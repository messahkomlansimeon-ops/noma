import "server-only";

import { decodeCandidateCursor } from "./candidates";

/** Module pur : aucune requête SQL, aucune mutation des entrées (copies profondes). */

const MAX_INTEGER = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ERROR_CLASS = /^[a-z0-9_.:-]{1,120}$/;

export type ChunkState = "initialized" | "processing" | "validated";
export type CandidateStatus = "pending" | "persisted" | "replayed" | "skipped_stale" | "already_superseded";
export type ResolvedCandidateStatus = Exclude<CandidateStatus, "pending">;

const CHUNK_STATES: readonly ChunkState[] = ["initialized", "processing", "validated"];
const STATE_RANK: Record<ChunkState, number> = { initialized: 0, processing: 1, validated: 2 };
const CANDIDATE_STATUSES: readonly CandidateStatus[] = ["pending", "persisted", "replayed", "skipped_stale", "already_superseded"];

export interface ChunkAttempt {
  attempt_id: string;
  evaluated_at: string;
  scoring_config_hash: string;
  engine_offline_version: string;
  engine_scoring_version: string;
  idempotency_key: string;
  attempt_hash: string;
  status: CandidateStatus;
  error_class: string | null;
}

export interface ChunkCandidate {
  candidate_id: string;
  candidate_version: number;
  pair_resource_id: string;
  pair_resource_version: number;
  status: CandidateStatus;
  current_attempt_id: string;
  attempts: ChunkAttempt[];
}

export interface ChunkManifest {
  chunk_id: string;
  chunk_index: number;
  manifest_version: number;
  state: ChunkState;
  predecessor_chunk_id: string | null;
  predecessor_manifest_version: number | null;
  cursor_in: string | null;
  cursor_out: string | null;
  is_eof: boolean;
  evaluated_at: string;
  scoring_config_hash: string;
  engine_offline_version: string;
  engine_scoring_version: string;
  candidates: ChunkCandidate[];
}

export class ChunkManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkManifestValidationError";
  }
}

const MANIFEST_KEYS = [
  "chunk_id", "chunk_index", "manifest_version", "state", "predecessor_chunk_id",
  "predecessor_manifest_version", "cursor_in", "cursor_out", "is_eof", "evaluated_at",
  "scoring_config_hash", "engine_offline_version", "engine_scoring_version", "candidates",
] as const;
const CANDIDATE_KEYS = [
  "candidate_id", "candidate_version", "pair_resource_id", "pair_resource_version",
  "status", "current_attempt_id", "attempts",
] as const;
const ATTEMPT_KEYS = [
  "attempt_id", "evaluated_at", "scoring_config_hash", "engine_offline_version",
  "engine_scoring_version", "idempotency_key", "attempt_hash", "status", "error_class",
] as const;

function fail(message: string): never {
  throw new ChunkManifestValidationError(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} doit être un objet.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${label} : clé inconnue « ${key} ».`);
  for (const key of keys) if (!Object.hasOwn(record, key)) fail(`${label} : clé obligatoire « ${key} » absente.`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(`${label} doit être un UUID en minuscules.`);
  return value;
}

function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > MAX_INTEGER) {
    fail(`${label} doit être un entier entre ${min} et ${MAX_INTEGER}.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(`${label} doit être un hash SHA-256 hexadécimal minuscule.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} doit être une chaîne non vide.`);
  return value;
}

function isoMillis(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !ISO_UTC_MILLIS.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value
  ) fail(`${label} doit être une date ISO UTC avec millisecondes.`);
  return value;
}

