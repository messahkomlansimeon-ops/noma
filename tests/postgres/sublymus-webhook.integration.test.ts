import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { createWalletHttpHandlers, type WalletHttpHandlers } from "../../lib/server/wallet/http";
import { createTopupIntent } from "../../lib/server/wallet/topups";
import { signSublymusBody } from "../../lib/server/wallet/sublymus/webhook";
import { SUBLYMUS_WEBHOOK_MAX_BODY_BYTES } from "../../lib/server/wallet/sublymus/config";
import type { FakeIntent, FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import {
  TEST_API_KEY, TEST_MANAGER_ID, TEST_WEBHOOK_SECRET, balanceOf, countRows, newTopup, paymentSnapshot, providerOf, startApi, sublymusEnv, topupTransactions, webhookRequest, type Env,
} from "./sublymus-fixtures";
import { login, openTestSchema, reply, type Login, type Reply, type TestSchema } from "./social-fixtures";

/**
 * Lot PAY1 : webhook Sublymus → noma. Signatures synthétiques calculées avec un secret de TEST inventé (aucun appel réel). Ordre : signature (temps constant) AVANT tout parsing, puis
 * gestionnaire, puis lecture ; écarts → rien de crédité, anomalie journalisée, réponse 2xx ; un seul crédit quelles que soient les livraisons.
 */

let env: TestSchema;
let api: FakeSublymusApi;
let envVars: Env;
let handlers: WalletHttpHandlers;
const logs: string[] = [];
const consoleLines: string[] = [];
const realConsole = { error: console.error, log: console.log, warn: console.warn };
let user: Login;

before(async () => {
  env = await openTestSchema(16);
  api = await startApi();
  envVars = sublymusEnv(api);
  handlers = createWalletHttpHandlers({ pool: env.pool, env: envVars, log: (code) => { logs.push(code); } });
  user = await login(env.pool);
  for (const name of ["error", "log", "warn"] as const) console[name] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };
});

after(async () => {
  console.error = realConsole.error;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  await api.close();
  await env.close();
});

type Json = Record<string, unknown>;
type Signed = { body: string; headers: Record<string, string> };
const obj = (value: unknown): Json => value as Json;
const UNAUTHORIZED = { error: { code: "unauthorized", message: "Non autorisé." } };

const deliver = (signed: Signed, target: WalletHttpHandlers = handlers): Promise<Reply> => target.sublymus.webhook(webhookRequest(signed)).then(reply);
const topup = (amount = 5_000, owner: Login = user) => newTopup(env.pool, api, envVars, owner.userId, amount);
const sign = (intent: FakeIntent, extra: Partial<Omit<Parameters<FakeSublymusApi["webhook"]>[0], "intent" | "secret">> = {}): Signed => api.webhook({ intent, secret: TEST_WEBHOOK_SECRET, ...extra });
const anomalies = async (intentId: string | null): Promise<Array<{ kind: string; expected: string | null; received: string | null; currency: string | null; status: string | null; hint: string | null; origin: string }>> =>
  (await env.pool.query(
    `SELECT kind, expected_amount_xof::text AS expected, received_amount_xof::text AS received, received_currency AS currency, received_status AS status, payer_hint AS hint, origin
       FROM sublymus_anomalies WHERE intent_id IS NOT DISTINCT FROM $1::uuid ORDER BY kind`, [intentId])).rows;
const intentStatus = async (id: string): Promise<string> => (await env.pool.query<{ status: string }>("SELECT status FROM payment_intents WHERE id = $1", [id])).rows[0].status;

// ═════════════ 1. Livraison valide ═════════════

