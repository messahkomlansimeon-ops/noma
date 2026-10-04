import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { encodeCandidateCursor } from "../../lib/server/matching/candidates";
import {
  ChunkManifestValidationError, acknowledgeCandidateAttempt, appendCandidateAttempt, assertAppendOnly,
  buildInitialChunkManifest, parseChunkManifest, validateChunkManifest,
  type ChunkAttempt, type ChunkManifest,
} from "../../lib/server/matching/chunk-manifest";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
/** Plus la seconde est grande, plus le curseur est tôt dans l'ordre 2C1 (created_at décroissant). */
const cursorAt = (second: number, id: string = randomUUID()) =>
  encodeCandidateCursor({ createdAtIso: `2026-10-04T12:00:${String(second).padStart(2, "0")}.123456Z`, id });

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function build(overrides: { index?: number; count?: number; cursorOut?: string | null } = {}): ChunkManifest {
  const index = overrides.index ?? 0;
  return buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: index,
    predecessorChunkId: index > 0 ? randomUUID() : null,
    predecessorManifestVersion: index > 0 ? 4 : null,
    cursorIn: index > 0 ? cursorAt(50) : null,
    cursorOut: overrides.cursorOut === undefined ? cursorAt(40) : overrides.cursorOut,
    evaluatedAt: new Date("2026-10-04T12:00:00.000Z"),
    scoringConfigHash: HASH, engineOfflineVersion: "matching-offline/v1", engineScoringVersion: "matching-scoring/v1",
    candidates: Array.from({ length: overrides.count ?? 2 }, (_, i) => ({
      candidateId: randomUUID(), candidateVersion: i + 1, pairResourceId: randomUUID(), pairResourceVersion: 1,
      attemptId: randomUUID(), idempotencyKey: randomUUID(), attemptHash: HASH,
    })),
  });
}

/** Copie profonde modifiable, en `unknown` pour fabriquer des manifestes invalides. */
function raw(manifest: ChunkManifest, change: (value: any) => void): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  const copy = structuredClone(manifest);
  change(copy);
  return copy;
}

function retryAttempt(manifest: ChunkManifest, index = 0): ChunkAttempt {
  return { ...manifest.candidates[index].attempts[0], attempt_id: randomUUID(), idempotency_key: randomUUID(),
    evaluated_at: "2026-10-04T12:00:05.000Z", attempt_hash: OTHER_HASH, status: "pending", error_class: null };
}

const refuses = (call: () => unknown, label?: string) => assert.throws(call, ChunkManifestValidationError, label);

test("parseChunkManifest accepte un manifeste valide et renvoie une copie profonde", () => {
  const manifest = build();
  const parsed = parseChunkManifest(deepFreeze(structuredClone(manifest)));
  assert.deepEqual(parsed, manifest);
  assert.notEqual(parsed.candidates, manifest.candidates);
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.state, "initialized");
  assert.equal(manifest.is_eof, false);
  assert.ok(manifest.candidates.every((candidate) => candidate.status === "pending" && candidate.attempts.length === 1));
  assert.deepEqual(Object.keys(manifest), [
    "chunk_id", "chunk_index", "manifest_version", "state", "predecessor_chunk_id", "predecessor_manifest_version",
    "cursor_in", "cursor_out", "is_eof", "evaluated_at", "scoring_config_hash", "engine_offline_version",
    "engine_scoring_version", "candidates",
  ]);
  assert.equal(parseChunkManifest(build({ count: 0, cursorOut: null })).is_eof, true);
  assert.equal(parseChunkManifest(build({ index: 3 })).predecessor_manifest_version, 4);
});

