import "server-only";

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { recordOutboxEvent } from "./outbox";
import { MatchingProjectionIntegrityError, insertJob } from "./projection";
import {
  INITIAL_SCAN_POSITION,
  buildEvaluationChildJob,
  listEligibleResources,
  nextScanPosition,
  type ScanKind,
} from "./resource-scan";
import { MATCHING_REQUIRED_MIGRATION, isMatchingSchemaReady } from "./schema-ready";
import { readSealedConfig } from "./worker";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
/** Clé fixe du verrou consultatif de session (une seule exécution du bootstrap à la fois par base). */
const BOOTSTRAP_ADVISORY_LOCK_KEY = "7204003001";

export class MatchingBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingBootstrapError";
  }
}

/** Hooks réservés aux tests (concurrence, crash). */
export interface CatalogBootstrapHooks {
  /** Verrou obtenu, avant toute écriture. */
  afterLock?: () => void | Promise<void>;
  beforeBatch?: (batchIndex: number) => void | Promise<void>;
  /** Après le COMMIT du lot `batchIndex` (0, 1, …) ; lever simule un crash. */
  afterBatch?: (batchIndex: number) => void | Promise<void>;
}

export interface RunCatalogBootstrapOptions {
  pool: Pool;
  batchSize?: number;
  dryRun?: boolean;
  hooks?: CatalogBootstrapHooks;
}

export interface CatalogBootstrapResult {
  /** Événement `catalog.bootstrap_sync` porteur de la configuration scellée ; null en simulation. */
  eventId: string | null;
  offersScanned: number;
  demandsScanned: number;
  /** Jobs créés ; en simulation : jobs qui SERAIENT créés (rien n'est écrit). */
  jobsInserted: number;
  alreadyCovered: number;
  dryRun: boolean;
}

/** Santé de la connexion dédiée : un ROLLBACK impossible la condamne (elle est alors détruite à la libération). */
interface ConnectionHealth {
  rollbackFailed: boolean;
}

/** ROLLBACK explicite au mieux : s'il échoue, la connexion ne doit jamais retourner au pool (`release(error)`). */
async function rollbackOrCondemn(client: PoolClient, health: ConnectionHealth): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    health.rollbackFailed = true;
  }
}

function requireOptions(options: RunCatalogBootstrapOptions): { pool: Pool; batchSize: number; dryRun: boolean } {
  const { pool } = options;
  if (!(pool instanceof Pool)) throw new MatchingBootstrapError("Un pool PostgreSQL (Pool) est requis pour le bootstrap.");
  const batchSize = options.batchSize === undefined ? DEFAULT_BATCH_SIZE : options.batchSize;
  if (typeof batchSize !== "number" || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new MatchingBootstrapError(`batchSize doit être un entier entre 1 et ${MAX_BATCH_SIZE}.`);
  }
  const dryRun = options.dryRun === undefined ? false : options.dryRun;
  if (typeof dryRun !== "boolean") throw new MatchingBootstrapError("dryRun doit être un booléen.");
  return { pool, batchSize, dryRun };
}

/** N'applique JAMAIS de migration : refuse si 0010 n'est pas enregistrée dans noma_schema_migrations. */
async function assertSchemaReady(client: PoolClient): Promise<void> {
  if (!(await isMatchingSchemaReady(client))) {
    throw new MatchingBootstrapError(
      `Schéma non prêt : la migration ${MATCHING_REQUIRED_MIGRATION} n'est pas enregistrée (appliquez les migrations 0001 à 0010 avant le bootstrap).`);
  }
}

/**
 * Réutilise le plus ancien événement de bootstrap encore pending (reprise après crash) ou le crée, puis contrôle la
 * configuration scellée qu'il porte. Retourne l'identifiant et le hash scellé.
 */
async function ensureBootstrapEvent(
  client: PoolClient,
  health: ConnectionHealth,
): Promise<{ eventId: string; scoringConfigHash: string }> {
  let eventId: string;
  let hash: unknown;
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    const pending = await client.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM matching_outbox_events
        WHERE event_type = 'catalog.bootstrap_sync' AND dispatch_status = 'pending'
        ORDER BY occurred_at, id LIMIT 1`);
    if (pending.rowCount === 1) {
      eventId = pending.rows[0].id;
      hash = pending.rows[0].payload.scoring_config_hash;
    } else {
      // Agrégat 'system' non versionné : la génération est obligatoire dans le payload.
      const created = await recordOutboxEvent(client, {
        eventType: "catalog.bootstrap_sync", aggregateType: "system", aggregateId: randomUUID(), payload: { generation: 1 },
      });
      eventId = created.id;
      hash = created.payload.scoring_config_hash;
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollbackOrCondemn(client, health);
    throw error;
  }
  // Transaction terminée : le contrôle de la configuration scellée n'a plus rien à annuler.
  if (typeof hash !== "string") throw new MatchingBootstrapError("Événement de bootstrap sans configuration scellée.");
  const sealed = await readSealedConfig(client, { sourceEventId: eventId, scoringConfigHash: hash });
  if (!sealed.ok) throw new MatchingBootstrapError(`Configuration scellée de l'événement de bootstrap invalide (${sealed.errorCode}).`);
  return { eventId, scoringConfigHash: hash };
}