test("signature valide : 200 « reçu », UNE recharge créditée (partie double), intention réussie, livraison et événement journalisés, rattrapage terminé, wallet:check vert", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  const signed = sign(handle.fakeIntent!, { webhookId: "wh_valid_0001" });
  const answer = await deliver(signed);
  assert.equal(answer.status, 200);
  assert.deepEqual(obj(answer.json), { received: true }, "la réponse ne révèle pas l'issue");
  assert.equal(await intentStatus(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  const delivery = (await env.pool.query("SELECT webhook_id, event, outcome, sublymus_intent_id AS sub FROM sublymus_webhook_deliveries WHERE intent_id = $1", [handle.intent.id])).rows;
  assert.deepEqual(delivery, [{ webhook_id: "wh_valid_0001", event: "payment.completed", outcome: "applied", sub: handle.fakeIntent!.id }]);
  const events = (await env.pool.query("SELECT provider, provider_event_id AS id, type, outcome FROM payment_events WHERE intent_id = $1", [handle.intent.id])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].provider, events[0].type, events[0].outcome], ["sublymus", "payment.succeeded", "applied"]);
  assert.match(events[0].id, /^wh_[0-9a-f]{40}$/);
  const checkout = (await env.pool.query("SELECT provider_status, next_catchup_at, catchup_done_at IS NOT NULL AS done FROM sublymus_checkouts WHERE intent_id = $1", [handle.intent.id])).rows[0];
  assert.deepEqual([checkout.provider_status, checkout.next_catchup_at, checkout.done], ["COMPLETED", null, true]);
  const entries = (await env.pool.query<{ kind: string; amount: string }>(
    `SELECT a.kind, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id JOIN wallet_transactions t ON t.id = e.transaction_id
      WHERE t.reference = $1 ORDER BY a.kind`, [`topup:${handle.intent.id}`])).rows;
  assert.deepEqual(entries, [{ kind: "provider_clearing", amount: "-5000" }, { kind: "user", amount: "5000" }]);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

// ═════════════ 2. Authentification : signature et gestionnaire ═════════════

test("signature fausse, absente, non hexadécimale, de mauvaise longueur : 401 sans AUCUN détail, identique pour toutes les causes, rien d'écrit", async () => {
  const handle = await topup();
  const good = sign(handle.fakeIntent!);
  const flipped = `${good.headers["x-wave-signature"].slice(0, -1)}${good.headers["x-wave-signature"].endsWith("0") ? "1" : "0"}`;
  const variants: Array<string | null> = [flipped, null, "", "zz".repeat(32), good.headers["x-wave-signature"].slice(0, 63), `${good.headers["x-wave-signature"]}0`, "0".repeat(64), good.headers["x-wave-signature"].replace(/^./, "g")];
  const before = await paymentSnapshot(env.pool);
  for (const signature of variants) {
    const headers = { ...good.headers };
    if (signature === null) delete headers["x-wave-signature"];
    else headers["x-wave-signature"] = signature;
    const answer = await deliver({ body: good.body, headers });
    assert.equal(answer.status, 401, String(signature).slice(0, 12));
    assert.deepEqual(obj(answer.json), UNAUTHORIZED);
  }
  assert.deepEqual(await paymentSnapshot(env.pool), before, "aucune écriture sur un refus");
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(0));
  assert.ok(logs.includes("webhook_unauthorized"));
});

test("corps modifié après la signature, JSON re-sérialisé, ordre des clés changé : 401 (la signature porte sur les octets exacts du corps brut)", async () => {
  const handle = await topup(4_000);
  const good = sign(handle.fakeIntent!);
  const before = await paymentSnapshot(env.pool);
  const parsed = JSON.parse(good.body) as Json;
  const tampered = { ...parsed, data: { ...obj(parsed.data), amount: 1 } };
  const reordered = { timestamp: parsed.timestamp, data: parsed.data, event: parsed.event };
  for (const body of [JSON.stringify(tampered), JSON.stringify(parsed, null, 2), JSON.stringify(reordered), `${good.body} `, good.body.replace(/"COMPLETED"/, '"COMPLETED" ')]) {
    const answer = await deliver({ body, headers: good.headers });
    assert.equal(answer.status, 401);
    assert.deepEqual(obj(answer.json), UNAUTHORIZED);
  }
  assert.deepEqual(await paymentSnapshot(env.pool), before);
  // Un corps mis en forme PUIS signé tel quel est valide : seul compte le corps brut reçu.
  const pretty = JSON.stringify(parsed, null, 2);
  const signedPretty: Signed = { body: pretty, headers: { ...good.headers, "x-wave-signature": signSublymusBody(TEST_WEBHOOK_SECRET, pretty), "x-webhook-id": "wh_pretty_0001" } };
  assert.equal((await deliver(signedPretty)).status, 200);
  assert.equal(await intentStatus(handle.intent.id), "succeeded");
});

test("gestionnaire différent ou absent (signature valide) : 401 identique, rien d'écrit", async () => {
  const handle = await topup();
  const before = await paymentSnapshot(env.pool);
  for (const manager of ["mgr_autre", `${TEST_MANAGER_ID}x`, TEST_MANAGER_ID.toUpperCase(), "", null]) {
    const signed = sign(handle.fakeIntent!, manager === null ? {} : { managerId: manager });
    if (manager === null) delete signed.headers["x-manager-id"];
    const answer = await deliver(signed);
    assert.equal(answer.status, 401, String(manager));
    assert.deepEqual(obj(answer.json), UNAUTHORIZED);
  }
  assert.deepEqual(await paymentSnapshot(env.pool), before);
});