test("parseChunkManifest refuse chaque règle isolément", () => {
  const manifest = build({ count: 2 });
  const [c0, c1] = manifest.candidates;
  const cases: [string, unknown][] = [
    ["null", null], ["tableau", []], ["chaîne", "x"],
    ["clé inconnue (manifeste)", raw(manifest, (m) => { m.extra = 1; })],
    ["clé inconnue (candidat)", raw(manifest, (m) => { m.candidates[0].extra = 1; })],
    ["clé inconnue (tentative)", raw(manifest, (m) => { m.candidates[0].attempts[0].extra = 1; })],
    ["clé absente (manifeste)", raw(manifest, (m) => { delete m.chunk_id; })],
    ["clé absente (tentative)", raw(manifest, (m) => { delete m.candidates[0].attempts[0].error_class; })],
    ["chunk_id non UUID", raw(manifest, (m) => { m.chunk_id = "nope"; })],
    ["chunk_id en majuscules", raw(manifest, (m) => { m.chunk_id = m.chunk_id.toUpperCase(); })],
    ["candidate_id non UUID", raw(manifest, (m) => { m.candidates[0].candidate_id = "nope"; })],
    ["pair_resource_id non UUID", raw(manifest, (m) => { m.candidates[0].pair_resource_id = 5; })],
    ["attempt_id non UUID", raw(manifest, (m) => { m.candidates[0].attempts[0].attempt_id = "nope"; })],
    ["idempotency_key non UUID", raw(manifest, (m) => { m.candidates[0].attempts[0].idempotency_key = "nope"; })],
    ["chunk_index négatif", raw(manifest, (m) => { m.chunk_index = -1; })],
    ["chunk_index fractionnaire", raw(manifest, (m) => { m.chunk_index = 1.5; })],
    ["chunk_index trop grand", raw(manifest, (m) => { m.chunk_index = 2147483648; })],
    ["manifest_version 0", raw(manifest, (m) => { m.manifest_version = 0; })],
    ["manifest_version chaîne", raw(manifest, (m) => { m.manifest_version = "1"; })],
    ["candidate_version 0", raw(manifest, (m) => { m.candidates[0].candidate_version = 0; })],
    ["pair_resource_version 0", raw(manifest, (m) => { m.candidates[0].pair_resource_version = 0; })],
    ["state inconnu", raw(manifest, (m) => { m.state = "done"; })],
    ["cursor_in invalide", raw(manifest, (m) => { m.cursor_in = "pas un curseur"; })],
    ["cursor_out invalide", raw(manifest, (m) => { m.cursor_out = "EOF"; })],
    ["cursor_out non chaîne", raw(manifest, (m) => { m.cursor_out = 12; })],
    ["is_eof faux avec cursor_out nul", raw(manifest, (m) => { m.cursor_out = null; })],
    ["is_eof vrai avec cursor_out", raw(manifest, (m) => { m.is_eof = true; })],
    ["is_eof non booléen", raw(manifest, (m) => { m.is_eof = "false"; })],
    ["evaluated_at sans millisecondes", raw(manifest, (m) => { m.evaluated_at = "2026-10-04T12:00:00Z"; })],
    ["evaluated_at hors UTC", raw(manifest, (m) => { m.evaluated_at = "2026-10-04T12:00:00.000+02:00"; })],
    ["evaluated_at calendrier invalide", raw(manifest, (m) => { m.evaluated_at = "2026-02-30T00:00:00.000Z"; })],
    ["evaluated_at de tentative invalide", raw(manifest, (m) => { m.candidates[0].attempts[0].evaluated_at = "hier"; })],
    ["hash en majuscules", raw(manifest, (m) => { m.scoring_config_hash = HASH.toUpperCase(); })],
    ["hash trop court", raw(manifest, (m) => { m.scoring_config_hash = "ab"; })],
    ["attempt_hash invalide", raw(manifest, (m) => { m.candidates[0].attempts[0].attempt_hash = "xyz"; })],
    ["moteur offline vide", raw(manifest, (m) => { m.engine_offline_version = ""; })],
    ["moteur scoring non chaîne", raw(manifest, (m) => { m.engine_scoring_version = 1; })],
    ["chunk 0 avec prédécesseur", raw(manifest, (m) => { m.predecessor_chunk_id = randomUUID(); m.predecessor_manifest_version = 1; })],
    ["chunk 0 avec version de prédécesseur seule", raw(manifest, (m) => { m.predecessor_manifest_version = 1; })],
    ["chunk > 0 sans prédécesseur", raw(build({ index: 2 }), (m) => { m.predecessor_chunk_id = null; m.predecessor_manifest_version = null; })],
    ["chunk > 0 sans version de prédécesseur", raw(build({ index: 2 }), (m) => { m.predecessor_manifest_version = null; })],
    ["prédécesseur = lui-même", raw(build({ index: 2 }), (m) => { m.predecessor_chunk_id = m.chunk_id; })],
    ["candidate_id en double", raw(manifest, (m) => { m.candidates[1].candidate_id = m.candidates[0].candidate_id; })],
    ["attempt_id en double entre candidats", raw(manifest, (m) => {
      m.candidates[1].attempts[0].attempt_id = m.candidates[0].attempts[0].attempt_id;
      m.candidates[1].current_attempt_id = m.candidates[0].attempts[0].attempt_id;
    })],
    ["aucune tentative", raw(manifest, (m) => { m.candidates[0].attempts = []; })],
    ["current_attempt_id pas la dernière", raw(appendCandidateAttempt(manifest, c0.candidate_id, retryAttempt(manifest)), (m) => {
      m.candidates[0].current_attempt_id = m.candidates[0].attempts[0].attempt_id;
    })],
    ["current_attempt_id inconnu", raw(manifest, (m) => { m.candidates[0].current_attempt_id = randomUUID(); })],
    ["statut candidat ≠ tentative courante", raw(manifest, (m) => { m.candidates[0].status = "persisted"; })],
    ["statut de tentative inconnu", raw(manifest, (m) => { m.candidates[0].attempts[0].status = "done"; m.candidates[0].status = "done"; })],
    ["validated avec candidat pending", raw(manifest, (m) => { m.state = "validated"; })],
    ["hash de tentative divergent", raw(manifest, (m) => { m.candidates[0].attempts[0].scoring_config_hash = OTHER_HASH; })],
    ["moteur offline de tentative divergent", raw(manifest, (m) => { m.candidates[1].attempts[0].engine_offline_version = "autre"; })],
    ["moteur scoring de tentative divergent", raw(manifest, (m) => { m.candidates[1].attempts[0].engine_scoring_version = "autre"; })],
    ["error_class invalide", raw(manifest, (m) => { m.candidates[0].attempts[0].error_class = "Erreur brute: boom"; })],
    ["candidates non tableau", raw(manifest, (m) => { m.candidates = {}; })],
  ];
  for (const [label, value] of cases) refuses(() => parseChunkManifest(value), label);
  assert.ok(c1.candidate_id);
  // Le manifeste de référence reste valide : chaque refus ci-dessus vient bien de sa seule modification.
  parseChunkManifest(manifest);
});

