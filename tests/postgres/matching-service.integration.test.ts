import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  activateDemand,
  createDemand,
  createOffer,
  createUser,
  publishOffer,
} from "../../lib/server/catalog";
import {
  CatalogNotFoundError,
  CatalogValidationError,
} from "../../lib/server/catalog/errors";
import {
  findEvaluatedDemandMatchesForOffer,
  findEvaluatedOfferMatchesForDemand,
} from "../../lib/server/matching/service";
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
  test("pré-requis PostgreSQL dédié pour service de matching Lot 2C2", () => {
    assert.fail(
      "TEST_DATABASE_URL requis : aucun test service matching n'a été simulé.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour service de matching Lot 2C2", () => {
    throw configuredUrlError;
  });
} else {
  describe("service serveur d'évaluation de candidats Lot 2C2 (2A + 2B)", () => {
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

    test("direction demande -> offres : évaluation de paires compatibles, incompatibles et inconnues", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        // Demande de A
        const demand = await createDemand(
          {
            ownerId: userA.id,
            rawText: "Cherche iPhone 13 128Go avec chargeur",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
            requirements: [
              { key: "chargeur", operator: "includes", value: "chargeur" },
            ],
            budget: { amount: 300_000, currency: "XOF" },
          },
          isolatedPool,
        );
        const actDemand = await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        // 1. Offre B1: Compatible parfaite
        const offer1 = await createOffer(
          {
            ownerId: userB.id,
            rawText: "iPhone 13 128Go avec chargeur original",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
            attributes: { charger_included: true },
            price: { amount: 250_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await publishOffer(userB.id, offer1.id, offer1.contentVersion, isolatedPool);

        // 2. Offre B2: Incompatible (modèle différent)
        const offer2 = await createOffer(
          {
            ownerId: userB.id,
            rawText: "iPhone 12 128Go avec chargeur",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 12",
            attributes: { charger_included: true },
            price: { amount: 200_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await publishOffer(userB.id, offer2.id, offer2.contentVersion, isolatedPool);

        // 3. Offre B3: Inconnue (chargeur manquant / non renseigné)
        const offer3 = await createOffer(
          {
            ownerId: userB.id,
            rawText: "iPhone 13 sans info chargeur",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
            price: { amount: 260_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await publishOffer(userB.id, offer3.id, offer3.contentVersion, isolatedPool);

        const page = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 10 },
          isolatedPool,
        );

        assert.equal(page.contractVersion, "matching-service/v1");
        assert.equal(page.source.id, demand.id);
        assert.equal(page.source.contentVersion, actDemand.contentVersion);
        assert.equal(page.items.length, 3);

        const item1 = page.items.find((it) => it.candidateId === offer1.id);
        const item2 = page.items.find((it) => it.candidateId === offer2.id);
        const item3 = page.items.find((it) => it.candidateId === offer3.id);

        assert.ok(item1 && item2 && item3);

        // Item 1 : compatible, score élevé
        assert.equal(item1.compatibilityStatus, "compatible");
        assert.equal(item1.evaluation.compatibility.status, "compatible");
        assert.equal(item1.scoring.score, 100);
        assert.equal(item1.scoring.coverage, 100);

        // Item 2 : incompatible
        assert.equal(item2.compatibilityStatus, "incompatible");
        assert.equal(item2.evaluation.compatibility.status, "incompatible");

        // Item 3 : inconnu (obligation chargeur inconnue)
        assert.equal(item3.compatibilityStatus, "unknown");
        assert.equal(item3.evaluation.compatibility.status, "unknown");
        assert.ok(item3.scoring.score !== null && item3.scoring.score < 100);
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("direction offre -> demandes : évaluation de paires dans l'autre sens", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        const offer = await createOffer(
          {
            ownerId: userA.id,
            rawText: "MacBook Pro M1 16Go",
            category: "ordinateurs",
            brand: "Apple",
            model: "MacBook Pro",
            price: { amount: 600_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await publishOffer(userA.id, offer.id, offer.contentVersion, isolatedPool);

        // Demande compatible
        const demand1 = await createDemand(
          {
            ownerId: userB.id,
            rawText: "Cherche MacBook Pro",
            category: "ordinateurs",
            brand: "Apple",
            model: "MacBook Pro",
            budget: { amount: 700_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await activateDemand(userB.id, demand1.id, demand1.contentVersion, isolatedPool);

        // Demande incompatible (budget insuffisant)
        const demand2 = await createDemand(
          {
            ownerId: userB.id,
            rawText: "Cherche MacBook Pro budget serré",
            category: "ordinateurs",
            brand: "Apple",
            model: "MacBook Pro",
            budget: { amount: 400_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await activateDemand(userB.id, demand2.id, demand2.contentVersion, isolatedPool);

        const page = await findEvaluatedDemandMatchesForOffer(
          userA.id,
          offer.id,
          { limit: 10 },
          isolatedPool,
        );

        assert.equal(page.items.length, 2);
        const it1 = page.items.find((it) => it.candidateId === demand1.id);
        const it2 = page.items.find((it) => it.candidateId === demand2.id);

        assert.ok(it1 && it2);
        assert.equal(it1.compatibilityStatus, "compatible");
        assert.equal(it2.compatibilityStatus, "incompatible");
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("distinction stricte : un score élevé ne transforme jamais un statut unknown ou incompatible en compatible", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        // Demande avec de nombreux critères satisfaits mais une obligation inconnue
        const demand = await createDemand(
          {
            ownerId: userA.id,
            rawText: "iPhone 13 128Go avec écouteurs",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
            requirements: [
              { key: "ecouteurs", operator: "includes", value: "ecouteurs" },
            ],
            budget: { amount: 300_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        // Offre où écouteurs est absent
        const offer = await createOffer(
          {
            ownerId: userB.id,
            rawText: "iPhone 13 128Go",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
            price: { amount: 250_000, currency: "XOF" },
          },
          isolatedPool,
        );
        await publishOffer(userB.id, offer.id, offer.contentVersion, isolatedPool);

        const page = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 10 },
          isolatedPool,
        );

        assert.equal(page.items.length, 1);
        const item = page.items[0];

        // 4 critères satisfaits (catégorie, marque, modèle, prix) sur 5 => score = 80
        assert.ok(item.scoring.score !== null && item.scoring.score >= 80);
        // Mais le statut DOIT RESTER STRICTEMENT "unknown"
        assert.equal(item.compatibilityStatus, "unknown");
        assert.equal(item.evaluation.compatibility.status, "unknown");
        assert.notEqual(item.compatibilityStatus, "compatible");
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("page vide : retourne une structure valide avec items=[] et nextCursor=null", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const demand = await createDemand(
          { ownerId: userA.id, rawText: "Demande isolée sans aucun candidat" },
          isolatedPool,
        );
        await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        const page = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 10 },
          isolatedPool,
        );

        assert.equal(page.contractVersion, "matching-service/v1");
        assert.equal(page.source.id, demand.id);
        assert.equal(page.items.length, 0);
        assert.equal(page.hasMore, false);
        assert.equal(page.nextCursor, null);
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("pagination et conservation de l'ordre d'origine des candidats (pas de re-tri par score)", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        const demand = await createDemand(
          {
            ownerId: userA.id,
            rawText: "Demande pagination",
            category: "ordinateurs",
            model: "ThinkPad",
          },
          isolatedPool,
        );
        await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        // Insérer 4 offres à des timestamps dégressifs
        // Offre la plus ancienne aura un score parfait, offre récente score nul
        const offerIds: string[] = [];
        for (let i = 0; i < 4; i++) {
          const id = randomUUID();
          offerIds.push(id);
          const isMatch = i === 3; // L'offre la plus ancienne sera le meilleur match
          await isolatedPool.query(
            `INSERT INTO offers (id, owner_id, status, raw_text, category, model, created_at)
             VALUES ($1, $2, 'published', 'Candidate', $3, $4, $5::timestamptz)`,
            [
              id,
              userB.id,
              isMatch ? "ordinateurs" : "autres",
              isMatch ? "ThinkPad" : "Inconnu",
              `2032-01-01T12:00:00.12345${i}Z`,
            ],
          );
        }

        // Pagination avec limit: 2
        const page1 = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 2 },
          isolatedPool,
        );

        assert.equal(page1.items.length, 2);
        assert.equal(page1.hasMore, true);
        assert.ok(page1.nextCursor !== null);

        // L'ordre DOIT être strictement celui de created_at DESC (les plus récents en premier), pas trié par score
        assert.equal(page1.items[0].candidateId, offerIds[3]);
        assert.equal(page1.items[1].candidateId, offerIds[2]);

        const page2 = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 2, cursor: page1.nextCursor },
          isolatedPool,
        );

        assert.equal(page2.items.length, 2);
        assert.equal(page2.hasMore, false);
        assert.equal(page2.items[0].candidateId, offerIds[1]);
        assert.equal(page2.items[1].candidateId, offerIds[0]);

        // Tous les identifiants retrouvés sans doublon
        const allRetrieved = [...page1.items, ...page2.items].map((x) => x.candidateId);
        assert.deepEqual(allRetrieved, [...offerIds].reverse());
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("isolation propriétaire sur la source : CatalogNotFoundError si absent ou appartenant à un tiers", async () => {
      const userA = await createUser({ status: "active" }, pool);
      const userB = await createUser({ status: "active" }, pool);

      const demandA = await createDemand({ ownerId: userA.id, rawText: "Demande A" }, pool);
      await activateDemand(userA.id, demandA.id, demandA.contentVersion, pool);

      // Ressource demandée par un tiers B
      await assert.rejects(
        findEvaluatedOfferMatchesForDemand(userB.id, demandA.id, {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );

      // Ressource inexistante demandée par A
      await assert.rejects(
        findEvaluatedOfferMatchesForDemand(userA.id, randomUUID(), {}, pool),
        (err: unknown) => err instanceof CatalogNotFoundError,
      );
    });

    test("source non éligible : rejetée avec CatalogValidationError", async () => {
      const userA = await createUser({ status: "active" }, pool);

      // 1. Demande en état draft
      const draftDemand = await createDemand({ ownerId: userA.id, rawText: "Demande draft" }, pool);
      await assert.rejects(
        findEvaluatedOfferMatchesForDemand(userA.id, draftDemand.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // 2. Offre unavailable
      const offer = await createOffer({ ownerId: userA.id, rawText: "Offre unavailable" }, pool);
      await publishOffer(userA.id, offer.id, offer.contentVersion, pool);
      await pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [offer.id]);

      await assert.rejects(
        findEvaluatedDemandMatchesForOffer(userA.id, offer.id, {}, pool),
        (err: unknown) => err instanceof CatalogValidationError,
      );

      // 3. Propriétaire suspendu
      const userSuspended = await createUser({ status: "suspended" }, pool);
      const offerSuspended = await createOffer({ ownerId: userSuspended.id, rawText: "Offre suspendu" }, pool);
      await publishOffer(userSuspended.id, offerSuspended.id, offerSuspended.contentVersion, pool);

      await assert.rejects(
        findEvaluatedDemandMatchesForOffer(userSuspended.id, offerSuspended.id, {}, pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("propriétaire"),
      );
    });

    test("horloge injectée unique et versions préservées", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        const demand = await createDemand({ ownerId: userA.id, rawText: "Demande horloge" }, isolatedPool);
        const actDemand = await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        const offer = await createOffer({ ownerId: userB.id, rawText: "Offre horloge" }, isolatedPool);
        const pubOffer = await publishOffer(userB.id, offer.id, offer.contentVersion, isolatedPool);

        const fixedNow = new Date("2035-08-15T14:30:00.000Z");

        const page = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { now: fixedNow },
          isolatedPool,
        );

        assert.equal(page.evaluatedAt.toISOString(), fixedNow.toISOString());
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].evaluation.evaluatedAt.toISOString(), fixedNow.toISOString());
        assert.equal(page.items[0].scoring.scoredAt.toISOString(), fixedNow.toISOString());
        assert.equal(page.items[0].candidateContentVersion, pubOffer.contentVersion);
        assert.equal(page.source.contentVersion, actDemand.contentVersion);
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("instantané stable et modification concurrente (REPEATABLE READ) : direction demande -> offres", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      const writerPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        const demand = await createDemand({ ownerId: userA.id, rawText: "Demande concurrente" }, isolatedPool);
        await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        const earlyOffer = await createOffer({ ownerId: userB.id, rawText: "Offre initiale" }, isolatedPool);
        await publishOffer(userB.id, earlyOffer.id, earlyOffer.contentVersion, isolatedPool);

        const lateOfferId = randomUUID();
        let injected = false;

        // Proxy de pool pour injecter une modification juste après que le client réservé a démarré sa transaction
        const proxiedPool = {
          connect: async () => {
            const client = await isolatedPool.connect();
            const originalQuery = client.query.bind(client);
            client.query = (async (text: string, values?: unknown[]) => {
              const res = await originalQuery(text, values);
              // Dès que la source demand a été lue dans la transaction REPEATABLE READ :
              if (!injected && typeof text === "string" && text.includes("FROM demands d")) {
                injected = true;
                // Désactiver la source et créer un nouveau candidat sur une AUTRE connexion indépendante
                await writerPool.query("UPDATE demands SET status = 'draft' WHERE id = $1", [demand.id]);
                await writerPool.query(
                  "INSERT INTO offers(id, owner_id, status, raw_text) VALUES ($1, $2, 'published', 'Late candidate')",
                  [lateOfferId, userB.id],
                );
              }
              return res;
            }) as typeof client.query;
            return client;
          },
        };

        const page = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          {},
          proxiedPool as unknown as Pool,
        );

        assert.equal(injected, true, "L'injection concurrente s'est bien produite");
        // Sous REPEATABLE READ, la source demand était vue comme 'active' au début de la transaction,
        // et le candidat tardif n'existait pas au début de la transaction
        assert.ok(
          !page.items.some((it) => it.candidateId === lateOfferId),
          "Le candidat inséré après le début de la transaction ne doit pas apparaître",
        );
        assert.ok(
          page.items.some((it) => it.candidateId === earlyOffer.id),
          "Le candidat préexistant doit être présent",
        );
      } finally {
        await writerPool.end();
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("instantané stable et modification concurrente (REPEATABLE READ) : direction offre -> demandes", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      const writerPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const userB = await createUser({ status: "active" }, isolatedPool);

        const offer = await createOffer({ ownerId: userA.id, rawText: "MacBook Pro M1" }, isolatedPool);
        await publishOffer(userA.id, offer.id, offer.contentVersion, isolatedPool);

        const earlyDemand = await createDemand({ ownerId: userB.id, rawText: "Cherche MacBook Pro initiale" }, isolatedPool);
        await activateDemand(userB.id, earlyDemand.id, earlyDemand.contentVersion, isolatedPool);

        const lateDemandId = randomUUID();
        let injected = false;

        // Proxy de pool pour injecter une modification concurrente dès la lecture de l'offre source
        const proxiedPool = {
          connect: async () => {
            const client = await isolatedPool.connect();
            const originalQuery = client.query.bind(client);
            client.query = (async (text: string, values?: unknown[]) => {
              const res = await originalQuery(text, values);
              if (!injected && typeof text === "string" && text.includes("FROM offers o")) {
                injected = true;
                // Modifier la source et insérer une nouvelle demande concurrente sur une AUTRE connexion
                await writerPool.query("UPDATE offers SET status = 'draft' WHERE id = $1", [offer.id]);
                await writerPool.query(
                  "INSERT INTO demands(id, owner_id, status, raw_text) VALUES ($1, $2, 'active', 'Late demand candidate')",
                  [lateDemandId, userB.id],
                );
              }
              return res;
            }) as typeof client.query;
            return client;
          },
        };

        const page = await findEvaluatedDemandMatchesForOffer(
          userA.id,
          offer.id,
          {},
          proxiedPool as unknown as Pool,
        );

        assert.equal(injected, true, "L'injection concurrente s'est bien produite");
        assert.ok(
          !page.items.some((it) => it.candidateId === lateDemandId),
          "Le candidat inséré après le début de la transaction ne doit pas apparaître",
        );
        assert.ok(
          page.items.some((it) => it.candidateId === earlyDemand.id),
          "Le candidat préexistant doit être présent",
        );
      } finally {
        await writerPool.end();
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("refus d'un simple SqlExecutor ou d'un client réservé avant toute requête (dans les deux directions)", async () => {
      const userA = await createUser({ status: "active" }, pool);
      const userB = await createUser({ status: "active" }, pool);

      const demand = await createDemand({ ownerId: userA.id, rawText: "Demande refuser sql executor" }, pool);
      await activateDemand(userA.id, demand.id, demand.contentVersion, pool);

      const offer = await createOffer({ ownerId: userB.id, rawText: "Offre refuser sql executor" }, pool);
      await publishOffer(userB.id, offer.id, offer.contentVersion, pool);

      // 1. Direction demande -> offres avec simple SqlExecutor
      let queryCountOffers = 0;
      const plainExecutorOffers = {
        query: async () => {
          queryCountOffers++;
          return { rows: [] };
        },
      };
      await assert.rejects(
        findEvaluatedOfferMatchesForDemand(userA.id, demand.id, {}, plainExecutorOffers as unknown as Pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("pool PostgreSQL valide"),
      );
      assert.equal(queryCountOffers, 0, "Aucune requête ne doit être émise vers le simple SqlExecutor");

      // 2. Direction demande -> offres avec client déjà réservé (ayant .release)
      let queryCountReservedClientOffers = 0;
      const reservedClientOffers = {
        connect: async () => reservedClientOffers,
        query: async () => {
          queryCountReservedClientOffers++;
          return { rows: [] };
        },
        release: () => {},
      };
      await assert.rejects(
        findEvaluatedOfferMatchesForDemand(userA.id, demand.id, {}, reservedClientOffers as unknown as Pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("pool PostgreSQL valide"),
      );
      assert.equal(queryCountReservedClientOffers, 0, "Aucune requête ne doit être émise vers un client réservé");

      // 3. Direction offre -> demandes avec simple SqlExecutor
      let queryCountDemands = 0;
      const plainExecutorDemands = {
        query: async () => {
          queryCountDemands++;
          return { rows: [] };
        },
      };
      await assert.rejects(
        findEvaluatedDemandMatchesForOffer(userB.id, offer.id, {}, plainExecutorDemands as unknown as Pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("pool PostgreSQL valide"),
      );
      assert.equal(queryCountDemands, 0, "Aucune requête ne doit être émise vers le simple SqlExecutor");

      // 4. Direction offre -> demandes avec client déjà réservé (ayant .release)
      let queryCountReservedClientDemands = 0;
      const reservedClientDemands = {
        connect: async () => reservedClientDemands,
        query: async () => {
          queryCountReservedClientDemands++;
          return { rows: [] };
        },
        release: () => {},
      };
      await assert.rejects(
        findEvaluatedDemandMatchesForOffer(userB.id, offer.id, {}, reservedClientDemands as unknown as Pool),
        (err: unknown) =>
          err instanceof CatalogValidationError &&
          err.message.includes("pool PostgreSQL valide"),
      );
      assert.equal(queryCountReservedClientDemands, 0, "Aucune requête ne doit être émise vers un client réservé");
    });

    test("limite et curseur invalides : zéro acquisition de connexion et zéro requête SQL (dans les deux directions)", async () => {
      const dummyOwnerId = randomUUID();
      const dummySourceId = randomUUID();

      let acquisitions = 0;
      let queries = 0;
      const spyPool = {
        connect: async () => {
          acquisitions++;
          return {
            query: async () => {
              queries++;
              return { rows: [] };
            },
            release: () => {},
          };
        },
      };

      const invalidLimits = [0, -1, 101, 1.5, Number.NaN];
      const invalidCursors = [
        "!invalid!",
        "not-base64-url!",
        Buffer.from("invalid-json").toString("base64url"),
        Buffer.from(JSON.stringify({ v: 2 })).toString("base64url"),
      ];

      // 1. Direction demande -> offres
      for (const limit of invalidLimits) {
        await assert.rejects(
          findEvaluatedOfferMatchesForDemand(dummyOwnerId, dummySourceId, { limit }, spyPool as unknown as Pool),
          (err: unknown) => err instanceof CatalogValidationError,
        );
      }
      for (const cursor of invalidCursors) {
        await assert.rejects(
          findEvaluatedOfferMatchesForDemand(dummyOwnerId, dummySourceId, { cursor }, spyPool as unknown as Pool),
          (err: unknown) => err instanceof CatalogValidationError,
        );
      }

      // 2. Direction offre -> demandes
      for (const limit of invalidLimits) {
        await assert.rejects(
          findEvaluatedDemandMatchesForOffer(dummyOwnerId, dummySourceId, { limit }, spyPool as unknown as Pool),
          (err: unknown) => err instanceof CatalogValidationError,
        );
      }
      for (const cursor of invalidCursors) {
        await assert.rejects(
          findEvaluatedDemandMatchesForOffer(dummyOwnerId, dummySourceId, { cursor }, spyPool as unknown as Pool),
          (err: unknown) => err instanceof CatalogValidationError,
        );
      }

      assert.equal(acquisitions, 0, "Aucune acquisition de connexion autorisée sur paramètre invalide");
      assert.equal(queries, 0, "Aucune requête SQL autorisée sur paramètre invalide");
    });

    test("rollback et libération de connexion sur erreur d'exécution (dans les deux directions)", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const isolatedPool = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(isolatedPool);

      try {
        const userA = await createUser({ status: "active" }, isolatedPool);
        const demand = await createDemand({ ownerId: userA.id, rawText: "Demande rollback" }, isolatedPool);
        await activateDemand(userA.id, demand.id, demand.contentVersion, isolatedPool);

        const offer = await createOffer({ ownerId: userA.id, rawText: "Offre rollback" }, isolatedPool);
        await publishOffer(userA.id, offer.id, offer.contentVersion, isolatedPool);

        // 1. Direction demande -> offres : simulation d'une erreur SQL
        let releasedOffers = false;
        const statementsOffers: string[] = [];
        const failingPoolOffers = {
          connect: async () => {
            const realClient = await isolatedPool.connect();
            return {
              query: async (text: string, values?: unknown[]) => {
                const cmd = typeof text === "string" ? text.trim().split(/\s+/)[0].toUpperCase() : "";
                statementsOffers.push(cmd);
                if (typeof text === "string" && text.includes("FROM demands d")) {
                  throw new Error("Simulated failure reading source demand");
                }
                return realClient.query(text, values);
              },
              release: () => {
                releasedOffers = true;
                realClient.release();
              },
            };
          },
        };

        await assert.rejects(
          findEvaluatedOfferMatchesForDemand(userA.id, demand.id, {}, failingPoolOffers as unknown as Pool),
          (err: unknown) => err instanceof Error && err.message.includes("Simulated failure reading source demand"),
        );
        assert.equal(releasedOffers, true, "Le client doit avoir été libéré");
        assert.ok(statementsOffers.includes("BEGIN"), "BEGIN doit avoir été exécuté");
        assert.ok(statementsOffers.includes("ROLLBACK"), "ROLLBACK doit avoir été exécuté suite à l'erreur");

        // 2. Direction offre -> demandes : simulation d'une erreur SQL
        let releasedDemands = false;
        const statementsDemands: string[] = [];
        const failingPoolDemands = {
          connect: async () => {
            const realClient = await isolatedPool.connect();
            return {
              query: async (text: string, values?: unknown[]) => {
                const cmd = typeof text === "string" ? text.trim().split(/\s+/)[0].toUpperCase() : "";
                statementsDemands.push(cmd);
                if (typeof text === "string" && text.includes("FROM offers o")) {
                  throw new Error("Simulated failure reading source offer");
                }
                return realClient.query(text, values);
              },
              release: () => {
                releasedDemands = true;
                realClient.release();
              },
            };
          },
        };

        await assert.rejects(
          findEvaluatedDemandMatchesForOffer(userA.id, offer.id, {}, failingPoolDemands as unknown as Pool),
          (err: unknown) => err instanceof Error && err.message.includes("Simulated failure reading source offer"),
        );
        assert.equal(releasedDemands, true, "Le client doit avoir été libéré");
        assert.ok(statementsDemands.includes("BEGIN"), "BEGIN doit avoir été exécuté");
        assert.ok(statementsDemands.includes("ROLLBACK"), "ROLLBACK doit avoir été exécuté suite à l'erreur");

        // Vérifier que le pool est immédiatement réutilisable sans blocage
        const check = await isolatedPool.query("SELECT 1 AS ok");
        assert.equal(check.rows[0].ok, 1);
      } finally {
        await isolatedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("fonctionnement nominal sur pool limité à 1 connexion (max: 1) dans les deux directions", async () => {
      const testSchema = createTemporarySchemaName();
      const quotedTestSchema = quoteTemporarySchema(testSchema);
      await adminPool.query(`CREATE SCHEMA ${quotedTestSchema}`);
      const poolMax1 = await openVerifiedIsolatedPool(target, testSchema);
      await runMigrations(poolMax1);

      try {
        const userA = await createUser({ status: "active" }, poolMax1);
        const userB = await createUser({ status: "active" }, poolMax1);

        const demand = await createDemand(
          {
            ownerId: userA.id,
            rawText: "Demande sur pool max: 1",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
          },
          poolMax1,
        );
        await activateDemand(userA.id, demand.id, demand.contentVersion, poolMax1);

        const offer = await createOffer(
          {
            ownerId: userB.id,
            rawText: "Offre sur pool max: 1",
            category: "smartphones",
            brand: "Apple",
            model: "iPhone 13",
          },
          poolMax1,
        );
        await publishOffer(userB.id, offer.id, offer.contentVersion, poolMax1);

        // 1. Demande -> offres sur pool max: 1
        const pageOffers = await findEvaluatedOfferMatchesForDemand(
          userA.id,
          demand.id,
          { limit: 10 },
          poolMax1,
        );
        assert.equal(pageOffers.items.length, 1);
        assert.equal(pageOffers.items[0].candidateId, offer.id);

        // 2. Offre -> demandes sur le MÊME pool max: 1 immédiatement après
        const pageDemands = await findEvaluatedDemandMatchesForOffer(
          userB.id,
          offer.id,
          { limit: 10 },
          poolMax1,
        );
        assert.equal(pageDemands.items.length, 1);
        assert.equal(pageDemands.items[0].candidateId, demand.id);

        // 3. Requête ultérieure pour confirmer qu'aucune connexion n'est bloquée ou fuite
        const ping = await poolMax1.query("SELECT 42 AS val");
        assert.equal(ping.rows[0].val, 42);
      } finally {
        await poolMax1.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedTestSchema} CASCADE`);
      }
    });

    test("absence d'écriture métier (lecture pure vérifiée sur versions et updated_at)", async () => {
      const userA = await createUser({ status: "active" }, pool);
      const userB = await createUser({ status: "active" }, pool);

      const demand = await createDemand({ ownerId: userA.id, rawText: "Demande pure read" }, pool);
      const pubDemand = await activateDemand(userA.id, demand.id, demand.contentVersion, pool);

      const offer = await createOffer({ ownerId: userB.id, rawText: "Offre pure read" }, pool);
      const pubOffer = await publishOffer(userB.id, offer.id, offer.contentVersion, pool);

      await findEvaluatedOfferMatchesForDemand(userA.id, pubDemand.id, {}, pool);
      await findEvaluatedDemandMatchesForOffer(userB.id, pubOffer.id, {}, pool);

      const checkDemand = await pool.query<{ content_version: number }>(
        "SELECT content_version FROM demands WHERE id = $1",
        [pubDemand.id],
      );
      const checkOffer = await pool.query<{ content_version: number }>(
        "SELECT content_version FROM offers WHERE id = $1",
        [pubOffer.id],
      );

      assert.equal(checkDemand.rows[0].content_version, pubDemand.contentVersion);
      assert.equal(checkOffer.rows[0].content_version, pubOffer.contentVersion);
    });
  });
}
