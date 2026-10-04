import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  archiveDemand,
  archiveOffer,
  archiveUser,
  createDemand,
  createOffer,
  createUser,
  publishOffer,
  activateDemand,
  updateUser,
} from "../../lib/server/catalog";
import {
  findDemandCandidatesForOffer,
  findOfferCandidatesForDemand,
  encodeCandidateCursor,
  decodeCandidateCursor,
} from "../../lib/server/matching/candidates";
import {
  CatalogNotFoundError,
  CatalogValidationError,
} from "../../lib/server/catalog/errors";
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
  test("pré-requis PostgreSQL dédié pour sélection des candidats Lot 2C1", () => {
    assert.fail(
      "TEST_DATABASE_URL requis : aucun test sélection candidats catalogue n'a été simulé.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour sélection des candidats Lot 2C1", () => {
    throw configuredUrlError;
  });
} else {
  describe("sélection de candidats interne paginée et bornée (Lot 2C1)", () => {
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

    test("direction demande -> offres : exclusion auto-matching, états exclus et disponibilité", async () => {
      // Propriétaire A
      const userA = await createUser({ status: "active" }, pool);
      // Demande active de A
      const demandA = await createDemand(
        {
          ownerId: userA.id,
          rawText: "Cherche iPhone 12",
          category: "Téléphonie",
          model: "iPhone 12",
        },
        pool,
      );
      await activateDemand(userA.id, demandA.id, demandA.contentVersion, pool);

      // Offre de A (même propriétaire -> auto-matching exclu)
      const offerOwn = await createOffer(
        {
          ownerId: userA.id,
          rawText: "Mon iPhone 12",
          model: "iPhone 12",
        },
        pool,
      );
      await publishOffer(userA.id, offerOwn.id, offerOwn.contentVersion, pool);

      // Propriétaire B (actif)
      const userB = await createUser({ status: "active" }, pool);

      // Offre B1: publiée, available -> doit être candidate
      const offerB1 = await createOffer(
        {
          ownerId: userB.id,
          rawText: "iPhone 12 Pro",
          model: "iPhone 12 Pro",
          availabilityStatus: "available",
        },
        pool,
      );
      await publishOffer(userB.id, offerB1.id, offerB1.contentVersion, pool);

      // Offre B2: publiée, reserved -> doit être candidate (Règle 1: conserver les offres reserved)
      const offerB2 = await createOffer(
        {
          ownerId: userB.id,
          rawText: "iPhone 12 réservé",
          model: "iPhone 12",
          availabilityStatus: "reserved",
        },
        pool,
      );
      await publishOffer(userB.id, offerB2.id, offerB2.contentVersion, pool);

      // Offre B3: publiée, unavailable -> EXCLUE
      const offerB3 = await createOffer(
        {
          ownerId: userB.id,
          rawText: "iPhone 12 indisponible",
          model: "iPhone 12",
          availabilityStatus: "unavailable",
        },
        pool,
      );
      await publishOffer(userB.id, offerB3.id, offerB3.contentVersion, pool);

      // Offre B4: draft (non publiée) -> EXCLUE
      await createOffer(
        {
          ownerId: userB.id,
          rawText: "iPhone 12 brouillon",
          model: "iPhone 12",
        },
        pool,
      );

      // Offre B5: publiée puis archivée -> EXCLUE
      const offerB5 = await createOffer(
        {
          ownerId: userB.id,
          rawText: "iPhone 12 archivé",
          model: "iPhone 12",
        },
        pool,
      );
      const pubB5 = await publishOffer(userB.id, offerB5.id, offerB5.contentVersion, pool);
      await archiveOffer(userB.id, offerB5.id, pubB5.contentVersion, pool);

      // Propriétaire C suspendu
      const userC = await createUser({ status: "suspended" }, pool);
      const offerC = await createOffer(
        {
          ownerId: userC.id,
          rawText: "iPhone de C suspendu",
          model: "iPhone 12",
        },
        pool,
      );
      await publishOffer(userC.id, offerC.id, offerC.contentVersion, pool);

      // Propriétaire D archivé
      const userD = await createUser({ status: "active" }, pool);
      const offerD = await createOffer(
        {
          ownerId: userD.id,
          rawText: "iPhone de D archivé",
          model: "iPhone 12",
        },
        pool,
      );
      await publishOffer(userD.id, offerD.id, offerD.contentVersion, pool);
      await archiveUser(userD.id, userD.version, pool);

      // Recherche des offres candidates pour la demande de A
      const res = await findOfferCandidatesForDemand(userA.id, demandA.id, { limit: 50 }, pool);

      const candidateIds = res.items.map((o) => o.id);
      assert.ok(candidateIds.includes(offerB1.id), "Offre B1 doit être présente");
      assert.ok(candidateIds.includes(offerB2.id), "Offre B2 (reserved) doit être présente");
      assert.ok(!candidateIds.includes(offerOwn.id), "Auto-matching exclu");
      assert.ok(!candidateIds.includes(offerB3.id), "Offre unavailable exclue");
      assert.ok(!candidateIds.includes(offerB5.id), "Offre archivée exclue");
      assert.ok(!candidateIds.includes(offerC.id), "Offre d'utilisateur suspendu exclue");
      assert.ok(!candidateIds.includes(offerD.id), "Offre d'utilisateur archivé exclue");
    });

    test("direction offre -> demandes : exclusion auto-matching, états exclus et propriétaires inactifs", async () => {
      // Propriétaire X
      const userX = await createUser({ status: "active" }, pool);
      const offerX = await createOffer(
        {
          ownerId: userX.id,
          rawText: "Offre X iPhone 13",
          category: "smartphones",
        },
        pool,
      );
      await publishOffer(userX.id, offerX.id, offerX.contentVersion, pool);

      // Demande propre de X -> auto-matching exclu
      const demandX = await createDemand(
        {
          ownerId: userX.id,
          rawText: "Demande X iPhone 13",
        },
        pool,
      );
      await activateDemand(userX.id, demandX.id, demandX.contentVersion, pool);

      // Propriétaire Y (actif)
      const userY = await createUser({ status: "active" }, pool);

      // Demande Y1: active -> candidate
      const demandY1 = await createDemand(
        {
          ownerId: userY.id,
          rawText: "Cherche iPhone 13",
        },
        pool,
      );
      await activateDemand(userY.id, demandY1.id, demandY1.contentVersion, pool);

      // Demande Y2: draft (non active) -> EXCLUE
      await createDemand(
        {
          ownerId: userY.id,
          rawText: "Cherche iPhone 13 brouillon",
        },
        pool,
      );

      // Demande Y3: archivée -> EXCLUE
      const demandY3 = await createDemand(
        {
          ownerId: userY.id,
          rawText: "Cherche iPhone 13 archivée",
        },
        pool,
      );
      const actY3 = await activateDemand(userY.id, demandY3.id, demandY3.contentVersion, pool);
      await archiveDemand(userY.id, demandY3.id, actY3.contentVersion, pool);

      // Propriétaire Z suspendu
      const userZ = await createUser({ status: "suspended" }, pool);
      const demandZ = await createDemand(
        {
          ownerId: userZ.id,
          rawText: "Demande de Z",
        },
        pool,
      );
      await activateDemand(userZ.id, demandZ.id, demandZ.contentVersion, pool);

      // Recherche des demandes candidates pour l'offre de X
      const res = await findDemandCandidatesForOffer(userX.id, offerX.id, { limit: 50 }, pool);

      const candidateIds = res.items.map((d) => d.id);
      assert.ok(candidateIds.includes(demandY1.id), "Demande Y1 doit être candidate");
      assert.ok(!candidateIds.includes(demandX.id), "Auto-matching exclu");
      assert.ok(!candidateIds.includes(demandY3.id), "Demande archivée exclue");
      assert.ok(!candidateIds.includes(demandZ.id), "Demande d'utilisateur suspendu exclue");
    });

    test("non-élimination prématurée : valeurs inconnues, accents, casse et unités conservées pour évaluation 2A", async () => {
      const userAlpha = await createUser({ status: "active" }, pool);
      const userBeta = await createUser({ status: "active" }, pool);

      // Demande avec catégorie et attributs spécifiques
      const demandAlpha = await createDemand(
        {
          ownerId: userAlpha.id,
          rawText: "Cherche téléphone Apple",
          category: "Téléphonie",
          brand: "Apple",
          attributes: { storage_capacity: { value: 128, unit: "Go" } },
        },
        pool,
      );
      await activateDemand(userAlpha.id, demandAlpha.id, demandAlpha.contentVersion, pool);

      // Offre avec catégorie sans accent, casse différente ou attribut null/unknown
      // En 2C1, aucun filtre SQL ne doit éliminer ces offres : seul 2A les évaluera.
      const offer1 = await createOffer(
        {
          ownerId: userBeta.id,
          rawText: "iPhone 128 Go",
          category: "telephonie", // sans accent
          brand: "APPLE", // majuscules
          attributes: null, // inconnu
        },
        pool,
      );
      await publishOffer(userBeta.id, offer1.id, offer1.contentVersion, pool);

      const offer2 = await createOffer(
        {
          ownerId: userBeta.id,
          rawText: "Autre appareil catégorie inconnue",
          category: null, // catégorie inconnue
          brand: null,
        },
        pool,
      );
      await publishOffer(userBeta.id, offer2.id, offer2.contentVersion, pool);

      const candidates = await findOfferCandidatesForDemand(
        userAlpha.id,
        demandAlpha.id,
        { limit: 50 },
        pool,
      );

      const ids = candidates.items.map((o) => o.id);
      assert.ok(ids.includes(offer1.id), "Offre avec casse/accent différents conservée");
      assert.ok(ids.includes(offer2.id), "Offre avec champs inconnus conservée");
    });

    test("isolation propriétaire sur la ressource source : CatalogNotFoundError si absent ou appartenant à autrui", async () => {
      const user1 = await createUser({ status: "active" }, pool);
      const user2 = await createUser({ status: "active" }, pool);

      const offer1 = await createOffer({ ownerId: user1.id, rawText: "Offre 1" }, pool);
      await publishOffer(user1.id, offer1.id, offer1.contentVersion, pool);

      const unknownId = randomUUID();

      // Offre inexistante
      await assert.rejects(
        findDemandCandidatesForOffer(user1.id, unknownId, {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );

      // Offre appartenant à user1 interrogée avec user2 (Règle 4: CatalogNotFoundError)
      await assert.rejects(
        findDemandCandidatesForOffer(user2.id, offer1.id, {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );

      const demand1 = await createDemand({ ownerId: user1.id, rawText: "Demande 1" }, pool);
      await activateDemand(user1.id, demand1.id, demand1.contentVersion, pool);

      // Demande inexistante
      await assert.rejects(
        findOfferCandidatesForDemand(user1.id, unknownId, {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );

      // Demande appartenant à user1 interrogée avec user2 (Règle 4: CatalogNotFoundError)
      await assert.rejects(
        findOfferCandidatesForDemand(user2.id, demand1.id, {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );
    });

    test("source non éligible (draft, unavailable, propriétaire suspendu) rejetée avec CatalogValidationError", async () => {
      const user = await createUser({ status: "active" }, pool);

      // Offre draft
      const draftOffer = await createOffer({ ownerId: user.id, rawText: "Draft" }, pool);
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, draftOffer.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // Offre unavailable
      const unavailOffer = await createOffer(
        { ownerId: user.id, rawText: "Unavail", availabilityStatus: "unavailable" },
        pool,
      );
      await publishOffer(user.id, unavailOffer.id, unavailOffer.contentVersion, pool);
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, unavailOffer.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // Propriétaire suspendu
      const suspendedUser = await createUser({ status: "active" }, pool);
      const offerSuspended = await createOffer({ ownerId: suspendedUser.id, rawText: "Pub" }, pool);
      await publishOffer(suspendedUser.id, offerSuspended.id, offerSuspended.contentVersion, pool);
      await updateUser({ id: suspendedUser.id, expectedVersion: suspendedUser.version, status: "suspended" }, pool);

      await assert.rejects(
        findDemandCandidatesForOffer(suspendedUser.id, offerSuspended.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );
    });

    test("pagination par curseur stable : microsecondes exactes, plusieurs lignes dans la même milliseconde", async () => {
      const sourceUser = await createUser({ status: "active" }, pool);
      const candidateUser = await createUser({ status: "active" }, pool);

      const sourceDemand = await createDemand(
        { ownerId: sourceUser.id, rawText: "Demande source" },
        pool,
      );
      await activateDemand(sourceUser.id, sourceDemand.id, sourceDemand.contentVersion, pool);

      // Insérer 5 offres dans la même transaction avec le même timestamp de transaction
      // ou timestamps avec microsecondes contrôlées
      const fixedTimestamp = "2032-01-01 12:00:00.123456+00";
      const createdOffers: string[] = [];

      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        createdOffers.push(id);
        await pool.query(
          `INSERT INTO offers (
             id, owner_id, status, raw_text, created_at, updated_at
           ) VALUES (
             $1, $2, 'published', $3, $4::timestamptz, $4::timestamptz
           )`,
          [id, candidateUser.id, `Offre même timestamp ${i}`, fixedTimestamp],
        );
      }

      // Pagination avec limit: 2
      const page1 = await findOfferCandidatesForDemand(
        sourceUser.id,
        sourceDemand.id,
        { limit: 2 },
        pool,
      );

      assert.equal(page1.items.length, 2);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor !== null);

      const page2 = await findOfferCandidatesForDemand(
        sourceUser.id,
        sourceDemand.id,
        { limit: 2, cursor: page1.nextCursor },
        pool,
      );

      assert.equal(page2.items.length, 2);
      assert.equal(page2.hasMore, true);
      assert.ok(page2.nextCursor !== null);

      const page3 = await findOfferCandidatesForDemand(
        sourceUser.id,
        sourceDemand.id,
        { limit: 2, cursor: page2.nextCursor },
        pool,
      );

      assert.ok(page3.items.length >= 1);

      // Vérifier l'absence de doublons entre les pages
      const allIds = [
        ...page1.items.map((o) => o.id),
        ...page2.items.map((o) => o.id),
        ...page3.items.map((o) => o.id),
      ];
      const uniqueIds = new Set(allIds);
      assert.equal(allIds.length, uniqueIds.size, "Aucun doublon sur données stables");
    });

    test("validation des limites et rejet des curseurs corrompus", async () => {
      const user = await createUser({ status: "active" }, pool);
      const offer = await createOffer({ ownerId: user.id, rawText: "Offre test" }, pool);
      await publishOffer(user.id, offer.id, offer.contentVersion, pool);

      // Limites invalides
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, offer.id, { limit: 0 }, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, offer.id, { limit: 101 }, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, offer.id, { limit: -5 }, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // Curseurs invalides
      await assert.rejects(
        findDemandCandidatesForOffer(user.id, offer.id, { cursor: "not-a-valid-cursor" }, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );
      await assert.rejects(
        findDemandCandidatesForOffer(
          user.id,
          offer.id,
          { cursor: Buffer.from(JSON.stringify({ bad: "payload" })).toString("base64url") },
          pool,
        ),
        (err: unknown) => err instanceof CatalogValidationError,
      );
    });

    test("absence d'écriture métier (requête de sélection en lecture pure)", async () => {
      const user = await createUser({ status: "active" }, pool);
      const offer = await createOffer({ ownerId: user.id, rawText: "Offre test" }, pool);
      const pubOffer = await publishOffer(user.id, offer.id, offer.contentVersion, pool);

      // Version avant appel
      const beforeVersion = pubOffer.contentVersion;

      await findDemandCandidatesForOffer(user.id, pubOffer.id, {}, pool);

      // Vérifier que content_version et updated_at sont inchangés
      const check = await pool.query<{ content_version: number }>(
        "SELECT content_version FROM offers WHERE id = $1",
        [pubOffer.id],
      );
      assert.equal(check.rows[0].content_version, beforeVersion);
    });

    test("pagination exacte indépendante du TimeZone de session (UTC, Auckland, New York)", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const owner = await createUser({ status: "active" }, isolatedPool);
        const other = await createUser({ status: "active" }, isolatedPool);

        const demand = await createDemand(
          { ownerId: owner.id, rawText: "Source pagination timezone" },
          isolatedPool,
        );
        await activateDemand(owner.id, demand.id, demand.contentVersion, isolatedPool);

        const candidateOfferIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const id = randomUUID();
          candidateOfferIds.push(id);
          await isolatedPool.query(
            "INSERT INTO offers(id, owner_id, status, raw_text, created_at) VALUES ($1, $2, 'published', 'Candidate', $3::timestamptz)",
            [id, other.id, `2032-05-01T10:00:00.12345${i}Z`],
          );
        }

        for (const tz of ["UTC", "Pacific/Auckland", "America/New_York"]) {
          await isolatedPool.query("SELECT set_config('TimeZone', $1, false)", [tz]);
          let cursor: string | null = null;
          const retrieved: string[] = [];
          for (let step = 0; step < 5; step++) {
            const page = await findOfferCandidatesForDemand(
              owner.id,
              demand.id,
              { limit: 1, cursor },
              isolatedPool,
            );
            retrieved.push(...page.items.map((x) => x.id));
            if (!page.hasMore) break;
            cursor = page.nextCursor;
          }

          assert.equal(retrieved.length, 3);
          assert.deepEqual([...retrieved].sort(), [...candidateOfferIds].sort());
          assert.equal(new Set(retrieved).size, 3);
        }

        // Test dans l'autre sens (demandes candidates pour une offre)
        const offer = await createOffer(
          { ownerId: owner.id, rawText: "Source offer pagination timezone" },
          isolatedPool,
        );
        await publishOffer(owner.id, offer.id, offer.contentVersion, isolatedPool);

        const candidateDemandIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const id = randomUUID();
          candidateDemandIds.push(id);
          await isolatedPool.query(
            "INSERT INTO demands(id, owner_id, status, raw_text, created_at) VALUES ($1, $2, 'active', 'Candidate demand', $3::timestamptz)",
            [id, other.id, `2032-05-01T11:00:00.12345${i}Z`],
          );
        }

        for (const tz of ["UTC", "Pacific/Auckland", "America/New_York"]) {
          await isolatedPool.query("SELECT set_config('TimeZone', $1, false)", [tz]);
          let cursor: string | null = null;
          const retrieved: string[] = [];
          for (let step = 0; step < 5; step++) {
            const page = await findDemandCandidatesForOffer(
              owner.id,
              offer.id,
              { limit: 1, cursor },
              isolatedPool,
            );
            retrieved.push(...page.items.map((x) => x.id));
            if (!page.hasMore) break;
            cursor = page.nextCursor;
          }

          assert.equal(retrieved.length, 3);
          assert.deepEqual([...retrieved].sort(), [...candidateDemandIds].sort());
          assert.equal(new Set(retrieved).size, 3);
        }
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("conservation des erreurs source même en l'absence de candidat (0 candidats)", async () => {
      const owner = await createUser({ status: "active" }, pool);
      const demand = await createDemand({ ownerId: owner.id, rawText: "Demand zero candidates" }, pool);
      // Non active (status = draft)
      await assert.rejects(
        findOfferCandidatesForDemand(owner.id, demand.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // Désactivation / suspension du propriétaire
      await activateDemand(owner.id, demand.id, demand.contentVersion, pool);
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [owner.id]);

      await assert.rejects(
        findOfferCandidatesForDemand(owner.id, demand.id, {}, pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("propriétaire"),
      );

      // Idem direction offre -> demandes avec 0 candidats
      const offer = await createOffer({ ownerId: owner.id, rawText: "Offer zero candidates" }, pool);
      await assert.rejects(
        findDemandCandidatesForOffer(owner.id, offer.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );
    });

    test("insensibilité à la casse des UUIDs (uppercase vs lowercase)", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const owner = await createUser({ status: "active" }, isolatedPool);
        const other = await createUser({ status: "active" }, isolatedPool);
        const offer = await createOffer({ ownerId: owner.id, rawText: "Offer case insensitivity" }, isolatedPool);
        const pubOffer = await publishOffer(owner.id, offer.id, offer.contentVersion, isolatedPool);

        const dem = await createDemand({ ownerId: other.id, rawText: "Demand case insensitivity" }, isolatedPool);
        await activateDemand(other.id, dem.id, dem.contentVersion, isolatedPool);

        // UUID propriétaire en majuscules
        const res1 = await findDemandCandidatesForOffer(
          owner.id.toUpperCase(),
          pubOffer.id,
          {},
          isolatedPool,
        );
        assert.equal(res1.items.length, 1);
        assert.equal(res1.items[0].id, dem.id);

        // UUID offre en majuscules
        const res2 = await findDemandCandidatesForOffer(
          owner.id,
          pubOffer.id.toUpperCase(),
          {},
          isolatedPool,
        );
        assert.equal(res2.items.length, 1);
        assert.equal(res2.items[0].id, dem.id);
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("instantané cohérent : contrôle source et candidats atomique (pas de snapshot mixte)", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const owner = await createUser({ status: "active" }, isolatedPool);
        const other = await createUser({ status: "active" }, isolatedPool);

        const demand = await createDemand({ ownerId: owner.id, rawText: "Source atomic demand" }, isolatedPool);
        await activateDemand(owner.id, demand.id, demand.contentVersion, isolatedPool);

        let injected = false;
        const lateOfferId = randomUUID();

        // Proxy SqlExecutor simulant une concurrence
        const db = {
          query: async (text: string, values?: unknown[]) => {
            const result = await isolatedPool.query(text, values);
            if (!injected && text.includes("user_status")) {
              injected = true;
              // Désactivation source et insertion d'un candidat tardif
              await isolatedPool.query("UPDATE demands SET status = 'draft' WHERE id = $1", [demand.id]);
              await isolatedPool.query(
                "INSERT INTO offers(id, owner_id, status, raw_text) VALUES ($1, $2, 'published', 'Late offer')",
                [lateOfferId, other.id],
              );
            }
            return result;
          },
        };

        const page = await findOfferCandidatesForDemand(owner.id, demand.id, {}, db);
        assert.ok(
          !page.items.some((x) => x.id === lateOfferId),
          "Le candidat tardif ne doit pas apparaître dans un instantané où la source était active",
        );

        // Suspension synchronisée du propriétaire
        const offer = await createOffer({ ownerId: owner.id, rawText: "Source atomic offer" }, isolatedPool);
        await publishOffer(owner.id, offer.id, offer.contentVersion, isolatedPool);

        // Suspendre le propriétaire
        await isolatedPool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [owner.id]);

        await assert.rejects(
          findDemandCandidatesForOffer(owner.id, offer.id, {}, isolatedPool),
          (err: unknown) =>
            err instanceof CatalogValidationError &&
            err.message.includes("propriétaire"),
        );
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("validation stricte du curseur de pagination avant appel SQL", async () => {
      const id = randomUUID();
      const validCursor = encodeCandidateCursor({
        createdAtIso: "2032-01-01T12:00:00.123456Z",
        id,
      });

      // Types non chaînes
      assert.throws(() => decodeCandidateCursor(42), (err: unknown) => err instanceof CatalogValidationError);
      assert.throws(() => decodeCandidateCursor(true), (err: unknown) => err instanceof CatalogValidationError);
      assert.throws(() => decodeCandidateCursor({}), (err: unknown) => err instanceof CatalogValidationError);

      // Caractères invalides base64url
      assert.throws(() => decodeCandidateCursor(validCursor + "!"), (err: unknown) => err instanceof CatalogValidationError);
      assert.throws(() => decodeCandidateCursor(validCursor + "="), (err: unknown) => err instanceof CatalogValidationError);

      // Date calendairement invalide (30 février)
      const invalidDateCursor = encodeCandidateCursor({
        createdAtIso: "2032-02-30T12:00:00.123456Z",
        id,
      });
      assert.throws(() => decodeCandidateCursor(invalidDateCursor), (err: unknown) => err instanceof CatalogValidationError);

      // Date sans microsecondes ou non UTC
      const noMicroCursor = encodeCandidateCursor({
        createdAtIso: "2032-01-01T12:00:00Z",
        id,
      });
      assert.throws(() => decodeCandidateCursor(noMicroCursor), (err: unknown) => err instanceof CatalogValidationError);

      // Propriété inattendue
      const extraPropCursor = Buffer.from(
        JSON.stringify({ createdAtIso: "2032-01-01T12:00:00.123456Z", id, extra: true }),
        "utf8",
      ).toString("base64url");
      assert.throws(() => decodeCandidateCursor(extraPropCursor), (err: unknown) => err instanceof CatalogValidationError);
    });
  });
}
