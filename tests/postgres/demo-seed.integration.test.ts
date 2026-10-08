import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { readBuyerHome, readVendorHome } from "../../lib/server/home/reads";
import { readOfferStats } from "../../lib/server/metrics/stats";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { listStoredOfferMatchesForDemand } from "../../lib/server/matching/stored-matches";
import { readProBadges, readUserEntitlements } from "../../lib/server/subscriptions/entitlements";
import { readPromoSummary } from "../../lib/server/subscriptions/promo";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { readWalletBalance } from "../../lib/server/wallet/ledger";
import { DEMO_ADMIN_PHONE, DEMO_BUYER_PHONE, DEMO_CONTACTERS, DEMO_EXTRA_BUYER_COUNT, DEMO_OFFERS, DEMO_OPENERS, DEMO_VENDOR_CREDIT_XOF, DEMO_VENDOR_PHONE, demoMarker } from "../../scripts/demo-seed-plan";
import { runScript } from "./run-script";
import { openVerifiedTestDatabase } from "./test-database";

/**
 * `npm run demo:seed` (lot D1) sur une base jetable `noma_essai_*` créée à côté de la base de test : vrais services (catalogue, worker du matching jusqu'au repos, boost,
 * journal des ouvertures et des contacts, grand livre), trois comptes aux numéros fixes, REJOUABLE à l'identique. Le script est lancé en processus enfant avec NODE_ENV=development.
 */

const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const mainDb = `noma_essai_${suffix}`;
let admin: Pool, pool: Pool;
let baseUrl: string;
/** Lot PH1 : dossier jetable des photos de démonstration (jamais data/media du dépôt). */
let mediaDir: string;
const urlFor = (database: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "noma-demo-media-"));
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  baseUrl = opened.target.connectionString;
  await admin.query(`CREATE DATABASE "${mainDb}"`);
  pool = new Pool({ connectionString: urlFor(mainDb), max: 4 });
  assert.equal((await runMigrations(pool)).applied.length, 22);
});