function cursor(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${label} doit être null ou un curseur 2C1.`);
  try {
    if (decodeCandidateCursor(value) === null) fail(`${label} doit être un curseur 2C1 valide.`);
  } catch (error) {
    if (error instanceof ChunkManifestValidationError) throw error;
    fail(`${label} doit être un curseur 2C1 valide.`);
  }
  return value;
}

/**
 * Ordre 2C1 : (created_at, id) décroissant, le curseur suivant étant strictement plus petit.
 * createdAtIso a un format fixe garanti par decodeCandidateCursor (UTC, 6 décimales, Z) : la comparaison
 * lexicographique est donc exacte. L'id est comparé en minuscules (le décodage accepte les deux casses).
 */
function isCursorStrictlyAfter(out: string, from: string): boolean {
  const next = decodeCandidateCursor(out)!;
  const previous = decodeCandidateCursor(from)!;
  if (next.createdAtIso !== previous.createdAtIso) return next.createdAtIso < previous.createdAtIso;
  return next.id.toLowerCase() < previous.id.toLowerCase();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} invalide.`);
  return value as T;
}

function parseAttempt(raw: unknown, label: string): ChunkAttempt {
  const record = asRecord(raw, label);
  requireExactKeys(record, ATTEMPT_KEYS, label);
  const errorClass = record.error_class;
  if (errorClass !== null && (typeof errorClass !== "string" || !ERROR_CLASS.test(errorClass))) {
    fail(`${label}.error_class doit être null ou un code stable.`);
  }
  return {
    attempt_id: uuid(record.attempt_id, `${label}.attempt_id`),
    evaluated_at: isoMillis(record.evaluated_at, `${label}.evaluated_at`),
    scoring_config_hash: hash(record.scoring_config_hash, `${label}.scoring_config_hash`),
    engine_offline_version: nonEmptyString(record.engine_offline_version, `${label}.engine_offline_version`),
    engine_scoring_version: nonEmptyString(record.engine_scoring_version, `${label}.engine_scoring_version`),
    idempotency_key: uuid(record.idempotency_key, `${label}.idempotency_key`),
    attempt_hash: hash(record.attempt_hash, `${label}.attempt_hash`),
    status: oneOf(record.status, CANDIDATE_STATUSES, `${label}.status`),
    error_class: errorClass as string | null,
  };
}

