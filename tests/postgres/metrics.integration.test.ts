import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { invalidateMatchesForOffer } from "../../lib/server/matching/persistence";
import { listStoredOfferMatchesForDemand, readStoredOfferForDemand } from "../../lib/server/matching/stored-matches";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { CONTACT_DAILY_SELLER_LIMIT } from "../../lib/server/metrics/config";
import { revealOfferContact } from "../../lib/server/metrics/contacts";
import { MetricsError } from "../../lib/server/metrics/errors";
import { buildOfferStats, readOfferStats, readOfferStatsRaw } from "../../lib/server/metrics/stats";
import { recordOfferView } from "../../lib/server/metrics/views";
import {
  PRODUCT, REACHABLE_LIST_SIZE, TRUNCATE_METRICS_TABLES, addReachableBuyer, ageOffer, insertContact, insertExposure, insertView, makeBoost, makeBuyerMatch,
  makeDemand, makeMatch, makeOffer, makePerson,
} from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool, widePool: Pool;
let target: DedicatedTestDatabase;

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  await runMigrations(pool);
  // Pool à plusieurs connexions (les essais de concurrence), même schéma isolé.
  widePool = new Pool({ connectionString: target.connectionString, max: 12, options: `-c search_path=${schema}` });
});

after(async () => {
  if (widePool) await widePool.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

const reset = () => pool.query(TRUNCATE_METRICS_TABLES);
const rows = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => (await pool.query<T>(text, values)).rows;
const count = async (table: string): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof MetricsError ? error.code : `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// ═════════════ 1. Migration 0018 ═════════════

test("migration 0018 : tables, clés, CHECK sur les compteurs et index de lecture, d'attribution et de purge", async () => {
  const columns = async (table: string) => (await rows<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", [table])).map((row) => row.column_name);
  assert.deepEqual(await columns("offer_views"), ["offer_id", "demand_id", "viewed_day", "viewer_id", "boost_id", "views", "boosted_views", "first_at", "last_at"]);
  assert.deepEqual(await columns("offer_contacts"), ["offer_id", "demand_id", "viewer_id", "boost_id", "reveals", "first_contact_at", "last_contact_at"]);
  const indexes = (await rows<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")).map((row) => row.indexname);
  for (const expected of [
    "pk_offer_views", "pk_offer_contacts", "idx_offer_views_offer_day", "idx_offer_views_day", "idx_offer_views_boost", "idx_offer_contacts_offer_first",
    "idx_offer_contacts_viewer_first", "idx_offer_contacts_last", "idx_offer_contacts_boost", "idx_boost_exposures_served_day",
  ]) assert.ok(indexes.includes(expected), `index ${expected}`);
  const constraints = (await rows<{ conname: string }>(
    "SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND contype = 'c'")).map((row) => row.conname);
  for (const expected of ["chk_offer_views_views", "chk_offer_views_boosted_views", "chk_offer_views_period", "chk_offer_contacts_reveals", "chk_offer_contacts_period"]) {
    assert.ok(constraints.includes(expected), `contrainte ${expected}`);
  }
});

test("migration 0018 : les compteurs refusent 0, un négatif, et plus d'ouvertures attribuées que d'ouvertures ; une période inversée", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  const insertBad = (sql: string, values: unknown[]) => pool.query(sql, values).then(() => "inséré", (error: { code?: string }) => error.code);
  const view = (views: number, boosted: number, lastOffset = "0 seconds") => insertBad(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, clock_timestamp(), clock_timestamp() + $6::interval)`, [offer.id, demand.id, buyer.id, views, boosted, lastOffset]);
  assert.equal(await view(0, 0), "23514", "views >= 1");
  assert.equal(await view(-1, 0), "23514");
  assert.equal(await view(2, -1), "23514", "boosted_views >= 0");
  assert.equal(await view(2, 3), "23514", "boosted_views <= views");
  assert.equal(await view(2, 0, "-1 second"), "23514", "last_at >= first_at");
  assert.equal(await view(2, 2), "inséré");
  assert.equal(await view(2, 2), "23505", "clé (offre, besoin, jour)");
  const contact = (reveals: number, lastOffset = "0 seconds") => insertBad(
    `INSERT INTO offer_contacts (offer_id, demand_id, viewer_id, reveals, first_contact_at, last_contact_at)
     VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + $5::interval)`, [offer.id, demand.id, buyer.id, reveals, lastOffset]);
  assert.equal(await contact(0), "23514", "reveals >= 1");
  assert.equal(await contact(1, "-1 second"), "23514");
  assert.equal(await contact(1), "inséré");
  assert.equal(await contact(1), "23505", "clé (offre, besoin)");
});

// ═════════════ 2. Fiche : accès (même prédicat que stored-matches) ═════════════

const detail = (viewerId: string, demandId: string, offerId: string, db: Pool = pool) => readStoredOfferForDemand(viewerId, demandId, offerId, db);

test("fiche : l'acheteur lit une annonce de SES correspondances confirmées et fraîches (élément identique à la liste, sans boost : sponsored faux)", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id, { price: 250_000 });
  const { buyer, demand } = await makeBuyerMatch(pool, offer, { score: 87 });
  const result = await detail(buyer.id, demand.id, offer.id);
  assert.ok(result);
  assert.equal(result.item.candidateId, offer.id);
  assert.equal(result.item.score, 87);
  assert.equal(result.item.sponsored, false);
  assert.equal(result.item.candidate.price?.amount, 250_000);
  assert.equal(result.offer.createdAt instanceof Date, true);
  // Le même élément que la page de résultats (sens demande), champ par champ.
  const page = await listStoredOfferMatchesForDemand(buyer.id, demand.id, { sort: "relevance" }, pool);
  const listed = page.items.find((item) => item.candidateId === offer.id)!;
  const { evaluatedAt: a, ...fromDetail } = result.item;
  const { evaluatedAt: b, ...fromList } = listed;
  void a; void b;
  assert.deepEqual(fromDetail, fromList);
});

test("fiche : accès refusé = null PARTOUT (autre acheteur, besoin d'autrui, annonce hors correspondances, vendeur lui-même, besoin clos ou brouillon, évaluation périmée ou incompatible, annonce en pause ou vendue)", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  assert.ok(await detail(buyer.id, demand.id, offer.id), "témoin : accès permis");

  const stranger = await makePerson(pool);
  assert.equal(await detail(stranger.id, demand.id, offer.id), null, "un autre acheteur lit le besoin d'autrui");
  const strangerDemand = await makeDemand(pool, stranger.id);
  assert.equal(await detail(buyer.id, strangerDemand.id, offer.id), null, "besoin d'un autre");
  assert.equal(await detail(stranger.id, strangerDemand.id, offer.id), null, "son propre besoin, mais l'annonce n'y correspond pas");
  const unrelated = await makeOffer(pool, seller.id, { model: "iPhone 14" });
  assert.equal(await detail(buyer.id, demand.id, unrelated.id), null, "annonce jamais correspondante");
  assert.equal(await detail(seller.id, demand.id, offer.id), null, "le vendeur sur le besoin de l'acheteur");
  const sellersOwnDemand = await makeDemand(pool, seller.id);
  // Une évaluation entre une annonce et un besoin du MÊME propriétaire ne peut pas exister (CHECK de la base) : le vendeur n'a jamais sa propre annonce parmi ses correspondances.
  const impossible = await pool.query(
    `INSERT INTO matching_evaluations (idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id, offer_content_version, demand_content_version,
       engine_offline_version, engine_scoring_version, scoring_config_hash, scoring_config, evaluated_at, eligibility_status, eligibility_reasons, compatibility_status, score, coverage,
       evaluation_summary, scoring_summary, preferences_summary, evaluation_details, is_latest, is_stale)
     SELECT gen_random_uuid(), 'ATTEMPT_' || gen_random_uuid()::text, offer_id, $2::uuid, offer_owner_id, $3::uuid, offer_content_version, $4::int, engine_offline_version, engine_scoring_version, scoring_config_hash,
            scoring_config, evaluated_at, eligibility_status, eligibility_reasons, compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
            evaluation_details, is_latest, is_stale FROM matching_evaluations WHERE offer_id = $1 AND demand_id = $5`,
    [offer.id, sellersOwnDemand.id, seller.id, sellersOwnDemand.contentVersion, demand.id],
  ).then(() => "inséré", (error: { code?: string }) => error.code);
  assert.equal(impossible, "23514");
  assert.equal(await detail(seller.id, sellersOwnDemand.id, offer.id), null, "le vendeur lit SA propre annonce depuis son propre besoin : jamais");

  // Besoin clos : satisfait puis brouillon.
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [demand.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "besoin satisfait");
  await pool.query("UPDATE demands SET status = 'draft' WHERE id = $1", [demand.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "besoin brouillon");
  await pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [demand.id]);
  assert.ok(await detail(buyer.id, demand.id, offer.id), "réactivé : de nouveau permis");

  // Évaluation périmée, incompatible, non confirmée.
  await pool.query("UPDATE matching_evaluations SET is_stale = TRUE, is_latest = FALSE, stale_reason = 'engine_superseded', staled_at = clock_timestamp() WHERE offer_id = $1 AND demand_id = $2", [offer.id, demand.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "évaluation périmée");
  await pool.query("UPDATE matching_evaluations SET is_stale = FALSE, is_latest = TRUE, stale_reason = NULL, staled_at = NULL, compatibility_status = 'incompatible' WHERE offer_id = $1 AND demand_id = $2", [offer.id, demand.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "correspondance non confirmée");
  await pool.query("UPDATE matching_evaluations SET compatibility_status = 'compatible' WHERE offer_id = $1 AND demand_id = $2", [offer.id, demand.id]);
  assert.ok(await detail(buyer.id, demand.id, offer.id));

  // Annonce en pause, vendue (indisponible), archivée.
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offer.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "annonce en pause");
  await pool.query("UPDATE offers SET status = 'published', availability_status = 'unavailable' WHERE id = $1", [offer.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "annonce vendue (indisponible)");
  await pool.query("UPDATE offers SET availability_status = 'available' WHERE id = $1", [offer.id]);
  assert.ok(await detail(buyer.id, demand.id, offer.id), "remise en ligne : de nouveau permis");
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [seller.id]);
  assert.equal(await detail(buyer.id, demand.id, offer.id), null, "vendeur suspendu");
});

