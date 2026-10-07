import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  archiveDemand,
  CatalogNotFoundError,
  createDemand,
  createOffer,
  createUser,
  getDemandById,
  getOfferById,
  updateOffer,
} from "../../lib/server/catalog";
import {
  CatalogExtractionPersistenceConflictError,
  CatalogExtractionValidationError,
  createCatalogExtractionProposal,
  extractCatalogProposal,
  getCatalogExtractionProposalById,
  listCatalogExtractionProposals,
} from "../../lib/server/catalog-extraction";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
} from "./test-database";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  test("pré-requis PostgreSQL dédié pour les propositions d'extraction", () => {
    assert.fail(
      "TEST_DATABASE_URL requis : aucun test de persistance d'extraction n'a été simulé.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour les propositions d'extraction", () => {
    throw configuredUrlError;
  });
} else {
  describe("propositions d'extraction catalogue persistées", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let schemaCleaned = false;

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      const migrations = await runMigrations(pool);
      assert.deepEqual(migrations.applied, [
        "0001_users_offers_demands",
        "0002_phone_otp_sessions",
        "0003_catalog_extraction_proposals",
        "0004_catalog_extraction_proposal_json_constraints",
        "0005_catalog_extraction_applications",
        "0006_matching_evaluations",
        "0007_matching_outbox_events",
        "0008_matching_jobs",
        "0009_matching_projection",
        "0010_matching_job_leases",
        "0011_offer_boosts",
        "0012_boost_pricing",
        "0013_boost_exposures",
        "0014_wallet_ledger",
        "0015_boost_purchases",
        "0016_boost_quote_reach",
        "0017_boost_quote_reach_truncated",
        "0018_offer_metrics",
        "0019_notifications",
        "0020_social_orders_admin",
      ]);
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        if (!schemaCleaned) {
          await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        }
        await adminPool.end();
      }
    });

    test("offres, demandes, preuves et valeurs humaines survivent à une reconnexion", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({
        ownerId: owner.id,
        rawText: "iPhone 12 ou iPhone 13 128 Go, quantité 2 à Cocody",
        model: "modèle saisi humainement",
        quantity: 7,
        price: { amount: 175_000, currency: "XOF" },
      }, pool);
      const demand = await createDemand({
        ownerId: owner.id,
        rawText: "Je cherche un canapé à Marcory, budget 200000 FCFA",
        category: "catégorie humaine",
        requirements: ["valeur humaine"],
      }, pool);

      const offerExtraction = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });
      const demandExtraction = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "demand",
        resourceId: demand.id,
      }, { pool });

      assert.equal(offerExtraction.provenance, "deterministic");
      assert.equal(offerExtraction.sourceRawText, offer.rawText);
      assert.equal(
        offerExtraction.sourceTextSha256,
        createHash("sha256").update(offer.rawText).digest("hex"),
      );
      assert.equal(offerExtraction.proposal.fields.model, null);
      assert.equal(offerExtraction.proposal.fields.deadlineAt, null);
      assert.ok(offerExtraction.evidence.some((item) => item.field === "quantity"));
      assert.ok(offerExtraction.ambiguities.some((item) => item.code === "multiple_models"));
      assert.deepEqual(offerExtraction.proposal.evidence, offerExtraction.evidence);
      assert.deepEqual(offerExtraction.proposal.ambiguities, offerExtraction.ambiguities);
      assert.equal(demandExtraction.proposal.type, "demand");
      assert.deepEqual(demandExtraction.proposal.fields.budget, {
        amount: 200_000,
        currency: "XOF",
      });

      const unchangedOffer = await getOfferById(owner.id, offer.id, pool);
      const unchangedDemand = await getDemandById(owner.id, demand.id, pool);
      assert.equal(unchangedOffer?.model, "modèle saisi humainement");
      assert.equal(unchangedOffer?.quantity, 7);
      assert.equal(unchangedOffer?.contentVersion, 1);
      assert.equal(unchangedDemand?.category, "catégorie humaine");
      assert.deepEqual(unchangedDemand?.requirements, ["valeur humaine"]);
      assert.equal(unchangedDemand?.contentVersion, 1);

      const reopened = await openVerifiedIsolatedPool(target, schema);
      try {
        const persisted = await getCatalogExtractionProposalById({
          ownerId: owner.id,
          proposalId: offerExtraction.id,
        }, reopened);
        assert.equal(persisted?.proposal.rawText, offer.rawText);
        assert.equal(persisted?.isStale, false);
        assert.ok(persisted?.ambiguities.some((item) => item.code === "multiple_models"));
        assert.equal(
          (await listCatalogExtractionProposals({
            ownerId: owner.id,
            resourceType: "demand",
            resourceId: demand.id,
          }, reopened))[0]?.id,
          demandExtraction.id,
        );
      } finally {
        await reopened.end();
      }
    });

    test("ressource étrangère et ressource absente restent indistinguables", async () => {
      const owner = await createUser({}, pool);
      const intruder = await createUser({}, pool);
      const offer = await createOffer({ ownerId: owner.id, rawText: "offre privée" }, pool);
      const persisted = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const capture = async (resourceId: string) => {
        try {
          await createCatalogExtractionProposal({
            ownerId: intruder.id,
            resourceType: "offer",
            resourceId,
          }, { pool });
          assert.fail("la création devait échouer");
        } catch (error) {
          assert.ok(error instanceof CatalogNotFoundError);
          return { name: error.name, message: error.message };
        }
      };
      assert.deepEqual(await capture(offer.id), await capture(randomUUID()));
      assert.equal(await getCatalogExtractionProposalById({
        ownerId: intruder.id,
        proposalId: persisted.id,
      }, pool), null);
      assert.deepEqual(await listCatalogExtractionProposals({
        ownerId: intruder.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, pool), []);
    });

    test("répétition et appels concurrents réutilisent une seule ligne", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({
        ownerId: owner.id,
        rawText: "Téléviseur 55 pouces à Cocody",
      }, pool);
      const pools = await Promise.all(
        Array.from({ length: 4 }, () => openVerifiedIsolatedPool(target, schema)),
      );
      try {
        const results = await Promise.all(pools.map((concurrentPool) =>
          createCatalogExtractionProposal({
            ownerId: owner.id,
            resourceType: "offer",
            resourceId: offer.id,
          }, { pool: concurrentPool })));
        assert.equal(new Set(results.map((item) => item.id)).size, 1);

        const repeated = await createCatalogExtractionProposal({
          ownerId: owner.id,
          resourceType: "offer",
          resourceId: offer.id,
        }, { pool });
        assert.equal(repeated.id, results[0].id);
        const count = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
          [offer.id],
        );
        assert.equal(count.rows[0].count, "1");
      } finally {
        await Promise.all(pools.map((concurrentPool) => concurrentPool.end()));
      }
    });

    test("modification et archivage pendant l'extraction produisent un conflit sans ligne", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({ ownerId: owner.id, rawText: "Table 6 places" }, pool);
      const offerReached = deferred();
      const offerRelease = deferred();
      const pendingOffer = createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, {
        pool,
        afterExtraction: async () => {
          offerReached.resolve();
          await offerRelease.promise;
        },
      });
      await offerReached.promise;
      await updateOffer({
        id: offer.id,
        ownerId: owner.id,
        expectedContentVersion: offer.contentVersion,
        changes: { rawText: "Table 8 places" },
      }, pool);
      offerRelease.resolve();
      await assert.rejects(pendingOffer, CatalogExtractionPersistenceConflictError);

      const demand = await createDemand({ ownerId: owner.id, rawText: "Canapé à Cocody" }, pool);
      const demandReached = deferred();
      const demandRelease = deferred();
      const pendingDemand = createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "demand",
        resourceId: demand.id,
      }, {
        pool,
        afterExtraction: async () => {
          demandReached.resolve();
          await demandRelease.promise;
        },
      });
      await demandReached.promise;
      await archiveDemand(owner.id, demand.id, demand.contentVersion, pool);
      demandRelease.resolve();
      await assert.rejects(pendingDemand, CatalogExtractionPersistenceConflictError);

      const counts = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM catalog_extraction_proposals
          WHERE offer_id = $1 OR demand_id = $2`,
        [offer.id, demand.id],
      );
      assert.equal(counts.rows[0].count, "0");
    });

    test("l'historique signale explicitement les propositions obsolètes", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({ ownerId: owner.id, rawText: "iPhone 12 128 Go" }, pool);
      const first = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });
      const updated = await updateOffer({
        id: offer.id,
        ownerId: owner.id,
        expectedContentVersion: offer.contentVersion,
        changes: { rawText: "iPhone 13 256 Go" },
      }, pool);
      const second = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });
      assert.equal(updated.contentVersion, 2);
      assert.notEqual(first.id, second.id);

      const history = await listCatalogExtractionProposals({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, pool);
      assert.deepEqual(history.map((item) => item.sourceContentVersion), [2, 1]);
      assert.deepEqual(history.map((item) => item.isStale), [false, true]);
      assert.equal((await getCatalogExtractionProposalById({
        ownerId: owner.id,
        proposalId: first.id,
      }, pool))?.isStale, true);
    });

    test("un échec d'extraction ne laisse aucune écriture partielle", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({ ownerId: owner.id, rawText: "x".repeat(10_001) }, pool);
      await assert.rejects(
        createCatalogExtractionProposal({
          ownerId: owner.id,
          resourceType: "offer",
          resourceId: offer.id,
        }, { pool }),
        CatalogExtractionValidationError,
      );
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
        [offer.id],
      );
      assert.equal(count.rows[0].count, "0");
    });

    test("contraintes CHECK JSON : rejet direct INSERT/UPDATE des propriétés absentes, null, mauvais types et incohérences", async () => {
      const owner = await createUser({}, pool);
      const offer = await createOffer({ ownerId: owner.id, rawText: "iPhone 12 128 Go" }, pool);
      const demand = await createDemand({ ownerId: owner.id, rawText: "Je cherche un iPhone 12" }, pool);
      const validOfferProposal = await extractCatalogProposal({ type: "offer", rawText: offer.rawText });
      const validDemandProposal = await extractCatalogProposal({ type: "demand", rawText: demand.rawText });

      interface InsertOverrides {
        offer_id?: string | null;
        demand_id?: string | null;
        source_content_version?: number;
        source_raw_text?: string;
        contract_version?: string;
        extractor_version?: string;
        provenance?: string;
        evidence?: unknown;
        ambiguities?: unknown;
      }

      const tryInsert = async (proposal: unknown, overrides: InsertOverrides = {}) => {
        const id = randomUUID();
        const client = await pool.connect();
        try {
          const isDemand = overrides.demand_id !== undefined && overrides.demand_id !== null;
          const defaultResource = isDemand ? demand : offer;
          const rawText = overrides.source_raw_text ?? defaultResource.rawText;
          const contentVersion = overrides.source_content_version ?? defaultResource.contentVersion;
          const hash = createHash("sha256").update(rawText).digest("hex");

          await client.query("BEGIN");
          await client.query(
            `INSERT INTO catalog_extraction_proposals (
               id, offer_id, demand_id, source_content_version, source_raw_text,
               source_text_sha256, contract_version, extractor_version, provenance,
               proposal, evidence, ambiguities
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
            [
              id,
              overrides.offer_id !== undefined ? overrides.offer_id : (isDemand ? null : offer.id),
              overrides.demand_id !== undefined ? overrides.demand_id : (isDemand ? demand.id : null),
              contentVersion,
              rawText,
              hash,
              overrides.contract_version ?? validOfferProposal.contractVersion,
              overrides.extractor_version ?? validOfferProposal.extractorVersion,
              overrides.provenance ?? validOfferProposal.provenance,
              JSON.stringify(proposal),
              JSON.stringify(overrides.evidence ?? (proposal as { evidence?: unknown })?.evidence ?? []),
              JSON.stringify(overrides.ambiguities ?? (proposal as { ambiguities?: unknown })?.ambiguities ?? []),
            ],
          );
          await client.query("COMMIT");
          return { ok: true, id };
        } catch (error) {
          await client.query("ROLLBACK");
          return { ok: false, error };
        } finally {
          client.release();
        }
      };

      // 1. Propriétés obligatoires absentes
      for (const key of ["type", "rawText", "contractVersion", "extractorVersion", "provenance", "fields"]) {
        const candidate = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
        delete candidate[key];
        const res = await tryInsert(candidate);
        assert.equal(res.ok, false, `La propriété absente "${key}" doit être rejetée`);
      }

      // 2. Propriétés obligatoires valant null JSON
      for (const key of ["type", "rawText", "contractVersion", "extractorVersion", "provenance", "fields"]) {
        const candidate = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
        candidate[key] = null;
        const res = await tryInsert(candidate);
        assert.equal(res.ok, false, `La propriété "${key}" valant null doit être rejetée`);
      }

      // 3. Mauvais types scalaires
      for (const key of ["type", "rawText", "contractVersion", "extractorVersion", "provenance"]) {
        for (const badValue of [123, true, [], {}]) {
          const candidate = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
          candidate[key] = badValue;
          const res = await tryInsert(candidate);
          assert.equal(res.ok, false, `Le type non-chaîne pour "${key}" (${JSON.stringify(badValue)}) doit être rejeté`);
        }
      }

      // 4. Mauvais types pour fields (doit être un objet JSON)
      for (const badValue of ["chaine", 42, true, [1, 2]]) {
        const candidate = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
        candidate.fields = badValue;
        const res = await tryInsert(candidate);
        assert.equal(res.ok, false, `Le type non-objet pour fields (${JSON.stringify(badValue)}) doit être rejeté`);
      }

      // 5. Incohérences
      // a) type demand avec offer_id
      const mismatchedType = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      mismatchedType.type = "demand";
      assert.equal((await tryInsert(mismatchedType)).ok, false, "Incohérence type/ressource doit être rejetée");

      // b) type offer avec demand_id
      const mismatchedDemand = structuredClone(validDemandProposal) as unknown as Record<string, unknown>;
      mismatchedDemand.type = "offer";
      assert.equal((await tryInsert(mismatchedDemand, { offer_id: null, demand_id: demand.id })).ok, false, "Incohérence type/ressource doit être rejetée");

      // c) rawText divergent
      const mismatchedRaw = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      mismatchedRaw.rawText = "Autre texte";
      assert.equal((await tryInsert(mismatchedRaw)).ok, false, "Divergence rawText doit être rejetée");

      // d) contractVersion divergente
      const mismatchedContract = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      mismatchedContract.contractVersion = "v99";
      assert.equal((await tryInsert(mismatchedContract)).ok, false, "Divergence contractVersion doit être rejetée");

      // e) extractorVersion divergente
      const mismatchedExtractor = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      mismatchedExtractor.extractorVersion = "v99";
      assert.equal((await tryInsert(mismatchedExtractor)).ok, false, "Divergence extractorVersion doit être rejetée");

      // f) provenance divergente
      const mismatchedProvenance = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      mismatchedProvenance.provenance = "ai";
      assert.equal((await tryInsert(mismatchedProvenance)).ok, false, "Divergence provenance doit être rejetée");

      // 6. Valeurs null légitimes dans fields
      const validNullFieldsOffer = structuredClone(validOfferProposal) as unknown as Record<string, unknown>;
      validNullFieldsOffer.fields = {
        category: null,
        brand: null,
        model: null,
        variant: null,
        attributes: null,
        condition: null,
        quantity: null,
        location: null,
        deadlineAt: null,
        price: null,
      };
      const resNullOffer = await tryInsert(validNullFieldsOffer);
      assert.equal(resNullOffer.ok, true, "Les valeurs null légitimes dans fields offre doivent être acceptées");

      const validNullFieldsDemand = structuredClone(validDemandProposal) as unknown as Record<string, unknown>;
      validNullFieldsDemand.fields = {
        category: null,
        brand: null,
        model: null,
        variant: null,
        attributes: null,
        condition: null,
        quantity: null,
        location: null,
        deadlineAt: null,
        budget: null,
        requirements: null,
        preferences: null,
      };
      const resNullDemand = await tryInsert(validNullFieldsDemand, { offer_id: null, demand_id: demand.id });
      assert.equal(resNullDemand.ok, true, "Les valeurs null légitimes dans fields demande doivent être acceptées");

      // 7. Vérifications directes sur UPDATE
      const targetId = resNullOffer.id!;
      const tryUpdateProposal = async (id: string, updatedProposal: unknown) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "UPDATE catalog_extraction_proposals SET proposal = $1::jsonb WHERE id = $2",
            [JSON.stringify(updatedProposal), id],
          );
          await client.query("COMMIT");
          return { ok: true };
        } catch (error) {
          await client.query("ROLLBACK");
          return { ok: false, error };
        } finally {
          client.release();
        }
      };

      // UPDATE invalide : suppression de champ obligatoire
      const updateWithoutRaw = structuredClone(validNullFieldsOffer);
      delete (updateWithoutRaw as unknown as Record<string, unknown>).rawText;
      assert.equal((await tryUpdateProposal(targetId, updateWithoutRaw)).ok, false, "UPDATE supprimant rawText doit être rejeté");

      // UPDATE invalide : fields null
      const updateNullFields = structuredClone(validNullFieldsOffer);
      (updateNullFields as unknown as Record<string, unknown>).fields = null;
      assert.equal((await tryUpdateProposal(targetId, updateNullFields)).ok, false, "UPDATE avec fields: null doit être rejeté");

      // UPDATE invalide : fields chaîne
      const updateBadFieldsType = structuredClone(validNullFieldsOffer);
      (updateBadFieldsType as unknown as Record<string, unknown>).fields = "invalid";
      assert.equal((await tryUpdateProposal(targetId, updateBadFieldsType)).ok, false, "UPDATE avec fields de type chaîne doit être rejeté");

      // UPDATE invalide : incohérence de type
      const updateBadType = structuredClone(validNullFieldsOffer);
      (updateBadType as unknown as Record<string, unknown>).type = "demand";
      assert.equal((await tryUpdateProposal(targetId, updateBadType)).ok, false, "UPDATE avec incohérence de type doit être rejeté");

      // UPDATE valide
      const validUpdate = structuredClone(validNullFieldsOffer);
      (validUpdate.fields as unknown as Record<string, unknown>).brand = "Apple";
      assert.equal((await tryUpdateProposal(targetId, validUpdate)).ok, true, "UPDATE avec proposition valide doit être accepté");
    });

    test("la migration 0004 échoue explicitement si des données invalides préexistent", async () => {
      const corruptSchema = createTemporarySchemaName();
      const quotedCorruptSchema = quoteTemporarySchema(corruptSchema);
      let corruptPool: Pool | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${quotedCorruptSchema}`);
        corruptPool = await openVerifiedIsolatedPool(target, corruptSchema);

        const fs = await import("node:fs");
        const path = await import("node:path");
        const migrationsDir = path.resolve("database/migrations");
        await corruptPool.query(fs.readFileSync(path.join(migrationsDir, "0001_users_offers_demands.sql"), "utf8"));
        await corruptPool.query(fs.readFileSync(path.join(migrationsDir, "0002_phone_otp_sessions.sql"), "utf8"));
        await corruptPool.query(fs.readFileSync(path.join(migrationsDir, "0003_catalog_extraction_proposals.sql"), "utf8"));

        const owner = await createUser({}, corruptPool);
        const offer = await createOffer({ ownerId: owner.id, rawText: "iPhone 12 128 Go" }, corruptPool);

        await corruptPool.query(
          `INSERT INTO catalog_extraction_proposals (
             id, offer_id, source_content_version, source_raw_text, source_text_sha256,
             contract_version, extractor_version, provenance, proposal, evidence, ambiguities
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)`,
          [
            randomUUID(),
            offer.id,
            offer.contentVersion,
            offer.rawText,
            createHash("sha256").update(offer.rawText).digest("hex"),
            "catalog-extraction/v1",
            "noma-deterministic/v1",
            "deterministic",
            JSON.stringify({ evidence: [], ambiguities: [] }),
            "[]",
            "[]",
          ],
        );

        const migration0004Sql = fs.readFileSync(path.join(migrationsDir, "0004_catalog_extraction_proposal_json_constraints.sql"), "utf8");
        await assert.rejects(
          corruptPool.query(migration0004Sql),
          /catalog_extraction_proposals_proposal_type_check/,
          "La migration 0004 doit échouer sur des données préexistantes invalides",
        );

        const constraints = await corruptPool.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint c
             JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = $1 AND conname = 'catalog_extraction_proposals_proposal_type_check'`,
          [corruptSchema],
        );
        assert.equal(constraints.rowCount, 0);

        const row = await corruptPool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
          [offer.id],
        );
        assert.equal(row.rows[0].count, "1");
      } finally {
        if (corruptPool) await corruptPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedCorruptSchema} CASCADE`);
      }
    });

    test("le nettoyage reste limité au schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      const remaining = await adminPool.query<{ name: string | null }>(
        "SELECT to_regnamespace($1)::text AS name",
        [schema],
      );
      assert.equal(remaining.rows[0].name, null);
    });
  });
}
