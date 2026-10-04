import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, revokeSession, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import {
  activateDemand,
  ArchivedCatalogResourceError,
  archiveDemand,
  archiveOffer,
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogStatusTransitionError,
  CatalogValidationError,
  createDemand,
  createOffer,
  getDemandById,
  getOfferById,
  pauseOffer,
  publishOffer,
  satisfyDemand,
  StaleContentVersionError,
  updateUser,
} from "../../lib/server/catalog";
import {
  createCatalogHttpHandlers,
  type CatalogHttpHandlers,
} from "../../lib/server/catalog/http";
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
  method: "POST",
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function getPid(p: Pool): Promise<number> {
  const res = await p.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return res.rows[0].pid;
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
  test("pré-requis PostgreSQL dédié pour les transitions catalogue", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test transition catalogue n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour les transitions catalogue", () => {
    throw configuredUrlError;
  });
} else {
  describe("transitions de statut catalogue et API privées (Lot 1F)", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let pool2: Pool;
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
      pool2 = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
      handlers = createCatalogHttpHandlers({
        pool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });
      owner = await login(clock, "198.51.100.71");
      other = await login(clock, "198.51.100.72");
    });

    after(async () => {
      if (pool) await pool.end();
      if (pool2) await pool2.end();
      if (adminPool) {
        if (!schemaCleaned) await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    test("services directs : cycle nominal offres (draft -> published -> paused -> published)", async () => {
      const initial = await createOffer({
        ownerId: owner.userId,
        rawText: "Sac de riz 50kg disponible",
      }, pool);
      assert.equal(initial.status, "draft");
      assert.equal(initial.contentVersion, 1);

      // draft -> published
      const published = await publishOffer(owner.userId, initial.id, 1, pool);
      assert.equal(published.status, "published");
      assert.equal(published.contentVersion, 2);
      assert.ok(published.updatedAt.getTime() >= initial.updatedAt.getTime());

      // published -> paused
      const paused = await pauseOffer(owner.userId, initial.id, 2, pool);
      assert.equal(paused.status, "paused");
      assert.equal(paused.contentVersion, 3);
      assert.ok(paused.updatedAt.getTime() >= published.updatedAt.getTime());

      // paused -> published
      const republished = await publishOffer(owner.userId, initial.id, 3, pool);
      assert.equal(republished.status, "published");
      assert.equal(republished.contentVersion, 4);
    });

    test("services directs : cycle nominal demandes (draft -> active -> satisfied -> active)", async () => {
      const initial = await createDemand({
        ownerId: owner.userId,
        rawText: "Recherche groupe électrogène 5kVA",
      }, pool);
      assert.equal(initial.status, "draft");
      assert.equal(initial.contentVersion, 1);

      // draft -> active
      const activated = await activateDemand(owner.userId, initial.id, 1, pool);
      assert.equal(activated.status, "active");
      assert.equal(activated.contentVersion, 2);

      // active -> satisfied
      const satisfied = await satisfyDemand(owner.userId, initial.id, 2, pool);
      assert.equal(satisfied.status, "satisfied");
      assert.equal(satisfied.contentVersion, 3);

      // satisfied -> active
      const reactivated = await activateDemand(owner.userId, initial.id, 3, pool);
      assert.equal(reactivated.status, "active");
      assert.equal(reactivated.contentVersion, 4);
    });

    test("services directs : no-op / idempotence quand cible déjà atteinte avec version exacte", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "Moto Yamaha YBR",
      }, pool);
      const pub1 = await publishOffer(owner.userId, offer.id, 1, pool);
      assert.equal(pub1.status, "published");
      assert.equal(pub1.contentVersion, 2);

      // No-op sur publish déjà published avec version courante (2)
      const pub2 = await publishOffer(owner.userId, offer.id, 2, pool);
      assert.equal(pub2.status, "published");
      assert.equal(pub2.contentVersion, 2);
      assert.equal(pub2.updatedAt.getTime(), pub1.updatedAt.getTime());

      // Idem pour pause déjà paused
      const pause1 = await pauseOffer(owner.userId, offer.id, 2, pool);
      assert.equal(pause1.status, "paused");
      assert.equal(pause1.contentVersion, 3);

      const pause2 = await pauseOffer(owner.userId, offer.id, 3, pool);
      assert.equal(pause2.status, "paused");
      assert.equal(pause2.contentVersion, 3);
      assert.equal(pause2.updatedAt.getTime(), pause1.updatedAt.getTime());
    });

    test("services directs : transitions interdites et version obsolète", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "Table en teck",
      }, pool);
      assert.equal(offer.status, "draft");

      // draft -> paused est interdit pour une offre
      await assert.rejects(
        pauseOffer(owner.userId, offer.id, 1, pool),
        (err: unknown) => {
          assert.ok(err instanceof CatalogStatusTransitionError);
          assert.equal(err.currentStatus, "draft");
          assert.equal(err.targetStatus, "paused");
          return true;
        },
      );

      // Version obsolète : même si on tente une transition valide
      await assert.rejects(
        publishOffer(owner.userId, offer.id, 999, pool),
        (err: unknown) => {
          assert.ok(err instanceof StaleContentVersionError);
          return true;
        },
      );

      // Version obsolète MÊME si la cible est déjà atteinte
      const published = await publishOffer(owner.userId, offer.id, 1, pool);
      assert.equal(published.status, "published");
      await assert.rejects(
        publishOffer(owner.userId, offer.id, 1, pool), // version 1 est obsolète, la courante est 2
        (err: unknown) => {
          assert.ok(err instanceof StaleContentVersionError);
          return true;
        },
      );

      // Ressource archivée : refus direct avec ArchivedCatalogResourceError
      await archiveOffer(owner.userId, offer.id, 2, pool);
      await assert.rejects(
        publishOffer(owner.userId, offer.id, 3, pool),
        (err: unknown) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        },
      );
      await assert.rejects(
        pauseOffer(owner.userId, offer.id, 3, pool),
        (err: unknown) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        },
      );

      // Demande archivée : refus direct avec ArchivedCatalogResourceError
      const demand = await createDemand({
        ownerId: owner.userId,
        rawText: "Demande pour archivage direct",
      }, pool);
      await archiveDemand(owner.userId, demand.id, 1, pool);
      await assert.rejects(
        activateDemand(owner.userId, demand.id, 2, pool),
        (err: unknown) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        },
      );
      await assert.rejects(
        satisfyDemand(owner.userId, demand.id, 2, pool),
        (err: unknown) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        },
      );
    });

    test("services directs : isolation propriétaire stricte et ressource inexistante", async () => {
      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "Offre privée propriétaire A",
      }, pool);

      // Tiers tente de publier l'offre
      await assert.rejects(
        publishOffer(other.userId, offer.id, 1, pool),
        (err: unknown) => {
          assert.ok(err instanceof CatalogOwnershipError);
          return true;
        },
      );

      // ID inexistant
      const missingId = "00000000-0000-4000-8000-000000000000";
      await assert.rejects(
        publishOffer(owner.userId, missingId, 1, pool),
        (err: unknown) => {
          assert.ok(err instanceof CatalogNotFoundError);
          return true;
        },
      );
    });

    test("HTTP : cycle nominal complet offres (/publish et /pause)", async () => {
      const createdRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Café robusta 100kg" },
      ));
      assert.equal(createdRes.status, 201);
      const offerId = ((await createdRes.json()) as { offer: { id: string } }).offer.id;

      // 1. POST /publish depuis draft
      const pubRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offerId}/publish`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offerId,
      );
      assert.equal(pubRes.status, 200);
      assertNoStore(pubRes);
      const pubData = ((await pubRes.json()) as { offer: { status: string; contentVersion: number; updatedAt: string } }).offer;
      assert.equal(pubData.status, "published");
      assert.equal(pubData.contentVersion, 2);

      // 2. POST /publish idempotente (cible déjà atteinte, version 2 actuelle)
      const pubNoOpRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offerId}/publish`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        offerId,
      );
      assert.equal(pubNoOpRes.status, 200);
      const pubNoOpData = ((await pubNoOpRes.json()) as { offer: { status: string; contentVersion: number; updatedAt: string } }).offer;
      assert.equal(pubNoOpData.status, "published");
      assert.equal(pubNoOpData.contentVersion, 2);
      assert.equal(pubNoOpData.updatedAt, pubData.updatedAt);

      // 3. POST /pause depuis published
      const pauseRes = await handlers.offers.pause(
        httpRequest("POST", `/api/offers/${offerId}/pause`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        offerId,
      );
      assert.equal(pauseRes.status, 200);
      assertNoStore(pauseRes);
      const pauseData = ((await pauseRes.json()) as { offer: { status: string; contentVersion: number; updatedAt: string } }).offer;
      assert.equal(pauseData.status, "paused");
      assert.equal(pauseData.contentVersion, 3);

      // 4. POST /pause idempotente
      const pauseNoOpRes = await handlers.offers.pause(
        httpRequest("POST", `/api/offers/${offerId}/pause`, owner.cookie, {
          expectedContentVersion: 3,
        }),
        offerId,
      );
      assert.equal(pauseNoOpRes.status, 200);
      const pauseNoOpData = ((await pauseNoOpRes.json()) as { offer: { status: string; contentVersion: number; updatedAt: string } }).offer;
      assert.equal(pauseNoOpData.contentVersion, 3);
      assert.equal(pauseNoOpData.updatedAt, pauseData.updatedAt);

      // 5. POST /publish depuis paused
      const repubRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offerId}/publish`, owner.cookie, {
          expectedContentVersion: 3,
        }),
        offerId,
      );
      assert.equal(repubRes.status, 200);
      const repubData = ((await repubRes.json()) as { offer: { status: string; contentVersion: number } }).offer;
      assert.equal(repubData.status, "published");
      assert.equal(repubData.contentVersion, 4);
    });

    test("HTTP : cycle nominal complet demandes (/activate et /satisfy)", async () => {
      const createdRes = await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        { rawText: "Recherche développeur TypeScript senior" },
      ));
      assert.equal(createdRes.status, 201);
      const demandId = ((await createdRes.json()) as { demand: { id: string } }).demand.id;

      // 1. POST /activate depuis draft
      const actRes = await handlers.demands.activate(
        httpRequest("POST", `/api/demands/${demandId}/activate`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        demandId,
      );
      assert.equal(actRes.status, 200);
      assertNoStore(actRes);
      const actData = ((await actRes.json()) as { demand: { status: string; contentVersion: number; updatedAt: string } }).demand;
      assert.equal(actData.status, "active");
      assert.equal(actData.contentVersion, 2);

      // 2. POST /activate idempotente
      const actNoOpRes = await handlers.demands.activate(
        httpRequest("POST", `/api/demands/${demandId}/activate`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        demandId,
      );
      assert.equal(actNoOpRes.status, 200);
      const actNoOpData = ((await actNoOpRes.json()) as { demand: { status: string; contentVersion: number; updatedAt: string } }).demand;
      assert.equal(actNoOpData.contentVersion, 2);
      assert.equal(actNoOpData.updatedAt, actData.updatedAt);

      // 3. POST /satisfy depuis active
      const satRes = await handlers.demands.satisfy(
        httpRequest("POST", `/api/demands/${demandId}/satisfy`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        demandId,
      );
      assert.equal(satRes.status, 200);
      assertNoStore(satRes);
      const satData = ((await satRes.json()) as { demand: { status: string; contentVersion: number; updatedAt: string } }).demand;
      assert.equal(satData.status, "satisfied");
      assert.equal(satData.contentVersion, 3);

      // 4. POST /satisfy idempotente
      const satNoOpRes = await handlers.demands.satisfy(
        httpRequest("POST", `/api/demands/${demandId}/satisfy`, owner.cookie, {
          expectedContentVersion: 3,
        }),
        demandId,
      );
      assert.equal(satNoOpRes.status, 200);
      const satNoOpData = ((await satNoOpRes.json()) as { demand: { status: string; contentVersion: number; updatedAt: string } }).demand;
      assert.equal(satNoOpData.contentVersion, 3);
      assert.equal(satNoOpData.updatedAt, satData.updatedAt);

      // 5. POST /activate depuis satisfied
      const reactRes = await handlers.demands.activate(
        httpRequest("POST", `/api/demands/${demandId}/activate`, owner.cookie, {
          expectedContentVersion: 3,
        }),
        demandId,
      );
      assert.equal(reactRes.status, 200);
      const reactData = ((await reactRes.json()) as { demand: { status: string; contentVersion: number } }).demand;
      assert.equal(reactData.status, "active");
      assert.equal(reactData.contentVersion, 4);
    });

    test("HTTP : refus 409 transitions interdites (status_transition_conflict)", async () => {
      // Offre en draft -> pause interdite
      const offDraftRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Voiture citadine" },
      ));
      const offId = ((await offDraftRes.json()) as { offer: { id: string } }).offer.id;

      const badPauseRes = await handlers.offers.pause(
        httpRequest("POST", `/api/offers/${offId}/pause`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(badPauseRes.status, 409);
      assertNoStore(badPauseRes);
      const badPauseBody = (await badPauseRes.json()) as { error: { code: string } };
      assert.equal(badPauseBody.error.code, "status_transition_conflict");

      // Demande en draft -> satisfy interdite
      const demDraftRes = await handlers.demands.create(httpRequest(
        "POST",
        "/api/demands",
        owner.cookie,
        { rawText: "Camion benne" },
      ));
      const demId = ((await demDraftRes.json()) as { demand: { id: string } }).demand.id;

      const badSatRes = await handlers.demands.satisfy(
        httpRequest("POST", `/api/demands/${demId}/satisfy`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        demId,
      );
      assert.equal(badSatRes.status, 409);
      assertNoStore(badSatRes);
      const badSatBody = (await badSatRes.json()) as { error: { code: string } };
      assert.equal(badSatBody.error.code, "status_transition_conflict");
    });

    test("HTTP : refus 409 version obsolète (content_version_conflict)", async () => {
      const offRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Ordinateur portable" },
      ));
      const offId = ((await offRes.json()) as { offer: { id: string } }).offer.id;

      // Transition vers published
      await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );

      // Tentative avec version obsolète 1 vers pause
      const staleRes = await handlers.offers.pause(
        httpRequest("POST", `/api/offers/${offId}/pause`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(staleRes.status, 409);
      assertNoStore(staleRes);
      const staleBody = (await staleRes.json()) as { error: { code: string } };
      assert.equal(staleBody.error.code, "content_version_conflict");

      // Version obsolète MÊME si cible déjà atteinte (offre est published, version actuelle = 2, client envoie 1)
      const staleSameStatusRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(staleSameStatusRes.status, 409);
      const staleSameBody = (await staleSameStatusRes.json()) as { error: { code: string } };
      assert.equal(staleSameBody.error.code, "content_version_conflict");
    });

    test("HTTP : refus 409 ressource archivée (resource_archived)", async () => {
      const offRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Panneau solaire 400W" },
      ));
      const offId = ((await offRes.json()) as { offer: { id: string } }).offer.id;

      // Archivage
      const archRes = await handlers.offers.archive(
        httpRequest("POST", `/api/offers/${offId}/archive`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(archRes.status, 200);

      // Tentative de publication sur l'offre archivée
      const pubArchRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        offId,
      );
      assert.equal(pubArchRes.status, 409);
      assertNoStore(pubArchRes);
      const pubArchBody = (await pubArchRes.json()) as { error: { code: string } };
      assert.equal(pubArchBody.error.code, "resource_archived");

      // Tentative de pause sur l'offre archivée
      const pauseArchRes = await handlers.offers.pause(
        httpRequest("POST", `/api/offers/${offId}/pause`, owner.cookie, {
          expectedContentVersion: 2,
        }),
        offId,
      );
      assert.equal(pauseArchRes.status, 409);
      assert.equal(((await pauseArchRes.json()) as { error: { code: string } }).error.code, "resource_archived");
    });

    test("HTTP : isolation propriétaire stricte et 404 indiscernable", async () => {
      const offRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Tracteur agricole" },
      ));
      const offId = ((await offRes.json()) as { offer: { id: string } }).offer.id;

      // Requête par un autre compte
      const otherRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, other.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(otherRes.status, 404);
      assertNoStore(otherRes);
      const otherBody = (await otherRes.json()) as { error: { code: string } };
      assert.equal(otherBody.error.code, "resource_not_found");

      // Requête sur ID inexistant
      const missingId = "11111111-2222-4333-8444-555555555555";
      const missingRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${missingId}/publish`, owner.cookie, {
          expectedContentVersion: 1,
        }),
        missingId,
      );
      assert.equal(missingRes.status, 404);
      assertNoStore(missingRes);
      const missingBody = (await missingRes.json()) as { error: { code: string } };
      assert.equal(missingBody.error.code, "resource_not_found");

      // Les deux réponses 404 ont exactement la même charge utile
      assert.deepEqual(otherBody, missingBody);
    });

    test("HTTP : validation stricte du corps JSON (400 invalid_request) et limite 32 Kio", async () => {
      const offRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Vélo de course" },
      ));
      const offId = ((await offRes.json()) as { offer: { id: string } }).offer.id;

      // 1. Champ inconnu / superflu
      const extraFieldRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {
          expectedContentVersion: 1,
          unknownField: "valeur_non_permise",
        }),
        offId,
      );
      assert.equal(extraFieldRes.status, 400);
      assert.equal(((await extraFieldRes.json()) as { error: { code: string } }).error.code, "invalid_request");

      // 2. expectedContentVersion manquant
      const missingVerRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {}),
        offId,
      );
      assert.equal(missingVerRes.status, 400);
      assert.equal(((await missingVerRes.json()) as { error: { code: string } }).error.code, "invalid_request");

      // 3. expectedContentVersion non entier ou négatif
      for (const badVer of [0, -1, 1.5, "1", null, true, [], {}]) {
        const badVerRes = await handlers.offers.publish(
          httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, {
            expectedContentVersion: badVer,
          }),
          offId,
        );
        assert.equal(badVerRes.status, 400);
      }

      // 4. Corps non-objet (tableau JSON)
      const arrayRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, owner.cookie, [1]),
        offId,
      );
      assert.equal(arrayRes.status, 400);

      // 5. Corps > 32 Kio
      const bigPadding = "x".repeat(33 * 1024);
      const tooLargeReq = new Request(`${ORIGIN}/api/offers/${offId}/publish`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedContentVersion: 1, padding: bigPadding }),
      });
      const tooLargeRes = await handlers.offers.publish(tooLargeReq, offId);
      assert.equal(tooLargeRes.status, 413);
      assert.equal(((await tooLargeRes.json()) as { error: { code: string } }).error.code, "payload_too_large");
    });

    test("HTTP : protections auth (401) et Origin CSRF (403)", async () => {
      const offRes = await handlers.offers.create(httpRequest(
        "POST",
        "/api/offers",
        owner.cookie,
        { rawText: "Canapé 3 places" },
      ));
      const offId = ((await offRes.json()) as { offer: { id: string } }).offer.id;

      // 1. Sans cookie de session
      const noAuthRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, undefined, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(noAuthRes.status, 401);
      assertNoStore(noAuthRes);
      assert.equal(((await noAuthRes.json()) as { error: { code: string } }).error.code, "authentication_required");

      // 2. Cookie session invalide
      const fakeAuthRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, "noma_auth=token_inexistant", {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(fakeAuthRes.status, 401);

      // 3. Session révoquée
      const revokedUser = await login(clock, "198.51.100.74");
      await revokeSession(revokedUser.token, { pool, now: clock.now });
      const revokedRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${offId}/publish`, revokedUser.cookie, {
          expectedContentVersion: 1,
        }),
        offId,
      );
      assert.equal(revokedRes.status, 401);
      assert.equal(((await revokedRes.json()) as { error: { code: string } }).error.code, "authentication_required");

      // 4. Origine non autorisée
      const badOriginRes = await handlers.offers.publish(
        httpRequest(
          "POST",
          `/api/offers/${offId}/publish`,
          owner.cookie,
          { expectedContentVersion: 1 },
          "https://evil-attacker.example",
        ),
        offId,
      );
      assert.equal(badOriginRes.status, 403);
      assertNoStore(badOriginRes);
      assert.equal(((await badOriginRes.json()) as { error: { code: string } }).error.code, "invalid_origin");

      // 4. Origine absente
      const noOriginRes = await handlers.offers.publish(
        httpRequest(
          "POST",
          `/api/offers/${offId}/publish`,
          owner.cookie,
          { expectedContentVersion: 1 },
          null,
        ),
        offId,
      );
      assert.equal(noOriginRes.status, 403);

      // 5. Compte suspendu
      const suspendedUser = await login(clock, "198.51.100.73");
      const suspendedOffer = await createOffer({
        ownerId: suspendedUser.userId,
        rawText: "Offre compte suspendu",
      }, pool);
      await updateUser({ id: suspendedUser.userId, expectedVersion: 1, status: "suspended" }, pool);

      const suspendedRes = await handlers.offers.publish(
        httpRequest("POST", `/api/offers/${suspendedOffer.id}/publish`, suspendedUser.cookie, {
          expectedContentVersion: 1,
        }),
        suspendedOffer.id,
      );
      assert.equal(suspendedRes.status, 401);
    });

    test("concurrence réelle : course même version sur deux pools distincts (offres et demandes)", async () => {
      const firstPid = await getPid(pool);
      const secondPid = await getPid(pool2);
      assert.notEqual(firstPid, secondPid, "Deux connexions PostgreSQL distinctes requises");

      for (const kind of ["offer", "demand"] as const) {
        const create = kind === "offer" ? createOffer : createDemand;
        const publish = kind === "offer" ? publishOffer : activateDemand;
        const get = kind === "offer" ? getOfferById : getDemandById;

        const resource = await create({
          ownerId: owner.userId,
          rawText: `Course même version ${kind}`,
        }, pool);
        assert.equal(resource.contentVersion, 1);

        const tx1Reached = deferred();
        const tx1Release = deferred();

        // Tx1 démarre sur pool (connexion 1) et suspend après le SELECT FOR UPDATE
        const runTx1 = publish(owner.userId, resource.id, 1, pool, {
          beforeUpdate: async () => {
            tx1Reached.resolve();
            await tx1Release.promise;
          },
        });

        await tx1Reached.promise;

        // Tx2 démarre sur pool2 (connexion 2) avec la même version attendue 1
        const runTx2 = publish(owner.userId, resource.id, 1, pool2);

        // Preuve formelle : Tx2 est en attente du verrou détenu par Tx1
        const blocked = await waitForLock(adminPool, secondPid, firstPid);
        assert.equal(blocked, true, `Tx2 (${secondPid}) doit être bloquée par Tx1 (${firstPid}) pour ${kind}`);

        // Déblocage de Tx1
        tx1Release.resolve();

        const [resTx1, resTx2] = await Promise.allSettled([runTx1, runTx2]);

        assert.equal(resTx1.status, "fulfilled");
        assert.equal(resTx2.status, "rejected");

        if (resTx1.status === "fulfilled") {
          assert.equal(resTx1.value.status, kind === "offer" ? "published" : "active");
          assert.equal(resTx1.value.contentVersion, 2);
        }

        if (resTx2.status === "rejected") {
          assert.ok(
            resTx2.reason instanceof StaleContentVersionError,
            `Tx2 doit échouer avec StaleContentVersionError pour ${kind}`,
          );
        }

        const persisted = await get(owner.userId, resource.id, pool);
        assert.equal(persisted?.contentVersion, 2, "Un seul incrément de version au total");
      }
    });

    test("concurrence réelle : transition contre archivage dans les deux ordres (offres et demandes)", async () => {
      const firstPid = await getPid(pool);
      const secondPid = await getPid(pool2);

      for (const kind of ["offer", "demand"] as const) {
        const create = kind === "offer" ? createOffer : createDemand;
        const publish = kind === "offer" ? publishOffer : activateDemand;
        const archive = kind === "offer" ? archiveOffer : archiveDemand;
        const get = kind === "offer" ? getOfferById : getDemandById;
        const table = kind === "offer" ? "offers" : "demands";

        // ORDRE 1 : Transition d'abord, archivage ensuite
        const res1 = await create({ ownerId: owner.userId, rawText: `Ordre 1 ${kind}` }, pool);
        const tx1Reached = deferred();
        const tx1Release = deferred();

        const runTrans = publish(owner.userId, res1.id, 1, pool, {
          beforeUpdate: async () => {
            tx1Reached.resolve();
            await tx1Release.promise;
          },
        });

        await tx1Reached.promise;

        // Archive sur pool2 avec version 1
        const runArch = archive(owner.userId, res1.id, 1, pool2);

        const blockedArch = await waitForLock(adminPool, secondPid, firstPid);
        assert.equal(blockedArch, true, `L'archivage doit être bloqué par la transition pour ${kind}`);

        tx1Release.resolve();

        const [transOutcome, archOutcome] = await Promise.allSettled([runTrans, runArch]);
        assert.equal(transOutcome.status, "fulfilled");
        assert.equal(archOutcome.status, "rejected");

        if (archOutcome.status === "rejected") {
          assert.ok(archOutcome.reason instanceof StaleContentVersionError);
        }

        const afterOrder1 = await get(owner.userId, res1.id, pool);
        assert.equal(afterOrder1?.status, kind === "offer" ? "published" : "active");
        assert.equal(afterOrder1?.contentVersion, 2);
        assert.equal(afterOrder1?.archivedAt, null);

        // ORDRE 2 : Archivage d'abord sous transaction réservée, transition ensuite
        const res2 = await create({ ownerId: owner.userId, rawText: `Ordre 2 ${kind}` }, pool);

        const client1 = await pool.connect();
        await client1.query("BEGIN");
        // client1 pose le verrou exclusif et effectue l'archivage sans encore committer
        await client1.query(
          `UPDATE ${table}
              SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
                  content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND content_version = 1`,
          [res2.id],
        );

        // Tx2 tente de publier sur pool2
        const runTrans2 = publish(owner.userId, res2.id, 1, pool2);

        const blockedTrans = await waitForLock(adminPool, secondPid, firstPid);
        assert.equal(blockedTrans, true, `La transition doit être bloquée par l'archivage pour ${kind}`);

        await client1.query("COMMIT");
        client1.release();

        await assert.rejects(
          runTrans2,
          (err: unknown) => {
            assert.ok(err instanceof ArchivedCatalogResourceError);
            return true;
          },
        );

        const afterOrder2 = await get(owner.userId, res2.id, pool2);
        assert.equal(afterOrder2?.status, "archived");
        assert.equal(afterOrder2?.contentVersion, 2);
        assert.ok(afterOrder2?.archivedAt !== null);
      }
    });

    test("aucun contournement de l'archivage : les transitions sont irrévocablement rejetées", async () => {
      // Offre archivée
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre à archiver" }, pool);
      await archiveOffer(owner.userId, offer.id, 1, pool);

      for (const v of [1, 2, 3]) {
        await assert.rejects(publishOffer(owner.userId, offer.id, v, pool), (err) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        });
        await assert.rejects(pauseOffer(owner.userId, offer.id, v, pool), (err) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        });
      }

      // Demande archivée
      const demand = await createDemand({ ownerId: owner.userId, rawText: "Demande à archiver" }, pool);
      await archiveDemand(owner.userId, demand.id, 1, pool);

      for (const v of [1, 2, 3]) {
        await assert.rejects(activateDemand(owner.userId, demand.id, v, pool), (err) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        });
        await assert.rejects(satisfyDemand(owner.userId, demand.id, v, pool), (err) => {
          assert.ok(err instanceof ArchivedCatalogResourceError);
          return true;
        });
      }
    });

    test("idempotence et no-op : aucune écriture SQL quand la cible est déjà atteinte avec la bonne version", async () => {
      // Offre
      const offer = await createOffer({ ownerId: owner.userId, rawText: "Offre test noop" }, pool);
      const pub1 = await publishOffer(owner.userId, offer.id, 1, pool);
      assert.equal(pub1.status, "published");
      assert.equal(pub1.contentVersion, 2);

      const beforeNoopOffer = (await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM offers WHERE id = $1",
        [offer.id],
      )).rows[0];

      await new Promise((r) => setTimeout(r, 10));

      const pubNoop = await publishOffer(owner.userId, offer.id, 2, pool);
      assert.equal(pubNoop.status, "published");
      assert.equal(pubNoop.contentVersion, 2);

      const afterNoopOffer = (await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM offers WHERE id = $1",
        [offer.id],
      )).rows[0];

      assert.equal(afterNoopOffer.content_version, beforeNoopOffer.content_version);
      assert.equal(afterNoopOffer.updated_at.getTime(), beforeNoopOffer.updated_at.getTime());

      // Demande
      const demand = await createDemand({ ownerId: owner.userId, rawText: "Demande test noop" }, pool);
      const act1 = await activateDemand(owner.userId, demand.id, 1, pool);
      assert.equal(act1.status, "active");
      assert.equal(act1.contentVersion, 2);

      const beforeNoopDem = (await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM demands WHERE id = $1",
        [demand.id],
      )).rows[0];

      await new Promise((r) => setTimeout(r, 10));

      const actNoop = await activateDemand(owner.userId, demand.id, 2, pool);
      assert.equal(actNoop.status, "active");
      assert.equal(actNoop.contentVersion, 2);

      const afterNoopDem = (await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM demands WHERE id = $1",
        [demand.id],
      )).rows[0];

      assert.equal(afterNoopDem.content_version, beforeNoopDem.content_version);
      assert.equal(afterNoopDem.updated_at.getTime(), beforeNoopDem.updated_at.getTime());
    });

    test("HTTP : course concurrente via deux handlers sur deux pools distincts (verrouillage prouvé)", async () => {
      const firstPid = await getPid(pool);
      const secondPid = await getPid(pool2);

      const offer = await createOffer({
        ownerId: owner.userId,
        rawText: "Offre HTTP concurrence pools distincts",
      }, pool);

      const tx1Reached = deferred();
      const tx1Release = deferred();

      const handlers1 = createCatalogHttpHandlers({
        pool,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
        beforeUpdate: async () => {
          tx1Reached.resolve();
          await tx1Release.promise;
        },
      });

      const handlers2 = createCatalogHttpHandlers({
        pool: pool2,
        now: clock.now,
        env: { NOMA_AUTH_ORIGIN: ORIGIN },
      });

      const req1 = httpRequest("POST", `/api/offers/${offer.id}/publish`, owner.cookie, {
        expectedContentVersion: 1,
      });
      const req2 = httpRequest("POST", `/api/offers/${offer.id}/publish`, owner.cookie, {
        expectedContentVersion: 1,
      });

      const run1 = handlers1.offers.publish(req1, offer.id);
      await tx1Reached.promise;

      const run2 = handlers2.offers.publish(req2, offer.id);

      const blocked = await waitForLock(adminPool, secondPid, firstPid);
      assert.equal(blocked, true, "Req2 sur handlers2 doit être bloquée par Req1 sur handlers1");

      tx1Release.resolve();

      const [res1, res2] = await Promise.all([run1, run2]);

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 409);
      assertNoStore(res1);
      assertNoStore(res2);

      const json1 = (await res1.json()) as { offer: { status: string; contentVersion: number } };
      const json2 = (await res2.json()) as { error: { code: string } };

      assert.equal(json1.offer.status, "published");
      assert.equal(json1.offer.contentVersion, 2);
      assert.equal(json2.error.code, "content_version_conflict");

      const inDb = await getOfferById(owner.userId, offer.id, pool);
      assert.equal(inDb?.contentVersion, 2);
    });

    test("régression contrat d'injection : rejet immédiat des dépendances non supportées pour les 4 services", async () => {
      let queryExecuted = false;
      const fakeExecutor = {
        async query() {
          queryExecuted = true;
          throw new Error("Ne doit jamais être appelé");
        },
      };

      const client = await pool.connect();
      try {
        const dummyUuid = "00000000-0000-4000-8000-000000000001";
        const services = [
          { name: "publishOffer", fn: (p: unknown) => publishOffer(dummyUuid, dummyUuid, 1, p as Pool) },
          { name: "pauseOffer", fn: (p: unknown) => pauseOffer(dummyUuid, dummyUuid, 1, p as Pool) },
          { name: "activateDemand", fn: (p: unknown) => activateDemand(dummyUuid, dummyUuid, 1, p as Pool) },
          { name: "satisfyDemand", fn: (p: unknown) => satisfyDemand(dummyUuid, dummyUuid, 1, p as Pool) },
        ];

        for (const s of services) {
          // 1. SqlExecutor sans connect
          queryExecuted = false;
          await assert.rejects(
            s.fn(fakeExecutor),
            (err: unknown) => {
              assert.ok(err instanceof CatalogValidationError, `${s.name} doit rejeter SqlExecutor sans connect`);
              return true;
            },
          );
          assert.equal(queryExecuted, false, "Aucune requête SQL ne doit être exécutée");

          // 2. PoolClient au lieu d'un Pool
          await assert.rejects(
            s.fn(client),
            (err: unknown) => {
              assert.ok(err instanceof CatalogValidationError, `${s.name} doit rejeter PoolClient`);
              return true;
            },
          );

          // 3. null
          await assert.rejects(
            s.fn(null),
            (err: unknown) => {
              assert.ok(err instanceof CatalogValidationError, `${s.name} doit rejeter null`);
              return true;
            },
          );

          // 4. primitive
          await assert.rejects(
            s.fn("not_a_pool"),
            (err: unknown) => {
              assert.ok(err instanceof CatalogValidationError, `${s.name} doit rejeter primitive`);
              return true;
            },
          );
        }
      } finally {
        client.release();
      }
    });

    test("nettoyage vérifié du schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      const schemaCheck = await adminPool.query<{ count: string }>(
        "SELECT count(*) FROM information_schema.schemata WHERE schema_name = $1",
        [schema],
      );
      assert.equal(schemaCheck.rows[0].count, "0");
    });
  });
}
