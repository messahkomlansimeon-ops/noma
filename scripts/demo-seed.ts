import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { activateDemand, createDemand, createOffer, createUser, getUserById, publishOffer } from "../lib/server/catalog";
import { grantAdmin } from "../lib/server/admin/grant";
import { BOOST_ERROR_MESSAGES, BoostError, grantOfferBoost } from "../lib/server/boost/boosts";
import { runMatchingCycle } from "../lib/server/matching/runner";
import { isMatchingSchemaReady } from "../lib/server/matching/schema-ready";
import { createMediaStore } from "../lib/server/media/store";
import { revealOfferContact } from "../lib/server/metrics/contacts";
import { recordOfferView } from "../lib/server/metrics/views";
import { closePostgresPool, getPostgresPool } from "../lib/server/postgres/client";
import { openConversation, sendMessage } from "../lib/server/social/conversations";
import { SocialError } from "../lib/server/social/errors";
import { addFavorite } from "../lib/server/social/favorites";
import { declareOrder } from "../lib/server/social/orders";
import { readUserEntitlements } from "../lib/server/subscriptions/entitlements";
import { subscribeToPlan } from "../lib/server/subscriptions/lifecycle";
import { recordWalletTransaction } from "../lib/server/wallet/ledger";
import {
  DEMO_ADMIN_PHONE,
  DEMO_BOOST_DURATION,
  DEMO_BUYER_DEMANDS,
  DEMO_BUYER_PHONE,
  DEMO_CONTACTERS,
  DEMO_CONVERSATION_DEMAND_KEY,
  DEMO_CONVERSATION_MESSAGES,
  DEMO_CONVERSATION_OFFER_KEY,
  DEMO_EXTRA_BUYER_COUNT,
  DEMO_FAVORITE_OFFER_KEY,
  DEMO_OFFERS,
  DEMO_OPENERS,
  DEMO_ORDER_BUYER_INDEX,
  DEMO_ORDER_OFFER_KEY,
  DEMO_ORDER_PRICE_XOF,
  DEMO_SEED_LOCK_NAMESPACE,
  DEMO_PRO_PLAN_CODE,
  DEMO_SEED_USAGE,
  DEMO_VENDOR_CREDIT_REFERENCE,
  DEMO_VENDOR_CREDIT_XOF,
  DEMO_VENDOR_PHONE,
  DEMO_VENDOR_PRO_CREDIT_PREFIX,
  checkDemoSeedEnvironment,
  demoProSubscriptionKey,
  demandRawText,
  demoAccountId,
  demoExtraBuyerPhone,
  demoMarker,
  extraBuyerDemand,
  offerRawText,
  vendorPhoneOf,
  type DemoDemand,
  type DemoOffer,
} from "./demo-seed-plan";
import { seedDemoPhotos } from "./demo-seed-photos";

/**
 * `npm run demo:seed` (lot D1) : peuple une base d'ESSAI (`noma_essai`) d'un marché de démonstration réaliste, REJOUABLE, pour présenter noma à des investisseurs :
 * 8 vendeurs (dont le vendeur démo), 30 annonces publiées dans 4 catégories, trois comptes de démonstration aux numéros fixes (acheteur +225 07 00 00 01 01,
 * vendeur +225 07 00 00 02 02, admin +225 07 00 00 03 03, ce dernier administrateur), 3 besoins actifs avec correspondances pour l'acheteur démo, 4 annonces dont une boostée, un solde de crédits,
 * des ouvertures et des contacts d'acheteurs fictifs pour le vendeur démo, et quelques notifications pour l'acheteur démo (annonces publiées APRÈS ses besoins).
 *
 * Tout passe par les VRAIS services (catalogue, publication, activation d'un besoin, attribution d'un boost, journal des ouvertures et des contacts, grand livre) ; le worker du
 * matching est lancé par la commande elle-même jusqu'au repos (aucun envoi externe : `notificationTransport: null`). Aucune requête n'écrit directement une
 * correspondance ou une notification. Rejouable : un compte, une annonce, un besoin, un crédit, une ouverture ou un contact déjà présent n'est jamais recréé ; un boost échu est
 * renouvelé. Refus clair, RIEN d'écrit, si `NODE_ENV` est défini autre que « development », `DATABASE_URL` est absente ou ne désigne pas une base de ce poste, ou si la
 * base n'est pas `noma_essai`, `noma_e2e` ou `noma_essai_*` (garde-fous de `dev:seed`, voir demo-seed-plan.ts). Voir DEMO.md.
 */

