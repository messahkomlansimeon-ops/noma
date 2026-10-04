import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dedupListings, canonicalUrl } from "../lib/dedup";
import type { RawListing } from "../lib/normalize";

const listing = (over: Partial<RawListing>): RawListing => ({
  id: "x",
  source: "coinafrique",
  title: "iPhone 12 - 128Gb",
  price: 135000,
  currency: "FCFA",
  zone: "Cocody",
  vendor: null,
  url: null,
  photo: null,
  date: null,
  description: null,
  ...over,
});

describe("canonicalUrl", () => {
  test("paramètres de suivi retirés", () => {
    const c = canonicalUrl(
      "https://www.coinafrique.com/annonce/a-1?utm_source=x&fbclid=y",
    );
    assert.equal(c, "https://coinafrique.com/annonce/a-1");
  });

  test("paramètres identifiants conservés : ad?id=1 ≠ ad?id=2", () => {
    const a = canonicalUrl("https://site.com/list?ad?id=1&utm_source=x");
    const b = canonicalUrl("https://site.com/list?ad?id=2&utm_source=x");
    assert.notEqual(a, b);
  });

  test("www et hash normalisés", () => {
    assert.equal(
      canonicalUrl("http://www.site.com/a#section"),
      "https://site.com/a",
    );
  });
});

describe("dedupListings — fusion par identité uniquement", () => {
  test("deux vendeurs, même produit même prix → deux offres distinctes", () => {
    const r = dedupListings([
      listing({ id: "v1", source: "coinafrique", vendor: "Marcory Mobile" }),
      listing({ id: "v2", source: "facebook", vendor: "Cocody Phones" }),
    ]);
    assert.equal(r.kept.length, 2, "aucune suppression sur similarité");
    assert.equal(r.possibleDuplicates.length, 1, "ressemblance inter-sources → groupe possible (sans suppression)");
  });

  test("même annonce avec paramètre de suivi → fusionnée", () => {
    const r = dedupListings([
      listing({ id: "c1", url: "https://ci.coinafrique.com/annonce/x-42?utm_source=wa" }),
      listing({ id: "c2", url: "https://ci.coinafrique.com/annonce/x-42" }),
    ]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.exactDuplicates, 1);
    assert.deepEqual(r.mergedFrom["c1"], ["c2"]);
  });

  test("ad?id=1 et ad?id=2 restent distincts", () => {
    const r = dedupListings([
      listing({ id: "a1", url: "https://site.com/list?ad?id=1" }),
      listing({ id: "a2", url: "https://site.com/list?ad?id=2" }),
    ]);
    assert.equal(r.kept.length, 2);
  });

  test("fusion certaine : provenances et infos complétées", () => {
    const r = dedupListings([
      listing({ id: "m1", url: "https://ci.coinafrique.com/annonce/x-9", photo: null, zone: null, date: null }),
      listing({ id: "m2", url: "https://ci.coinafrique.com/annonce/x-9?ref=wa", photo: "https://img.co/x.jpg", zone: "Marcory", date: "il y a 1 h" }),
    ]);
    assert.equal(r.kept.length, 1);
    const k = r.kept[0];
    assert.equal(k.photo, "https://img.co/x.jpg", "photo complétée depuis le doublon");
    assert.equal(k.zone, "Marcory");
    assert.equal(k.date, "il y a 1 h");
  });

  test("titres similaires entre sources → groupe de doublons POSSIBLE, pas de suppression", () => {
    const r = dedupListings([
      listing({ id: "s1", source: "coinafrique", title: "iPhone 12 - 128Gb 135 000 FCFA", zone: "Cocody" }),
      listing({ id: "s2", source: "facebook", title: "iPhone 12 128Gb 135 000 FCFA", zone: "Cocody" }),
    ]);
    assert.equal(r.kept.length, 2, "aucune suppression par similarité");
    assert.equal(r.possibleDuplicates.length, 1);
    assert.deepEqual(r.possibleDuplicates[0].sources, ["coinafrique", "facebook"]);
  });

  test("annonces réellement différentes → pas de groupe", () => {
    const r = dedupListings([
      listing({ id: "d1", title: "iPhone 12 - 128Gb", zone: "Cocody" }),
      listing({ id: "d2", source: "facebook", title: "Canapé 3 places", zone: "Cocody" }),
    ]);
    assert.equal(r.kept.length, 2);
    assert.equal(r.possibleDuplicates.length, 0);
  });
});