test("ordre : la signature est vérifiée AVANT le parsing (corps illisible + mauvaise signature = 401) ; événement authentifié mais illisible ou inconnu = 200 + anomalie + code au journal, JAMAIS 400, rien de crédité", async () => {
  const before = await paymentSnapshot(env.pool);
  const garbage = "{ ceci n'est pas du json";
  const wrong: Signed = { body: garbage, headers: { "x-wave-signature": "0".repeat(64), "x-wave-event": "payment.completed", "x-manager-id": TEST_MANAGER_ID, "x-webhook-id": "wh_order_0001" } };
  assert.equal((await deliver(wrong)).status, 401);
  assert.deepEqual(await paymentSnapshot(env.pool), before, "une signature fausse n'écrit rien");
  const signedBody = (body: string): Signed => ({ body, headers: { ...wrong.headers, "x-wave-signature": signSublymusBody(TEST_WEBHOOK_SECRET, body) } });
  const owner = await login(env.pool);
  const known = await topup(5_000, owner);
  const good = { id: known.fakeIntent!.id, externalReference: known.reference, amount: 5_000, currency: "XOF", status: "COMPLETED" };
  const cases: Array<[string, string]> = [
    [garbage, "unreadable_event"],
    ["[]", "unreadable_event"],
    ["{}", "unreadable_event"],
    ["null", "unreadable_event"],
    ['{"event":"payment.completed","event":"payment.failed","data":{}}', "unreadable_event"],
    [`\uFEFF${JSON.stringify({ event: "payment.completed", data: good })}`, "unreadable_event"],
    [JSON.stringify({ event: "payment.completed", data: { ...good, id: "pi/avec/barres" } }), "unreadable_event"],
    [JSON.stringify({ event: "payment.completed", data: { ...good, externalReference: undefined } }), "unreadable_event"],
    ['{"event":"payment.completed","data":{"id":"pi_x","externalReference":"noma-topup-x","amount":1e400}}', "unreadable_event"],
    ['{"event":"payment.completed","data":{"id":"pi_x","externalReference":"noma-topup-x"},"x":' + "[".repeat(40) + "]".repeat(40) + "}", "unreadable_event"],
    ['{"event":"payment.refunded","data":{"id":"pi_x","externalReference":"noma-topup-inconnue"}}', "unknown_event"],
    [JSON.stringify({ event: "payment.refunded", data: good }), "unknown_event"],
    [JSON.stringify({ event: "payment.expired" }), "unknown_event"],
  ];
  const logsBefore = logs.length;
  for (const [body] of cases) {
    const answer = await deliver(signedBody(body));
    assert.equal(answer.status, 200, body.slice(0, 50));
    assert.deepEqual(answer.json, { received: true }, "même réponse qu'une livraison reçue");
  }
  const afterAll = await paymentSnapshot(env.pool);
  assert.deepEqual({ ...afterAll, anomalies: 0 }, { ...before, anomalies: 0 }, "ni crédit, ni livraison, ni événement du journal");
  assert.equal(afterAll.anomalies - before.anomalies, cases.length, "une anomalie par événement distinct");
  const recorded = (await env.pool.query<{ kind: string; n: number }>("SELECT kind, count(*)::int AS n FROM sublymus_anomalies WHERE kind IN ('unreadable_event', 'unknown_event') GROUP BY kind")).rows;
  const expected = (kind: string): number => cases.filter(([, caseKind]) => caseKind === kind).length;
  for (const kind of ["unreadable_event", "unknown_event"]) assert.equal(recorded.find((row) => row.kind === kind)?.n, expected(kind), kind);
  // Le même événement rejoué : aucune anomalie de plus (idempotent). Un événement inconnu sur une référence connue est rattaché à l'intention, avec son nom.
  assert.equal((await deliver(signedBody(garbage))).status, 200);
  assert.equal((await paymentSnapshot(env.pool)).anomalies, afterAll.anomalies);
  const attached = (await env.pool.query<{ intent_id: string | null; status: string | null; reference: string }>(
    "SELECT intent_id, received_status AS status, external_reference AS reference FROM sublymus_anomalies WHERE kind = 'unknown_event' AND intent_id = $1", [known.intent.id])).rows;
  assert.deepEqual(attached.map((row) => [row.status, row.reference]), [["payment.refunded", known.reference]]);
  assert.equal(await intentStatus(known.intent.id), "pending");
  // Codes au journal : un code par genre, rien d'autre que des codes.
  const codes = logs.slice(logsBefore);
  assert.ok(codes.includes("webhook_unreadable") && codes.includes("webhook_unknown_event"), codes.join(","));
  assert.ok(codes.every((code) => /^[a-zA-Z_0-9]{1,40}$/.test(code)));
  // L'événement lisible de la même intention est ensuite crédité normalement.
  assert.equal((await deliver(sign(known.fakeIntent!))).status, 200);
  assert.equal(await intentStatus(known.intent.id), "succeeded");
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("corps au-delà de 64 Kio : 413 avant toute lecture ; corps exactement à la limite : lu (puis refusé ici faute de signature valide)", async () => {
  const big = "x".repeat(SUBLYMUS_WEBHOOK_MAX_BODY_BYTES + 1);
  const answer = await deliver({ body: big, headers: { "x-wave-signature": signSublymusBody(TEST_WEBHOOK_SECRET, big), "x-manager-id": TEST_MANAGER_ID } });
  assert.equal(answer.status, 413);
  const atLimit = "y".repeat(SUBLYMUS_WEBHOOK_MAX_BODY_BYTES);
  assert.equal((await deliver({ body: atLimit, headers: { "x-wave-signature": "0".repeat(64), "x-manager-id": TEST_MANAGER_ID } })).status, 401);
});

// ═════════════ 3. Écarts : rien de crédité, anomalie journalisée, 2xx ═════════════

test("montant modifié : rien n'est crédité, anomalie « montant différent » journalisée (attendu et reçu), 2xx pour que Sublymus ne rejoue pas en boucle", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  const answer = await deliver(sign(handle.fakeIntent!, { data: { amount: 4_999 }, webhookId: "wh_amount_0001" }));
  assert.equal(answer.status, 200);
  assert.deepEqual(obj(answer.json), { received: true });
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  assert.equal(await intentStatus(handle.intent.id), "pending");
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 0);
  const rows = await anomalies(handle.intent.id);
  assert.deepEqual(rows.map((row) => [row.kind, row.expected, row.received, row.origin]), [["amount_mismatch", "5000", "4999", "webhook"]]);
  assert.equal((await env.pool.query("SELECT outcome FROM sublymus_webhook_deliveries WHERE webhook_id = 'wh_amount_0001'")).rows[0].outcome, "anomaly");
  assert.ok(logs.includes("webhook_anomaly"));
  // Montant illisible (texte) : anomalie, rien d'autre.
  const unreadable = await deliver(sign(handle.fakeIntent!, { data: { amount: "beaucoup" }, webhookId: "wh_amount_0002" }));
  assert.equal(unreadable.status, 200);
  assert.ok((await anomalies(handle.intent.id)).some((row) => row.kind === "invalid_amount"));
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
});