test("fiche : « Sponsorisé » est RELU depuis le placement (boost effectif, quota, pertinence), jamais déduit ; faux pour un boost échu, annulé ou une liste trop courte ; égal au drapeau de la liste", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  // Liste de 7 : quota floor(0,15 × 7) = 1 ; l'annonce est évaluée EN PREMIER, donc classée après les remplissages (plus compatibles) : un boost la fait monter.
  const world = await addReachableBuyer(pool, offer, { listSize: REACHABLE_LIST_SIZE });
  const viewer = world.demand.ownerId;
  assert.equal((await detail(viewer, world.demand.id, offer.id))?.item.sponsored, false, "pas de boost : organique");
  const boostId = await makeBoost(pool, offer);
  const boosted = await detail(viewer, world.demand.id, offer.id);
  assert.equal(boosted?.item.sponsored, true, "boost effectif et place gagnée");
  const listed = (await listStoredOfferMatchesForDemand(viewer, world.demand.id, { sort: "relevance" }, pool)).items.find((item) => item.candidateId === offer.id)!;
  assert.equal(listed.sponsored, true, "le drapeau de la liste est le même");
  // Boost échu, annulé : plus sponsorisé.
  await pool.query("UPDATE offer_boosts SET status = 'expired' WHERE id = $1", [boostId]);
  assert.equal((await detail(viewer, world.demand.id, offer.id))?.item.sponsored, false, "boost expiré");
  await pool.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [boostId]);
  assert.equal((await detail(viewer, world.demand.id, offer.id))?.item.sponsored, false, "boost annulé");
  await pool.query("UPDATE offer_boosts SET status = 'active', cancelled_at = NULL, ends_at = clock_timestamp() - interval '1 second', starts_at = clock_timestamp() - interval '1 day' WHERE id = $1", [boostId]);
  assert.equal((await detail(viewer, world.demand.id, offer.id))?.item.sponsored, false, "fenêtre du boost terminée");
  await pool.query("UPDATE offer_boosts SET ends_at = clock_timestamp() + interval '1 day' WHERE id = $1", [boostId]);
  assert.equal((await detail(viewer, world.demand.id, offer.id))?.item.sponsored, true, "fenêtre rouverte");
  // Liste de 6 : quota nul, le boost ne fait rien monter pour CE besoin.
  const shortList = await addReachableBuyer(pool, offer, { listSize: 6 });
  assert.equal((await detail(shortList.demand.ownerId, shortList.demand.id, offer.id))?.item.sponsored, false, "liste trop courte : jamais sponsorisé");
  const shortListed = (await listStoredOfferMatchesForDemand(shortList.demand.ownerId, shortList.demand.id, { sort: "relevance" }, pool)).items.find((item) => item.candidateId === offer.id)!;
  assert.equal(shortListed.sponsored, false);
});

test("fiche : une annonce confirmée et fraîche AU-DELÀ de la fenêtre triée (plus de 200 correspondances) est servie quand même, jamais sponsorisée", async () => {
  await reset();
  const seller = await makePerson(pool);
  const target = await makeOffer(pool, seller.id);
  const filler = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  await makeMatch(pool, target, demand, 10);
  for (let index = 0; index < 201; index++) await makeMatch(pool, await makeOffer(pool, filler.id, { model: `m${index}` }), demand, 50 + (index % 40));
  await makeBoost(pool, target);
  const page = await listStoredOfferMatchesForDemand(buyer.id, demand.id, { sort: "relevance", limit: 100 }, pool);
  assert.equal(page.truncated, true, "plus de 200 correspondances");
  const result = await detail(buyer.id, demand.id, target.id);
  assert.ok(result, "hors fenêtre mais confirmée et fraîche");
  assert.equal(result.item.sponsored, false);
  assert.equal(result.item.score, 10);
  // Une annonce qui n'est PAS dans les correspondances reste refusée même quand la fenêtre est tronquée.
  const unrelated = await makeOffer(pool, seller.id, { model: "iPhone 99" });
  assert.equal(await detail(buyer.id, demand.id, unrelated.id), null);
});

// ═════════════ 3. Ouvertures ═════════════

const view = (offerId: string, demandId: string, viewerId: string, db: Pool = pool) => recordOfferView(db, { offerId, demandId, viewerId });

test("ouvertures : une ligne par annonce, besoin et JOUR UTC ; le compteur monte à chaque lecture ; un autre besoin ou un autre jour = une autre ligne", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const first = await makeBuyerMatch(pool, offer);
  const second = await makeBuyerMatch(pool, offer);
  assert.equal(await view(offer.id, first.demand.id, first.buyer.id), true);
  assert.equal(await view(offer.id, first.demand.id, first.buyer.id), true);
  assert.equal(await view(offer.id, first.demand.id, first.buyer.id), true);
  const day = (await rows<{ d: string }>("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS d"))[0].d;
  const stored = await rows<{ offer_id: string; demand_id: string; viewer_id: string; viewed_day: string; views: number; boosted_views: number; boost_id: string | null; first: Date; last: Date }>(
    "SELECT offer_id, demand_id, viewer_id, viewed_day::text AS viewed_day, views, boosted_views, boost_id, first_at AS first, last_at AS last FROM offer_views");
  assert.equal(stored.length, 1, "déduplication par jour : une ligne, trois ouvertures");
  assert.deepEqual([stored[0].views, stored[0].boosted_views, stored[0].boost_id, stored[0].viewer_id, stored[0].viewed_day], [3, 0, null, first.buyer.id, day]);
  assert.ok(stored[0].last.getTime() >= stored[0].first.getTime());
  // Un autre besoin (autre acheteur) : une autre ligne.
  await view(offer.id, second.demand.id, second.buyer.id);
  assert.equal(await count("offer_views"), 2);
  // Un autre jour : l'ancienne ligne est rangée à la veille, la lecture d'aujourd'hui en crée une nouvelle.
  await pool.query("UPDATE offer_views SET viewed_day = viewed_day - 1 WHERE demand_id = $1", [first.demand.id]);
  await view(offer.id, first.demand.id, first.buyer.id);
  const perDay = await rows<{ viewed_day: string; views: number }>("SELECT viewed_day::text AS viewed_day, views FROM offer_views WHERE demand_id = $1 ORDER BY viewed_day", [first.demand.id]);
  assert.deepEqual(perDay.map((row) => row.views), [3, 1], "la veille : 3 ; aujourd'hui : 1");
  assert.equal(new Set(perDay.map((row) => row.viewed_day)).size, 2);
});

