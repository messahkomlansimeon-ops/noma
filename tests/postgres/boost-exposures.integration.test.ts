import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { BoostError, expireOfferBoosts, grantOfferBoost, readEffectiveBoostedOfferIds, readEffectiveBoostsByOffer } from "../../lib/server/boost/boosts";
import { readOfferBoostExposureStats, type OfferBoostExposureStats } from "../../lib/server/boost/exposures";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import {
  listStoredDemandMatchesForOffer, listStoredOfferMatchesForDemand, type StoredMatchesQueryOptions,
} from "../../lib/server/matching/stored-matches";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const emptySchema = createTemporarySchemaName();
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
let firstMigration: Awaited<ReturnType<typeof runMigrations>>;
const extraPools: Pool[] = [];

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(emptySchema)}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  firstMigration = await runMigrations(pool);
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) {
    for (const name of [schema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(name)} CASCADE`);
    await admin.end();
  }
});

// ───────────── données ─────────────

const reset = () => pool.query("TRUNCATE boost_exposures, boost_quotes, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");
const makeUser = async (): Promise<string> => (await createUser({}, pool)).id;
let phoneSequence = 0;

async function makeOwner(options: { verified?: boolean; ageDays?: number } = {}): Promise<string> {
  const id = await makeUser();
  if (options.verified) {
    phoneSequence += 1;
    await pool.query("INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2, clock_timestamp())", [`+22507${phoneSequence.toString().padStart(8, "0")}`, id]);
  }
  if (options.ageDays !== undefined) await pool.query("UPDATE users SET created_at = clock_timestamp() - ($2::int * interval '1 day') WHERE id = $1", [id, options.ageDays]);
  return id;
}

interface OfferOptions { ownerId: string; price?: number; availability?: "available" | "reserved" | null; status?: "published" | "paused" }
const newOffer = (options: OfferOptions): Promise<OfferRecord> => createOffer({
  ownerId: options.ownerId, rawText: "RAW_SECRET_TEXT offre iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  condition: "good", location: "Cocody", price: { amount: options.price ?? 250_000, currency: "XOF" },
  status: options.status ?? "published", availabilityStatus: options.availability === undefined ? "available" : options.availability,
}, pool);

const newDemand = (ownerId: string, text = "demande iPhone 13"): Promise<DemandRecord> => createDemand({
  ownerId, rawText: `RAW_SECRET_TEXT ${text}`, category: "smartphones", brand: "Apple", model: "iPhone 13", condition: "good", location: "Cocody",
  budget: null, status: "active",
}, pool);

async function cyclesUntilIdle(): Promise<void> {
  for (let index = 0; index < 120; index++) {
    const cycle = await runMatchingCycle({ pool, workerId: "exposures-test" });
    assert.deepEqual(cycle.errors, []);
    if (cycle.idle) return;
  }
  assert.fail("le cycle n'atteint pas l'état idle");
}

const SHARE = 0.15;
const relevanceOptions = (extra: StoredMatchesQueryOptions = {}): StoredMatchesQueryOptions => ({ sort: "relevance", limit: 100, ...extra });
const listFor = (demand: DemandRecord, options: StoredMatchesQueryOptions, db: Pool = pool) =>
  listStoredOfferMatchesForDemand(demand.ownerId, demand.id, options, db);

/**
 * Modèle de référence INDÉPENDANT de placeBoostedItems (règle du plancher et priorité d'ANCIENNETÉ, lot P3), en flottants avec tolérance. L'ordre d'itération de
 * `boosted` est l'ordre d'ancienneté des boosts (le plus ANCIEN d'abord) : à chaque position de promotion, le promouvable restant au boost le plus ancien est
 * promu s'il MONTE (sa position organique dépasse la position finale), jamais selon l'ordre organique.
 */
function referencePlacement(organic: string[], relevances: Map<string, number>, boosted: Iterable<string>, minRelevance: number, share: number) {
  const age = new Map([...boosted].map((id, rank) => [id, rank]));
  const n = organic.length;
  const step = Math.ceil(1 / share - 1e-9);
  const maxPromoted = Math.floor(n * share + 1e-9);
  const queue = [...organic];
  const order: string[] = [];
  const promoted = new Set<string>();
  for (let position = 0; position < n; position++) {
    let pick = queue[0];
    if (position % step === 0 && promoted.size < maxPromoted) {
      const eligible = queue.filter((id) => age.has(id) && relevances.get(id)! >= minRelevance);
      const candidate = eligible.length === 0 ? undefined : eligible.reduce((oldest, id) => (age.get(id)! < age.get(oldest)! ? id : oldest));
      if (candidate !== undefined && organic.indexOf(candidate) > position) { pick = candidate; promoted.add(candidate); }
    }
    queue.splice(queue.indexOf(pick), 1);
    order.push(pick);
  }
  return { order, promoted };
}

interface Organic { ids: string[]; relevances: Map<string, number> }
const readOrganic = async (demand: DemandRecord): Promise<Organic> => {
  const page = await listFor(demand, relevanceOptions());
  return { ids: page.items.map((item) => item.candidateId), relevances: new Map(page.items.map((item) => [item.candidateId, item.relevance])) };
};

interface Expected { position: number; gain: number; sponsored: boolean }
/** Pour une demande : offre boostée → position finale, gain et sponsorisation attendus (calcul indépendant). */
function expectedFor(organic: Organic, boosted: Set<string>, minRelevance: number): Map<string, Expected> {
  const { order, promoted } = referencePlacement(organic.ids, organic.relevances, boosted, minRelevance, SHARE);
  const result = new Map<string, Expected>();
  for (const id of boosted) {
    if (!organic.ids.includes(id)) continue;
    const position = order.indexOf(id);
    result.set(id, { position, gain: Math.max(0, organic.ids.indexOf(id) - position), sponsored: promoted.has(id) });
  }
  return result;
}

interface ExposureRow {
  boost_id: string; offer_id: string; demand_id: string; viewer_id: string; served_day: string;
  servings: number; sponsored_servings: number; best_position: number; best_gain: number;
}
const exposureRows = async (): Promise<ExposureRow[]> => (await pool.query<ExposureRow>(
  `SELECT boost_id, offer_id, demand_id, viewer_id, served_day::text AS served_day, servings, sponsored_servings, best_position, best_gain
     FROM boost_exposures ORDER BY offer_id, demand_id, served_day`)).rows;
const exposureCount = async (): Promise<number> => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM boost_exposures")).rows[0].n;
const clearExposures = () => pool.query("TRUNCATE boost_exposures");
const byOffer = (rows: ExposureRow[]) => new Map(rows.map((row) => [row.offer_id, row]));
const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Le jour de dédoublonnage est le jour UTC de `at` : on évite de traverser minuit UTC pendant un test. */
async function avoidUtcMidnight(): Promise<void> {
  const remaining = 86_400_000 - (Date.now() % 86_400_000);
  if (remaining < 15_000) await new Promise((resolve) => setTimeout(resolve, remaining + 100));
}

function setMinRelevance(value: number) {
  return pool.query("UPDATE boost_settings SET min_relevance = $1 WHERE key = 'default'", [value]);
}

// ───────────── le monde (vrai pipeline) ─────────────

interface World {
  buyer1: string; buyer2: string; seller: string;
  d1: DemandRecord; d1b: DemandRecord; d2: DemandRecord; ds: DemandRecord;
  offers: OfferRecord[];
  organic: { d1: Organic; d1b: Organic; d2: Organic; ds: Organic };
  /** x0 : déjà en tête ; b2 : boosté, ne gagne rien ; s1 : sponsorisé ; u : boosté sous min_relevance. */
  targets: { x0: string; b2: string; s1: string; u: string };
  boostIds: { x0: string; b2: string; s1: string; u: string };
  minRelevance: number;
  boosted: Set<string>;
}
let sharedWorld: Promise<World> | null = null;

function buildWorld(): Promise<World> {
  sharedWorld ??= (async () => {
    await reset();
    const patterns: Array<Partial<OfferOptions>> = [{}, { availability: "reserved" }, { availability: null }, { price: 90_000 }, { price: 330_000 }];
    const offers: OfferRecord[] = [];
    for (let index = 0; index < 28; index++) {
      offers.push(await newOffer({
        ownerId: await makeOwner({ verified: index % 2 === 0, ageDays: [1, 12, 40][index % 3] }),
        price: 100_000 + index * 4_500, ...patterns[index % patterns.length],
      }));
    }
    const buyer1 = await makeUser(), buyer2 = await makeUser();
    const d1 = await newDemand(buyer1, "demande n°1"), d1b = await newDemand(buyer1, "demande n°1 bis"), d2 = await newDemand(buyer2, "demande n°2");
    await cyclesUntilIdle();
    const organicD1 = await readOrganic(d1);
    assert.equal(organicD1.ids.length, 28, "fenêtre réelle : 28 correspondances confirmées");

    const x0 = organicD1.ids[0], b2 = organicD1.ids[4], s1 = organicD1.ids[12], u = organicD1.ids[27];
    const relS1 = organicD1.relevances.get(s1)!, relU = organicD1.relevances.get(u)!;
    const minRelevance = Math.floor(relS1 * 100) / 100;
    assert.ok(relU < minRelevance, `la dernière offre doit être sous le seuil (${relU} < ${minRelevance})`);
    const seller = offers.find((offer) => offer.id === s1)!.ownerId;
    // Le vendeur de l'offre sponsorisée a aussi une demande : ses vues ne doivent jamais être journalisées pour SON boost.
    const ds = await newDemand(seller, "demande du vendeur");
    await cyclesUntilIdle();
    const organic = { d1: organicD1, d1b: await readOrganic(d1b), d2: await readOrganic(d2), ds: await readOrganic(ds) };
    assert.ok(!organic.ds.ids.includes(s1), "le vendeur ne voit pas sa propre offre : évaluations entre propriétaires distincts");

    await setMinRelevance(minRelevance);
    const boostIds = { x0: "", b2: "", s1: "", u: "" };
    for (const [key, offerId] of Object.entries({ x0, b2, s1, u }) as Array<[keyof typeof boostIds, string]>) {
      const offer = offers.find((candidate) => candidate.id === offerId)!;
      boostIds[key] = (await grantOfferBoost({ pool, offerId, ownerId: offer.ownerId, durationCode: "24h", source: "admin_grant" })).boost.id;
    }
    await clearExposures();
    return { buyer1, buyer2, seller, d1, d1b, d2, ds, offers, organic, targets: { x0, b2, s1, u }, boostIds, minRelevance, boosted: new Set([x0, b2, s1, u]) };
  })();
  return sharedWorld;
}

const pageOptions = (cursor?: string): StoredMatchesQueryOptions => relevanceOptions({ limit: 7, ...(cursor ? { cursor } : {}) });

/** Curseur de la page suivante d'UNE demande (un curseur est lié à sa source), fabriqué sans lecture : aucun compteur n'est faussé. `at` = maintenant : les boosts déjà attribués sont effectifs. */
const cursorFor = (demand: DemandRecord, offset = 7): string => Buffer.from(JSON.stringify({
  v: 1, sort: "relevance", sourceKind: "demand", sourceId: demand.id, offset, at: new Date().toISOString().replace(/Z$/, "000Z"),
}), "utf8").toString("base64url");

// ═════════════ 1. Migration 0013 ═════════════

test("migration 0013 : 13 appliquées, la relance n'en applique aucune, chaque CHECK, clé primaire, clés étrangères, index et cascades", async () => {
  assert.equal(firstMigration.applied.length, 28);
  assert.equal(firstMigration.applied.at(-1), "0028_active_search");
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 28);

  const seller = await makeUser(), viewer = await makeUser(), extraViewer = await makeUser();
  const offer = await newOffer({ ownerId: seller }), otherOffer = await newOffer({ ownerId: await makeUser() });
  const demand = await newDemand(viewer, "demande de migration");
  const newBoost = async (offerId: string, ownerId: string) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
       VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', 'active', '24h', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', 'admin_grant')`, [id, offerId, ownerId]);
    return id;
  };
  const boost = await newBoost(offer.id, seller);
  const insert = (fields: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      boost_id: boost, offer_id: offer.id, demand_id: demand.id, viewer_id: viewer, served_day: "2032-01-01",
      first_served_at: "2032-01-01T10:00:00Z", last_served_at: "2032-01-01T10:00:00Z", servings: 3, sponsored_servings: 1, best_position: 4, best_gain: 2, ...fields,
    };
    const columns = Object.keys(row);
    return pool.query(`INSERT INTO boost_exposures (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((column) => row[column]));
  };
  const refuse = (constraint: string, fields: Record<string, unknown>) => assert.rejects(insert(fields), new RegExp(constraint), `${constraint} ${JSON.stringify(fields)}`);

  await refuse("chk_boost_exposures_servings", { servings: 0, sponsored_servings: 0 });
  await refuse("chk_boost_exposures_sponsored_servings", { sponsored_servings: 4 });
  await refuse("chk_boost_exposures_sponsored_servings", { sponsored_servings: -1 });
  await refuse("chk_boost_exposures_best_position", { best_position: -1 });
  await refuse("chk_boost_exposures_best_gain", { best_gain: -1 });
  await refuse("chk_boost_exposures_served_period", { last_served_at: "2032-01-01T09:59:59Z" });
  await refuse("boost_exposures_boost_id_fkey", { boost_id: randomUUID() });
  await refuse("boost_exposures_offer_id_fkey", { offer_id: randomUUID() });
  await refuse("boost_exposures_demand_id_fkey", { demand_id: randomUUID() });
  await refuse("boost_exposures_viewer_id_fkey", { viewer_id: randomUUID() });
  // Bornes acceptées : 1 apparition, toutes sponsorisées, position 0, gain 0, début = fin.
  await insert({ servings: 1, sponsored_servings: 1, best_position: 0, best_gain: 0 });
  // Clé primaire (boost, demande, jour) ; un autre jour ou une autre demande est une autre ligne.
  await refuse("pk_boost_exposures", {});
  await insert({ served_day: "2032-01-02" });
  assert.equal(await exposureCount(), 2);
  const indexes = new Map((await pool.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'boost_exposures'", [schema])).rows.map((row) => [row.indexname, row.indexdef]));
  assert.match(indexes.get("idx_boost_exposures_offer_day") ?? "", /\(offer_id, served_day\)/);
  assert.ok(indexes.has("pk_boost_exposures"));

  // Cascades : le boost, la demande, l'acheteur et l'offre journalisée emportent leurs lignes.
  await pool.query("DELETE FROM offer_boosts WHERE id = $1", [boost]);
  assert.equal(await exposureCount(), 0, "boost supprimé → lignes supprimées");
  const boost2 = await newBoost(offer.id, seller);
  await insert({ boost_id: boost2 });
  await pool.query("DELETE FROM demands WHERE id = $1", [demand.id]);
  assert.equal(await exposureCount(), 0, "demande supprimée → lignes supprimées");
  const demand2 = await newDemand(viewer, "demande de migration 2");
  await insert({ boost_id: boost2, demand_id: demand2.id, viewer_id: extraViewer });
  await pool.query("DELETE FROM users WHERE id = $1", [extraViewer]);
  assert.equal(await exposureCount(), 0, "acheteur supprimé → lignes supprimées");
  await insert({ boost_id: boost2, demand_id: demand2.id, offer_id: otherOffer.id });
  await pool.query("DELETE FROM offers WHERE id = $1", [otherOffer.id]);
  assert.equal(await exposureCount(), 0, "offre journalisée supprimée → lignes supprimées");
});

// ═════════════ 2. Page servie, pas fenêtre ═════════════

test("page 1 → lignes pour les SEULS éléments boostés de cette page (valeurs égales à un calcul indépendant) ; page 2 → seulement les siens ; jour UTC de `at`", async () => {
  const world = await buildWorld();
  await avoidUtcMidnight();
  await clearExposures();
  const expected = expectedFor(world.organic.d1, world.boosted, world.minRelevance);
  const { x0, b2, s1, u } = world.targets;
  // Garde du scénario : x0 déjà en tête, b2 au rang 4, s1 sponsorisé et monté, u sous le seuil.
  assert.deepEqual(expected.get(x0), { position: 0, gain: 0, sponsored: false });
  assert.deepEqual(expected.get(b2), { position: 4, gain: 0, sponsored: false });
  assert.equal(expected.get(s1)!.sponsored, true);
  assert.ok(expected.get(s1)!.gain > 0);
  assert.equal(expected.get(u)!.sponsored, false);

  const pages = [];
  let cursor: string | undefined;
  do {
    const page = await listFor(world.d1, pageOptions(cursor));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(pages.length, 4, "28 éléments, 7 par page");
  const day = utcDay(pages[0].readAt);

  // Après CHAQUE page : exactement les éléments boostés des pages déjà servies, avec leurs valeurs exactes.
  await clearExposures();
  cursor = undefined;
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = await listFor(world.d1, pageOptions(cursor));
    cursor = page.nextCursor ?? undefined;
    for (const item of page.items) if (world.boosted.has(item.candidateId)) seen.add(item.candidateId);
    const rows = byOffer(await exposureRows());
    assert.deepEqual([...rows.keys()].sort(), [...seen].sort(), `après la page ${pageIndex + 1} : seulement les boostés des pages servies`);
    for (const [offerId, row] of rows) {
      const want = expected.get(offerId)!;
      assert.deepEqual(
        { servings: row.servings, sponsored: row.sponsored_servings, position: row.best_position, gain: row.best_gain, viewer: row.viewer_id, demand: row.demand_id, day: row.served_day },
        { servings: 1, sponsored: want.sponsored ? 1 : 0, position: want.position, gain: want.gain, viewer: world.buyer1, demand: world.d1.id, day },
        `ligne de ${offerId === x0 ? "x0" : offerId === b2 ? "b2" : offerId === s1 ? "s1" : "u"}`);
      assert.equal(row.boost_id, ({ [x0]: world.boostIds.x0, [b2]: world.boostIds.b2, [s1]: world.boostIds.s1, [u]: world.boostIds.u } as Record<string, string>)[offerId]);
    }
    // Les éléments non boostés ne sont jamais journalisés.
    assert.ok([...rows.keys()].every((offerId) => world.boosted.has(offerId)));
  }
  assert.equal(await exposureCount(), 4);
  // Page 1 seule : x0 et b2, pas s1 (position 7) ni u (position 25).
  await clearExposures();
  await listFor(world.d1, pageOptions());
  assert.deepEqual([...byOffer(await exposureRows()).keys()].sort(), [x0, b2].sort());
});

// ═════════════ 3. Déduplication, acheteurs uniques ═════════════

test("même page 3 fois le même jour → servings 3, 1 acheteur ; autre acheteur → 2 ; autre demande du MÊME acheteur → 1 acheteur unique ; LEAST, GREATEST et sponsored_servings exacts", async () => {
  const world = await buildWorld();
  await avoidUtcMidnight();
  await clearExposures();
  const { x0, b2, s1 } = world.targets;
  const ownerOf = (offerId: string) => world.offers.find((offer) => offer.id === offerId)!.ownerId;
  const stats = async (offerId: string) => (await readOfferBoostExposureStats({ pool, ownerId: ownerOf(offerId), offerId }))[0];

  for (let index = 0; index < 3; index++) await listFor(world.d1, pageOptions());   // la même page, trois fois
  let rows = byOffer(await exposureRows());
  assert.equal(rows.size, 2);
  for (const id of [x0, b2]) assert.deepEqual({ servings: rows.get(id)!.servings, sponsored: rows.get(id)!.sponsored_servings }, { servings: 3, sponsored: 0 });
  assert.equal((await stats(x0)).uniqueBuyersExposed, 1);
  assert.equal((await stats(x0)).servings, 3);
  assert.equal((await stats(x0)).activeDays, 1);

  await listFor(world.d2, pageOptions());                       // un autre acheteur
  assert.equal((await stats(x0)).uniqueBuyersExposed, 2);
  await listFor(world.d1b, pageOptions());                      // une autre demande du MÊME acheteur
  assert.equal((await stats(x0)).uniqueBuyersExposed, 2, "le même acheteur compte une fois");
  assert.equal((await stats(x0)).servings, 5);
  assert.equal((await pool.query("SELECT 1 FROM boost_exposures WHERE offer_id = $1", [x0])).rowCount, 3, "une ligne par demande et par jour");

  // Page 2 (s1 sponsorisé, position montée) par d1 deux fois et par d2 une fois.
  for (const demand of [world.d1, world.d1, world.d2]) await listFor(demand, pageOptions(cursorFor(demand)));
  const s1Stats = await stats(s1);
  assert.deepEqual(
    { servings: s1Stats.servings, sponsored: s1Stats.sponsoredServings, exposed: s1Stats.uniqueBuyersExposed, sponsoredBuyers: s1Stats.uniqueBuyersSponsored },
    { servings: 3, sponsored: 3, exposed: 2, sponsoredBuyers: 2 });
  const upPosition = byOffer(await exposureRows()).get(s1)!;
  const organicRank = world.organic.d1.ids.indexOf(s1);
  assert.ok(upPosition.best_position < organicRank);

  // Même boost, même demande, même jour : une apparition NON sponsorisée à une position PLUS BASSE ne dégrade pas best_position / best_gain,
  // et sponsored_servings ne compte que les apparitions sponsorisées (seuil relevé au-dessus de s1 : plus de promotion).
  await setMinRelevance(world.minRelevance + 0.5);
  try {
    const before = (await exposureRows()).find((row) => row.offer_id === s1 && row.demand_id === world.d1.id)!;
    const page = await listFor(world.d1, pageOptions(cursorFor(world.d1)));
    assert.ok(page.items.every((item) => item.sponsored === false), "plus personne n'est sponsorisé");
    const after = (await exposureRows()).find((row) => row.offer_id === s1 && row.demand_id === world.d1.id)!;
    assert.equal(after.servings, 3, "d1 avait 2 apparitions de s1 : la troisième s'ajoute");
    assert.equal(after.sponsored_servings, 2, "la troisième n'est pas sponsorisée");
    assert.equal(after.best_position, before.best_position, "LEAST : la meilleure position reste la plus haute");
    assert.equal(after.best_gain, before.best_gain, "GREATEST : le meilleur gain reste le plus grand");
    assert.equal(after.servings, before.servings + 1);
  } finally {
    await setMinRelevance(world.minRelevance);
  }
  rows = byOffer(await exposureRows());
  assert.ok(rows.size >= 3);
});

// ═════════════ 4. Ce qui n'est jamais enregistré ═════════════

test("rien n'est enregistré pour sort=score, le tri par défaut, le sens offre, une page sans offre boostée, ni pour un repli organique (boost_settings vidée)", async () => {
  const world = await buildWorld();
  await clearExposures();
  const { s1 } = world.targets;
  // sort=score et tri par défaut : toutes les pages.
  for (const options of [{ sort: "score" as const, limit: 7 }, { limit: 7 }]) {
    let cursor: string | undefined;
    do {
      const page = await listFor(world.d1, { ...options, ...(cursor ? { cursor } : {}) });
      assert.ok(page.items.every((item) => item.sponsored === false));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(await exposureCount(), 0, `aucune ligne pour ${JSON.stringify(options)}`);
  }
  // Sens offre : le vendeur lit les demandes candidates de son offre boostée.
  const sellerOfS1 = world.offers.find((offer) => offer.id === s1)!;
  const offerSide = await listStoredDemandMatchesForOffer(sellerOfS1.ownerId, s1, relevanceOptions(), pool);
  assert.ok(offerSide.items.length >= 1);
  assert.equal(await exposureCount(), 0, "sens offre : aucune ligne");
  // Une page sans aucune offre boostée (page 3 : positions 14 à 20) ne produit aucune écriture.
  const page1 = await listFor(world.d1, pageOptions());
  await clearExposures();
  const page2 = await listFor(world.d1, pageOptions(page1.nextCursor!));
  const page3 = await listFor(world.d1, pageOptions(page2.nextCursor!));
  assert.ok(page3.items.every((item) => !world.boosted.has(item.candidateId)));
  await clearExposures();
  await listFor(world.d1, pageOptions(page2.nextCursor!));
  assert.equal(await exposureCount(), 0, "page 3 : aucune offre boostée → aucune écriture");

  // Repli organique : réglages absents → ordre organique, sponsored faux, aucun journal.
  const settings = (await pool.query("SELECT * FROM boost_settings WHERE key = 'default'")).rows[0];
  await pool.query("DELETE FROM boost_settings WHERE key = 'default'");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  try {
    const fallback = await listFor(world.d1, pageOptions());
    assert.deepEqual(fallback.items.map((item) => item.candidateId), world.organic.d1.ids.slice(0, 7), "repli : ordre organique");
    assert.ok(fallback.items.every((item) => item.sponsored === false));
    assert.equal(await exposureCount(), 0, "repli organique : aucun journal");
    assert.ok(errors.some((line) => line.startsWith("[matching] étape boost ignorée (")));
    assert.ok(!errors.some((line) => line.includes("journal d'exposition")));
  } finally {
    console.error = originalError;
    await pool.query(
      `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [settings.key, settings.slot_ratio, settings.min_slots, settings.max_slots, settings.max_active_per_seller, settings.max_seller_slot_share, settings.max_promoted_share, settings.min_relevance, settings.updated_at]);
  }
});

