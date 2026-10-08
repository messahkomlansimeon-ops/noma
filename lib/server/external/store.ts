import "server-only";

import type { Pool, PoolClient } from "pg";
import { analyzeContent, contentHashOf, type AnalyzableContent, type ListingAnalysis } from "./analysis";
import { EXTERNAL_ANALYSIS_LOCK_NAMESPACE, GONE_AFTER_MISSED_COLLECTS } from "./config";
import type { SanitizedBatch, SanitizedListing } from "./sanitize";
import type { WatchRow } from "./types";

/**
 * Stockage d'une réponse de source (lot EXT1) : annonces normalisées, analyses par contenu, observations, disponibilité et regroupement entre sources.
 *
 * - Unicité (source, identifiant externe) ET (source, URL canonique) : une annonce déjà connue de CETTE source est MISE À JOUR, jamais dupliquée. La même adresse chez une AUTRE source
 *   est une autre ligne (regroupée ensuite comme doublon) : une source ne peut ni réécrire ni faire disparaître l'annonce d'une autre.
 * - Le même contenu n'est analysé qu'une fois (`content_hash`, verrou consultatif par empreinte) ; une annonce inchangée n'est pas renormalisée.
 * - Une annonce que la source signale indisponible passe à « gone » ; une annonce absente de 3 collectes réussies de suite (toutes ses observations) aussi. Une panne n'est jamais une absence.
 * - Aucune annonce n'est supprimée ni fusionnée. Le regroupement entre sources est fait APRÈS le stockage de toutes les sources d'une surveillance (`grouping.ts`).
 * - Une seule transaction, mais chaque annonce est écrite dans un POINT DE SAUVEGARDE : une annonce que la base refuse (erreur de donnée) est rejetée seule, les annonces saines du même
 *   lot sont stockées. Si TOUTES sont refusées, rien n'est écrit et l'appelant classe la réponse en échec de la source (`isListingDataError`).
 * - Ordre des verrous (pas d'interblocage entre deux surveillances qui partagent des annonces) : TOUTES les annonces que la transaction peut modifier (celles de la réponse ET celles
 *   que la surveillance a déjà observées chez cette source) sont verrouillées d'emblée, triées par identifiant ; les écritures suivantes ne prennent plus aucun verrou de ligne nouveau.
 * - Dates robustes à l'écart d'horloge entre deux machines : `first_seen_at` ne fait que reculer, `last_seen_at` et `last_checked_at` que avancer.
 */

export type Analyzer = (content: AnalyzableContent) => ListingAnalysis;

export interface StoreInput {
  watch: Pick<WatchRow, "id" | "product_key">;
  sourceCode: string;
  batch: SanitizedBatch;
  now: Date;
  /** Analyseur (défaut : `analyzeContent`) ; injectable pour compter les analyses. */
  analyze?: Analyzer;
}

export interface StoreOutcome {
  /** Annonces écrites ou mises à jour. */
  stored: number;
  created: number;
  /** Contenu différent de celui déjà stocké. */
  changed: number;
  /** Contenu identique : aucune renormalisation. */
  unchanged: number;
  /** Annonces revenues de « gone » à « available ». */
  revived: number;
  /** Annonces passées à « gone » parce que la source les signale indisponibles. */
  goneBySource: number;
  /** Annonces passées à « gone » après 3 collectes sans elles. */
  goneByAbsence: number;
  /** Analyses RÉELLEMENT faites (contenus jamais vus). */
  analyzed: number;
  /** Annonces dont le contenu était déjà analysé. */
  analysisReused: number;
  rejected: number;
  phoneRemoved: number;
  duplicatesInResponse: number;
  truncated: number;
}

/**
 * Erreur de DONNÉE de la base (classe 22 : donnée hors plage ou mal formée ; 23514 : contrainte de contrôle ; 23505 : unicité) : la faute est celle de la réponse de la source, pas de
 * l'infrastructure. Les autres erreurs (connexion, interblocage, droits…) restent des erreurs d'infrastructure.
 */
export function isListingDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (/^22/.test(code) || code === "23514" || code === "23505");
}

/** Interblocage ou conflit de sérialisation : transitoire, la faute n'est ni de la source ni de l'infrastructure. */
export function isStoreConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "40001";
}

