import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient, describeApiError } from "../../lib/client/api";
import { preferencesLabel, preferencesToast } from "../../lib/client/notifications-view";
import {
  PURPOSE_LABELS,
  budgetLines,
  failedRows,
  loadSmsAdmin,
  localLines,
  parseSmsAdminOverview,
  providerLine,
  uncertainRows,
  usageErrorMessage,
  usageLines,
} from "../../lib/client/sms-admin";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MASKED = `+${"•".repeat(11)}12`;

const valid = () => ({
  contractVersion: "admin-sms/v1",
  provider: { mode: "meno", active: true, unitPriceXof: 15 },
  usage: { accepted: 12, uncertain: 1, rejected: 2, acceptedAmountXof: 180, unitPriceXof: 15, currency: "XOF", cachedAt: "2032-06-15T12:00:00.000Z" },
  usageError: null,
  local: { month: "2032-06", accepted: 10, uncertain: 1, rejected: 1, failed: 0, pending: 0 },
  uncertain: [{ id: ID, purpose: "otp", maskedPhone: MASKED, status: "uncertain", createdAt: "2032-06-15T11:00:00.000Z", httpStatus: 503, errorCode: "provider_unavailable", providerId: "msg_unsure_1", attempts: 1 }],
  recentFailed: [{ id: ID, purpose: "notification", maskedPhone: MASKED, createdAt: "2032-06-15T10:00:00.000Z", httpStatus: 429, errorCode: "rate_limited", attempts: 4 }],
  budget: {
    day: "2032-06-15",
    plan: { total: 1000, notifications: 400, codes: 600, existingReserve: 300, newNumbers: 300, newNumbersPerHour: 38 },
    used: { total: 52, codes: 40, newNumbers: 12, newNumbersHour: 3, notifications: 12 },
  },
  readAt: "2032-06-15T12:00:00.000Z",
  injected: "<script>alert(1)</script>",
});

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("lecture en liste blanche : un champ inconnu n'atteint jamais l'écran", () => {
  const overview = parseSmsAdminOverview(200, valid());
  assert.equal("injected" in overview, false);
  assert.deepEqual(overview.provider, { mode: "meno", active: true, unitPriceXof: 15 });
  assert.equal(overview.usage?.accepted, 12);
  assert.equal(overview.uncertain[0].maskedPhone, MASKED);
  assert.equal(JSON.stringify(overview).includes("script"), false);
});

test("réponse invalide refusée : contrat, numéro entier, comptes négatifs, identifiant, statut", () => {
  const broken: Array<(body: ReturnType<typeof valid>) => void> = [
    (body) => { body.contractVersion = "admin-sms/v2"; },
    (body) => { body.uncertain[0].maskedPhone = "+2250712345612"; },
    (body) => { body.uncertain[0].maskedPhone = "0712345612"; },
    (body) => { body.local.accepted = -1; },
    (body) => { body.uncertain[0].id = "pas-un-uuid"; },
    (body) => { (body.uncertain[0] as { status: string }).status = "accepted"; },
    (body) => { body.usage.currency = "xof"; },
    (body) => { (body as { usageError: unknown }).usageError = "Détail Libre !"; },
    (body) => { (body.provider as { mode: string }).mode = "autre"; },
    (body) => { body.uncertain[0].providerId = "avec espace"; },
    (body) => { body.recentFailed[0].maskedPhone = "+2250712345612"; },
    (body) => { (body.recentFailed[0] as { purpose: string }).purpose = "autre"; },
    (body) => { body.recentFailed[0].errorCode = "Détail Libre !"; },
    (body) => { body.budget.plan.codes = -1; },
    (body) => { body.budget.used.total = 1.5; },
    (body) => { body.budget.day = "hier"; },
    (body) => { (body as { budget: unknown }).budget = null; },
    (body) => { (body as { recentFailed: unknown }).recentFailed = "oui"; },
  ];
  for (const [index, change] of broken.entries()) {
    const body = valid();
    change(body);
    assert.throws(() => parseSmsAdminOverview(200, body), (error: unknown) => error instanceof ApiError && error.code === "invalid_response", `cas ${index}`);
  }
  assert.throws(() => parseSmsAdminOverview(200, null), ApiError);
  const withoutUsage = parseSmsAdminOverview(200, { ...valid(), usage: null, usageError: "usage_unreachable" });
  assert.equal(withoutUsage.usage, null);
  assert.equal(withoutUsage.usageError, "usage_unreachable");
});

test("chargement : 404 du serveur → ApiError 404 (page introuvable), réseau coupé et réponse illisible → codes fixes, jamais le texte brut", async () => {
  const notFound = await loadSmsAdmin({ fetchImpl: jsonFetch(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }) }).catch((e: unknown) => e);
  assert.ok(notFound instanceof ApiError);
  assert.equal(notFound.status, 404);
  const network = await loadSmsAdmin({ fetchImpl: (async () => { throw new TypeError("détail réseau secret"); }) as typeof fetch }).catch((e: unknown) => e);
  assert.ok(network instanceof ApiError);
  assert.equal(network.code, "network_error");
  assert.equal(network.message.includes("secret"), false);
  const garbled = await loadSmsAdmin({ fetchImpl: (async () => new Response("<html>", { status: 502 })) as typeof fetch }).catch((e: unknown) => e);
  assert.ok(garbled instanceof ApiError);
  assert.equal(garbled.code, "invalid_response");
  const ok = await loadSmsAdmin({ fetchImpl: jsonFetch(200, valid()) });
  assert.equal(ok.local.month, "2032-06");
});