test("ouvertures : le vendeur n'est JAMAIS compté (même avec un besoin qui correspond à sa propre annonce) ; ni un acheteur qui n'est pas le propriétaire du besoin ; ni une annonce ou un besoin inconnus", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  // Le vendeur a un besoin « correspondant » à sa propre annonce (évaluation même propriétaire, insérée de force) et l'ouvre.
  const own = await makeDemand(pool, seller.id);
  assert.equal(await view(offer.id, own.id, seller.id), false);
  assert.equal(await count("offer_views"), 0, "viewer = propriétaire de l'annonce : rien d'écrit");
  // Le vendeur se fait passer pour l'acheteur (besoin d'autrui) : refusé aussi.
  assert.equal(await view(offer.id, demand.id, seller.id), false);
  // Un tiers sur le besoin d'autrui.
  const stranger = await makePerson(pool);
  assert.equal(await view(offer.id, demand.id, stranger.id), false);
  assert.equal(await view(randomUUID(), demand.id, buyer.id), false, "annonce inconnue");
  assert.equal(await view(offer.id, randomUUID(), buyer.id), false, "besoin inconnu");
  assert.equal(await count("offer_views"), 0);
  assert.equal(await view(offer.id, demand.id, buyer.id), true, "témoin : l'acheteur est compté");
  assert.equal(await count("offer_views"), 1);
});

test("attribution des ouvertures : au boost seulement si le journal montre l'annonce servie SPONSORISÉE à ce besoin dans les 7 jours (servie < 7 j, > 7 j, servie non sponsorisée, autre besoin) ; le plus récent des boosts ; compteur d'ouvertures attribuées exact", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boost = await makeBoost(pool, offer);
  const attributed = async (demandId: string) => (await rows<{ boost_id: string | null; views: number; boosted_views: number }>(
    "SELECT boost_id, views, boosted_views FROM offer_views WHERE demand_id = $1", [demandId]))[0];

  // a. Servie sponsorisée il y a 6 jours : attribuée.
  const a = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: a.demand.id, viewerId: a.buyer.id, firstServedAgo: "6 days", sponsoredServings: 2, servings: 3 });
  await view(offer.id, a.demand.id, a.buyer.id);
  assert.deepEqual(await attributed(a.demand.id), { boost_id: boost, views: 1, boosted_views: 1 });
  // b. Servie sponsorisée il y a 8 jours : plus attribuée (organique).
  const b = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: b.demand.id, viewerId: b.buyer.id, firstServedAgo: "8 days", sponsoredServings: 1 });
  await view(offer.id, b.demand.id, b.buyer.id);
  assert.deepEqual(await attributed(b.demand.id), { boost_id: null, views: 1, boosted_views: 0 });
  // c. Servie récemment mais NON sponsorisée (a gagné aucune place) : organique.
  const c = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: c.demand.id, viewerId: c.buyer.id, firstServedAgo: "1 hour", servings: 4, sponsoredServings: 0 });
  await view(offer.id, c.demand.id, c.buyer.id);
  assert.deepEqual(await attributed(c.demand.id), { boost_id: null, views: 1, boosted_views: 0 });
  // d. Servie sponsorisée à UN AUTRE besoin : organique pour celui-ci.
  const d = await makeBuyerMatch(pool, offer);
  await view(offer.id, d.demand.id, d.buyer.id);
  assert.deepEqual(await attributed(d.demand.id), { boost_id: null, views: 1, boosted_views: 0 });
  // e. Jamais exposée : organique.
  // f. Bornes de la fenêtre : 6 j 23 h attribué, 7 j 1 h non.
  const inside = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: inside.demand.id, viewerId: inside.buyer.id, firstServedAgo: "6 days 23 hours" });
  await view(offer.id, inside.demand.id, inside.buyer.id);
  assert.equal((await attributed(inside.demand.id)).boost_id, boost, "6 j 23 h : dans la fenêtre");
  const outside = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: outside.demand.id, viewerId: outside.buyer.id, firstServedAgo: "7 days 1 hour" });
  await view(offer.id, outside.demand.id, outside.buyer.id);
  assert.equal((await attributed(outside.demand.id)).boost_id, null, "7 j 1 h : hors fenêtre");
  // g. Plusieurs boosts : le plus récemment servi.
  const older = await makeBoost(pool, offer, { status: "expired", startsAgo: "9 days", endsIn: "-8 days" });
  const g = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: older, offerId: offer.id, demandId: g.demand.id, viewerId: g.buyer.id, firstServedAgo: "5 days" });
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: g.demand.id, viewerId: g.buyer.id, firstServedAgo: "2 days" });
  await view(offer.id, g.demand.id, g.buyer.id);
  assert.equal((await attributed(g.demand.id)).boost_id, boost, "le boost servi le plus récemment");
  // h. Un boost qui a pris fin depuis est retenu (l'acheteur l'a vu sponsorisé dans les 7 jours).
  const h = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: older, offerId: offer.id, demandId: h.demand.id, viewerId: h.buyer.id, firstServedAgo: "3 days" });
  await view(offer.id, h.demand.id, h.buyer.id);
  assert.equal((await attributed(h.demand.id)).boost_id, older);
  // i. Une même ligne du jour : ouverture organique, puis attribuée (après une exposition), puis organique ; boosted_views compte seulement la 2e.
  const i = await makeBuyerMatch(pool, offer);
  await view(offer.id, i.demand.id, i.buyer.id);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: i.demand.id, viewerId: i.buyer.id, firstServedAgo: "10 minutes" });
  await view(offer.id, i.demand.id, i.buyer.id);
  assert.deepEqual(await attributed(i.demand.id), { boost_id: boost, views: 2, boosted_views: 1 });
  await pool.query("DELETE FROM boost_exposures WHERE demand_id = $1", [i.demand.id]);
  await view(offer.id, i.demand.id, i.buyer.id);
  assert.deepEqual(await attributed(i.demand.id), { boost_id: boost, views: 3, boosted_views: 1 }, "la ligne garde le dernier boost attribué, boosted_views ne bouge pas");
});

test("attribution : la lecture réelle des résultats (journal d'exposition écrit par stored-matches) puis l'ouverture de la fiche → attribuée au boost", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const world = await addReachableBuyer(pool, offer, { listSize: REACHABLE_LIST_SIZE });
  const viewer = world.demand.ownerId;
  const boostId = await makeBoost(pool, offer);
  // Ouverture AVANT d'avoir vu l'annonce sponsorisée dans les résultats : organique.
  await view(offer.id, world.demand.id, viewer);
  assert.equal((await rows<{ boost_id: string | null }>("SELECT boost_id FROM offer_views"))[0].boost_id, null);
  await pool.query("DELETE FROM offer_views");
  // La liste des résultats sert l'annonce sponsorisée : le journal d'exposition la compte.
  const page = await listStoredOfferMatchesForDemand(viewer, world.demand.id, { sort: "relevance" }, pool);
  assert.equal(page.items.find((item) => item.candidateId === offer.id)?.sponsored, true);
  assert.equal((await rows<{ sponsored_servings: number }>("SELECT sponsored_servings FROM boost_exposures WHERE boost_id = $1", [boostId]))[0].sponsored_servings, 1);
  // Puis la fiche est ouverte : attribuée.
  await view(offer.id, world.demand.id, viewer);
  const stored = (await rows<{ boost_id: string | null; boosted_views: number }>("SELECT boost_id, boosted_views FROM offer_views"))[0];
  assert.deepEqual([stored.boost_id, stored.boosted_views], [boostId, 1]);
  // La lecture de la fiche elle-même n'ajoute AUCUNE apparition au journal d'exposition.
  await detail(viewer, world.demand.id, offer.id);
  assert.equal((await rows<{ servings: number }>("SELECT servings FROM boost_exposures WHERE boost_id = $1", [boostId]))[0].servings, 1);
});

// ═════════════ 4. Contacts ═════════════

const reveal = (viewerId: string, demandId: string, offerId: string, db: Pool = pool) => revealOfferContact({ pool: db, viewerId, demandId, offerId });
const contactRows = () => rows<{ offer_id: string; demand_id: string; viewer_id: string; boost_id: string | null; reveals: number; first_contact_at: Date; last_contact_at: Date }>(
  "SELECT offer_id, demand_id, viewer_id, boost_id, reveals, first_contact_at, last_contact_at FROM offer_contacts ORDER BY first_contact_at");

test("contact : le numéro vérifié du vendeur (E.164) ; une ligne par annonce et besoin ; chaque révélation compte ; le premier contact est daté une fois", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  const first = await reveal(buyer.id, demand.id, offer.id);
  assert.deepEqual(first, { phone: seller.phone, firstContact: true });
  assert.match(first.phone, /^\+[1-9][0-9]{1,14}$/);
  const afterFirst = await contactRows();
  assert.equal(afterFirst.length, 1);
  assert.deepEqual([afterFirst[0].viewer_id, afterFirst[0].reveals, afterFirst[0].boost_id], [buyer.id, 1, null]);
  const again = await reveal(buyer.id, demand.id, offer.id);
  assert.deepEqual(again, { phone: seller.phone, firstContact: false });
  await reveal(buyer.id, demand.id, offer.id);
  const afterThree = await contactRows();
  assert.equal(afterThree.length, 1, "toujours une seule ligne");
  assert.equal(afterThree[0].reveals, 3);
  assert.equal(afterThree[0].first_contact_at.getTime(), afterFirst[0].first_contact_at.getTime(), "le premier contact ne bouge pas");
  assert.ok(afterThree[0].last_contact_at.getTime() >= afterThree[0].first_contact_at.getTime());
});