test("cycle complet : versions, états, tentatives append-only et entrées jamais modifiées", () => {
  const initial = deepFreeze(build({ count: 2 }));
  const [first, secondCandidate] = initial.candidates;
  const retry = retryAttempt(initial, 0);
  const appended = deepFreeze(appendCandidateAttempt(initial, first.candidate_id, retry));
  assert.equal(appended.manifest_version, 2);
  assert.equal(appended.state, "processing");
  assert.deepEqual(appended.candidates[0].attempts[0], initial.candidates[0].attempts[0]);
  assert.deepEqual(appended.candidates[0].attempts[1], retry);
  assert.equal(appended.candidates[0].current_attempt_id, retry.attempt_id);
  assert.equal(appended.candidates[0].status, "pending");

  const acked = deepFreeze(acknowledgeCandidateAttempt(appended, first.candidate_id, retry.attempt_id, "persisted"));
  assert.equal(acked.manifest_version, 3);
  assert.equal(acked.candidates[0].status, "persisted");
  assert.equal(acked.candidates[0].attempts[1].status, "persisted");
  assert.equal(acked.candidates[0].attempts[0].status, "pending", "l'ancienne tentative n'est jamais réécrite");

  const secondAck = deepFreeze(acknowledgeCandidateAttempt(acked, secondCandidate.candidate_id, secondCandidate.attempts[0].attempt_id, "skipped_stale"));
  const validated = validateChunkManifest(secondAck);
  assert.equal(validated.manifest_version, 5);
  assert.equal(validated.state, "validated");
  for (const [previous, next] of [[initial, appended], [appended, acked], [acked, secondAck], [secondAck, validated]] as const) {
    assertAppendOnly(previous, next);
    assert.equal(next.manifest_version, previous.manifest_version + 1);
  }
  assert.equal(initial.manifest_version, 1);
  assert.equal(initial.candidates[0].attempts.length, 1);
  const empty = validateChunkManifest(build({ count: 0, cursorOut: null }));
  assert.equal(empty.state, "validated");
  assert.equal(empty.is_eof, true);
});

