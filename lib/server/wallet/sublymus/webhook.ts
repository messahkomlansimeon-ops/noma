import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withPostgresTransaction } from "../../postgres/client";
import { WALLET_LOCK_TIMEOUT_MS } from "../config";
import { parseStrictJson } from "../strict-json";
import { applyProviderEventInTransaction, type PaymentEventOutcome, type PaymentEventType, type ProviderEventResult } from "../topups";
import { recordAnomaly, type AnomalyKind } from "./anomalies";
import { readAmount } from "./client";
import { SUBLYMUS_EVENTS, SUBLYMUS_IDENTIFIER, SUBLYMUS_PROVIDER, SUBLYMUS_SOURCE_SYSTEM, type SublymusEventName } from "./config";

/**
 * Webhook Sublymus → noma (lot PAY1), `POST /api/webhooks/sublymus`. ORDRE de traitement (contrat du fournisseur) :
 *   1. corps BRUT lu en entier (64 Kio au plus : fait par la route) ;
 *   2. signature `X-Wave-Signature` (HMAC-SHA256 hexadécimal du corps brut, secret SUBLYMUS_WEBHOOK_SECRET) vérifiée À TEMPS CONSTANT, AVANT tout parsing ;
 *   3. `X-Manager-Id` égal à NOTRE gestionnaire ;
 *   4. SEULEMENT ENSUITE, lecture du corps (JSON strict) : `{ event, data, timestamp }`. Un événement AUTHENTIFIÉ mais illisible ou inconnu (payment.refunded, nombre absurde,
 *      BOM, data.id invalide…) ne donne JAMAIS 400 : 200, une anomalie (`unreadable_event`, `unknown_event`) et un code au journal, rien n'est crédité. Seule une signature
 *      (ou un gestionnaire) invalide donne 401.
 * Puis, dans UNE transaction : intention verrouillée par sa référence EXACTE, livraison déjà vue (rejeu : rien), vérifications (événement, identifiant Sublymus, montant, devise,
 * statut, payeur, système source) ; au moindre écart : RIEN n'est crédité, une anomalie est journalisée, et on répond 2xx (Sublymus ne doit pas rejouer en boucle un écart qui ne
 * se corrigera pas : la table de rapprochement est la liste à traiter à la main). Sinon le crédit passe par `applyProviderEventInTransaction`, la MÊME écriture que le prestataire
 * fictif : partie double, une seule fois par intention quel que soit le nombre de livraisons (rejeu, livraisons simultanées, rattrapage). Voir PAIEMENT-WAVE.md.
 */

// ───────────── signature ─────────────

const SIGNATURE_HEX = /^[0-9a-fA-F]{64}$/;

