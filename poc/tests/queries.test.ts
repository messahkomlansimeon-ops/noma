import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import {
  coinAfriqueQuery,
  facebookQuery,
  locantoQuery,
  googleQuery,
} from "../lib/query";

describe("requêtes dynamiques — aucun besoin codé en dur", () => {
  const iphone = parseNeed("iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA");
  const canape = parseNeed("canapé à Cocody");
  const plombier = parseNeed("plombier à Bouaké");

  test("trois besoins → trois requêtes distinctes par connecteur", () => {
    const urls = [iphone, canape, plombier].map(coinAfriqueQuery).map((q) => q.url);
    assert.equal(new Set(urls).size, 3, "URLs CoinAfrique distinctes");
    assert.ok(urls[0].includes("iphone"), "requête iPhone");
    assert.ok(urls[1].includes("canape"), "requête canapé (accents normalisés)");
    assert.ok(urls[2].includes("plombier"), "requête plombier");
  });

  test("aucun retour silencieux au besoin de démonstration", () => {
    for (const need of [canape, plombier]) {
      for (const build of [coinAfriqueQuery, locantoQuery, googleQuery]) {
        const q = build(need);
        assert.ok(!q.query.includes("iphone"), `« ${q.query} » ne doit pas parler d'iPhone`);
      }
    }
  });

  test("encodage URL correct (espaces, accents)", () => {
    const q = coinAfriqueQuery(canape);
    const u = new URL(q.url);
    assert.equal(u.searchParams.get("keyword"), "canape", "URLSearchParams décode correctement");
    assert.ok(!q.url.includes("é"), "accents encodés");
  });

  test("Facebook : ville dans le slug, zone dans la requête seulement si gérée", () => {
    const q = facebookQuery(plombier);
    assert.ok(q.url.includes("/marketplace/bouake/search"), "slug bouake");
    const qAbj = facebookQuery(canape);
    assert.ok(qAbj.url.includes("/marketplace/abidjan/search"), "cocody → slug abidjan");
  });

  test("capacités déclarées et critères non pris en charge signalés", () => {
    const coin = coinAfriqueQuery(plombier);
    assert.ok(coin.warnings.some((w) => w.includes("service")), "service non géré par CoinAfrique signalé");
    assert.ok(coin.warnings.some((w) => w.includes("bouake") || w.includes("Bouaké") || w.includes("zone")), "zone non filtrée signalée");
    const fb = facebookQuery(plombier);
    assert.ok(fb.warnings.some((w) => w.includes("service")), "service non géré par FB signalé");
    const loc = locantoQuery(plombier);
    assert.equal(loc.capabilities.services, true, "Locanto gère les services");
    assert.equal(loc.warnings.length, 0, "aucun critère non pris en charge pour Locanto");
  });

  test("budget jamais envoyé dans la requête produit", () => {
    const q = coinAfriqueQuery(iphone);
    assert.ok(!q.query.includes("150"), "le budget reste côté filtrage");
    assert.ok(!q.query.includes("fcfa"));
  });

  test("google : requête ciblée Côte d'Ivoire", () => {
    const q = googleQuery(iphone);
    assert.ok(q.query.includes("côte d'ivoire"));
    assert.ok(q.query.includes("annonce"));
  });
});