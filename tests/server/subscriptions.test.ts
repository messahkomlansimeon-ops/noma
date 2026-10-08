import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import { ENTITLEMENTS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, PLAN_FREE_CODE, PLAN_PRO_CODE, SUBSCRIPTION_GRACE_HOURS } from "../../lib/server/subscriptions/config";
import { SUBSCRIPTION_ERROR_MESSAGES, SubscriptionError, type SubscriptionErrorCode } from "../../lib/server/subscriptions/errors";
import { validateNewPlanVersion } from "../../lib/server/subscriptions/plans";
import { splitBoostPrice } from "../../lib/server/subscriptions/promo";
import { validateWalletTransactionInput } from "../../lib/server/wallet/ledger";

const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const big = (value: number): bigint => BigInt(value);
const uuid = (digit: string): string => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const USER = uuid("1");
const PERIOD = uuid("2");
const GRANT = uuid("3");
const PURCHASE = uuid("4");

// ───────────── configuration ─────────────

test("configuration : droits de la liste blanche, plans de départ, grâce de 72 h, import de 200 lignes et 256 Kio ; identiques à la migration 0021", () => {
  assert.deepEqual([...ENTITLEMENTS], ["badge_pro", "catalog_import", "priority_support_label"]);
  assert.equal(PLAN_FREE_CODE, "free");
  assert.equal(PLAN_PRO_CODE, "pro");
  assert.equal(SUBSCRIPTION_GRACE_HOURS, 72);
  assert.equal(IMPORT_MAX_ROWS, 200);
  assert.equal(IMPORT_MAX_BYTES, 256 * 1024);
  const sql = source("database/migrations/0021_pro_subscriptions.sql").replace(/\s+/g, " ");
  const list = /p_entitlements <@ ARRAY\[([^\]]*)\]/.exec(sql);
  assert.ok(list, "liste blanche des droits dans la migration");
  assert.deepEqual([...list[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]), [...ENTITLEMENTS]);
  // Les valeurs de départ (PROVISOIRES) de la migration.
  assert.match(sql, /'Gratuit', 0, 0, 10, '\{\}'::text\[\]/);
  assert.match(sql, /'Pro', 10000, 5000, 100, ARRAY\['badge_pro', 'catalog_import'\]/);
  assert.match(sql, /PRIX PROVISOIRES/);
  // Le délai de grâce du code est celui que le document annonce.
  assert.match(source("OFFRE-PRO.md"), /72 h à partir de la FIN de la période/);
});

test("erreurs de domaine de l'offre Pro : un message fixe par code, sans donnée", () => {
  const codes: SubscriptionErrorCode[] = [
    "plan_not_found", "plan_not_subscribable", "already_subscribed", "no_subscription", "period_ended", "idempotency_conflict", "entitlement_required", "period_not_found",
    "already_refunded", "invalid_plan_version", "plans_unavailable", "import_too_many_rows", "import_invalid_file",
  ];
  for (const code of codes) {
    const message = SUBSCRIPTION_ERROR_MESSAGES[code];
    assert.equal(typeof message, "string");
    assert.ok(message.length > 5);
    assert.ok(!/[0-9a-f]{8}-/.test(message), `${code} : aucun identifiant`);
    const error = new SubscriptionError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.name, "SubscriptionError");
  }
  assert.equal(new Set(codes.map((code) => SUBSCRIPTION_ERROR_MESSAGES[code])).size, codes.length, "messages tous différents");
  assert.equal(Object.keys(SUBSCRIPTION_ERROR_MESSAGES).length, codes.length, "aucun code sans test");
});

// ───────────── validation d'une nouvelle version ─────────────