/** Toutes les annonces d'une réponse non vide ont été refusées par la base : la réponse est inexploitable (la source a changé de format). */
export class AllListingsRejectedError extends Error {
  readonly code = "22000";
  constructor() {
    super("all_listings_rejected");
    this.name = "AllListingsRejectedError";
  }
}

interface ExistingRow {
  id: string;
  content_hash: string;
  availability_status: "available" | "gone" | "unknown";
}

const contentOf = (listing: SanitizedListing): AnalyzableContent => ({
  title: listing.title,
  priceAmount: listing.priceAmount,
  priceCurrency: listing.priceCurrency,
  location: listing.location,
});

/**
 * Garantit qu'une analyse existe pour chaque empreinte. Les empreintes déjà analysées ne coûtent qu'une lecture ; chaque empreinte nouvelle est analysée dans une courte transaction
 * sous un verrou consultatif PAR EMPREINTE (deux processus qui rencontrent le même contenu neuf ne l'analysent qu'une fois : le second relit l'analyse du premier).
 */
async function ensureAnalyses(pool: Pool, contents: Map<string, AnalyzableContent>, analyze: Analyzer, now: Date): Promise<number> {
  const hashes = [...contents.keys()];
  if (hashes.length === 0) return 0;
  const known = await pool.query<{ content_hash: string }>("SELECT content_hash FROM external_analyses WHERE content_hash = ANY($1::text[])", [hashes]);
  const present = new Set(known.rows.map((row) => row.content_hash));
  const missing = hashes.filter((hash) => !present.has(hash));
  if (missing.length === 0) return 0;
  let analyzed = 0;
  const client = await pool.connect();
  try {
    for (const hash of missing) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [EXTERNAL_ANALYSIS_LOCK_NAMESPACE, hash]);
        const again = await client.query("SELECT 1 FROM external_analyses WHERE content_hash = $1", [hash]);
        if (again.rowCount === 0) {
          const analysis = analyze(contents.get(hash) as AnalyzableContent);
          await client.query(
            "INSERT INTO external_analyses (content_hash, analysis, analyzer_version, analyzed_at) VALUES ($1, $2::jsonb, $3, $4::timestamptz) ON CONFLICT (content_hash) DO NOTHING",
            [hash, JSON.stringify(analysis), analysis.version, now],
          );
          analyzed += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    client.release();
  }
  return analyzed;
}

async function findExisting(client: PoolClient, sourceCode: string, listing: SanitizedListing): Promise<ExistingRow | null> {
  const found = await client.query<ExistingRow>(
    `SELECT id, content_hash, availability_status FROM external_listings
      WHERE source_code = $1 AND (external_id = $2 OR canonical_url = $3)
      ORDER BY (external_id = $2) DESC, id
      LIMIT 1 FOR UPDATE`,
    [sourceCode, listing.externalId, listing.url],
  );
  return found.rows[0] ?? null;
}

/** Statut après observation selon ce que la source dit de la disponibilité (« unknown » : la présence dans une recherche ne confirme pas le stock). */
function statusAfterSighting(listing: SanitizedListing): "available" | "gone" | "unknown" {
  if (listing.availability === "available") return "available";
  if (listing.availability === "unavailable") return "gone";
  return "unknown";
}

/**
 * Verrouille d'emblée, triées par identifiant, toutes les annonces que la transaction peut modifier : celles de la réponse (par identifiant externe ou adresse, chez cette source) et
 * celles que la surveillance a déjà observées chez cette source (elles recevront une absence, et peut-être « gone »). Deux transactions qui se recoupent prennent donc leurs verrous
 * dans le même ordre : aucun interblocage possible entre elles.
 */
async function lockListings(client: PoolClient, watchId: string, sourceCode: string, listings: readonly SanitizedListing[]): Promise<void> {
  await client.query(
    `SELECT id FROM external_listings
      WHERE id IN (
        SELECT l.id FROM external_listings l
         WHERE l.source_code = $1 AND (l.external_id = ANY($2::text[]) OR l.canonical_url = ANY($3::text[]))
        UNION
        SELECT o.listing_id FROM source_observations o JOIN external_listings l ON l.id = o.listing_id
         WHERE o.watch_id = $4::uuid AND l.source_code = $1)
      ORDER BY id
      FOR UPDATE`,
    [sourceCode, listings.map((listing) => listing.externalId), listings.map((listing) => listing.url), watchId],
  );
}