export interface DemoSeedReport {
  accountsCreated: number;
  accountsExisting: number;
  offersCreated: number;
  offersExisting: number;
  demandsCreated: number;
  demandsExisting: number;
  viewsRecorded: number;
  contactsRecorded: number;
  creditAdded: boolean;
  /** Lot PRO1 : le vendeur démo a été abonné à l'offre Pro ce coup-ci (faux : déjà abonné). */
  proSubscribed: boolean;
  boost: "granted" | "existing" | "refused";
  /** Lot D2 : rôle d'administrateur attribué ce coup-ci, messages écrits, favori et commande de démonstration créés ce coup-ci. */
  adminGranted: boolean;
  messagesWritten: number;
  favoriteAdded: boolean;
  orderDeclared: boolean;
  /** Lot PH1 : photos synthétiques ajoutées ce coup-ci (une par annonce) et déjà présentes. */
  photosAdded: number;
  photosExisting: number;
  /** Cycles du worker du matching exécutés (jusqu'au repos). */
  cycles: number;
}

interface Counters {
  report: DemoSeedReport;
}

const WORKER_ID = "demo-seed";
const WORKER_MAX_CYCLES = 400;
const WORKER_TIMEOUT_MS = 180_000;

/** Compte de démonstration : retrouvé par son numéro, sinon créé (compte actif + identité téléphonique vérifiée, identifiant stable). */
async function ensureAccount(pool: Pool, phone: string): Promise<{ userId: string; created: boolean }> {
  const identity = await pool.query<{ user_id: string }>("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [phone]);
  if (identity.rows[0]) return { userId: identity.rows[0].user_id, created: false };
  const userId = demoAccountId(phone);
  const user = (await getUserById(userId, pool)) ?? (await createUser({ id: userId }, pool));
  await pool.query(
    "INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2::uuid, clock_timestamp()) ON CONFLICT DO NOTHING",
    [phone, user.id],
  );
  return { userId: user.id, created: true };
}

async function ensureOffer(pool: Pool, ownerId: string, offer: DemoOffer): Promise<{ id: string; created: boolean }> {
  const found = await pool.query<{ id: string; status: string; content_version: number }>(
    "SELECT id, status, content_version FROM offers WHERE owner_id = $1::uuid AND position($2::text in raw_text) > 0 AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1",
    [ownerId, demoMarker(offer.key)],
  );
  const existing = found.rows[0];
  if (existing) {
    // Reprise d'une exécution interrompue entre la création et la publication.
    if (existing.status === "draft") await publishOffer(ownerId, existing.id, existing.content_version, pool);
    return { id: existing.id, created: false };
  }
  const created = await createOffer(
    {
      ownerId,
      rawText: offerRawText(offer),
      category: offer.category,
      brand: offer.brand,
      model: offer.model,
      variant: offer.variant,
      condition: offer.condition,
      location: offer.location,
      attributes: offer.attributes as never,
      price: { amount: offer.priceXof, currency: "XOF" },
      availabilityStatus: "available",
      availabilityConfirmedAt: new Date(),
      status: "draft",
    },
    pool,
  );
  await publishOffer(ownerId, created.id, created.contentVersion, pool);
  return { id: created.id, created: true };
}

async function ensureDemand(pool: Pool, ownerId: string, demand: DemoDemand): Promise<{ id: string; created: boolean }> {
  const found = await pool.query<{ id: string; status: string; content_version: number }>(
    "SELECT id, status, content_version FROM demands WHERE owner_id = $1::uuid AND position($2::text in raw_text) > 0 AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1",
    [ownerId, demoMarker(demand.key)],
  );
  const existing = found.rows[0];
  if (existing) {
    if (existing.status === "draft") await activateDemand(ownerId, existing.id, existing.content_version, pool);
    return { id: existing.id, created: false };
  }
  const created = await createDemand(
    {
      ownerId,
      rawText: demandRawText(demand),
      category: demand.category,
      brand: demand.brand,
      model: demand.model,
      location: demand.location,
      budget: { amount: demand.budgetXof, currency: "XOF" },
      status: "draft",
    },
    pool,
  );
  await activateDemand(ownerId, created.id, created.contentVersion, pool);
  return { id: created.id, created: true };
}

/** Lance le worker du matching jusqu'au repos : DEUX cycles consécutifs sans travail (une évaluation en crée parfois une autre), borné en cycles et en durée. */
export async function runMatchingUntilIdle(pool: Pool, counters: Counters): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  let idleInARow = 0;
  for (let cycle = 0; cycle < WORKER_MAX_CYCLES && idleInARow < 2; cycle += 1) {
    if (Date.now() > deadline) throw new Error("le worker du matching n'a pas atteint le repos à temps");
    const result = await runMatchingCycle({ pool, workerId: WORKER_ID, notificationTransport: null });
    counters.report.cycles += 1;
    for (const code of result.errors) console.error(`demo:seed : étape du worker en échec (${code}).`);
    idleInARow = result.idle ? idleInARow + 1 : 0;
  }
}