after(async () => {
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
  if (pool) await pool.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${mainDb}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

const seed = (env: Record<string, string> = {}) => runScript("scripts/demo-seed.ts", [], "public", { NODE_ENV: "development", DATABASE_URL: urlFor(mainDb), NOMA_MEDIA_DIR: mediaDir, ...env });

async function snapshot() {
  const read = async (sql: string) => (await pool.query<{ n: string }>(sql)).rows[0].n;
  return {
    users: await read("SELECT count(*)::text AS n FROM users"),
    identities: await read("SELECT count(*)::text AS n FROM phone_identities"),
    offers: await read("SELECT count(*)::text AS n FROM offers"),
    published: await read("SELECT count(*)::text AS n FROM offers WHERE status = 'published'"),
    demands: await read("SELECT count(*)::text AS n FROM demands WHERE status = 'active'"),
    evaluations: await read("SELECT count(*)::text AS n FROM matching_evaluations"),
    notifications: await read("SELECT count(*)::text AS n FROM notifications"),
    views: await read("SELECT coalesce(sum(views), 0)::text AS n FROM offer_views"),
    contacts: await read("SELECT coalesce(sum(reveals), 0)::text AS n FROM offer_contacts"),
    boosts: await read("SELECT count(*)::text AS n FROM offer_boosts"),
    walletTransactions: await read("SELECT count(*)::text AS n FROM wallet_transactions"),
    subscriptions: await read("SELECT count(*)::text AS n FROM subscriptions"),
    subscriptionPeriods: await read("SELECT count(*)::text AS n FROM subscription_periods"),
    promoGrants: await read("SELECT count(*)::text AS n FROM promo_grants"),
    outbox: await read("SELECT count(*)::text AS n FROM matching_outbox_events"),
    // Lot D2.
    conversations: await read("SELECT count(*)::text AS n FROM conversations"),
    messages: await read("SELECT count(*)::text AS n FROM messages"),
    favorites: await read("SELECT count(*)::text AS n FROM favorites"),
    orders: await read("SELECT count(*)::text AS n FROM orders"),
    admins: await read("SELECT count(*)::text AS n FROM users WHERE is_admin"),
    adminActions: await read("SELECT count(*)::text AS n FROM admin_actions"),
    messageNotifications: await read("SELECT count(*)::text AS n FROM notifications WHERE kind = 'new_message'"),
    // Lot PH1.
    photos: await read("SELECT count(*)::text AS n FROM offer_photos"),
    photoFiles: String((await readdir(mediaDir)).length),
  };
}

const userOf = async (phone: string): Promise<string> => (await pool.query<{ user_id: string }>("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [phone])).rows[0].user_id;

test("premier passage : comptes aux numéros fixes, 30 annonces publiées, besoins actifs, boost, crédits, ouvertures et contacts, notifications", async () => {
  const result = await seed();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, new RegExp(`base « ${mainDb} » : 30 annonce\\(s\\) publiée\\(s\\) \\(0 déjà présente\\(s\\)\\), 14 besoin\\(s\\) activé\\(s\\)`));
  assert.match(result.output, /Acheteur démo : \+225 07 00 00 01 01/);
  assert.match(result.output, /Vendeur démo {2}: \+225 07 00 00 02 02/);
  assert.match(result.output, /Admin démo {4}: \+225 07 00 00 03 03/);

  const snap = await snapshot();
  assert.equal(snap.users, String(3 + 7 + DEMO_EXTRA_BUYER_COUNT));
  assert.equal(snap.identities, snap.users);
  assert.equal(snap.offers, "30");
  assert.equal(snap.published, "30");
  assert.equal(snap.demands, String(3 + DEMO_EXTRA_BUYER_COUNT));
  assert.equal(snap.views, String(DEMO_OPENERS));
  assert.equal(snap.contacts, String(DEMO_CONTACTERS));
  assert.equal(snap.boosts, "1");
  // Le crédit de démonstration, le crédit du prix de l'abonnement Pro et le débit de l'abonnement (lot PRO1) : trois transactions, jamais plus.
  assert.equal(snap.walletTransactions, "3");
  assert.equal(snap.subscriptions, "1");
  assert.equal(snap.subscriptionPeriods, "1");
  assert.equal(snap.promoGrants, "1");
  // Aucune écriture directe d'une correspondance ou d'une notification : tout vient du worker, par l'outbox du catalogue.
  assert.ok(Number(snap.outbox) >= 30 + 14, `outbox : ${snap.outbox}`);
  assert.ok(Number(snap.evaluations) > 30);

  // Comptes de démonstration : numéros fixes, identité vérifiée, compte actif.
  for (const phone of [DEMO_BUYER_PHONE, DEMO_VENDOR_PHONE, DEMO_ADMIN_PHONE]) {
    const identity = (await pool.query<{ verified_at: Date | null; status: string }>(
      "SELECT i.verified_at, u.status FROM phone_identities i JOIN users u ON u.id = i.user_id WHERE i.phone_e164 = $1", [phone])).rows[0];
    assert.notEqual(identity.verified_at, null, phone);
    assert.equal(identity.status, "active");
  }

  // Les 30 annonces portent leur repère, ont un prix en francs CFA et sont disponibles.
  for (const offer of DEMO_OFFERS) {
    const row = (await pool.query<{ status: string; price_amount: string; price_currency: string; availability_status: string }>(
      "SELECT status, price_amount::text, price_currency, availability_status FROM offers WHERE position($1::text in raw_text) > 0", [demoMarker(offer.key)])).rows;
    assert.equal(row.length, 1, offer.key);
    assert.deepEqual(row[0], { status: "published", price_amount: String(offer.priceXof), price_currency: "XOF", availability_status: "available" });
  }
});

test("lot PH1 : une photo synthétique (PNG) par annonce, en première place, fichier nommé d'un UUID dans le dossier jetable, métadonnées absentes, affichée en couverture du tableau de bord du vendeur", async () => {
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM offer_photos")).rows[0].n, 30);
  const perOffer = await pool.query<{ offer_id: string; n: number; position: number; mime: string; width: number; height: number }>(
    "SELECT offer_id, count(*)::int AS n, min(position) AS position, min(mime) AS mime, min(width) AS width, min(height) AS height FROM offer_photos GROUP BY offer_id");
  assert.equal(perOffer.rows.length, 30, "une annonce = une ligne");
  assert.ok(perOffer.rows.every((row) => row.n === 1 && row.position === 0 && row.mime === "image/png" && row.width === 480 && row.height === 360));
  const names = await readdir(mediaDir);
  assert.equal(names.length, 30);
  assert.ok(names.every((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)), "aucun fichier hors UUID, aucun fichier temporaire");
  const ids = new Set((await pool.query<{ id: string }>("SELECT id FROM offer_photos")).rows.map((row) => row.id));
  assert.deepEqual(new Set(names), ids, "autant de fichiers que de lignes, les mêmes");
  const home = await readVendorHome({ pool, userId: await userOf(DEMO_VENDOR_PHONE) });
  assert.ok(home.offers.length > 0 && home.offers.every((offer) => offer.coverPhotoId !== undefined && ids.has(offer.coverPhotoId)), "chaque annonce du vendeur démo a sa couverture");
});

test("lot D2 : le compte Admin démo est administrateur (journalisé), une conversation de 3 messages avec un vendeur fictif, un favori, une commande proposée au vendeur démo par un acheteur fictif", async () => {
  const adminId = await userOf(DEMO_ADMIN_PHONE);
  assert.deepEqual((await pool.query("SELECT id FROM users WHERE is_admin")).rows, [{ id: adminId }], "seul le compte Admin démo est administrateur");
  assert.deepEqual((await pool.query("SELECT admin_id, source, action, target_user_id FROM admin_actions")).rows, [{ admin_id: null, source: "command", action: "grant_admin", target_user_id: adminId }]);

  const buyerId = await userOf(DEMO_BUYER_PHONE);
  const vendorId = await userOf(DEMO_VENDOR_PHONE);
  const conversation = (await pool.query<{ id: string; seller_id: string }>("SELECT id, seller_id FROM conversations WHERE buyer_id = $1", [buyerId])).rows;
  assert.equal(conversation.length, 1);
  assert.notEqual(conversation[0].seller_id, vendorId, "le vendeur de la conversation est un vendeur FICTIF");
  const fictional = (await pool.query<{ phone_e164: string }>("SELECT phone_e164 FROM phone_identities WHERE user_id = $1", [conversation[0].seller_id])).rows[0].phone_e164;
  assert.match(fictional, /^\+22507888888\d\d$/);
  const thread = (await pool.query<{ sender_id: string; body: string }>("SELECT sender_id, body FROM messages WHERE conversation_id = $1 ORDER BY id", [conversation[0].id])).rows;
  assert.deepEqual(thread.map((message) => message.sender_id === buyerId ? "acheteur" : "vendeur"), ["acheteur", "vendeur", "acheteur"]);
  assert.ok(thread.every((message) => !/\d{4}/.test(message.body)), "aucun numéro dans les messages de démonstration");
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE kind = 'new_message'")).rowCount, 0, "l'historique de démonstration ne notifie personne : l'acheteur démo garde ses 3 notifications");
  assert.equal(await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.sender_id <> $1 AND m.id > c.buyer_last_read_id", [buyerId]).then((r) => r.rows[0].n), 0, "aucun message non lu côté acheteur");

  assert.equal((await pool.query("SELECT 1 FROM favorites WHERE user_id = $1", [buyerId])).rowCount, 1);
  const orders = (await pool.query<{ status: string; seller_id: string; buyer_id: string; price_amount: string }>("SELECT status, seller_id, buyer_id, price_amount::text FROM orders")).rows;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "proposed");
  assert.equal(orders[0].seller_id, vendorId, "à confirmer par le vendeur démo");
  assert.notEqual(orders[0].buyer_id, buyerId, "venant d'un acheteur fictif");
  assert.equal(orders[0].price_amount, "160000");
});

test("acheteur démo : 3 besoins actifs qui ont des correspondances, 3 notifications non lues (annonces publiées APRÈS ses besoins)", async () => {
  const home = await readBuyerHome({ pool, userId: await userOf(DEMO_BUYER_PHONE) });
  assert.equal(home.activeDemandCount, 3);
  assert.equal(home.demands.length, 3);
  for (const demand of home.demands) assert.ok(demand.matchCount >= 4, `${demand.title} : ${demand.matchCount} correspondance(s)`);
  const iphone = home.demands.find((demand) => demand.model === "iPhone 12");
  assert.equal(iphone?.matchCount, 9, "huit annonces avant le besoin, une après : neuf correspondances (assez pour qu'un boost fasse monter l'annonce)");
  assert.equal(home.demands.find((demand) => demand.model === "Galaxy S21")?.matchCount, 8, "sept annonces avant le besoin, une après : le vendeur démo peut acheter un boost du Galaxy S21");
  assert.deepEqual(home.demands.map((demand) => demand.model), ["iPhone 12", "MacBook Air M1", "Galaxy S21"], "le besoin de la démonstration (iPhone 12) s'affiche en premier");
  assert.equal(home.unreadNotifications, 3);
  assert.equal(home.notifications.length, 3);
  assert.ok(home.notifications.every((item) => item.kind === "new_match" && item.unread && item.price !== null));
});

test("vendeur démo : 4 annonces en ligne dont une boostée, solde de crédits, statistiques « environ 10 » ouvreurs et « environ 5 » contacts", async () => {
  const vendorId = await userOf(DEMO_VENDOR_PHONE);
  const home = await readVendorHome({ pool, userId: vendorId });
  assert.deepEqual(home.counts, { published: 4, paused: 0, draft: 0 });
  assert.equal(home.balance, DEMO_VENDOR_CREDIT_XOF);
  assert.equal(await readWalletBalance(pool, vendorId), BigInt(DEMO_VENDOR_CREDIT_XOF));
  assert.equal(home.activeBoosts.length, 1);
  const boosted = home.offers.find((offer) => offer.boostEndsAt !== null);
  assert.equal(boosted?.model, "iPhone 12");
  assert.deepEqual(boosted?.needs, { kind: "approx", value: 10 }, "12 besoins correspondent à l'annonce boostée");

  const stats = await readOfferStats({ pool, ownerId: vendorId, offerId: boosted?.id as string });
  assert.deepEqual(stats.activeMatches.needs, { kind: "approx", value: 10 });
  const all = stats.periods.find((period) => period.period === "all");
  assert.deepEqual(all?.opens.uniqueBuyers, { kind: "approx", value: 10 }, "11 acheteurs ont ouvert la fiche : « environ 10 »");
  assert.deepEqual(all?.contacts.uniqueBuyers, { kind: "approx", value: 5 }, "6 acheteurs ont contacté : « environ 5 »");
  const values = [...JSON.stringify(stats).matchAll(/"value":(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(values.length > 0 && values.every((value) => value % 5 === 0), `tous les comptes publiés sont arrondis à 5 : ${values.join(", ")}`);
});

test("vendeur démo : abonné à l'offre Pro par la VRAIE souscription (droits Pro, badge, 5 000 FCFA de crédits promotionnels, solde de crédits intact) ; le badge apparaît dans les résultats de l'acheteur démo", async () => {
  const vendorId = await userOf(DEMO_VENDOR_PHONE);
  const entitlements = await readUserEntitlements(pool, vendorId);
  assert.equal(entitlements.source, "subscription");
  assert.equal(entitlements.planCode, "pro");
  assert.ok(entitlements.entitlements.includes("badge_pro") && entitlements.entitlements.includes("catalog_import"));
  assert.equal((await readPromoSummary(pool, vendorId)).balance, BigInt(5_000), "crédits promotionnels émis par l'abonnement");
  assert.equal(await readWalletBalance(pool, vendorId), BigInt(DEMO_VENDOR_CREDIT_XOF), "le crédit de démonstration est intact : le prix de l'abonnement a été crédité en plus");
  assert.equal((await pool.query("SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active'", [vendorId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM subscription_periods WHERE user_id = $1 AND price_xof = 10000 AND promo_credits_xof = 5000", [vendorId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM wallet_transactions WHERE kind = 'subscription_charge'")).rowCount, 1, "une seule souscription");
  // Aucun autre compte de démonstration n'est abonné ; les vendeurs fictifs n'ont pas le badge.
  const other = await userOf("+22507888888" + "01");
  const badges = await readProBadges(pool, [vendorId, other]);
  assert.equal(badges.get(vendorId), true);
  assert.equal(badges.get(other), false);
  // Résultats de l'acheteur démo : l'annonce du vendeur démo porte `proBadge`, celles des vendeurs fictifs non.
  const demand = (await pool.query<{ id: string }>("SELECT id FROM demands WHERE owner_id = $1 AND raw_text LIKE '%buyer-iphone12%'", [await userOf(DEMO_BUYER_PHONE)])).rows[0];
  const page = await listStoredOfferMatchesForDemand(await userOf(DEMO_BUYER_PHONE), demand.id, { limit: 50 }, pool);
  const mine = page.items.filter((item) => item.candidate.ownerId === vendorId);
  const others = page.items.filter((item) => item.candidate.ownerId !== vendorId);
  assert.ok(mine.length >= 1 && others.length >= 5);
  assert.ok(mine.every((item) => item.proBadge === true), "badge sur l'annonce du vendeur Pro");
  assert.ok(others.every((item) => item.proBadge === false), "aucun badge sur les autres");
  assert.deepEqual((await checkWalletIntegrity(pool)).violations, [], "wallet:check vert");
});

test("rejeu à l'identique : aucun doublon, aucune ouverture ni aucun contact de plus, un seul crédit, un seul boost", async () => {
  const before = await snapshot();
  const result = await seed();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /0 annonce\(s\) publiée\(s\) \(30 déjà présente\(s\)\), 0 besoin\(s\) activé\(s\) \(14 déjà présent\(s\)\), 0 compte\(s\) créé\(s\) \(21 déjà présent\(s\)\)/);
  assert.match(result.output, /0 ouverture\(s\) et 0 contact\(s\) fictifs écrits, crédits déjà présents, boost déjà actif/);
  assert.match(result.output, /0 message\(s\) écrit\(s\), favori déjà présent, commande de démonstration déjà active, rôle admin déjà attribué/);
  assert.match(result.output, /offre Pro : vendeur démo déjà abonné/);
  assert.match(result.output, /photos : 0 photo\(s\) synthétique\(s\) ajoutée\(s\) \(30 déjà présente\(s\)\), une par annonce/);
  assert.deepEqual(await snapshot(), before, "l'état de la base est identique au premier passage");
});

test("un boost échu est renouvelé au rejeu (jamais un second boost actif)", async () => {
  await pool.query("UPDATE offer_boosts SET status = 'expired', starts_at = clock_timestamp() - interval '9 days', ends_at = clock_timestamp() - interval '2 days'");
  const result = await seed();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /boost attribué/);
  const active = await pool.query("SELECT 1 FROM offer_boosts WHERE status = 'active' AND ends_at > clock_timestamp()");
  assert.equal(active.rowCount, 1);
});

test("refus sans écriture : noma_dev, noma_test, NODE_ENV=production (la base jetable n'est pas touchée)", async () => {
  const before = await snapshot();
  const refusals: Array<Record<string, string>> = [
    { DATABASE_URL: urlFor("noma_dev") },
    { DATABASE_URL: urlFor("noma_test") },
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
  ];
  for (const env of refusals) {
    const refused = await seed(env);
    assert.equal(refused.code, 1, JSON.stringify(env));
    assert.match(refused.output, /demo:seed : refus/);
  }
  assert.deepEqual(await snapshot(), before);
});