interface Written {
  id: string;
  change: "created" | "unchanged" | "changed";
  revived: boolean;
}

/** Écrit UNE annonce (insertion ou mise à jour) et son observation. Lève l'erreur de la base telle quelle (le point de sauvegarde de l'appelant la contient). */
async function writeListing(client: PoolClient, watchId: string, sourceCode: string, listing: SanitizedListing, hash: string, now: Date): Promise<Written | null> {
  const existing = await findExisting(client, sourceCode, listing);
  let written: Written;
  if (existing === null) {
    const status = statusAfterSighting(listing);
    const confirmed = listing.availability !== "unknown";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO external_listings (source_code, external_id, canonical_url, title, price_amount, price_currency, location_text, listed_at, availability_status,
                                      availability_confirmed_at, availability_origin, content_hash, first_seen_at, last_seen_at, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $13)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [sourceCode, listing.externalId, listing.url, listing.title, listing.priceAmount, listing.priceCurrency, listing.location, listing.listedAt, status, confirmed ? now : null, confirmed ? "source" : null, hash, now],
    );
    if (inserted.rows[0]) {
      written = { id: inserted.rows[0].id, change: "created", revived: false };
    } else {
      // Une autre transaction vient d'écrire la même annonce : elle est relue (verrouillée) puis mise à jour comme une annonce connue.
      const raced = await findExisting(client, sourceCode, listing);
      if (raced === null) return null;
      written = await updateKnown(client, sourceCode, raced, listing, hash, now);
    }
  } else {
    written = await updateKnown(client, sourceCode, existing, listing, hash, now);
  }
  await client.query(
    `INSERT INTO source_observations (watch_id, listing_id, first_seen_at, last_seen_at, missed_collects) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz, 0)
     ON CONFLICT (watch_id, listing_id) DO UPDATE SET first_seen_at = LEAST(source_observations.first_seen_at, $3::timestamptz),
       last_seen_at = GREATEST(source_observations.last_seen_at, $3::timestamptz), missed_collects = 0`,
    [watchId, written.id, now],
  );
  return written;
}

/**
 * Écrit la réponse d'une source pour une surveillance. Une seule transaction pour les annonces, les observations, les absences et la disponibilité : tout ou rien, sauf qu'une annonce
 * refusée par la base (erreur de donnée) est rejetée SEULE (point de sauvegarde). Le regroupement entre sources est fait ensuite (`grouping.ts`).
 */
