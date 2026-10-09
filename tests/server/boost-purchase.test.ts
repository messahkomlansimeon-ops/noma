import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOOST_DURATION_CODES, BOOST_PURCHASE_LOCK_NAMESPACE, BOOST_QUOTE_LOCK_NAMESPACE, BOOST_RECORD_SOURCES, BOOST_SCOPE_LOCK_NAMESPACE, BOOST_SOURCES,
} from "../../lib/server/boost/boost-config";
import { BOOST_ERROR_MESSAGES, BoostError, type BoostErrorCode } from "../../lib/server/boost/boosts";
import { BOOST_PURCHASE_CONTRACT_VERSION, BOOST_PURCHASE_HTTP_BODY_MAX_BYTES } from "../../lib/server/boost/purchase-http";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import { WALLET_TOPUP_LOCK_NAMESPACE } from "../../lib/server/wallet/config";
import { validateWalletTransactionInput, WALLET_TRANSACTION_KINDS } from "../../lib/server/wallet/ledger";

const root = (path: string): string => join(process.cwd(), path);
const source = (path: string): string => readFileSync(root(path), "utf8");
const big = (value: number): bigint => BigInt(value);

test("configuration de code : espaces de verrou tous distincts, sources d'un boost, contrat HTTP et plafond du corps", () => {
  const namespaces = [
    1_314_664_945, 1_314_664_946, 1_314_664_947, BOOST_SCOPE_LOCK_NAMESPACE, BOOST_QUOTE_LOCK_NAMESPACE, WALLET_TOPUP_LOCK_NAMESPACE, BOOST_PURCHASE_LOCK_NAMESPACE,
  ];
  assert.equal(new Set(namespaces).size, namespaces.length, "aucun espace de verrou consultatif n'est partagé");
  assert.equal(BOOST_PURCHASE_LOCK_NAMESPACE, 1_314_664_951);
  assert.deepEqual([...BOOST_SOURCES], ["admin_grant"], "l'attribution d'administration n'accepte toujours que admin_grant");
  assert.deepEqual([...BOOST_RECORD_SOURCES], ["admin_grant", "purchase"]);
  assert.deepEqual([...BOOST_DURATION_CODES], ["24h", "3d", "7d"]);
  assert.equal(BOOST_PURCHASE_CONTRACT_VERSION, "boost-purchase/v1");
  assert.equal(BOOST_PURCHASE_HTTP_BODY_MAX_BYTES, 2048);
});

