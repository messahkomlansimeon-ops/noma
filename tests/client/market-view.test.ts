import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkline } from "../../components/market/sparkline";
import type { MarketListings, MarketStats, MarketTrendPoint } from "../../lib/client/market-api";
import {
  MARKET_CARD_TITLE,
  MARKET_INSUFFICIENT_TEXT,
  adminMarketRows,
  listingsView,
  marketCardView,
  marketHintText,
  marketQueryFromForm,
  marketQueryFromProduct,
  periodShortText,
  periodText,
  sparklineGeometry,
  trendSummary,
} from "../../lib/client/market-view";

/**
 * Présentation des prix demandés dans les annonces (lots H1, H1-bis et H1-ter) : textes honnêtes (« Prix demandés dans les annonces », jamais « prix du marché » seul, jamais un prix de vente),
 * effectifs arrondis (annonces ET vendeurs), fourchette seulement à partir de 10 vendeurs, comparabilité toujours dite, mini-courbe SVG calculée à la main, requêtes déduites d'une fiche ou d'un formulaire.
 */

const ROOT = join(import.meta.dirname, "../..");
const NBSP = (text: string) => text.replace(/[  ]/g, " ");
const published = (overrides: Partial<Extract<MarketListings, { status: "published" }>> = {}): MarketListings => ({
  status: "published",
  comparedTo: { scope: "exact", text: "Comparé à : iPhone 12 128 Go, Occasion" },
  count: { kind: "approx", value: 15 },
  sellers: { kind: "approx", value: 10 },
  excluded: null,
  median: 160_000,
  range: { q1: 152_000, q3: 176_000 },
  trend: [{ from: "2026-09-10", median: 150_000 }, { from: "2026-09-17", median: 160_000 }, { from: "2026-09-24", median: null }, { from: "2026-10-01", median: 170_000 }],
  ...overrides,
});
const stats = (overrides: Partial<MarketStats> = {}): MarketStats => ({ period: { days: 90, from: "2026-07-10", to: "2026-10-07" }, listings: published(), ...overrides });

