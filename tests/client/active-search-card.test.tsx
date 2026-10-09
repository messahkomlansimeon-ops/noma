import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveSearchCardView, type ActiveSearchCardViewProps } from "../../components/active-search-card";
import type { ActiveSearchState } from "../../lib/client/active-search-api";

/** Carte « Recherche active » (lot RA1), rendue sans navigateur : tous les états, règles dites avant l'achat, prix provisoire, confirmation, aucune donnée technique. */

const DEMAND_ID = "22222222-2222-4222-8222-222222222222";
const state = (overrides: Partial<ActiveSearchState> = {}): ActiveSearchState => ({
  priceProvisional: true, paidCreditsOnly: true, autoRenew: false, demandId: DEMAND_ID, demandStatus: "active", active: false, suspended: false, startsAt: null, endsAt: null, remainingDays: null, purchasedPeriods: 0,
  nextEndsAt: "2031-02-01T10:00:00.000Z", maxEndsAt: "2031-07-01T10:00:00.000Z", canPurchase: true, blockedReason: null, expiringSoon: false, priceXof: 2_000, durationDays: 30, balanceXof: 5_000,
  readAt: "2031-01-02T10:00:00.000Z", ...overrides,
});
const view = (overrides: Partial<ActiveSearchCardViewProps> = {}): string =>
  renderToStaticMarkup(
    <ActiveSearchCardView
      demandId={DEMAND_ID} state={state()} loadError={null} confirming={false} pending={false} actionError={null} done={null}
      onRetry={() => undefined} onBuy={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} {...overrides}
    />,
  );
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&nbsp;|[  ]/g, " ").replace(/\s+/g, " ").trim();

describe("option désactivée", () => {
  const html = view();

  test("titre, état « désactivée », bouton d'activation avec le prix et la durée, carte marquée inactive", () => {
    assert.match(html, /<section[^>]*data-testid="active-search-card"[^>]*data-tone="off"[^>]*data-active="false"/);
    assert.match(text(html), /Recherche active/);
    assert.match(html, /data-testid="active-search-headline"[^>]*>Recherche active : désactivée</);
    assert.match(html, /data-testid="active-search-buy"[^>]*>Activer — 2.000.FCFA pour 30 jours</);
  });

  test("les règles sont dites AVANT l'achat : crédits payés, aucun renouvellement, arrêt sans remboursement, aucun remboursement automatique ; le prix est dit provisoire", () => {
    const content = text(html);
    assert.match(content, /Elle se paie avec vos crédits, pas avec vos crédits promotionnels\./);
    assert.match(content, /Aucun renouvellement automatique : vous êtes prévenu 3 jours avant la fin/);
    assert.match(content, /Si le besoin est marqué satisfait, l'option est suspendue : rien n'est notifié, mais la période continue de courir, sans prolongation ni remboursement, et elle reprend si vous réactivez le besoin\./);
    assert.match(content, /Si le besoin est archivé, l'option s'arrête sans remboursement\./);
    assert.match(content, /jusqu'à toutes les heures au lieu de toutes les 6 heures/);
    assert.match(content, /Aucun remboursement automatique\./);
    assert.match(html, /data-testid="active-search-price-notice"[^>]*>Prix provisoire/);
    assert.match(content, /180 jours au lieu de 90/);
    assert.match(content, /jamais directement à l'annonce d'un autre site/);
  });

  test("aucune confirmation, aucun message tant qu'on n'a pas appuyé", () => {
    assert.equal(html.includes('data-testid="active-search-confirmation"'), false);
    assert.equal(html.includes('data-testid="active-search-done"'), false);
    assert.equal(html.includes('data-testid="active-search-action-error"'), false);
  });
});

describe("achat", () => {
  test("confirmation : le montant, la fin, le solde après ; boutons Confirmer et Annuler", () => {
    const html = view({ confirming: true });
    assert.match(html, /data-testid="active-search-confirmation"/);
    assert.match(text(html), /Activer la recherche active : 2 000 FCFA seront débités de vos crédits payés, jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\. Il vous restera 3 000 FCFA\./);
    assert.match(html, /data-testid="active-search-confirm"[^>]*>Confirmer l&#x27;achat</);
    assert.match(text(html), /Annuler/);
    assert.equal(html.includes('data-testid="active-search-buy"'), false, "le bouton d'achat cède la place à la confirmation");
  });

  test("achat en cours : le bouton de confirmation est désactivé et dit « Achat en cours… »", () => {
    const html = view({ confirming: true, pending: true });
    assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="active-search-confirm"|<button[^>]*data-testid="active-search-confirm"[^>]*disabled=""/);
    assert.match(text(html), /Achat en cours…/);
  });

  test("solde insuffisant : ce qu'il manque, le lien de recharge vers le porte-monnaie avec retour au besoin, bouton d'achat désactivé", () => {
    const html = view({ state: state({ balanceXof: 1_200 }) });
    assert.match(html, /data-testid="active-search-insufficient"/);
    assert.match(text(html), /Crédits payés insuffisants \(1 200 FCFA\)/);
    for (const vendorWord of ["Solde", "Porte-monnaie", "Achat de boost", "boost_purchase"]) assert.equal(text(html).includes(vendorWord), false, `la page d'un besoin ne dit jamais « ${vendorWord} » (e2e:ui)`);
    assert.match(text(html), /Il vous manque 800 FCFA\. Seuls vos crédits payés règlent la recherche active, pas les crédits promotionnels\./);
    assert.match(html, /<a[^>]*href="[^"]*recharger=1[^"]*"[^>]*data-testid="active-search-recharge"|<a[^>]*data-testid="active-search-recharge"[^>]*href="[^"]*recharger=1/);
    assert.match(html, new RegExp(`href="[^"]*next=%2Fbesoins%2F${DEMAND_ID}`));
    assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="active-search-buy"|<button[^>]*data-testid="active-search-buy"[^>]*disabled=""/);
  });

  test("message d'erreur de l'achat et message de réussite", () => {
    assert.match(view({ actionError: "Solde insuffisant : rechargez votre porte-monnaie." }), /role="alert"[^>]*data-testid="active-search-action-error"|data-testid="active-search-action-error"/);
    assert.match(text(view({ done: "Recherche active activée jusqu'au 01/02/2031." })), /Recherche active activée jusqu'au 01\/02\/2031\./);
  });
});