test("contact : seul le numéro VÉRIFIÉ est révélé ; un vendeur sans numéro vérifié → contact_unavailable, rien d'écrit", async () => {
  await reset();
  const seller = await makePerson(pool, { phone: false });
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "contact_unavailable");
  assert.equal(await count("offer_contacts"), 0);
});

test("contact : accès refusé = resource_not_found IDENTIQUE (autre acheteur, besoin d'autrui, annonce hors correspondances, vendeur lui-même, besoin clos) ; rien d'écrit", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  const stranger = await makePerson(pool);
  const strangerDemand = await makeDemand(pool, stranger.id);
  const unrelated = await makeOffer(pool, seller.id, { model: "iPhone 14" });
  const denials = [
    ["autre acheteur sur ce besoin", () => reveal(stranger.id, demand.id, offer.id)],
    ["besoin d'autrui", () => reveal(buyer.id, strangerDemand.id, offer.id)],
    ["annonce hors correspondances", () => reveal(buyer.id, demand.id, unrelated.id)],
    ["annonce inconnue", () => reveal(buyer.id, demand.id, randomUUID())],
    ["besoin inconnu", () => reveal(buyer.id, randomUUID(), offer.id)],
    ["le vendeur sur ce besoin", () => reveal(seller.id, demand.id, offer.id)],
  ] as const;
  for (const [label, run] of denials) assert.equal(await failure(run()), "resource_not_found", label);
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [demand.id]);
  assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "resource_not_found", "besoin clos");
  await pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [demand.id]);
  assert.equal(await count("offer_contacts"), 0, "aucune ligne écrite par un refus");
  // Même message pour toutes les causes (rien de distinguable).
  const messages = new Set<string>();
  for (const [, run] of denials) await run().catch((error: Error) => messages.add(error.message));
  assert.equal(messages.size, 1);
});

test("contact : annonce en pause, retirée ou vendue → offer_not_available, RIEN n'est révélé ni écrit ; une annonce jamais correspondante reste 404 même retirée", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const { buyer, demand } = await makeBuyerMatch(pool, offer);
  assert.ok(await reveal(buyer.id, demand.id, offer.id), "témoin");
  await pool.query("DELETE FROM offer_contacts");
  for (const [label, sql] of [
    ["en pause", "UPDATE offers SET status = 'paused' WHERE id = $1"],
    ["vendue (indisponible)", "UPDATE offers SET status = 'published', availability_status = 'unavailable' WHERE id = $1"],
    ["retirée (archivée)", "UPDATE offers SET status = 'archived', archived_at = clock_timestamp(), availability_status = 'available' WHERE id = $1"],
  ] as const) {
    await pool.query("UPDATE offers SET status = 'published', archived_at = NULL, availability_status = 'available' WHERE id = $1", [offer.id]);
    await pool.query(sql, [offer.id]);
    assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "offer_not_available", label);
    assert.equal(await count("offer_contacts"), 0, `${label} : rien d'écrit`);
  }
  // Même quand le worker a déjà périmé l'évaluation de l'annonce retirée : l'acheteur la connaissait, 409 et non 404.
  await pool.query("UPDATE offers SET status = 'paused', archived_at = NULL, availability_status = 'available' WHERE id = $1", [offer.id]);
  assert.ok((await invalidateMatchesForOffer(pool, offer.id, "offer_unavailable")) >= 1, "le worker périme l'évaluation de l'annonce retirée");
  assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "offer_not_available", "évaluation périmée par le worker");
  // Jamais correspondante : 404 même si elle est en pause.
  const never = await makeOffer(pool, seller.id, { model: "iPhone 14", status: "paused" });
  assert.equal(await failure(reveal(buyer.id, demand.id, never.id)), "resource_not_found");
  // Et un besoin clos ne distingue plus rien : 404.
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [demand.id]);
  assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "resource_not_found");
  assert.equal(await count("offer_contacts"), 0);
});

test("contact : attribution au boost AU PREMIER contact seulement (mêmes règles que les ouvertures : fenêtre de 7 jours, sponsorisée, ce besoin)", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boost = await makeBoost(pool, offer);
  const a = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: a.demand.id, viewerId: a.buyer.id, firstServedAgo: "2 days" });
  await reveal(a.buyer.id, a.demand.id, offer.id);
  const b = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: b.demand.id, viewerId: b.buyer.id, firstServedAgo: "9 days" });
  await reveal(b.buyer.id, b.demand.id, offer.id);
  const c = await makeBuyerMatch(pool, offer);
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: c.demand.id, viewerId: c.buyer.id, firstServedAgo: "1 hour", sponsoredServings: 0, servings: 2 });
  await reveal(c.buyer.id, c.demand.id, offer.id);
  const d = await makeBuyerMatch(pool, offer);
  await reveal(d.buyer.id, d.demand.id, offer.id);
  const byDemand = new Map((await contactRows()).map((row) => [row.demand_id, row.boost_id]));
  assert.equal(byDemand.get(a.demand.id), boost, "servie sponsorisée il y a 2 jours");
  assert.equal(byDemand.get(b.demand.id), null, "il y a 9 jours");
  assert.equal(byDemand.get(c.demand.id), null, "servie non sponsorisée");
  assert.equal(byDemand.get(d.demand.id), null, "jamais exposée");
  // Après le premier contact organique de d, une exposition sponsorisée n'attribue pas rétroactivement ; un nouveau contact (révélation) ne change rien.
  await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: d.demand.id, viewerId: d.buyer.id, firstServedAgo: "1 minute" });
  await reveal(d.buyer.id, d.demand.id, offer.id);
  const dRow = (await contactRows()).find((row) => row.demand_id === d.demand.id)!;
  assert.deepEqual([dRow.boost_id, dRow.reveals], [null, 2]);
});

async function sellerWithOffer(): Promise<{ seller: Awaited<ReturnType<typeof makePerson>>; offer: Awaited<ReturnType<typeof makeOffer>> }> {
  const seller = await makePerson(pool);
  return { seller, offer: await makeOffer(pool, seller.id) };
}

test(`contact : limite de ${CONTACT_DAILY_SELLER_LIMIT} vendeurs DISTINCTS par acheteur et par jour UTC → la ${CONTACT_DAILY_SELLER_LIMIT + 1}e est refusée (rate_limited) ; un vendeur déjà révélé l'est de nouveau sans compter ; un autre acheteur n'est pas touché ; le jour suivant, de nouveau permis`, async () => {
  await reset();
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offers: Array<Awaited<ReturnType<typeof makeOffer>>> = [];
  for (let index = 0; index < CONTACT_DAILY_SELLER_LIMIT + 2; index++) {
    const { offer } = await sellerWithOffer();
    await makeMatch(pool, offer, demand);
    offers.push(offer);
  }
  for (const offer of offers.slice(0, CONTACT_DAILY_SELLER_LIMIT)) assert.equal(await failure(reveal(buyer.id, demand.id, offer.id)), "ok");
  assert.equal(await count("offer_contacts"), CONTACT_DAILY_SELLER_LIMIT);
  // Le 21e vendeur distinct : refusé, rien d'écrit.
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[CONTACT_DAILY_SELLER_LIMIT].id)), "rate_limited");
  assert.equal(await count("offer_contacts"), CONTACT_DAILY_SELLER_LIMIT);
  // Un vendeur déjà révélé l'est de nouveau (même annonce), et une AUTRE annonce du même vendeur aussi : sans compter.
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[0].id)), "ok");
  const sameSellerOffer = await makeOffer(pool, offers[0].ownerId, { model: PRODUCT.model });
  await makeMatch(pool, sameSellerOffer, demand);
  assert.equal(await failure(reveal(buyer.id, demand.id, sameSellerOffer.id)), "ok", "autre annonce d'un vendeur déjà révélé");
  assert.equal(await count("offer_contacts"), CONTACT_DAILY_SELLER_LIMIT + 1);
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[CONTACT_DAILY_SELLER_LIMIT + 1].id)), "rate_limited", "toujours 20 vendeurs distincts");
  // Un autre acheteur n'est pas concerné.
  const other = await makePerson(pool);
  const otherDemand = await makeDemand(pool, other.id);
  await makeMatch(pool, offers[CONTACT_DAILY_SELLER_LIMIT], otherDemand);
  assert.equal(await failure(reveal(other.id, otherDemand.id, offers[CONTACT_DAILY_SELLER_LIMIT].id)), "ok");
  // Le lendemain (UTC) : les premiers contacts datent de la veille, le quota est neuf.
  await pool.query("UPDATE offer_contacts SET first_contact_at = first_contact_at - interval '1 day', last_contact_at = last_contact_at - interval '1 day' WHERE viewer_id = $1", [buyer.id]);
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[CONTACT_DAILY_SELLER_LIMIT].id)), "ok", "nouveau jour UTC");
  // Un vendeur révélé HIER ne consomme pas le quota d'aujourd'hui quand on le révèle de nouveau.
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[1].id)), "ok");
});