test("les listes du code sont EXACTEMENT celles des migrations 0015, 0021 et 0028 (source d'un boost, types de transaction, durées)", () => {
  const sql = source("database/migrations/0015_boost_purchases.sql");
  const list = (constraint: string): string[] => {
    const match = new RegExp(`${constraint}\\s+CHECK \\((?:source|kind|duration_code) IN \\(([^)]*)\\)`, "m").exec(sql.replace(/\n\s+/g, " "));
    assert.ok(match, `contrainte ${constraint} introuvable`);
    return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((entry) => entry[1]);
  };
  assert.deepEqual(list("chk_offer_boosts_source"), [...BOOST_RECORD_SOURCES]);
  assert.deepEqual(list("chk_boost_purchases_duration_code"), [...BOOST_DURATION_CODES]);
  // Les types de transaction : la définition de 0021 (lot PRO1) ajoute les trois types de l'offre Pro à ceux de 0015.
  assert.deepEqual(list("chk_wallet_transactions_kind"), ["topup", "adjustment", "boost_purchase", "boost_refund"]);
  const proSql = source("database/migrations/0021_pro_subscriptions.sql").replace(/\n\s+/g, " ");
  const proKinds = /chk_wallet_transactions_kind\s+CHECK \(kind IN \(([^)]*)\)/m.exec(proSql);
  assert.ok(proKinds, "contrainte chk_wallet_transactions_kind introuvable dans 0021");
  const proList = [...proKinds[1].matchAll(/'([a-z0-9_]+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(proList, ["topup", "adjustment", "boost_purchase", "boost_refund", "subscription_charge", "subscription_refund", "promo_expiry"]);
  // Lot RA1 : la migration 0028 ajoute les deux types de la recherche active ; sa définition est la DERNIÈRE de la contrainte, celle que reflète le code.
  const searchSql = source("database/migrations/0028_active_search.sql").replace(/\n\s+/g, " ");
  const searchKinds = /chk_wallet_transactions_kind\s+CHECK \(kind IN \(([^)]*)\)/m.exec(searchSql);
  assert.ok(searchKinds, "contrainte chk_wallet_transactions_kind introuvable dans 0028");
  assert.deepEqual([...searchKinds[1].matchAll(/'([a-z0-9_]+)'/g)].map((entry) => entry[1]), [...WALLET_TRANSACTION_KINDS]);
  assert.deepEqual([...WALLET_TRANSACTION_KINDS], [...proList, "search_purchase", "search_refund"]);
});

test("erreurs de domaine de l'achat : un message fixe par code, sans donnée (ni identifiant, ni montant)", () => {
  const codes: BoostErrorCode[] = ["quote_not_found", "quote_expired", "quote_unavailable", "quote_already_used", "idempotency_conflict", "purchase_not_found", "already_refunded"];
  for (const code of codes) {
    const message = BOOST_ERROR_MESSAGES[code];
    assert.equal(typeof message, "string");
    assert.ok(message.length > 5, code);
    assert.ok(!/[0-9]/.test(message) && !/[0-9a-f]{8}-/.test(message), `${code} : aucun chiffre ni identifiant`);
    const error = new BoostError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.name, "BoostError");
  }
  assert.equal(new Set(codes.map((code) => BOOST_ERROR_MESSAGES[code])).size, codes.length, "messages tous différents");
});

test("erreur de domaine reach_check_unavailable (lot P3-bis) : texte fixe, distinct de no_visible_effect, retriable (jamais un refus définitif), sans donnée", () => {
  const error = new BoostError("reach_check_unavailable");
  assert.equal(error.code, "reach_check_unavailable");
  assert.equal(error.message, "Vérification impossible pour le moment, réessayez dans un instant.");
  assert.notEqual(BOOST_ERROR_MESSAGES.reach_check_unavailable, BOOST_ERROR_MESSAGES.no_visible_effect);
  assert.ok(!/[0-9]/.test(BOOST_ERROR_MESSAGES.reach_check_unavailable), "aucun chiffre");
  assert.equal(/rien n'a été acheté|aucun acheteur/.test(BOOST_ERROR_MESSAGES.reach_check_unavailable), false, "ne dit jamais « aucun effet » : rien n'est démontré");
});

test("transaction du grand livre `boost_purchase` et `boost_refund` : métadonnées exactes et référence dérivée de l'achat, validées avant tout SQL", () => {
  const purchase = randomUUID();
  const quote = randomUUID();
  const owner = randomUUID();
  const entries = (amount: number) => [
    { account: { kind: "user" as const, ownerId: owner }, amount: -big(amount) },
    { account: { kind: "boost_revenue" as const }, amount: big(amount) },
  ];
  const purchaseGood = { kind: "boost_purchase" as const, reference: `boost_purchase:${purchase}`, metadata: { boostPurchaseId: purchase, quoteId: quote }, entries: entries(2300) };
  const validated = validateWalletTransactionInput(purchaseGood);
  assert.equal(validated.kind, "boost_purchase");
  assert.deepEqual(validated.metadata, { boostPurchaseId: purchase, quoteId: quote });
  const refundEntries = [
    { account: { kind: "boost_revenue" as const }, amount: -big(2300) },
    { account: { kind: "user" as const, ownerId: owner }, amount: big(2300) },
  ];
  const refundGood = { kind: "boost_refund" as const, reference: `boost_refund:${purchase}`, metadata: { boostPurchaseId: purchase, reasonCode: "customer_request" }, entries: refundEntries };
  assert.equal(validateWalletTransactionInput(refundGood).kind, "boost_refund");

  const refused: Array<[string, unknown]> = [
    ["achat sans métadonnées", { ...purchaseGood, metadata: undefined }],
    ["achat sans quoteId", { ...purchaseGood, metadata: { boostPurchaseId: purchase } }],
    ["achat sans boostPurchaseId", { ...purchaseGood, metadata: { quoteId: quote } }],
    ["achat avec reasonCode en plus", { ...purchaseGood, metadata: { ...purchaseGood.metadata, reasonCode: "x" } }],
    ["achat dont la référence ne dérive pas de l'achat", { ...purchaseGood, reference: `boost_purchase:${randomUUID()}` }],
    ["achat avec la référence d'un remboursement", { ...purchaseGood, reference: `boost_refund:${purchase}` }],
    ["remboursement sans reasonCode", { ...refundGood, metadata: { boostPurchaseId: purchase } }],
    ["remboursement avec quoteId", { ...refundGood, metadata: { ...refundGood.metadata, quoteId: quote } }],
    ["remboursement dont la référence ne dérive pas de l'achat", { ...refundGood, reference: `boost_refund:${randomUUID()}` }],
    ["boostPurchaseId non UUID", { ...purchaseGood, reference: "boost_purchase:abc", metadata: { boostPurchaseId: "abc", quoteId: quote } }],
    ["boostPurchaseId en majuscules", { ...purchaseGood, metadata: { ...purchaseGood.metadata, boostPurchaseId: purchase.toUpperCase() } }],
    ["ajustement qui porte boostPurchaseId", { kind: "adjustment", reference: "adjustment:fix-1", metadata: { boostPurchaseId: purchase }, entries: entries(5) }],
    ["recharge qui porte quoteId", { kind: "topup", reference: `topup:${purchase}`, metadata: { paymentIntentId: purchase, quoteId: quote }, entries: entries(5) }],
    ["somme non nulle", { ...purchaseGood, entries: [purchaseGood.entries[0], { account: { kind: "boost_revenue" as const }, amount: big(2299) }] }],
    ["montant non bigint", { ...purchaseGood, entries: [{ ...purchaseGood.entries[0], amount: -2300 }, purchaseGood.entries[1]] }],
  ];
  for (const [label, input] of refused) {
    assert.throws(() => validateWalletTransactionInput(input), (error: unknown) => error instanceof CatalogValidationError, label);
  }
});

// ───────────── structure des sources : une seule copie des règles, ordre des contrôles, aucune fuite ─────────────

test("une seule copie des règles de places et de plafond : purchase.ts passe par placeOfferBoostInTransaction, comme grantOfferBoost", () => {
  const boosts = source("lib/server/boost/boosts.ts");
  const purchase = source("lib/server/boost/purchase.ts");
  for (const rule of ['throw new BoostError("no_slot_available")', 'throw new BoostError("seller_boost_limit_reached")', 'throw new BoostError("offer_already_boosted")', "pg_advisory_xact_lock"]) {
    assert.equal(boosts.split(rule).length - 1, 1, `${rule} n'existe qu'UNE fois dans boosts.ts`);
  }
  for (const rule of ['throw new BoostError("no_slot_available")', 'throw new BoostError("seller_boost_limit_reached")', 'throw new BoostError("offer_already_boosted")']) {
    assert.ok(!purchase.includes(rule), `${rule} n'est pas copié dans purchase.ts`);
  }
  // Le seul verrou consultatif propre à purchase.ts est celui de l'idempotence (espace distinct de celui du périmètre).
  assert.equal(purchase.split("pg_advisory_xact_lock").length - 1, 1);
  assert.match(purchase, /pg_advisory_xact_lock\(\$1::int, hashtext\(\$2::text\)\)", \[BOOST_PURCHASE_LOCK_NAMESPACE,/);
  for (const forbidden of ["computeSlots", "computeSellerLimit", "countEffectiveBoosts", "readBoostSettings", "BOOST_SCOPE_LOCK_NAMESPACE", "countOffersInScope"]) {
    assert.ok(!purchase.includes(forbidden), `purchase.ts n'utilise pas ${forbidden} directement`);
  }
  assert.match(purchase, /placeOfferBoostInTransaction\(client, \{/);
  assert.match(boosts, /export async function placeOfferBoostInTransaction\(/);
  const grantBody = boosts.slice(boosts.indexOf("export async function grantOfferBoost("), boosts.indexOf("// ───────────── annulation"));
  assert.match(grantBody, /placeOfferBoostInTransaction\(client, \{/);
  assert.ok(!grantBody.includes("INSERT INTO offer_boosts"), "l'INSERT du boost n'est pas copié dans grantOfferBoost");
  // L'annulation est partagée de la même façon avec le remboursement.
  assert.match(boosts, /export async function cancelOfferBoostInTransaction\(/);
  assert.match(purchase, /cancelOfferBoostInTransaction\(client, \{/);
  assert.ok(!purchase.includes("UPDATE offer_boosts"), "purchase.ts n'écrit pas lui-même le statut d'un boost");
});

test("achat : le prix est celui de la cotation (jamais recalculé), le débit n'a lieu qu'APRÈS tous les contrôles de places, avant la création du boost et de la ligne d'achat", () => {
  const purchase = source("lib/server/boost/purchase.ts");
  for (const forbidden of ["computeBoostPrice", "readBoostPricingSettings", "pricing", "quoteOfferBoost"]) {
    assert.ok(!purchase.includes(forbidden), `purchase.ts ne recalcule pas le prix (${forbidden})`);
  }
  const body = purchase.slice(purchase.indexOf("export async function purchaseOfferBoost("), purchase.indexOf("// ───────────── remboursement"));
  const at = (needle: string): number => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `${needle} introuvable`);
    return index;
  };
  // Ordre : verrou d'idempotence → relecture → cotation → placement (qui contient les contrôles) → débit dans beforeInsert → ligne d'achat.
  assert.ok(at("BOOST_PURCHASE_LOCK_NAMESPACE") < at("FROM boost_purchases p WHERE p.seller_id"));
  assert.ok(at("FROM boost_purchases p WHERE p.seller_id") < at("assertQuotePurchasable(client, { quoteId, sellerId, offerId })"));
  assert.ok(at("assertQuotePurchasable(client, { quoteId, sellerId, offerId })") < at("placeOfferBoostInTransaction(client, {"));
  assert.ok(at("placeOfferBoostInTransaction(client, {") < at("postWalletTransaction(client, {"), "le débit est dans le rappel beforeInsert du placement");
  assert.ok(at("beforeInsert: async () => {") < at("postWalletTransaction(client, {"));
  assert.ok(at("postWalletTransaction(client, {") < at("INSERT INTO boost_purchases"));
  // Lot PRO1 : le prix à répartir est EXACTEMENT celui de la cotation ; les crédits promotionnels (émissions verrouillées dans le rappel beforeInsert, avant les comptes) sont
  // dépensés EN PREMIER, le débit des crédits payés ne porte que sur le reste. Aucun montant n'est recalculé.
  assert.match(body, /splitBoostPrice\(price\.amount, grants\)/);
  assert.match(body, /amount: -split\.paid/);
  assert.match(body, /amount: -split\.promo/);
  assert.ok(at("beforeInsert: async () => {") < at("lockSpendablePromoGrants(client, sellerId)"));
  assert.ok(at("lockSpendablePromoGrants(client, sellerId)") < at("splitBoostPrice(price.amount, grants)"));
  assert.ok(at("splitBoostPrice(price.amount, grants)") < at("postWalletTransaction(client, {"), "la répartition précède le débit");
  assert.ok(at("INSERT INTO boost_purchases") < at("recordPromoSpends(client"), "les dépenses promotionnelles s'inscrivent après la ligne d'achat (clé étrangère)");
  // Dans le placement partagé, le rappel de débit est appelé APRÈS les contrôles de places et AVANT l'INSERT du boost.
  const boosts = source("lib/server/boost/boosts.ts");
  const placement = boosts.slice(boosts.indexOf("export async function placeOfferBoostInTransaction("), boosts.indexOf("export async function grantOfferBoost("));
  assert.ok(placement.indexOf('"no_slot_available"') < placement.indexOf("input.beforeInsert(context)"));
  assert.ok(placement.indexOf('"seller_boost_limit_reached"') < placement.indexOf("input.beforeInsert(context)"));
  assert.ok(placement.indexOf("input.beforeInsert(context)") < placement.indexOf("INSERT INTO offer_boosts"));
  assert.ok(placement.indexOf("pg_advisory_xact_lock") < placement.indexOf("input.afterScopeLock(context)"));
  assert.ok(placement.indexOf("input.afterScopeLock(context)") < placement.indexOf('"offer_already_boosted"'));
});

test("ordre des verrous documenté : le remboursement prend l'achat puis le boost puis le grand livre ; l'achat prend l'idempotence, l'offre, le périmètre, le grand livre", () => {
  const purchase = source("lib/server/boost/purchase.ts");
  const refund = purchase.slice(purchase.indexOf("export async function refundBoostPurchase("), purchase.indexOf("// ───────────── historique"));
  assert.ok(refund.indexOf("FOR UPDATE") < refund.indexOf("cancelOfferBoostInTransaction("));
  assert.ok(refund.indexOf("cancelOfferBoostInTransaction(") < refund.indexOf("postWalletTransaction(client, {"));
  assert.ok(refund.indexOf("postWalletTransaction(client, {") < refund.indexOf("UPDATE boost_purchases"));
  assert.match(purchase, /ORDRE GLOBAL DES VERROUS/);
  assert.ok(!/INSERT INTO wallet_(transactions|entries)/.test(purchase), "toute écriture du grand livre passe par postWalletTransaction");
});

test("routes HTTP : origine AVANT la session, JSON strict, DTO en liste blanche sans identifiant de boost ni de transaction ; aucune route de remboursement", () => {
  const http = source("lib/server/boost/purchase-http.ts");
  const create = http.slice(http.indexOf("async create(request, id)"), http.indexOf("async list(request, id)"));
  assert.ok(create.indexOf("checkPostOrigin(") >= 0 && create.indexOf("authenticate(request)") >= 0);
  assert.ok(create.indexOf("checkPostOrigin(") < create.indexOf("authenticate(request)"), "l'origine est contrôlée avant la session");
  assert.ok(create.indexOf("authenticate(request)") < create.indexOf("readStrictJsonBody("), "la session précède la lecture du corps");
  assert.ok(create.indexOf("readStrictJsonBody(") < create.indexOf("purchaseOfferBoost("));
  assert.ok(!http.includes("JSON.parse") && !http.includes("readJsonBodyCapped"), "jamais le JSON.parse tolérant");
  const list = http.slice(http.indexOf("async list(request, id)"));
  assert.ok(!list.includes("checkPostOrigin("), "le GET n'a pas de contrôle d'origine (lecture seule)");
  for (const dto of ["function purchaseDto(", "function historyDto("]) {
    const start = http.indexOf(dto);
    const text = http.slice(start, http.indexOf("\n}\n", start));
    for (const leak of ["boostId", "transactionId", "sellerId", "offerId", "idempotencyKey", "refundTransactionId", "boost.id"]) {
      assert.ok(!text.includes(leak), `${dto} ne copie pas ${leak}`);
    }
  }
  const route = source("app/api/offers/[id]/boost-purchases/route.ts");
  assert.deepEqual([...route.matchAll(/^export (?:async )?function (\w+)/gm)].map((entry) => entry[1]).sort(), ["GET", "POST"]);
  assert.match(route, /export const runtime = "nodejs";/);
  assert.match(route, /export const dynamic = "force-dynamic";/);
  // Aucun chemin de remboursement ni d'administration n'est exposé en HTTP.
  const listing = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? [path, ...listing(path)] : [path];
  });
  const apiPaths = listing(root("app/api"));
  assert.ok(!apiPaths.some((path) => /refund|rembours/i.test(path)), "aucune route de remboursement");
  assert.ok(!existsSync(root("app/api/offers/[id]/boost-purchases/refund")));
});

test("P1b-bis : fenêtre d'un boost acheté figée par la base, délais de verrou posés avant tout verrou, offre lue en lecture partagée, cotation achetée exclue de la réutilisation", () => {
  const sql = source("database/migrations/0015_boost_purchases.sql");
  const trigger = sql.slice(sql.indexOf("CREATE TRIGGER trg_offer_boosts_purchase_window"), sql.indexOf("-- Cohérence au COMMIT"));
  assert.match(trigger, /BEFORE UPDATE ON offer_boosts/);
  assert.match(trigger, /WHEN \(OLD\.source = 'purchase' OR NEW\.source = 'purchase'\)/);
  const guardFunction = sql.slice(sql.indexOf("CREATE FUNCTION offer_boosts_guard_purchase_window()"), sql.indexOf("CREATE TRIGGER trg_offer_boosts_purchase_window"));
  for (const column of ["starts_at", "ends_at", "duration_code", "offer_id", "seller_id", "source"]) {
    assert.ok(guardFunction.includes(`NEW.${column} IS DISTINCT FROM OLD.${column}`), `le déclencheur fige ${column}`);
  }
  for (const allowed of ["status", "cancelled_at"]) assert.ok(!guardFunction.includes(`NEW.${allowed}`), `le déclencheur ne touche pas ${allowed}`);
  assert.match(sql, /window_seconds := CASE NEW\.duration_code WHEN '24h' THEN 86400 WHEN '3d' THEN 259200 WHEN '7d' THEN 604800 END;/);
  assert.match(source("lib/server/wallet/check.ts"), /code: "boost_purchase_window_mismatch"/);

  const purchase = source("lib/server/boost/purchase.ts");
  const purchaseBody = purchase.slice(purchase.indexOf("export async function purchaseOfferBoost("), purchase.indexOf("// ───────────── remboursement"));
  const refundBody = purchase.slice(purchase.indexOf("export async function refundBoostPurchase("), purchase.indexOf("// ───────────── historique"));
  assert.ok(purchaseBody.indexOf("SET LOCAL lock_timeout") >= 0 && purchaseBody.indexOf("SET LOCAL lock_timeout") < purchaseBody.indexOf("pg_advisory_xact_lock"), "achat : lock_timeout avant le verrou d'idempotence");
  assert.ok(refundBody.indexOf("SET LOCAL lock_timeout") >= 0 && refundBody.indexOf("SET LOCAL lock_timeout") < refundBody.indexOf("FOR UPDATE"), "remboursement : lock_timeout avant le verrou de l'achat");
  const boosts = source("lib/server/boost/boosts.ts");
  const placement = boosts.slice(boosts.indexOf("export async function placeOfferBoostInTransaction("), boosts.indexOf("export async function grantOfferBoost("));
  assert.match(placement, /loadOfferFacts\(client, offerId, true\)/, "l'offre est lue FOR SHARE par le placement partagé");
  assert.match(boosts, /\$\{lockRow \? "FOR SHARE OF o" : ""\}/);
  const quotes = source("lib/server/boost/quotes.ts");
  const reuse = quotes.slice(quotes.indexOf("const existing = await client.query<QuoteRow>("), quotes.indexOf("if (existing.rows[0])"));
  assert.match(reuse, /AND NOT EXISTS \(SELECT 1 FROM boost_purchases p WHERE p\.quote_id = boost_quotes\.id\)/, "une cotation achetée n'est jamais réutilisée");
});

test("package.json : scripts d'administration et de test du lot", () => {
  const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts["boost:refund-purchase"], /scripts\/boost-refund-purchase\.ts$/);
  assert.match(scripts["test:boost-purchase"], /tests\/server\/boost-purchase\.test\.ts tests\/postgres\/boost-purchase\.integration\.test\.ts/);
  assert.match(scripts["test:boost-purchase-http"], /tests\/postgres\/boost-purchase-http\.integration\.test\.ts/);
  assert.ok(existsSync(root("scripts/boost-refund-purchase.ts")));
});