async function ensureVendorCredit(pool: Pool, vendorId: string): Promise<boolean> {
  const existing = await pool.query("SELECT 1 FROM wallet_transactions WHERE reference = $1", [DEMO_VENDOR_CREDIT_REFERENCE]);
  if (existing.rowCount) return false;
  await recordWalletTransaction(pool, {
    kind: "adjustment",
    reference: DEMO_VENDOR_CREDIT_REFERENCE,
    metadata: { reasonCode: "demo_seed" },
    entries: [
      { account: { kind: "boost_revenue" }, amount: -BigInt(DEMO_VENDOR_CREDIT_XOF) },
      { account: { kind: "user", ownerId: vendorId }, amount: BigInt(DEMO_VENDOR_CREDIT_XOF) },
    ],
  });
  return true;
}

/**
 * Lot PRO1 : abonne le vendeur démo à l'offre Pro par le VRAI service (`subscribeToPlan` : débit des crédits, revenus d'abonnement, crédits promotionnels, période d'un mois). Rejouable :
 * un vendeur déjà abonné (droits Pro en vigueur) n'est jamais abonné deux fois ; sinon, le crédit du prix du plan est ajouté (une fois par abonnement) pour que son solde de crédits de
 * démonstration reste intact, puis l'abonnement est souscrit avec une clé d'idempotence propre à cet abonnement (une reprise après interruption ne débite jamais deux fois).
 */
async function ensureVendorPro(pool: Pool, vendorId: string): Promise<boolean> {
  if ((await readUserEntitlements(pool, vendorId)).source === "subscription") return false;
  const price = await pool.query<{ price: string }>(
    "SELECT v.monthly_price_xof::text AS price FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = $1 ORDER BY v.version DESC LIMIT 1",
    [DEMO_PRO_PLAN_CODE],
  );
  if (!price.rows[0]) throw new Error("le plan Pro n'existe pas : la base d'essai n'est pas migrée jusqu'au bout");
  const sequence = (await pool.query<{ n: number }>("SELECT count(*)::int + 1 AS n FROM subscriptions WHERE user_id = $1::uuid", [vendorId])).rows[0].n;
  const reference = `${DEMO_VENDOR_PRO_CREDIT_PREFIX}${sequence}`;
  const credited = await pool.query("SELECT 1 FROM wallet_transactions WHERE reference = $1", [reference]);
  if (!credited.rowCount) {
    await recordWalletTransaction(pool, {
      kind: "adjustment",
      reference,
      metadata: { reasonCode: "demo_seed" },
      entries: [
        { account: { kind: "boost_revenue" }, amount: -BigInt(price.rows[0].price) },
        { account: { kind: "user", ownerId: vendorId }, amount: BigInt(price.rows[0].price) },
      ],
    });
  }
  await subscribeToPlan({ pool, userId: vendorId, planCode: DEMO_PRO_PLAN_CODE, idempotencyKey: demoProSubscriptionKey(vendorId, sequence) });
  return true;
}