test("contact : le jour UTC compte (pas les 24 dernières heures) ; 20 premiers contacts à 23 h 59 UTC de la veille ne bloquent pas ce matin", async () => {
  await reset();
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offers = [] as Array<Awaited<ReturnType<typeof makeOffer>>>;
  for (let index = 0; index < CONTACT_DAILY_SELLER_LIMIT + 1; index++) {
    const { offer } = await sellerWithOffer();
    await makeMatch(pool, offer, demand);
    offers.push(offer);
  }
  for (const offer of offers.slice(0, CONTACT_DAILY_SELLER_LIMIT)) await reveal(buyer.id, demand.id, offer.id);
  // Premiers contacts : hier à 23 h 59 UTC (il y a moins de 24 h si on est tôt le matin, mais un autre jour UTC).
  await pool.query(
    `UPDATE offer_contacts SET first_contact_at = ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1)::timestamp AT TIME ZONE 'UTC' + interval '23 hours 59 minutes',
                              last_contact_at = ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1)::timestamp AT TIME ZONE 'UTC' + interval '23 hours 59 minutes' WHERE viewer_id = $1`, [buyer.id]);
  assert.equal(await failure(reveal(buyer.id, demand.id, offers[CONTACT_DAILY_SELLER_LIMIT].id)), "ok");
});

test("contact : la limite est EXACTE sous concurrence (25 demandes simultanées de vendeurs distincts → exactement 20 réussissent, 5 sont refusées)", async () => {
  await reset();
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offers = [] as Array<Awaited<ReturnType<typeof makeOffer>>>;
  for (let index = 0; index < 25; index++) {
    const { offer } = await sellerWithOffer();
    await makeMatch(pool, offer, demand);
    offers.push(offer);
  }
  const outcomes = await Promise.all(offers.map((offer) => failure(reveal(buyer.id, demand.id, offer.id, widePool))));
  assert.equal(outcomes.filter((outcome) => outcome === "ok").length, CONTACT_DAILY_SELLER_LIMIT, outcomes.join(","));
  assert.equal(outcomes.filter((outcome) => outcome === "rate_limited").length, 5);
  assert.equal(await count("offer_contacts"), CONTACT_DAILY_SELLER_LIMIT);
  // Même annonce, 10 révélations simultanées : une ligne, 10 révélations.
  const { offer } = await sellerWithOffer();
  const second = await makeDemand(pool, (await makePerson(pool)).id);
  await makeMatch(pool, offer, second);
  const results = await Promise.all(Array.from({ length: 10 }, () => reveal(second.ownerId, second.id, offer.id, widePool)));
  assert.equal(results.filter((result) => result.firstContact).length, 1, "un seul premier contact");
  const row = (await rows<{ reveals: number }>("SELECT reveals FROM offer_contacts WHERE demand_id = $1", [second.id]))[0];
  assert.equal(row.reveals, 10);
});

// ═════════════ 5. Statistiques ═════════════

/** Comptes publiés (lot M1-quater) : « moins de 5 » de 0 à 4, sinon « environ N ». */
const BELOW = { kind: "below", bound: 5 } as const;
const about = (value: number) => ({ kind: "approx", value }) as const;
const INSUFFICIENT = { kind: "insufficient" } as const;