test("nouvelle version d'un plan : bornes, droits de la liste blanche sans doublon, règles du plan Gratuit, validation AVANT tout SQL", () => {
  const valid = { planCode: "pro", name: " Pro v2 ", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro", "catalog_import"], createdBy: uuid("a") };
  const ok = validateNewPlanVersion(valid);
  assert.equal(ok.name, "Pro v2", "nom nettoyé");
  assert.equal(ok.createdBy, uuid("a"));
  const reject = (override: Record<string, unknown>) => assert.throws(() => validateNewPlanVersion({ ...valid, ...override } as never), CatalogValidationError, JSON.stringify(override));
  reject({ planCode: "Pro" });
  reject({ planCode: "" });
  reject({ planCode: "a" });
  reject({ name: "" });
  reject({ name: "   " });
  reject({ name: "x".repeat(61) });
  reject({ name: "ab‮cd" });
  reject({ name: 5 });
  reject({ monthlyPriceXof: 0 });
  reject({ monthlyPriceXof: -1 });
  reject({ monthlyPriceXof: 1.5 });
  reject({ monthlyPriceXof: 1_000_000_001 });
  reject({ monthlyPriceXof: "12000" });
  reject({ promoCreditsXof: -1 });
  reject({ promoCreditsXof: 0.5 });
  reject({ maxOnlineOffers: 0 });
  reject({ maxOnlineOffers: 100_001 });
  reject({ maxOnlineOffers: 2.5 });
  reject({ entitlements: ["inconnu"] });
  reject({ entitlements: ["badge_pro", "badge_pro"] });
  reject({ entitlements: "badge_pro" });
  reject({ createdBy: "pas-un-uuid" });
  // Bornes acceptées.
  assert.equal(validateNewPlanVersion({ ...valid, monthlyPriceXof: 1_000_000_000, promoCreditsXof: 0, maxOnlineOffers: 100_000, entitlements: [] }).maxOnlineOffers, 100_000);
  assert.equal(validateNewPlanVersion({ ...valid, name: "x".repeat(60) }).name.length, 60);
  // Plan Gratuit : ni prix, ni crédits, ni droit.
  const free = { ...valid, planCode: "free", monthlyPriceXof: 0, promoCreditsXof: 0, entitlements: [] };
  assert.equal(validateNewPlanVersion(free).planCode, "free");
  for (const override of [{ monthlyPriceXof: 1 }, { promoCreditsXof: 1 }, { entitlements: ["badge_pro"] }]) assert.throws(() => validateNewPlanVersion({ ...free, ...override } as never), CatalogValidationError);
});

// ───────────── grand livre : types et comptes de l'offre Pro ─────────────

const entry = (account: unknown, amount: bigint) => ({ account, amount });

test("transactions de l'offre Pro : forme exacte des métadonnées et de la référence, comptes permis seulement, sens imposé, somme nulle", () => {
  const charge = {
    kind: "subscription_charge",
    reference: `subscription_charge:${PERIOD}`,
    metadata: { subscriptionPeriodId: PERIOD },
    entries: [
      entry({ kind: "user", ownerId: USER }, -big(10_000)), entry({ kind: "subscription_revenue" }, big(10_000)),
      entry({ kind: "user_promo", ownerId: USER }, big(5_000)), entry({ kind: "promo_issuance" }, -big(5_000)),
    ],
  };
  assert.equal(validateWalletTransactionInput(charge).kind, "subscription_charge");
  const bad = (override: Record<string, unknown>, base: Record<string, unknown> = charge) => assert.throws(() => validateWalletTransactionInput({ ...base, ...override }), CatalogValidationError, JSON.stringify(Object.keys(override)));
  bad({ metadata: {} });
  bad({ metadata: { subscriptionPeriodId: PERIOD, reasonCode: "x" } });
  bad({ metadata: { promoGrantId: GRANT } });
  bad({ reference: `subscription_charge:${uuid("9")}` });
  // Revenus d'abonnement débités par un débit de période : sens interdit.
  bad({ entries: [entry({ kind: "user", ownerId: USER }, big(10_000)), entry({ kind: "subscription_revenue" }, -big(10_000))] });
  // Crédit promotionnel débité à l'émission : sens interdit.
  bad({ entries: [
    entry({ kind: "user", ownerId: USER }, -big(10_000)), entry({ kind: "subscription_revenue" }, big(10_000)),
    entry({ kind: "user_promo", ownerId: USER }, -big(5_000)), entry({ kind: "promo_issuance" }, big(5_000)),
  ] });

  const refund = {
    kind: "subscription_refund",
    reference: `subscription_refund:${PERIOD}`,
    metadata: { subscriptionPeriodId: PERIOD, reasonCode: "geste" },
    entries: [
      entry({ kind: "subscription_revenue" }, -big(10_000)), entry({ kind: "user", ownerId: USER }, big(10_000)),
      entry({ kind: "user_promo", ownerId: USER }, -big(500)), entry({ kind: "promo_expired" }, big(500)),
    ],
  };
  assert.equal(validateWalletTransactionInput(refund).kind, "subscription_refund");
  bad({ metadata: { subscriptionPeriodId: PERIOD } }, refund);
  bad({ metadata: { subscriptionPeriodId: PERIOD, reasonCode: "x", extra: "y" } }, refund);

  const expiry = {
    kind: "promo_expiry",
    reference: `promo_expiry:${GRANT}`,
    metadata: { promoGrantId: GRANT },
    entries: [entry({ kind: "user_promo", ownerId: USER }, -big(700)), entry({ kind: "promo_expired" }, big(700))],
  };
  assert.equal(validateWalletTransactionInput(expiry).kind, "promo_expiry");
  bad({ metadata: { promoGrantId: GRANT, subscriptionPeriodId: PERIOD } }, expiry);
  bad({ reference: `promo_expiry:${PERIOD}` }, expiry);
  bad({ entries: [entry({ kind: "user_promo", ownerId: USER }, big(700)), entry({ kind: "promo_expired" }, -big(700))] }, expiry);
  // Une transaction d'un autre type ne porte aucune de ces clés.
  bad({ kind: "adjustment", reference: `adjustment:${PERIOD}`, metadata: { subscriptionPeriodId: PERIOD, reasonCode: "x" }, entries: [entry({ kind: "boost_revenue" }, -big(1)), entry({ kind: "user", ownerId: USER }, big(1))] }, expiry);
});

test("un crédit promotionnel ne se recharge pas, ne s'ajuste pas, ne se retire pas : seuls les types de son rôle écrivent sur ses comptes", () => {
  const adjust = (account: unknown, amount: bigint) => ({
    kind: "adjustment", reference: `adjustment:${uuid("5")}`, metadata: { reasonCode: "test" },
    entries: [entry(account, amount), entry({ kind: "boost_revenue" }, -amount)],
  });
  for (const account of [{ kind: "user_promo", ownerId: USER }, { kind: "promo_issuance" }, { kind: "promo_consumed" }, { kind: "promo_expired" }, { kind: "subscription_revenue" }]) {
    assert.throws(() => validateWalletTransactionInput(adjust(account, big(100))), CatalogValidationError, `ajustement ${JSON.stringify(account)} (+)`);
    assert.throws(() => validateWalletTransactionInput(adjust(account, -big(100))), CatalogValidationError, `ajustement ${JSON.stringify(account)} (−)`);
  }
  const topup = { kind: "topup", reference: `topup:${uuid("6")}`, metadata: { paymentIntentId: uuid("6") }, entries: [entry({ kind: "provider_clearing" }, -big(100)), entry({ kind: "user_promo", ownerId: USER }, big(100))] };
  assert.throws(() => validateWalletTransactionInput(topup), CatalogValidationError, "recharge sur un compte promotionnel");
  // L'achat et le remboursement de boost peuvent écrire des crédits promotionnels, dans le bon sens seulement.
  const purchase = {
    kind: "boost_purchase", reference: `boost_purchase:${PURCHASE}`, metadata: { boostPurchaseId: PURCHASE, quoteId: uuid("7") },
    entries: [entry({ kind: "user_promo", ownerId: USER }, -big(2_300)), entry({ kind: "promo_consumed" }, big(2_300))],
  };
  assert.equal(validateWalletTransactionInput(purchase).kind, "boost_purchase");
  assert.throws(() => validateWalletTransactionInput({ ...purchase, entries: [entry({ kind: "user_promo", ownerId: USER }, big(2_300)), entry({ kind: "promo_consumed" }, -big(2_300))] }), CatalogValidationError, "achat qui créditerait le sous-compte");
  const refund = {
    kind: "boost_refund", reference: `boost_refund:${PURCHASE}`, metadata: { boostPurchaseId: PURCHASE, reasonCode: "incident" },
    entries: [entry({ kind: "promo_consumed" }, -big(2_300)), entry({ kind: "user_promo", ownerId: USER }, big(1_000)), entry({ kind: "promo_expired" }, big(1_300))],
  };
  assert.equal(validateWalletTransactionInput(refund).kind, "boost_refund");
});

// ───────────── répartition promotionnelle ─────────────

test("répartition d'un prix : promotionnel d'abord, jamais de part négative, somme exacte (propriété sur de nombreux prix et soldes)", () => {
  const grant = (id: string, remaining: number) => ({ id, expiresAt: new Date(0), remaining: big(remaining) });
  assert.deepEqual(splitBoostPrice(big(100), [grant("a", 60)]), { paid: big(40), promo: big(60), allocations: [{ grantId: "a", amount: big(60) }] });
  for (let price = 1; price <= 300; price += 7) {
    for (const remaining of [0, 1, 99, 150, 300, 10_000]) {
      const result = splitBoostPrice(big(price), [grant("a", remaining)]);
      assert.equal(result.promo + result.paid, big(price));
      assert.equal(result.promo, big(Math.min(price, remaining)), "promotionnel d'abord, à concurrence du reste");
      assert.ok(result.paid >= big(0) && result.promo >= big(0));
    }
  }
});

// ───────────── structure du code (les règles qui ne se voient pas à l'exécution) ─────────────

test("la limite d'annonces en ligne est appliquée à la PUBLICATION (seule voie HTTP vers « en ligne ») et à l'import, le verrou de l'utilisateur AVANT la ligne de l'annonce ; l'API refuse `status` à la création et à la modification", () => {
  const offers = source("lib/server/catalog/offers.ts");
  const transition = offers.slice(offers.indexOf("async function transitionOfferStatus("), offers.indexOf("/** Écrit le nouveau statut"));
  assert.match(transition, /targetStatus === "published"\) await lockUserEntitlements\(client, ownerId\)/);
  assert.ok(transition.indexOf("lockUserEntitlements(client, ownerId)") < transition.indexOf("FOR UPDATE"));
  assert.match(transition, /targetStatus === "published"\) await assertCanPublishOffer\(client, ownerId\)/);
  assert.ok(transition.indexOf("assertCanPublishOffer(client, ownerId)") < transition.indexOf("applyOfferStatus("), "le contrôle précède l'écriture du statut");
  const entitlements = source("lib/server/subscriptions/entitlements.ts");
  assert.match(entitlements, /online >= entitlements\.maxOnlineOffers\) throw new OfferLimitError/);
  // `createOffer` et `updateOffer` avec un statut ne sont jamais joignables par HTTP : les schémas de corps de la route du catalogue n'admettent pas `status`.
  const http = source("lib/server/catalog/http.ts");
  assert.match(http, /const OFFER_FIELDS = \[\.\.\.COMMON_FIELDS, "price", "availabilityStatus"\] as const;/);
  assert.ok(!/"status"/.test(http.slice(http.indexOf("const COMMON_FIELDS"), http.indexOf("const DEMAND_FIELDS"))), "aucun champ `status` dans les corps de création et de modification d'une annonce");
  // L'import, seul code qui crée des annonces EN LIGNE, contrôle la limite explicitement avant chaque création.
  const code = source("lib/server/subscriptions/catalog-import.ts");
  assert.ok(code.indexOf("await assertCanPublishOffer(client, sellerId)") < code.indexOf('createOffer({ ...input, ownerId: sellerId, status: "published" }, client)'));
});

