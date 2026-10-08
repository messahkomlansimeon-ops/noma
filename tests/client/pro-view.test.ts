import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AdminPlansOverview, CatalogImportResult, PlanView, SubscriptionNoticeView, SubscriptionState, SubscriptionView } from "../../lib/client/pro-api";
import {
  IMPORT_MAX_ROWS, NO_REFUND_NOTE, PRICES_PROVISIONAL_NOTICE, PRO_BADGE_LABEL, PRO_BADGE_NOTICE, PROMO_CREDITS_RULES, adminVersionRows, approximateText, buildNewVersion, canSubscribe,
  checkImportText, comparisonRows, entitlementLabel, importRejectionText, importRowView, importSummary, noticeView, onlineOffersText, planCodeLabel, planPriceText, promoView,
  rejectedRows, renewalText, statusView, subscribableLabelFor, subscribablePlan, subscribeConfirmationText, subscribeState,
} from "../../lib/client/pro-view";
import { TRANSACTION_LABELS, buyState, canBuy, promoExpiryText, purchaseConfirmationText, transactionLabel, walletRow } from "../../lib/client/wallet-view";

const NOW = "2026-10-06T10:00:00.000Z";
const END = "2026-11-06T10:00:00.000Z";
const FREE: PlanView = { code: "free", name: "Gratuit", version: 1, monthlyPriceXof: 0, promoCreditsXof: 0, maxOnlineOffers: 10, entitlements: [] };
const PRO: PlanView = { code: "pro", name: "Pro", version: 1, monthlyPriceXof: 10_000, promoCreditsXof: 5_000, maxOnlineOffers: 100, entitlements: ["badge_pro", "catalog_import"] };
const sub = (overrides: Partial<SubscriptionView> = {}): SubscriptionView => ({
  planCode: "pro", status: "active", periodStart: NOW, periodEnd: END, autoRenew: true, canceledAt: null, graceEndsAt: null, currentPriceXof: 10_000, renewalPriceXof: 10_000, entitled: true, ...overrides,
});
const proState = (overrides: Partial<Pick<SubscriptionState, "current" | "subscription" | "onlineOffers">> = {}) => ({
  current: { source: "subscription" as const, planCode: "pro", planName: "Pro", maxOnlineOffers: 100, entitlements: ["badge_pro" as const, "catalog_import" as const] },
  subscription: sub(),
  onlineOffers: 3,
  ...overrides,
});
const freeState = () => ({ current: { source: "free" as const, planCode: "free", planName: "Gratuit", maxOnlineOffers: 10, entitlements: [] }, subscription: null, onlineOffers: 4 });

describe("textes honnêtes", () => {
  test("badge : libellé et texte exacts, jamais une garantie ; prix provisoires dits ; règles des crédits promotionnels", () => {
    assert.equal(PRO_BADGE_LABEL, "Vendeur Pro");
    assert.equal(PRO_BADGE_NOTICE, "Abonné à l'offre Pro de noma. Ce n'est pas une garantie de qualité.");
    assert.match(PRICES_PROVISIONAL_NOTICE, /^Prix provisoires/);
  assert.match(PRICES_PROVISIONAL_NOTICE, /les abonnés actuels gardent leur prix/, "une nouvelle version ne s'applique qu'aux nouveaux abonnements");
  assert.equal(/renouvellements/.test(PRICES_PROVISIONAL_NOTICE), false, "plus de promesse d'application aux renouvellements");
    assert.match(PROMO_CREDITS_RULES, /dépensés en premier/);
    assert.match(PROMO_CREDITS_RULES, /ni remboursables ni retirables/);
    assert.match(PROMO_CREDITS_RULES, /expirent à la fin de chaque période/);
    assert.match(NO_REFUND_NOTE, /sans remboursement/);
    for (const text of [PRO_BADGE_NOTICE, PRICES_PROVISIONAL_NOTICE]) assert.equal(/garanti(?!e de qualité)/.test(text.replace("garantie de qualité", "")), false);
  });

  test("droits : libellés en mots simples, jamais un code ; un droit inconnu ne s'affiche pas tel quel", () => {
    assert.equal(entitlementLabel("badge_pro"), "Badge « Vendeur Pro » sur vos annonces");
    assert.equal(entitlementLabel("catalog_import"), "Import de catalogue par fichier CSV");
    assert.equal(entitlementLabel("inconnu"), "Droit de l'offre");
    assert.equal(entitlementLabel("__proto__"), "Droit de l'offre");
    assert.equal(planCodeLabel("free"), "Gratuit");
    assert.equal(planCodeLabel("pro"), "Pro");
    assert.equal(planCodeLabel("equipe"), "equipe");
  });
});