async function ensureBoost(pool: Pool, offerId: string, ownerId: string): Promise<"granted" | "existing" | "refused"> {
  const active = await pool.query("SELECT 1 FROM offer_boosts WHERE offer_id = $1::uuid AND status = 'active' AND ends_at > clock_timestamp()", [offerId]);
  if (active.rowCount) return "existing";
  try {
    await grantOfferBoost({ pool, offerId, ownerId, durationCode: DEMO_BOOST_DURATION, source: "admin_grant" });
    return "granted";
  } catch (error) {
    if (error instanceof BoostError) {
      console.error(`demo:seed : boost non attribué (${error.code} : ${BOOST_ERROR_MESSAGES[error.code]}).`);
      return "refused";
    }
    throw error;
  }
}

/**
 * Peuple la base d'essai, UN `demo:seed` À LA FOIS (verrou consultatif de session sur une connexion dédiée du pool, comme `dev:seed`). Le pool doit offrir au moins deux
 * connexions.
 */
export async function seedDemoMarket(pool: Pool): Promise<DemoSeedReport> {
  const lock = await pool.connect();
  let reusable = true;
  try {
    await lock.query("SET lock_timeout = '60s'");
    await lock.query("SELECT pg_advisory_lock($1::int, 1)", [DEMO_SEED_LOCK_NAMESPACE]);
    return await seedUnderLock(pool);
  } finally {
    try {
      await lock.query("SELECT pg_advisory_unlock($1::int, 1)", [DEMO_SEED_LOCK_NAMESPACE]);
      await lock.query("RESET lock_timeout");
    } catch {
      reusable = false;
    }
    lock.release(!reusable);
  }
}