/**
 * Ressources déjà couvertes : (a) un job evaluate_* du bon type à la content_version courante, hors dead_letter ;
 * (b) un événement outbox pending de l'agrégat à cette version. Renvoie les ids couverts.
 */
async function findCovered(
  client: PoolClient,
  kind: ScanKind,
  rows: ReadonlyArray<{ id: string; content_version: number }>,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const jobType = kind === "offer" ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
  const result = await client.query<{ id: string }>(
    `SELECT r.id
       FROM unnest($1::uuid[], $2::int[]) AS r(id, content_version)
      WHERE EXISTS (
              SELECT 1 FROM matching_jobs j
               WHERE j.job_type = $3 AND j.resource_id = r.id
                 AND j.resource_version = r.content_version AND j.status <> 'dead_letter')
         OR EXISTS (
              SELECT 1 FROM matching_outbox_events e
               WHERE e.aggregate_type = $4 AND e.aggregate_id = r.id
                 AND e.aggregate_version = r.content_version AND e.dispatch_status = 'pending')`,
    [rows.map((row) => row.id), rows.map((row) => row.content_version), jobType, kind],
  );
  return new Set(result.rows.map((row) => row.id));
}

/**
 * Bootstrap du catalogue antérieur à l'outbox : crée un job d'évaluation par ressource éligible non encore couverte.
 * Exécution manuelle, jamais lancée par Next.js ni par le runner. Exclusion mutuelle par verrou consultatif de
 * session sur la connexion dédiée, qui sert aussi aux lots (un lot = une transaction). Aucune progression
 * persistée : une reprise refait le parcours, la règle « déjà couvert » et les identités empêchent tout doublon.
 */
export async function runCatalogBootstrap(options: RunCatalogBootstrapOptions): Promise<CatalogBootstrapResult> {
  const { pool, batchSize, dryRun } = requireOptions(options);
  const hooks = options.hooks;
  const result: CatalogBootstrapResult = {
    eventId: null, offersScanned: 0, demandsScanned: 0, jobsInserted: 0, alreadyCovered: 0, dryRun,
  };

  const client = await pool.connect();
  const health: ConnectionHealth = { rollbackFailed: false };
  let lockHeld = false;
  let unlockFailed = false;
  try {
    const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [BOOTSTRAP_ADVISORY_LOCK_KEY]);
    if (locked.rows[0].locked !== true) throw new MatchingBootstrapError("Bootstrap déjà en cours : aucune écriture.");
    lockHeld = true;
    await assertSchemaReady(client);
    await hooks?.afterLock?.();

    const event = dryRun ? null : await ensureBootstrapEvent(client, health);
    result.eventId = event?.eventId ?? null;

    let position = INITIAL_SCAN_POSITION;
    for (let batchIndex = 0, next: typeof position | null = position; next; batchIndex++) {
      position = next;
      await hooks?.beforeBatch?.(batchIndex);
      await client.query(dryRun ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY" : "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const rows = await listEligibleResources(client, { kind: "active_owners" }, position, batchSize);
        const covered = await findCovered(client, position.kind, rows);
        let inserted = 0;
        let alreadyCovered = 0;
        for (const row of rows) {
          if (covered.has(row.id)) { alreadyCovered++; continue; }
          if (dryRun) { inserted++; continue; }
          const job = buildEvaluationChildJob({
            kind: position.kind, row, generation: row.content_version,
            scoringConfigHash: event!.scoringConfigHash, sourceEventId: event!.eventId,
          });
          if (await insertJob(client, job)) inserted++;
          else alreadyCovered++;
        }
        await client.query("COMMIT");
        if (position.kind === "offer") result.offersScanned += rows.length;
        else result.demandsScanned += rows.length;
        result.jobsInserted += inserted;
        result.alreadyCovered += alreadyCovered;
        next = nextScanPosition(position, rows, batchSize);
      } catch (error) {
        await rollbackOrCondemn(client, health);
        throw error;
      }
      await hooks?.afterBatch?.(batchIndex);
    }

    if (event) {
      const done = await client.query(
        `UPDATE matching_outbox_events
            SET dispatch_status = 'projected', dispatched_at = clock_timestamp()
          WHERE id = $1 AND dispatch_status = 'pending'`,
        [event.eventId]);
      if (done.rowCount !== 1) throw new MatchingProjectionIntegrityError("Acquittement de l'événement de bootstrap impossible.");
    }
    return result;
  } finally {
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [BOOTSTRAP_ADVISORY_LOCK_KEY]);
      } catch {
        // Impossible de libérer proprement : fermer la connexion libère le verrou de session.
        unlockFailed = true;
      }
    }
    // Connexion condamnée (ROLLBACK ou déverrouillage impossible) : détruite, jamais rendue au pool.
    client.release(health.rollbackFailed || unlockFailed ? new Error("connection discarded") : undefined);
  }
}