describe("requêtes", () => {
  test("une fiche donne sa requête ; sans catégorie, marque ou modèle : aucune (pas de marché)", () => {
    const product = { category: "Téléphones", brand: " Apple ", model: "iPhone 12", variant: "128 Go", condition: "Occasion" };
    assert.deepEqual(marketQueryFromProduct(product), { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion" });
    assert.deepEqual(marketQueryFromProduct({ ...product, variant: null, condition: "" }, 30), { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: null, periodDays: 30 });
    for (const empty of [{ category: null }, { brand: null }, { model: "  " }, { model: "x".repeat(81) }]) assert.equal(marketQueryFromProduct({ ...product, ...empty }), null);
  });

  test("un formulaire donne sa requête quand catégorie, marque et modèle sont remplis ; 90 jours ; l'état non choisi reste absent (« confondus »)", () => {
    assert.equal(marketQueryFromForm({ category: null, brand: "Apple", model: "iPhone 12", variant: "", condition: "Occasion" }), null);
    assert.equal(marketQueryFromForm({ category: "Téléphones", brand: "", model: "iPhone 12", variant: "", condition: "Occasion" }), null);
    assert.deepEqual(marketQueryFromForm({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "", condition: "Occasion" }), {
      category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: "Occasion", periodDays: 90,
    });
    assert.equal(marketQueryFromForm({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "", condition: null })?.condition, null);
  });
});

describe("textes honnêtes", () => {
  test("périodes en mots simples", () => {
    assert.equal(periodText(30), "Sur les 30 derniers jours");
    assert.equal(periodText(90), "Sur les 90 derniers jours");
    assert.equal(periodText(365), "Sur la dernière année");
    assert.equal(periodShortText(90), "90 jours");
    assert.equal(periodShortText(365), "1 an");
  });

  test("annonces publiées : médiane, « la moitié des prix demandés est entre … », effectif ARRONDI, comparabilité", () => {
    const view = listingsView(published());
    assert.equal(view.published, true);
    assert.equal(NBSP(view.headline as string), "160 000 FCFA");
    assert.equal(NBSP(view.range as string), "La moitié des prix demandés est entre 152 000 FCFA et 176 000 FCFA");
    assert.equal(view.rangeNote, null);
    assert.equal(view.countText, "environ 15 annonces d'environ 10 vendeurs");
    assert.equal(view.excludedText, null);
    assert.equal(view.comparedTo, "Comparé à : iPhone 12 128 Go, Occasion");
    assert.equal(view.widened, false);
    assert.equal(view.insufficient, null);
  });

  test("moins de 10 vendeurs : la médiane seule, et le dit ; annonces aux prix atypiques écartées : arrondies, jamais un compte exact", () => {
    const view = listingsView(published({ range: null, excluded: { kind: "below", bound: 5 } }));
    assert.equal(view.range, null);
    assert.equal(view.rangeNote, "Fourchette non affichée : il faut au moins 10 vendeurs.");
    assert.equal(view.excludedText, "moins de 5 annonces aux prix atypiques écartées");
    assert.equal(listingsView(published({ excluded: { kind: "approx", value: 10 } })).excludedText, "environ 10 annonces aux prix atypiques écartées");
    assert.equal(listingsView(published({ count: { kind: "approx", value: 5 }, sellers: { kind: "approx", value: 5 } })).countText, "environ 5 annonces d'environ 5 vendeurs");
    assert.equal(listingsView(published({ count: { kind: "approx", value: 90 }, sellers: { kind: "approx", value: 10 } })).countText, "environ 90 annonces d'environ 10 vendeurs", "beaucoup d'annonces de peu de vendeurs : les deux effectifs sont dits");
    assert.equal(listingsView(published({ sellers: { kind: "below", bound: 5 } })).countText, "environ 15 annonces de moins de 5 vendeurs");
  });

  test("comparaison élargie : signalée (widened) avec la phrase du serveur", () => {
    const view = listingsView(published({ comparedTo: { scope: "any_condition", text: "Comparé à : iPhone 12, toutes variantes et tous états confondus" } }));
    assert.equal(view.widened, true);
    assert.equal(view.comparedTo, "Comparé à : iPhone 12, toutes variantes et tous états confondus");
  });

  test("sous les seuils : « Pas assez de données », aucun chiffre", () => {
    const view = listingsView({ status: "insufficient" });
    assert.deepEqual([view.published, view.headline, view.range, view.rangeNote, view.countText, view.excludedText, view.comparedTo, view.insufficient], [false, null, null, null, null, null, null, MARKET_INSUFFICIENT_TEXT]);
    assert.equal(MARKET_INSUFFICIENT_TEXT, "Pas assez de données");
  });

  test("encart : « Prix demandés dans les annonces » (jamais « prix du marché » seul), prix DEMANDÉS dits, phrase exacte sur ce que contiennent les chiffres ; AUCUNE ligne de ventes", () => {
    const card = marketCardView(stats());
    assert.equal(MARKET_CARD_TITLE, "Prix demandés dans les annonces");
    assert.equal(card.title, "Prix demandés dans les annonces");
    assert.equal(card.periodText, "Sur les 90 derniers jours");
    assert.equal(card.empty, false);
    assert.equal(card.askingNote, "Ce sont des prix demandés par les vendeurs, pas des prix payés.");
    assert.equal(card.note, "Calculé sur au moins 5 vendeurs différents, une seule valeur par vendeur (la médiane de ses annonces), prix atypiques écartés, chiffres arrondis (prix à 500 FCFA, effectifs à 5 près).");
    assert.deepEqual(Object.keys(card).sort(), ["askingNote", "empty", "listings", "note", "periodText", "title"], "aucune clé `sales`");
    const everything = JSON.stringify(card);
    assert.ok(!/prix du marché/i.test(everything), "jamais « prix du marché »");
    assert.ok(!/par annonce/i.test(everything), "plus de « une seule valeur par annonce » : l'unité est le vendeur");
    assert.ok(!/vente|sales/i.test(everything), "aucune vente dans l'encart");
    assert.ok(!/Aucune annonce ni vente n'est montrée/.test(everything), "l'ancienne phrase inexacte n'existe plus");
    assert.equal(marketCardView(stats({ listings: { status: "insufficient" } })).empty, true);
  });

  test("le code des écrans ne parle ni de « Ventes confirmées » ni de « prix du marché » (hors administration) : lecture des sources", () => {
    const files = [
      ...readdirSync(join(ROOT, "components/market")).map((name) => `components/market/${name}`),
      "components/vendor/nouvelle-annonce-form.tsx",
      "app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      assert.ok(!/Ventes? confirmées?/i.test(source), `${file} : pas de « ventes confirmées »`);
      assert.ok(!/market-sales/.test(source), `${file} : pas d'élément de ventes`);
      assert.ok(!/["'`>]Prix du marché/.test(source), `${file} : pas de titre « Prix du marché »`);
    }
    const view = readFileSync(join(ROOT, "lib/client/market-view.ts"), "utf8");
    assert.ok(!/["'`]Prix du marché/.test(view));
  });

  test("indication du formulaire : « Prix demandés dans les annonces pour ce produit : médiane X (environ N annonces d'environ M vendeurs, 90 jours). Comparé à : … » ; « tous états confondus » dit quand l'état n'est pas choisi ; rien sous les seuils", () => {
    assert.equal(NBSP(marketHintText(stats()) as string), "Prix demandés dans les annonces pour ce produit : médiane 160 000 FCFA (environ 15 annonces d'environ 10 vendeurs, 90 jours). Comparé à : iPhone 12 128 Go, Occasion.");
    const open = stats({ listings: published({ comparedTo: { scope: "exact", text: "Comparé à : iPhone 12 128 Go, tous états confondus" } }) });
    assert.match(marketHintText(open) as string, /tous états confondus\.$/);
    const widened = stats({ listings: published({ comparedTo: { scope: "any_variant", text: "Comparé à : iPhone 12, Occasion, toutes variantes confondues" } }), period: { days: 365, from: "2025-10-08", to: "2026-10-07" } });
    assert.equal(NBSP(marketHintText(widened) as string), "Prix demandés dans les annonces pour ce produit : médiane 160 000 FCFA (environ 15 annonces d'environ 10 vendeurs, 1 an). Comparé à : iPhone 12, Occasion, toutes variantes confondues.");
    assert.equal(marketHintText(stats({ listings: { status: "insufficient" } })), null);
    assert.ok(!/prix du marché/i.test(marketHintText(stats()) as string));
  });

  test("tableau d'administration : prix demandés et NOMBRE arrondi de ventes confirmées (jamais un prix)", () => {
    const rows = adminMarketRows([
      { label: "Apple iPhone 12 · 128 Go · Occasion", listings: published(), confirmedSales: { kind: "approx", value: 15 } },
      { label: "Apple iPhone 13", listings: { status: "insufficient" }, confirmedSales: { kind: "below", bound: 5 } },
    ]);
    assert.equal(rows[0].label, "Apple iPhone 12 · 128 Go · Occasion");
    assert.equal(rows[0].listings.published, true);
    assert.equal(rows[0].salesText, "environ 15 ventes confirmées");
    assert.equal(rows[1].salesText, "moins de 5 ventes confirmées");
    assert.equal(rows[1].listings.published, false);
    assert.ok(rows.every((row) => row.key.length > 0 && !/FCFA/.test(row.salesText)), "aucun prix dans la colonne des ventes");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["key", "label", "listings", "salesText"]);
  });
});

describe("mini-courbe", () => {
  const trend = (...values: Array<number | null>): MarketTrendPoint[] => values.map((median, index) => ({ from: `2026-09-${String(10 + index).padStart(2, "0")}`, median }));

  test("géométrie exacte : abscisses réparties, plus petite médiane en bas, plus grande en haut, 4 de marge", () => {
    const geometry = sparklineGeometry(trend(100_000, 150_000, 200_000), 100, 50, 4);
    // x : 4, 50, 96 ; y : de 46 (minimum) à 4 (maximum) ; milieu à 25.
    assert.deepEqual(geometry.points, [{ x: 4, y: 46 }, { x: 50, y: 25 }, { x: 96, y: 4 }]);
    assert.deepEqual(geometry.paths, ["M 4 46 L 50 25 L 96 4"]);
    assert.equal(geometry.known, 3);
  });

  test("un bloc sans médiane coupe le tracé en deux ; un point isolé reste un point", () => {
    const geometry = sparklineGeometry(trend(100_000, 120_000, null, 140_000, null, 160_000), 100, 50, 4);
    // x : 4, 22.4, 59.2, 96 ; y : 46, 32, 18, 4 ; les blocs sans médiane (rangs 2 et 4) coupent le tracé.
    assert.deepEqual(geometry.paths, ["M 4 46 L 22.4 32", "M 59.2 18", "M 96 4"]);
    assert.equal(geometry.points.length, 4);
    assert.equal(geometry.known, 4);
  });

  test("toutes les médianes égales : une ligne à mi-hauteur ; moins de deux médianes ou dimensions trop petites : aucun tracé", () => {
    assert.deepEqual(sparklineGeometry(trend(150_000, 150_000, 150_000), 100, 50).points.map((point) => point.y), [25, 25, 25]);
    for (const empty of [trend(), trend(100_000), trend(100_000, null), trend(null, null, null)]) assert.deepEqual(sparklineGeometry(empty, 100, 50).paths, []);
    assert.deepEqual(sparklineGeometry(trend(1, 2), 8, 50, 4).paths, []);
    assert.deepEqual(sparklineGeometry(trend(1, 2), 100, 8, 4).paths, []);
  });

  test("tendance dite en mots : hausse, baisse, stable ; rien sans deux médianes", () => {
    assert.match(NBSP(trendSummary(trend(150_000, null, 170_000)) as string), /^Tendance en hausse : de 150 000 FCFA à 170 000 FCFA/);
    assert.match(trendSummary(trend(170_000, 150_000)) as string, /en baisse/);
    assert.match(trendSummary(trend(150_000, 150_000)) as string, /stable/);
    assert.equal(trendSummary(trend(150_000, null)), null);
  });

  test("le composant SVG : un tracé et des points, un texte alternatif ; rien sans courbe", () => {
    const html = renderToStaticMarkup(Sparkline({ trend: trend(100_000, 150_000, 200_000), label: "Tendance en hausse", testId: "t" }));
    assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Tendance en hausse"/);
    assert.match(html, /<path d="M 4 /);
    assert.equal((html.match(/<circle/g) ?? []).length, 3);
    assert.match(html, /data-points="3"/);
    assert.equal(renderToStaticMarkup(Sparkline({ trend: trend(100_000), label: "x" })), "");
    assert.ok(!/<script|dangerouslySetInnerHTML|<foreignObject/i.test(html));
  });
});