async function seedUnderLock(pool: Pool): Promise<DemoSeedReport> {
  const counters: Counters = {
    report: {
      accountsCreated: 0, accountsExisting: 0, offersCreated: 0, offersExisting: 0, demandsCreated: 0, demandsExisting: 0,
      viewsRecorded: 0, contactsRecorded: 0, creditAdded: false, proSubscribed: false, boost: "existing", adminGranted: false, messagesWritten: 0, favoriteAdded: false, orderDeclared: false, photosAdded: 0, photosExisting: 0, cycles: 0,
    },
  };
  const { report } = counters;
  const account = async (phone: string): Promise<string> => {
    const ensured = await ensureAccount(pool, phone);
    if (ensured.created) report.accountsCreated += 1;
    else report.accountsExisting += 1;
    return ensured.userId;
  };

  // 1. Comptes : les trois comptes de démonstration, 7 vendeurs fictifs, 12 acheteurs fictifs.
  const buyerId = await account(DEMO_BUYER_PHONE);
  const vendorId = await account(DEMO_VENDOR_PHONE);
  await account(DEMO_ADMIN_PHONE);
  // Lot D2 : le rôle d'administrateur du compte Admin démo, par le MÊME chemin que la commande `admin:grant` (journalisé, idempotent).
  report.adminGranted = (await grantAdmin({ pool, phone: DEMO_ADMIN_PHONE })).granted;
  const sellerIds = new Map<number, string>([[0, vendorId]]);
  for (let index = 1; index <= 7; index += 1) sellerIds.set(index, await account(vendorPhoneOf(index as 1)));
  const extraBuyerIds: string[] = [];
  for (let index = 1; index <= DEMO_EXTRA_BUYER_COUNT; index += 1) extraBuyerIds.push(await account(demoExtraBuyerPhone(index)));

  // 2. Annonces publiées AVANT les besoins.
  const offerIds = new Map<string, string>();
  const publishOffers = async (list: readonly DemoOffer[]): Promise<void> => {
    for (const offer of list) {
      const ensured = await ensureOffer(pool, sellerIds.get(offer.vendor) as string, offer);
      offerIds.set(offer.key, ensured.id);
      if (ensured.created) report.offersCreated += 1;
      else report.offersExisting += 1;
    }
  };
  await publishOffers(DEMO_OFFERS.filter((offer) => offer.afterDemands !== true));

  // 3. Besoins actifs : 3 pour l'acheteur démo, 1 par acheteur fictif.
  const demandIds = new Map<string, string>();
  const publishDemands = async (ownerId: string, demands: readonly DemoDemand[]): Promise<void> => {
    for (const demand of demands) {
      const ensured = await ensureDemand(pool, ownerId, demand);
      demandIds.set(demand.key, ensured.id);
      if (ensured.created) report.demandsCreated += 1;
      else report.demandsExisting += 1;
    }
  };
  await publishDemands(buyerId, DEMO_BUYER_DEMANDS);
  for (let index = 1; index <= DEMO_EXTRA_BUYER_COUNT; index += 1) await publishDemands(extraBuyerIds[index - 1], [extraBuyerDemand(index)]);
  await runMatchingUntilIdle(pool, counters);

  // 4. Annonces publiées APRÈS les besoins : le worker les évalue côté annonce et écrit les notifications de l'acheteur démo.
  await publishOffers(DEMO_OFFERS.filter((offer) => offer.afterDemands === true));
  await runMatchingUntilIdle(pool, counters);

  // Lot PH1 : une photo synthétique par annonce (vrai service d'envoi ; rejouable sans doublon ; n'influence ni le matching ni les notifications).
  const photos = await seedDemoPhotos({
    pool,
    store: createMediaStore(process.env),
    offers: DEMO_OFFERS.map((offer) => ({ offer, offerId: offerIds.get(offer.key) as string, ownerId: sellerIds.get(offer.vendor) as string })),
  });
  report.photosAdded = photos.added;
  report.photosExisting = photos.existing;

  // 5. Le vendeur démo : crédits, boost de son iPhone 12, ouvertures et contacts d'acheteurs fictifs.
  report.creditAdded = await ensureVendorCredit(pool, vendorId);
  // Lot PRO1 : le vendeur démo est abonné à l'offre Pro (crédit d'abonnement en plus, puis vraie souscription).
  report.proSubscribed = await ensureVendorPro(pool, vendorId);
  const boostedOffer = DEMO_OFFERS.find((offer) => offer.boosted === true) as DemoOffer;
  const boostedOfferId = offerIds.get(boostedOffer.key) as string;
  report.boost = await ensureBoost(pool, boostedOfferId, vendorId);
  for (let index = 1; index <= DEMO_EXTRA_BUYER_COUNT; index += 1) {
    const viewerId = extraBuyerIds[index - 1];
    const demandId = demandIds.get(extraBuyerDemand(index).key) as string;
    if (index <= DEMO_OPENERS) {
      const seen = await pool.query("SELECT 1 FROM offer_views WHERE offer_id = $1::uuid AND demand_id = $2::uuid", [boostedOfferId, demandId]);
      if (!seen.rowCount && (await recordOfferView(pool, { offerId: boostedOfferId, demandId, viewerId }))) report.viewsRecorded += 1;
    }
    if (index <= DEMO_CONTACTERS) {
      const contacted = await pool.query("SELECT 1 FROM offer_contacts WHERE offer_id = $1::uuid AND demand_id = $2::uuid", [boostedOfferId, demandId]);
      if (!contacted.rowCount) {
        await revealOfferContact({ pool, viewerId, demandId, offerId: boostedOfferId });
        report.contactsRecorded += 1;
      }
    }
  }
  await runMatchingUntilIdle(pool, counters);

  // 6. Lot D2 : conversation, favori et commande de démonstration (vrais services : mêmes contrôles d'accès que l'application ; rejouable sans doublon).
  await seedSocial(pool, report, { offerIds, demandIds, buyerId, sellerIds, extraBuyerIds });
  return report;
}

