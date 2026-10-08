import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { listExternalMatchesForDemand } from "../../lib/server/external/matching";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { DEMO_BUYER_PHONE, DEMO_BUYER_DEMANDS, DEMO_EXTRA_BUYER_COUNT, DEMO_HISTORY_SELLER_COUNT, demandRawText } from "../../scripts/demo-seed-plan";
import { runScript } from "./run-script";
import { openVerifiedTestDatabase } from "./test-database";

/**
 * `npm run demo:seed` et la collecte externe (lot EXT1) : surveillances de marché et annonces d'autres sites FICTIVES pour les besoins de l'acheteur démo, rejouables à l'identique.
 * Base jetable `noma_essai_*` ; le script est lancé en processus enfant avec NODE_ENV=development.
 */

const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const mainDb = `noma_essai_${suffix}`;
let admin: Pool, pool: Pool;
let baseUrl: string;
const urlFor = (database: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  baseUrl = opened.target.connectionString;
  await admin.query(`CREATE DATABASE "${mainDb}"`);
  pool = new Pool({ connectionString: urlFor(mainDb), max: 4 });
  assert.equal((await runMigrations(pool)).applied.at(-1), "0026_sublymus_payments");
});

after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${mainDb}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

const seed = () => runScript("scripts/demo-seed.ts", [], "public", { NODE_ENV: "development", DATABASE_URL: urlFor(mainDb) });

async function externalState() {
  const read = async (sql: string) => (await pool.query<{ n: string }>(sql)).rows[0].n;
  return {
    watches: await read("SELECT count(*)::text AS n FROM market_watches"),
    activeWatches: await read("SELECT count(*)::text AS n FROM market_watches WHERE status = 'active'"),
    listings: await read("SELECT count(*)::text AS n FROM external_listings"),
    analyses: await read("SELECT count(*)::text AS n FROM external_analyses"),
    observations: await read("SELECT count(*)::text AS n FROM source_observations"),
    groups: await read("SELECT count(*)::text AS n FROM duplicate_groups"),
    users: await read("SELECT count(*)::text AS n FROM users"),
    offers: await read("SELECT count(*)::text AS n FROM offers"),
  };
}

test("premier passage : 14 besoins actifs → 3 surveillances (mutualisation) ; annonces externes fictives pour les trois besoins de l'acheteur démo", async () => {
  const result = await seed();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /demo:seed : collecte externe \(sources FICTIVES, aucun réseau\) : 3 surveillance\(s\) pour l'acheteur démo, \d+ annonce\(s\) externe\(s\) créée\(s\) \(0 déjà présente\(s\)\), 0 panne\(s\) de source, 0 requête\(s\) refusée\(s\) par le budget du jour\./);
  const state = await externalState();
  assert.equal(state.watches, "3", "14 besoins actifs, 3 clés produit : un seul iPhone 12 à Abidjan pour 12 acheteurs");
  assert.equal(state.activeWatches, "3");
  assert.equal(state.offers, "30", "aucune annonce interne ajoutée");
  assert.equal(state.users, String(3 + 7 + DEMO_EXTRA_BUYER_COUNT + DEMO_HISTORY_SELLER_COUNT), "aucun compte ajouté (3 comptes de démonstration, 7 vendeurs, 11 acheteurs et 6 vendeurs d'historique fictifs)");
  assert.ok(Number(state.listings) >= 18, `${state.listings} annonces externes`);
  assert.equal(state.observations, state.listings);
  assert.ok(Number(state.groups) >= 3, "un doublon entre sources par produit");
  const runs = await pool.query("SELECT source_code, count(*)::int AS n FROM external_collect_runs WHERE status = 'ok' GROUP BY source_code ORDER BY source_code");
  assert.deepEqual(runs.rows, [{ source_code: "demo_a", n: 3 }, { source_code: "demo_b", n: 3 }], "une collecte par surveillance et par source, jamais une par besoin");

  // Chaque besoin de l'acheteur démo a des annonces d'autres sites, dans son budget et à Abidjan, sans numéro de téléphone.
  const buyerId = (await pool.query<{ user_id: string }>("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [DEMO_BUYER_PHONE])).rows[0].user_id;
  for (const demand of DEMO_BUYER_DEMANDS) {
    const id = (await pool.query<{ id: string }>("SELECT id FROM demands WHERE owner_id = $1 AND position($2::text in raw_text) > 0", [buyerId, `[demo:seed:${demand.key}]`])).rows[0].id;
    assert.ok(demandRawText(demand).includes(demand.key));
    const page = await listExternalMatchesForDemand({ pool, ownerId: buyerId, demandId: id, limit: 30 });
    assert.ok(!("watching" in page) && !("lastCollectedAt" in page), "la surveillance partagée n'est pas exposée");
    assert.ok(page.items.length >= 3, `${demand.key} : ${page.items.length} annonces d'autres sites`);
    assert.ok(page.items.every((item) => item.price !== null && item.price.amount <= demand.budgetXof && item.url.startsWith("https://annonces-demo-")), demand.key);
    assert.ok(page.items.some((item) => item.alsoOn.length > 0), `${demand.key} : un doublon entre sources présenté une seule fois`);
    assert.ok(!JSON.stringify(page).includes("appelez"), "le numéro de téléphone de l'annonce piégée n'est jamais conservé");
  }
});

test("rejeu à l'identique : aucune annonce externe de plus, aucune analyse de plus, mêmes surveillances", async () => {
  const before = await externalState();
  const result = await seed();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /3 surveillance\(s\) pour l'acheteur démo, 0 annonce\(s\) externe\(s\) créée\(s\) \(\d+ déjà présente\(s\)\), 0 panne\(s\) de source/);
  assert.deepEqual(await externalState(), before);
  const analysesBefore = Number(before.analyses);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM external_analyses")).rows[0].n), analysesBefore, "le même contenu n'est pas réanalysé");
});

test("sans réseau : le script d'amorçage ne contacte aucun hôte externe (les adresses sont du domaine réservé .example)", async () => {
  const hosts = await pool.query<{ host: string }>("SELECT DISTINCT split_part(split_part(canonical_url, '://', 2), '/', 1) AS host FROM external_listings ORDER BY 1");
  assert.deepEqual(hosts.rows.map((row) => row.host), ["annonces-demo-a.example", "annonces-demo-b.example"]);
});