describe("comparaison et état", () => {
  test("tableau Gratuit / Pro : prix, annonces, crédits promotionnels, badge, import", () => {
    const rows = comparisonRows([FREE, PRO]);
    assert.deepEqual(rows.map((row) => row.key), ["price", "offers", "promo", "badge", "import"]);
    assert.deepEqual(rows[0].values, ["Gratuit", "10 000 FCFA par mois"]);
    assert.deepEqual(rows[1].values, ["10 au plus", "100 au plus"]);
    assert.deepEqual(rows[2].values, ["Aucun", "5 000 FCFA par mois"]);
    assert.deepEqual(rows[3].values, ["Non", "Oui"]);
    assert.deepEqual(rows[4].values, ["Non", "Oui"]);
    assert.equal(planPriceText(PRO), "10 000 FCFA par mois");
    assert.equal(subscribablePlan([FREE, PRO])?.code, "pro");
    assert.equal(subscribablePlan([FREE]), null);
  });

  test("état : Gratuit, actif, annulé, paiement en attente ; annonces en ligne sur la limite ; jamais de code brut", () => {
    assert.deepEqual(statusView(freeState(), "UTC"), { tone: "neutral", title: "Vous êtes sur l'offre Gratuit", lines: ["4 annonces en ligne sur 10"] });
    const active = statusView(proState(), "UTC");
    assert.equal(active.tone, "good");
    assert.equal(active.title, "Offre Pro active");
    assert.ok(active.lines.some((line) => line.includes("06/11/2026")));
    assert.ok(active.lines.some((line) => line.includes("Renouvellement automatique : 10 000 FCFA le 06/11/2026")));
    const canceled = statusView(proState({ subscription: sub({ autoRenew: false, canceledAt: NOW }) }), "UTC");
    assert.equal(canceled.tone, "warn");
    assert.equal(canceled.title, "Offre Pro annulée");
    assert.ok(canceled.lines.includes(NO_REFUND_NOTE));
    const pastDue = statusView(proState({ subscription: sub({ status: "past_due", graceEndsAt: "2026-11-09T10:00:00.000Z" }) }), "UTC");
    assert.equal(pastDue.title, "Paiement en attente");
    assert.ok(pastDue.lines.some((line) => line.includes("09/11/2026")));
    assert.equal(onlineOffersText(1, 10), "1 annonce en ligne sur 10");
    assert.equal(onlineOffersText(0, 10), "0 annonce en ligne sur 10");
    assert.equal(renewalText(sub({ autoRenew: false }), "UTC"), "Renouvellement automatique désactivé.");
    for (const view of [active, canceled, pastDue]) assert.equal(/past_due|auto_renew|renewal_failed/.test(JSON.stringify(view)), false);
  });

  test("crédits promotionnels : montant, échéance en clair, rien s'il n'y en a plus", () => {
    assert.deepEqual(promoView({ balanceXof: 5_000, expiresAt: END }, "UTC"), { amountText: "5 000 FCFA", expiryText: "valables jusqu'au 06/11/2026 à 10:00" });
    assert.deepEqual(promoView({ balanceXof: 0, expiresAt: END }, "UTC"), { amountText: "0 FCFA", expiryText: null });
    assert.deepEqual(promoView({ balanceXof: 100, expiresAt: null }, "UTC"), { amountText: "100 FCFA", expiryText: null });
    assert.equal(promoExpiryText(5_000, END, "UTC"), "jusqu'au 06/11/2026 à 10:00");
    assert.equal(promoExpiryText(0, END, "UTC"), null);
  });

  test("avis : texte fixe par code, nombre d'annonces mises en pause, lu ou non", () => {
    const notice = (code: SubscriptionNoticeView["code"], listingCount: number | null, readAt: string | null = null): SubscriptionNoticeView => ({ id: "n", code, listingCount, createdAt: NOW, readAt });
    assert.equal(noticeView(notice("renewal_failed", null), "UTC").title, "Renouvellement impossible");
    assert.match(noticeView(notice("renewal_failed", null), "UTC").detail, /3 jours de grâce pendant lesquels votre offre reste active/);
    assert.equal(noticeView(notice("subscription_ended", null), "UTC").title, "Offre Pro terminée");
    assert.equal(noticeView(notice("listings_paused", 1), "UTC").title, "1 annonce mise en pause");
    assert.equal(noticeView(notice("listings_paused", 5), "UTC").title, "5 annonces mises en pause");
    // Texte corrigé : repasser à l'offre Pro remet ces annonces en ligne automatiquement (et le dit) ; rien ne promet de remettre celles que le vendeur a mises en pause.
  const pausedDetail = noticeView(notice("listings_paused", 5), "UTC").detail;
  assert.match(pausedDetail, /Si vous repassez à l'offre Pro, elles seront remises en ligne automatiquement, dans la limite de votre offre/);
  assert.match(pausedDetail, /en mettant une autre en pause/);
  assert.equal(noticeView(notice("listings_restored", 1), "UTC").title, "1 annonce remise en ligne");
  assert.equal(noticeView(notice("listings_restored", 3), "UTC").title, "3 annonces remises en ligne");
  assert.match(noticeView(notice("listings_restored", 3), "UTC").detail, /les plus récentes d'abord, dans la limite de votre offre\. Celles que vous aviez mises en pause vous-même restent en pause\./);
  assert.equal(noticeView(notice("listings_restored", 3), "UTC").unread, true);
  assert.equal(noticeView(notice("listings_paused", 5), "UTC").unread, true);
    assert.equal(noticeView(notice("listings_paused", 5, NOW), "UTC").unread, false);
    assert.equal(noticeView(notice("listings_paused", 5), "UTC").dateText, "06/10/2026 à 10:00");
  });
});

describe("souscription", () => {
  test("« Passer à l'offre Pro » : actif seulement si le solde de CRÉDITS PAYÉS couvre le prix (jamais le promotionnel), plan connu, solde lu", () => {
    assert.deepEqual(subscribeState({ plan: null, balanceXof: 50_000 }), { kind: "none" });
    assert.deepEqual(subscribeState({ plan: FREE, balanceXof: 50_000 }), { kind: "none" }, "un plan gratuit ne se souscrit pas");
    assert.deepEqual(subscribeState({ plan: PRO, balanceXof: null }), { kind: "balance_unknown" });
    assert.deepEqual(subscribeState({ plan: PRO, balanceXof: -1 }), { kind: "balance_unknown" });
    const poor = subscribeState({ plan: PRO, balanceXof: 9_999 });
    assert.equal(poor.kind, "insufficient");
    if (poor.kind === "insufficient") {
      assert.equal(poor.missingXof, 1);
      assert.match(poor.text, /Solde insuffisant \(9 999 FCFA\)/);
      assert.match(poor.detail, /pas les crédits promotionnels/);
    }
    const ready = subscribeState({ plan: PRO, balanceXof: 12_000 });
    assert.deepEqual(ready, { kind: "ready", priceXof: 10_000, balanceXof: 12_000, balanceAfterXof: 2_000, promoXof: 5_000 });
    assert.deepEqual(subscribeState({ plan: PRO, balanceXof: 10_000 }), { kind: "ready", priceXof: 10_000, balanceXof: 10_000, balanceAfterXof: 0, promoXof: 5_000 }, "le prix exact passe");
    assert.equal(canSubscribe(ready, false), true);
    assert.equal(canSubscribe(ready, true), false, "pas de double envoi");
    assert.equal(canSubscribe(poor, false), false);
    assert.equal(canSubscribe({ kind: "none" }, false), false);
    assert.equal(subscribeConfirmationText(ready as Extract<typeof ready, { kind: "ready" }>), "Vous allez payer 10 000 FCFA avec vos crédits pour un mois d'offre Pro. Solde après paiement : 2 000 FCFA. Vous recevez 5 000 FCFA de crédits promotionnels pour cette période.");
    assert.equal(subscribableLabelFor(PRO), "Passer à l'offre Pro — 10 000 FCFA par mois");
  });
});

describe("porte-monnaie et achat de boost avec crédits promotionnels", () => {
  test("types de transaction : libellés en mots simples ; ligne : la part promotionnelle est séparée de la part payée", () => {
    assert.equal(transactionLabel("subscription_charge"), "Abonnement Pro");
    assert.equal(transactionLabel("subscription_refund"), "Remboursement d'abonnement");
    assert.equal(transactionLabel("promo_expiry"), "Expiration de crédits promotionnels");
    assert.equal(TRANSACTION_LABELS.promo_expiry.includes("promo_expiry"), false);
    const row = walletRow({ id: "a", kind: "subscription_charge", amountXof: -10_000, promoAmountXof: 5_000, createdAt: NOW }, "UTC");
    assert.equal(row.amountText, "−10 000 FCFA");
    assert.equal(row.promoText, "+5 000 FCFA promotionnels");
    assert.equal(row.tone, "debit");
    const pure = walletRow({ id: "b", kind: "promo_expiry", amountXof: 0, promoAmountXof: -2_700, createdAt: NOW }, "UTC");
    assert.equal(pure.amountText, "−2 700 FCFA");
    assert.equal(pure.promoText, "crédits promotionnels");
    assert.equal(pure.tone, "debit");
    const plain = walletRow({ id: "c", kind: "topup", amountXof: 2_000, promoAmountXof: 0, createdAt: NOW }, "UTC");
    assert.equal(plain.promoText, null);
    assert.equal(plain.amountText, "+2 000 FCFA");
  });

  test("« Acheter » : les crédits promotionnels paient EN PREMIER, les crédits complètent ; insuffisant seulement si les deux ensemble ne suffisent pas", () => {
    const quote = { status: "available" as const, amount: 2_300, currency: "XOF" };
    // Sans promotionnel : comportement inchangé.
    assert.deepEqual(buyState({ quote, expired: false, balanceXof: 5_000 }), { kind: "ready", amountXof: 2_300, balanceXof: 5_000, balanceAfterXof: 2_700 });
    // Promotionnel couvrant tout le prix : les crédits payés ne bougent pas.
    assert.deepEqual(buyState({ quote, expired: false, balanceXof: 5_000, promoBalanceXof: 5_000 }), { kind: "ready", amountXof: 2_300, balanceXof: 5_000, balanceAfterXof: 5_000, promoXof: 2_300 });
    // Promotionnel partiel : le reste vient des crédits.
    assert.deepEqual(buyState({ quote, expired: false, balanceXof: 5_000, promoBalanceXof: 1_000 }), { kind: "ready", amountXof: 2_300, balanceXof: 5_000, balanceAfterXof: 3_700, promoXof: 1_000 });
    // Solde payé nul mais promotionnel suffisant : achat possible.
    assert.equal(buyState({ quote, expired: false, balanceXof: 0, promoBalanceXof: 2_300 }).kind, "ready");
    // Insuffisant : la somme des deux ne suffit pas.
    const poor = buyState({ quote, expired: false, balanceXof: 1_000, promoBalanceXof: 1_000 });
    assert.equal(poor.kind, "insufficient");
    if (poor.kind === "insufficient") {
      assert.equal(poor.missingXof, 300);
      assert.match(poor.text, /1 000 FCFA et 1 000 FCFA de crédits promotionnels/);
    }
    assert.equal(canBuy(buyState({ quote, expired: false, balanceXof: 0, promoBalanceXof: 2_300 }), false), true);
    // Un promotionnel illisible (négatif, non entier) est ignoré, jamais compté.
    assert.deepEqual(buyState({ quote, expired: false, balanceXof: 5_000, promoBalanceXof: -5 }), { kind: "ready", amountXof: 2_300, balanceXof: 5_000, balanceAfterXof: 2_700 });
    assert.deepEqual(buyState({ quote, expired: false, balanceXof: 5_000, promoBalanceXof: 1.5 }), { kind: "ready", amountXof: 2_300, balanceXof: 5_000, balanceAfterXof: 2_700 });
  });

  test("confirmation d'achat : dit la part promotionnelle (dépensée en premier) et la part payée, et le solde de crédits après", () => {
    assert.equal(purchaseConfirmationText({ amountXof: 1_300, durationCode: "3d", balanceXof: 2_000 }), "Vous allez payer 1 300 FCFA pour un boost de 3 jours. Solde après achat : 700 FCFA.");
    assert.equal(
      purchaseConfirmationText({ amountXof: 2_300, durationCode: "24h", balanceXof: 5_000, promoXof: 2_300 }),
      "Vous allez payer 2 300 FCFA pour un boost de 24 h : 2 300 FCFA de crédits promotionnels (dépensés en premier). Solde de crédits après achat : 5 000 FCFA.",
    );
    assert.match(purchaseConfirmationText({ amountXof: 7_000, durationCode: "24h", balanceXof: 5_000, promoXof: 5_000 }), /5 000 FCFA de crédits promotionnels \(dépensés en premier\) et 2 000 FCFA de vos crédits\. Solde de crédits après achat : 3 000 FCFA\./);
  });
});

describe("import de catalogue", () => {
  const rows = (count: number): string => `titre\n${Array.from({ length: count }, (_, index) => `A${index}`).join("\n")}`;
  test("contrôle avant l'envoi : fichier vide, taille, 200 lignes au plus, au moins une ligne de données", () => {
    assert.deepEqual(checkImportText("titre\nA"), { ok: true });
    assert.deepEqual(checkImportText(rows(IMPORT_MAX_ROWS)), { ok: true });
    assert.equal(checkImportText(rows(IMPORT_MAX_ROWS + 1)).ok, false);
    assert.match((checkImportText(rows(201)) as { message: string }).message, /plus de 200 lignes/);
    assert.equal(checkImportText("").ok, false);
    assert.equal(checkImportText("   \n ").ok, false);
    assert.match((checkImportText("titre,prix") as { message: string }).message, /aucune ligne de données/);
    assert.match((checkImportText(`titre\n${"x".repeat(300_000)}`) as { message: string }).message, /256 Ko/);
    assert.equal(checkImportText("titre\r\nA\r\nB\r\n").ok, true, "fins de ligne Windows");
    assert.equal(checkImportText("titre\n\n\nA\n\n").ok, true, "lignes vides ignorées");
  });

  test("raisons de refus en mots simples (jamais le code, jamais une donnée du fichier) et résumé de l'aperçu, de l'application et du rejeu", () => {
    assert.equal(importRejectionText({ code: "invalid_field", field: "price" }), "Ligne refusée : le prix n'est pas valide.");
    assert.equal(importRejectionText({ code: "invalid_field", field: "category" }), "Ligne refusée : la catégorie n'est pas valide.");
    assert.equal(importRejectionText({ code: "invalid_field", field: "inconnu" }), "Ligne refusée : un champ n'est pas valide.");
    assert.match(importRejectionText({ code: "phone_number_in_offer", field: null }), /pas de numéro de téléphone/);
    assert.match(importRejectionText({ code: "offer_limit_reached", field: null }), /nombre maximal d'annonces en ligne/);
    assert.match(importRejectionText({ code: "too_many_columns", field: null }), /plus de cellules/);
    assert.equal(importRejectionText({ code: "autre", field: null }), "Ligne refusée.");
    const result = (overrides: Partial<CatalogImportResult>): CatalogImportResult => ({
      mode: "preview", alreadyApplied: false, rowCount: 3, acceptedCount: 2, rejectedCount: 1,
      rows: [
        { line: 2, outcome: "would_create", code: null, field: null, offerId: null },
        { line: 3, outcome: "rejected", code: "phone_number_in_offer", field: null, offerId: null },
        { line: 4, outcome: "would_create", code: null, field: null, offerId: null },
      ], ...overrides,
    });
    assert.deepEqual(importSummary(result({})), { title: "Aperçu : rien n'a encore été créé", detail: "2 annonces seraient créées et 1 ligne serait refusée.", replayed: false });
    assert.deepEqual(importSummary(result({ mode: "apply", acceptedCount: 1, rejectedCount: 2 })), { title: "Import terminé", detail: "1 annonce créée et 2 lignes refusées.", replayed: false });
    assert.equal(importSummary(result({ mode: "apply", acceptedCount: 0, rejectedCount: 3 })).title, "Aucune annonce créée");
    const replay = importSummary(result({ mode: "apply", alreadyApplied: true }));
    assert.equal(replay.title, "Ce fichier a déjà été importé");
    assert.equal(replay.replayed, true);
    assert.match(replay.detail, /Rien n'a été recréé/);
    assert.deepEqual(rejectedRows(result({})), [{ line: 3, ok: false, text: importRejectionText({ code: "phone_number_in_offer", field: null }) }]);
    assert.deepEqual(importRowView({ line: 2, outcome: "would_create", code: null, field: null, offerId: null }, "preview"), { line: 2, ok: true, text: "Sera créée et mise en ligne." });
    assert.deepEqual(importRowView({ line: 2, outcome: "created", code: null, field: null, offerId: null }, "apply"), { line: 2, ok: true, text: "Créée et mise en ligne." });
  });
});

describe("administration", () => {
  test("versions en lecture : prix, crédits, annonces, droits en clair ; abonnés « environ N »", () => {
    const rows = adminVersionRows([
      { version: 2, name: "Pro", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro", "catalog_import"], createdAt: NOW },
      { version: 1, name: "Gratuit", monthlyPriceXof: 0, promoCreditsXof: 0, maxOnlineOffers: 10, entitlements: [], createdAt: NOW },
    ] satisfies AdminPlansOverview["plans"][number]["versions"], "UTC");
    assert.equal(rows[0].priceText, "12 000 FCFA par mois");
    assert.equal(rows[0].promoText, "6 000 FCFA par mois");
    assert.equal(rows[0].offersText, "150 au plus");
    assert.equal(rows[0].rightsText, "Badge « Vendeur Pro » sur vos annonces, Import de catalogue par fichier CSV");
    assert.equal(rows[1].priceText, "Gratuit");
    assert.equal(rows[1].rightsText, "Aucun droit");
    assert.equal(rows[1].dateText, "06/10/2026");
    assert.equal(approximateText(5), "environ 5");
    assert.equal(approximateText(0), "moins de 5", "un arrondi nul n'est jamais présenté comme « environ 0 »");
    assert.equal(approximateText(25), "environ 25");
  });

  test("saisie d'une nouvelle version : bornes du serveur, erreurs par champ en français, droits copiés", () => {
    const ok = buildNewVersion({ name: " Pro v2 ", monthlyPriceXof: "12000", promoCreditsXof: "6000", maxOnlineOffers: "150", entitlements: ["badge_pro"] }, "pro");
    assert.deepEqual(ok, { ok: true, request: { name: "Pro v2", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro"] } });
    const bad = buildNewVersion({ name: "", monthlyPriceXof: "0", promoCreditsXof: "-1", maxOnlineOffers: "0", entitlements: [] }, "pro");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["maxOnlineOffers", "monthlyPriceXof", "name", "promoCreditsXof"]);
    assert.equal(buildNewVersion({ name: "x", monthlyPriceXof: "1.5", promoCreditsXof: "0", maxOnlineOffers: "1", entitlements: [] }, "pro").ok, false);
    assert.equal(buildNewVersion({ name: "x", monthlyPriceXof: "1000000001", promoCreditsXof: "0", maxOnlineOffers: "1", entitlements: [] }, "pro").ok, false);
    assert.equal(buildNewVersion({ name: "x", monthlyPriceXof: "1", promoCreditsXof: "0", maxOnlineOffers: "100001", entitlements: [] }, "pro").ok, false);
    // Plan Gratuit : ni prix, ni crédits, ni droit.
    assert.equal(buildNewVersion({ name: "Gratuit", monthlyPriceXof: "0", promoCreditsXof: "0", maxOnlineOffers: "12", entitlements: [] }, "free").ok, true);
    assert.equal(buildNewVersion({ name: "Gratuit", monthlyPriceXof: "100", promoCreditsXof: "0", maxOnlineOffers: "12", entitlements: [] }, "free").ok, false);
    assert.equal(buildNewVersion({ name: "Gratuit", monthlyPriceXof: "0", promoCreditsXof: "0", maxOnlineOffers: "12", entitlements: ["badge_pro"] }, "free").ok, false);
  });
});
