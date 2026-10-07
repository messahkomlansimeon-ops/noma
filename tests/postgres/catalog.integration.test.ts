import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool, QueryResultRow } from "pg";
import {
  archiveDemand,
  archiveOffer,
  archiveUser,
  CatalogOwnershipError,
  CatalogValidationError,
  createDemand,
  createOffer,
  createUser,
  getDemandById,
  getOfferById,
  getUserById,
  listDemandsByOwner,
  listOffersByOwner,
  StaleContentVersionError,
  updateDemand,
  updateOffer,
  updateUser,
} from "../../lib/server/catalog";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  assertEffectiveTestConnection,
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
  type TestPoolFactory,
} from "./test-database";

async function assertRejectedBeforePool(
  value: string | undefined,
  expected: RegExp,
): Promise<void> {
  let poolConstructions = 0;
  const guardedFactory: TestPoolFactory = () => {
    poolConstructions += 1;
    throw new Error("Le Pool ne devait pas être construit.");
  };
  await assert.rejects(openVerifiedTestDatabase(value, guardedFactory), expected);
  assert.equal(poolConstructions, 0, "aucune connexion ne doit être préparée");
}

test("URL PostgreSQL dédiée valide acceptée sans connexion", () => {
  const target = requireDedicatedTestDatabase(
    "postgresql://local:local@127.0.0.1:55432/noma_test?application_name=noma",
  );
  assert.equal(target.databaseName, "noma_test");
});

test("TEST_DATABASE_URL absente refusée avant toute connexion", async () => {
  await assertRejectedBeforePool(undefined, /TEST_DATABASE_URL requis/);
});

test("base non dédiée refusée avant toute connexion", async () => {
  await assertRejectedBeforePool(
    "postgresql://local:local@127.0.0.1:55432/noma_dev",
    /segment « test »/,
  );
});