test("l'import passe par la validation du formulaire et la création du formulaire ; l'aperçu et l'application partagent UN seul code", () => {
  const code = source("lib/server/subscriptions/catalog-import.ts");
  assert.match(code, /from "\.\.\/\.\.\/client\/catalog-view"/);
  assert.match(code, /buildOfferInput\(/);
  assert.match(code, /createOffer\(\{ \.\.\.input, ownerId: sellerId, status: "published" \}, client\)/);
  assert.ok(code.indexOf('hasEntitlement(await readUserEntitlements(client, sellerId), "catalog_import")') < code.indexOf("buildRow(parsed.columns"), "le droit est contrôlé avant la première ligne");
  assert.ok(code.indexOf("throw new DryRunComplete(result)") < code.indexOf("INSERT INTO catalog_imports"), "l'aperçu annule tout avant d'écrire l'empreinte");
  assert.ok(!/INSERT INTO offers/.test(code), "aucune création d'annonce propre à l'import");
});

test("routes HTTP de l'offre Pro : origine AVANT la session, JSON strict, aucune route d'écriture d'une version publiée", () => {
  const http = source("lib/server/subscriptions/http.ts");
  const write = http.slice(http.indexOf("async function authenticatedWrite("), http.indexOf("return {\n    async state("));
  assert.ok(write.indexOf("context.originGuard(request)") >= 0 && write.indexOf("context.authenticate(request)") > write.indexOf("context.originGuard(request)"));
  assert.ok((http.match(/readStrictJsonBody\(/g) ?? []).length >= 4, "corps JSON strict partout");
  const adminHttp = source("lib/server/admin/plans-http.ts");
  assert.match(adminHttp, /is_admin = TRUE AND status = 'active'/);
  const guarded = adminHttp.slice(adminHttp.indexOf("async function guarded("), adminHttp.indexOf("return {\n    overview"));
  assert.ok(guarded.indexOf("originGuard") < guarded.indexOf("authenticate"), "origine avant session");
  assert.ok(guarded.indexOf("authenticate") < guarded.indexOf("is_admin = TRUE"), "session avant rôle");
  assert.ok(guarded.indexOf("resourceNotFound()") >= 0);
  const plans = source("lib/server/subscriptions/plans.ts");
  assert.ok(!/UPDATE plan_versions|DELETE FROM plan_versions|UPDATE plans/.test(plans), "aucun code ne modifie une version");
});

test("l'étape « subscriptions » du worker est branchée dans runMatchingCycle, après « notify », sans empêcher les autres étapes", () => {
  const runner = source("lib/server/matching/runner.ts");
  assert.match(runner, /runSubscriptionStep\(\{ pool \}\)/);
  assert.ok(runner.indexOf("runNotificationStep(") < runner.indexOf("runSubscriptionStep("), "après l'étape notify");
  assert.match(runner, /subscriptions_error_/);
  const lifecycle = source("lib/server/subscriptions/lifecycle.ts");
  assert.match(lifecycle, /SAVEPOINT subscription_renewal/);
  assert.match(lifecycle, /lockUserEntitlements/);
});

test("l'achat de boost reste UN chemin : le code d'attribution et de places est partagé, la répartition promotionnelle n'ajoute aucun contrôle de places", () => {
  const purchase = source("lib/server/boost/purchase.ts");
  assert.match(purchase, /placeOfferBoostInTransaction\(client, \{/);
  const code = purchase.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/slots_total|max_active_per_seller|seller_boost_limit/.test(code), "purchase.ts ne recalcule aucune règle de places");
  const body = purchase.slice(purchase.indexOf("export async function purchaseOfferBoost("), purchase.indexOf("// ───────────── remboursement"));
  assert.ok(body.indexOf("placeOfferBoostInTransaction(client, {") < body.indexOf("lockSpendablePromoGrants("), "les places d'abord, les crédits promotionnels ensuite");
  assert.ok(body.indexOf("computeBoostReach(") < body.indexOf("lockSpendablePromoGrants("), "la portée est revérifiée avant toute dépense");
});

test("/admin/offres passe par la garde de l'espace d'administration (lot D3) : page sous le gabarit gardé, aucune garde propre, 404 standard pour un non-administrateur", () => {
  const layout = source("app/(admin)/layout.tsx");
  // La page est dans le groupe de routes `(admin)` : le gabarit appelle `requireAdminSpace()` AVANT le sélecteur d'espace et les pages (notFound standard, aucun onglet Admin).
  assert.match(layout, /await requireAdminSpace\(\);/);
  assert.ok(layout.indexOf("await requireAdminSpace()") < layout.indexOf("<RoleSwitcher />"), "la garde précède le sélecteur d'espace");
  assert.ok(layout.indexOf("await requireAdminSpace()") < layout.indexOf("{children}"), "la garde précède la page");
  const page = source("app/(admin)/admin/offres/page.tsx");
  assert.match(page, /<AdminPage title="Offres Pro"/);
  assert.equal(/requireAdminSpace|notFound\(|redirect\(/.test(page), false, "la page n'a pas de garde propre : celle du gabarit s'applique");
  // Le composant d'administration (page cliente) traduit un 404 du serveur en page 404 standard (rôle retiré pendant la session).
  assert.match(source("components/admin/admin-page.tsx"), /notFound\(\)/);
  assert.match(source("lib/server/admin/space-decision.ts"), /session\.isAdmin === true \? "show" : "not_found"/);
  // Les routes de l'API refusent par le même 404 : rôle administrateur actif vérifié en base à chaque appel.
  const routes = source("lib/server/admin/plans-http.ts");
  assert.match(routes, /is_admin = TRUE AND status = 'active'/);
  assert.match(routes, /if \(!admin\.rowCount\) return resourceNotFound\(\);/);
});

test("renouvellement : une nouvelle version d'un plan ne s'applique qu'aux nouvelles souscriptions (le code lit la version de l'abonnement, jamais la dernière) ; remise en ligne des seules annonces « plan_limit »", () => {
  const lifecycle = source("lib/server/subscriptions/lifecycle.ts");
  const renewal = lifecycle.slice(lifecycle.indexOf("async function chargeRenewal("), lifecycle.indexOf("export type SubscriptionStepOutcome"));
  assert.match(renewal, /readVersionById\(client, subscription\.plan_version_id\)/);
  assert.equal(/readLatestVersion/.test(renewal), false, "un renouvellement ne lit jamais la dernière version du plan");
  const subscribe = lifecycle.slice(lifecycle.indexOf("export async function subscribeToPlan("), lifecycle.indexOf("// ───────────── annulation"));
  assert.match(subscribe, /readLatestVersion\(client, planCode\)/, "une NOUVELLE souscription utilise la dernière version");
  const offers = source("lib/server/catalog/offers.ts");
  assert.match(offers, /paused_reason = 'plan_limit'/, "seules les annonces mises en pause par la limite du plan sont candidates");
  assert.match(offers, /ORDER BY created_at DESC, id DESC/, "les plus récentes d'abord");
  assert.match(source("lib/server/subscriptions/lifecycle.ts"), /pauseOfferInTransaction\(client, row\.id, "plan_limit"\)/, "la fin d'abonnement écrit la raison");
});