describe("option en vigueur, bloquée, fermée, chargement", () => {
  test("en vigueur : la date de fin et les jours restants, bouton « Prolonger de 30 jours »", () => {
    const html = view({ state: state({ active: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, purchasedPeriods: 1, nextEndsAt: "2031-03-03T10:00:00.000Z" }) });
    assert.match(html, /data-tone="active"[^>]*data-active="true"|data-active="true"/);
    assert.match(html, /data-testid="active-search-headline"[^>]*>Recherche active jusqu&#x27;au 01\/02\/2031</);
    assert.match(text(html), /Il reste 30 jours\./);
    assert.match(html, /data-testid="active-search-buy"[^>]*>Prolonger de 30 jours — 2.000.FCFA</);
  });

  test("180 jours atteints : explication, aucun bouton d'achat", () => {
    const html = view({ state: state({ active: true, endsAt: "2031-06-30T10:00:00.000Z", startsAt: "2031-01-02T10:00:00.000Z", remainingDays: 180, canPurchase: false, blockedReason: "max_horizon", nextEndsAt: null }) });
    assert.match(html, /data-testid="active-search-blocked"/);
    assert.match(text(html), /ne peut pas dépasser 180 jours à partir d'aujourd'hui/);
    assert.equal(html.includes('data-testid="active-search-buy"'), false);
  });

  test("besoin archivé ou brouillon : la carte disparaît", () => {
    assert.equal(view({ state: state({ demandStatus: "archived", canPurchase: false, blockedReason: "demand_not_active", nextEndsAt: null }) }), "");
  });

  test("A4 : besoin satisfait avec une période qui court → carte « suspendue » (fin connue, explication, aucun avantage ni prix ni bouton d'achat)", () => {
    const html = view({ state: state({ demandStatus: "satisfied", suspended: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, canPurchase: false, blockedReason: "demand_not_active", nextEndsAt: null }) });
    assert.match(html, /data-tone="paused"[^>]*data-active="false"|data-active="false"[^>]*data-tone="paused"|data-testid="active-search-card"/);
    assert.match(html, /data-tone="paused"/);
    assert.match(html, /data-testid="active-search-headline"[^>]*>Recherche active suspendue jusqu&#x27;au 01\/02\/2031</);
    assert.match(text(html), /La période continue de courir ; si vous réactivez le besoin, la recherche active reprend\./);
    for (const testid of ["active-search-buy", "active-search-confirmation", "active-search-benefits", "active-search-price-notice", "active-search-blocked", "active-search-insufficient"]) {
      assert.equal(html.includes(`data-testid="${testid}"`), false, testid);
    }
  });

  test("B1 : sans clé produit → « Option indisponible pour ce besoin », sans bouton d'achat ni avantages ni prix", () => {
    const html = view({ state: state({ canPurchase: false, blockedReason: "no_product_key", nextEndsAt: null }) });
    assert.match(html, /data-tone="unavailable"/);
    assert.match(html, /data-testid="active-search-headline"[^>]*>Option indisponible pour ce besoin</);
    assert.match(text(html), /il faut au moins une catégorie, une marque et un modèle/);
    for (const testid of ["active-search-buy", "active-search-confirmation", "active-search-benefits", "active-search-price-notice", "active-search-insufficient"]) assert.equal(html.includes(`data-testid="${testid}"`), false, testid);
  });

  test("B1 : collecte indisponible → « pas encore disponible », sans bouton d'achat ; même avec un solde suffisant et la confirmation demandée, rien ne s'achète", () => {
    for (const confirming of [false, true]) {
      const html = view({ confirming, state: state({ canPurchase: false, blockedReason: "unavailable", nextEndsAt: null, balanceXof: 50_000 }) });
      assert.match(html, /data-tone="unavailable"/);
      assert.match(html, /data-testid="active-search-headline"[^>]*>Recherche active : pas encore disponible</);
      assert.match(text(html), /aucune annonce d&#x27;un autre site n&#x27;est collectée pour le moment|aucune annonce d'un autre site n'est collectée pour le moment/);
      for (const testid of ["active-search-buy", "active-search-confirmation", "active-search-confirm"]) assert.equal(html.includes(`data-testid="${testid}"`), false, testid);
    }
  });

  test("A5 : capacité atteinte → l'option reste présentée, le texte dit que la collecte accélérée est complète, aucun bouton d'achat", () => {
    const html = view({ state: state({ canPurchase: false, blockedReason: "capacity", nextEndsAt: null }) });
    assert.match(html, /data-testid="active-search-blocked"/);
    assert.match(text(html), /La collecte accélérée est complète pour le moment : réessayez plus tard\./);
    assert.equal(html.includes('data-testid="active-search-buy"'), false);
  });

  test("chargement : note discrète ; échec : message et bouton « Réessayer », jamais de détail technique", () => {
    assert.match(view({ state: null }), /aria-busy="true"/);
    const failure = view({ state: null, loadError: "Une erreur est survenue. Réessayez dans un instant." });
    assert.match(failure, /role="alert"[^>]*data-testid="active-search-error"|data-testid="active-search-error"/);
    assert.match(text(failure), /Réessayer/);
  });

  test("aucun identifiant, code technique ou valeur technique dans le texte affiché (états : désactivée, en vigueur, confirmation, solde insuffisant)", () => {
    const states = [
      view(), view({ confirming: true }), view({ state: state({ balanceXof: 0 }) }),
      view({ state: state({ active: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, nextEndsAt: "2031-03-03T10:00:00.000Z" }) }),
    ];
    for (const html of states) {
      const content = text(html);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(content), false, "aucun UUID affiché");
      assert.equal(/\b[a-z]+(?:_[a-z0-9]+)+\b|undefined|NaN|\[object|null/.test(content), false, content);
    }
  });
});

describe("A6 : la carte envoie le prix qu'elle AFFICHE", () => {
  const source = readFileSync(join(import.meta.dirname, "../../components/active-search-card.tsx"), "utf8").replace(/\/\/.*$/gm, "");

  test("l'achat envoie le prix de l'état affiché ; tout refus 409 (dont price_changed) ferme la confirmation et relit l'état", () => {
    assert.match(source, /const displayedPriceXof = state\.priceXof;/);
    assert.match(source, /activeSearchApi\.purchase\(demandId, key, displayedPriceXof\)/);
    assert.match(source, /failure\.status === 409\) \{\s*keys\.current\.forget\(demandId\);\s*setConfirming\(false\);\s*setReloadKey/);
  });

  test("la carte est montée pour un besoin actif ET satisfait (option suspendue visible), jamais pour un autre statut", () => {
    const page = readFileSync(join(import.meta.dirname, '../../app/(buyer)/besoins/[id]/page.tsx'), "utf8").replace(/\/\/.*$/gm, "");
    assert.match(page, /demand\.status === "active" \|\| demand\.status === "satisfied" \? <ActiveSearchCard/);
  });
});