// ═════════════ 5. Panne du journal ═════════════

function spyPool(real: Pool): { spy: Pool; events: string[] } {
  const events: string[] = [];
  const spy = new Proxy(real, {
    get: (target, property) => {
      if (property !== "connect") return Reflect.get(target, property);
      return async () => {
        events.push("connect");
        const client = await target.connect();
        return new Proxy(client, {
          get: (inner, innerProperty) => {
            if (innerProperty === "query") {
              return (...args: unknown[]) => {
                const first = args[0] as string | { text: string };
                events.push((typeof first === "string" ? first : first.text).replace(/\s+/g, " ").trim().slice(0, 100));
                return (inner.query as (...a: unknown[]) => unknown).apply(inner, args);
              };
            }
            if (innerProperty === "release") {
              return (...args: unknown[]) => { events.push("release"); return (inner.release as (...a: unknown[]) => unknown).apply(inner, args); };
            }
            return Reflect.get(inner, innerProperty);
          },
        }) as PoolClient;
      };
    },
  });
  return { spy, events };
}

const stripAt = (cursor: string | null): unknown => {
  if (cursor === null) return null;
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  delete payload.at;
  return payload;
};
const comparable = (page: Awaited<ReturnType<typeof listFor>>) => ({ ...page, readAt: null, nextCursor: stripAt(page.nextCursor) });

