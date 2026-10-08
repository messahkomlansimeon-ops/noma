import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_INVALID_ARGUMENT, API_INVALID_RESPONSE, ApiError } from "../../lib/client/api";
import { ADMIN_PAYMENTS_CONTRACT_VERSION, ANOMALY_KINDS, createPaymentsAdminClient } from "../../lib/client/payments-admin-api";
import { ANOMALY_LABELS, anomalyRow, catchupText, intentRow, providerStateText, webhooksText } from "../../lib/client/payments-admin-view";

/** Administration des paiements (lot PAY1) : client strict (liste blanche), libellés en français, aucune donnée personnelle. */

const UUID_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const UUID_B = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const NOW = "2026-10-08T10:00:00.000Z";

interface Seen { url: string; method: string; body: unknown; credentials: string | undefined }

function client(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createPaymentsAdminClient({ fetch: fetchStub }), calls };
}

const intent = (overrides: Record<string, unknown> = {}) => ({
  id: UUID_A, provider: "sublymus", amountXof: 5_000, status: "pending", createdAt: NOW, completedAt: null, checkoutOpened: true, providerStatus: "WAVE_CREATED", catchupAttempts: 2,
  nextCatchupAt: "2026-10-08T10:20:00.000Z", lastCatchupAt: NOW, lastCatchupOutcome: "waiting", catchupDone: false, ...overrides,
});
const anomaly = (overrides: Record<string, unknown> = {}) => ({
  id: UUID_B, kind: "amount_mismatch", origin: "webhook", createdAt: NOW, intentId: UUID_A, expectedAmountXof: 5_000, receivedAmountXof: 4_999, receivedCurrency: "XOF", receivedStatus: "COMPLETED", resolvedAt: null, ...overrides,
});
const overview = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: ADMIN_PAYMENTS_CONTRACT_VERSION, provider: "sublymus", openAnomalies: 1, anomalies: [anomaly()], intents: [intent()],
  catchup: { waiting: 3, overdue: 0, done: 5, lastRunAt: NOW }, webhooks: { last24h: 4, lastReceivedAt: NOW }, readAt: NOW, ...overrides,
});

