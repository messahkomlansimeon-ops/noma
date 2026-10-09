import "server-only";

import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import type { DemandRecord, Money, OfferRecord } from "../catalog/types";
import type { SqlExecutor } from "../postgres/client";
import { evaluateOfflineMatching } from "../matching/offline";
import { loadSourceDemand } from "../matching/service";
import { computeMatchingScore } from "../matching/scoring";
import { requireUuid } from "../catalog/validation";
import { ANALYZER_VERSION, confirmsKey, parseAnalysis, type ListingAnalysis } from "./analysis";
import {
  EXTERNAL_OWNER_ID,
  EXTERNAL_PAGE_DEFAULT,
  EXTERNAL_PAGE_MAX,
  GONE_AFTER_MISSED_COLLECTS,
  MATCH_CANDIDATE_LIMIT,
  VISIBLE_MAX_AGE_MS,
} from "./config";
import { isDuplicatePair, type DuplicateCandidate } from "./duplicates";
import { productKeyOf } from "./product-key";
import type { ProductKey } from "./types";
import { readWatchByKey } from "./watches";

/**
 * Mise en relation des annonces externes avec un besoin (lot EXT1). Lecture seule, calculée à la demande avec les MÊMES filtres de compatibilité que le matching interne
 * (`evaluateOfflineMatching` : catégorie, marque, modèle, variante, budget, lieu, quantité, état, exigences) et le MÊME score (`computeMatchingScore`). Seules les annonces
 * COMPATIBLES sont montrées (comme les correspondances confirmées internes) : une information inconnue n'est jamais présentée comme confirmée.
 *
 * Ces annonces ne passent JAMAIS dans le classement interne ni dans le boost : elles n'existent pas dans `offers`, n'ont ni propriétaire ni évaluation enregistrée, et la page
 * les présente dans une section SÉPARÉE. Le titre confirme le produit (`confirmsKey`) : sans confirmation, marque, modèle et catégorie restent inconnus et l'annonce est écartée.
 *
 * Fraîcheur : n'est montrée qu'une annonce VUE (présente dans la réponse de sa source) il y a moins de 48 h (`last_seen_at`) ; la date affichée (« Vue le ») est cette date de vue,
 * jamais la date d'un examen où l'annonce était absente (`last_checked_at`). Aucune information sur la surveillance partagée (existence, dernière collecte) n'est renvoyée : elle
 * dirait à un acheteur ce que d'autres acheteurs ont cherché.
 */

export interface ExternalSourceRef {
  code: string;
  name: string;
}

export interface ExternalMatchItem {
  /** Identifiant de l'annonce externe (jamais l'identifiant chez la source). */
  id: string;
  title: string;
  price: Money | null;
  location: string | null;
  listedAt: Date | null;
  source: ExternalSourceRef;
  /** Autres sources où la même annonce a été trouvée (groupe de doublons). */
  alsoOn: ExternalSourceRef[];
  /** Lien vers l'annonce chez la source (https). */
  url: string;
  /** Score de compatibilité 0 à 100 (le même calcul que le matching interne). */
  score: number;
  /** Dernière fois qu'une collecte a VU l'annonce dans la réponse de sa source (« Vue le »). */
  seenAt: Date;
  confirmedAt: Date | null;
}