test("panne du journal (table renommée) : réponse strictement identique à la réponse témoin, journal = code seul, lecture READ ONLY puis COMMIT, écriture dans une transaction séparée", async () => {
  const world = await buildWorld();
  await clearExposures();
  const witness = await listFor(world.d1, pageOptions());
  assert.equal(await exposureCount(), 2, "témoin : le journal fonctionne");
  await clearExposures();

  await pool.query("ALTER TABLE boost_exposures RENAME TO boost_exposures_absente");
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  const { spy, events } = spyPool(pool);
  try {
    const failing = await listFor(world.d1, pageOptions(), spy);
    assert.deepEqual(comparable(failing), comparable(witness), "même ordre, mêmes champs, même curseur (hors horloge)");
    assert.deepEqual(failing.items.map((item) => item.sponsored), witness.items.map((item) => item.sponsored));
  } finally {
    console.error = originalError;
    await pool.query("ALTER TABLE boost_exposures_absente RENAME TO boost_exposures");
  }
  assert.deepEqual(lines, ["[matching] journal d'exposition ignoré (42P01)"], "journal serveur : le code seul");
  assert.equal(await exposureCount(), 0);

  // Transaction de lecture : READ ONLY, jamais d'écriture, terminée par COMMIT ; l'écriture vient APRÈS, séparée.
  const firstRelease = events.indexOf("release");
  const readEvents = events.slice(0, firstRelease);
  assert.equal(readEvents[0], "connect");
  assert.equal(readEvents[1], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(readEvents.at(-1), "COMMIT", "la lecture se termine par COMMIT");
  assert.ok(!readEvents.some((event) => /^(INSERT|UPDATE|DELETE|SET LOCAL statement_timeout)/i.test(event) || event === "ROLLBACK"), "aucune écriture, aucun ROLLBACK dans la lecture");
  const writeEvents = events.slice(firstRelease + 1);
  assert.equal(writeEvents[0], "connect", "l'écriture ouvre sa PROPRE transaction");
  assert.equal(writeEvents[1], "BEGIN");
  assert.equal(writeEvents[2], "SET LOCAL statement_timeout = '2s'");
  assert.match(writeEvents[3], /^INSERT INTO boost_exposures/);
  assert.equal(writeEvents[4], "ROLLBACK", "seule l'écriture échoue et est annulée");
  assert.ok(!writeEvents.includes("COMMIT"));
});

test("écriture bloquée au-delà de 2 s (verrou de ligne) : la réponse arrive, identique, journal 57014, aucune ligne modifiée", async () => {
  const world = await buildWorld();
  await clearExposures();
  const witness = await listFor(world.d1, pageOptions());
  const before = await exposureRows();
  assert.equal(before.length, 2);
  const locker = await openVerifiedIsolatedPool(target, schema);
  extraPools.push(locker);
  const lockClient = await locker.connect();
  const lines: string[] = [];
  const originalError = console.error;
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT 1 FROM boost_exposures WHERE offer_id = $1 FOR UPDATE", [world.targets.x0]);
    console.error = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
    const started = Date.now();
    const blocked = await listFor(world.d1, pageOptions());
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1_800 && elapsed < 8_000, `l'écriture a attendu le plafond de 2 s (${elapsed} ms)`);
    assert.deepEqual(comparable(blocked), comparable(witness));
  } finally {
    console.error = originalError;
    await lockClient.query("ROLLBACK").catch(() => {});
    lockClient.release();
  }
  assert.deepEqual(lines, ["[matching] journal d'exposition ignoré (57014)"]);
  assert.deepEqual(await exposureRows(), before, "aucune ligne modifiée par l'écriture abandonnée");
});