test("transitions refusées : append, acquittement et validation", () => {
  const initial = build({ count: 2 });
  const [first, other] = initial.candidates;
  const retry = retryAttempt(initial, 0);
  const appended = appendCandidateAttempt(initial, first.candidate_id, retry);
  const resolvedFirst = acknowledgeCandidateAttempt(initial, first.candidate_id, first.attempts[0].attempt_id, "persisted");
  const validatedChunk = validateChunkManifest(build({ count: 0, cursorOut: null }));

  refuses(() => appendCandidateAttempt(initial, randomUUID(), retry), "candidat inconnu");
  refuses(() => appendCandidateAttempt(initial, first.candidate_id, { ...retry, attempt_id: first.attempts[0].attempt_id }), "attempt_id en double");
  refuses(() => appendCandidateAttempt(initial, first.candidate_id, { ...retry, status: "persisted" }), "tentative non pending");
  refuses(() => appendCandidateAttempt(initial, first.candidate_id, { ...retry, scoring_config_hash: OTHER_HASH }), "hash divergent");
  refuses(() => appendCandidateAttempt(initial, first.candidate_id, { ...retry, error_class: "boom" }), "error_class à l'ouverture");
  refuses(() => appendCandidateAttempt(resolvedFirst, first.candidate_id, retry), "candidat déjà résolu");
  refuses(() => appendCandidateAttempt(validatedChunk, first.candidate_id, retry), "chunk validated");

  refuses(() => acknowledgeCandidateAttempt(appended, first.candidate_id, first.attempts[0].attempt_id, "persisted"), "tentative non courante");
  refuses(() => acknowledgeCandidateAttempt(initial, first.candidate_id, randomUUID(), "persisted"), "tentative inconnue");
  refuses(() => acknowledgeCandidateAttempt(resolvedFirst, first.candidate_id, first.attempts[0].attempt_id, "replayed"), "tentative plus pending");
  refuses(() => acknowledgeCandidateAttempt(initial, first.candidate_id, first.attempts[0].attempt_id, "pending" as never), "statut pending");
  refuses(() => acknowledgeCandidateAttempt(initial, first.candidate_id, first.attempts[0].attempt_id, "autre" as never), "statut inconnu");
  refuses(() => acknowledgeCandidateAttempt(initial, randomUUID(), other.attempts[0].attempt_id, "persisted"), "candidat inconnu");
  refuses(() => acknowledgeCandidateAttempt(validatedChunk, first.candidate_id, first.attempts[0].attempt_id, "persisted"), "chunk validated");

  refuses(() => validateChunkManifest(initial), "tous pending");
  refuses(() => validateChunkManifest(resolvedFirst), "un candidat pending");
  refuses(() => validateChunkManifest(validatedChunk), "déjà validated");
});