test("devise différente : rien n'est crédité, anomalie « devise »", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  assert.equal((await deliver(sign(handle.fakeIntent!, { data: { currency: "USD" } }))).status, 200);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  assert.deepEqual((await anomalies(handle.intent.id)).map((row) => [row.kind, row.currency]), [["currency_mismatch", "USD"]]);
  assert.equal(await intentStatus(handle.intent.id), "pending");
});

test("référence inconnue : rien n'est crédité, anomalie « référence inconnue » sans intention ; 2xx", async () => {
  const before = await countRows(env.pool, "payment_intents", "status = 'succeeded'");
  const stranger = api.seed({ externalReference: "noma-topup-00000000-0000-4000-8000-000000000000", amount: 5_000 });
  assert.equal((await deliver(sign(stranger))).status, 200);
  assert.equal(await countRows(env.pool, "payment_intents", "status = 'succeeded'"), before);
  assert.deepEqual((await anomalies(null)).filter((row) => row.kind === "unknown_reference").length >= 1, true);
  const row = (await env.pool.query("SELECT intent_id, external_reference FROM sublymus_anomalies WHERE kind = 'unknown_reference' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(row.intent_id, null);
  assert.equal(row.external_reference, stranger.externalReference);
});

test("statut non COMPLETED sur payment.completed : rien n'est crédité, anomalie « statut »", async () => {
  const owner = await login(env.pool);
  for (const status of ["WAVE_CREATED", "PENDING", "FAILED", "completed", ""]) {
    const handle = await topup(5_000, owner);
    assert.equal((await deliver(sign(handle.fakeIntent!, { status }))).status, 200);
    assert.equal(await intentStatus(handle.intent.id), "pending", status);
    assert.ok((await anomalies(handle.intent.id)).some((row) => row.kind === "status_mismatch"), status);
  }
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
});

test("événement différent de l'en-tête, identifiant Sublymus différent, payeur et système source différents : rien n'est crédité, une anomalie chacun, jamais le payeur en clair", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  const mismatched = sign(handle.fakeIntent!, { webhookId: "wh_header_0001" });
  mismatched.headers["x-wave-event"] = "payment.failed";
  assert.equal((await deliver(mismatched)).status, 200);
  assert.ok((await anomalies(handle.intent.id)).some((row) => row.kind === "event_mismatch"));
  assert.equal((await deliver(sign(handle.fakeIntent!, { data: { id: "pi_autre_session" }, webhookId: "wh_id_0001" }))).status, 200);
  assert.ok((await anomalies(handle.intent.id)).some((row) => row.kind === "intent_id_mismatch"));
  const payerSecret = "payeur_prive_123456";
  assert.equal((await deliver(sign(handle.fakeIntent!, { data: { payerId: payerSecret, sourceSystem: "AUTRE" }, webhookId: "wh_payer_0001" }))).status, 200);
  const kinds = (await anomalies(handle.intent.id)).map((row) => row.kind);
  assert.ok(kinds.includes("payer_mismatch") && kinds.includes("source_mismatch"));
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  assert.equal(await intentStatus(handle.intent.id), "pending");
  // Le payeur n'est conservé que masqué : jamais entier dans la table, ni dans le journal ni dans la console.
  const everything = JSON.stringify((await env.pool.query("SELECT * FROM sublymus_anomalies")).rows) + JSON.stringify((await env.pool.query("SELECT * FROM sublymus_webhook_deliveries")).rows);
  assert.ok(!everything.includes(payerSecret));
  assert.equal((await anomalies(handle.intent.id)).find((row) => row.kind === "payer_mismatch")!.hint, "pa***");
  for (const line of [...logs, ...consoleLines]) assert.ok(!line.includes(payerSecret));
});

test("référence voisine (préfixe, suffixe, casse) : jamais acceptée, une référence exacte seulement ; l'événement d'une autre intention ne crédite que la sienne", async () => {
  const a = await topup(5_000);
  const b = await topup(5_000);
  const reference = a.reference;
  const neighbors = [reference.slice(0, -1), `${reference}0`, `${reference}-bis`, reference.toUpperCase(), ` ${reference}`, `${reference.slice(0, 11)}`];
  for (const neighbor of neighbors) {
    const answer = await deliver(sign({ ...a.fakeIntent!, externalReference: neighbor }));
    assert.equal(answer.status, 200, neighbor);
  }
  assert.equal(await intentStatus(a.intent.id), "pending", "aucune référence voisine ne crédite A");
  // Chaque voisin est une référence INCONNUE : une anomalie « référence inconnue » sans intention, jamais rattachée à A.
  assert.deepEqual(await anomalies(a.intent.id), []);
  const reported = (await env.pool.query<{ external_reference: string }>("SELECT external_reference FROM sublymus_anomalies WHERE kind = 'unknown_reference' AND intent_id IS NULL")).rows.map((row) => row.external_reference);
  for (const neighbor of neighbors) assert.ok(reported.includes(neighbor), `voisin non signalé comme référence inconnue : ${neighbor}`);
  assert.equal(await topupTransactions(env.pool, a.intent.id), 0);
  assert.equal(await intentStatus(b.intent.id), "pending");
  // L'événement exact de B ne crédite que B.
  assert.equal((await deliver(sign(b.fakeIntent!))).status, 200);
  assert.equal(await intentStatus(b.intent.id), "succeeded");
  assert.equal(await intentStatus(a.intent.id), "pending");
});

// ═════════════ 4. Échec, rejeu, concurrence ═════════════

test("payment.failed : l'intention échoue, rien n'est crédité ; un payment.completed ensuite crédite comme un paiement tardif (l'argent a été pris) avec une anomalie « conflit d'état »", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  assert.equal((await deliver(sign(handle.fakeIntent!, { event: "payment.failed", webhookId: "wh_failed_0001" }))).status, 200);
  assert.equal(await intentStatus(handle.intent.id), "failed");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  assert.deepEqual((await anomalies(handle.intent.id)).map((row) => row.kind), [], "un échec seul n'est pas une anomalie");
  // Le paiement réussi arrive après l'échec : crédité UNE fois, l'intention devient réussie, l'anomalie le signale.
  assert.equal((await deliver(sign(handle.fakeIntent!, { webhookId: "wh_failed_0002" }))).status, 200);
  assert.equal(await intentStatus(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.deepEqual((await anomalies(handle.intent.id)).map((row) => row.kind), ["state_conflict"]);
  // Rejeux et événements suivants : jamais un second crédit ; un échec tardif ne défait rien.
  assert.equal((await deliver(sign(handle.fakeIntent!, { webhookId: "wh_failed_0002" }))).status, 200);
  assert.equal((await deliver(sign(handle.fakeIntent!, { webhookId: "wh_failed_0003" }))).status, 200);
  assert.equal((await deliver(sign(handle.fakeIntent!, { event: "payment.failed", webhookId: "wh_failed_0004" }))).status, 200);
  assert.equal(await intentStatus(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  // La session est terminée côté rattrapage ; wallet:check accepte l'échec supplanté par le paiement réussi.
  const session = (await env.pool.query<{ status: string; next: Date | null; done: boolean; outcome: string }>(
    "SELECT provider_status AS status, next_catchup_at AS next, catchup_done_at IS NOT NULL AS done, last_catchup_outcome AS outcome FROM sublymus_checkouts WHERE intent_id = $1", [handle.intent.id])).rows[0];
  assert.deepEqual(session, { status: "COMPLETED", next: null, done: true, outcome: "completed" });
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
  // Un échec avec un statut qui n'en est pas un : anomalie, l'intention reste en attente.
  const other = await topup(5_000, owner);
  assert.equal((await deliver(sign(other.fakeIntent!, { event: "payment.failed", status: "COMPLETED" }))).status, 200);
  assert.equal(await intentStatus(other.intent.id), "pending");
  assert.ok((await anomalies(other.intent.id)).some((row) => row.kind === "status_mismatch"));
});

test("livraison répétée (même identifiant, même corps) : UNE seule recharge, une seule ligne de livraison, une seule écriture au journal, 2xx à chaque fois", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  const signed = sign(handle.fakeIntent!, { webhookId: "wh_repeat_0001" });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await deliver(signed)).status, 200);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.equal(await countRows(env.pool, "sublymus_webhook_deliveries", "webhook_id = 'wh_repeat_0001'"), 1);
  assert.equal(await countRows(env.pool, "payment_events", "intent_id = $1", [handle.intent.id]), 1);
  // Sans X-Webhook-Id : l'empreinte du corps sert d'identifiant ; le rejeu ne crédite pas non plus.
  const anonymous = await topup(2_000, owner);
  const withoutId = sign(anonymous.fakeIntent!);
  delete withoutId.headers["x-webhook-id"];
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await deliver(withoutId)).status, 200);
  assert.equal(await topupTransactions(env.pool, anonymous.intent.id), 1);
  assert.match((await env.pool.query<{ webhook_id: string }>("SELECT webhook_id FROM sublymus_webhook_deliveries WHERE intent_id = $1", [anonymous.intent.id])).rows[0].webhook_id, /^body-[0-9a-f]{48}$/);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(7_000));
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("deux livraisons distinctes (identifiants différents) pour la même intention : une seule recharge ; le second événement est un doublon, jamais un second crédit", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  assert.equal((await deliver(sign(handle.fakeIntent!, { webhookId: "wh_dup_a_0001" }))).status, 200);
  assert.equal((await deliver(sign(handle.fakeIntent!, { webhookId: "wh_dup_b_0001" }))).status, 200);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.deepEqual((await env.pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1 ORDER BY received_at", [handle.intent.id])).rows.map((row) => row.outcome), ["applied", "duplicate"]);
});

test("10 livraisons SIMULTANÉES (même identifiant, ou identifiants différents) : une seule recharge, jamais deux crédits", async () => {
  const owner = await login(env.pool);
  const pools = Array.from({ length: 10 }, () => env.extraPool(2));
  const farm = pools.map((pool) => createWalletHttpHandlers({ pool, env: envVars, log: (code) => { logs.push(code); } }));
  const same = await topup(5_000, owner);
  const signedSame = sign(same.fakeIntent!, { webhookId: "wh_race_same_01" });
  const answersSame = await Promise.all(farm.map((entry) => deliver(signedSame, entry)));
  assert.ok(answersSame.every((answer) => answer.status === 200), answersSame.map((answer) => answer.status).join(","));
  assert.equal(await topupTransactions(env.pool, same.intent.id), 1);
  assert.equal(await countRows(env.pool, "sublymus_webhook_deliveries", "intent_id = $1", [same.intent.id]), 1);

  const distinct = await topup(3_000, owner);
  const answersDistinct = await Promise.all(farm.map((entry, index) => deliver(sign(distinct.fakeIntent!, { webhookId: `wh_race_diff_${index}` }), entry)));
  assert.ok(answersDistinct.every((answer) => answer.status === 200), answersDistinct.map((answer) => answer.status).join(","));
  assert.equal(await topupTransactions(env.pool, distinct.intent.id), 1);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(8_000));
  const outcomes = (await env.pool.query<{ outcome: string }>("SELECT outcome FROM payment_events WHERE intent_id = $1", [distinct.intent.id])).rows.map((row) => row.outcome).sort();
  assert.equal(outcomes.filter((outcome) => outcome === "applied").length, 1);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("un en-tête X-Webhook-Id réutilisé avec un AUTRE corps n'empêche jamais le crédit ni sa ligne de livraison (clé composite identifiant + corps) ; chaque corps rejoué n'est traité qu'une fois", async () => {
  const owner = await login(env.pool);
  const first = await topup(5_000, owner);
  const second = await topup(2_000, owner);
  assert.equal((await deliver(sign(first.fakeIntent!, { webhookId: "wh_reused_id_1" }))).status, 200);
  assert.equal((await deliver(sign(second.fakeIntent!, { webhookId: "wh_reused_id_1" }))).status, 200);
  assert.equal(await intentStatus(first.intent.id), "succeeded");
  assert.equal(await intentStatus(second.intent.id), "succeeded", "le second paiement est crédité malgré l'identifiant déjà vu");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(7_000));
  assert.deepEqual(
    (await env.pool.query<{ intent_id: string; outcome: string }>("SELECT intent_id, outcome FROM sublymus_webhook_deliveries WHERE webhook_id = 'wh_reused_id_1' ORDER BY outcome, intent_id")).rows.map((row) => row.outcome),
    ["applied", "applied"], "chaque livraison qui crédite a SA ligne");

  // Un mauvais corps (montant modifié) arrive d'abord avec l'identifiant X, puis le bon corps avec le MÊME identifiant : la livraison qui crédite a sa ligne.
  const third = await topup(4_000, owner);
  const tampered = sign(third.fakeIntent!, { webhookId: "wh_reused_id_2", data: { amount: 4_001 } });
  const genuine = sign(third.fakeIntent!, { webhookId: "wh_reused_id_2" });
  assert.deepEqual([await deliver(tampered), await deliver(genuine), await deliver(tampered), await deliver(genuine)].map((answer) => answer.status), [200, 200, 200, 200]);
  assert.equal(await intentStatus(third.intent.id), "succeeded");
  assert.equal(await topupTransactions(env.pool, third.intent.id), 1);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(11_000));
  assert.deepEqual(
    (await env.pool.query<{ outcome: string }>("SELECT outcome FROM sublymus_webhook_deliveries WHERE webhook_id = 'wh_reused_id_2' ORDER BY outcome")).rows.map((row) => row.outcome),
    ["anomaly", "applied"], "une ligne pour le mauvais corps, une pour celui qui a crédité, aucune de plus au rejeu");
  assert.deepEqual((await anomalies(third.intent.id)).map((row) => row.kind), ["amount_mismatch"], "le rejeu du mauvais corps n'ajoute aucune anomalie");
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("montant en chaîne décimale : « 1200.0 » et « 1200.00 » sont lus comme 1200 (crédit), toute autre fraction est une anomalie « montant illisible » sans crédit", async () => {
  for (const [text, credited] of [["1200.0", true], ["1200.00", true], ["1200", true], ["1200.5", false], ["1199.99", false], ["1200.", false], ["1,200", false], ["12e2", false]] as const) {
    const handle = await topup(1_200, await login(env.pool));
    assert.equal((await deliver(sign(handle.fakeIntent!, { data: { amount: text } }))).status, 200, text);
    assert.equal(await intentStatus(handle.intent.id), credited ? "succeeded" : "pending", text);
    assert.equal(await topupTransactions(env.pool, handle.intent.id), credited ? 1 : 0, text);
    if (!credited) assert.deepEqual((await anomalies(handle.intent.id)).map((row) => row.kind), ["invalid_amount"], text);
  }
  // Un nombre JSON (1200, 1.2e3) égal au montant est accepté ; 1200.5 jamais.
  const exponent = await topup(1_200, await login(env.pool));
  assert.equal((await deliver(sign(exponent.fakeIntent!, { data: { amount: 1.2e3 } }))).status, 200);
  assert.equal(await intentStatus(exponent.intent.id), "succeeded");
  const fractional = await topup(1_200, await login(env.pool));
  assert.equal((await deliver(sign(fractional.fakeIntent!, { data: { amount: 1200.5 } }))).status, 200);
  assert.equal(await intentStatus(fractional.intent.id), "pending");
  assert.deepEqual((await anomalies(fractional.intent.id)).map((row) => row.kind), ["invalid_amount"]);
});

test("paiement tardif : une recharge échue (expirée) puis payée chez Wave est créditée une fois (l'argent a été pris)", async () => {
  const owner = await login(env.pool);
  const handle = await topup(5_000, owner);
  await env.pool.query("UPDATE payment_intents SET status = 'expired', completed_at = clock_timestamp() WHERE id = $1", [handle.intent.id]);
  assert.equal((await deliver(sign(handle.fakeIntent!))).status, 200);
  assert.equal(await intentStatus(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
});

// ═════════════ 4 bis. Lot PAY1-ter (N7) : identifiants Sublymus avec « . » et « : » ═════════════

for (const sublymusId of ["pi.abc123", "pi:abc123"]) {
  test(`N7 — webhook avec l'identifiant Sublymus « ${sublymusId} » : la contrainte de la base l'accepte, l'identifiant est enregistré, UNE recharge est créditée (200, pas d'échec ni de rejeu infini)`, async () => {
    const owner = await login(env.pool);
    // Intention dont la création de session a été interrompue : l'identifiant Sublymus n'est connu que par le premier événement authentifié.
    const created = await createTopupIntent({ pool: env.pool, ownerId: owner.userId, amountXof: BigInt(1_000), idempotencyKey: crypto.randomUUID(), provider: providerOf(envVars) });
    const fake = api.seed({ id: sublymusId, externalReference: created.intent.providerReference, amount: 1_000, status: "COMPLETED" });
    const answer = await deliver(sign(fake, { webhookId: `wh_n7_${sublymusId.replace(/[^a-z0-9]/g, "_")}` }));
    assert.equal(answer.status, 200, answer.text);
    assert.equal(await intentStatus(created.intent.id), "succeeded");
    assert.equal(await topupTransactions(env.pool, created.intent.id), 1);
    assert.equal(await balanceOf(env.pool, owner.userId), BigInt(1_000));
    assert.equal((await env.pool.query<{ id: string }>("SELECT sublymus_intent_id AS id FROM sublymus_checkouts WHERE intent_id = $1", [created.intent.id])).rows[0].id, sublymusId);
    assert.deepEqual(await anomalies(created.intent.id), []);
    api.intents.delete(sublymusId);
  });
}

// ═════════════ 5. Prestataire inactif, journal ═════════════

test("prestataire fictif actif (pas Sublymus) : la route n'existe pas (404) ; configuration refusée : 503 ; aucun secret ni payeur dans le journal ni la console", async () => {
  const handle = await topup();
  const signed = sign(handle.fakeIntent!);
  const fake = createWalletHttpHandlers({ pool: env.pool, env: { NODE_ENV: "test", NOMA_AUTH_ORIGIN: "https://noma.test", NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: randomBytes(24).toString("hex") } });
  assert.equal((await deliver(signed, fake)).status, 404);
  const broken = createWalletHttpHandlers({ pool: env.pool, env: { ...envVars, WAVE_API_KEY: "" }, log: (code) => { logs.push(code); } });
  assert.equal((await deliver(signed, broken)).status, 503);
  assert.ok(logs.includes("provider_misconfigured"));
  assert.equal(await intentStatus(handle.intent.id), "pending");
  for (const line of [...logs, ...consoleLines]) {
    assert.ok(!line.includes(TEST_API_KEY) && !line.includes(TEST_WEBHOOK_SECRET), "ni clé ni secret");
  }
});
