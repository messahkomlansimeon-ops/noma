import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import {
  archiveOffer,
  CatalogNotFoundError,
  createDemand,
  createOffer,
  createUser,
  getDemandById,
  getOfferById,
  StaleContentVersionError,
  updateOffer,
} from "../../lib/server/catalog";
import {
  applyCatalogExtractionProposal,
  CatalogExtractionApplicationConflictError,
  CatalogExtractionApplicationValidationError,
  CatalogExtractionProposalAttachmentError,
  createCatalogExtractionProposal,
  getCatalogExtractionApplicationById,
  getCatalogExtractionApplicationByIdempotencyKey,
  listCatalogExtractionApplications,
  StaleCatalogExtractionProposalError,
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

async function waitForLock(
  admin: Pool,
  targetPid: number,
  blockerPid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const res = await admin.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1)::int[] AS blockers",
      [targetPid],
    );
    if (res.rows[0]?.blockers?.includes(blockerPid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return false;
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
  test("pré-requis PostgreSQL dédié pour l'application d'extraction", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test d'application n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour l'application d'extraction", () => {
    throw configuredUrlError;
  });
} else {
  describe("application explicite de propositions d'extraction (Lot 1E4)", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let secondPool: Pool;
    let schemaCleaned = false;

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      secondPool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
    });

    after(async () => {
      if (pool) await pool.end();
      if (secondPool) await secondPool.end();
      if (adminPool) {
        if (!schemaCleaned) {
          await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        }
        await adminPool.end();
      }
    });

    test("application réussie sur offre et demande avec conversion exacte et reçu durable", async () => {
      const user = await createUser({}, pool);

      // 1. Offre : extraction complète
      const offer = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 128 Go à Cocody, prix 150000 FCFA, disponible avant le 15 décembre 2026",
      }, pool);

      const offerProposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const offerReceipt = await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
        proposalId: offerProposal.id,
        expectedContentVersion: 1,
        selection: {
          fields: ["model", "category", "price", "location"],
          attributeKeys: ["storage_capacity"],
        },
        idempotencyKey: "idem_offer_1",
      }, { pool });

      assert.equal(offerReceipt.ownerId, user.id);
      assert.equal(offerReceipt.resourceType, "offer");
      assert.equal(offerReceipt.resourceId, offer.id);
      assert.equal(offerReceipt.proposalId, offerProposal.id);
      assert.equal(offerReceipt.versionBefore, 1);
      assert.equal(offerReceipt.versionAfter, 2);
      assert.equal(offerReceipt.idempotencyKey, "idem_offer_1");
      assert.ok(offerReceipt.appliedAt instanceof Date);

      // Vérification des valeurs mises à jour en base
      const updatedOffer = await getOfferById(user.id, offer.id, pool);
      assert.ok(updatedOffer);
      assert.equal(updatedOffer.contentVersion, 2);
      assert.equal(updatedOffer.model, "iphone 12");
      assert.equal(updatedOffer.category, "phones");
      assert.deepEqual(updatedOffer.price, { amount: 150_000, currency: "XOF" });
      assert.equal(updatedOffer.location, "cocody");
      assert.deepEqual(updatedOffer.attributes, {
        storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
      });

      // 2. Demande : extraction et application des critères / budget
      const demand = await createDemand({
        ownerId: user.id,
        rawText: "Cherche iPhone 12 64 Go à Cocody avec budget 120000 FCFA",
      }, pool);

      const demandProposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "demand",
        resourceId: demand.id,
      }, { pool });

      const demandReceipt = await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "demand",
        resourceId: demand.id,
        proposalId: demandProposal.id,
        expectedContentVersion: 1,
        selection: ["model", "budget", "attributes:storage_capacity"],
        idempotencyKey: "idem_demand_1",
      }, { pool });

      assert.equal(demandReceipt.versionBefore, 1);
      assert.equal(demandReceipt.versionAfter, 2);

      const updatedDemand = await getDemandById(user.id, demand.id, pool);
      assert.ok(updatedDemand);
      assert.equal(updatedDemand.contentVersion, 2);
      assert.equal(updatedDemand.model, "iphone 12");
      assert.deepEqual(updatedDemand.budget, { amount: 120_000, currency: "XOF" });
      assert.deepEqual(updatedDemand.attributes, {
        storage_capacity: { value: 64, unit: "GB", sourceUnit: "Go" },
      });
    });

    test("préservation stricte des valeurs humaines existantes et des attributs non sélectionnés", async () => {
      const user = await createUser({}, pool);

      const offer = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 256 Go à Marcory",
        brand: "Apple saisi par humain",
        condition: "comme neuf",
        quantity: 5,
        attributes: {
          couleur: "bleu",
          etat_batterie: "98%",
        },
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      // On applique SEULEMENT model et l'attribut storage_capacity
      await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
        proposalId: proposal.id,
        expectedContentVersion: 1,
        selection: {
          fields: ["model"],
          attributeKeys: ["storage_capacity"],
        },
        idempotencyKey: "idem_preserve_human",
      }, { pool });

      const reloaded = await getOfferById(user.id, offer.id, pool);
      assert.ok(reloaded);
      assert.equal(reloaded.contentVersion, 2);
      // Champ appliqué
      assert.equal(reloaded.model, "iphone 12");
      // Valeurs humaines strictement conservées
      assert.equal(reloaded.brand, "Apple saisi par humain");
      assert.equal(reloaded.condition, "comme neuf");
      assert.equal(reloaded.quantity, 5);
      assert.equal(reloaded.rawText, "iPhone 12 256 Go à Marcory");
      // Attributs existants conservés avec fusion de la nouvelle clé
      assert.deepEqual(reloaded.attributes, {
        couleur: "bleu",
        etat_batterie: "98%",
        storage_capacity: { value: 256, unit: "GB", sourceUnit: "Go" },
      });
    });

    test("propriétaire et confidentialité : 404 indistinguable entre ressource étrangère et inexistante", async () => {
      const owner = await createUser({}, pool);
      const stranger = await createUser({}, pool);

      const offer = await createOffer({
        ownerId: owner.id,
        rawText: "iPhone 12 128 Go",
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const absentId = randomUUID();

      // Ressource appartenant à un tiers
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: stranger.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_foreign",
        }, { pool }),
        (error) => error instanceof CatalogNotFoundError,
      );

      // Ressource inexistante
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: stranger.id,
          resourceType: "offer",
          resourceId: absentId,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_absent",
        }, { pool }),
        (error) => error instanceof CatalogNotFoundError,
      );
    });

    test("mauvais rattachement : refus si la proposition n'appartient pas à la ressource", async () => {
      const user = await createUser({}, pool);

      const offerA = await createOffer({ ownerId: user.id, rawText: "iPhone 12" }, pool);
      const offerB = await createOffer({ ownerId: user.id, rawText: "iPhone 13" }, pool);

      const proposalA = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerA.id,
      }, { pool });

      // Tentative d'appliquer proposalA sur offerB
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerB.id,
          proposalId: proposalA.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_bad_attachment_1",
        }, { pool }),
        (error) => error instanceof CatalogExtractionProposalAttachmentError,
      );

      // Tentative d'appliquer une proposition d'offre sur une demande
      const demand = await createDemand({ ownerId: user.id, rawText: "iPhone 12" }, pool);
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "demand",
          resourceId: demand.id,
          proposalId: proposalA.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_bad_attachment_2",
        }, { pool }),
        (error) => error instanceof CatalogExtractionProposalAttachmentError,
      );
    });

    test("sélections invalides et champs interdits", async () => {
      const user = await createUser({}, pool);
      const offer = await createOffer({ ownerId: user.id, rawText: "iPhone 12" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      // 1. rawText interdit
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["rawText"],
          idempotencyKey: "idem_forbidden_rawtext",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError &&
                   error.message.includes("interdit"),
      );

      // 2. Champs techniques interdits (status, id, contentVersion)
      for (const field of ["status", "id", "contentVersion", "ownerId"]) {
        await assert.rejects(
          () => applyCatalogExtractionProposal({
            ownerId: user.id,
            resourceType: "offer",
            resourceId: offer.id,
            proposalId: proposal.id,
            expectedContentVersion: 1,
            selection: [field],
            idempotencyKey: `idem_forbidden_${field}`,
          }, { pool }),
          (error) => error instanceof CatalogExtractionApplicationValidationError,
        );
      }

      // 3. Champ inconnu
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["champ_inconnu"],
          idempotencyKey: "idem_unknown_field",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError,
      );

      // 4. Champ de demande (budget) sur une offre
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["budget"],
          idempotencyKey: "idem_demand_on_offer",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError,
      );

      // 5. Sélection vide
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: [],
          idempotencyKey: "idem_empty_selection",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError,
      );
    });

    test("refus des valeurs inconnues/nulles et des ambiguïtés", async () => {
      const user = await createUser({}, pool);

      // 1. Champ absent/null dans la proposition
      const offer1 = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12", // pas de prix, pas de condition, pas de variante
      }, pool);
      const proposal1 = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer1.id,
      }, { pool });

      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer1.id,
          proposalId: proposal1.id,
          expectedContentVersion: 1,
          selection: ["variant"],
          idempotencyKey: "idem_null_val",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError &&
                   error.message.includes("absent"),
      );

      // 2. Clé d'attribut inexistante
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer1.id,
          proposalId: proposal1.id,
          expectedContentVersion: 1,
          selection: { attributeKeys: ["cle_inexistante"] },
          idempotencyKey: "idem_unknown_attr",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError &&
                   error.message.includes("absent"),
      );

      // 3. Montant sans devise : refus d'impliciter XOF
      const offerNoCurr = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 à 150000", // montant sans devise
      }, pool);
      const proposalNoCurr = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerNoCurr.id,
      }, { pool });

      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerNoCurr.id,
          proposalId: proposalNoCurr.id,
          expectedContentVersion: 1,
          selection: ["price"],
          idempotencyKey: "idem_no_currency",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError &&
                   (error.message.includes("devise") || error.message.includes("ambiguïtés")),
      );

      // 4. Ambiguïté d'attributs multiples : "iPhone 12 64 Go ou 128 Go"
      const offerAmbiguous = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 64 Go ou 128 Go",
      }, pool);
      const proposalAmbiguous = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerAmbiguous.id,
      }, { pool });

      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerAmbiguous.id,
          proposalId: proposalAmbiguous.id,
          expectedContentVersion: 1,
          selection: { attributeKeys: ["storage_capacity"] },
          idempotencyKey: "idem_ambiguity",
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationValidationError &&
                   error.message.includes("ambiguïtés"),
      );
    });

    test("obsolescence et archivage : refus sous verrou", async () => {
      const user = await createUser({}, pool);

      const offer = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 128 Go",
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      // 1. Ressource modifiée entre-temps (version 1 -> 2)
      await updateOffer({
        id: offer.id,
        ownerId: user.id,
        expectedContentVersion: 1,
        changes: { rawText: "iPhone 12 256 Go mis à jour" },
      }, pool);

      // Avec expectedContentVersion: 1 -> StaleContentVersionError
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_stale_ver",
        }, { pool }),
        (error) => error instanceof StaleContentVersionError,
      );

      // Avec expectedContentVersion: 2 -> StaleCatalogExtractionProposalError (la proposition est obsolète)
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 2,
          selection: ["model"],
          idempotencyKey: "idem_stale_prop",
        }, { pool }),
        (error) => error instanceof StaleCatalogExtractionProposalError,
      );

      // 2. Ressource archivée
      const offerArchived = await createOffer({ ownerId: user.id, rawText: "Vélo course" }, pool);
      const propArchived = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerArchived.id,
      }, { pool });

      await archiveOffer(user.id, offerArchived.id, 1, pool);

      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerArchived.id,
          proposalId: propArchived.id,
          expectedContentVersion: 2,
          selection: ["model"],
          idempotencyKey: "idem_archived",
        }, { pool }),
        (error) => error instanceof StaleContentVersionError || error instanceof Error,
      );
    });

    test("aucun changement effectif : égalité structurelle JSONB sur offres/demandes, pas d'incrémentation de version ni modification d'updated_at", async () => {
      const user = await createUser({}, pool);

      // 1. Offre avec attributs JSONB identiques mais propriétés réordonnées
      const offer = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 128 Go",
        attributes: {
          storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
          couleur: "noir",
        },
      }, pool);

      const offerProposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const offerBefore = await getOfferById(user.id, offer.id, pool);
      assert.ok(offerBefore);

      const offerReceipt = await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
        proposalId: offerProposal.id,
        expectedContentVersion: 1,
        selection: { attributeKeys: ["storage_capacity"] },
        idempotencyKey: "idem_noop_offer_jsonb",
      }, { pool });

      assert.equal(offerReceipt.versionBefore, 1);
      assert.equal(offerReceipt.versionAfter, 1);
      assert.deepEqual(offerReceipt.changes, {});

      const offerAfter = await getOfferById(user.id, offer.id, pool);
      assert.ok(offerAfter);
      assert.equal(offerAfter.contentVersion, 1);
      assert.equal(offerAfter.updatedAt.getTime(), offerBefore.updatedAt.getTime(), "updatedAt ne doit pas changer lors d'un no-op");
      assert.equal(isDeepStrictEqual(offerBefore.attributes, offerAfter.attributes), true);

      // 2. Demande avec attributs JSONB identiques
      const demand = await createDemand({
        ownerId: user.id,
        rawText: "Cherche iPhone 12 128 Go",
        attributes: {
          storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
          couleur: "noir",
        },
      }, pool);

      const demandProposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "demand",
        resourceId: demand.id,
      }, { pool });

      const demandBefore = await getDemandById(user.id, demand.id, pool);
      assert.ok(demandBefore);

      const demandReceipt = await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "demand",
        resourceId: demand.id,
        proposalId: demandProposal.id,
        expectedContentVersion: 1,
        selection: { attributeKeys: ["storage_capacity"] },
        idempotencyKey: "idem_noop_demand_jsonb",
      }, { pool });

      assert.equal(demandReceipt.versionBefore, 1);
      assert.equal(demandReceipt.versionAfter, 1);
      assert.deepEqual(demandReceipt.changes, {});

      const demandAfter = await getDemandById(user.id, demand.id, pool);
      assert.ok(demandAfter);
      assert.equal(demandAfter.contentVersion, 1);
      assert.equal(demandAfter.updatedAt.getTime(), demandBefore.updatedAt.getTime(), "updatedAt ne doit pas changer lors d'un no-op");
      assert.equal(isDeepStrictEqual(demandBefore.attributes, demandAfter.attributes), true);

      // 3. Différence réelle : un changement réel sur attribut JSONB doit être appliqué
      const offerDiff = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 128 Go",
        attributes: {
          storage_capacity: { value: 64, unit: "GB", sourceUnit: "Go" }, // 64 Go au lieu de 128 Go
        },
      }, pool);

      const offerDiffProposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerDiff.id,
      }, { pool });

      const diffReceipt = await applyCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerDiff.id,
        proposalId: offerDiffProposal.id,
        expectedContentVersion: 1,
        selection: { attributeKeys: ["storage_capacity"] },
        idempotencyKey: "idem_diff_offer_jsonb",
      }, { pool });

      assert.equal(diffReceipt.versionBefore, 1);
      assert.equal(diffReceipt.versionAfter, 2);
      assert.ok(diffReceipt.changes.attributes);

      const offerDiffAfter = await getOfferById(user.id, offerDiff.id, pool);
      assert.ok(offerDiffAfter);
      assert.equal(offerDiffAfter.contentVersion, 2);
      assert.deepEqual(offerDiffAfter.attributes, {
        storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
      });
    });

    test("idempotence stricte : même clé retourne le reçu, clé avec requête différente lève un conflit", async () => {
      const user = await createUser({}, pool);

      const offer = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const input = {
        ownerId: user.id,
        resourceType: "offer" as const,
        resourceId: offer.id,
        proposalId: proposal.id,
        expectedContentVersion: 1,
        selection: ["model", "category"],
        idempotencyKey: "idem_repeatable_key",
      };

      // Premier appel
      const first = await applyCatalogExtractionProposal(input, { pool });
      assert.equal(first.versionAfter, 2);

      // Second appel avec la même clé et les mêmes paramètres
      const second = await applyCatalogExtractionProposal(input, { pool });
      assert.deepEqual(second, first);

      // Vérification : un seul reçu en base pour cette clé
      const applications = await listCatalogExtractionApplications(user.id, "offer", offer.id, pool);
      assert.equal(applications.length, 1);

      // Troisième appel avec la MÊME clé mais des paramètres différents (ex: selection différente)
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ...input,
          selection: ["model"], // différent
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationConflictError,
      );

      // Quatrième appel avec la MÊME clé mais version attendue différente
      await assert.rejects(
        () => applyCatalogExtractionProposal({
          ...input,
          expectedContentVersion: 2, // différent
        }, { pool }),
        (error) => error instanceof CatalogExtractionApplicationConflictError,
      );

      // Lecture par identifiant et par clé d'idempotence
      const readById = await getCatalogExtractionApplicationById(user.id, first.id, pool);
      assert.deepEqual(readById, first);

      const readByKey = await getCatalogExtractionApplicationByIdempotencyKey(
        user.id,
        "idem_repeatable_key",
        pool,
      );
      assert.deepEqual(readByKey, first);
    });

    test("rollback intégral : une erreur annule toute écriture catalogue et reçu", async () => {
      const user = await createUser({}, pool);

      const offer = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      // Déclenchement d'une erreur pendant l'application
      await assert.rejects(
        () => applyCatalogExtractionProposal(
          {
            ownerId: user.id,
            resourceType: "offer",
            resourceId: offer.id,
            proposalId: proposal.id,
            expectedContentVersion: 1,
            selection: ["model"],
            idempotencyKey: "idem_rollback_test",
          },
          {
            pool,
            beforeUpdate: async () => {
              throw new Error("Panne transactionnelle simulée");
            },
          },
        ),
        (error: Error) => error.message === "Panne transactionnelle simulée",
      );

      // Vérification : l'offre est restée intacte
      const offerDb = await getOfferById(user.id, offer.id, pool);
      assert.equal(offerDb?.contentVersion, 1);
      assert.equal(offerDb?.model, null);

      // Aucun reçu persisté
      const receipt = await getCatalogExtractionApplicationByIdempotencyKey(
        user.id,
        "idem_rollback_test",
        pool,
      );
      assert.equal(receipt, null);
    });

    test("concurrence synchronisée : deux connexions PostgreSQL distinctes sous même clé (avec modification et noop)", async () => {
      const user = await createUser({}, pool);
      const firstPid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await secondPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.notEqual(firstPid, secondPid, "Les deux pools doivent utiliser des connexions distinctes");

      // 1. Cas avec modification effective : Tx1 change version 1 -> 2, Tx2 attend et réutilise le reçu
      const offerChange = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const proposalChange = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerChange.id,
      }, { pool });

      const inputChange = {
        ownerId: user.id,
        resourceType: "offer" as const,
        resourceId: offerChange.id,
        proposalId: proposalChange.id,
        expectedContentVersion: 1,
        selection: ["model"],
        idempotencyKey: "idem_concurrent_same_key_change",
      };

      const tx1ReachedChange = deferred();
      const tx1ReleaseChange = deferred();

      const runTx1Change = applyCatalogExtractionProposal(inputChange, {
        pool,
        beforeUpdate: async () => {
          tx1ReachedChange.resolve();
          await tx1ReleaseChange.promise;
        },
      });

      await tx1ReachedChange.promise;

      // Tx2 démarre sur secondPool pendant que Tx1 détient le verrou transactionnel
      const runTx2Change = applyCatalogExtractionProposal(inputChange, { pool: secondPool });

      const lockObservedChange = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(lockObservedChange, true, "Tx2 doit être bloquée par Tx1 sur le verrou transactionnel");

      // On débloque Tx1
      tx1ReleaseChange.resolve();

      const [res1Change, res2Change] = await Promise.all([runTx1Change, runTx2Change]);

      assert.equal(res1Change.id, res2Change.id, "Même clé simultanée : même reçu retourné");
      assert.equal(res1Change.versionBefore, 1);
      assert.equal(res1Change.versionAfter, 2);

      const countChange = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2",
        [user.id, inputChange.idempotencyKey],
      );
      assert.equal(countChange.rows[0].count, "1", "Une seule application enregistrée");

      const offerDbChange = await getOfferById(user.id, offerChange.id, pool);
      assert.equal(offerDbChange?.contentVersion, 2);
      assert.equal(offerDbChange?.model, "iphone 12");

      // 2. Cas sans modification effective (noop) : Tx1 ne modifie pas la version, Tx2 attend et réutilise le reçu
      const offerNoop = await createOffer({
        ownerId: user.id,
        rawText: "iPhone 12 128 Go",
        model: "iphone 12",
      }, pool);
      const proposalNoop = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerNoop.id,
      }, { pool });

      const inputNoop = {
        ownerId: user.id,
        resourceType: "offer" as const,
        resourceId: offerNoop.id,
        proposalId: proposalNoop.id,
        expectedContentVersion: 1,
        selection: ["model"],
        idempotencyKey: "idem_concurrent_same_key_noop",
      };

      const tx1ReachedNoop = deferred();
      const tx1ReleaseNoop = deferred();

      const runTx1Noop = applyCatalogExtractionProposal(inputNoop, {
        pool,
        beforeUpdate: async () => {
          tx1ReachedNoop.resolve();
          await tx1ReleaseNoop.promise;
        },
      });

      await tx1ReachedNoop.promise;

      const runTx2Noop = applyCatalogExtractionProposal(inputNoop, { pool: secondPool });

      const lockObservedNoop = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(lockObservedNoop, true, "Tx2 noop doit être bloquée par Tx1");

      tx1ReleaseNoop.resolve();

      const [res1Noop, res2Noop] = await Promise.all([runTx1Noop, runTx2Noop]);

      assert.equal(res1Noop.id, res2Noop.id, "Même reçu retourné sans modification");
      assert.equal(res1Noop.versionBefore, 1);
      assert.equal(res1Noop.versionAfter, 1);
      assert.deepEqual(res1Noop.changes, {});

      const countNoop = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2",
        [user.id, inputNoop.idempotencyKey],
      );
      assert.equal(countNoop.rows[0].count, "1", "Une seule ligne de reçu enregistrée");

      const offerDbNoop = await getOfferById(user.id, offerNoop.id, pool);
      assert.equal(offerDbNoop?.contentVersion, 1);
    });

    test("concurrence synchronisée : requêtes différentes sous même clé (même ressource et ressources différentes du même propriétaire)", async () => {
      const user = await createUser({}, pool);
      const firstPid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await secondPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

      // 1. Même ressource mais sélections différentes
      const offer = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const tx1ReachedDiff = deferred();
      const tx1ReleaseDiff = deferred();

      const runTx1 = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_concurrent_diff_req",
        },
        {
          pool,
          beforeUpdate: async () => {
            tx1ReachedDiff.resolve();
            await tx1ReleaseDiff.promise;
          },
        },
      );

      await tx1ReachedDiff.promise;

      // Tx2 démarre sur secondPool avec la même clé mais sélection divergente
      const runTx2 = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["category"],
          idempotencyKey: "idem_concurrent_diff_req",
        },
        { pool: secondPool },
      );

      const lockObserved = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(lockObserved, true);

      tx1ReleaseDiff.resolve();

      const [res1, res2Result] = await Promise.allSettled([runTx1, runTx2]);

      assert.equal(res1.status, "fulfilled");
      assert.equal(res2Result.status, "rejected");
      assert.ok(
        (res2Result as PromiseRejectedResult).reason instanceof CatalogExtractionApplicationConflictError,
        "Requête différente sous même clé doit échouer avec CatalogExtractionApplicationConflictError",
      );

      // 2. Ressources différentes appartenant au même propriétaire sous la même clé d'idempotence
      const offerA = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const offerB = await createOffer({ ownerId: user.id, rawText: "Samsung Galaxy S21" }, pool);
      const proposalA = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerA.id,
      }, { pool });
      const proposalB = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offerB.id,
      }, { pool });

      const tx1ReachedMulti = deferred();
      const tx1ReleaseMulti = deferred();

      const runTxA = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerA.id,
          proposalId: proposalA.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_concurrent_diff_res",
        },
        {
          pool,
          beforeUpdate: async () => {
            tx1ReachedMulti.resolve();
            await tx1ReleaseMulti.promise;
          },
        },
      );

      await tx1ReachedMulti.promise;

      // TxB applique sur l'offre B avec la même clé
      const runTxB = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offerB.id,
          proposalId: proposalB.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_concurrent_diff_res",
        },
        { pool: secondPool },
      );

      const lockObservedMulti = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(lockObservedMulti, true);

      tx1ReleaseMulti.resolve();

      const [resA, resBResult] = await Promise.allSettled([runTxA, runTxB]);

      assert.equal(resA.status, "fulfilled");
      assert.equal(resBResult.status, "rejected");
      assert.ok(
        (resBResult as PromiseRejectedResult).reason instanceof CatalogExtractionApplicationConflictError,
        "Ressources différentes sous même clé doivent lever CatalogExtractionApplicationConflictError",
      );
    });

    test("concurrence synchronisée : clés différentes sur la même ressource (conflit de version optimiste)", async () => {
      const user = await createUser({}, pool);
      const firstPid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await secondPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

      const offer = await createOffer({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: user.id,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const tx1ReachedLock = deferred();
      const tx2MayProceed = deferred();

      const runTx1 = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["model"],
          idempotencyKey: "idem_concurrent_key_1",
        },
        {
          pool,
          beforeUpdate: async () => {
            tx1ReachedLock.resolve();
            await tx2MayProceed.promise;
          },
        },
      );

      await tx1ReachedLock.promise;

      // Tx2 démarre sur secondPool avec une clé différente et attend la version 1
      const runTx2 = applyCatalogExtractionProposal(
        {
          ownerId: user.id,
          resourceType: "offer",
          resourceId: offer.id,
          proposalId: proposal.id,
          expectedContentVersion: 1,
          selection: ["category"],
          idempotencyKey: "idem_concurrent_key_2",
        },
        { pool: secondPool },
      );

      const lockObserved = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(lockObserved, true, "Tx2 doit être bloquée par le verrou FOR UPDATE de Tx1");

      tx2MayProceed.resolve();

      const [res1, res2Result] = await Promise.allSettled([runTx1, runTx2]);

      assert.equal(res1.status, "fulfilled");
      assert.equal(res2Result.status, "rejected");
      assert.ok(
        (res2Result as PromiseRejectedResult).reason instanceof StaleContentVersionError,
        "Tx2 doit échouer avec StaleContentVersionError car Tx1 a incrémenté la version",
      );

      const finalOffer = await getOfferById(user.id, offer.id, pool);
      assert.equal(finalOffer?.contentVersion, 2);
      assert.equal(finalOffer?.model, "iphone 12");
      assert.equal(finalOffer?.category, null);
    });

    test("rejet du caractère NUL U+0000 dans idempotencyKey (début, milieu, fin) et préservation de l'Unicode valide", async () => {
      const user = await createUser({}, pool);

      for (const resourceType of ["offer", "demand"] as const) {
        const create = resourceType === "offer" ? createOffer : createDemand;
        const getResource = resourceType === "offer" ? getOfferById : getDemandById;
        const resource = await create({ ownerId: user.id, rawText: "iPhone 12 128 Go" }, pool);
        const proposal = await createCatalogExtractionProposal(
          { ownerId: user.id, resourceType, resourceId: resource.id },
          { pool },
        );

        // Cas NUL au début, au milieu et à la fin
        const nulKeys = [
          { position: "début", key: "\0nul_at_start" },
          { position: "milieu", key: "nul_\0_middle" },
          { position: "fin", key: "nul_at_end\0" },
        ];

        for (const { position, key } of nulKeys) {
          await assert.rejects(
            async () => {
              await applyCatalogExtractionProposal(
                {
                  ownerId: user.id,
                  resourceType,
                  resourceId: resource.id,
                  proposalId: proposal.id,
                  expectedContentVersion: 1,
                  selection: { fields: ["model"] },
                  idempotencyKey: key,
                },
                { pool },
              );
            },
            (error: unknown) => {
              assert.ok(
                error instanceof CatalogExtractionApplicationValidationError,
                `Erreur CatalogExtractionApplicationValidationError attendue pour NUL au ${position}`,
              );
              assert.equal(
                (error as CatalogExtractionApplicationValidationError).message,
                "La clé d'idempotence ne peut pas contenir le caractère NUL.",
              );
              return true;
            },
          );

          // Vérifier l'absence de modification catalogue
          const unchanged = await getResource(user.id, resource.id, pool);
          assert.equal(unchanged?.contentVersion, 1);
          assert.equal(unchanged?.model, null);

          // Vérifier l'absence de reçu en base
          const receipts = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND ${resourceType === "offer" ? "offer_id" : "demand_id"} = $2`,
            [user.id, resource.id],
          );
          assert.equal(receipts.rows[0].count, "0");
        }

        // Témoin Unicode valide avec répétition idempotente
        const validUnicodeKey = `clé_unicode_é_à_${resourceType}_✓`;
        const receipt1 = await applyCatalogExtractionProposal(
          {
            ownerId: user.id,
            resourceType,
            resourceId: resource.id,
            proposalId: proposal.id,
            expectedContentVersion: 1,
            selection: { fields: ["model"] },
            idempotencyKey: validUnicodeKey,
          },
          { pool },
        );
        assert.equal(receipt1.versionBefore, 1);
        assert.equal(receipt1.versionAfter, 2);
        assert.deepEqual(receipt1.changes, { model: "iphone 12" });

        // Répétition idempotente avec la même clé Unicode
        const receipt2 = await applyCatalogExtractionProposal(
          {
            ownerId: user.id,
            resourceType,
            resourceId: resource.id,
            proposalId: proposal.id,
            expectedContentVersion: 1,
            selection: { fields: ["model"] },
            idempotencyKey: validUnicodeKey,
          },
          { pool },
        );
        assert.equal(receipt2.id, receipt1.id);
        assert.deepEqual(receipt2, receipt1);

        // Exactement 1 reçu en base
        const countAfter = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2`,
          [user.id, validUnicodeKey],
        );
        assert.equal(countAfter.rows[0].count, "1");
      }
    });

    test("le nettoyage reste limité au schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      const remaining = await adminPool.query<{ name: string | null }>(
        "SELECT to_regnamespace($1)::text AS name",
        [schema],
      );
      assert.equal(remaining.rows[0].name, null);
    });
  });
}