/** HMAC-SHA256 du corps brut, en hexadécimal minuscule : valeur de `X-Wave-Signature` (sert aux essais et au faux Sublymus, jamais à une comparaison). */
export function signSublymusBody(secret: string, body: Uint8Array | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Comparaison À TEMPS CONSTANT du HMAC du corps BRUT. Un en-tête absent, non hexadécimal ou de mauvaise longueur est refusé sans comparaison. */
export function verifySublymusSignature(secret: string, body: Uint8Array, signature: string | null): boolean {
  if (signature === null || !SIGNATURE_HEX.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

/** Égalité de deux textes à temps constant (leurs empreintes ont toutes la même longueur). */
export function safeEqualText(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

// ───────────── lecture du corps ─────────────

export interface ParsedSublymusWebhook {
  event: SublymusEventName;
  dataId: string;
  externalReference: string;
  /** null : montant absent ou illisible. */
  amountXof: bigint | null;
  currency: string | null;
  status: string | null;
  payerId: string | null;
  sourceSystem: string | null;
}

const DATA_ID = SUBLYMUS_IDENTIFIER;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SublymusWebhookRead =
  | { ok: true; parsed: ParsedSublymusWebhook }
  /** `unknown_event` : JSON lisible dont l'événement n'est pas payment.completed / payment.failed ; `unreadable` : tout le reste (octets, JSON, forme, data.id, référence). */
  | { ok: false; reason: "unreadable" | "unknown_event"; eventName: string | null; externalReference: string | null };

function referenceOf(data: Record<string, unknown>): string | null {
  const reference = typeof data.externalReference === "string" ? data.externalReference : typeof data.external_reference === "string" ? data.external_reference : null;
  return reference !== null && reference.length >= 1 && reference.length <= 100 ? reference : null;
}

/** Lit un corps DÉJÀ authentifié ; ne lève jamais. Une forme qui n'est pas celle du contrat donne `ok: false` avec la raison (aucun crédit, une anomalie). */
export function readSublymusWebhook(body: Uint8Array): SublymusWebhookRead {
  const unreadable = (eventName: string | null = null, externalReference: string | null = null): SublymusWebhookRead => ({ ok: false, reason: "unreadable", eventName, externalReference });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return unreadable();
  }
  let value: unknown;
  try {
    value = parseStrictJson(text, { providerPayload: true });
  } catch {
    return unreadable();
  }
  if (!isObject(value) || typeof value.event !== "string") return unreadable();
  const data = isObject(value.data) ? value.data : null;
  const reference = data ? referenceOf(data) : null;
  if (!(SUBLYMUS_EVENTS as readonly string[]).includes(value.event)) return { ok: false, reason: "unknown_event", eventName: value.event, externalReference: reference };
  if (data === null) return unreadable(value.event);
  const id = typeof data.id === "string" && DATA_ID.test(data.id) ? data.id : null;
  if (id === null || reference === null) return unreadable(value.event, reference);
  const payer = typeof data.payerId === "string" ? data.payerId : typeof data.payer_id === "string" ? data.payer_id : null;
  const source = typeof data.sourceSystem === "string" ? data.sourceSystem : typeof data.source_system === "string" ? data.source_system : null;
  return {
    ok: true,
    parsed: {
      event: value.event as SublymusEventName,
      dataId: id,
      externalReference: reference,
      amountXof: readAmount(data.amount),
      currency: typeof data.currency === "string" ? data.currency : null,
      status: typeof data.status === "string" ? data.status : null,
      payerId: payer,
      sourceSystem: source,
    },
  };
}

/** Lit un corps DÉJÀ authentifié. Renvoie null si la forme du contrat n'est pas respectée (voir `readSublymusWebhook` pour la raison). */
export function parseSublymusWebhook(body: Uint8Array): ParsedSublymusWebhook | null {
  const read = readSublymusWebhook(body);
  return read.ok ? read.parsed : null;
}

// ───────────── vérifications ─────────────

export interface KnownIntent {
  id: string;
  amountXof: bigint;
  /** Identifiant Sublymus déjà enregistré pour la session, ou null. */
  sublymusIntentId: string | null;
}

export interface VerificationInput {
  parsed: ParsedSublymusWebhook;
  /** En-tête X-Wave-Event. */
  headerEvent: string | null;
  intent: KnownIntent | null;
  managerId: string;
}

/**
 * Écarts entre l'événement et NOTRE intention (liste vide : l'événement peut être appliqué). Référence inconnue : seul cet écart est signalé (aucun montant attendu).
 * Le payeur, s'il est présent, est celui de NOTRE gestionnaire (hypothèse à confirmer au premier essai réel : voir PAIEMENT-WAVE.md).
 */
export function verifySublymusEvent(input: VerificationInput): AnomalyKind[] {
  const { parsed, intent } = input;
  if (intent === null) return ["unknown_reference"];
  const kinds: AnomalyKind[] = [];
  if (input.headerEvent !== parsed.event) kinds.push("event_mismatch");
  if (intent.sublymusIntentId !== null && intent.sublymusIntentId !== parsed.dataId) kinds.push("intent_id_mismatch");
  if (parsed.amountXof === null) kinds.push("invalid_amount");
  else if (parsed.amountXof !== intent.amountXof) kinds.push("amount_mismatch");
  if (parsed.currency !== "XOF") kinds.push("currency_mismatch");
  const expectedStatus = parsed.event === "payment.completed" ? "COMPLETED" : "FAILED";
  if (parsed.status !== expectedStatus) kinds.push("status_mismatch");
  if (parsed.payerId !== null && !safeEqualText(parsed.payerId, input.managerId)) kinds.push("payer_mismatch");
  if (parsed.sourceSystem !== null && parsed.sourceSystem !== SUBLYMUS_SOURCE_SYSTEM) kinds.push("source_mismatch");
  return kinds;
}

// ───────────── transaction ─────────────

export interface SublymusWebhookHeaders {
  signature: string | null;
  event: string | null;
  managerId: string | null;
  webhookId: string | null;
}

export type SublymusWebhookResult =
  | { status: "unauthorized" }
  | { status: "received"; outcome: SublymusDeliveryOutcome; anomalies: AnomalyKind[]; replayed: boolean };

export type SublymusDeliveryOutcome = PaymentEventOutcome | "anomaly" | "replayed";

interface IntentRow {
  id: string;
  amount_xof: string;
  status: string;
  sublymus_intent_id: string | null;
}

const WEBHOOK_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Identifiant de livraison : l'en-tête X-Webhook-Id ; absent ou illisible : l'empreinte du corps (le crédit reste de toute façon unique par intention). */
export function deliveryIdOf(headerValue: string | null, payloadSha256: string): string {
  return headerValue !== null && WEBHOOK_ID.test(headerValue) ? headerValue : `body-${payloadSha256.slice(0, 48)}`;
}

/** Identifiant de l'événement dans le journal des paiements : lié à la livraison ET au corps, jamais à un en-tête seul (un en-tête réutilisé avec un autre corps n'efface rien). */
export function paymentEventIdOf(deliveryId: string, payloadSha256: string): string {
  return `wh_${createHash("sha256").update(`${deliveryId}\n${payloadSha256}`).digest("hex").slice(0, 40)}`;
}

/** Applique l'événement (déjà authentifié et lu) en une transaction. Exporté pour l'essai en concurrence. */
export async function applySublymusWebhook(input: {
  client: PoolClient;
  parsed: ParsedSublymusWebhook;
  headerEvent: string | null;
  managerId: string;
  deliveryId: string;
  payloadSha256: string;
}): Promise<{ outcome: SublymusDeliveryOutcome; anomalies: AnomalyKind[]; replayed: boolean }> {
  const { client, parsed, deliveryId, payloadSha256 } = input;
  await client.query(`SET LOCAL lock_timeout = '${WALLET_LOCK_TIMEOUT_MS}ms'`);
  // Référence EXACTE (égalité), jamais un préfixe : une référence voisine est une référence inconnue.
  const found = await client.query<IntentRow>(
    `SELECT p.id, p.amount_xof::text AS amount_xof, p.status, c.sublymus_intent_id
       FROM payment_intents p JOIN sublymus_checkouts c ON c.intent_id = p.id
      WHERE p.provider = $1 AND p.provider_reference = $2
      FOR UPDATE OF p`,
    [SUBLYMUS_PROVIDER, parsed.externalReference],
  );
  const row = found.rows[0] ?? null;
  const intent: KnownIntent | null = row ? { id: row.id, amountXof: BigInt(row.amount_xof), sublymusIntentId: row.sublymus_intent_id } : null;

  // Livraison déjà traitée (même identifiant ET même corps) : rien n'est refait. Le même identifiant avec un AUTRE corps est une autre livraison (clé composite).
  const previous = await client.query("SELECT 1 FROM sublymus_webhook_deliveries WHERE webhook_id = $1 AND payload_sha256 = $2", [deliveryId, payloadSha256]);
  if (previous.rowCount) return { outcome: "replayed", anomalies: [], replayed: true };

  const recordDelivery = async (outcome: Exclude<SublymusDeliveryOutcome, "replayed">): Promise<void> => {
    await client.query(
      `INSERT INTO sublymus_webhook_deliveries (webhook_id, event, intent_id, external_reference, sublymus_intent_id, payload_sha256, outcome)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)
       ON CONFLICT (webhook_id, payload_sha256) DO NOTHING`,
      [deliveryId, parsed.event, intent?.id ?? null, parsed.externalReference.replace(/[^\x20-\x7e]/g, "?").slice(0, 100), parsed.dataId, payloadSha256, outcome],
    );
  };

  const anomalies = verifySublymusEvent({ parsed, headerEvent: input.headerEvent, intent, managerId: input.managerId });
  if (anomalies.length > 0) {
    for (const kind of anomalies) {
      await recordAnomaly(client, {
        kind,
        origin: "webhook",
        dedupeKey: `${deliveryId}.${payloadSha256.slice(0, 16)}`,
        intentId: intent?.id ?? null,
        externalReference: parsed.externalReference,
        webhookId: deliveryId,
        sublymusIntentId: parsed.dataId,
        expectedAmountXof: intent?.amountXof ?? null,
        receivedAmountXof: parsed.amountXof,
        receivedCurrency: parsed.currency,
        receivedStatus: parsed.status,
        payerId: parsed.payerId,
      });
    }
    await recordDelivery("anomaly");
    return { outcome: "anomaly", anomalies, replayed: false };
  }
  if (intent === null) throw new Error("invariant : aucune anomalie sans intention");

  // L'identifiant Sublymus de la session : enregistré au premier événement authentifié s'il manquait (création interrompue après l'appel au prestataire).
  if (intent.sublymusIntentId === null) {
    const taken = await client.query("SELECT 1 FROM sublymus_checkouts WHERE sublymus_intent_id = $1 AND intent_id <> $2::uuid", [parsed.dataId, intent.id]);
    if (taken.rowCount) {
      await recordAnomaly(client, {
        kind: "intent_id_mismatch", origin: "webhook", dedupeKey: `${deliveryId}.${payloadSha256.slice(0, 16)}`, intentId: intent.id, externalReference: parsed.externalReference,
        webhookId: deliveryId, sublymusIntentId: parsed.dataId, expectedAmountXof: intent.amountXof, receivedAmountXof: parsed.amountXof, receivedCurrency: parsed.currency,
        receivedStatus: parsed.status, payerId: parsed.payerId,
      });
      await recordDelivery("anomaly");
      return { outcome: "anomaly", anomalies: ["intent_id_mismatch"], replayed: false };
    }
    await client.query("UPDATE sublymus_checkouts SET sublymus_intent_id = $2 WHERE intent_id = $1::uuid AND sublymus_intent_id IS NULL", [intent.id, parsed.dataId]);
  }

  const type: PaymentEventType = parsed.event === "payment.completed" ? "payment.succeeded" : "payment.failed";
  // Un paiement RÉUSSI qui arrive après un échec est appliqué comme un paiement tardif (l'argent a été pris chez Wave) ; l'anomalie « conflit d'état » le signale.
  const applied: ProviderEventResult = await applyProviderEventInTransaction(client, {
    provider: SUBLYMUS_PROVIDER,
    eventId: paymentEventIdOf(deliveryId, payloadSha256),
    type,
    providerReference: parsed.externalReference,
    amountXof: intent.amountXof,
    payloadSha256,
  }, { allowSuccessAfterFailure: true });
  const outcome: SublymusDeliveryOutcome = applied.outcome;
  const result: AnomalyKind[] = [];
  if (type === "payment.succeeded" && applied.outcome === "applied" && row?.status === "failed") {
    await recordAnomaly(client, {
      kind: "state_conflict", origin: "webhook", dedupeKey: `${deliveryId}.${payloadSha256.slice(0, 16)}`, intentId: intent.id, externalReference: parsed.externalReference,
      webhookId: deliveryId, sublymusIntentId: parsed.dataId, expectedAmountXof: intent.amountXof, receivedAmountXof: parsed.amountXof, receivedCurrency: parsed.currency,
      receivedStatus: parsed.status, payerId: parsed.payerId,
    });
    result.push("state_conflict");
  }
  if (applied.outcome === "applied" || applied.outcome === "duplicate") {
    // Un paiement RÉUSSI termine la session : le rattrapage n'a plus rien à faire pour elle. Lot PAY1-ter (N4) : un ÉCHEC ne la termine pas, elle reste sondée (attente doublée,
    // plafond 1 h, jusqu'à 24 h après la création) : un paiement peut réussir après un échec (l'argent a été pris).
    const finished = type === "payment.succeeded";
    await client.query(
      `UPDATE sublymus_checkouts
          SET provider_status = $2,
              next_catchup_at = CASE WHEN $4::boolean THEN NULL ELSE next_catchup_at END,
              catchup_done_at = CASE WHEN $4::boolean THEN COALESCE(catchup_done_at, clock_timestamp()) ELSE catchup_done_at END,
              last_catchup_outcome = CASE WHEN $3 = 'completed' THEN 'completed' ELSE COALESCE(last_catchup_outcome, $3) END
        WHERE intent_id = $1::uuid`,
      [intent.id, finished ? "COMPLETED" : "FAILED", finished ? "completed" : "failed", finished],
    );
  }
  await recordDelivery(applied.outcome === "replayed" ? "duplicate" : applied.outcome);
  return { outcome, anomalies: result, replayed: applied.outcome === "replayed" };
}

/** Journalise un événement authentifié mais illisible ou inconnu : une anomalie (idempotente), rattachée à l'intention si la référence exacte en désigne une. */
async function recordUnreadableEvent(input: {
  client: PoolClient;
  read: Extract<SublymusWebhookRead, { ok: false }>;
  kind: AnomalyKind;
  deliveryId: string;
  payloadSha256: string;
}): Promise<void> {
  const { client, read } = input;
  let intentId: string | null = null;
  if (read.externalReference !== null) {
    const found = await client.query<{ id: string }>("SELECT id FROM payment_intents WHERE provider = $1 AND provider_reference = $2", [SUBLYMUS_PROVIDER, read.externalReference]);
    intentId = found.rows[0]?.id ?? null;
  }
  await recordAnomaly(client, {
    kind: input.kind,
    origin: "webhook",
    dedupeKey: `${input.deliveryId}.${input.payloadSha256.slice(0, 16)}`,
    intentId,
    externalReference: read.externalReference ?? "?",
    webhookId: input.deliveryId,
    receivedStatus: input.kind === "unknown_event" ? read.eventName : null,
  });
}

/**
 * CHEMIN UNIQUE du webhook : signature (aucune requête SQL si elle est fausse), gestionnaire, lecture du corps, puis application en base. Le pool n'est résolu
 * qu'APRÈS l'authentification : un refus précoce n'ouvre aucune connexion.
 */
export async function processSublymusWebhook(input: {
  pool: Pool | (() => Pool);
  secret: string;
  managerId: string;
  /** Corps BRUT, octets exacts reçus. */
  body: Uint8Array;
  headers: SublymusWebhookHeaders;
}): Promise<SublymusWebhookResult> {
  if (!verifySublymusSignature(input.secret, input.body, input.headers.signature)) return { status: "unauthorized" };
  if (input.headers.managerId === null || !safeEqualText(input.headers.managerId, input.managerId)) return { status: "unauthorized" };
  const read = readSublymusWebhook(input.body);
  const payloadSha256 = createHash("sha256").update(input.body).digest("hex");
  const deliveryId = deliveryIdOf(input.headers.webhookId, payloadSha256);
  const pool = typeof input.pool === "function" ? input.pool() : input.pool;
  if (!read.ok) {
    // Authentifié mais illisible ou inconnu : JAMAIS 400. Une anomalie à traiter, rien de crédité, et on répond 2xx (Sublymus ne doit pas rejouer en boucle).
    const kind: AnomalyKind = read.reason === "unknown_event" ? "unknown_event" : "unreadable_event";
    await withPostgresTransaction((client) => recordUnreadableEvent({ client, read, kind, deliveryId, payloadSha256 }), pool);
    return { status: "received", outcome: "anomaly", anomalies: [kind], replayed: false };
  }
  const parsed = read.parsed;
  const applied = await withPostgresTransaction(
    (client) => applySublymusWebhook({ client, parsed, headerEvent: input.headers.event, managerId: input.managerId, deliveryId, payloadSha256 }),
    pool,
  );
  return { status: "received", outcome: applied.outcome, anomalies: applied.anomalies, replayed: applied.replayed };
}
