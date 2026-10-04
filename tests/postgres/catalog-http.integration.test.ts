import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, revokeSession, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import {
  CATALOG_HTTP_BODY_MAX_BYTES,
  createCatalogHttpHandlers,
  type CatalogHttpHandlers,
} from "../../lib/server/catalog/http";
import { updateUser } from "../../lib/server/catalog";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
} from "./test-database";

class TestClock {
  constructor(private timestamp: number) {}

  readonly now = (): Date => new Date(this.timestamp);

  advance(milliseconds: number): void {
    this.timestamp += milliseconds;
  }
}

interface Login {
  userId: string;
  token: string;
  cookie: string;
}

const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const DAY = 24 * 60 * 60 * 1_000;
let phoneSequence = 0;

function uniquePhone(): string {
  phoneSequence += 1;
  return `+22503${phoneSequence.toString().padStart(8, "0")}`;
}

function httpRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  cookie: string | undefined,
  body?: unknown,
  origin: string | null = ORIGIN,
): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
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
  test("pré-requis PostgreSQL dédié pour le catalogue HTTP", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test catalogue HTTP n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour le catalogue HTTP", () => {
    throw configuredUrlError;
  });
} else {
  describe("catalogue HTTP propriétaire", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let handlers: CatalogHttpHandlers;
    let owner: Login;
    let other: Login;
    let schemaCleaned = false;

    async function login(authClock: TestClock, ip: string): Promise<Login> {
      let delivery: SendOtpInput | undefined;
      const requested = await requestOtp(uniquePhone(), {
        pool,
        now: authClock.now,
        authSecret: SECRET,
        requestIp: ip,
        sendOtp: async (input) => {
          delivery = input;
        },
      });
      assert.ok(delivery);
      const verified = await verifyOtp(requested.challengeId, delivery.code, {
        pool,
        now: authClock.now,
        authSecret: SECRET,
      });
      return {
        userId: verified.userId,
        token: verified.sessionToken,
        cookie: `noma_auth=${verified.sessionToken}`,
      };
    }

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
      handlers = createCatalogHttpHandlers({
        pool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });
      owner = await login(clock, "198.51.100.61");
      other = await login(clock, "198.51.100.62");
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        if (!schemaCleaned) await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    test("CRUD draft, valeurs nulles et persistance offre/demande", async () => {
      const offerCreated = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        {
          rawText: "iPhone 14 disponible à Cocody",
          model: "iPhone 14",
          quantity: 1,
          deadlineAt: "2032-01-10T12:00:00Z",
          price: { amount: 450_000, currency: "XOF" },
          availabilityStatus: "available",
        },
      ));
      assert.equal(offerCreated.status, 201);
      assertNoStore(offerCreated);
      const offer = (await offerCreated.json() as { offer: Record<string, unknown> }).offer;
      assert.equal(offer.status, "draft");
      assert.equal(offer.category, null);
      assert.equal(offer.ownerId, undefined);
      assert.equal(offer.extractionMetadata, undefined);

      const demandCreated = await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        {
          rawText: "Recherche iPhone 14",
          category: null,
          budget: { amount: 400_000, currency: "XOF" },
          requirements: ["128 Go"],
          preferences: null,
        },
      ));
      assert.equal(demandCreated.status, 201);
      const demand = (await demandCreated.json() as { demand: Record<string, unknown> }).demand;
      assert.equal(demand.status, "draft");
      assert.equal(demand.brand, null);

      const offerUpdated = await handlers.offers.update(httpRequest(
        "PATCH",
        `/api/offers/${offer.id as string}`,
        owner.cookie,
        { expectedContentVersion: 1, brand: "Apple", category: null },
      ), offer.id as string);
      assert.equal(offerUpdated.status, 200);
      const updatedOffer = (await offerUpdated.json() as { offer: Record<string, unknown> }).offer;
      assert.equal(updatedOffer.brand, "Apple");
      assert.equal(updatedOffer.category, null);
      assert.equal(updatedOffer.contentVersion, 2);

      const demandUpdated = await handlers.demands.update(httpRequest(
        "PATCH",
        `/api/demands/${demand.id as string}`,
        owner.cookie,
        { expectedContentVersion: 1, budget: null, location: "Abidjan" },
      ), demand.id as string);
      assert.equal(demandUpdated.status, 200);
      const updatedDemand = (await demandUpdated.json() as { demand: Record<string, unknown> }).demand;
      assert.equal(updatedDemand.budget, null);
      assert.equal(updatedDemand.location, "Abidjan");

      const reopened = await openVerifiedIsolatedPool(target, schema);
      try {
        const reopenedHandlers = createCatalogHttpHandlers({
          pool: reopened,
          now: clock.now,
          env: { NOMA_AUTH_ORIGIN: ORIGIN },
        });
        const persistedOffer = await reopenedHandlers.offers.read(
          httpRequest("GET", `/api/offers/${offer.id as string}`, owner.cookie),
          offer.id as string,
        );
        const persistedDemand = await reopenedHandlers.demands.read(
          httpRequest("GET", `/api/demands/${demand.id as string}`, owner.cookie),
          demand.id as string,
        );
        assert.equal(persistedOffer.status, 200);
        assert.equal(persistedDemand.status, 200);
      } finally {
        await reopened.end();
      }
    });

    test("isolation propriétaire identique pour lecture, liste et écriture", async () => {
      const created = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "offre privée" },
      ));
      const offer = (await created.json() as { offer: { id: string } }).offer;

      const foreignRead = await handlers.offers.read(
        httpRequest("GET", `/api/offers/${offer.id}`, other.cookie),
        offer.id,
      );
      const absentId = randomUUID();
      const absentRead = await handlers.offers.read(
        httpRequest("GET", `/api/offers/${absentId}`, other.cookie),
        absentId,
      );
      assert.equal(foreignRead.status, 404);
      assert.equal(absentRead.status, 404);
      assert.deepEqual(await foreignRead.json(), await absentRead.json());

      const foreignUpdate = await handlers.offers.update(httpRequest(
        "PATCH",
        `/api/offers/${offer.id}`,
        other.cookie,
        { expectedContentVersion: 1, rawText: "intrusion" },
      ), offer.id);
      const foreignArchive = await handlers.offers.archive(httpRequest(
        "POST",
        `/api/offers/${offer.id}/archive`,
        other.cookie,
        { expectedContentVersion: 1 },
      ), offer.id);
      assert.equal(foreignUpdate.status, 404);
      assert.equal(foreignArchive.status, 404);

      const foreignList = await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers?limit=100&offset=0",
        other.cookie,
      ));
      const ids = (await foreignList.json() as { offers: Array<{ id: string }> }).offers
        .map((item) => item.id);
      assert.equal(ids.includes(offer.id), false);
      const unchanged = await handlers.offers.read(
        httpRequest("GET", `/api/offers/${offer.id}`, owner.cookie),
        offer.id,
      );
      assert.equal((await unchanged.json() as { offer: { rawText: string } }).offer.rawText, "offre privée");

      const demandCreated = await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        { rawText: "demande privée" },
      ));
      const demand = (await demandCreated.json() as { demand: { id: string } }).demand;
      assert.equal((await handlers.demands.read(
        httpRequest("GET", `/api/demands/${demand.id}`, other.cookie),
        demand.id,
      )).status, 404);
      assert.equal((await handlers.demands.update(httpRequest(
        "PATCH",
        `/api/demands/${demand.id}`,
        other.cookie,
        { expectedContentVersion: 1, rawText: "intrusion" },
      ), demand.id)).status, 404);
    });

    test("conflit de version concurrent et archivage irréversible", async () => {
      const created = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "offre concurrente" },
      ));
      const offer = (await created.json() as { offer: { id: string } }).offer;
      const secondPool = await openVerifiedIsolatedPool(target, schema);
      try {
        const secondHandlers = createCatalogHttpHandlers({
          pool: secondPool,
          now: clock.now,
          env: { NOMA_AUTH_ORIGIN: ORIGIN },
        });
        const outcomes = await Promise.all([
          handlers.offers.update(httpRequest(
            "PATCH",
            `/api/offers/${offer.id}`,
            owner.cookie,
            { expectedContentVersion: 1, brand: "A" },
          ), offer.id),
          secondHandlers.offers.update(httpRequest(
            "PATCH",
            `/api/offers/${offer.id}`,
            owner.cookie,
            { expectedContentVersion: 1, brand: "B" },
          ), offer.id),
        ]);
        assert.deepEqual(outcomes.map((response) => response.status).sort(), [200, 409]);
      } finally {
        await secondPool.end();
      }

      const archived = await handlers.offers.archive(httpRequest(
        "POST",
        `/api/offers/${offer.id}/archive`,
        owner.cookie,
        { expectedContentVersion: 2 },
      ), offer.id);
      assert.equal(archived.status, 200);
      const archivedOffer = (await archived.json() as {
        offer: { status: string; contentVersion: number };
      }).offer;
      assert.equal(archivedOffer.status, "archived");
      assert.equal(archivedOffer.contentVersion, 3);

      const updateArchived = await handlers.offers.update(httpRequest(
        "PATCH",
        `/api/offers/${offer.id}`,
        owner.cookie,
        { expectedContentVersion: 3, model: "interdit" },
      ), offer.id);
      const archiveAgain = await handlers.offers.archive(httpRequest(
        "POST",
        `/api/offers/${offer.id}/archive`,
        owner.cookie,
        { expectedContentVersion: 3 },
      ), offer.id);
      assert.equal(updateArchived.status, 409);
      assert.equal(archiveAgain.status, 409);

      const demandCreated = await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        { rawText: "demande à archiver" },
      ));
      const demand = (await demandCreated.json() as { demand: { id: string } }).demand;
      assert.equal((await handlers.demands.archive(httpRequest(
        "POST",
        `/api/demands/${demand.id}/archive`,
        owner.cookie,
        { expectedContentVersion: 1 },
      ), demand.id)).status, 200);
      assert.equal((await handlers.demands.update(httpRequest(
        "PATCH",
        `/api/demands/${demand.id}`,
        owner.cookie,
        { expectedContentVersion: 2, location: "interdit" },
      ), demand.id)).status, 409);
    });

    test("pagination SQL stable et bornée", async () => {
      const paginationOwner = await login(clock, "198.51.100.63");
      for (let index = 0; index < 5; index += 1) {
        const response = await handlers.offers.create(httpRequest(
          "POST",
          "/api/offers",
          paginationOwner.cookie,
          { rawText: `offre page ${index}` },
        ));
        assert.equal(response.status, 201);
      }
      const expected = await pool.query<{ id: string }>(
        "SELECT id FROM offers WHERE owner_id = $1 ORDER BY created_at, id",
        [paginationOwner.userId],
      );
      const first = await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers?limit=2&offset=0",
        paginationOwner.cookie,
      ));
      const second = await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers?limit=2&offset=2",
        paginationOwner.cookie,
      ));
      const firstBody = await first.json() as {
        offers: Array<{ id: string }>;
        pagination: { limit: number; offset: number };
      };
      const secondBody = await second.json() as { offers: Array<{ id: string }> };
      assert.deepEqual(firstBody.pagination, { limit: 2, offset: 0 });
      assert.deepEqual(
        [...firstBody.offers, ...secondBody.offers].map((item) => item.id),
        expected.rows.slice(0, 4).map((item) => item.id),
      );
      assert.equal((await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers?limit=101",
        paginationOwner.cookie,
      ))).status, 400);
      assert.equal((await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers?ownerId=x",
        paginationOwner.cookie,
      ))).status, 400);
    });

    test("sessions absente, expirée, révoquée et compte suspendu", async () => {
      assert.equal((await handlers.offers.list(httpRequest(
        "GET",
        "/api/offers",
        undefined,
      ))).status, 401);

      const expiringClock = new TestClock(Date.UTC(2033, 0, 1, 10));
      const expiring = await login(expiringClock, "198.51.100.64");
      const expiringHandlers = createCatalogHttpHandlers({
        pool,
        now: expiringClock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });
      expiringClock.advance(7 * DAY + 1);
      assert.equal((await expiringHandlers.offers.list(httpRequest(
        "GET",
        "/api/offers",
        expiring.cookie,
      ))).status, 401);

      const revoked = await login(clock, "198.51.100.65");
      await revokeSession(revoked.token, { pool, now: clock.now });
      assert.equal((await handlers.demands.list(httpRequest(
        "GET",
        "/api/demands",
        revoked.cookie,
      ))).status, 401);

      const suspended = await login(clock, "198.51.100.66");
      await updateUser(
        { id: suspended.userId, expectedVersion: 1, status: "suspended" },
        pool,
      );
      assert.equal((await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        suspended.cookie,
        { rawText: "interdit" },
      ))).status, 401);
    });

    test("entrées réservées, types stricts, taille et Origin refusés", async () => {
      const reservedFields = [
        "ownerId",
        "role",
        "id",
        "status",
        "extractorVersion",
        "extractionMetadata",
        "extractedAt",
        "createdAt",
        "updatedAt",
        "archivedAt",
        "availabilityConfirmedAt",
      ];
      for (const field of reservedFields) {
        const response = await handlers.offers.create(httpRequest(
          "POST",
          "/api/offers",
          owner.cookie,
          { rawText: "invalide", [field]: field === "status" ? "published" : "x" },
        ));
        assert.equal(response.status, 400, `champ réservé accepté : ${field}`);
      }

      assert.equal((await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "prix flottant", price: { amount: 1.5, currency: "XOF" } },
      ))).status, 400);
      assert.equal((await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        { rawText: "devise implicite", budget: { amount: 1, currency: "xof" } },
      ))).status, 400);
      assert.equal((await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "date non stricte", deadlineAt: "2032-01-01T10:00:00+00:00" },
      ))).status, 400);

      const valid = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "patch cible" },
      ));
      const id = (await valid.json() as { offer: { id: string } }).offer.id;
      assert.equal((await handlers.offers.update(httpRequest(
        "PATCH",
        `/api/offers/${id}`,
        owner.cookie,
        { expectedContentVersion: 1, rawText: null },
      ), id)).status, 400);
      assert.equal((await handlers.offers.update(httpRequest(
        "PATCH",
        `/api/offers/${id}`,
        owner.cookie,
        { expectedContentVersion: 1 },
      ), id)).status, 400);

      const beforeCount = Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM offers WHERE owner_id = $1",
        [owner.userId],
      )).rows[0].count);
      const badOrigin = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "origine interdite" },
        "https://evil.test",
      ));
      assert.equal(badOrigin.status, 403);
      assert.equal((await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "origine absente" },
        null,
      ))).status, 403);
      assert.equal(Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM offers WHERE owner_id = $1",
        [owner.userId],
      )).rows[0].count), beforeCount);

      const chunks = Array.from(
        { length: 4 },
        () => new TextEncoder().encode("é".repeat(CATALOG_HTTP_BODY_MAX_BYTES / 2)),
      );
      const state = { pulls: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      });
      const oversized = new Request(`${ORIGIN}/api/offers`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const tooLarge = await handlers.offers.create(oversized);
      assert.equal(tooLarge.status, 413);
      assertNoStore(tooLarge);
      assert.equal(state.cancelled, true);
      assert.ok(state.pulls < 4);
    });

    test("attributes objet JSON et quantité INTEGER validés avant écriture", async () => {
      const definitions = [
        { table: "offers", singular: "offer", resource: handlers.offers },
        { table: "demands", singular: "demand", resource: handlers.demands },
      ] as const;
      const invalidAttributes: unknown[] = ["scalaire", 42, true, []];
      const maximumQuantity = 2_147_483_647;

      for (const definition of definitions) {
        const path = `/api/${definition.table}`;
        const countBefore = Number((await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${definition.table} WHERE owner_id = $1`,
          [owner.userId],
        )).rows[0].count);

        for (const attributes of invalidAttributes) {
          const response = await definition.resource.create(httpRequest(
            "POST",
            path,
            owner.cookie,
            { rawText: "création refusée", attributes },
          ));
          assert.equal(response.status, 400);
        }
        assert.equal((await definition.resource.create(httpRequest(
          "POST",
          path,
          owner.cookie,
          { rawText: "quantité refusée", quantity: maximumQuantity + 1 },
        ))).status, 400);
        assert.equal(Number((await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${definition.table} WHERE owner_id = $1`,
          [owner.userId],
        )).rows[0].count), countBefore);

        const created = await definition.resource.create(httpRequest(
          "POST",
          path,
          owner.cookie,
          {
            rawText: "bornes valides",
            attributes: { stockage: 128 },
            quantity: maximumQuantity,
          },
        ));
        assert.equal(created.status, 201);
        const record = (await created.json() as Record<string, {
          id: string;
          attributes: unknown;
          quantity: number | null;
          contentVersion: number;
        }>)[definition.singular];
        assert.deepEqual(record.attributes, { stockage: 128 });
        assert.equal(record.quantity, maximumQuantity);

        const nullable = await definition.resource.update(httpRequest(
          "PATCH",
          `${path}/${record.id}`,
          owner.cookie,
          { expectedContentVersion: 1, attributes: null, quantity: null },
        ), record.id);
        assert.equal(nullable.status, 200);
        const nullableRecord = (await nullable.json() as Record<string, {
          attributes: unknown;
          quantity: number | null;
          contentVersion: number;
        }>)[definition.singular];
        assert.equal(nullableRecord.attributes, null);
        assert.equal(nullableRecord.quantity, null);
        assert.equal(nullableRecord.contentVersion, 2);

        const objectPatch = await definition.resource.update(httpRequest(
          "PATCH",
          `${path}/${record.id}`,
          owner.cookie,
          {
            expectedContentVersion: 2,
            attributes: { couleur: "noir" },
            quantity: maximumQuantity,
          },
        ), record.id);
        assert.equal(objectPatch.status, 200);

        for (const attributes of invalidAttributes) {
          const response = await definition.resource.update(httpRequest(
            "PATCH",
            `${path}/${record.id}`,
            owner.cookie,
            { expectedContentVersion: 3, attributes },
          ), record.id);
          assert.equal(response.status, 400);
        }
        assert.equal((await definition.resource.update(httpRequest(
          "PATCH",
          `${path}/${record.id}`,
          owner.cookie,
          { expectedContentVersion: 3, quantity: maximumQuantity + 1 },
        ), record.id)).status, 400);

        const persisted = await definition.resource.read(
          httpRequest("GET", `${path}/${record.id}`, owner.cookie),
          record.id,
        );
        const persistedRecord = (await persisted.json() as Record<string, {
          attributes: unknown;
          quantity: number | null;
          contentVersion: number;
        }>)[definition.singular];
        assert.deepEqual(persistedRecord.attributes, { couleur: "noir" });
        assert.equal(persistedRecord.quantity, maximumQuantity);
        assert.equal(persistedRecord.contentVersion, 3);

        const nullCreated = await definition.resource.create(httpRequest(
          "POST",
          path,
          owner.cookie,
          { rawText: "null valide", attributes: null, quantity: null },
        ));
        assert.equal(nullCreated.status, 201);
        const nullRecord = (await nullCreated.json() as Record<string, {
          attributes: unknown;
          quantity: number | null;
        }>)[definition.singular];
        assert.equal(nullRecord.attributes, null);
        assert.equal(nullRecord.quantity, null);
      }
    });

    test("nettoyage limité au schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      assert.equal(
        (await adminPool.query<{ name: string | null }>(
          "SELECT to_regnamespace($1)::text AS name",
          [schema],
        )).rows[0].name,
        null,
      );
    });
  });
}