test("statistiques : jeu connu, comptes BRUTS exacts par période (7 j, 30 j, depuis la publication) et par boost ; la publication arrondit chaque compte (« moins de 5 », « environ N »), jamais un compte exact", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  await ageOffer(pool, offer.id, 100);
  const boost = await makeBoost(pool, offer, { startsAgo: "25 days", endsIn: "4 days" });
  const old = await makeBoost(pool, offer, { status: "expired", startsAgo: "40 days", endsIn: "-38 days" });
  const buyers = [] as Awaited<ReturnType<typeof makeBuyerMatch>>[];
  for (let index = 0; index < 8; index++) buyers.push(await makeBuyerMatch(pool, offer));
  // Exposition (journal) : b0..b4 il y a 3 jours (b0..b2 sponsorisés, 2 apparitions chacun), b5, b6 il y a 20 jours (même boost courant), b7 il y a 40 jours (ancien boost).
  for (const [index, entry] of buyers.slice(0, 5).entries()) {
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "3 days", servings: 2, sponsoredServings: index < 3 ? 2 : 0 });
  }
  for (const entry of buyers.slice(5, 7)) {
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "20 days", servings: 1, sponsoredServings: 1 });
  }
  await insertExposure(pool, { boostId: old, offerId: offer.id, demandId: buyers[7].demand.id, viewerId: buyers[7].buyer.id, firstServedAgo: "40 days", servings: 5, sponsoredServings: 5 });
  // Ouvertures : b0 (2 ouvertures attribuées), b1 (1 attribuée), b2 (1 attribuée), b3 (3 organiques) il y a 2 jours ; b5 il y a 20 jours (organique) ; b7 il y a 40 jours.
  await insertView(pool, { offerId: offer.id, demandId: buyers[0].demand.id, viewerId: buyers[0].buyer.id, boostId: boost, views: 2, daysAgo: 2 });
  await insertView(pool, { offerId: offer.id, demandId: buyers[1].demand.id, viewerId: buyers[1].buyer.id, boostId: boost, views: 1, daysAgo: 2 });
  await insertView(pool, { offerId: offer.id, demandId: buyers[2].demand.id, viewerId: buyers[2].buyer.id, boostId: boost, views: 1, daysAgo: 2 });
  await insertView(pool, { offerId: offer.id, demandId: buyers[3].demand.id, viewerId: buyers[3].buyer.id, views: 3, daysAgo: 2 });
  await insertView(pool, { offerId: offer.id, demandId: buyers[5].demand.id, viewerId: buyers[5].buyer.id, views: 1, daysAgo: 20 });
  await insertView(pool, { offerId: offer.id, demandId: buyers[7].demand.id, viewerId: buyers[7].buyer.id, boostId: old, views: 4, daysAgo: 40 });
  // Contacts : b0 (attribué, 2 révélations) et b3 (organique) il y a 2 jours ; b5 il y a 20 jours ; b6 il y a 1 jour (sans ouverture).
  await insertContact(pool, { offerId: offer.id, demandId: buyers[0].demand.id, viewerId: buyers[0].buyer.id, boostId: boost, reveals: 2, daysAgo: 2 });
  await insertContact(pool, { offerId: offer.id, demandId: buyers[3].demand.id, viewerId: buyers[3].buyer.id, reveals: 1, daysAgo: 2 });
  await insertContact(pool, { offerId: offer.id, demandId: buyers[5].demand.id, viewerId: buyers[5].buyer.id, reveals: 1, daysAgo: 20 });
  await insertContact(pool, { offerId: offer.id, demandId: buyers[6].demand.id, viewerId: buyers[6].buyer.id, reveals: 1, daysAgo: 1 });
  const raw = await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id });
  const { since: weekSince, ...week } = raw.periods["7d"];
  const { since: monthSince, ...month } = raw.periods["30d"];
  const { since: allSince, ...everything } = raw.periods.all;
  assert.ok(weekSince && monthSince && allSince === null);
  assert.equal(raw.needs, 8, "8 besoins correspondants (comptés bruts avant arrondi)");
  assert.ok(raw.readAt instanceof Date, "l'instant de lecture (horloge de la base) accompagne les comptes");

  // ── COMPTES BRUTS (avant arrondi) : 7 jours : exposition b0..b4 ; ouvertures b0..b3 (toutes exposées) ; contacts b0, b3, b6 (b6 n'a pas ouvert).
  assert.deepEqual(week, {
    exposedBuyers: 5, sponsoredBuyers: 3, servings: 10, sponsoredServings: 6,
    openerBuyers: 4, openerBuyersAttributed: 3, opens: 7, opensAttributed: 4,
    contactBuyers: 3, contactBuyersAttributed: 1, reveals: 4,
    openerBuyersExposed: 4, contactBuyersOpened: 2,
  });
  // 30 jours : exposition b0..b6 ; ouvertures b0..b3, b5 (toutes exposées) ; contacts b0, b3, b5, b6 (ouvreurs : b0, b3, b5).
  assert.deepEqual(month, {
    exposedBuyers: 7, sponsoredBuyers: 5, servings: 12, sponsoredServings: 8,
    openerBuyers: 5, openerBuyersAttributed: 3, opens: 8, opensAttributed: 4,
    contactBuyers: 4, contactBuyersAttributed: 1, reveals: 5,
    openerBuyersExposed: 5, contactBuyersOpened: 3,
  });
  // Depuis la publication : tout (b7 : ancien boost, 40 jours).
  assert.deepEqual(everything, {
    exposedBuyers: 8, sponsoredBuyers: 6, servings: 17, sponsoredServings: 13,
    openerBuyers: 6, openerBuyersAttributed: 4, opens: 12, opensAttributed: 8,
    contactBuyers: 4, contactBuyersAttributed: 1, reveals: 5,
    openerBuyersExposed: 6, contactBuyersOpened: 3,
  });
  // Par boost (le plus récent d'abord).
  assert.deepEqual(raw.boosts.map((entry) => entry.boostId), [boost, old]);
  const [currentRaw, previousRaw] = raw.boosts;
  assert.deepEqual(
    { status: currentRaw.status, exposedBuyers: currentRaw.exposedBuyers, sponsoredBuyers: currentRaw.sponsoredBuyers, servings: currentRaw.servings, sponsoredServings: currentRaw.sponsoredServings,
      attributedOpens: currentRaw.attributedOpens, attributedOpeners: currentRaw.attributedOpeners, attributedContactBuyers: currentRaw.attributedContactBuyers,
      attributedReveals: currentRaw.attributedReveals },
    { status: "effective", exposedBuyers: 7, sponsoredBuyers: 5, servings: 12, sponsoredServings: 8, attributedOpens: 4, attributedOpeners: 3, attributedContactBuyers: 1, attributedReveals: 2 },
  );
  assert.deepEqual(
    { status: previousRaw.status, exposedBuyers: previousRaw.exposedBuyers, servings: previousRaw.servings, attributedOpens: previousRaw.attributedOpens, attributedOpeners: previousRaw.attributedOpeners,
      attributedContactBuyers: previousRaw.attributedContactBuyers },
    { status: "expired", exposedBuyers: 1, servings: 5, attributedOpens: 4, attributedOpeners: 1, attributedContactBuyers: 0 },
  );
  for (const forbidden of ["bestPosition", "bestGain", "activeDays", "attributedContactsOpened", "offerCreatedAt"]) {
    assert.equal(forbidden in currentRaw || forbidden in week || forbidden in raw, false, `${forbidden} n'est plus lu ni publié`);
  }

  // ── PUBLIÉ : la sortie du service est EXACTEMENT l'arrondi des comptes bruts, rien d'autre.
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  assert.equal("privacyThreshold" in stats, false);
  assert.deepEqual(stats, buildOfferStats(raw));
  assert.deepEqual(stats.periods.map((period) => period.period), ["7d", "30d", "all"]);
  assert.deepEqual(stats.activeMatches, { needs: about(5) }, "8 besoins : environ 5 (5 à 8)");

  const [weekStats, monthStats, all] = stats.periods;
  assert.equal(all.since, null);
  assert.deepEqual(weekStats.exposure, { servings: about(10), sponsoredServings: about(5), buyersExposed: about(5), buyersSponsored: BELOW }, "5 acheteurs : environ 5 ; 3 sponsorisés : moins de 5 ; 10 apparitions : environ 10");
  assert.deepEqual(monthStats.exposure, { servings: about(10), sponsoredServings: about(5), buyersExposed: about(5), buyersSponsored: about(5) });
  assert.deepEqual(all.exposure, { servings: about(15), sponsoredServings: about(15), buyersExposed: about(5), buyersSponsored: about(5) }, "17 apparitions : environ 15 ; 13 : environ 15 ; 8 acheteurs : environ 5 ; 6 sponsorisés : environ 5");
  assert.deepEqual([all.opens.total, all.opens.uniqueBuyers], [about(10), about(5)], "12 ouvertures : environ 10 ; 6 ouvreurs : environ 5");
  assert.deepEqual(all.opens.attributedToBoost, { opens: about(5), uniqueBuyers: BELOW }, "8 ouvertures attribuées : environ 5 ; 4 ouvreurs attribués : moins de 5");
  assert.deepEqual(all.opens.organic, { opens: BELOW, uniqueBuyers: BELOW });
  assert.deepEqual([all.contacts.uniqueBuyers, all.contacts.reveals], [BELOW, about(5)], "4 contacts : moins de 5 ; 5 révélations : environ 5");
  assert.deepEqual(all.contacts.attributedToBoost, { uniqueBuyers: BELOW });
  assert.deepEqual(all.contacts.organic, { uniqueBuyers: BELOW });
  assert.deepEqual([weekStats.opens.total, weekStats.opens.uniqueBuyers, weekStats.contacts.uniqueBuyers, weekStats.contacts.reveals], [about(5), BELOW, BELOW, BELOW]);
  assert.deepEqual([monthStats.opens.total, monthStats.opens.uniqueBuyers, monthStats.contacts.uniqueBuyers, monthStats.contacts.reveals], [about(5), about(5), BELOW, about(5)]);
  for (const entry of stats.periods) assert.deepEqual(entry.ratios, { openRate: INSUFFICIENT, contactRate: INSUFFICIENT }, `${entry.period} : moins de 10 acheteurs publiés : aucun pourcentage`);
  // ── Par boost : le boost courant (7 acheteurs exposés dont 5 sponsorisés) ; l'ancien (1 acheteur, 5 apparitions d'un seul acheteur).
  assert.deepEqual(stats.boosts.map((entry) => entry.boostId), [boost, old]);
  assert.equal(stats.boosts[0].status, "effective");
  assert.deepEqual(stats.boosts[0].exposure, { servings: about(10), sponsoredServings: about(5), buyersExposed: about(5), buyersSponsored: about(5) });
  assert.deepEqual(stats.boosts[0].attributed, { opens: BELOW, uniqueOpeners: BELOW, uniqueContacts: BELOW, reveals: BELOW });
  assert.equal(stats.boosts[1].status, "expired");
  assert.deepEqual(stats.boosts[1].exposure, { servings: about(5), sponsoredServings: about(5), buyersExposed: BELOW, buyersSponsored: BELOW });
  assert.deepEqual(stats.boosts[1].attributed, { opens: BELOW, uniqueOpeners: BELOW, uniqueContacts: BELOW, reveals: BELOW });
  for (const entry of stats.boosts) assert.deepEqual(entry.ratios, { openRate: INSUFFICIENT, contactRate: INSUFFICIENT });
  assert.equal(/"(bestPosition|bestGain|activeDays)"/.test(JSON.stringify(stats)), false);
});