describe("client de l'administration des paiements", () => {
  test("overview : GET /api/admin/payments, même origine, sans mise en cache ; réponse relue champ par champ", async () => {
    const { api, calls } = client(() => ({ status: 200, body: overview() }));
    const result = await api.adminPayments.overview();
    assert.deepEqual([calls[0].url, calls[0].method, calls[0].credentials], ["/api/admin/payments", "GET", "same-origin"]);
    assert.equal(result.provider, "sublymus");
    assert.equal(result.openAnomalies, 1);
    assert.deepEqual(result.anomalies[0], anomaly());
    assert.deepEqual(result.intents[0], intent());
    assert.deepEqual(result.catchup, { waiting: 3, overdue: 0, done: 5, lastRunAt: NOW });
  });

  test("overview : un champ ajouté par le serveur n'atteint jamais l'écran (liste blanche)", async () => {
    const { api } = client(() => ({ status: 200, body: overview({ intents: [intent({ ownerId: "x", providerReference: "noma-topup-secret" })], anomalies: [anomaly({ payerHint: "pa***", webhookId: "wh_secret" })], extra: 1 }) }));
    const text = JSON.stringify(await api.adminPayments.overview());
    for (const leaked of ["ownerId", "noma-topup-secret", "payerHint", "pa***", "wh_secret", "extra"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("overview : réponse hors liste blanche = invalid_response (contrat, prestataire, genre d'anomalie, montants, dates, statuts)", async () => {
    for (const bad of [
      { contractVersion: "admin-payments/v2" }, { provider: "orange" }, { openAnomalies: -1 }, { anomalies: "x" }, { intents: null },
      { anomalies: [anomaly({ kind: "inconnu" })] }, { anomalies: [anomaly({ id: "pas-un-uuid" })] }, { anomalies: [anomaly({ origin: "autre" })] }, { anomalies: [anomaly({ expectedAmountXof: -1 })] },
      { anomalies: [anomaly({ receivedCurrency: "x".repeat(9) })] }, { anomalies: [anomaly({ resolvedAt: "bientôt" })] },
      { intents: [intent({ provider: "wave" })] }, { intents: [intent({ amountXof: 0 })] }, { intents: [intent({ status: "payée" })] }, { intents: [intent({ createdAt: "hier" })] },
      { intents: [intent({ checkoutOpened: "oui" })] }, { intents: [intent({ catchupAttempts: -2 })] }, { catchup: { waiting: 1 } }, { webhooks: { last24h: "4", lastReceivedAt: null } }, { readAt: "x" },
    ]) {
      const { api } = client(() => ({ status: 200, body: overview(bad) }));
      await assert.rejects(api.adminPayments.overview(), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, JSON.stringify(Object.keys(bad)));
    }
  });

  test("resolveAnomaly : POST sur l'identifiant, corps {} ; identifiant mal formé refusé AVANT la requête ; 404 conservé en erreur", async () => {
    const { api, calls } = client((seen) => (seen.url.includes(UUID_B) ? { status: 200, body: { contractVersion: ADMIN_PAYMENTS_CONTRACT_VERSION, anomalyId: UUID_B, changed: true } } : { status: 404, body: { error: { code: "resource_not_found", message: "Ressource introuvable." } } }));
    assert.deepEqual(await api.adminPayments.resolveAnomaly(UUID_B), { changed: true });
    assert.deepEqual([calls[0].url, calls[0].method, calls[0].body], [`/api/admin/payments/anomalies/${UUID_B}/resolve`, "POST", {}]);
    await assert.rejects(api.adminPayments.resolveAnomaly("../x"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT);
    assert.equal(calls.length, 1);
    await assert.rejects(api.adminPayments.resolveAnomaly(UUID_A), (error: unknown) => error instanceof ApiError && error.status === 404);
    const { api: broken } = client(() => ({ status: 200, body: { contractVersion: ADMIN_PAYMENTS_CONTRACT_VERSION, changed: "oui" } }));
    await assert.rejects(broken.adminPayments.resolveAnomaly(UUID_B), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
  });
});

describe("présentation de l'administration des paiements", () => {
  test("anomalies : un libellé français par genre, le détail (attendu, reçu, devise, statut), jamais un code brut", () => {
    for (const label of Object.values(ANOMALY_LABELS)) assert.ok(label.length > 8 && !/[a-z]+_[a-z]+/.test(label));
    assert.equal(Object.keys(ANOMALY_LABELS).length, 13);
    assert.deepEqual(Object.keys(ANOMALY_LABELS).sort(), [...ANOMALY_KINDS].sort(), "un libellé par genre d'anomalie, ni plus ni moins");
    assert.equal(ANOMALY_LABELS.unreadable_event, "Événement de Sublymus illisible");
    assert.equal(ANOMALY_LABELS.unknown_event, "Événement de Sublymus inconnu");
    const row = anomalyRow(anomaly() as never, "UTC");
    assert.equal(row.title, "Montant différent de la recharge");
    assert.match(row.detail, /webhook/);
    assert.match(row.detail, /attendu 5\s000\sFCFA/);
    assert.match(row.detail, /reçu 4\s999\sFCFA/);
    assert.match(row.detail, /devise XOF/);
    assert.equal(row.open, true);
    assert.equal(anomalyRow(anomaly({ resolvedAt: NOW, origin: "catchup" }) as never, "UTC").open, false);
    assert.match(anomalyRow(anomaly({ origin: "catchup" }) as never, "UTC").detail, /rattrapage/);
    assert.equal(anomalyRow(anomaly({ kind: "unknown_reference", expectedAmountXof: null, receivedAmountXof: null, receivedCurrency: null, receivedStatus: null }) as never).detail.includes("attendu"), false);
  });

  test("recharges : statut, moyen (Wave ou simulé), session, rattrapage en mots ; état du rattrapage et des webhooks", () => {
    const row = intentRow(intent() as never, "UTC");
    assert.match(row.title, /5\s000\sFCFA/);
    assert.match(row.detail, /^En attente · Wave/);
    assert.match(row.detail, /session Wave ouverte/);
    assert.match(row.detail, /rattrapage : 2 tentative\(s\), paiement en attente chez Wave/);
    assert.match(row.detail, /prochain rattrapage le/);
    assert.match(intentRow(intent({ provider: "fake", checkoutOpened: null, catchupAttempts: null, catchupDone: null, status: "succeeded" }) as never).detail, /^Payée · simulé/);
    assert.doesNotMatch(intentRow(intent({ provider: "fake", checkoutOpened: null, catchupAttempts: null, catchupDone: null }) as never).detail, /Wave|rattrapage/);
    assert.match(intentRow(intent({ lastCatchupOutcome: "window_closed", catchupDone: true, nextCatchupAt: null }) as never).detail, /abandonné après 24 h/);
    assert.deepEqual(catchupText({ waiting: 3, overdue: 0, done: 5, lastRunAt: NOW }, "UTC"), { text: "Rattrapage : 3 en attente, 5 terminé(s), dernier passage le 08/10/2026 à 10:00.", warn: false });
    const late = catchupText({ waiting: 3, overdue: 2, done: 0, lastRunAt: null }, "UTC");
    assert.equal(late.warn, true);
    assert.match(late.text, /2 rattrapage\(s\) échu\(s\) depuis plus de 15 minutes : le worker ne tourne peut-être pas/);
    assert.equal(webhooksText({ last24h: 0, lastReceivedAt: null }), "Webhooks Sublymus : aucun reçu.");
    assert.match(webhooksText({ last24h: 4, lastReceivedAt: NOW }, "UTC"), /4 reçu\(s\) ces dernières 24 h, dernier le 08\/10\/2026 à 10:00/);
    assert.match(providerStateText("sublymus"), /Wave via Sublymus/);
    assert.match(providerStateText("fake"), /simulé/);
    assert.match(providerStateText("misconfigured"), /refusée/);
  });
});