/** Validation stricte et copie profonde. Toute clé inconnue ou manquante est refusée. */
export function parseChunkManifest(value: unknown): ChunkManifest {
  const record = asRecord(value, "Manifeste");
  requireExactKeys(record, MANIFEST_KEYS, "Manifeste");
  const chunkIndex = integer(record.chunk_index, "chunk_index", 0);
  const predecessorChunkId = record.predecessor_chunk_id === null
    ? null : uuid(record.predecessor_chunk_id, "predecessor_chunk_id");
  const predecessorVersion = record.predecessor_manifest_version === null
    ? null : integer(record.predecessor_manifest_version, "predecessor_manifest_version", 1);
  if (chunkIndex === 0) {
    if (predecessorChunkId !== null || predecessorVersion !== null) fail("Le chunk 0 n'a aucun prédécesseur.");
  } else if (predecessorChunkId === null || predecessorVersion === null) {
    fail("Un chunk d'index > 0 exige un prédécesseur (identité et révision).");
  }
  const chunkId = uuid(record.chunk_id, "chunk_id");
  if (predecessorChunkId === chunkId) fail("Un chunk ne peut pas être son propre prédécesseur.");
  const cursorIn = cursor(record.cursor_in, "cursor_in");
  const cursorOut = cursor(record.cursor_out, "cursor_out");
  if (typeof record.is_eof !== "boolean") fail("is_eof doit être un booléen.");
  if (record.is_eof !== (cursorOut === null)) fail("is_eof doit valoir (cursor_out === null).");
  if (cursorIn !== null && cursorOut !== null && !isCursorStrictlyAfter(cursorOut, cursorIn)) {
    fail("cursor_out doit être strictement après cursor_in dans l'ordre 2C1 : le curseur doit avancer.");
  }
  const state = oneOf(record.state, CHUNK_STATES, "state");
  const scoringConfigHash = hash(record.scoring_config_hash, "scoring_config_hash");
  const engineOffline = nonEmptyString(record.engine_offline_version, "engine_offline_version");
  const engineScoring = nonEmptyString(record.engine_scoring_version, "engine_scoring_version");
  if (!Array.isArray(record.candidates)) fail("candidates doit être un tableau.");

  const candidateIds = new Set<string>();
  const attemptIds = new Set<string>();
  const candidates = record.candidates.map((rawCandidate, index): ChunkCandidate => {
    const label = `candidates[${index}]`;
    const candidate = asRecord(rawCandidate, label);
    requireExactKeys(candidate, CANDIDATE_KEYS, label);
    const candidateId = uuid(candidate.candidate_id, `${label}.candidate_id`);
    if (candidateIds.has(candidateId)) fail(`${label} : candidate_id en double.`);
    candidateIds.add(candidateId);
    if (!Array.isArray(candidate.attempts) || candidate.attempts.length === 0) {
      fail(`${label} : au moins une tentative est requise.`);
    }
    const attempts = candidate.attempts.map((rawAttempt, attemptIndex) => {
      const attempt = parseAttempt(rawAttempt, `${label}.attempts[${attemptIndex}]`);
      if (attemptIds.has(attempt.attempt_id)) fail(`${label} : attempt_id en double dans le manifeste.`);
      attemptIds.add(attempt.attempt_id);
      if (
        attempt.scoring_config_hash !== scoringConfigHash ||
        attempt.engine_offline_version !== engineOffline ||
        attempt.engine_scoring_version !== engineScoring
      ) fail(`${label}.attempts[${attemptIndex}] : hash ou versions de moteur divergents du manifeste.`);
      return attempt;
    });
    const last = attempts[attempts.length - 1];
    const currentAttemptId = uuid(candidate.current_attempt_id, `${label}.current_attempt_id`);
    if (currentAttemptId !== last.attempt_id) fail(`${label} : current_attempt_id doit désigner la dernière tentative.`);
    const status = oneOf(candidate.status, CANDIDATE_STATUSES, `${label}.status`);
    if (status !== last.status) fail(`${label} : status différent de celui de la tentative courante.`);
    if (state === "validated" && status === "pending") fail("Un chunk validated ne contient aucun candidat pending.");
    return {
      candidate_id: candidateId,
      candidate_version: integer(candidate.candidate_version, `${label}.candidate_version`, 1),
      pair_resource_id: uuid(candidate.pair_resource_id, `${label}.pair_resource_id`),
      pair_resource_version: integer(candidate.pair_resource_version, `${label}.pair_resource_version`, 1),
      status,
      current_attempt_id: currentAttemptId,
      attempts,
    };
  });

  return {
    chunk_id: chunkId,
    chunk_index: chunkIndex,
    manifest_version: integer(record.manifest_version, "manifest_version", 1),
    state,
    predecessor_chunk_id: predecessorChunkId,
    predecessor_manifest_version: predecessorVersion,
    cursor_in: cursorIn,
    cursor_out: cursorOut,
    is_eof: record.is_eof,
    evaluated_at: isoMillis(record.evaluated_at, "evaluated_at"),
    scoring_config_hash: scoringConfigHash,
    engine_offline_version: engineOffline,
    engine_scoring_version: engineScoring,
    candidates,
  };
}

export interface InitialChunkCandidateInput {
  candidateId: string;
  candidateVersion: number;
  pairResourceId: string;
  pairResourceVersion: number;
  attemptId: string;
  idempotencyKey: string;
  attemptHash: string;
}

export interface InitialChunkManifestInput {
  chunkId: string;
  chunkIndex: number;
  predecessorChunkId?: string | null;
  predecessorManifestVersion?: number | null;
  cursorIn: string | null;
  cursorOut: string | null;
  evaluatedAt: Date | string;
  scoringConfigHash: string;
  engineOfflineVersion: string;
  engineScoringVersion: string;
  candidates: readonly InitialChunkCandidateInput[];
}