test("statistiques : jeu LARGE (23 acheteurs, un boost) : comptes arrondis à 5 près, part attribuée ET organique publiées, taux calculés sur les nombres publiés", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  await ageOffer(pool, offer.id, 100);
  const boost = await makeBoost(pool, offer, { startsAgo: "3 days", endsIn: "4 days" });
  const buyers = [] as Awaited<ReturnType<typeof makeBuyerMatch>>[];
  for (let index = 0; index < 23; index++) buyers.push(await makeBuyerMatch(pool, offer));
  const at = (index: number) => ({ offerId: offer.id, demandId: buyers[index].demand.id, viewerId: buyers[index].buyer.id });
  // Exposition (il y a 2 jours, pendant le boost) : b0..b9 ; sponsorisés (2 apparitions) : b0..b6 ; seulement non sponsorisés (2 apparitions) : b7..b9.
  for (let index = 0; index < 10; index++) await insertExposure(pool, { boostId: boost, ...at(index), firstServedAgo: "2 days", servings: 2, sponsoredServings: index < 7 ? 2 : 0 });
  // Il y a 2 jours : ouvreurs ATTRIBUÉS b0..b3 (2 ouvertures chacun), ouvreurs organiques b8, b9, b10..b13 (1 ouverture).
  for (let index = 0; index < 4; index++) await insertView(pool, { ...at(index), boostId: boost, views: 2, daysAgo: 2 });
  for (const index of [8, 9, 10, 11, 12, 13]) await insertView(pool, { ...at(index), views: 1, daysAgo: 2 });
  // Il y a 20 jours : 5 ouvreurs organiques de plus (b14..b18) ; il y a 60 jours : 4 de plus (b19..b22).
  for (let index = 14; index < 19; index++) await insertView(pool, { ...at(index), views: 1, daysAgo: 20 });
  for (let index = 19; index < 23; index++) await insertView(pool, { ...at(index), views: 1, daysAgo: 60 });
  // Contacts : il y a 2 jours b0, b1 (attribués) et b8, b10, b11 (organiques) ; il y a 20 jours b14..b17 ; il y a 60 jours b19..b21.
  for (const index of [0, 1]) await insertContact(pool, { ...at(index), boostId: boost, reveals: 1, daysAgo: 2 });
  for (const index of [8, 10, 11]) await insertContact(pool, { ...at(index), reveals: 1, daysAgo: 2 });
  for (let index = 14; index < 18; index++) await insertContact(pool, { ...at(index), reveals: 1, daysAgo: 20 });
  for (let index = 19; index < 22; index++) await insertContact(pool, { ...at(index), reveals: 1, daysAgo: 60 });
  const raw = await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id });
  // Comptes bruts : 7 j : exposés 10 (7 sponsorisés), 20 apparitions (14 sponsorisées) ; ouvreurs 10 (4 attribués, 6 exposés), 14 ouvertures (8 attribuées) ; contacts 5 (2 attribués, tous ouvreurs), 5 révélations.
  const { since: ignoredWeek, ...week } = raw.periods["7d"];
  const { since: ignoredMonth, ...month } = raw.periods["30d"];
  const { since: ignoredAll, ...everything } = raw.periods.all;
  void [ignoredWeek, ignoredMonth, ignoredAll];
  assert.deepEqual(week, {
    exposedBuyers: 10, sponsoredBuyers: 7, servings: 20, sponsoredServings: 14, openerBuyers: 10, openerBuyersAttributed: 4, opens: 14, opensAttributed: 8,
    contactBuyers: 5, contactBuyersAttributed: 2, reveals: 5, openerBuyersExposed: 6, contactBuyersOpened: 5,
  });
  assert.deepEqual(month, { ...week, openerBuyers: 15, opens: 19, contactBuyers: 9, reveals: 9, contactBuyersOpened: 9 });
  assert.deepEqual(everything, { ...week, openerBuyers: 19, opens: 23, contactBuyers: 12, reveals: 12, contactBuyersOpened: 12 });
  assert.equal(raw.boosts[0].attributedOpens, 8);

  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  const exposure = { servings: about(20), sponsoredServings: about(15), buyersExposed: about(10), buyersSponsored: about(5) };
  // Exposition : le boost n'a servi que les 3 derniers jours : 7 jours, 30 jours, depuis la publication et le boost ont les MÊMES valeurs.
  for (const entry of stats.periods) assert.deepEqual(entry.exposure, exposure, entry.period);
  assert.deepEqual(stats.boosts[0].exposure, exposure);
  // Ouvertures : 14 / 19 / 23 ouvertures → 15 / 20 / 25 ; 10 / 15 / 19 ouvreurs → 10 / 15 / 20 ; attribués : 8 ouvertures → 5 et 4 ouvreurs → moins de 5 ; organiques : 6 / 11 / 15 ouvertures et ouvreurs.
  assert.deepEqual(stats.periods.map((entry) => [entry.opens.total, entry.opens.uniqueBuyers]), [[about(15), about(10)], [about(20), about(15)], [about(25), about(20)]]);
  for (const entry of stats.periods) assert.deepEqual(entry.opens.attributedToBoost, { opens: about(5), uniqueBuyers: BELOW }, entry.period);
  assert.deepEqual(stats.periods.map((entry) => entry.opens.organic), [
    { opens: about(5), uniqueBuyers: about(5) }, { opens: about(10), uniqueBuyers: about(10) }, { opens: about(15), uniqueBuyers: about(15) },
  ]);
  // Contacts : 5 / 9 / 12 contacts → 5 / 10 / 10 ; attribués : 2 (moins de 5) ; organiques : 3, 7, 10 → moins de 5, environ 5, environ 10.
  assert.deepEqual(stats.periods.map((entry) => [entry.contacts.uniqueBuyers, entry.contacts.reveals]), [[about(5), about(5)], [about(10), about(10)], [about(10), about(10)]]);
  for (const entry of stats.periods) assert.deepEqual(entry.contacts.attributedToBoost, { uniqueBuyers: BELOW }, entry.period);
  assert.deepEqual(stats.periods.map((entry) => entry.contacts.organic), [{ uniqueBuyers: BELOW }, { uniqueBuyers: about(5) }, { uniqueBuyers: about(10) }]);
  // Taux, calculés sur les nombres publiés : ouverture (6 → 5 sur 10) : pas de pourcentage ; contact : 5 sur 10 → insuffisant en 7 jours (5 < 10), 9 → 10 sur 15 en 30 jours : 67 % → 70 %, 12 → 10 sur 19 → 20 : 50 %.
  assert.deepEqual(stats.periods.map((entry) => entry.ratios), [
    { openRate: INSUFFICIENT, contactRate: INSUFFICIENT },
    { openRate: INSUFFICIENT, contactRate: { kind: "percent", value: 70 } },
    { openRate: INSUFFICIENT, contactRate: { kind: "percent", value: 50 } },
  ]);
  // Boost : 7 servis sponsorisés → environ 5 ; 4 ouvreurs attribués → moins de 5, 8 ouvertures → environ 5 ; 2 contacts attribués (moins de 5). Aucun taux (numérateurs et dénominateur sous 10).
  assert.deepEqual(stats.boosts[0].attributed, { opens: about(5), uniqueOpeners: BELOW, uniqueContacts: BELOW, reveals: BELOW });
  assert.deepEqual(stats.boosts[0].ratios, { openRate: INSUFFICIENT, contactRate: INSUFFICIENT });
  assert.deepEqual(stats.activeMatches, { needs: about(25) });
  assert.deepEqual(stats, buildOfferStats(raw));
});

test("statistiques : AUCUNE identité ni identifiant dans la sortie sérialisée ; aucun compte exact ; le propriétaire seul y accède (inconnue et autrui : même refus)", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boost = await makeBoost(pool, offer);
  const one = await makeBuyerMatch(pool, offer);
  const two = await makeBuyerMatch(pool, offer);
  for (const entry of [one, two]) {
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "1 hour", servings: 7, sponsoredServings: 7 });
    await view(offer.id, entry.demand.id, entry.buyer.id);
    await reveal(entry.buyer.id, entry.demand.id, offer.id);
  }
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  const text = JSON.stringify(stats);
  for (const secret of [one.buyer.id, two.buyer.id, one.demand.id, two.demand.id, seller.id, offer.id, one.buyer.phone ?? "", seller.phone ?? "", "viewer", "demand_id", "RAW_SECRET_TEXT"]) {
    assert.equal(text.includes(secret), false, `la sortie ne doit pas contenir ${secret}`);
  }
  // Deux acheteurs : tous leurs comptes d'acheteurs sont « moins de 5 » ; leurs 14 apparitions : « environ 15 » (jamais « 14 ») ; aucun taux.
  const all = stats.periods[2];
  for (const count of [all.exposure?.buyersExposed, all.opens.total, all.opens.uniqueBuyers, all.contacts.uniqueBuyers, all.contacts.reveals]) assert.deepEqual(count, BELOW);
  assert.deepEqual(all.exposure?.servings, about(15));
  assert.deepEqual(stats.boosts[0].ratios, { openRate: INSUFFICIENT, contactRate: INSUFFICIENT });
  assert.equal(/"value":(?:1|2|7|14)[,}]/.test(text), false, "ni 1, ni 2, ni les 7 apparitions ou 14 en clair");
  // Accès réservé au propriétaire.
  const stranger = await makePerson(pool);
  assert.equal(await failure(readOfferStats({ pool, ownerId: stranger.id, offerId: offer.id })), "resource_not_found");
  assert.equal(await failure(readOfferStats({ pool, ownerId: seller.id, offerId: randomUUID() })), "resource_not_found");
  assert.equal(await failure(readOfferStats({ pool, ownerId: one.buyer.id, offerId: offer.id })), "resource_not_found", "un acheteur qui a ouvert la fiche n'a pas accès aux statistiques");
});

