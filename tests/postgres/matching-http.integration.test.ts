import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  requestOtp,
  revokeSession,
  verifyOtp,
  type SendOtpInput,
} from "../../lib/server/auth";
import {
  activateDemand,
  createDemand,
  createOffer,
  publishOffer,
} from "../../lib/server/catalog";
import {
  createMatchingHttpHandlers,
  type MatchingHttpHandlers,
} from "../../lib/server/matching/http";
import { GET as demandMatchesGet } from "../../app/api/demands/[id]/matches/route";
import { GET as offerMatchesGet } from "../../app/api/offers/[id]/matches/route";
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
  return `+22505${phoneSequence.toString().padStart(8, "0")}`;
}

function httpRequest(
  method: "GET",
  path: string,
  cookie?: string,
): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
  });
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
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
  test("pré-requis PostgreSQL dédié pour matching HTTP", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test matching HTTP n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour matching HTTP", () => {
    throw configuredUrlError;
  });
} else {
  describe("exposition HTTP des matchs de matching (Lot 2D)", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let handlers: MatchingHttpHandlers;
    let userA: Login;
    let userB: Login;

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
      handlers = createMatchingHttpHandlers({
        pool,
        now: clock.now,
      });
      userA = await login(clock, "198.51.100.11");
      userB = await login(clock, "198.51.100.12");
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    test("authentification requise : 401 en l'absence de session, session révoquée ou utilisateur suspendu", async () => {
      const dummyId = randomUUID();

      // 1. Pas de cookie
      const resNoCookie = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${dummyId}/matches`),
        dummyId,
      );
      assert.equal(resNoCookie.status, 401);
      assertNoStore(resNoCookie);
      const bodyNoCookie = (await resNoCookie.json()) as { error: { code: string } };
      assert.equal(bodyNoCookie.error.code, "authentication_required");

      const resNoCookieOffer = await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${dummyId}/matches`),
        dummyId,
      );
      assert.equal(resNoCookieOffer.status, 401);
      assertNoStore(resNoCookieOffer);

      // 2. Cookie invalide
      const resInvalidCookie = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${dummyId}/matches`, "noma_auth=invalid-token"),
        dummyId,
      );
      assert.equal(resInvalidCookie.status, 401);

      // 3. Session révoquée
      const tempUser = await login(clock, "198.51.100.15");
      await revokeSession(tempUser.token, { pool, now: clock.now });
      const resRevoked = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${dummyId}/matches`, tempUser.cookie),
        dummyId,
      );
      assert.equal(resRevoked.status, 401);

      // 4. Utilisateur suspendu
      const suspendedUser = await login(clock, "198.51.100.16");
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspendedUser.userId]);
      const resSuspended = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${dummyId}/matches`, suspendedUser.cookie),
        dummyId,
      );
      assert.equal(resSuspended.status, 401);
    });

    test("isolation propriétaire et ressource absente : même 404 sans fuite d'existence", async () => {
      // Demande appartenant à User B
      const demandB = await createDemand(
        { ownerId: userB.userId, rawText: "Demande de B" },
        pool,
      );
      await activateDemand(userB.userId, demandB.id, demandB.contentVersion, pool);

      // User A tente d'accéder aux matchs de la demande de B
      const resForeign = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandB.id}/matches`, userA.cookie),
        demandB.id,
      );
      assert.equal(resForeign.status, 404);
      assertNoStore(resForeign);
      const bodyForeign = (await resForeign.json()) as { error: { code: string; message: string } };
      assert.equal(bodyForeign.error.code, "resource_not_found");
      assert.equal(bodyForeign.error.message, "Ressource introuvable.");

      // Ressource totalement inexistante
      const nonExistentId = randomUUID();
      const resNotFound = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${nonExistentId}/matches`, userA.cookie),
        nonExistentId,
      );
      assert.equal(resNotFound.status, 404);
      assertNoStore(resNotFound);
      const bodyNotFound = (await resNotFound.json()) as { error: { code: string; message: string } };
      assert.deepEqual(bodyForeign, bodyNotFound, "Les réponses 404 doivent être strictement indiscernables");

      // Idem direction offre -> demandes
      const offerB = await createOffer(
        { ownerId: userB.userId, rawText: "Offre de B" },
        pool,
      );
      await publishOffer(userB.userId, offerB.id, offerB.contentVersion, pool);

      const resOfferForeign = await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${offerB.id}/matches`, userA.cookie),
        offerB.id,
      );
      assert.equal(resOfferForeign.status, 404);

      const resOfferNotFound = await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${nonExistentId}/matches`, userA.cookie),
        nonExistentId,
      );
      assert.equal(resOfferNotFound.status, 404);
    });

    test("validation stricte des entrées : UUID, paramètres inconnus, répétés ou limites corrompues (400)", async () => {
      // 1. UUID invalide dans le chemin
      const resInvalidUuid = await handlers.demands.matches(
        httpRequest("GET", "/api/demands/not-a-uuid/matches", userA.cookie),
        "not-a-uuid",
      );
      assert.equal(resInvalidUuid.status, 400);
      assertNoStore(resInvalidUuid);

      const resInvalidUuidOffer = await handlers.offers.matches(
        httpRequest("GET", "/api/offers/not-a-uuid/matches", userA.cookie),
        "not-a-uuid",
      );
      assert.equal(resInvalidUuidOffer.status, 400);

      // Création d'une demande active pour User A
      const demandA = await createDemand(
        { ownerId: userA.userId, rawText: "Demande de test params" },
        pool,
      );
      await activateDemand(userA.userId, demandA.id, demandA.contentVersion, pool);

      // 2. Paramètre inconnu
      const resUnknownParam = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?foo=bar`, userA.cookie),
        demandA.id,
      );
      assert.equal(resUnknownParam.status, 400);

      // 3. Tentative de configuration client non autorisée (now, scoringOptions, ownerId)
      const resNow = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?now=2035-01-01`, userA.cookie),
        demandA.id,
      );
      assert.equal(resNow.status, 400);

      const resScoring = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?scoringOptions=test`, userA.cookie),
        demandA.id,
      );
      assert.equal(resScoring.status, 400);

      // 4. Paramètre répété
      const resRepeatedLimit = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?limit=10&limit=20`, userA.cookie),
        demandA.id,
      );
      assert.equal(resRepeatedLimit.status, 400);

      const resRepeatedCursor = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?cursor=abc&cursor=def`, userA.cookie),
        demandA.id,
      );
      assert.equal(resRepeatedCursor.status, 400);

      // 5. Limite invalide
      for (const badLimit of ["0", "101", "-1", "abc", "1.5"]) {
        const resBadLimit = await handlers.demands.matches(
          httpRequest("GET", `/api/demands/${demandA.id}/matches?limit=${badLimit}`, userA.cookie),
          demandA.id,
        );
        assert.equal(resBadLimit.status, 400, `limit=${badLimit} doit produire 400`);
      }

      // 6. Curseur corrompu
      const resBadCursor = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandA.id}/matches?cursor=!corrupted!`, userA.cookie),
        demandA.id,
      );
      assert.equal(resBadCursor.status, 400);
    });

    test("source non éligible : rejetée en 400 (demande draft ou offre unavailable)", async () => {
      // 1. Demande en état draft
      const draftDemand = await createDemand(
        { ownerId: userA.userId, rawText: "Demande en état draft" },
        pool,
      );
      const resDraft = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${draftDemand.id}/matches`, userA.cookie),
        draftDemand.id,
      );
      assert.equal(resDraft.status, 400);
      assertNoStore(resDraft);

      // 2. Offre marquée unavailable
      const unavailOffer = await createOffer(
        { ownerId: userA.userId, rawText: "Offre unavailable" },
        pool,
      );
      await publishOffer(userA.userId, unavailOffer.id, unavailOffer.contentVersion, pool);
      await pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [
        unavailOffer.id,
      ]);

      const resUnavail = await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${unavailOffer.id}/matches`, userA.cookie),
        unavailOffer.id,
      );
      assert.equal(resUnavail.status, 400);
      assertNoStore(resUnavail);
    });

    test("direction demande -> offres : évaluation nominale, conservation statuts, scores et pagination", async () => {
      const demand = await createDemand(
        {
          ownerId: userA.userId,
          rawText: "Cherche iPhone 13 128Go",
          category: "smartphones",
          brand: "Apple",
          model: "iPhone 13",
          budget: { amount: 350_000, currency: "XOF" },
        },
        pool,
      );
      await activateDemand(userA.userId, demand.id, demand.contentVersion, pool);

      // 3 offres de User B créées à des dates échelonnées
      const offer1 = await createOffer(
        {
          ownerId: userB.userId,
          rawText: "iPhone 13 128Go parfait",
          category: "smartphones",
          brand: "Apple",
          model: "iPhone 13",
          price: { amount: 300_000, currency: "XOF" },
        },
        pool,
      );
      await publishOffer(userB.userId, offer1.id, offer1.contentVersion, pool);

      const offer2 = await createOffer(
        {
          ownerId: userB.userId,
          rawText: "iPhone 12 incompatible",
          category: "smartphones",
          brand: "Apple",
          model: "iPhone 12",
          price: { amount: 200_000, currency: "XOF" },
        },
        pool,
      );
      await publishOffer(userB.userId, offer2.id, offer2.contentVersion, pool);

      // Page 1 avec limit: 1
      const resPage1 = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demand.id}/matches?limit=1`, userA.cookie),
        demand.id,
      );
      assert.equal(resPage1.status, 200);
      assertNoStore(resPage1);

      const page1 = (await resPage1.json()) as {
        contractVersion: string;
        source: { id: string; category: string };
        items: Array<{
          candidateId: string;
          compatibilityStatus: string;
          score: number | null;
          coverage: number | null;
        }>;
        nextCursor: string | null;
        hasMore: boolean;
        limit: number;
      };

      assert.equal(page1.contractVersion, "matching-http/v1");
      assert.equal(page1.source.id, demand.id);
      assert.equal(page1.limit, 1);
      assert.equal(page1.items.length, 1);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor !== null);

      // Page 2 avec le curseur
      const resPage2 = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demand.id}/matches?limit=10&cursor=${page1.nextCursor}`, userA.cookie),
        demand.id,
      );
      assert.equal(resPage2.status, 200);
      const page2 = (await resPage2.json()) as typeof page1;
      assert.ok(page2.items.length >= 1);
      assert.equal(page2.hasMore, false);

      // Vérification des candidats trouvés
      const allItems = [...page1.items, ...page2.items];
      const match1 = allItems.find((it) => it.candidateId === offer1.id);
      const match2 = allItems.find((it) => it.candidateId === offer2.id);

      assert.ok(match1);
      assert.equal(match1.compatibilityStatus, "compatible");
      assert.equal(match1.score, 100);

      assert.ok(match2);
      assert.equal(match2.compatibilityStatus, "incompatible");
    });

    test("direction offre -> demandes : évaluation dans l'autre sens", async () => {
      const offer = await createOffer(
        {
          ownerId: userA.userId,
          rawText: "MacBook Pro M1",
          category: "ordinateurs",
          brand: "Apple",
          model: "MacBook Pro",
          price: { amount: 500_000, currency: "XOF" },
        },
        pool,
      );
      await publishOffer(userA.userId, offer.id, offer.contentVersion, pool);

      const demandMatch = await createDemand(
        {
          ownerId: userB.userId,
          rawText: "Cherche MacBook Pro",
          category: "ordinateurs",
          brand: "Apple",
          model: "MacBook Pro",
          budget: { amount: 600_000, currency: "XOF" },
        },
        pool,
      );
      await activateDemand(userB.userId, demandMatch.id, demandMatch.contentVersion, pool);

      const res = await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${offer.id}/matches`, userA.cookie),
        offer.id,
      );
      assert.equal(res.status, 200);
      assertNoStore(res);

      const body = (await res.json()) as {
        source: { id: string; price: { amount: number } };
        items: Array<{
          candidateId: string;
          compatibilityStatus: string;
          candidate: { budget: { amount: number } };
        }>;
      };

      assert.equal(body.source.id, offer.id);
      assert.equal(body.source.price.amount, 500_000);
      assert.ok(body.items.some((it) => it.candidateId === demandMatch.id));
      const item = body.items.find((it) => it.candidateId === demandMatch.id)!;
      assert.equal(item.compatibilityStatus, "compatible");
      assert.equal(item.candidate.budget.amount, 600_000);
    });

    test("étanchéité absolue et confidentialité : aucune fuite de données privées dans tout le JSON", async () => {
      const demandSecret = await createDemand(
        {
          ownerId: userA.userId,
          rawText: "DEMAND_SECRET_RAW_TEXT_ABC123",
          category: "smartphones",
          brand: "Apple",
          model: "iPhone 13",
          budget: { amount: 300_000, currency: "XOF" },
          requirements: [
            { key: "secret_req_key", operator: "includes", value: "SECRET_REQUIREMENT_VALUE_789" },
          ],
          preferences: [
            { key: "secret_pref_key", operator: "includes", value: "SECRET_PREFERENCE_VALUE_456" },
          ],
        },
        pool,
      );
      await activateDemand(userA.userId, demandSecret.id, demandSecret.contentVersion, pool);

      const offerSecret = await createOffer(
        {
          ownerId: userB.userId,
          rawText: "OFFER_SECRET_RAW_TEXT_XYZ987",
          category: "smartphones",
          brand: "Apple",
          model: "iPhone 13",
          price: { amount: 280_000, currency: "XOF" },
          attributes: {
            confidential_note: "SECRET_INTERNAL_ATTRIBUTE_VALUE_111",
          },
          extractorVersion: "SECRET_EXTRACTOR_VERSION_222",
          extractionMetadata: { secret_log: "SECRET_EXTRACTION_METADATA_333" },
        },
        pool,
      );
      await publishOffer(userB.userId, offerSecret.id, offerSecret.contentVersion, pool);

      const res = await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${demandSecret.id}/matches`, userA.cookie),
        demandSecret.id,
      );
      assert.equal(res.status, 200);

      // Extraction du texte brut de la réponse HTTP entière
      const fullJsonText = await res.text();

      // 1. Identifiant du propriétaire tiers (User B) strictement absent
      assert.ok(
        !fullJsonText.includes(userB.userId),
        "L'ID du propriétaire tiers (User B) ne doit JAMAIS apparaître dans la réponse",
      );

      // 2. Textes bruts source et candidat strictement absents
      assert.ok(
        !fullJsonText.includes("DEMAND_SECRET_RAW_TEXT_ABC123"),
        "Le texte brut de la source ne doit pas apparaître",
      );
      assert.ok(
        !fullJsonText.includes("OFFER_SECRET_RAW_TEXT_XYZ987"),
        "Le texte brut du candidat ne doit pas apparaître",
      );

      // 3. Métadonnées d'extraction strictement absentes
      assert.ok(
        !fullJsonText.includes("SECRET_EXTRACTOR_VERSION_222"),
        "La version d'extraction ne doit pas apparaître",
      );
      assert.ok(
        !fullJsonText.includes("SECRET_EXTRACTION_METADATA_333"),
        "Les métadonnées d'extraction ne doivent pas apparaître",
      );

      // 4. Exigences et préférences brutes strictement absentes
      assert.ok(
        !fullJsonText.includes("SECRET_REQUIREMENT_VALUE_789"),
        "Les exigences brutes ne doivent pas être divulguées",
      );
      assert.ok(
        !fullJsonText.includes("SECRET_PREFERENCE_VALUE_456"),
        "Les préférences brutes ne doivent pas être divulguées",
      );

      // 5. Attributs internes non structurés absents
      assert.ok(
        !fullJsonText.includes("SECRET_INTERNAL_ATTRIBUTE_VALUE_111"),
        "Les attributs internes non sanitizés ne doivent pas être exposés",
      );

      // 6. Preuves internes de comparaison (offerValue, demandValue, etc.) absentes
      assert.ok(!fullJsonText.includes('"offerValue"'), "Les preuves offerValue ne doivent pas être sérialisées");
      assert.ok(!fullJsonText.includes('"demandValue"'), "Les preuves demandValue ne doivent pas être sérialisées");
      assert.ok(!fullJsonText.includes('"targetValue"'), "Les preuves targetValue ne doivent pas être sérialisées");
      assert.ok(!fullJsonText.includes('"observedValue"'), "Les preuves observedValue ne doivent pas être sérialisées");
    });

    test("lecture pure vérifiée : aucune écriture métier lors de l'appel matching", async () => {
      const demand = await createDemand(
        { ownerId: userA.userId, rawText: "Demande vérification lecture pure" },
        pool,
      );
      const actDemand = await activateDemand(userA.userId, demand.id, demand.contentVersion, pool);

      const offer = await createOffer(
        { ownerId: userB.userId, rawText: "Offre vérification lecture pure" },
        pool,
      );
      const pubOffer = await publishOffer(userB.userId, offer.id, offer.contentVersion, pool);

      await handlers.demands.matches(
        httpRequest("GET", `/api/demands/${actDemand.id}/matches`, userA.cookie),
        actDemand.id,
      );
      await handlers.offers.matches(
        httpRequest("GET", `/api/offers/${pubOffer.id}/matches`, userB.cookie),
        pubOffer.id,
      );

      const checkDemand = await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM demands WHERE id = $1",
        [actDemand.id],
      );
      const checkOffer = await pool.query<{ content_version: number; updated_at: Date }>(
        "SELECT content_version, updated_at FROM offers WHERE id = $1",
        [pubOffer.id],
      );

      assert.equal(checkDemand.rows[0].content_version, actDemand.contentVersion);
      assert.equal(checkOffer.rows[0].content_version, pubOffer.contentVersion);
      assert.equal(
        checkDemand.rows[0].updated_at.getTime(),
        actDemand.updatedAt.getTime(),
      );
      assert.equal(
        checkOffer.rows[0].updated_at.getTime(),
        pubOffer.updatedAt.getTime(),
      );
    });

    test("handlers de routes Next.js App Router : résolution asynchrone context.params et sécurité", async () => {
      const dummyId = randomUUID();
      const resDemand = await demandMatchesGet(
        httpRequest("GET", `/api/demands/${dummyId}/matches`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(resDemand.status, 401);
      assertNoStore(resDemand);

      const resOffer = await offerMatchesGet(
        httpRequest("GET", `/api/offers/${dummyId}/matches`),
        { params: Promise.resolve({ id: dummyId }) },
      );
      assert.equal(resOffer.status, 401);
      assertNoStore(resOffer);
    });
  });
}