/** Manifeste de révision 1, état `initialized`, chaque candidat avec une tentative initiale `pending`. */
export function buildInitialChunkManifest(input: InitialChunkManifestInput): ChunkManifest {
  const evaluatedAt = input.evaluatedAt instanceof Date
    ? (Number.isNaN(input.evaluatedAt.getTime()) ? fail("evaluatedAt invalide.") : input.evaluatedAt.toISOString())
    : input.evaluatedAt;
  return parseChunkManifest({
    chunk_id: input.chunkId,
    chunk_index: input.chunkIndex,
    manifest_version: 1,
    state: "initialized",
    predecessor_chunk_id: input.predecessorChunkId ?? null,
    predecessor_manifest_version: input.predecessorManifestVersion ?? null,
    cursor_in: input.cursorIn,
    cursor_out: input.cursorOut,
    is_eof: input.cursorOut === null,
    evaluated_at: evaluatedAt,
    scoring_config_hash: input.scoringConfigHash,
    engine_offline_version: input.engineOfflineVersion,
    engine_scoring_version: input.engineScoringVersion,
    candidates: input.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      candidate_version: candidate.candidateVersion,
      pair_resource_id: candidate.pairResourceId,
      pair_resource_version: candidate.pairResourceVersion,
      status: "pending",
      current_attempt_id: candidate.attemptId,
      attempts: [{
        attempt_id: candidate.attemptId,
        evaluated_at: evaluatedAt,
        scoring_config_hash: input.scoringConfigHash,
        engine_offline_version: input.engineOfflineVersion,
        engine_scoring_version: input.engineScoringVersion,
        idempotency_key: candidate.idempotencyKey,
        attempt_hash: candidate.attemptHash,
        status: "pending",
        error_class: null,
      }],
    })),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Refuse toute transition qui n'est pas strictement additive : tentative supprimée, réordonnée ou
 * modifiée (seul `pending` → résolu est permis), candidat ajouté ou supprimé, champ structurant
 * modifié, révision qui n'avance pas d'exactement 1, ou état qui recule.
 */
export function assertAppendOnly(previousInput: ChunkManifest, nextInput: ChunkManifest): void {
  const previous = parseChunkManifest(previousInput);
  const next = parseChunkManifest(nextInput);
  for (const key of [
    "chunk_id", "chunk_index", "cursor_in", "cursor_out", "is_eof", "evaluated_at", "scoring_config_hash",
    "engine_offline_version", "engine_scoring_version", "predecessor_chunk_id", "predecessor_manifest_version",
  ] as const) {
    if (!sameJson(previous[key], next[key])) fail(`Champ structurant modifié : ${key}.`);
  }
  if (next.manifest_version !== previous.manifest_version + 1) fail("manifest_version doit avancer d'exactement 1.");
  if (previous.state === "validated") fail("Un chunk validated n'accepte plus aucune mutation.");
  if (STATE_RANK[next.state] < STATE_RANK[previous.state]) fail("L'état du chunk ne peut pas reculer.");
  if (next.candidates.length !== previous.candidates.length) fail("Candidat ajouté ou supprimé.");
  previous.candidates.forEach((oldCandidate, index) => {
    const newCandidate = next.candidates[index];
    if (
      oldCandidate.candidate_id !== newCandidate.candidate_id ||
      oldCandidate.candidate_version !== newCandidate.candidate_version ||
      oldCandidate.pair_resource_id !== newCandidate.pair_resource_id ||
      oldCandidate.pair_resource_version !== newCandidate.pair_resource_version
    ) fail(`Candidat modifié ou réordonné à la position ${index}.`);
    if (newCandidate.attempts.length < oldCandidate.attempts.length) fail("Tentative supprimée.");
    oldCandidate.attempts.forEach((oldAttempt, attemptIndex) => {
      const newAttempt = newCandidate.attempts[attemptIndex];
      const { status: oldStatus, ...oldRest } = oldAttempt;
      const { status: newStatus, ...newRest } = newAttempt;
      if (!sameJson(oldRest, newRest)) fail("Tentative modifiée ou réordonnée.");
      if (oldStatus !== newStatus && oldStatus !== "pending") fail("Une tentative résolue ne change plus de statut.");
    });
    for (const added of newCandidate.attempts.slice(oldCandidate.attempts.length)) {
      if (added.status !== "pending" || added.error_class !== null) fail("Une nouvelle tentative démarre pending.");
    }
  });
}