// ═════════════ 6. Concurrence ═════════════

test("concurrence : 8 lectures simultanées de la même page (8 pools) → servings = 8 exactement, sans erreur ni blocage", async () => {
  const world = await buildWorld();
  await avoidUtcMidnight();
  await clearExposures();
  const pools: Pool[] = [];
  for (let index = 0; index < 8; index++) {
    const extra = await openVerifiedIsolatedPool(target, schema);
    extraPools.push(extra);
    pools.push(extra);
  }
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  let results: Awaited<ReturnType<typeof listFor>>[];
  try {
    let start!: () => void;
    const gate = new Promise<void>((resolve) => { start = resolve; });
    const attempts = pools.map(async (db) => { await gate; return listFor(world.d1, pageOptions(), db); });
    start();
    results = await Promise.all(attempts);
    // Page 2 (s1 sponsorisé), toujours 8 lectures simultanées.
    const cursor = results[0].nextCursor!;
    const second = pools.map(async (db) => { await gate; return listFor(world.d1, pageOptions(cursor), db); });
    const secondResults = await Promise.all(second);
    assert.ok(secondResults.every((page) => page.items.some((item) => item.sponsored)));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(lines, [], "aucun journal d'erreur : pas de blocage ni de conflit");
  assert.ok(results.every((page) => JSON.stringify(page.items.map((item) => item.candidateId)) === JSON.stringify(results[0].items.map((item) => item.candidateId))));
  const rows = byOffer(await exposureRows());
  const { x0, b2, s1 } = world.targets;
  assert.equal(rows.size, 3);
  assert.deepEqual([rows.get(x0)!.servings, rows.get(b2)!.servings, rows.get(s1)!.servings], [8, 8, 8]);
  assert.deepEqual([rows.get(x0)!.sponsored_servings, rows.get(b2)!.sponsored_servings, rows.get(s1)!.sponsored_servings], [0, 0, 8]);
});

// ═════════════ 7. Vues du vendeur ═════════════

test("vues du vendeur : aucune ligne dont viewer_id est le vendeur du boost (évaluations entre propriétaires distincts), alors que ses vues d'autres boosts sont journalisées", async () => {
  const world = await buildWorld();
  await clearExposures();
  for (const demand of [world.d1, world.d1b, world.d2, world.ds]) {
    let cursor: string | undefined;
    do {
      const page = await listFor(demand, pageOptions(cursor));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  const own = await pool.query("SELECT count(*)::int AS n FROM boost_exposures e JOIN offer_boosts b ON b.id = e.boost_id WHERE e.viewer_id = b.seller_id");
  assert.equal(own.rows[0].n, 0, "un vendeur ne voit jamais son propre boost");
  const sellerRows = (await exposureRows()).filter((row) => row.viewer_id === world.seller);
  assert.ok(sellerRows.length >= 1, "le vendeur, acheteur par ailleurs, a bien des apparitions d'AUTRES boosts journalisées");
  assert.ok(sellerRows.every((row) => row.boost_id !== world.boostIds.s1));
  assert.ok(!(await exposureRows()).some((row) => row.demand_id === world.ds.id && row.offer_id === world.targets.s1));
});

// ═════════════ 7b. Non-régression : ordre final et sponsored identiques avec et sans journal ═════════════

test("non-régression : ordre final et `sponsored` identiques avec la table d'exposition, sans elle (journal en panne) et au modèle de référence", async () => {
  const world = await buildWorld();
  await clearExposures();
  const walk = async () => {
    const ids: string[] = [], sponsored: boolean[] = [];
    let cursor: string | undefined;
    do {
      const page = await listFor(world.d1, pageOptions(cursor));
      for (const item of page.items) { ids.push(item.candidateId); sponsored.push(item.sponsored); }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { ids, sponsored };
  };
  const withTable = await walk();
  assert.ok(await exposureCount() > 0);
  const reference = referencePlacement(world.organic.d1.ids, world.organic.d1.relevances, world.boosted, world.minRelevance, SHARE);
  assert.deepEqual(withTable.ids, reference.order, "ordre final = modèle de référence indépendant");
  assert.deepEqual(withTable.sponsored, reference.order.map((id) => reference.promoted.has(id)));
  assert.ok(withTable.sponsored.some(Boolean) && withTable.sponsored.some((flag) => !flag));

  await pool.query("ALTER TABLE boost_exposures RENAME TO boost_exposures_absente");
  const originalError = console.error;
  console.error = () => {};
  let withoutTable: Awaited<ReturnType<typeof walk>>;
  try {
    withoutTable = await walk();
  } finally {
    console.error = originalError;
    await pool.query("ALTER TABLE boost_exposures_absente RENAME TO boost_exposures");
  }
  assert.deepEqual(withoutTable, withTable, "même ordre, mêmes sponsored, sans la table d'exposition");
});

// ═════════════ 7c. readEffectiveBoostsByOffer = readEffectiveBoostedOfferIds (diff de résultat nul) ═════════════

test("readEffectiveBoostsByOffer : mêmes offres que readEffectiveBoostedOfferIds dans toutes les situations de 2I1 et à plusieurs instants, avec le boost correspondant", async () => {
  await reset();
  sharedWorld = null;
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 9; index++) offers.push(await newOffer({ ownerId: await makeUser() }));
  const boosts: string[] = [];
  for (const offer of offers) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
       VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', 'active', '24h', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', 'admin_grant')`,
      [id, offer.id, offer.ownerId]);
    boosts.push(id);
  }
  // 0 effectif ; 1 annulé ; 2 expiré ; 3 futur ; 4 vendeur suspendu ; 5 offre en pause ; 6 offre indisponible ; 7 autre produit ; 8 clé à casse et espaces différents.
  await pool.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [boosts[1]]);
  await pool.query("UPDATE offer_boosts SET status = 'expired' WHERE id = $1", [boosts[2]]);
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() + interval '1 hour', ends_at = clock_timestamp() + interval '2 hours' WHERE id = $1", [boosts[3]]);
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [offers[4].ownerId]);
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offers[5].id]);
  await pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [offers[6].id]);
  await pool.query("UPDATE offers SET model = 'iPhone 14' WHERE id = $1", [offers[7].id]);
  await pool.query("UPDATE offers SET brand = ' APPLE ' WHERE id = $1", [offers[8].id]);

  const iso = (expression: string) => pool.query<{ at: string }>(
    `SELECT to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM offer_boosts WHERE id = $1`, [boosts[0]]).then((result) => result.rows[0].at);
  const instants = [
    await iso("clock_timestamp()"), await iso("starts_at - interval '1 second'"), await iso("starts_at"), await iso("ends_at - interval '1 microsecond'"),
    await iso("ends_at"), await iso("ends_at + interval '1 hour'"),
  ];
  const ids = offers.map((offer) => offer.id);
  for (const at of instants) {
    const legacy = await readEffectiveBoostedOfferIds(pool, ids, at);
    const withBoost = await readEffectiveBoostsByOffer(pool, ids, at);
    assert.deepEqual([...withBoost.keys()].sort(), [...legacy].sort(), `mêmes offres à ${at}`);
    for (const [offerId, boostId] of withBoost) assert.equal(boostId, boosts[ids.indexOf(offerId)], "le boost renvoyé est celui de l'offre");
  }
  assert.deepEqual([...(await readEffectiveBoostsByOffer(pool, ids, instants[0])).keys()].map((id) => ids.indexOf(id)).sort(), [0, 8].sort(), "à l'instant courant : seuls 0 et 8 sont effectifs");
  assert.deepEqual([...(await readEffectiveBoostsByOffer(pool, [], instants[0])).keys()], []);
});

// ═════════════ 7d. Balayage entre deux pages ═════════════

test("balayage entre deux pages : un curseur dont `at` précède l'échéance garde le boost TANT QUE le boost est encore « active » ; une fois marqué expired, les pages suivantes n'en tiennent plus compte (statut lu à l'instantané de chaque page)", async () => {
  const world = await buildWorld();
  await clearExposures();
  const { s1 } = world.targets;
  const original = (await pool.query("SELECT starts_at, ends_at FROM offer_boosts WHERE id = $1", [world.boostIds.s1])).rows[0];
  // Boost de s1 échu depuis 10 minutes ; le curseur date d'il y a 30 minutes (dans la tolérance d'une heure) : à `at`, seul ce boost était
  // effectif (les autres ont été attribués après `at`), donc s1 est promu à la première position de promotion (0).
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 hours', ends_at = clock_timestamp() - interval '10 minutes' WHERE id = $1", [world.boostIds.s1]);
  const oldCursor = Buffer.from(JSON.stringify({
    v: 1, sort: "relevance", sourceKind: "demand", sourceId: world.d1.id, offset: 0, at: new Date(Date.now() - 30 * 60_000).toISOString().replace(/Z$/, "000Z"),
  }), "utf8").toString("base64url");
  try {
    const beforeSweep = await listFor(world.d1, pageOptions(oldCursor));
    const promotedBefore = beforeSweep.items.find((item) => item.candidateId === s1);
    assert.ok(promotedBefore?.sponsored, "boost encore « active » : effectif à `at`, promu en tête");
    assert.equal(beforeSweep.items[0].candidateId, s1);
    assert.equal((await exposureRows()).filter((row) => row.offer_id === s1).length, 1, "l'apparition est journalisée");

    assert.deepEqual(await expireOfferBoosts({ pool, limit: 1 }), { expired: 1 });
    await clearExposures();
    const afterSweep = await listFor(world.d1, pageOptions(oldCursor));
    assert.ok(afterSweep.items.every((item) => item.sponsored === false), "boost expiré : plus aucun avantage");
    assert.deepEqual(afterSweep.items.map((item) => item.candidateId), world.organic.d1.ids.slice(0, 7), "page : ordre organique des rangs 0 à 6");
    assert.equal((await exposureRows()).filter((row) => row.offer_id === s1).length, 0, "rien n'est journalisé pour un boost non effectif");
  } finally {
    await pool.query("UPDATE offer_boosts SET status = 'active', starts_at = $2, ends_at = $3 WHERE id = $1", [world.boostIds.s1, original.starts_at, original.ends_at]);
  }
});

// ═════════════ 8. Lecture vendeur ═════════════

test("readOfferBoostExposureStats : valeurs exactes, propriété, ordre, limite, statuts effectifs ; sortie sérialisée sans viewer_id, demand_id ni identité d'acheteur", async () => {
  await reset();
  sharedWorld = null;
  const seller = await makeUser(), stranger = await makeUser();
  const buyerA = await makeUser(), buyerB = await makeUser();
  const offer = await newOffer({ ownerId: seller }), scheduledOffer = await newOffer({ ownerId: seller });
  const dA1 = await newDemand(buyerA, "A1"), dA2 = await newDemand(buyerA, "A2"), dB = await newDemand(buyerB, "B");
  const makeBoost = async (offerId: string, status: string, startsDays: number, endsDays: number, cancelled = false) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source, cancelled_at)
       VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', $4::text, '24h', clock_timestamp() + ($5::numeric * interval '1 day'), clock_timestamp() + ($6::numeric * interval '1 day'), 'admin_grant',
               CASE WHEN $7::boolean THEN clock_timestamp() - interval '4 days' END)`, [id, offerId, seller, status, startsDays, endsDays, cancelled]);
    return id;
  };
  const expiredBoost = await makeBoost(offer.id, "expired", -10, -9);
  const cancelledBoost = await makeBoost(offer.id, "cancelled", -5, -4, true);
  const effectiveBoost = await makeBoost(offer.id, "active", -0.05, 0.95);
  const scheduledBoost = await makeBoost(scheduledOffer.id, "active", 1, 2);
  const expose = (boostId: string, demand: DemandRecord, viewer: string, day: string, servings: number, sponsored: number, position: number, gain: number) =>
    pool.query(
      `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
       VALUES ($1, $2, $3, $4, $5::date, $5::date + time '10:00', $5::date + time '11:00', $6, $7, $8, $9)`, [boostId, offer.id, demand.id, viewer, day, servings, sponsored, position, gain]);
  // Boost expiré : deux acheteurs, deux jours.
  await expose(expiredBoost, dA1, buyerA, "2032-01-01", 3, 2, 4, 3);
  await expose(expiredBoost, dA1, buyerA, "2032-01-02", 2, 0, 6, 0);
  await expose(expiredBoost, dB, buyerB, "2032-01-01", 1, 1, 2, 5);
  // Boost effectif : un seul acheteur, DEUX demandes (compte une fois), jamais sponsorisé.
  await expose(effectiveBoost, dA1, buyerA, "2032-01-03", 4, 0, 0, 0);
  await expose(effectiveBoost, dA2, buyerA, "2032-01-03", 1, 0, 5, 0);

  const stats = await readOfferBoostExposureStats({ pool, ownerId: seller, offerId: offer.id });
  const summary = (entry: OfferBoostExposureStats) => ({
    id: entry.boostId, status: entry.status, exposed: entry.uniqueBuyersExposed, sponsoredBuyers: entry.uniqueBuyersSponsored, servings: entry.servings,
    sponsored: entry.sponsoredServings, bestPosition: entry.bestPosition, bestGain: entry.bestGain, days: entry.activeDays, duration: entry.durationCode,
  });
  assert.deepEqual(stats.map(summary), [
    { id: effectiveBoost, status: "effective", exposed: 1, sponsoredBuyers: 0, servings: 5, sponsored: 0, bestPosition: 0, bestGain: 0, days: 1, duration: "24h" },
    { id: cancelledBoost, status: "cancelled", exposed: 0, sponsoredBuyers: 0, servings: 0, sponsored: 0, bestPosition: null, bestGain: null, days: 0, duration: "24h" },
    { id: expiredBoost, status: "expired", exposed: 2, sponsoredBuyers: 2, servings: 6, sponsored: 3, bestPosition: 2, bestGain: 5, days: 2, duration: "24h" },
  ], "du plus récent au plus ancien, valeurs exactes");
  assert.ok(stats[0].startsAt.getTime() > stats[1].startsAt.getTime() && stats[1].startsAt.getTime() > stats[2].startsAt.getTime());
  // Statut effectif : une échéance passée sur un boost encore « active » est « expired ».
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 hours', ends_at = clock_timestamp() - interval '1 minute' WHERE id = $1", [effectiveBoost]);
  assert.equal((await readOfferBoostExposureStats({ pool, ownerId: seller, offerId: offer.id }))[0].status, "expired");
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '1 hour', ends_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [effectiveBoost]);
  const scheduled = await readOfferBoostExposureStats({ pool, ownerId: seller, offerId: scheduledOffer.id });
  assert.deepEqual(scheduled.map((entry) => [entry.boostId, entry.status, entry.servings, entry.bestPosition]), [[scheduledBoost, "scheduled", 0, null]]);

  // Limite 1 à 20 (défaut 20), validée avant tout SQL.
  assert.equal((await readOfferBoostExposureStats({ pool, ownerId: seller, offerId: offer.id, limit: 2 })).length, 2);
  assert.equal((await readOfferBoostExposureStats({ pool, ownerId: seller, offerId: offer.id, limit: 1 }))[0].boostId, effectiveBoost);
  for (const bad of [0, 21, -1, 1.5, Number.NaN, "3" as unknown as number, null as unknown as number]) {
    await assert.rejects(readOfferBoostExposureStats({ pool, ownerId: seller, offerId: offer.id, limit: bad }), CatalogValidationError, `limit=${String(bad)}`);
  }
  await assert.rejects(readOfferBoostExposureStats({ pool, ownerId: "pas-un-uuid", offerId: offer.id }), CatalogValidationError);
  await assert.rejects(readOfferBoostExposureStats({ pool, ownerId: seller, offerId: "pas-un-uuid" }), CatalogValidationError);
  await assert.rejects(readOfferBoostExposureStats({ pool: undefined as unknown as Pool, ownerId: seller, offerId: offer.id }), CatalogValidationError);
  // Propriété : offre d'autrui et offre inexistante ont chacune leur code de domaine ; rien n'est lu pour un autre vendeur.
  await assert.rejects(readOfferBoostExposureStats({ pool, ownerId: stranger, offerId: offer.id }), (error: unknown) => error instanceof BoostError && error.code === "offer_not_owned");
  await assert.rejects(readOfferBoostExposureStats({ pool, ownerId: seller, offerId: randomUUID() }), (error: unknown) => error instanceof BoostError && error.code === "offer_not_found");
  assert.deepEqual(await readOfferBoostExposureStats({ pool, ownerId: stranger, offerId: (await newOffer({ ownerId: stranger })).id }), [], "offre sans boost : liste vide");

  // Sortie sérialisée : des comptages, jamais d'identité d'acheteur, de demande ni de clé interne.
  const serialized = JSON.stringify(stats);
  for (const secret of [buyerA, buyerB, dA1.id, dA2.id, dB.id, "viewer", "demand", "viewer_id", "demand_id", "servedDay", "RAW_SECRET_TEXT"]) {
    assert.ok(!serialized.includes(secret), `la sortie ne doit pas contenir ${secret}`);
  }
  assert.deepEqual(Object.keys(stats[0]).sort(), [
    "activeDays", "bestGain", "bestPosition", "boostId", "durationCode", "endsAt", "servings", "sponsoredServings", "startsAt", "status",
    "uniqueBuyersExposed", "uniqueBuyersSponsored",
  ].sort());
});