test("présentation : consommation, journal local, incertains avec numéro masqué et identifiant du fournisseur ; aucune action", () => {
  const overview = parseSmsAdminOverview(200, valid());
  assert.equal(providerLine(overview.provider), "Fournisseur Meno : actif.");
  assert.match(providerLine({ mode: "meno", active: false, unitPriceXof: 15 }), /inactif/);
  assert.match(providerLine({ mode: "none", active: false, unitPriceXof: 15 }), /désactivé/);
  const lines = usageLines(overview.usage!);
  assert.match(lines[0], /Acceptés ce mois : 12/);
  assert.match(lines[0], /180/);
  assert.match(lines[1], /Incertains : 1 · Refusés : 2/);
  assert.match(localLines(overview.local)[0], /2032-06\) : 10 acceptés/);
  const rows = uncertainRows(overview.uncertain);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /Code de connexion/);
  assert.ok(rows[0].title.includes(MASKED));
  assert.match(rows[0].detail, /Résultat incertain · HTTP 503 · provider_unavailable · identifiant msg_unsure_1/);
  assert.equal(PURPOSE_LABELS.notification, "Notification");
  assert.match(usageErrorMessage("usage_unauthorized"), /clé du fournisseur est refusée/);
  assert.equal(usageErrorMessage("inconnu"), "Consommation indisponible.");
  assert.deepEqual(budgetLines(overview.budget), [
    "Budgets du jour (2032-06-15, UTC) : total 52/1000",
    "Codes de connexion : 40/600 (dont 300 réservés aux numéros qui ont déjà un compte)",
    "Numéros inconnus : 12/300 · cette heure : 3/38",
    "Notifications : 12/400",
  ]);
  const failed = failedRows(overview.recentFailed);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].title.includes(MASKED));
  assert.match(failed[0].title, /Notification/);
  assert.equal(failed[0].detail, "Rien n'est parti · HTTP 429 · rate_limited");
  assert.equal(failedRows([{ ...overview.recentFailed[0], httpStatus: null, errorCode: null }])[0].detail, "Rien n'est parti");
  assert.equal(failedRows([]).length, 0);
  const pending = uncertainRows([{ ...overview.uncertain[0], status: "pending", providerId: null, httpStatus: null, errorCode: null }]);
  assert.match(pending[0].detail, /Interrompu pendant l'appel · identifiant du fournisseur inconnu/);
});

test("connexion : échec définitif de l'envoi du code → message générique, sans détail ; les autres 503 gardent leur message", () => {
  assert.equal(describeApiError(new ApiError(503, "otp_delivery_failed", "texte du serveur ignoré"), "otp-request"), "Envoi du code impossible pour le moment. Réessayez dans quelques minutes.");
  assert.equal(describeApiError(new ApiError(503, "auth_unavailable", "x"), "otp-request"), "Le service est temporairement indisponible. Réessayez dans un instant.");
  assert.equal(describeApiError(new ApiError(503, "otp_delivery_failed", "x"), "otp-verify"), "Le service est temporairement indisponible. Réessayez dans un instant.");
  // SMS1-bis : budget d'envoi atteint — message DISTINCT, jamais le texte du serveur.
  assert.equal(describeApiError(new ApiError(503, "otp_capacity_reached", "texte du serveur ignoré"), "otp-request"), "Le service d'envoi de codes est très sollicité en ce moment. Réessayez un peu plus tard.");
  assert.notEqual(describeApiError(new ApiError(503, "otp_capacity_reached", "x"), "otp-request"), describeApiError(new ApiError(503, "otp_delivery_failed", "x"), "otp-request"));
  assert.equal(describeApiError(new ApiError(503, "otp_capacity_reached", "x"), "otp-verify"), "Le service est temporairement indisponible. Réessayez dans un instant.", "seulement pour la demande de code");
});

test("préférences d'envoi : un vrai fournisseur retire « (simulé) » des libellés ; sans lui, rien ne change", async () => {
  assert.equal(preferencesLabel({}), "Me prévenir par SMS (simulé)");
  assert.equal(preferencesLabel({ real: false }), "Me prévenir par SMS (simulé)");
  assert.equal(preferencesLabel({ real: true }), "Me prévenir par SMS");
  assert.equal(preferencesToast(true, {}), "Envoi par SMS (simulé) activé");
  assert.equal(preferencesToast(false, {}), "Envoi par SMS (simulé) désactivé");
  assert.equal(preferencesToast(true, { real: true }), "Envoi par SMS activé");
  assert.equal(preferencesToast(false, { real: true }), "Envoi par SMS désactivé");
  const body = (external: Record<string, unknown>) => ({ contractVersion: "notification-preferences/v1", preferences: { externalEnabled: false }, external });
  const read = (payload: unknown) => createApiClient({ fetch: (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }).notifications.preferences();
  assert.deepEqual(await read(body({ available: false, notice: "texte" })), { externalEnabled: false, externalAvailable: false, notice: "texte" }, "sans `real`, le résultat est celui d'avant");
  assert.deepEqual(await read(body({ available: true, notice: "texte", real: true })), { externalEnabled: false, externalAvailable: true, notice: "texte", real: true });
  assert.deepEqual(await read(body({ available: true, notice: "texte", real: "oui" })), { externalEnabled: false, externalAvailable: true, notice: "texte" }, "seul `true` compte");
});