export interface ExternalMatchesPage {
  items: ExternalMatchItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ExternalMatchesQuery {
  pool: Pool;
  ownerId: string;
  demandId: string;
  limit?: number;
  cursor?: string;
  now?: Date;
}

export interface CandidateRow {
  id: string;
  source_code: string;
  source_name: string;
  canonical_url: string;
  title: string | null;
  price_amount: string | null;
  price_currency: string | null;
  location_text: string | null;
  listed_at: Date | null;
  availability_confirmed_at: Date | null;
  last_seen_at: Date;
  first_seen_at: Date;
  duplicate_group_id: string | null;
  analysis: unknown;
}

/** L'annonce externe vue comme une offre publiée d'un propriétaire fictif, pour passer par les MÊMES filtres. Sans confirmation du titre, produit et catégorie restent inconnus. */
export function externalListingAsOffer(
  row: Pick<CandidateRow, "id" | "title" | "price_amount" | "price_currency" | "location_text" | "availability_confirmed_at" | "first_seen_at" | "last_seen_at">,
  analysis: ListingAnalysis,
  key: ProductKey,
): OfferRecord {
  const confirmed = confirmsKey(analysis, key);
  return {
    id: row.id,
    ownerId: EXTERNAL_OWNER_ID,
    status: "published",
    price: row.price_amount !== null && row.price_currency !== null ? { amount: Number(row.price_amount), currency: row.price_currency } : null,
    availabilityStatus: "available",
    availabilityConfirmedAt: row.availability_confirmed_at,
    contentVersion: 1,
    createdAt: row.first_seen_at,
    updatedAt: row.last_seen_at,
    archivedAt: null,
    rawText: row.title ?? "",
    category: confirmed ? key.category : null,
    brand: confirmed ? key.brand : null,
    model: confirmed ? key.model : null,
    variant: confirmed ? key.variant : null,
    attributes: null,
    condition: null,
    quantity: null,
    unit: null,
    location: row.location_text,
    deadlineAt: null,
    extractorVersion: ANALYZER_VERSION,
    extractionMetadata: null,
    extractedAt: null,
  };
}

export interface Evaluated {
  row: CandidateRow;
  candidate: DuplicateCandidate;
  score: number;
  price: number | null;
}

/** Ordre d'affichage : meilleur score, puis prix croissant (sans prix en dernier), puis identifiant. */
export function compareEvaluated(a: Pick<Evaluated, "score" | "price"> & { row: { id: string } }, b: Pick<Evaluated, "score" | "price"> & { row: { id: string } }): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.price !== b.price) {
    if (a.price === null) return 1;
    if (b.price === null) return -1;
    return a.price - b.price;
  }
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

interface CursorPayload {
  s: number;
  p: number | null;
  i: string;
}

