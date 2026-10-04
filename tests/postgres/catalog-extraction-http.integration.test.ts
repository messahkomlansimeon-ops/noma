import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, revokeSession, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import {
  archiveOffer,
  createDemand,
  createOffer,
  getOfferById,
  updateOffer,
} from "../../lib/server/catalog";
import {
  CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES,
  createCatalogExtractionHttpHandlers,
  type CatalogExtractionHttpHandlers,
} from "../../lib/server/catalog-extraction/http";
import {
  GET as getOfferProposalsRoute,
  POST as postOfferProposalsRoute,
} from "../../app/api/offers/[id]/extraction-proposals/route";
import {
  GET as getDemandProposalsRoute,
  POST as postDemandProposalsRoute,
} from "../../app/api/demands/[id]/extraction-proposals/route";
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
  return `+22507${phoneSequence.toString().padStart(8, "0")}`;
}

function httpRequest(
  method: "GET" | "POST",
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

const localRequire = createRequire(__filename);
const { NodeNextRequest } = localRequire("next/dist/server/base-http/node.js");
const { NextRequestAdapter } = localRequire("next/dist/server/web/spec-extension/adapters/next-request.js");

function createNextAdaptedRequest(
  url: string,
  headers: Record<string, string>,
  bytes?: Uint8Array | string,
): { request: Request; cleanup: () => void } {
  const socket = new Socket();
  const incoming = new IncomingMessage(socket);
  incoming.method = "POST";
  incoming.url = url;
  incoming.headers = { ...headers };
  if (bytes) {
    incoming.push(Buffer.from(bytes));
  }
  incoming.push(null);
  const request = NextRequestAdapter.fromNodeNextRequest(
    new NodeNextRequest(incoming),
    new AbortController().signal,
  ) as Request;
  return {
    request,
    cleanup: () => socket.destroy(),
  };
}

function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
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
  test("pré-requis PostgreSQL dédié pour les propositions d'extraction HTTP", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test HTTP d'extraction n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour les propositions d'extraction HTTP", () => {
    throw configuredUrlError;
  });
} else {
  describe("API privée des propositions d'extraction", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let handlers: CatalogExtractionHttpHandlers;
    let owner: Login;
    let other: Login;
    let schemaCleaned = false;

    async function login(authClock: TestClock = clock, ip = "198.51.100.71"): Promise<Login> {
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
      handlers = createCatalogExtractionHttpHandlers({
        pool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });
      owner = await login();
      other = await login();
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

    test("authentification requise : 401 pour session absente, révoquée ou invalide", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "iPhone 12 128 Go" }, pool);

      // Sans cookie
      const noAuthGet = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals`),
        offer.id,
      );
      assert.equal(noAuthGet.status, 401);
      assertNoStore(noAuthGet);
      assert.equal(
        (await noAuthGet.json() as { error: { code: string } }).error.code,
        "authentication_required",
      );

      const noAuthPost = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`),
        offer.id,
      );
      assert.equal(noAuthPost.status, 401);
      assertNoStore(noAuthPost);

      // Cookie révoqué
      const temporary = await login();
      await revokeSession(temporary.token, { pool, now: clock.now });
      const revokedResponse = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, temporary.cookie),
        offer.id,
      );
      assert.equal(revokedResponse.status, 401);
    });

    test("propriétaire : 404 indistinguable entre ressource étrangère et ressource absente", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre propriétaire" }, pool);
      const demand = await createDemand({ ownerId: owner.userId, rawText: "Demande propriétaire" }, pool);
      const absentId = randomUUID();

      // Offre étrangère vs absente en GET
      const foreignOfferGet = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals`, other.cookie),
        offer.id,
      );
      const absentOfferGet = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${absentId}/extraction-proposals`, other.cookie),
        absentId,
      );
      assert.equal(foreignOfferGet.status, 404);
      assert.equal(absentOfferGet.status, 404);
      assert.deepEqual(await foreignOfferGet.json(), await absentOfferGet.json());

      // Offre étrangère vs absente en POST
      const foreignOfferPost = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, other.cookie),
        offer.id,
      );
      const absentOfferPost = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${absentId}/extraction-proposals`, other.cookie),
        absentId,
      );
      assert.equal(foreignOfferPost.status, 404);
      assert.equal(absentOfferPost.status, 404);
      assert.deepEqual(await foreignOfferPost.json(), await absentOfferPost.json());

      // Demande étrangère vs absente en GET et POST
      const foreignDemandGet = await handlers.demands.list(
        httpRequest("GET", `/api/demands/${demand.id}/extraction-proposals`, other.cookie),
        demand.id,
      );
      const absentDemandGet = await handlers.demands.list(
        httpRequest("GET", `/api/demands/${absentId}/extraction-proposals`, other.cookie),
        absentId,
      );
      assert.equal(foreignDemandGet.status, 404);
      assert.equal(absentDemandGet.status, 404);
      assert.deepEqual(await foreignDemandGet.json(), await absentDemandGet.json());

      // Identifiant non UUID -> 400 invalid_request
      const invalidIdResponse = await handlers.offers.list(
        httpRequest("GET", "/api/offers/not-a-uuid/extraction-proposals", owner.cookie),
        "not-a-uuid",
      );
      assert.equal(invalidIdResponse.status, 400);
      assert.equal(
        (await invalidIdResponse.json() as { error: { code: string } }).error.code,
        "invalid_request",
      );
    });

    test("protection Origin sur POST : 403 si origine absente ou non autorisée", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre test origin" }, pool);

      // Origine pirate
      const badOrigin = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie, undefined, "https://evil.test"),
        offer.id,
      );
      assert.equal(badOrigin.status, 403);
      assert.equal((await badOrigin.json() as { error: { code: string } }).error.code, "invalid_origin");

      // Origine absente
      const missingOrigin = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie, undefined, null),
        offer.id,
      );
      assert.equal(missingOrigin.status, 403);
      assert.equal((await missingOrigin.json() as { error: { code: string } }).error.code, "invalid_origin");

      // Aucune proposition créée
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
        [offer.id],
      );
      assert.equal(count.rows[0].count, "0");
    });

    test("corps de requête POST : refus des champs métier et payload trop volumineux", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre test corps" }, pool);

      // Corps contenant des champs métier non autorisés
      const bodyWithFields = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie, {
          rawText: "tentative d'injection",
          price: 10_000,
        }),
        offer.id,
      );
      assert.equal(bodyWithFields.status, 400);
      assert.equal((await bodyWithFields.json() as { error: { code: string } }).error.code, "invalid_request");

      // Content-Type non JSON
      const badContentType = new Request(`${ORIGIN}/api/offers/${offer.id}/extraction-proposals`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "content-type": "text/plain",
        },
        body: "texte brut",
      });
      const resBadContent = await handlers.offers.create(badContentType, offer.id);
      assert.equal(resBadContent.status, 400);

      // Payload dépassant CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES (32 Kio)
      const chunks = Array.from(
        { length: 4 },
        () => new TextEncoder().encode("a".repeat(CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES / 2)),
      );
      const state = { cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      });
      const oversized = new Request(`${ORIGIN}/api/offers/${offer.id}/extraction-proposals`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const tooLarge = await handlers.offers.create(oversized, offer.id);
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json() as { error: { code: string } }).error.code, "payload_too_large");
      assert.equal(state.cancelled, true);
    });

    test("régressions offres et demandes sur le corps POST : flux vide, {} valide, contenu interdit et dépassement réellement lu", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre régression corps POST" }, pool);
      const demand = await createDemand({ ownerId: owner.userId, rawText: "Demande régression corps POST" }, pool);

      const targets = [
        {
          type: "offer" as const,
          id: offer.id,
          tableName: "catalog_extraction_proposals",
          fkColumn: "offer_id",
          createHandler: handlers.offers.create,
          basePath: `/api/offers/${offer.id}/extraction-proposals`,
        },
        {
          type: "demand" as const,
          id: demand.id,
          tableName: "catalog_extraction_proposals",
          fkColumn: "demand_id",
          createHandler: handlers.demands.create,
          basePath: `/api/demands/${demand.id}/extraction-proposals`,
        },
      ];

      for (const target of targets) {
        const url = `${ORIGIN}${target.basePath}`;
        const baseHeaders = { cookie: owner.cookie, origin: ORIGIN };

        // 1. Flux vide : acceptation (200), no-store, idempotence
        // Cas 1.a : ReadableStream vide sans Content-Type
        const emptyStreamReq1 = new Request(url, {
          method: "POST",
          headers: baseHeaders,
          body: createEmptyStream(),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const res1 = await target.createHandler(emptyStreamReq1, target.id);
        assert.equal(res1.status, 200, `${target.type}: empty stream without content-type should be 200`);
        assertNoStore(res1);
        const data1 = await res1.json() as { extractionProposal: { id: string; resourceType: string } };
        assert.equal(data1.extractionProposal.resourceType, target.type);
        const initialProposalId = data1.extractionProposal.id;

        // Cas 1.b : ReadableStream vide avec Content-Length: 0
        const emptyStreamReq2 = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-length": "0" },
          body: createEmptyStream(),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const res2 = await target.createHandler(emptyStreamReq2, target.id);
        assert.equal(res2.status, 200, `${target.type}: empty stream with content-length: 0 should be 200`);
        const data2 = await res2.json() as typeof data1;
        assert.equal(data2.extractionProposal.id, initialProposalId, "Idempotence réutilisée");

        // Cas 1.c : ReadableStream vide avec Content-Type: application/json
        const emptyStreamReq3 = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json", "content-length": "0" },
          body: createEmptyStream(),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const res3 = await target.createHandler(emptyStreamReq3, target.id);
        assert.equal(res3.status, 200, `${target.type}: empty stream with application/json should be 200`);
        const data3 = await res3.json() as typeof data1;
        assert.equal(data3.extractionProposal.id, initialProposalId, "Idempotence réutilisée");

        // Cas 1.d : NextRequestAdapter flux IncomingMessage vide (fidèle au runtime Next.js)
        const nextReq = createNextAdaptedRequest(url, baseHeaders);
        try {
          const resNext = await target.createHandler(nextReq.request, target.id);
          assert.equal(resNext.status, 200, `${target.type}: NextRequestAdapter empty stream should be 200`);
          assertNoStore(resNext);
          const dataNext = await resNext.json() as typeof data1;
          assert.equal(dataNext.extractionProposal.id, initialProposalId, "Idempotence réutilisée");
        } finally {
          nextReq.cleanup();
        }

        // Vérification qu'une seule proposition est présente en base
        const countQuery = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${target.tableName} WHERE ${target.fkColumn} = $1`,
          [target.id],
        );
        assert.equal(countQuery.rows[0].count, "1", `${target.type}: une seule proposition persistée`);

        // 2. Corps {} valide : accepté (200), no-store, idempotence
        const validJsonReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const resJson = await target.createHandler(validJsonReq, target.id);
        assert.equal(resJson.status, 200, `${target.type}: {} valid should be 200`);
        assertNoStore(resJson);
        const dataJson = await resJson.json() as typeof data1;
        assert.equal(dataJson.extractionProposal.id, initialProposalId, "Idempotence réutilisée");

        // 3. Contenu interdit : rejet strict avec 400 invalid_request
        // 3.a. Champs métier non autorisés
        const forbiddenFieldsReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: JSON.stringify({ rawText: "injection", malicious: true }),
        });
        const resForbidden = await target.createHandler(forbiddenFieldsReq, target.id);
        assert.equal(resForbidden.status, 400);
        assert.equal((await resForbidden.json() as { error: { code: string } }).error.code, "invalid_request");

        // 3.b. Tableau JSON interdit
        const arrayReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: JSON.stringify(["interdit"]),
        });
        const resArray = await target.createHandler(arrayReq, target.id);
        assert.equal(resArray.status, 400);
        assert.equal((await resArray.json() as { error: { code: string } }).error.code, "invalid_request");

        // 3.c. Primitif JSON non-objet interdit
        const primitiveReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: JSON.stringify("chaine_interdite"),
        });
        const resPrimitive = await target.createHandler(primitiveReq, target.id);
        assert.equal(resPrimitive.status, 400);
        assert.equal((await resPrimitive.json() as { error: { code: string } }).error.code, "invalid_request");

        // 3.d. JSON syntaxiquement corrompu
        const malformedJsonReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: "{ unclosed_json: ",
        });
        const resMalformed = await target.createHandler(malformedJsonReq, target.id);
        assert.equal(resMalformed.status, 400);
        assert.equal((await resMalformed.json() as { error: { code: string } }).error.code, "invalid_request");

        // 3.e. Corps non-JSON non vide (ex: text/plain)
        const textReq = new Request(url, {
          method: "POST",
          headers: { ...baseHeaders, "content-type": "text/plain" },
          body: "texte non json",
        });
        const resText = await target.createHandler(textReq, target.id);
        assert.equal(resText.status, 400);
        assert.equal((await resText.json() as { error: { code: string } }).error.code, "invalid_request");

        // 4. Dépassement réellement lu (avec tentative de contournement Content-Length: 0)
        const streamState = { cancelled: false };
        const oversizedStream = createOversizedStream(48 * 1024, streamState);
        const bypassAttemptReq = new Request(url, {
          method: "POST",
          headers: {
            ...baseHeaders,
            "content-length": "0", // tentative de contournement par en-tête menteur
            "content-type": "application/json",
          },
          body: oversizedStream,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const resOversized = await target.createHandler(bypassAttemptReq, target.id);
        assert.equal(resOversized.status, 413, `${target.type}: bypass Content-Length: 0 must be caught at 413`);
        assert.equal((await resOversized.json() as { error: { code: string } }).error.code, "payload_too_large");
        assert.equal(streamState.cancelled, true, `${target.type}: stream cancelled upon exceeding 32 Kio`);

        // 5. Préservation des sécurités sur flux vide : authentification et Origin
        // Sans authentification
        const noAuthStreamReq = new Request(url, {
          method: "POST",
          headers: { origin: ORIGIN },
          body: createEmptyStream(),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const resNoAuth = await target.createHandler(noAuthStreamReq, target.id);
        assert.equal(resNoAuth.status, 401, "Flux vide sans auth -> 401");
        assertNoStore(resNoAuth);

        // Mauvaise Origin
        const badOriginStreamReq = new Request(url, {
          method: "POST",
          headers: { cookie: owner.cookie, origin: "https://evil.test" },
          body: createEmptyStream(),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        const resBadOrigin = await target.createHandler(badOriginStreamReq, target.id);
        assert.equal(resBadOrigin.status, 403, "Flux vide mauvaise origin -> 403");
      }
    });

    test("POST création, réutilisation et idempotence sans modification du catalogue", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "iPhone 12 128 Go à Cocody, prix 150000 FCFA",
        model: "iPhone 12 saisi par humain",
        quantity: 2,
        price: { amount: 150_000, currency: "XOF" },
      }, pool);

      // 1. Premier POST : création
      const firstResponse = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie, {}),
        offer.id,
      );
      assert.equal(firstResponse.status, 200);
      assertNoStore(firstResponse);
      const firstBody = await firstResponse.json() as {
        extractionProposal: {
          id: string;
          sourceContentVersion: number;
          sourceRawText: string;
          isStale: boolean;
          proposal: { fields: { model: string | null } };
        };
      };
      assert.ok(firstBody.extractionProposal.id);
      assert.equal(firstBody.extractionProposal.sourceContentVersion, 1);
      assert.equal(firstBody.extractionProposal.sourceRawText, offer.rawText);
      assert.equal(firstBody.extractionProposal.isStale, false);

      // 2. Second POST : réutilisation idempotente
      const secondResponse = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      assert.equal(secondResponse.status, 200);
      const secondBody = await secondResponse.json() as typeof firstBody;
      assert.equal(secondBody.extractionProposal.id, firstBody.extractionProposal.id);

      // Une seule ligne en base
      const rowCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
        [offer.id],
      );
      assert.equal(rowCount.rows[0].count, "1");

      // Valeurs humaines du catalogue intactes
      const offerInDb = await getOfferById(owner.userId, offer.id, pool);
      assert.equal(offerInDb?.model, "iPhone 12 saisi par humain");
      assert.equal(offerInDb?.quantity, 2);
      assert.equal(offerInDb?.contentVersion, 1);

      // Idem pour une demande
      const demand = await createDemand({
        ownerId: owner.userId,
        rawText: "Canapé 3 places à Cocody, budget 200000 FCFA",
      }, pool);
      const demandResponse = await handlers.demands.create(
        httpRequest("POST", `/api/demands/${demand.id}/extraction-proposals`, owner.cookie),
        demand.id,
      );
      assert.equal(demandResponse.status, 200);
      const demandBody = await demandResponse.json() as {
        extractionProposal: { resourceType: string; isStale: boolean };
      };
      assert.equal(demandBody.extractionProposal.resourceType, "demand");
      assert.equal(demandBody.extractionProposal.isStale, false);
    });

    test("GET lecture seule : aucune extraction déclenchée et pagination SQL stable", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "MacBook Air M2 256 Go" }, pool);

      // GET avant toute extraction : liste vide, 200 OK
      const emptyGet = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      assert.equal(emptyGet.status, 200);
      assertNoStore(emptyGet);
      const emptyBody = await emptyGet.json() as { extractionProposals: unknown[]; pagination: unknown };
      assert.deepEqual(emptyBody.extractionProposals, []);

      // Vérification : count reste à 0, aucune extraction n'a été déclenchée par GET
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM catalog_extraction_proposals WHERE offer_id = $1",
        [offer.id],
      );
      assert.equal(count.rows[0].count, "0");

      // Création de 2 propositions distinctes via mise à jour de version
      await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      await updateOffer({
        id: offer.id,
        ownerId: owner.userId,
        expectedContentVersion: 1,
        changes: { rawText: "MacBook Air M2 512 Go" },
      }, pool);
      await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );

      // Pagination valide : limit=1&offset=0
      const page1 = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals?limit=1&offset=0`, owner.cookie),
        offer.id,
      );
      assert.equal(page1.status, 200);
      const body1 = await page1.json() as {
        extractionProposals: Array<{ sourceContentVersion: number; isStale: boolean }>;
        pagination: { limit: number; offset: number };
      };
      assert.equal(body1.extractionProposals.length, 1);
      assert.equal(body1.extractionProposals[0].sourceContentVersion, 2);
      assert.equal(body1.extractionProposals[0].isStale, false);
      assert.deepEqual(body1.pagination, { limit: 1, offset: 0 });

      // Pagination valide : limit=1&offset=1
      const page2 = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals?limit=1&offset=1`, owner.cookie),
        offer.id,
      );
      assert.equal(page2.status, 200);
      const body2 = await page2.json() as typeof body1;
      assert.equal(body2.extractionProposals.length, 1);
      assert.equal(body2.extractionProposals[0].sourceContentVersion, 1);
      assert.equal(body2.extractionProposals[0].isStale, true);
      assert.deepEqual(body2.pagination, { limit: 1, offset: 1 });

      // Pagination invalide : limit hors bornes, offset négatif, paramètre inconnu, doublons
      for (const invalidQuery of [
        "?limit=0",
        "?limit=101",
        "?offset=-1",
        "?limit=abc",
        "?offset=xyz",
        "?inconnu=1",
        "?limit=10&limit=20",
        "?offset=0&offset=5",
      ]) {
        const invalidResponse = await handlers.offers.list(
          httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals${invalidQuery}`, owner.cookie),
          offer.id,
        );
        assert.equal(invalidResponse.status, 400, `Query ${invalidQuery} devait produire 400`);
      }
    });

    test("archivage : 409 sur POST et isStale=true sur toutes les propositions de l'historique", async () => {
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Vélo de course" }, pool);
      await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );

      // Archivage de l'offre
      await archiveOffer(owner.userId, offer.id, 1, pool);

      // POST sur offre archivée -> 409 resource_archived
      const archivedPost = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      assert.equal(archivedPost.status, 409);
      assert.equal((await archivedPost.json() as { error: { code: string } }).error.code, "resource_archived");

      // GET sur offre archivée -> 200 avec isStale: true
      const historyGet = await handlers.offers.list(
        httpRequest("GET", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      assert.equal(historyGet.status, 200);
      const historyBody = await historyGet.json() as {
        extractionProposals: Array<{ isStale: boolean }>;
      };
      assert.equal(historyBody.extractionProposals.length, 1);
      assert.equal(historyBody.extractionProposals[0].isStale, true);
    });

    test("limites d'extraction : erreur métier documentée 400 (jamais un faux 503)", async () => {
      // Texte catalogue de 10 001 caractères (dépasse MAX_RAW_TEXT_CHARACTERS = 10 000 de l'extracteur)
      const oversizedText = "x".repeat(10_001);
      const offer = await createOffer({ ownerId: owner.userId, rawText: oversizedText }, pool);

      const response = await handlers.offers.create(
        httpRequest("POST", `/api/offers/${offer.id}/extraction-proposals`, owner.cookie),
        offer.id,
      );
      assert.notEqual(response.status, 503, "Ne doit pas être un faux 503");
      assert.equal(response.status, 400);
      assertNoStore(response);
      const body = await response.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, "extraction_validation_error");
      assert.ok(body.error.message.includes("invalide"));
    });

    test("les Route Handlers Next.js /api/.../[id]/extraction-proposals sont fonctionnels", async () => {
      const dummyId = randomUUID();
      const offerGet = await getOfferProposalsRoute(
        httpRequest("GET", `/api/offers/${dummyId}/extraction-proposals`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(offerGet.status, 401);
      assertNoStore(offerGet);

      const offerPost = await postOfferProposalsRoute(
        httpRequest("POST", `/api/offers/${dummyId}/extraction-proposals`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(offerPost.status, 401);
      assertNoStore(offerPost);

      const demandGet = await getDemandProposalsRoute(
        httpRequest("GET", `/api/demands/${dummyId}/extraction-proposals`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(demandGet.status, 401);

      const demandPost = await postDemandProposalsRoute(
        httpRequest("POST", `/api/demands/${dummyId}/extraction-proposals`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(demandPost.status, 401);
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