async function seedSocial(
  pool: Pool,
  report: DemoSeedReport,
  world: { offerIds: Map<string, string>; demandIds: Map<string, string>; buyerId: string; sellerIds: Map<number, string>; extraBuyerIds: string[] },
): Promise<void> {
  const offer = (key: string): string => world.offerIds.get(key) as string;
  // Une conversation entre l'acheteur démo et un vendeur fictif, 3 messages : écrits une seule fois (une conversation qui a déjà des messages n'est jamais complétée).
  const conversationOffer = DEMO_OFFERS.find((entry) => entry.key === DEMO_CONVERSATION_OFFER_KEY) as DemoOffer;
  const sellerId = world.sellerIds.get(conversationOffer.vendor) as string;
  const opened = await openConversation({ pool, viewerId: world.buyerId, demandId: world.demandIds.get(DEMO_CONVERSATION_DEMAND_KEY) as string, offerId: offer(DEMO_CONVERSATION_OFFER_KEY) });
  const written = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1::uuid", [opened.conversationId]);
  if (written.rows[0].n === 0) {
    for (const message of DEMO_CONVERSATION_MESSAGES) {
      // Historique de démonstration : sans notification (l'acheteur démo garde exactement ses 3 notifications de nouvelles annonces ; les nouveaux messages de la démonstration en direct notifient).
      await sendMessage({ pool, senderId: message.from === "buyer" ? world.buyerId : sellerId, conversationId: opened.conversationId, body: message.body, notify: false });
      report.messagesWritten += 1;
    }
  }
  // Un favori de l'acheteur démo.
  report.favoriteAdded = (await addFavorite({ pool, userId: world.buyerId, demandId: world.demandIds.get(DEMO_CONVERSATION_DEMAND_KEY) as string, offerId: offer(DEMO_FAVORITE_OFFER_KEY) })).created;
  // Une commande PROPOSÉE au vendeur démo par un acheteur fictif (à confirmer pendant la démonstration) ; une commande déjà active n'est pas dupliquée.
  const orderBuyerId = world.extraBuyerIds[DEMO_ORDER_BUYER_INDEX - 1];
  try {
    await declareOrder({
      pool,
      buyerId: orderBuyerId,
      demandId: world.demandIds.get(extraBuyerDemand(DEMO_ORDER_BUYER_INDEX).key) as string,
      offerId: offer(DEMO_ORDER_OFFER_KEY),
      price: DEMO_ORDER_PRICE_XOF,
    });
    report.orderDeclared = true;
  } catch (error) {
    if (!(error instanceof SocialError) || error.code !== "order_active_exists") throw error;
  }
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.error(`demo:seed : aucune option n'existe. ${DEMO_SEED_USAGE}`);
    return 1;
  }
  // Garde-fous AVANT toute connexion : en cas de refus, aucune requête n'est envoyée.
  const environment = checkDemoSeedEnvironment(process.env);
  if (!environment.ok) {
    console.error(`demo:seed : refus — ${environment.reason}`);
    return 1;
  }
  const pool = getPostgresPool();
  if (!(await isMatchingSchemaReady(pool))) {
    console.error("demo:seed : la base d'essai n'est pas migrée (lancez d'abord `npm run db:migrate` avec cette DATABASE_URL).");
    return 1;
  }
  const report = await seedDemoMarket(pool);
  console.log(
    `demo:seed : base « ${environment.databaseName} » : ${report.offersCreated} annonce(s) publiée(s) (${report.offersExisting} déjà présente(s)), ` +
      `${report.demandsCreated} besoin(s) activé(s) (${report.demandsExisting} déjà présent(s)), ${report.accountsCreated} compte(s) créé(s) (${report.accountsExisting} déjà présent(s)), ` +
      `${report.viewsRecorded} ouverture(s) et ${report.contactsRecorded} contact(s) fictifs écrits, crédits ${report.creditAdded ? "ajoutés" : "déjà présents"}, ` +
      `boost ${report.boost === "granted" ? "attribué" : report.boost === "existing" ? "déjà actif" : "NON attribué"}.`,
  );
  console.log(
    `demo:seed : messagerie, favoris, commandes et administration : ${report.messagesWritten} message(s) écrit(s), favori ${report.favoriteAdded ? "ajouté" : "déjà présent"}, ` +
      `commande de démonstration ${report.orderDeclared ? "proposée au vendeur démo" : "déjà active"}, rôle admin ${report.adminGranted ? "attribué au compte Admin démo" : "déjà attribué"}.`,
  );
  console.log(`demo:seed : offre Pro : vendeur démo ${report.proSubscribed ? "abonné (crédits promotionnels émis)" : "déjà abonné"}.`);
  console.log(`demo:seed : photos : ${report.photosAdded} photo(s) synthétique(s) ajoutée(s) (${report.photosExisting} déjà présente(s)), une par annonce.`);
  console.log("demo:seed : comptes de démonstration (le code de connexion s'affiche dans le terminal de `npm run dev:try`) :");
  console.log("  Acheteur démo : +225 07 00 00 01 01");
  console.log("  Vendeur démo  : +225 07 00 00 02 02");
  console.log("  Admin démo    : +225 07 00 00 03 03 (administrateur)");
  return report.boost === "refused" ? 1 : 0;
}

// Exécution directe seulement (les tests importent ce module sans rien lancer).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`demo:seed : ${error.message}`);
      else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`demo:seed : erreur ${code}.`);
      else console.error("demo:seed : erreur inattendue.");
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePostgresPool();
    });
}