function findCandidate(manifest: ChunkManifest, candidateId: string): ChunkCandidate {
  const candidate = manifest.candidates.find((entry) => entry.candidate_id === candidateId);
  if (!candidate) fail("Candidat introuvable dans le manifeste.");
  return candidate;
}

/** Ajoute une tentative `pending` en fin de liste ; refuse si le candidat est déjà résolu ou le chunk validé. */
export function appendCandidateAttempt(
  manifestInput: ChunkManifest,
  candidateId: string,
  attempt: ChunkAttempt,
): ChunkManifest {
  const previous = parseChunkManifest(manifestInput);
  if (previous.state === "validated") fail("Un chunk validated n'accepte plus de tentative.");
  const next = structuredClone(previous);
  const candidate = findCandidate(next, candidateId);
  if (candidate.status !== "pending") fail("Le candidat est déjà résolu : aucune nouvelle tentative.");
  const added = parseAttempt(attempt, "attempt");
  if (added.status !== "pending" || added.error_class !== null) fail("Une nouvelle tentative démarre pending.");
  candidate.attempts.push(added);
  candidate.current_attempt_id = added.attempt_id;
  candidate.status = "pending";
  next.state = "processing";
  next.manifest_version = previous.manifest_version + 1;
  const result = parseChunkManifest(next);
  assertAppendOnly(previous, result);
  return result;
}

/** Résout la tentative courante (et le statut du candidat) ; l'ancienne tentative ne se rembobine jamais. */
export function acknowledgeCandidateAttempt(
  manifestInput: ChunkManifest,
  candidateId: string,
  attemptId: string,
  status: ResolvedCandidateStatus,
): ChunkManifest {
  const previous = parseChunkManifest(manifestInput);
  if (previous.state === "validated") fail("Un chunk validated n'accepte plus d'acquittement.");
  if (!CANDIDATE_STATUSES.includes(status) || (status as CandidateStatus) === "pending") fail("Le statut d'acquittement ne peut pas être pending.");
  const next = structuredClone(previous);
  const candidate = findCandidate(next, candidateId);
  if (candidate.current_attempt_id !== attemptId) fail("Seule la tentative courante peut être acquittée.");
  const attempt = candidate.attempts[candidate.attempts.length - 1];
  if (attempt.status !== "pending") fail("La tentative n'est plus pending.");
  attempt.status = status;
  candidate.status = status;
  next.state = "processing";
  next.manifest_version = previous.manifest_version + 1;
  const result = parseChunkManifest(next);
  assertAppendOnly(previous, result);
  return result;
}

/** Passe le chunk en `validated` ; refusé s'il reste un candidat pending. */
export function validateChunkManifest(manifestInput: ChunkManifest): ChunkManifest {
  const previous = parseChunkManifest(manifestInput);
  if (previous.state === "validated") fail("Le chunk est déjà validated.");
  if (previous.candidates.some((candidate) => candidate.status === "pending")) {
    fail("Validation impossible : il reste un candidat pending.");
  }
  const next = structuredClone(previous);
  next.state = "validated";
  next.manifest_version = previous.manifest_version + 1;
  const result = parseChunkManifest(next);
  assertAppendOnly(previous, result);
  return result;
}