// ═════════════ 9. Commande boost:stats ═════════════

test("script boost:stats : succès (mention « administration », comptages sans identité), refus et erreurs → code 1, textes fixes, SQLSTATE seul", async () => {
  await reset();
  sharedWorld = null;
  const seller = await makeUser(), buyer = await makeUser();
  const offer = await newOffer({ ownerId: seller }), bare = await newOffer({ ownerId: await makeUser() });
  const demand = await newDemand(buyer, "script");
  const boost = randomUUID();
  await pool.query(
    `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
     VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', 'active', '3d', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', 'admin_grant')`, [boost, offer.id, seller]);
  await pool.query(
    `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
     VALUES ($1, $2, $3, $4, '2032-01-01', clock_timestamp(), clock_timestamp(), 4, 1, 2, 3)`, [boost, offer.id, demand.id, buyer]);
  const STATS = "scripts/boost-stats.ts";
  const ok = await runScript(STATS, ["--offer", offer.id], schema);
  assert.equal(ok.code, 0, ok.output);
  const lines = ok.output.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `Boost (administration) : exposition de l'offre ${offer.id}, 1 boost(s).`);
  assert.match(lines[1], new RegExp(`^${boost} \\| 3d \\| effectif \\| du \\d{4}-[\\d-]+T[\\d:.]+Z au \\d{4}-[\\d-]+T[\\d:.]+Z \\| apparitions servies : 4 \\(dont 1 sponsorisée\\(s\\)\\) \\| acheteurs uniques : 1 exposé\\(s\\), 1 sponsorisé\\(s\\) \\| meilleure position : 2 \\| gain maximal : 3 \\| jours actifs : 1$`));
  const none = await runScript(STATS, ["--offer", bare.id], schema);
  assert.equal(none.code, 0);
  assert.equal(none.output.trim(), `Boost (administration) : exposition de l'offre ${bare.id}, 0 boost(s).`);

  const unknown = await runScript(STATS, ["--offer", randomUUID()], schema);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.output.trim(), "Boost (administration) : refus offer_not_found (Offre introuvable.)");
  const bad: string[][] = [[], ["--offer"], ["--offer", "pas-un-uuid"], ["--duration", "24h"], ["--offer", offer.id, "--offer", bare.id], ["--offer", offer.id, "extra"], ["--offer", "--json"]];
  for (const args of bad) {
    const result = await runScript(STATS, args, schema);
    assert.equal(result.code, 1, JSON.stringify(args) + result.output);
    assert.match(result.output, /^Boost \(administration\) : .*Usage : npm run boost:stats -- --offer <uuid>/m, JSON.stringify(args));
  }
  const noUrl = await runScript(STATS, ["--offer", offer.id], schema, { DATABASE_URL: "" });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.output, /DATABASE_URL est requis/);
  const missing = await runScript(STATS, ["--offer", offer.id], emptySchema);
  assert.equal(missing.code, 1);
  assert.equal(missing.output.trim(), "Boost (administration) : erreur 42P01.");
  for (const output of [ok.output, none.output, unknown.output, noUrl.output, missing.output]) {
    for (const forbidden of [buyer, demand.id, "viewer", "RAW_SECRET_TEXT", "postgres://", "noma_local", "SELECT", "relation"]) {
      assert.ok(!output.includes(forbidden), `fuite « ${forbidden} » dans : ${output}`);
    }
  }
});