export async function storeSearchResult(pool: Pool, input: StoreInput): Promise<StoreOutcome> {
  const { watch, sourceCode, batch, now } = input;
  const analyze = input.analyze ?? analyzeContent;
  const outcome: StoreOutcome = {
    stored: 0, created: 0, changed: 0, unchanged: 0, revived: 0, goneBySource: 0, goneByAbsence: 0, analyzed: 0, analysisReused: 0,
    rejected: batch.rejected, phoneRemoved: batch.phoneRemoved, duplicatesInResponse: batch.duplicatesInResponse, truncated: batch.truncated,
  };

  // Ordre stable des écritures entre deux transactions concurrentes.
  const listings = [...batch.listings].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
  const hashes = new Map<string, AnalyzableContent>();
  const hashOf = new Map<SanitizedListing, string>();
  for (const listing of listings) {
    const content = contentOf(listing);
    const hash = contentHashOf(content);
    hashOf.set(listing, hash);
    if (!hashes.has(hash)) hashes.set(hash, content);
  }
  outcome.analyzed = await ensureAnalyses(pool, hashes, analyze, now);
  outcome.analysisReused = listings.length - outcome.analyzed;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockListings(client, watch.id, sourceCode, listings);
    const seen: string[] = [];
    const refused: string[] = [];
    for (const listing of listings) {
      await client.query("SAVEPOINT listing_write");
      let written: Written | null;
      try {
        written = await writeListing(client, watch.id, sourceCode, listing, hashOf.get(listing) as string, now);
        await client.query("RELEASE SAVEPOINT listing_write");
      } catch (error) {
        if (!isListingDataError(error)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT listing_write");
        await client.query("RELEASE SAVEPOINT listing_write");
        refused.push(listing.externalId);
        continue;
      }
      if (written === null) continue;
      if (written.change === "created") outcome.created += 1;
      else if (written.change === "unchanged") outcome.unchanged += 1;
      else outcome.changed += 1;
      if (written.revived) outcome.revived += 1;
      outcome.stored += 1;
      seen.push(written.id);
    }
    if (refused.length > 0 && refused.length === listings.length) throw new AllListingsRejectedError();
    outcome.rejected += refused.length;
    outcome.goneBySource = listings.filter((listing) => listing.availability === "unavailable" && !refused.includes(listing.externalId)).length;

    // Absences : une collecte RÉUSSIE sans l'annonce compte pour une absence de cette surveillance. Une annonce que la base a refusée n'est pas une absence.
    await client.query(
      `WITH absent AS (
         UPDATE source_observations o SET missed_collects = o.missed_collects + 1
           FROM external_listings l
          WHERE o.watch_id = $1::uuid AND o.listing_id = l.id AND l.source_code = $2 AND NOT (o.listing_id = ANY($3::uuid[])) AND l.external_id <> ALL($5::text[])
         RETURNING o.listing_id
       )
       UPDATE external_listings SET last_checked_at = GREATEST(last_checked_at, $4::timestamptz) WHERE id IN (SELECT listing_id FROM absent)`,
      [watch.id, sourceCode, seen, now, refused],
    );
    const gone = await client.query(
      `UPDATE external_listings l
          SET availability_status = 'gone', availability_confirmed_at = $4::timestamptz, availability_origin = 'absence'
        WHERE l.source_code = $2 AND l.availability_status <> 'gone'
          AND EXISTS (SELECT 1 FROM source_observations o WHERE o.listing_id = l.id AND o.watch_id = $1::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM source_observations o JOIN market_watches w ON w.id = o.watch_id
             WHERE o.listing_id = l.id AND w.status = 'active' AND o.missed_collects < $3::int)`,
      [watch.id, sourceCode, GONE_AFTER_MISSED_COLLECTS, now],
    );
    outcome.goneByAbsence = gone.rowCount ?? 0;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return outcome;
}

async function updateKnown(
  client: PoolClient,
  sourceCode: string,
  existing: ExistingRow,
  listing: SanitizedListing,
  hash: string,
  now: Date,
): Promise<Written> {
  const status = statusAfterSighting(listing);
  const confirmed = listing.availability !== "unknown";
  // « gone » puis revue SANS disponibilité : l'origine et la date de la confirmation décrivaient la disparition, plus rien ne les justifie.
  const reset = existing.availability_status === "gone" && status === "unknown";
  await client.query(
    `UPDATE external_listings
        SET title = $2, price_amount = $3, price_currency = $4, location_text = $5, listed_at = $6, content_hash = $7,
            availability_status = $8,
            availability_confirmed_at = CASE WHEN $9::boolean THEN $10::timestamptz WHEN $11::boolean THEN NULL ELSE availability_confirmed_at END,
            availability_origin = CASE WHEN $9::boolean THEN 'source' WHEN $11::boolean THEN NULL ELSE availability_origin END,
            first_seen_at = LEAST(first_seen_at, $10::timestamptz), last_seen_at = GREATEST(last_seen_at, $10::timestamptz), last_checked_at = GREATEST(last_checked_at, $10::timestamptz)
      WHERE id = $1::uuid`,
    [existing.id, listing.title, listing.priceAmount, listing.priceCurrency, listing.location, listing.listedAt, hash, status, confirmed, now, reset],
  );
  // L'adresse suit la source (la page a pu changer) tant qu'aucune AUTRE annonce de cette source ne la porte. Deux transactions qui prennent la même adresse en même temps : la base
  // en refuse une (23505), l'adresse précédente est conservée.
  await client.query("SAVEPOINT listing_url");
  try {
    await client.query(
      `UPDATE external_listings SET canonical_url = $2
        WHERE id = $1::uuid AND canonical_url <> $2
          AND NOT EXISTS (SELECT 1 FROM external_listings x WHERE x.source_code = $3 AND x.canonical_url = $2 AND x.id <> $1::uuid)`,
      [existing.id, listing.url, sourceCode],
    );
    await client.query("RELEASE SAVEPOINT listing_url");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "23505") throw error;
    await client.query("ROLLBACK TO SAVEPOINT listing_url");
    await client.query("RELEASE SAVEPOINT listing_url");
  }
  return {
    id: existing.id,
    change: existing.content_hash === hash ? "unchanged" : "changed",
    revived: existing.availability_status === "gone" && status === "available",
  };
}
