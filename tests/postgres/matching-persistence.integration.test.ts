import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  activateDemand,
  archiveDemand,
  archiveOffer,
  archiveUser,
  createDemand,
  createOffer,
  createUser,
  pauseOffer,
  publishOffer,
  satisfyDemand,
  updateDemand,
  updateOffer,
  updateUser,
} from "../../lib/server/catalog";
import {
  createCatalogExtractionProposal,
  applyCatalogExtractionProposal,
} from "../../lib/server/catalog-extraction";
import {
  evaluateOfflineMatching,
  computeMatchingScore,
  persistEvaluatedMatch,
  getActiveMatchingEvaluation,
  computeEvaluationExpiration,
  computeScoringConfigHash,
  normalizeScoringConfig,
  MatchingIdempotencyConflictError,
  MatchingInputConsistencyError,
  EvaluationExpiredDuringLockWaitError,
  StaleAttemptSupersededError,
  StalePreconditionsError,
} from "../../lib/server/matching";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
} from "./test-database";

const configuredUrl = process.env.TEST_DATABASE_URL;
let configuredUrlError: unknown;
if (configuredUrl?.trim()) {
  try {
    requireDedicatedTestDatabase(configuredUrl);
  } catch (error) {
    configuredUrlError = error;
  }
}

if (!configuredUrl?.trim()) {
  test("pré-requis PostgreSQL dédié pour persistance matching Lot 2D", () => {
    assert.fail(
      "TEST_DATABASE_URL requis : aucun test persistance matching n'a été simulé.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour persistance matching Lot 2D", () => {
    throw configuredUrlError;
  });
} else {
  describe("persistance transactionnelle et invalidation synchrone du matching", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    test("1. persistance nominale et lecture active sous prédicat strict", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await createOffer(
        {
          ownerId: userOffer.id,
          rawText: "MacBook Pro M2 16Go 512Go parfait état",
          category: "Informatique",
          brand: "Apple",
          model: "MacBook Pro",
          price: { amount: 1200, currency: "EUR" },
        },
        pool,
      );
      const publishedOffer = await publishOffer(userOffer.id, offer.id, offer.contentVersion, pool);

      const demand = await createDemand(
        {
          ownerId: userDemand.id,
          rawText: "Cherche MacBook Pro Apple budget 1300 EUR",
          category: "Informatique",
          brand: "Apple",
          model: "MacBook Pro",
          budget: { amount: 1300, currency: "EUR" },
        },
        pool,
      );
      const activeDemand = await activateDemand(userDemand.id, demand.id, demand.contentVersion, pool);

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evaluation = evaluateOfflineMatching(publishedOffer, activeDemand, { now });
      const scoring = computeMatchingScore(evaluation, { now });

      const idempotencyKey = randomUUID();
      const persisted = await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring,
        pool,
      });

      assert.equal(persisted.offerId, publishedOffer.id);
      assert.equal(persisted.demandId, activeDemand.id);
      assert.equal(persisted.idempotencyKey, idempotencyKey);
      assert.equal(persisted.isLatest, true);
      assert.equal(persisted.isStale, false);
      assert.equal(persisted.staleReason, null);
      assert.equal(persisted.staledAt, null);
      assert.equal(persisted.eligibilityStatus, "eligible");
      assert.equal(persisted.compatibilityStatus, "compatible");
      assert.ok(typeof persisted.score === "number" && persisted.score > 0);
      assert.ok(typeof persisted.coverage === "number" && persisted.coverage > 0);

      // Lecture active via getActiveMatchingEvaluation
      const activeEval = await getActiveMatchingEvaluation({
        offerId: publishedOffer.id,
        demandId: activeDemand.id,
        pool,
      });

      assert.ok(activeEval !== null);
      assert.equal(activeEval.id, persisted.id);
      assert.equal(activeEval.isLatest, true);
      assert.equal(activeEval.isStale, false);
      assert.equal(activeEval.score, persisted.score);
    });

    test("2. rejeu idempotent avec même clé et même attempt_hash (sans duplication)", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await createOffer({ ownerId: userOffer.id, rawText: "Vends vélo VTT" }, pool);
      const publishedOffer = await publishOffer(userOffer.id, offer.id, offer.contentVersion, pool);

      const demand = await createDemand({ ownerId: userDemand.id, rawText: "Cherche vélo VTT" }, pool);
      const activeDemand = await activateDemand(userDemand.id, demand.id, demand.contentVersion, pool);

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evaluation = evaluateOfflineMatching(publishedOffer, activeDemand, { now });
      const scoring = computeMatchingScore(evaluation, { now });

      const idempotencyKey = randomUUID();
      const first = await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring,
        pool,
      });

      // Deuxième appel avec la même clé et entrées identiques
      const second = await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring,
        pool,
      });

      assert.equal(second.id, first.id);
      assert.equal(second.evaluatedAt.toISOString(), first.evaluatedAt.toISOString());

      // Vérifier qu'une seule ligne existe en base
      const countRes = await pool.query(
        "SELECT count(*) FROM matching_evaluations WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      assert.equal(countRes.rows[0].count, "1");
    });

    test("3. rejeu idempotent sur évaluation déjà invalidée (ne réactive JAMAIS)", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await createOffer({ ownerId: userOffer.id, rawText: "Guitare acoustique" }, pool);
      const publishedOffer = await publishOffer(userOffer.id, offer.id, offer.contentVersion, pool);

      const demand = await createDemand({ ownerId: userDemand.id, rawText: "Cherche guitare acoustique" }, pool);
      const activeDemand = await activateDemand(userDemand.id, demand.id, demand.contentVersion, pool);

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evaluation = evaluateOfflineMatching(publishedOffer, activeDemand, { now });
      const scoring = computeMatchingScore(evaluation, { now });

      const idempotencyKey = randomUUID();
      const first = await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring,
        pool,
      });
      assert.equal(first.isStale, false);

      // Invalidation synchrone via modification de l'offre
      await updateOffer(
        {
          id: publishedOffer.id,
          ownerId: userOffer.id,
          expectedContentVersion: publishedOffer.contentVersion,
          changes: {
            rawText: "Guitare acoustique avec housse de transport",
          },
        },
        pool,
      );

      // Rejeu avec la même clé d'idempotence et les mêmes entrées initiales
      const replay = await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring,
        pool,
      });

      // Le rejeu retourne la ligne existante, et is_stale reste TRUE !
      assert.equal(replay.id, first.id);
      assert.equal(replay.isStale, true);
      assert.equal(replay.staleReason, "offer_updated");

      // Vérification directe en base
      const checkRes = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [first.id],
      );
      assert.equal(checkRes.rows[0].is_stale, true);
      assert.equal(checkRes.rows[0].stale_reason, "offer_updated");
    });

    test("4. conflit d'idempotence (409) : même clé mais entrées différentes", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await createOffer({ ownerId: userOffer.id, rawText: "Table en chêne" }, pool);
      const publishedOffer = await publishOffer(userOffer.id, offer.id, offer.contentVersion, pool);

      const demand = await createDemand({ ownerId: userDemand.id, rawText: "Cherche table" }, pool);
      const activeDemand = await activateDemand(userDemand.id, demand.id, demand.contentVersion, pool);

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evaluation = evaluateOfflineMatching(publishedOffer, activeDemand, { now });
      const scoring1 = computeMatchingScore(evaluation, { now, defaultWeight: 1 });
      const scoring2 = computeMatchingScore(evaluation, { now, defaultWeight: 5 });

      const idempotencyKey = randomUUID();
      await persistEvaluatedMatch({
        idempotencyKey,
        offer: publishedOffer,
        demand: activeDemand,
        evaluation,
        scoring: scoring1,
        scoringOptions: { defaultWeight: 1 },
        pool,
      });

      // Tentative avec la même clé mais scoringOptions / scoring différents
      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey,
            offer: publishedOffer,
            demand: activeDemand,
            evaluation,
            scoring: scoring2,
            scoringOptions: { defaultWeight: 5 },
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingIdempotencyConflictError);
          assert.equal(err.code, "MATCHING_IDEMPOTENCY_CONFLICT");
          assert.equal(err.status, 409);
          return true;
        },
      );
    });

    test("5. conflit d'idempotence global : même clé réutilisée sur une autre paire", async () => {
      const userA = await createUser({ status: "active" }, pool);
      const userB = await createUser({ status: "active" }, pool);

      const offer1 = await publishOffer(
        userA.id,
        (await createOffer({ ownerId: userA.id, rawText: "Objet 1" }, pool)).id,
        1,
        pool,
      );
      const demand1 = await activateDemand(
        userB.id,
        (await createDemand({ ownerId: userB.id, rawText: "Besoin 1" }, pool)).id,
        1,
        pool,
      );

      const offer2 = await publishOffer(
        userA.id,
        (await createOffer({ ownerId: userA.id, rawText: "Objet 2" }, pool)).id,
        1,
        pool,
      );
      const demand2 = await activateDemand(
        userB.id,
        (await createDemand({ ownerId: userB.id, rawText: "Besoin 2" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const eval1 = evaluateOfflineMatching(offer1, demand1, { now });
      const scoring1 = computeMatchingScore(eval1, { now });

      const eval2 = evaluateOfflineMatching(offer2, demand2, { now });
      const scoring2 = computeMatchingScore(eval2, { now });

      const idempotencyKey = randomUUID();
      await persistEvaluatedMatch({
        idempotencyKey,
        offer: offer1,
        demand: demand1,
        evaluation: eval1,
        scoring: scoring1,
        pool,
      });

      // Même clé sur la paire (offer2, demand2)
      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey,
            offer: offer2,
            demand: demand2,
            evaluation: eval2,
            scoring: scoring2,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingIdempotencyConflictError);
          assert.equal(err.code, "MATCHING_IDEMPOTENCY_CONFLICT");
          assert.equal(err.status, 409);
          return true;
        },
      );
    });

    test("6. sérialisation par verrou applicatif de persistances concurrentes sur la même paire", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Écran 4K 27 pouces" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche écran 4K" }, pool)).id,
        1,
        pool,
      );

      const now1 = new Date("2026-10-04T12:00:00.000Z");
      const now2 = new Date("2026-10-04T12:00:01.000Z");

      const eval1 = evaluateOfflineMatching(offer, demand, { now: now1 });
      const scoring1 = computeMatchingScore(eval1, { now: now1 });

      const eval2 = evaluateOfflineMatching(offer, demand, { now: now2 });
      const scoring2 = computeMatchingScore(eval2, { now: now2 });

      // Lancement simultané de deux persistances sur la même paire avec deux clés différentes
      const [res1, res2] = await Promise.all([
        persistEvaluatedMatch({
          idempotencyKey: randomUUID(),
          offer,
          demand,
          evaluation: eval1,
          scoring: scoring1,
          pool,
        }),
        persistEvaluatedMatch({
          idempotencyKey: randomUUID(),
          offer,
          demand,
          evaluation: eval2,
          scoring: scoring2,
          pool,
        }),
      ]);

      // Les deux ont abouti sans blocage ni deadlock
      assert.ok(res1.id);
      assert.ok(res2.id);

      // Exactement UNE des deux est `is_latest = true`
      const latestRows = await pool.query(
        "SELECT id, is_latest, is_stale, stale_reason FROM matching_evaluations WHERE offer_id = $1 AND demand_id = $2 AND is_latest = TRUE",
        [offer.id, demand.id],
      );
      assert.equal(latestRows.rowCount, 1);
    });

    test("7. barrière d'historique : rejet d'une tentative antérieure arrivant tardivement (StaleAttemptSupersededError)", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Appareil photo reflex" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche reflex" }, pool)).id,
        1,
        pool,
      );

      const tNewer = new Date("2026-10-04T15:00:00.000Z");
      const evalNewer = evaluateOfflineMatching(offer, demand, { now: tNewer });
      const scoringNewer = computeMatchingScore(evalNewer, { now: tNewer });

      // Persister l'évaluation récente d'abord
      await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalNewer,
        scoring: scoringNewer,
        pool,
      });

      // Tentative plus ancienne (T_older < T_newer) arrivant en retard
      const tOlder = new Date("2026-10-04T14:00:00.000Z");
      const evalOlder = evaluateOfflineMatching(offer, demand, { now: tOlder });
      const scoringOlder = computeMatchingScore(evalOlder, { now: tOlder });

      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation: evalOlder,
            scoring: scoringOlder,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleAttemptSupersededError);
          assert.equal(err.name, "StaleAttemptSupersededError");
          return true;
        },
      );
    });

    test("8. relecture des préconditions : rejet si version ou ressource obsolète (StalePreconditionsError)", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Drone DJI Mini" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche drone DJI" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      // Modifier l'offre en base (incrémente content_version de 1 à 2)
      await updateOffer(
        {
          id: offer.id,
          ownerId: userOffer.id,
          expectedContentVersion: offer.contentVersion,
          changes: {
            rawText: "Drone DJI Mini avec 3 batteries",
          },
        },
        pool,
      );

      // Essayer de persister avec l'objet offer initial (version 1)
      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer, // version 1 alors que la DB est à 2
            demand,
            evaluation: evalMatch,
            scoring,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StalePreconditionsError);
          return true;
        },
      );
    });

    test("9. invalidation synchrone par mutations : offre modifiée, pausée, archivée", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Clavier mécanique" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche clavier mécanique" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      const p1 = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalMatch,
        scoring,
        pool,
      });
      assert.equal(p1.isStale, false);

      // Invalidation 1: updateOffer -> offer_updated
      const updatedOffer = await updateOffer(
        {
          id: offer.id,
          ownerId: userOffer.id,
          expectedContentVersion: offer.contentVersion,
          changes: {
            rawText: "Clavier mécanique switches red",
          },
        },
        pool,
      );
      const afterUpdate = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p1.id],
      );
      assert.equal(afterUpdate.rows[0].is_stale, true);
      assert.equal(afterUpdate.rows[0].stale_reason, "offer_updated");

      // Nouvelle évaluation avec l'offre mise à jour
      const eval2 = evaluateOfflineMatching(updatedOffer, demand, { now });
      const scoring2 = computeMatchingScore(eval2, { now });
      const p2 = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer: updatedOffer,
        demand,
        evaluation: eval2,
        scoring: scoring2,
        pool,
      });
      assert.equal(p2.isStale, false);

      // Invalidation 2: pauseOffer -> offer_updated (conformément au plan de persistance pour transitionOfferStatus)
      const pausedOffer = await pauseOffer(userOffer.id, updatedOffer.id, updatedOffer.contentVersion, pool);
      const afterPause = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p2.id],
      );
      assert.equal(afterPause.rows[0].is_stale, true);
      assert.equal(afterPause.rows[0].stale_reason, "offer_updated");

      // Invalidation 3: archiveOffer -> offer_archived
      await archiveOffer(userOffer.id, pausedOffer.id, pausedOffer.contentVersion, pool);
      const afterArchive = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p2.id],
      );
      assert.equal(afterArchive.rows[0].is_stale, true);
    });

    test("10. invalidation synchrone par mutations : demande modifiée, satisfaite, archivée", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Casque Bose QC45" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche casque Bose" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      const p1 = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalMatch,
        scoring,
        pool,
      });

      // Invalidation 1: updateDemand -> demand_updated
      const updatedDemand = await updateDemand(
        {
          id: demand.id,
          ownerId: userDemand.id,
          expectedContentVersion: demand.contentVersion,
          changes: {
            rawText: "Cherche casque Bose QC45 ou 700",
          },
        },
        pool,
      );
      const checkUpdate = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p1.id],
      );
      assert.equal(checkUpdate.rows[0].is_stale, true);
      assert.equal(checkUpdate.rows[0].stale_reason, "demand_updated");

      // Nouvelle évaluation
      const eval2 = evaluateOfflineMatching(offer, updatedDemand, { now });
      const scoring2 = computeMatchingScore(eval2, { now });
      const p2 = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand: updatedDemand,
        evaluation: eval2,
        scoring: scoring2,
        pool,
      });

      // Invalidation 2: satisfyDemand -> demand_satisfied
      const satisfiedDemand = await satisfyDemand(userDemand.id, updatedDemand.id, updatedDemand.contentVersion, pool);
      const checkSatisfy = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p2.id],
      );
      assert.equal(checkSatisfy.rows[0].is_stale, true);
      assert.equal(checkSatisfy.rows[0].stale_reason, "demand_satisfied");

      // Invalidation 3: archiveDemand -> demand_archived
      await archiveDemand(userDemand.id, satisfiedDemand.id, satisfiedDemand.contentVersion, pool);
      const checkArchive = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p2.id],
      );
      assert.equal(checkArchive.rows[0].is_stale, true);
    });

    test("11. invalidation synchrone sur suspension et archivage d'utilisateur", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Machine espresso" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche machine espresso" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      const p1 = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalMatch,
        scoring,
        pool,
      });

      // Suspension de l'utilisateur offreur
      await updateUser({ id: userOffer.id, expectedVersion: userOffer.version, status: "suspended" }, pool);
      const checkSuspension = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p1.id],
      );
      assert.equal(checkSuspension.rows[0].is_stale, true);
      assert.equal(checkSuspension.rows[0].stale_reason, "user_suspended");

      // getActiveMatchingEvaluation retourne null
      const activeCheck = await getActiveMatchingEvaluation({
        offerId: offer.id,
        demandId: demand.id,
        pool,
      });
      assert.equal(activeCheck, null);

      // Archivage de l'utilisateur demandeur
      await archiveUser(userDemand.id, userDemand.version, pool);
      const checkArchiveUser = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [p1.id],
      );
      assert.equal(checkArchiveUser.rows[0].is_stale, true);
    });

    test("12. calcul de frontière temporelle B = D + 1 ms et péremption", async () => {
      const tEval = new Date("2026-10-04T12:00:00.000Z");
      const dFuture = new Date("2026-10-04T14:00:00.000Z");
      const dPast = new Date("2026-10-04T10:00:00.000Z");

      // 1. Sans deadline -> expires_at = null
      assert.equal(computeEvaluationExpiration(tEval, null, null), null);

      // 2. Deadline future -> B = D + 1 ms
      const expFuture = computeEvaluationExpiration(tEval, dFuture, null);
      assert.ok(expFuture !== null);
      assert.equal(expFuture.getTime(), dFuture.getTime() + 1);

      // 3. Deadline passée -> expires_at = null
      assert.equal(computeEvaluationExpiration(tEval, dPast, null), null);

      // 4. Égalité exacte T_eval = D : frontière B = D + 1 ms est strictement future (> T_eval)
      const expExact = computeEvaluationExpiration(tEval, tEval, null);
      assert.ok(expExact !== null);
      assert.equal(expExact.getTime(), tEval.getTime() + 1);

      // 5. Deux deadlines futures : la plus proche est retenue
      const dLater = new Date("2026-10-04T16:00:00.000Z");
      const expEarliest = computeEvaluationExpiration(tEval, dLater, dFuture);
      assert.ok(expEarliest !== null);
      assert.equal(expEarliest.getTime(), dFuture.getTime() + 1);
    });

    test("13. rejet si l'évaluation expire pendant l'attente du verrou (EvaluationExpiredDuringLockWaitError)", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      // Deadline dans le passé par rapport à l'heure réelle de persistance en base
      const pastDeadline = new Date("2020-01-01T10:00:00.000Z");
      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Objet temporel", deadlineAt: pastDeadline }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche objet temporel" }, pool)).id,
        1,
        pool,
      );

      // Évaluation forgée prétendant avoir été calculée avant pastDeadline
      const tAncient = new Date("2020-01-01T09:00:00.000Z");
      const evalAncient = evaluateOfflineMatching(offer, demand, { now: tAncient });
      const scoringAncient = computeMatchingScore(evalAncient, { now: tAncient });

      // À l'exécution, clock_timestamp() en base est en 2026, donc clock_timestamp() >= expires_at (2020-01-01T10:00:00.001Z)
      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation: evalAncient,
            scoring: scoringAncient,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof EvaluationExpiredDuringLockWaitError);
          return true;
        },
      );
    });

    test("14. fidélité de précision NUMERIC(9,6) sans arrondi abusif à 100", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer(
          {
            ownerId: userOffer.id,
            rawText: "Ordinateur portable",
            category: "Informatique",
            brand: "Apple",
          },
          pool,
        )).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand(
          {
            ownerId: userDemand.id,
            rawText: "Cherche ordinateur",
            category: "Informatique",
            brand: "Dell",
          },
          pool,
        )).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evaluation = evaluateOfflineMatching(offer, demand, { now });
      // Score réel produit par 2B avec precision 6 : 1 critère sur 3 (weights 1 vs 2) -> 33.333333%
      const scoringOptions = { precision: 6, weights: { category: 1, brand: 2 } };
      const scoring = computeMatchingScore(evaluation, { ...scoringOptions, now });

      const persisted = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation,
        scoring,
        scoringOptions,
        pool,
      });

      assert.equal(persisted.score, 33.333333);
      assert.equal(persisted.coverage, 100);

      // Relecture SQL directe
      const rawRes = await pool.query(
        "SELECT score::text, coverage::text FROM matching_evaluations WHERE id = $1",
        [persisted.id],
      );
      assert.equal(rawRes.rows[0].score, "33.333333");
      assert.equal(rawRes.rows[0].coverage, "100.000000");

      // Test SQL dédié : fidélité de NUMERIC(9,6) jusqu'à 6 décimales sans arrondi abusif à 100
      const fineSql = await pool.query("SELECT 99.999999::numeric(9,6)::text AS val");
      assert.equal(fineSql.rows[0].val, "99.999999");
      assert.notEqual(fineSql.rows[0].val, "100.000000");
    });

    test("15. invalidation synchrone lors de l'application d'une proposition d'extraction", async () => {
      const user = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        user.id,
        (await createOffer({ ownerId: user.id, rawText: "iPhone 13 128 Go bleu" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche iPhone 13" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      const persisted = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalMatch,
        scoring,
        pool,
      });
      assert.equal(persisted.isStale, false);

      // Créer et appliquer une proposition d'extraction
      const proposal = await createCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
        },
        { pool },
      );

      await applyCatalogExtractionProposal(
        {
          proposalId: proposal.id,
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          expectedContentVersion: offer.contentVersion,
          selection: {
            fields: ["category", "brand", "model"],
          },
          idempotencyKey: randomUUID(),
        },
        { pool },
      );

      // L'évaluation doit être passée à is_stale = true, stale_reason = 'offer_updated'
      const checkRes = await pool.query(
        "SELECT is_stale, stale_reason FROM matching_evaluations WHERE id = $1",
        [persisted.id],
      );
      assert.equal(checkRes.rows[0].is_stale, true);
      assert.equal(checkRes.rows[0].stale_reason, "offer_updated");
    });

    test("16. atomicité et rollback commun : un échec de mutation préserve les évaluations actives", async () => {
      const userOffer = await createUser({ status: "active" }, pool);
      const userDemand = await createUser({ status: "active" }, pool);

      const offer = await publishOffer(
        userOffer.id,
        (await createOffer({ ownerId: userOffer.id, rawText: "Tablette tactile" }, pool)).id,
        1,
        pool,
      );
      const demand = await activateDemand(
        userDemand.id,
        (await createDemand({ ownerId: userDemand.id, rawText: "Cherche tablette" }, pool)).id,
        1,
        pool,
      );

      const now = new Date("2026-10-04T12:00:00.000Z");
      const evalMatch = evaluateOfflineMatching(offer, demand, { now });
      const scoring = computeMatchingScore(evalMatch, { now });

      const persisted = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalMatch,
        scoring,
        pool,
      });

      // Tentative de mutation avec version obsolète (doit lever StaleContentVersionError et rollback)
      await assert.rejects(async () => {
        await updateOffer(
          {
            id: offer.id,
            ownerId: userOffer.id,
            expectedContentVersion: 999, // Version erronée -> rollback
            changes: { rawText: "Tablette pro" },
          },
          pool,
        );
      });

      // L'évaluation est toujours active en base
      const checkRes = await pool.query(
        "SELECT is_stale, is_latest FROM matching_evaluations WHERE id = $1",
        [persisted.id],
      );
      assert.equal(checkRes.rows[0].is_stale, false);
      assert.equal(checkRes.rows[0].is_latest, true);
    });

    test("17. substitution d'offre rejetée : le résultat d'une offre A ne peut être lié à une offre incompatible B", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draftA = await createOffer({ ownerId: seller.id, rawText: "iPhone 12", model: "iPhone 12" }, pool);
      const offerA = await publishOffer(seller.id, draftA.id, draftA.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche iPhone 12", model: "iPhone 12" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offerA, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      const draftB = await createOffer({ ownerId: seller.id, rawText: "Samsung S24", model: "Samsung S24" }, pool);
      const offerB = await publishOffer(seller.id, draftB.id, draftB.contentVersion, pool);

      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer: offerA,
            demand,
            offerId: offerB.id,
            evaluation,
            scoring,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingInputConsistencyError);
          return true;
        },
      );
    });

    test("18. propriétés propres __proto__ dans weights produisent des hashes distincts sans pollution", () => {
      const a = normalizeScoringConfig({ weights: JSON.parse('{"__proto__":1}') });
      const b = normalizeScoringConfig({ weights: JSON.parse('{"__proto__":9}') });
      assert.notEqual(computeScoringConfigHash(a), computeScoringConfigHash(b));
      assert.equal(Object.prototype.hasOwnProperty.call(a.weights, "__proto__"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(b.weights, "__proto__"), true);
    });

    test("19. configuration de scoring invalide rejetée avant acquisition de connexion", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Test config invalide" }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche test" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      let connections = 0;
      const countedPool = {
        connect: async () => {
          connections++;
          return pool.connect();
        },
      };

      await assert.rejects(async () => {
        await persistEvaluatedMatch({
          idempotencyKey: randomUUID(),
          offer,
          demand,
          evaluation,
          scoring,
          scoringOptions: { defaultWeight: -1, precision: 999 },
          pool: countedPool as unknown as Pool,
        });
      });
      assert.equal(connections, 0);
    });

    test("20. lecture active requiert la configuration attendue ou le défaut canonique", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Livre rare" }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche livre rare" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoringOptions = { defaultWeight: 8 };
      const scoring = computeMatchingScore(evaluation, scoringOptions);

      await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation,
        scoring,
        scoringOptions,
        pool,
      });

      // Sans expectedScoringConfigHash, recherche par défaut le hash canonique standard -> retourne null
      const defaultRead = await getActiveMatchingEvaluation({ offerId: offer.id, demandId: demand.id, pool });
      assert.equal(defaultRead, null);

      // Avec le hash explicite correspondant à scoringOptions -> retourne le résultat
      const customHash = computeScoringConfigHash(normalizeScoringConfig(scoringOptions));
      const customRead = await getActiveMatchingEvaluation({
        offerId: offer.id,
        demandId: demand.id,
        pool,
        expectedScoringConfigHash: customHash,
      });
      assert.ok(customRead !== null);
      assert.equal(customRead.scoringConfigHash, customHash);
    });

    test("21. lecture active ne ressuscite pas un résultat expiré avec une fausse horloge", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const deadline = new Date(Date.now() + 1500);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Concert ce soir", deadlineAt: deadline }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche billet concert" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);

      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      const p = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation,
        scoring,
        pool,
      });

      // Attendre que la deadline soit passée
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline.getTime() + 10 - Date.now())));

      // Lecture active sous PostgreSQL clock_timestamp() réel
      const readResult = await getActiveMatchingEvaluation({
        offerId: offer.id,
        demandId: demand.id,
        pool,
        expectedScoringConfigHash: p.scoringConfigHash,
      });
      assert.equal(readResult, null);
    });

    test("22. atomicité et rollback d'invalidation forcée en erreur sur pool, query-only et client réservé", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Vélo vintage" }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche vélo" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);

      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      for (const mode of ["pool", "query-only", "reserved-without-BEGIN"] as const) {
        const persisted = await persistEvaluatedMatch({
          idempotencyKey: randomUUID(),
          offer,
          demand,
          evaluation,
          scoring,
          pool,
        });

        await pool.query(
          "CREATE FUNCTION audit_fail_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit invalidation failure'; END $$",
        );
        await pool.query(
          "CREATE TRIGGER audit_fail_invalidation BEFORE UPDATE ON matching_evaluations FOR EACH ROW EXECUTE FUNCTION audit_fail_invalidation()",
        );

        let client: PoolClient | undefined;
        try {
          const db =
            mode === "pool"
              ? pool
              : mode === "query-only"
                ? ({ query: (...args: Parameters<typeof pool.query>) => pool.query(...args) } as unknown as Pool)
                : (client = await pool.connect());

          await assert.rejects(
            updateOffer(
              {
                id: offer.id,
                ownerId: offer.ownerId,
                expectedContentVersion: offer.contentVersion,
                changes: { rawText: "changed" },
              },
              db,
            ),
          );
        } finally {
          if (client) client.release();
          await pool.query("DROP TRIGGER IF EXISTS audit_fail_invalidation ON matching_evaluations");
          await pool.query("DROP FUNCTION IF EXISTS audit_fail_invalidation()");
        }

        const stateRes = await pool.query(
          "SELECT o.content_version, e.is_stale FROM offers o JOIN matching_evaluations e ON e.offer_id=o.id WHERE e.id=$1",
          [persisted.id],
        );
        assert.equal(
          stateRes.rows[0].content_version,
          offer.contentVersion,
          `mutation committed although invalidation failed in mode ${mode}`,
        );
        assert.equal(stateRes.rows[0].is_stale, false);
      }
    });

    test("23. concurrence multi-connexions : mutation ou suspension concurrente holding lock détectée au réveil", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Trottinette électrique" }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche trottinette" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);

      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      // Cas A : mise à jour concurrente de l'offre sur connexion 1 pendant que connexion 2 tente de persister
      const poolOtherA = await openVerifiedIsolatedPool(target, schema);
      try {
        const conn1 = await poolOtherA.connect();
        try {
          await conn1.query("BEGIN");
          // Acquérir verrou exclusif sur l'offre
          await conn1.query("SELECT id FROM offers WHERE id = $1 FOR UPDATE", [offer.id]);

          // Connexion 2 lance persistEvaluatedMatch : doit attendre la libération du verrou
          const persistPromise = persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation,
            scoring,
            pool,
          });

          // Connexion 1 incrémente le content_version et valide la transaction
          await conn1.query("UPDATE offers SET content_version = content_version + 1 WHERE id = $1", [offer.id]);
          await conn1.query("COMMIT");

          // Connexion 2 se réveille, re-lit l'offre et doit rejeter avec StalePreconditionsError
          await assert.rejects(
            persistPromise,
            (err: unknown) => {
              assert.ok(err instanceof StalePreconditionsError);
              return true;
            },
          );
        } finally {
          conn1.release();
        }
      } finally {
        await poolOtherA.end();
      }

      // Cas B : suspension concurrente du propriétaire sur connexion 1
      const poolOtherB = await openVerifiedIsolatedPool(target, schema);
      try {
        const conn2 = await poolOtherB.connect();
        try {
          await conn2.query("BEGIN");
          // Acquérir verrou exclusif sur le compte du vendeur
          await conn2.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [seller.id]);

          // Relire l'offre actuelle pour avoir le bon contentVersion
          const currentOfferRes = await pool.query("SELECT * FROM offers WHERE id = $1", [offer.id]);
          const currentOffer = { ...offer, contentVersion: currentOfferRes.rows[0].content_version };
          const currentEval = evaluateOfflineMatching(currentOffer, demand, { now: new Date() });
          const currentScoring = computeMatchingScore(currentEval);

          const persistPromise = persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer: currentOffer,
            demand,
            evaluation: currentEval,
            scoring: currentScoring,
            pool,
          });

          // Suspendre le vendeur et valider
          await conn2.query("UPDATE users SET status = 'suspended', version = version + 1 WHERE id = $1", [seller.id]);
          await conn2.query("COMMIT");

          // Connexion 2 se réveille et constate que le vendeur est suspendu
          await assert.rejects(
            persistPromise,
            (err: unknown) => {
              assert.ok(err instanceof StalePreconditionsError);
              return true;
            },
          );
        } finally {
          conn2.release();
        }
      } finally {
        await poolOtherB.end();
      }
    });

    test("24. concurrence multi-connexions : attente de verrou expirant la deadline (EvaluationExpiredDuringLockWaitError)", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);

      // Deadline dans 400ms
      const deadline = new Date(Date.now() + 400);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Offre à durée très courte", deadlineAt: deadline }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Demande rapide" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);

      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      const poolLock = await openVerifiedIsolatedPool(target, schema);
      try {
        const connLock = await poolLock.connect();
        try {
          await connLock.query("BEGIN");
          await connLock.query("SELECT id FROM offers WHERE id = $1 FOR UPDATE", [offer.id]);

          // Lancer la persistance qui va bloquer sur le verrou de l'offre
          const persistPromise = persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation,
            scoring,
            pool,
          });

          // Attendre 500ms : la deadline (400ms) est maintenant dépassée
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Relâcher le verrou
          await connLock.query("ROLLBACK");

          // La persistance acquiert le verrou, vérifie l'horloge fraîche PostgreSQL et constate l'expiration
          await assert.rejects(
            persistPromise,
            (err: unknown) => {
              assert.ok(err instanceof EvaluationExpiredDuringLockWaitError);
              return true;
            },
          );
        } finally {
          connLock.release();
        }
      } finally {
        await poolLock.end();
      }
    });

    test("25. barrière d'historique : rejet d'une tentative antérieure même si l'évaluation plus récente a été invalidée", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const draft = await createOffer({ ownerId: seller.id, rawText: "Montre connectée" }, pool);
      const offer = await publishOffer(seller.id, draft.id, draft.contentVersion, pool);
      const dd = await createDemand({ ownerId: buyer.id, rawText: "Cherche montre connectée" }, pool);
      const demand = await activateDemand(buyer.id, dd.id, dd.contentVersion, pool);

      const tNewer = new Date("2026-10-04T16:00:00.000Z");
      const evalNewer = evaluateOfflineMatching(offer, demand, { now: tNewer });
      const scoringNewer = computeMatchingScore(evalNewer, { now: tNewer });

      // 1. Persister l'évaluation récente à tNewer
      const pNewer = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation: evalNewer,
        scoring: scoringNewer,
        pool,
      });
      assert.equal(pNewer.isStale, false);

      // 2. Invalider pNewer via updateOffer
      const updatedOffer = await updateOffer(
        {
          id: offer.id,
          ownerId: seller.id,
          expectedContentVersion: offer.contentVersion,
          changes: { rawText: "Montre connectée GPS" },
        },
        pool,
      );

      const checkStale = await pool.query("SELECT is_stale FROM matching_evaluations WHERE id = $1", [pNewer.id]);
      assert.equal(checkStale.rows[0].is_stale, true);

      // 3. Une tentative plus ancienne (tOlder < tNewer) se présente
      const tOlder = new Date("2026-10-04T15:00:00.000Z");
      const evalOlder = evaluateOfflineMatching(updatedOffer, demand, { now: tOlder });
      const scoringOlder = computeMatchingScore(evalOlder, { now: tOlder });

      // Même si l'évaluation plus récente était déjà invalidée, l'historique empêche de remonter le temps
      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer: updatedOffer,
            demand,
            evaluation: evalOlder,
            scoring: scoringOlder,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleAttemptSupersededError);
          return true;
        },
      );
    });

    test("26. un scoring calculé avec d'autres poids ne peut être persisté sous la configuration par défaut", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const o = await createOffer({ ownerId: seller.id, rawText: "Produit A", model: "M1", brand: "A" }, pool);
      const offer = await publishOffer(seller.id, o.id, o.contentVersion, pool);
      const d = await createDemand({ ownerId: buyer.id, rawText: "Besoin B", model: "M1", brand: "B" }, pool);
      const demand = await activateDemand(buyer.id, d.id, d.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const weighted = computeMatchingScore(evaluation, { weights: { model: 9, brand: 1 } });
      const defaultScoring = computeMatchingScore(evaluation);
      assert.notEqual(weighted.score, defaultScoring.score);

      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation,
            scoring: weighted,
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingInputConsistencyError);
          assert.equal(err.code, "MATCHING_INPUT_CONSISTENCY");
          return true;
        },
      );
    });

    test("27. la modification unilatérale du score numérique est rejetée avant connexion", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const o = await createOffer({ ownerId: seller.id, rawText: "Produit A", model: "M1", brand: "A" }, pool);
      const offer = await publishOffer(seller.id, o.id, o.contentVersion, pool);
      const d = await createDemand({ ownerId: buyer.id, rawText: "Besoin B", model: "M1", brand: "B" }, pool);
      const demand = await activateDemand(buyer.id, d.id, d.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation,
            scoring: { ...scoring, score: 100 },
            pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingInputConsistencyError);
          assert.equal(err.code, "MATCHING_INPUT_CONSISTENCY");
          return true;
        },
      );
    });

    test("28. weights:{} est équivalent au défaut canonique et reste lisible par défaut", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const o = await createOffer({ ownerId: seller.id, rawText: "Produit A", model: "M1" }, pool);
      const offer = await publishOffer(seller.id, o.id, o.contentVersion, pool);
      const d = await createDemand({ ownerId: buyer.id, rawText: "Besoin A", model: "M1" }, pool);
      const demand = await activateDemand(buyer.id, d.id, d.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoringOptions = { weights: {} };
      const scoring = computeMatchingScore(evaluation, scoringOptions);

      const persisted = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation,
        scoring,
        scoringOptions,
        pool,
      });

      const defaultHash = computeScoringConfigHash(normalizeScoringConfig());
      assert.equal(persisted.scoringConfigHash, defaultHash);

      const read = await getActiveMatchingEvaluation({ offerId: offer.id, demandId: demand.id, pool });
      assert.ok(read !== null);
      assert.equal(read.id, persisted.id);
    });

    test("29. résultat non fini (Infinity / NaN) rejeté avant toute acquisition de connexion", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const o = await createOffer({ ownerId: seller.id, rawText: "Produit A" }, pool);
      const offer = await publishOffer(seller.id, o.id, o.contentVersion, pool);
      const d = await createDemand({ ownerId: buyer.id, rawText: "Besoin A" }, pool);
      const demand = await activateDemand(buyer.id, d.id, d.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      let acquisitions = 0;
      const counted = {
        connect: async () => {
          acquisitions++;
          return pool.connect();
        },
      };

      await assert.rejects(
        async () => {
          await persistEvaluatedMatch({
            idempotencyKey: randomUUID(),
            offer,
            demand,
            evaluation,
            scoring: { ...scoring, score: Infinity },
            pool: counted as unknown as Pool,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MatchingInputConsistencyError);
          return true;
        },
      );

      assert.equal(acquisitions, 0);
    });

    test("30. BEGIN externe manuel reste sous contrôle de l'appelant et rollback mutation et invalidation", async () => {
      const seller = await createUser({ status: "active" }, pool);
      const buyer = await createUser({ status: "active" }, pool);
      const o = await createOffer({ ownerId: seller.id, rawText: "Produit Manuel" }, pool);
      const offer = await publishOffer(seller.id, o.id, o.contentVersion, pool);
      const d = await createDemand({ ownerId: buyer.id, rawText: "Besoin Manuel" }, pool);
      const demand = await activateDemand(buyer.id, d.id, d.contentVersion, pool);
      const evaluation = evaluateOfflineMatching(offer, demand, { now: new Date() });
      const scoring = computeMatchingScore(evaluation);

      const p = await persistEvaluatedMatch({
        idempotencyKey: randomUUID(),
        offer,
        demand,
        evaluation,
        scoring,
        pool,
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await updateOffer(
          {
            id: offer.id,
            ownerId: offer.ownerId,
            expectedContentVersion: offer.contentVersion,
            changes: { rawText: "edited manual" },
          },
          client,
        );
        const inTx = (
          await client.query("SELECT is_stale FROM matching_evaluations WHERE id = $1", [p.id])
        ).rows[0];
        assert.equal(inTx.is_stale, true);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const afterRollback = (
        await pool.query(
          "SELECT o.content_version, e.is_stale FROM offers o JOIN matching_evaluations e ON e.offer_id=o.id WHERE e.id=$1",
          [p.id],
        )
      ).rows[0];
      assert.equal(afterRollback.content_version, offer.contentVersion);
      assert.equal(afterRollback.is_stale, false);
    });
  });
}