test("statistiques : trois acheteurs identiques (exposés, sponsorisés, ouvreurs, contacts) : tous les comptes d'acheteurs sont « moins de 5 », les 6 apparitions « environ 5 », aucun taux ; 7 acheteurs : « environ 5 »", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boost = await makeBoost(pool, offer);
  const entries = [] as Awaited<ReturnType<typeof makeBuyerMatch>>[];
  for (let index = 0; index < 3; index++) entries.push(await makeBuyerMatch(pool, offer));
  for (const entry of entries) {
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "1 hour", servings: 2, sponsoredServings: 2 });
    await view(offer.id, entry.demand.id, entry.buyer.id);
    await reveal(entry.buyer.id, entry.demand.id, offer.id);
  }
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  const all = stats.periods[2];
  // L'annonce est toute neuve : 7 jours, 30 jours et depuis la publication ont les mêmes comptes.
  for (const entry of stats.periods) {
    assert.deepEqual([entry.exposure?.buyersExposed, entry.opens.uniqueBuyers, entry.contacts.uniqueBuyers], [BELOW, BELOW, BELOW], entry.period);
    assert.deepEqual(entry.exposure?.servings, about(5), "6 apparitions");
    assert.deepEqual(entry.opens.total, BELOW);
    assert.deepEqual(entry.contacts.reveals, BELOW);
    assert.deepEqual(entry.ratios, { openRate: INSUFFICIENT, contactRate: INSUFFICIENT });
  }
  assert.deepEqual(all.opens.attributedToBoost, { opens: BELOW, uniqueBuyers: BELOW });
  assert.deepEqual(all.opens.organic, { opens: BELOW, uniqueBuyers: BELOW }, "0 organique : « moins de 5 », jamais un zéro exact");
  assert.deepEqual(stats.boosts[0].attributed, { opens: BELOW, uniqueOpeners: BELOW, uniqueContacts: BELOW, reveals: BELOW });
  // Quatre acheteurs de plus : 7 acheteurs → « environ 5 ».
  for (let index = 0; index < 4; index++) {
    const entry = await makeBuyerMatch(pool, offer);
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "1 hour", servings: 2, sponsoredServings: 2 });
    await view(offer.id, entry.demand.id, entry.buyer.id);
    await reveal(entry.buyer.id, entry.demand.id, offer.id);
  }
  const seven = (await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id })).periods[2];
  assert.deepEqual([seven.exposure?.buyersExposed, seven.opens.uniqueBuyers, seven.contacts.uniqueBuyers], [about(5), about(5), about(5)]);
  assert.deepEqual(seven.exposure?.servings, about(15), "14 apparitions : environ 15");
});

test("statistiques : deux besoins du MÊME acheteur comptent pour UN acheteur (exposés, ouvreurs, contacts) ; correspondances actives = des besoins", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boost = await makeBoost(pool, offer);
  const buyer = await makePerson(pool);
  const demands = [await makeDemand(pool, buyer.id), await makeDemand(pool, buyer.id)];
  for (const demand of demands) {
    await makeMatch(pool, offer, demand);
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: demand.id, viewerId: buyer.id, firstServedAgo: "1 hour" });
    await view(offer.id, demand.id, buyer.id);
    await reveal(buyer.id, demand.id, offer.id);
  }
  // Sept autres acheteurs : 8 acheteurs, 9 besoins : « environ 10 » besoins, « environ 5 » acheteurs.
  for (let index = 0; index < 7; index++) {
    const entry = await makeBuyerMatch(pool, offer);
    await insertExposure(pool, { boostId: boost, offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, firstServedAgo: "1 hour" });
    await view(offer.id, entry.demand.id, entry.buyer.id);
    await reveal(entry.buyer.id, entry.demand.id, offer.id);
  }
  const raw = await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id });
  assert.equal(raw.needs, 9, "9 besoins");
  assert.deepEqual(
    [raw.periods.all.exposedBuyers, raw.periods.all.openerBuyers, raw.periods.all.contactBuyers, raw.periods.all.opens, raw.periods.all.reveals],
    [8, 8, 8, 9, 9],
    "8 acheteurs (pas 9), 9 ouvertures (une par besoin)",
  );
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  assert.deepEqual(stats.activeMatches, { needs: about(10) }, "9 besoins : environ 10");
  const all = stats.periods[2];
  assert.deepEqual(all.exposure?.buyersExposed, about(5), "8 acheteurs, pas 9 : environ 5 et non environ 10");
  assert.deepEqual(all.opens.uniqueBuyers, about(5));
  assert.deepEqual(all.opens.total, about(10), "9 ouvertures : environ 10");
  assert.deepEqual(all.contacts.uniqueBuyers, about(5));
  assert.deepEqual(all.contacts.reveals, about(10));
});

test("statistiques (K3) : les besoins correspondants sont arrondis (le compte brut reste exact) : 0 à 4 « moins de 5 », 5 à 8 « environ 5 », 9 « environ 10 » ; passer de 0 à 1 ne se voit pas", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const read = async () => ({
    published: (await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id })).activeMatches.needs,
    raw: (await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id })).needs,
  });
  const expectations: Array<[number, unknown]> = [[0, BELOW], [1, BELOW], [4, BELOW], [5, about(5)], [8, about(5)], [9, about(10)]];
  for (const [needs, published] of expectations) {
    while ((await read()).raw < needs) await makeBuyerMatch(pool, offer);
    const seen = await read();
    assert.deepEqual([seen.raw, seen.published], [needs, published], `${needs} besoin(s)`);
  }
});

test("statistiques : annonce sans aucune activité ni boost → « moins de 5 » partout (zéro compris), aucun boost, ni exposition ni part attribuée (tout est organique) ; une annonce brouillon ou en pause reste lisible par son vendeur", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id, { status: "paused" });
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  assert.deepEqual(stats.activeMatches, { needs: BELOW });
  assert.deepEqual(stats.boosts, []);
  for (const period of stats.periods) {
    assert.deepEqual(period.opens.total, BELOW);
    assert.deepEqual(period.contacts.uniqueBuyers, BELOW);
    assert.equal(period.exposure, null, "sans boost : aucune ligne d'exposition");
    assert.equal(period.opens.attributedToBoost, null);
    assert.equal(period.opens.organic, null);
    assert.equal(period.contacts.attributedToBoost, null);
    assert.equal(period.contacts.organic, null);
    assert.deepEqual(period.ratios, { openRate: null, contactRate: INSUFFICIENT });
  }
  assert.equal(/"value":\d/.test(JSON.stringify(stats)), false, "aucun nombre dans la sortie : le zéro non plus");
  const raw = await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id });
  assert.equal(raw.needs, 0);
  assert.equal(raw.periods.all.opens, 0);
});

test("statistiques : « 7 jours » = les 7 derniers jours UTC aujourd'hui compris (jour −6 inclus, jour −7 exclu) ; « 30 jours » de même", async () => {
  await reset();
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  await ageOffer(pool, offer.id, 100);
  for (const daysAgo of [0, 6, 7, 29, 30]) {
    const entry = await makeBuyerMatch(pool, offer);
    await insertView(pool, { offerId: offer.id, demandId: entry.demand.id, viewerId: entry.buyer.id, views: 1, daysAgo });
  }
  const stats = await readOfferStats({ pool, ownerId: seller.id, offerId: offer.id });
  // Comptes BRUTS (avant arrondi) : 7 j : jours 0 et 6 → 2 acheteurs ; 30 j : 0, 6, 7, 29 → 4 (jour −29 inclus, jour −30 exclu) ; tout : 5.
  const raw = await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: offer.id });
  assert.deepEqual([raw.periods["7d"].openerBuyers, raw.periods["30d"].openerBuyers, raw.periods.all.openerBuyers], [2, 4, 5]);
  // Publié : 2 et 4 → « moins de 5 » ; 5 → « environ 5 ».
  assert.deepEqual(stats.periods[0].opens.uniqueBuyers, BELOW);
  assert.deepEqual(stats.periods[1].opens.uniqueBuyers, BELOW);
  assert.deepEqual(stats.periods[2].opens.uniqueBuyers, about(5));
  const firstDay = (await rows<{ d: string; e: string }>("SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date - 6)::text AS d, ((clock_timestamp() AT TIME ZONE 'UTC')::date - 29)::text AS e"))[0];
  assert.deepEqual([stats.periods[0].since, stats.periods[1].since, stats.periods[2].since], [firstDay.d, firstDay.e, null]);
});

test("statistiques : lecture seule (aucune écriture, un seul instantané) et table du vendeur isolée ; une autre annonce du même vendeur n'est pas mêlée", async () => {
  await reset();
  const seller = await makePerson(pool);
  const mine = await makeOffer(pool, seller.id);
  const sibling = await makeOffer(pool, seller.id);
  const entry = await makeBuyerMatch(pool, mine);
  await view(mine.id, entry.demand.id, entry.buyer.id);
  const before = await count("offer_views");
  const siblingStats = await readOfferStats({ pool, ownerId: seller.id, offerId: sibling.id });
  assert.deepEqual(siblingStats.periods[2].opens.total, BELOW);
  assert.equal((await readOfferStatsRaw({ pool, ownerId: seller.id, offerId: sibling.id })).periods.all.opens, 0, "l'ouverture de l'autre annonce n'est pas mêlée");
  assert.equal(await count("offer_views"), before);
});