test("paramètre options refusé avant toute connexion", async () => {
  await assertRejectedBeforePool(
    "postgresql://local:local@127.0.0.1:55432/noma_test?options=-c%20search_path%3Dpublic",
    /paramètre « options »/,
  );
});

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
  test("pré-requis PostgreSQL dédié", () => {
    assert.throws(() => requireDedicatedTestDatabase(configuredUrl), /TEST_DATABASE_URL requis/);
    assert.fail(
      "TEST_DATABASE_URL requis : aucune suite PostgreSQL n'a été simulée ou ignorée.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr", () => {
    throw configuredUrlError;
  });
} else {
  describe("PostgreSQL métier — migrations et dépôts", () => {
    interface PublicRelationRow extends QueryResultRow {
      relname: string;
      relkind: string;
    }

    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const createdIds = {
      users: new Set<string>(),
      offers: new Set<string>(),
      demands: new Set<string>(),
    };
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let publicRelationsBefore: PublicRelationRow[];
    let schemaCleaned = false;

    const publicRelations = async (): Promise<PublicRelationRow[]> => {
      const result = await adminPool.query<PublicRelationRow>(`
        SELECT relation.relname, relation.relkind
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
         ORDER BY relation.relname, relation.relkind
      `);
      return result.rows;
    };

    const verifyIsolation = (testPool: Pool = pool) =>
      assertEffectiveTestConnection(testPool, target, schema);

    const assertIdsAbsentFromPublic = async (
      table: keyof typeof createdIds,
    ): Promise<void> => {
      const ids = [...createdIds[table]];
      if (ids.length === 0) return;
      const relation = await adminPool.query<{ name: string | null }>(
        "SELECT to_regclass($1)::text AS name",
        [`public.${table}`],
      );
      if (relation.rows[0].name === null) return;
      const leaked = await adminPool.query<{ id: string }>(
        `SELECT id::text FROM public.${table} WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      assert.deepEqual(leaked.rows, [], `aucune donnée de test ne doit atteindre public.${table}`);
    };

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      publicRelationsBefore = await publicRelations();
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
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

    test("base vide : migrations concurrentes sérialisées, puis relance idempotente", async () => {
      await verifyIsolation();
      const secondPool = await openVerifiedIsolatedPool(target, schema);
      try {
        const [first, second] = await Promise.all([
          runMigrations(pool),
          runMigrations(secondPool),
        ]);
        assert.equal(first.applied.length + second.applied.length, 19);
        assert.equal(first.skipped.length + second.skipped.length, 19);
        const rerun = await runMigrations(pool);
        assert.deepEqual(rerun.applied, []);
        assert.deepEqual(rerun.skipped, [
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
        ]);
        const history = await pool.query(
          "SELECT version, checksum FROM noma_schema_migrations ORDER BY version",
        );
        assert.equal(history.rowCount, 19);
        assert.deepEqual(history.rows.map((row) => row.version), [
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
        ]);
        assert.ok(history.rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)));
      } finally {
        await secondPool.end();
      }
    });

    test("persistance après fermeture et réouverture d'une connexion", async () => {
      await verifyIsolation();
      const firstPool = await openVerifiedIsolatedPool(target, schema);
      const user = await createUser({}, firstPool);
      createdIds.users.add(user.id);
      const offer = await createOffer(
        {
          ownerId: user.id,
          rawText: "iPhone 12 128 Go à Cocody",
          model: "iPhone 12",
          quantity: 1,
          price: { amount: 150_000, currency: "XOF" },
        },
        firstPool,
      );
      createdIds.offers.add(offer.id);
      await firstPool.end();

      const reopened = await openVerifiedIsolatedPool(target, schema);
      try {
        const persisted = await getOfferById(user.id, offer.id, reopened);
        assert.equal(persisted?.rawText, "iPhone 12 128 Go à Cocody");
        assert.deepEqual(persisted?.price, { amount: 150_000, currency: "XOF" });
        assert.equal(persisted?.category, null, "inconnu conservé à null");
      } finally {
        await reopened.end();
      }
    });

    test("contraintes propriétaire et montants entiers", async () => {
      await verifyIsolation();
      const owner = await createUser({}, pool);
      createdIds.users.add(owner.id);
      await assert.rejects(
        createOffer(
          { ownerId: randomUUID(), rawText: "propriétaire absent" },
          pool,
        ),
        (error: unknown) => (error as { code?: string }).code === "23503",
      );
      await assert.rejects(
        createDemand(
          {
            ownerId: owner.id,
            rawText: "budget invalide",
            budget: { amount: 1.5, currency: "XOF" },
          },
          pool,
        ),
        CatalogValidationError,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO offers (
             id, owner_id, status, raw_text, price_amount, price_currency
           ) VALUES ($1, $2, 'draft', $3, $4, $5)`,
          [randomUUID(), owner.id, "prix négatif", -1, "XOF"],
        ),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
    });

    test("rollback intégral : toutes les écritures partagent le même client", async () => {
      await verifyIsolation();
      const userId = randomUUID();
      const demandId = randomUUID();
      await assert.rejects(
        withPostgresTransaction(async (client) => {
          await createUser({ id: userId }, client);
          await createDemand(
            { id: demandId, ownerId: userId, rawText: "transaction annulée" },
            client,
          );
          throw new Error("échec volontaire");
        }, pool),
        /échec volontaire/,
      );
      assert.equal(await getUserById(userId, pool), null);
      const persisted = await pool.query("SELECT id FROM demands WHERE id = $1", [demandId]);
      assert.equal(persisted.rowCount, 0);
    });

    test("filtrage propriétaire, archivage et version obsolète", async () => {
      await verifyIsolation();
      const owner = await createUser({}, pool);
      const intruder = await createUser({}, pool);
      createdIds.users.add(owner.id);
      createdIds.users.add(intruder.id);
      const offer = await createOffer(
        { ownerId: owner.id, rawText: "offre privée", price: null },
        pool,
      );
      createdIds.offers.add(offer.id);
      const demand = await createDemand(
        {
          ownerId: owner.id,
          rawText: "demande privée",
          budget: { amount: 200_000, currency: "XOF" },
          requirements: ["128 Go"],
          preferences: null,
        },
        pool,
      );
      createdIds.demands.add(demand.id);

      assert.equal(await getOfferById(intruder.id, offer.id, pool), null);
      assert.equal(await getDemandById(intruder.id, demand.id, pool), null);
      assert.deepEqual(await listOffersByOwner(intruder.id, pool), []);
      assert.deepEqual(await listDemandsByOwner(intruder.id, pool), []);
      await assert.rejects(
        updateOffer({
          id: offer.id,
          ownerId: intruder.id,
          expectedContentVersion: 1,
          changes: { rawText: "intrusion" },
        }, pool),
        CatalogOwnershipError,
      );

      const updatedOffer = await updateOffer({
        id: offer.id,
        ownerId: owner.id,
        expectedContentVersion: 1,
        changes: { status: "published", availabilityStatus: "available" },
      }, pool);
      assert.equal(updatedOffer.contentVersion, 2);
      await assert.rejects(
        updateOffer({
          id: offer.id,
          ownerId: owner.id,
          expectedContentVersion: 1,
          changes: { rawText: "écriture obsolète" },
        }, pool),
        StaleContentVersionError,
      );

      const updatedDemand = await updateDemand({
        id: demand.id,
        ownerId: owner.id,
        expectedContentVersion: 1,
        changes: { status: "active", budget: null },
      }, pool);
      assert.equal(updatedDemand.budget, null);
      await assert.rejects(
        archiveDemand(intruder.id, demand.id, updatedDemand.contentVersion, pool),
        CatalogOwnershipError,
      );
      const archivedDemand = await archiveDemand(
        owner.id,
        demand.id,
        updatedDemand.contentVersion,
        pool,
      );
      assert.equal(archivedDemand.status, "archived");
      assert.ok(archivedDemand.archivedAt instanceof Date);

      const archivedOffer = await archiveOffer(
        owner.id,
        offer.id,
        updatedOffer.contentVersion,
        pool,
      );
      assert.equal(archivedOffer.status, "archived");

      const suspendedUser = await updateUser(
        { id: owner.id, expectedVersion: 1, status: "suspended" },
        pool,
      );
      assert.equal(suspendedUser.version, 2);
      await assert.rejects(
        updateUser({ id: owner.id, expectedVersion: 1, status: "active" }, pool),
        StaleContentVersionError,
      );
      const archivedUser = await archiveUser(owner.id, suspendedUser.version, pool);
      assert.equal(archivedUser.status, "archived");
    });

    test("migrations et données confinées, puis schéma temporaire seul nettoyé", async () => {
      await verifyIsolation();
      const relations = await pool.query<{ schema_name: string; relation_name: string }>(
        `SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
           FROM pg_class AS relation
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = $1
            AND relation.relname = ANY($2::text[])
          ORDER BY relation.relname`,
        [schema, [
          "auth_sessions",
          "catalog_extraction_applications",
          "catalog_extraction_proposals",
          "demands",
          "noma_schema_migrations",
          "offers",
          "otp_challenges",
          "otp_rate_limit_counters",
          "phone_identities",
          "users",
        ]],
      );
      assert.deepEqual(
        relations.rows,
        [
          "auth_sessions",
          "catalog_extraction_applications",
          "catalog_extraction_proposals",
          "demands",
          "noma_schema_migrations",
          "offers",
          "otp_challenges",
          "otp_rate_limit_counters",
          "phone_identities",
          "users",
        ].map((relationName) => ({ schema_name: schema, relation_name: relationName })),
      );
      await assertIdsAbsentFromPublic("users");
      await assertIdsAbsentFromPublic("offers");
      await assertIdsAbsentFromPublic("demands");

      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      const remaining = await adminPool.query<{ name: string | null }>(
        "SELECT to_regnamespace($1)::text AS name",
        [schema],
      );
      assert.equal(remaining.rows[0].name, null);
      assert.deepEqual(await publicRelations(), publicRelationsBefore);
    });
  });
}