test("assertAppendOnly refuse chaque altération", () => {
  const previous = build({ count: 2 });
  const indexed = build({ index: 2, count: 1 });
  const [first, other] = previous.candidates;
  const acked = acknowledgeCandidateAttempt(previous, first.candidate_id, first.attempts[0].attempt_id, "persisted");
  const retried = appendCandidateAttempt(previous, other.candidate_id, retryAttempt(previous, 1));
  const bump = (base: ChunkManifest, change: (value: any) => void) => // eslint-disable-line @typescript-eslint/no-explicit-any
    raw(base, (value) => { value.manifest_version = base.manifest_version + 1; value.state = "processing"; change(value); }) as ChunkManifest;
  const swapHash = (value: any, key: string, replacement: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    value[key] = replacement;
    for (const candidate of value.candidates) for (const attempt of candidate.attempts) attempt[key] = replacement;
  };

  assertAppendOnly(previous, acked);
  assertAppendOnly(previous, retried);
  assertAppendOnly(retried, acknowledgeCandidateAttempt(retried, other.candidate_id, retried.candidates[1].current_attempt_id, "replayed"));

  // [libellé, manifeste précédent, manifeste suivant] : chaque suivant ne diffère que par sa règle.
  const cases: [string, ChunkManifest, ChunkManifest][] = [
    ["tentative supprimée", retried, bump(retried, (m) => { m.candidates[1].attempts = [m.candidates[1].attempts[1]]; })],
    ["tentative réordonnée", retried, bump(retried, (m) => {
      const [a, b] = m.candidates[1].attempts;
      m.candidates[1].attempts = [b, a];
      m.candidates[1].current_attempt_id = a.attempt_id;
    })],
    ["tentative modifiée (clé)", previous, bump(previous, (m) => { m.candidates[0].attempts[0].idempotency_key = randomUUID(); })],
    ["tentative modifiée (hash)", previous, bump(previous, (m) => { m.candidates[0].attempts[0].attempt_hash = OTHER_HASH; })],
    ["tentative modifiée (error_class)", previous, bump(previous, (m) => { m.candidates[0].attempts[0].error_class = "boom"; })],
    ["statut résolu réécrit", acked, bump(acked, (m) => { m.candidates[0].attempts[0].status = "replayed"; m.candidates[0].status = "replayed"; })],
    ["statut résolu remis pending", acked, bump(acked, (m) => { m.candidates[0].attempts[0].status = "pending"; m.candidates[0].status = "pending"; })],
    ["nouvelle tentative non pending", previous, bump(previous, (m) => {
      const attempt = { ...retryAttempt(previous, 0), status: "persisted" };
      m.candidates[0].attempts.push(attempt); m.candidates[0].current_attempt_id = attempt.attempt_id; m.candidates[0].status = "persisted";
    })],
    ["candidat ajouté", previous, bump(previous, (m) => { m.candidates.push(structuredClone(build({ count: 1 }).candidates[0])); })],
    ["candidat supprimé", previous, bump(previous, (m) => { m.candidates.pop(); })],
    ["candidats réordonnés", previous, bump(previous, (m) => { m.candidates.reverse(); })],
    ["candidate_version modifiée", previous, bump(previous, (m) => { m.candidates[0].candidate_version = 9; })],
    ["pair_resource_id modifié", previous, bump(previous, (m) => { m.candidates[0].pair_resource_id = randomUUID(); })],
    ["chunk_id modifié", previous, bump(previous, (m) => { m.chunk_id = randomUUID(); })],
    ["chunk_index modifié", indexed, bump(indexed, (m) => { m.chunk_index = 3; })],
    ["cursor_in modifié", indexed, bump(indexed, (m) => { m.cursor_in = cursorAt(55); })],
    ["cursor_out modifié", previous, bump(previous, (m) => { m.cursor_out = cursorAt(30); })],
    ["is_eof modifié (cursor_out nul)", previous, bump(previous, (m) => { m.cursor_out = null; m.is_eof = true; })],
    ["evaluated_at modifié", previous, bump(previous, (m) => { m.evaluated_at = "2026-10-05T00:00:00.000Z"; })],
    ["hash modifié", previous, bump(previous, (m) => swapHash(m, "scoring_config_hash", OTHER_HASH))],
    ["moteur offline modifié", previous, bump(previous, (m) => swapHash(m, "engine_offline_version", "autre"))],
    ["moteur scoring modifié", previous, bump(previous, (m) => swapHash(m, "engine_scoring_version", "autre"))],
    ["prédécesseur modifié", indexed, bump(indexed, (m) => { m.predecessor_chunk_id = randomUUID(); })],
    ["version du prédécesseur modifiée", indexed, bump(indexed, (m) => { m.predecessor_manifest_version = 99; })],
    ["révision qui n'avance pas", previous, raw(acked, (m) => { m.manifest_version = previous.manifest_version; }) as ChunkManifest],
    ["saut de révision", previous, raw(acked, (m) => { m.manifest_version = previous.manifest_version + 2; }) as ChunkManifest],
    ["état qui recule", acked, raw(acked, (m) => { m.manifest_version = acked.manifest_version + 1; m.state = "initialized"; }) as ChunkManifest],
  ];
  for (const [label, before, after] of cases) {
    parseChunkManifest(before);
    parseChunkManifest(after); // chaque suivant est un manifeste valide : seule la règle append-only le refuse
    refuses(() => assertAppendOnly(before, after), label);
  }

  // Un chunk validé n'accepte plus aucune mutation, même sans autre changement.
  const validated = validateChunkManifest(build({ count: 0, cursorOut: null }));
  refuses(() => assertAppendOnly(validated, raw(validated, (m) => { m.manifest_version = validated.manifest_version + 1; }) as ChunkManifest), "mutation d'un chunk validated");
  // Les entrées invalides sont aussi refusées.
  refuses(() => assertAppendOnly(previous, { ...acked, extra: 1 } as never), "entrée invalide");
});