export function encodeExternalCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Curseur opaque strictement validé (score, prix, identifiant) ; toute autre forme est une requête invalide. */
export function decodeExternalCursor(cursor: unknown): CursorPayload | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CatalogValidationError("Curseur invalide.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CatalogValidationError("Curseur invalide.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CatalogValidationError("Curseur invalide.");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "i,p,s") throw new CatalogValidationError("Curseur invalide.");
  if (typeof record.s !== "number" || !Number.isFinite(record.s) || typeof record.i !== "string" || !/^[0-9a-f-]{36}$/.test(record.i)) throw new CatalogValidationError("Curseur invalide.");
  if (record.p !== null && (typeof record.p !== "number" || !Number.isSafeInteger(record.p) || record.p < 0)) throw new CatalogValidationError("Curseur invalide.");
  return { s: record.s, p: record.p as number | null, i: record.i };
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return EXTERNAL_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXTERNAL_PAGE_MAX) throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${EXTERNAL_PAGE_MAX}.`);
  return limit;
}

export interface CollapsedListing {
  /** Annonce présentée (la moins chère du groupe de doublons). */
  entry: Evaluated;
  /** Autres sources où la même annonce a été trouvée. */
  alsoOn: ExternalSourceRef[];
  /**
   * Identifiants des annonces ABSORBÉES par celle-ci : seulement les membres du groupe qui sont ENCORE des doublons de l'annonce présentée (revérifiés comme à la lecture). Un membre qui
   * n'est plus un doublon (prix, capacité ou titre ayant évolué) n'est jamais absorbé : il est présenté à part. La recherche active (lot RA1) marque « vues » l'annonce présentée ET
   * ces seules annonces, jamais un membre de groupe que la lecture montre séparément.
   */
  absorbedIds: string[];
}

/**
 * Regroupe les doublons : par groupe, l'annonce la moins chère est présentée et les autres sources où la même annonce a été trouvée sont listées (`alsoOn`). Un membre qui n'est
 * plus un doublon (prix, capacité ou titre ayant évolué) est présenté séparément : le groupe enregistré n'est jamais cru sur parole.
 */
export function collapseDuplicates(evaluated: readonly Evaluated[]): CollapsedListing[] {
  const byGroup = new Map<string, Evaluated[]>();
  const result: CollapsedListing[] = [];
  for (const entry of evaluated) {
    if (entry.row.duplicate_group_id === null) result.push({ entry, alsoOn: [], absorbedIds: [] });
    else byGroup.set(entry.row.duplicate_group_id, [...(byGroup.get(entry.row.duplicate_group_id) ?? []), entry]);
  }
  const cheaper = (a: Evaluated, b: Evaluated): number => {
    if (a.price !== b.price) return a.price === null ? 1 : b.price === null ? -1 : a.price - b.price;
    const byDate = a.row.first_seen_at.getTime() - b.row.first_seen_at.getTime();
    return byDate !== 0 ? byDate : a.row.source_code < b.row.source_code ? -1 : a.row.source_code > b.row.source_code ? 1 : 0;
  };
  for (const members of byGroup.values()) {
    const remaining = [...members].sort(cheaper);
    while (remaining.length > 0) {
      const representative = remaining.shift() as Evaluated;
      const absorbed = remaining.filter((other) => isDuplicatePair(representative.candidate, other.candidate));
      for (const other of absorbed) remaining.splice(remaining.indexOf(other), 1);
      const seen = new Set<string>([representative.row.source_code]);
      const alsoOn: ExternalSourceRef[] = [];
      for (const other of absorbed) {
        if (seen.has(other.row.source_code)) continue;
        seen.add(other.row.source_code);
        alsoOn.push({ code: other.row.source_code, name: other.row.source_name });
      }
      result.push({ entry: representative, alsoOn, absorbedIds: absorbed.map((other) => other.row.id) });
    }
  }
  return result;
}

export interface ExternalEvaluation {
  /** Surveillance de la clé du besoin ; null s'il n'y en a pas (besoin sans clé, ou surveillance jamais créée). */
  watch: Awaited<ReturnType<typeof readWatchByKey>>;
  /** Annonces COMPATIBLES (mêmes filtres que le matching interne), VUES il y a moins de 48 h, doublons repliés, triées : score, prix, identifiant. */
  items: CollapsedListing[];
  /** Les mêmes annonces AVANT le repli des doublons (une entrée par annonce) : la recherche active compare une annonce nouvelle à ce qu'elle a déjà vu. */
  candidates: Evaluated[];
}

/**
 * Évalue les annonces d'autres sites visibles pour un besoin DÉJÀ chargé (contrôles d'accès faits par l'appelant) : mêmes filtres, même fraîcheur (`last_seen_at` de moins de 48 h), même
 * score que le matching interne, doublons repliés, tri stable. Lecture seule, sur l'exécuteur fourni (un client de transaction, par exemple). Sert à la lecture de l'acheteur ET à la
 * recherche active (annonces nouvelles).
 */
export async function evaluateExternalForDemand(executor: SqlExecutor, demand: DemandRecord, now: Date): Promise<ExternalEvaluation> {
  const key = productKeyOf({ category: demand.category, brand: demand.brand, model: demand.model, variant: demand.variant, location: demand.location });
  if (key === null) return { watch: null, items: [], candidates: [] };
  const watch = await readWatchByKey(executor, key);
  if (watch === null) return { watch: null, items: [], candidates: [] };

  const rows = await executor.query<CandidateRow>(
    `SELECT l.id, l.source_code, s.name AS source_name, l.canonical_url, l.title, l.price_amount::text AS price_amount, l.price_currency, l.location_text, l.listed_at,
            l.availability_confirmed_at, l.last_seen_at, l.first_seen_at, l.duplicate_group_id, a.analysis
       FROM source_observations o
       JOIN external_listings l ON l.id = o.listing_id
       JOIN external_analyses a ON a.content_hash = l.content_hash
       JOIN external_sources s ON s.code = l.source_code
      WHERE o.watch_id = $1::uuid AND o.missed_collects < $2::int AND l.availability_status = 'available'
        AND l.last_seen_at >= $3::timestamptz AND s.enabled = TRUE AND s.type = 'fake'
      ORDER BY l.last_seen_at DESC, l.id
      LIMIT $4::int`,
    [watch.id, GONE_AFTER_MISSED_COLLECTS, new Date(now.getTime() - VISIBLE_MAX_AGE_MS), MATCH_CANDIDATE_LIMIT],
  );

  const evaluated: Evaluated[] = [];
  for (const row of rows.rows) {
    const analysis = parseAnalysis(row.analysis);
    if (analysis === null) continue;
    const offer = externalListingAsOffer(row, analysis, key);
    const evaluation = evaluateOfflineMatching(offer, demand, { now });
    if (evaluation.eligibility.status !== "eligible" || evaluation.compatibility.status !== "compatible") continue;
    const scoring = computeMatchingScore(evaluation, { now });
    if (scoring.score === null) continue;
    const price = row.price_amount === null ? null : Number(row.price_amount);
    evaluated.push({
      row,
      score: scoring.score,
      price,
      candidate: { sourceCode: row.source_code, priceAmount: price, priceCurrency: row.price_currency, tokens: analysis.tokens, url: row.canonical_url },
    });
  }
  return { watch, items: collapseDuplicates(evaluated).sort((a, b) => compareEvaluated(a.entry, b.entry)), candidates: evaluated };
}

/** Annonces externes compatibles avec un besoin ACTIF de l'utilisateur, en lecture seule. 404 pour un besoin d'autrui, 400 pour un besoin inactif (comme la lecture interne). */
export async function listExternalMatchesForDemand(query: ExternalMatchesQuery): Promise<ExternalMatchesPage> {
  const ownerId = requireUuid(query.ownerId, "ownerId").toLowerCase();
  const demandId = requireUuid(query.demandId, "demandId").toLowerCase();
  const limit = validateLimit(query.limit);
  const cursor = decodeExternalCursor(query.cursor);
  const now = query.now ?? new Date();
  const demand = await loadSourceDemand(ownerId, demandId, query.pool);
  const { watch, items: collapsed } = await evaluateExternalForDemand(query.pool, demand, now);
  const empty: ExternalMatchesPage = { items: [], nextCursor: null, hasMore: false };
  if (watch === null) return empty;

  const after = cursor === null ? collapsed : collapsed.filter((item) => compareEvaluated(item.entry, { score: cursor.s, price: cursor.p, row: { id: cursor.i } }) > 0);
  const page = after.slice(0, limit);
  const hasMore = after.length > limit;
  const items: ExternalMatchItem[] = page.map(({ entry, alsoOn }) => ({
    id: entry.row.id,
    title: entry.row.title as string,
    price: entry.row.price_amount !== null && entry.row.price_currency !== null ? { amount: Number(entry.row.price_amount), currency: entry.row.price_currency } : null,
    location: entry.row.location_text,
    listedAt: entry.row.listed_at,
    source: { code: entry.row.source_code, name: entry.row.source_name },
    alsoOn,
    url: entry.row.canonical_url,
    score: entry.score,
    seenAt: entry.row.last_seen_at,
    confirmedAt: entry.row.availability_confirmed_at,
  }));
  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeExternalCursor({ s: last.entry.score, p: last.entry.price, i: last.entry.row.id }) : null,
  };
}
