import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, revokeSession, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import {
  archiveOffer,
  createDemand,
  createOffer,
  getDemandById,
  getOfferById,
  updateOffer,
  updateUser,
} from "../../lib/server/catalog";
import {
  createCatalogExtractionHttpHandlers,
  type CatalogExtractionHttpHandlers,
} from "../../lib/server/catalog-extraction/http";
import { createCatalogExtractionProposal } from "../../lib/server/catalog-extraction";
import {
  POST as postOfferProposalApplyRoute,
} from "../../app/api/offers/[id]/extraction-proposals/[proposalId]/apply/route";
import {
  POST as postDemandProposalApplyRoute,
} from "../../app/api/demands/[id]/extraction-proposals/[proposalId]/apply/route";
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
let phoneSequence = 0;

function uniquePhone(): string {
  phoneSequence += 1;
  return `+22506${phoneSequence.toString().padStart(8, "0")}`;
}

function httpRequest(
  method: "POST",
  path: string,
  cookie?: string,
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
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

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

function createOversizedStream(
  totalBytes: number,
  state?: { cancelled: boolean },
): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunkSize = 8 * 1024;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const toSend = Math.min(chunkSize, totalBytes - sent);
      sent += toSend;
      controller.enqueue(new Uint8Array(toSend));
    },
    cancel() {
      if (state) state.cancelled = true;
    },
  });
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
  test("pré-requis PostgreSQL dédié pour l'application d'extraction HTTP (Lot 1E5)", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test HTTP d'application n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour l'application d'extraction HTTP (Lot 1E5)", () => {
    throw configuredUrlError;
  });
} else {
  describe("API privée d'application de proposition d'extraction (Lot 1E5)", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let secondPool: Pool;
    let handlers: CatalogExtractionHttpHandlers;
    let owner: Login;
    let other: Login;
    let schemaCleaned = false;

    async function login(authClock: TestClock = clock, ip = "198.51.100.80"): Promise<Login> {
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
      secondPool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
      process.env.DATABASE_URL = target.connectionString;
      process.env.NOMA_AUTH_SECRET = SECRET.toString("hex");
      process.env.NOMA_AUTH_ORIGIN = ORIGIN;
      handlers = createCatalogExtractionHttpHandlers({
        pool,
        now: clock.now,
        env: {
          DATABASE_URL: target.connectionString,
          NOMA_AUTH_SECRET: SECRET.toString("hex"),
          NOMA_AUTH_ORIGIN: ORIGIN,
        },
      });
      owner = await login();
      other = await login();
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

    test("succès POST apply sur offres et demandes via handlers et routes Next.js avec conversion exacte et reçu durable", async () => {
      // 1. Offre
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "iPhone 12 128 Go",
      }, pool);

      const offerProposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const offerApplyPayload = {
        expectedContentVersion: 1,
        selection: {
          fields: ["model"],
          attributeKeys: ["storage_capacity"],
        },
        idempotencyKey: "apply_offer_success_1",
      };

      // Test via handler
      const offerPath = `/api/offers/${offer.id}/extraction-proposals/${offerProposal.id}/apply`;
      const offerReq = httpRequest("POST", offerPath, owner.cookie, offerApplyPayload);
      const offerRes = await handlers.offers.apply(offerReq, offer.id, offerProposal.id);

      assert.equal(offerRes.status, 200);
      assertNoStore(offerRes);

      const offerJson = (await offerRes.json()) as { applicationReceipt: Record<string, unknown> };
      assert.ok(offerJson.applicationReceipt, "Champ unique applicationReceipt attendu");
      assert.equal(Object.keys(offerJson).length, 1, "Un seul champ racine applicationReceipt attendu");
      assert.equal(offerJson.applicationReceipt.resourceType, "offer");
      assert.equal(offerJson.applicationReceipt.resourceId, offer.id);
      assert.equal(offerJson.applicationReceipt.proposalId, offerProposal.id);
      assert.equal(offerJson.applicationReceipt.versionBefore, 1);
      assert.equal(offerJson.applicationReceipt.versionAfter, 2);
      assert.deepEqual(offerJson.applicationReceipt.changes, {
        model: "iphone 12",
        attributes: {
          storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
        },
      });

      // Vérification en base pour l'offre
      const offerDb = await getOfferById(owner.userId, offer.id, pool);
      assert.ok(offerDb);
      assert.equal(offerDb.contentVersion, 2);
      assert.equal(offerDb.model, "iphone 12");
      assert.deepEqual(offerDb.attributes, {
        storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
      });

      // 2. Demande via route Next.js directe
      const demand = await createDemand({
        ownerId: owner.userId,
        rawText: "Cherche iPhone 12 128 Go",
      }, pool);

      const demandProposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "demand",
        resourceId: demand.id,
      }, { pool });

      const demandApplyPayload = {
        expectedContentVersion: 1,
        selection: {
          fields: ["model"],
          attributeKeys: ["storage_capacity"],
        },
        idempotencyKey: "apply_demand_success_1",
      };

      const demandPath = `/api/demands/${demand.id}/extraction-proposals/${demandProposal.id}/apply`;
      const demandReq = httpRequest("POST", demandPath, owner.cookie, demandApplyPayload);
      const demandRes = await handlers.demands.apply(demandReq, demand.id, demandProposal.id);

      assert.equal(demandRes.status, 200);
      assertNoStore(demandRes);

      const demandJson = (await demandRes.json()) as { applicationReceipt: Record<string, unknown> };
      assert.ok(demandJson.applicationReceipt);
      assert.equal(demandJson.applicationReceipt.resourceType, "demand");
      assert.equal(demandJson.applicationReceipt.versionAfter, 2);

      const demandDb = await getDemandById(owner.userId, demand.id, pool);
      assert.ok(demandDb);
      assert.equal(demandDb.contentVersion, 2);
      assert.equal(demandDb.model, "iphone 12");
    });

    test("application ciblée et préservation des valeurs humaines existantes", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "iPhone 12 128 Go en excellent état",
        brand: "Apple Humain",
        attributes: {
          couleur: "bleu",
          vendeur: "particulier",
        },
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      // L'utilisateur ne choisit que "model"
      const payload = {
        expectedContentVersion: 1,
        selection: {
          fields: ["model"],
        },
        idempotencyKey: "apply_targeted_1",
      };

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;
      const res = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload),
        offer.id,
        proposal.id,
      );

      assert.equal(res.status, 200);

      const updated = await getOfferById(owner.userId, offer.id, pool);
      assert.ok(updated);
      assert.equal(updated.contentVersion, 2);
      assert.equal(updated.model, "iphone 12");
      // Valeurs humaines strictement préservées
      assert.equal(updated.rawText, "iPhone 12 128 Go en excellent état");
      assert.equal(updated.brand, "Apple Humain");
      assert.equal(updated.status, "draft");
      assert.equal(updated.category, null);
      assert.deepEqual(updated.attributes, {
        couleur: "bleu",
        vendeur: "particulier",
      });
    });

    test("absence de changement (no-op) : retour 200, changes={}, version et updatedAt non modifiés", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "iPhone 12 128 Go",
        model: "iphone 12",
        attributes: {
          storage_capacity: { value: 128, unit: "GB", sourceUnit: "Go" },
        },
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const before = await getOfferById(owner.userId, offer.id, pool);
      assert.ok(before);

      const payload = {
        expectedContentVersion: 1,
        selection: {
          fields: ["model"],
          attributeKeys: ["storage_capacity"],
        },
        idempotencyKey: "apply_noop_1",
      };

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;
      const res = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload),
        offer.id,
        proposal.id,
      );

      assert.equal(res.status, 200);
      const json = (await res.json()) as { applicationReceipt: Record<string, unknown> };
      assert.equal(json.applicationReceipt.versionBefore, 1);
      assert.equal(json.applicationReceipt.versionAfter, 1);
      assert.deepEqual(json.applicationReceipt.changes, {});

      const after = await getOfferById(owner.userId, offer.id, pool);
      assert.ok(after);
      assert.equal(after.contentVersion, 1);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "updatedAt ne doit pas changer");
    });

    test("répétition idempotente : renvoi du reçu initial même si la proposition est devenue obsolète", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "iPhone 12 128 Go",
      }, pool);

      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const payload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "apply_repeatable_key",
      };

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      // 1. Première exécution
      const res1 = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(res1.status, 200);
      const json1 = (await res1.json()) as { applicationReceipt: Record<string, unknown> };
      assert.equal(json1.applicationReceipt.versionAfter, 2);

      // Maintenant, offer.contentVersion vaut 2, proposal.sourceContentVersion vaut 1 (obsolète !)
      // 2. Répétition avec la même clé et la même requête
      const res2 = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(res2.status, 200);
      const json2 = (await res2.json()) as { applicationReceipt: Record<string, unknown> };
      assert.deepEqual(json2, json1, "Le reçu retourné doit être rigoureusement identique");

      // Vérification : exactement 1 reçu en base
      const countRes = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2",
        [owner.userId, payload.idempotencyKey],
      );
      assert.equal(countRes.rows[0].count, "1");
    });

    test("authentification et droits : 401 sur session invalide et 404 indistinguable sur ressource étrangère ou inexistante", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const payload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "auth_test_key",
      };

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      // 1. Sans cookie
      const resNoCookie = await handlers.offers.apply(
        httpRequest("POST", path, undefined, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(resNoCookie.status, 401);
      assertNoStore(resNoCookie);
      assert.equal((await resNoCookie.json() as { error: { code: string } }).error.code, "authentication_required");

      // 2. Cookie révoqué
      const tempUser = await login();
      await revokeSession(tempUser.token, { pool, now: clock.now });
      const resRevoked = await handlers.offers.apply(
        httpRequest("POST", path, tempUser.cookie, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(resRevoked.status, 401);

      // 3. Compte suspendu
      const suspendedUser = await login();
      await updateUser({ id: suspendedUser.userId, expectedVersion: 1, status: "suspended" }, pool);
      const resSuspended = await handlers.offers.apply(
        httpRequest("POST", path, suspendedUser.cookie, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(resSuspended.status, 401);

      // 4. Utilisateur tiers (ressource étrangère) -> 404
      const resStranger = await handlers.offers.apply(
        httpRequest("POST", path, other.cookie, payload),
        offer.id,
        proposal.id,
      );
      assert.equal(resStranger.status, 404);
      assertNoStore(resStranger);
      const errStranger = (await resStranger.json()) as { error: { code: string; message: string } };
      assert.equal(errStranger.error.code, "resource_not_found");
      assert.equal(errStranger.error.message, "Ressource introuvable.");

      // 5. Ressource inexistante -> 404 avec exactement le même corps
      const nonExistentId = randomUUID();
      const nonExistentPath = `/api/offers/${nonExistentId}/extraction-proposals/${proposal.id}/apply`;
      const resNonExistent = await handlers.offers.apply(
        httpRequest("POST", nonExistentPath, owner.cookie, payload),
        nonExistentId,
        proposal.id,
      );
      assert.equal(resNonExistent.status, 404);
      const errNonExistent = (await resNonExistent.json()) as { error: { code: string; message: string } };
      assert.deepEqual(errNonExistent, errStranger, "404 doit être indistinguable");
    });

    test("rattachement et proposition inexistante : 404 indistinguable sans révéler de proposition tierce", async () => {
      const offer1 = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const offer2 = await createOffer({ ownerId: owner.userId, rawText: "iPhone 13" }, pool);

      const prop1 = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer1.id,
      }, { pool });

      const payload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "attachment_test_key",
      };

      // 1. Proposition appartenant à offer1 appliquée sur le chemin de offer2
      const badPath = `/api/offers/${offer2.id}/extraction-proposals/${prop1.id}/apply`;
      const resBadAttachment = await handlers.offers.apply(
        httpRequest("POST", badPath, owner.cookie, payload),
        offer2.id,
        prop1.id,
      );
      assert.equal(resBadAttachment.status, 404);
      assertNoStore(resBadAttachment);
      const errBad = (await resBadAttachment.json()) as { error: { code: string; message: string } };
      assert.equal(errBad.error.code, "resource_not_found");
      assert.equal(errBad.error.message, "Ressource introuvable.");

      // 2. Proposition inexistante sur offer1
      const inexistentPropId = randomUUID();
      const inexistentPath = `/api/offers/${offer1.id}/extraction-proposals/${inexistentPropId}/apply`;
      const resInexistent = await handlers.offers.apply(
        httpRequest("POST", inexistentPath, owner.cookie, payload),
        offer1.id,
        inexistentPropId,
      );
      assert.equal(resInexistent.status, 404);
      const errInexistent = (await resInexistent.json()) as typeof errBad;
      assert.deepEqual(errInexistent, errBad, "404 proposition inexistante doit être identique à mauvais rattachement");
    });

    test("protection Origin : CSRF obligatoire sur les requêtes POST", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const payload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "origin_test_key",
      };
      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      // Sans origin
      const resNoOrigin = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload, null),
        offer.id,
        proposal.id,
      );
      assert.equal(resNoOrigin.status, 403);
      assert.equal((await resNoOrigin.json() as { error: { code: string } }).error.code, "invalid_origin");

      // Mauvaise origin
      const resBadOrigin = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, payload, "https://evil.attacker.com"),
        offer.id,
        proposal.id,
      );
      assert.equal(resBadOrigin.status, 403);
    });

    test("validation stricte du corps JSON et rejet des propriétés inconnues et injections métier", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      const assertInvalid = async (body: unknown, message = "") => {
        const req = httpRequest("POST", path, owner.cookie, body);
        const res = await handlers.offers.apply(req, offer.id, proposal.id);
        assert.equal(res.status, 400, `Attendu 400 pour ${message}`);
        const data = (await res.json()) as { error: { code: string } };
        assert.equal(data.error.code, "invalid_request");
      };

      // 1. Corps non JSON (ex: chaîne simple)
      const rawReq = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { cookie: owner.cookie, origin: ORIGIN, "content-type": "text/plain" },
        body: "non-json string",
      });
      const resRaw = await handlers.offers.apply(rawReq, offer.id, proposal.id);
      assert.equal(resRaw.status, 400);

      // 2. Corps vide (0 octet)
      const emptyReq = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { cookie: owner.cookie, origin: ORIGIN },
      });
      const resEmpty = await handlers.offers.apply(emptyReq, offer.id, proposal.id);
      assert.equal(resEmpty.status, 400);

      // 3. Propriétés inconnues au premier niveau (tentative d'injection métier ou identité)
      await assertInvalid(
        {
          expectedContentVersion: 1,
          selection: { fields: ["model"] },
          idempotencyKey: "k1",
          rawText: "injection_metier",
        },
        "propriété rawText non autorisée",
      );

      await assertInvalid(
        {
          expectedContentVersion: 1,
          selection: { fields: ["model"] },
          idempotencyKey: "k2",
          ownerId: randomUUID(),
        },
        "propriété ownerId non autorisée",
      );

      await assertInvalid(
        {
          expectedContentVersion: 1,
          selection: { fields: ["model"] },
          idempotencyKey: "k3",
          proposal: { model: "faux" },
        },
        "propriété proposal non autorisée",
      );

      // 4. Propriétés inconnues dans selection
      await assertInvalid(
        {
          expectedContentVersion: 1,
          selection: { fields: ["model"], extraField: true },
          idempotencyKey: "k4",
        },
        "propriété extraField dans selection",
      );

      // 5. expectedContentVersion manquant ou invalide
      await assertInvalid(
        { selection: { fields: ["model"] }, idempotencyKey: "k5" },
        "expectedContentVersion manquant",
      );
      await assertInvalid(
        { expectedContentVersion: 0, selection: { fields: ["model"] }, idempotencyKey: "k6" },
        "expectedContentVersion <= 0",
      );
      await assertInvalid(
        { expectedContentVersion: "1", selection: { fields: ["model"] }, idempotencyKey: "k7" },
        "expectedContentVersion chaîne",
      );

      // 6. idempotencyKey manquante ou vide
      await assertInvalid(
        { expectedContentVersion: 1, selection: { fields: ["model"] } },
        "idempotencyKey manquante",
      );
      await assertInvalid(
        { expectedContentVersion: 1, selection: { fields: ["model"] }, idempotencyKey: "   " },
        "idempotencyKey vide",
      );

      // 7. selection vide ou non-objet
      await assertInvalid(
        { expectedContentVersion: 1, selection: {}, idempotencyKey: "k8" },
        "selection vide",
      );
      await assertInvalid(
        { expectedContentVersion: 1, selection: { fields: [] }, idempotencyKey: "k9" },
        "selection fields vide",
      );
    });

    test("rejet dépassement de taille de flux (413 payload_too_large)", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      const streamState = { cancelled: false };
      const stream = createOversizedStream(48 * 1024, streamState);

      const req = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "content-length": "0", // tentative de contournement
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const res = await handlers.offers.apply(req, offer.id, proposal.id);

      assert.equal(res.status, 413);
      assert.equal(streamState.cancelled, true, "Flux annulé au dépassement de 32 Kio");
      const err = (await res.json()) as { error: { code: string } };
      assert.equal(err.error.code, "payload_too_large");
    });

    test("gestion des conflits 409 : conflit d'idempotence, version obsolète, proposition obsolète, ressource archivée", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      // 1. Conflit d'idempotence (même clé avec une requête divergente)
      const initialPayload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "conflict_key_1",
      };
      const resInit = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, initialPayload),
        offer.id,
        proposal.id,
      );
      assert.equal(resInit.status, 200);

      // Rejeu avec la MÊME clé mais selection différente
      const conflictPayload = {
        expectedContentVersion: 1,
        selection: { fields: ["category"] },
        idempotencyKey: "conflict_key_1",
      };
      const resConflict = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, conflictPayload),
        offer.id,
        proposal.id,
      );
      assert.equal(resConflict.status, 409);
      assert.equal((await resConflict.json() as { error: { code: string } }).error.code, "conflict");

      // 2. Conflit de version (stale_version)
      // offer.contentVersion est désormais 2. Si on tente d'appliquer une nouvelle clé en prétendant expectedContentVersion = 1 :
      const staleVersionPayload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "new_key_stale_version",
      };
      const resStaleVer = await handlers.offers.apply(
        httpRequest("POST", path, owner.cookie, staleVersionPayload),
        offer.id,
        proposal.id,
      );
      assert.equal(resStaleVer.status, 409);
      assert.equal((await resStaleVer.json() as { error: { code: string } }).error.code, "stale_version");

      // 3. Conflit de proposition obsolète (stale_proposal)
      // Créons une nouvelle offre avec une proposition, puis modifions le texte de l'offre
      const offerStaleProp = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const propStale = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offerStaleProp.id,
      }, { pool });

      // On modifie l'offre pour passer à la version 2 avec un texte différent
      await updateOffer({
        id: offerStaleProp.id,
        ownerId: owner.userId,
        expectedContentVersion: 1,
        changes: { rawText: "iPhone 12 Pro Max" },
      }, pool);

      const stalePropPath = `/api/offers/${offerStaleProp.id}/extraction-proposals/${propStale.id}/apply`;
      const resStaleProp = await handlers.offers.apply(
        httpRequest("POST", stalePropPath, owner.cookie, {
          expectedContentVersion: 2, // version attendue correspond à l'offre
          selection: { fields: ["model"] },
          idempotencyKey: "stale_prop_key",
        }),
        offerStaleProp.id,
        propStale.id,
      );
      assert.equal(resStaleProp.status, 409);
      assert.equal((await resStaleProp.json() as { error: { code: string } }).error.code, "stale_proposal");

      // 4. Ressource archivée (resource_archived)
      const offerArchived = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12" }, pool);
      const propArchived = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offerArchived.id,
      }, { pool });

      await archiveOffer(owner.userId, offerArchived.id, 1, pool);

      const archivedPath = `/api/offers/${offerArchived.id}/extraction-proposals/${propArchived.id}/apply`;
      const resArchived = await handlers.offers.apply(
        httpRequest("POST", archivedPath, owner.cookie, {
          expectedContentVersion: 2,
          selection: { fields: ["model"] },
          idempotencyKey: "archived_key",
        }),
        offerArchived.id,
        propArchived.id,
      );
      assert.equal(resArchived.status, 409);
      assert.equal((await resArchived.json() as { error: { code: string } }).error.code, "resource_archived");
    });

    test("les Route Handlers Next.js /api/.../[id]/extraction-proposals/[proposalId]/apply sont fonctionnels", async () => {
      const dummyId = randomUUID();
      const dummyPropId = randomUUID();
      const offerPost = await postOfferProposalApplyRoute(
        httpRequest("POST", `/api/offers/${dummyId}/extraction-proposals/${dummyPropId}/apply`),
        { params: Promise.resolve({ id: dummyId, proposalId: dummyPropId }) },
      );
      assert.equal(offerPost.status, 401);
      assertNoStore(offerPost);

      const demandPost = await postDemandProposalApplyRoute(
        httpRequest("POST", `/api/demands/${dummyId}/extraction-proposals/${dummyPropId}/apply`),
        { params: Promise.resolve({ id: dummyId, proposalId: dummyPropId }) },
      );
      assert.equal(demandPost.status, 401);
      assertNoStore(demandPost);
    });

    test("concurrence HTTP avec deux connexions PostgreSQL distinctes synchronisées", async () => {
      const firstPid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await secondPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.notEqual(firstPid, secondPid);

      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12 128 Go" }, pool);
      const proposal = await createCatalogExtractionProposal({
        ownerId: owner.userId,
        resourceType: "offer",
        resourceId: offer.id,
      }, { pool });

      const tx1Reached = deferred();
      const tx1Release = deferred();

      // Handler 1 avec crochet beforeUpdate branché sur pool 1
      const handlers1 = createCatalogExtractionHttpHandlers({
        pool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
        beforeUpdate: async () => {
          tx1Reached.resolve();
          await tx1Release.promise;
        },
      });

      // Handler 2 branché sur secondPool
      const handlers2 = createCatalogExtractionHttpHandlers({
        pool: secondPool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });

      const payload = {
        expectedContentVersion: 1,
        selection: { fields: ["model"] },
        idempotencyKey: "http_concurrent_same_key",
      };

      const path = `/api/offers/${offer.id}/extraction-proposals/${proposal.id}/apply`;

      const run1 = handlers1.offers.apply(httpRequest("POST", path, owner.cookie, payload), offer.id, proposal.id);

      await tx1Reached.promise;

      // Req2 démarre pendant que Req1 est sous verrou transactionnel
      const run2 = handlers2.offers.apply(httpRequest("POST", path, owner.cookie, payload), offer.id, proposal.id);

      const blocked = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(blocked, true, "Req2 doit être bloquée par le verrou PostgreSQL de Req1");

      tx1Release.resolve();

      const [res1, res2] = await Promise.all([run1, run2]);

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);

      const json1 = (await res1.json()) as { applicationReceipt: Record<string, unknown> };
      const json2 = (await res2.json()) as { applicationReceipt: Record<string, unknown> };

      assert.equal(json1.applicationReceipt.id, json2.applicationReceipt.id, "Même ID de reçu retourné");
      assert.equal(json1.applicationReceipt.versionAfter, 2);

      const receiptsCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2",
        [owner.userId, payload.idempotencyKey],
      );
      assert.equal(receiptsCount.rows[0].count, "1", "Exactement un reçu enregistré");
    });

    test("rejet du caractère NUL U+0000 dans idempotencyKey (début, milieu, fin) et témoins Unicode valides avec répétition", async () => {
      for (const resourceType of ["offer", "demand"] as const) {
        const create = resourceType === "offer" ? createOffer : createDemand;
        const getResource = resourceType === "offer" ? getOfferById : getDemandById;
        const entity = resourceType === "offer" ? "offers" : "demands";
        const resource = await create({ ownerId: owner.userId, rawText: "iPhone 12 128 Go" }, pool);
        const proposal = await createCatalogExtractionProposal(
          { ownerId: owner.userId, resourceType, resourceId: resource.id },
          { pool },
        );

        const before = await getResource(owner.userId, resource.id, pool);
        assert.ok(before);

        const path = `/api/${entity}/${resource.id}/extraction-proposals/${proposal.id}/apply`;

        // Cas NUL au début, au milieu et à la fin
        const nulKeys = [
          { position: "début", key: "\0http_nul_start" },
          { position: "milieu", key: "http_nul_\0_middle" },
          { position: "fin", key: "http_nul_end\0" },
        ];

        for (const { position, key } of nulKeys) {
          const req = httpRequest("POST", path, owner.cookie, {
            expectedContentVersion: 1,
            selection: { fields: ["model"] },
            idempotencyKey: key,
          });

          const res = await handlers[entity].apply(req, resource.id, proposal.id);
          assert.equal(res.status, 400, `Attendu 400 pour NUL au ${position}`);
          assertNoStore(res);

          const data = (await res.json()) as { error: { code: string; message: string } };
          assert.equal(data.error.code, "invalid_request");
          assert.ok(
            data.error.message.includes("NUL"),
            `Message d'erreur doit mentionner NUL au ${position} : ${data.error.message}`,
          );

          // Absence de modification catalogue
          const current = await getResource(owner.userId, resource.id, pool);
          assert.equal(current?.contentVersion, 1);
          assert.equal(current?.updatedAt.getTime(), before.updatedAt.getTime());
          assert.equal(current?.model, null);

          // Absence de reçu enregistré
          const countRes = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND ${resourceType === "offer" ? "offer_id" : "demand_id"} = $2`,
            [owner.userId, resource.id],
          );
          assert.equal(countRes.rows[0].count, "0");
        }

        // Témoin Unicode valide avec répétition idempotente
        const validUnicodeKey = `http_unicode_é_à_${resourceType}_✓`;
        const validReq = httpRequest("POST", path, owner.cookie, {
          expectedContentVersion: 1,
          selection: { fields: ["model"] },
          idempotencyKey: validUnicodeKey,
        });

        const validRes = await handlers[entity].apply(validReq, resource.id, proposal.id);
        assert.equal(validRes.status, 200);
        assertNoStore(validRes);

        const validJson = (await validRes.json()) as { applicationReceipt: Record<string, unknown> };
        assert.ok(validJson.applicationReceipt);
        assert.equal(validJson.applicationReceipt.versionAfter, 2);

        // Répétition idempotente avec la même clé Unicode
        const retryReq = httpRequest("POST", path, owner.cookie, {
          expectedContentVersion: 1,
          selection: { fields: ["model"] },
          idempotencyKey: validUnicodeKey,
        });

        const retryRes = await handlers[entity].apply(retryReq, resource.id, proposal.id);
        assert.equal(retryRes.status, 200);
        assertNoStore(retryRes);

        const retryJson = (await retryRes.json()) as { applicationReceipt: Record<string, unknown> };
        assert.equal(retryJson.applicationReceipt.id, validJson.applicationReceipt.id);
        assert.deepEqual(retryJson, validJson);

        // Exactement 1 reçu enregistré
        const finalCount = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM catalog_extraction_applications WHERE owner_id = $1 AND idempotency_key = $2`,
          [owner.userId, validUnicodeKey],
        );
        assert.equal(finalCount.rows[0].count, "1");
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