test("progression du curseur : cursor_out strictement après cursor_in dans l'ordre 2C1 (created_at, id décroissant)", () => {
  const base = build({ index: 1, count: 1 });
  const withCursors = (cursorIn: string | null, cursorOut: string | null) =>
    raw(base, (m) => { m.cursor_in = cursorIn; m.cursor_out = cursorOut; m.is_eof = cursorOut === null; });
  const at = (iso: string, id: string) => encodeCandidateCursor({ createdAtIso: iso, id });
  const ID_LOW = "00000000-0000-4000-8000-000000000001";
  const ID_HIGH = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const T = "2026-10-04T12:00:30.123456Z";
  // Même charge utile, base64 différente (clés dans l'autre ordre, id en majuscules) : égalité détectée sur les payloads.
  const reordered = Buffer.from(JSON.stringify({ id: ID_HIGH.toUpperCase(), createdAtIso: T }), "utf8").toString("base64url");

  const refused: [string, string, string][] = [
    ["cursor_out = cursor_in (même chaîne)", at(T, ID_LOW), at(T, ID_LOW)],
    ["cursor_out = cursor_in (même charge utile, base64 différente)", at(T, ID_HIGH), reordered],
    ["cursor_out plus tôt dans l'ordre 2C1 (created_at plus récent)", at(T, ID_LOW), at("2026-10-04T12:00:31.123456Z", ID_LOW)],
    ["même created_at, id plus grand", at(T, ID_LOW), at(T, ID_HIGH)],
    ["un microseconde de plus", at("2026-10-04T12:00:30.123456Z", ID_LOW), at("2026-10-04T12:00:30.123457Z", ID_LOW)],
    ["id comparé en minuscules (majuscules plus grandes en ASCII)", at(T, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), at(T, "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF")],
  ];
  for (const [label, cursorIn, cursorOut] of refused) refuses(() => parseChunkManifest(withCursors(cursorIn, cursorOut)), label);
  const accepted: [string, string | null, string | null][] = [
    ["created_at plus ancien", at(T, ID_LOW), at("2026-10-04T12:00:29.123456Z", ID_HIGH)],
    ["même created_at, id plus petit", at(T, ID_HIGH), at(T, ID_LOW)],
    ["un microseconde de moins", at("2026-10-04T12:00:30.123457Z", ID_LOW), at("2026-10-04T12:00:30.123456Z", ID_HIGH)],
    ["id majuscules plus petit une fois en minuscules", at(T, ID_HIGH), at(T, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")],
    ["cursor_in absent", null, at(T, ID_LOW)],
    ["dernière page (cursor_out nul)", at(T, ID_LOW), null],
  ];
  for (const [label, cursorIn, cursorOut] of accepted) {
    const parsed = parseChunkManifest(withCursors(cursorIn, cursorOut));
    assert.equal(parsed.is_eof, cursorOut === null, label);
  }
  // Le test pur de R3 : l'initialisation d'un chunk dont le curseur n'avance pas est impossible à construire.
  const same = cursorAt(40);
  refuses(() => buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: 0, cursorIn: same, cursorOut: same, evaluatedAt: new Date(),
    scoringConfigHash: HASH, engineOfflineVersion: "v1", engineScoringVersion: "v1", candidates: [],
  }), "R3 via buildInitialChunkManifest");
});
