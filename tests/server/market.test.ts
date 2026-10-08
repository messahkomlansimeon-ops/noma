import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MARKET_MIN_SELLERS, MARKET_RANGE_MIN_SELLERS, MARKET_TREND_MIN_SELLERS } from "../../lib/server/market/config";
import { createMarketRateLimiter } from "../../lib/server/market/rate-limit";
import {
  addDays,
  comparisonLevels,
  comparisonText,
  computeMarketStats,
  discardOutliers,
  isUtcDay,
  lastPerListing,
  meetsThresholds,
  relativeRound,
  roundPriceXof,
  sellerValues,
  type MarketObservation,
  type MarketRequest,
  type PublishedListings,
} from "../../lib/server/market/stats";

/**
 * Prix demandés dans les annonces (lots H1, H1-bis et H1-ter), fonctions pures : arrondi à 500 FCFA et arrondi RELATIF de la fourchette, niveaux et phrases de comparabilité, seuils
 * sur les VENDEURS distincts (5 pour la médiane, 10 pour la fourchette, 20 pour un point de tendance), APRÈS le retrait des prix atypiques, UNE valeur par vendeur (la médiane de ses
 * annonces : un vendeur ne pèse jamais plus qu'une valeur, quel que soit son nombre d'annonces), prix atypiques écartés, fenêtres de période, tendance, forme de la sortie (aucun prix
 * de vente, aucun identifiant), limite de débit. Les valeurs attendues sont calculées ici à la main, sans réutiliser le code testé.
 */

const TODAY = "2026-10-07";
let sequence = 0;

function row(overrides: Partial<MarketObservation> & Pick<MarketObservation, "priceXof">): MarketObservation {
  sequence += 1;
  return { referenceId: `ref-${sequence}`, sellerId: `seller-${sequence}`, day: TODAY, variantKey: "128 go", conditionKey: "occasion", ...overrides };
}

/** Une annonce par prix, vendeurs répartis entre `sellers` comptes (par défaut un vendeur par annonce), un relevé le jour demandé. */
function listings(prices: readonly number[], options: { sellers?: number; day?: string; prefix?: string; variantKey?: string; conditionKey?: string } = {}): MarketObservation[] {
  sequence += 1;
  const prefix = options.prefix ?? `L${sequence}`;
  return prices.map((priceXof, index) =>
    row({
      priceXof, referenceId: `${prefix}-${index}`, sellerId: `${prefix}-S${index % (options.sellers ?? prices.length)}`, day: options.day ?? TODAY,
      variantKey: options.variantKey ?? "128 go", conditionKey: options.conditionKey ?? "occasion",
    }),
  );
}

const request = (overrides: Partial<MarketRequest> = {}): MarketRequest => ({
  periodDays: 30,
  today: TODAY,
  variantKey: "128 go",
  conditionKey: "occasion",
  display: { model: "iPhone 12", variant: "128 Go", condition: "Occasion" },
  ...overrides,
});

const published = (rows: readonly MarketObservation[], overrides: Partial<MarketRequest> = {}): PublishedListings => {
  const outcome = computeMarketStats(rows, request(overrides)).listings;
  assert.equal(outcome.status, "published", JSON.stringify(outcome));
  return outcome as PublishedListings;
};

const insufficient = (rows: readonly MarketObservation[], overrides: Partial<MarketRequest> = {}): boolean => computeMarketStats(rows, request(overrides)).listings.status === "insufficient";

/** Les valeurs par vendeur d'un jeu de relevés (le dernier relevé de chaque annonce, puis une valeur par vendeur). */
const valuesOf = (rows: readonly MarketObservation[]) => sellerValues(lastPerListing(rows));

/** Arrondi à 500 écrit ici à la main (la moitié vers le haut), pour ne pas réutiliser le code testé. */
const round500 = (value: number): number => Math.floor((value + 250) / 500) * 500;

describe("arrondis : 500 FCFA pour les prix, relatif (5 % de la médiane) pour la fourchette", () => {
  test("le multiple de 500 le plus proche, la moitié vers le haut", () => {
    const cases: Array<[number, number]> = [
      [0, 0], [1, 0], [249, 0], [250, 500], [251, 500], [499, 500], [500, 500], [749, 500], [750, 1000],
      [149_900, 150_000], [160_249, 160_000], [160_250, 160_500], [162_500, 162_500], [165_749, 165_500], [165_750, 166_000], [99_999_999, 100_000_000],
      [151_250, 151_500], [151_125, 151_000], [151_375, 151_500],
    ];
    for (const [value, expected] of cases) assert.equal(roundPriceXof(value), expected, String(value));
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => roundPriceXof(bad), RangeError);
  });

  test("relativeRound : le multiple de 5 % de la médiane le plus proche, du bon côté de la médiane, la moitié vers le haut (en pas)", () => {
    // médiane 160 000 : un pas de 5 % vaut 8 000.
    for (const [quartile, expected] of [
      [151_250, 152_000], [144_000, 144_000], [140_000, 136_000], [156_000, 152_000], [157_000, 160_000], [175_000, 176_000], [164_000, 168_000], [163_999, 160_000], [160_000, 160_000],
    ] as Array<[number, number]>) {
      assert.equal(relativeRound(160_000, quartile), expected, String(quartile));
    }
    // médiane 162 500 : un pas de 8 125.
    assert.equal(relativeRound(162_500, 154_375), 154_375);
    assert.equal(relativeRound(162_500, 170_000), 170_625);
    // médiane nulle : pas de fourchette possible.
    assert.equal(relativeRound(0, 1_000), 0);
  });
});

describe("jours UTC", () => {
  test("validation stricte et décalage (mois, années bissextiles)", () => {
    assert.equal(isUtcDay("2026-10-07"), true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "20261007", "", "2026-10-07T00:00:00Z", 20261007, null]) assert.equal(isUtcDay(bad), false, String(bad));
    assert.equal(addDays("2026-10-07", -29), "2026-09-08");
    assert.equal(addDays("2024-03-01", -1), "2024-02-29");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.throws(() => addDays("2026-02-30", 1), RangeError);
  });
});

describe("niveaux et phrases de comparabilité (toujours dites)", () => {
  test("clé exacte d'abord, puis sans la variante, puis sans l'état ; un cran n'existe que si la partie était demandée", () => {
    const names = (variant: string | null, condition: string | null, widening = true) => comparisonLevels(variant, condition, widening).map((level) => [level.scope, level.variantKey, level.conditionKey]);
    assert.deepEqual(names("128 go", "occasion"), [["exact", "128 go", "occasion"], ["any_variant", null, "occasion"], ["any_variant_and_condition", null, null]]);
    assert.deepEqual(names(null, "occasion"), [["exact", null, "occasion"], ["any_condition", null, null]]);
    assert.deepEqual(names("128 go", null), [["exact", "128 go", null], ["any_variant", null, null]]);
    assert.deepEqual(names(null, null), [["exact", null, null]]);
    assert.deepEqual(names("128 go", "occasion", false), [["exact", "128 go", "occasion"]], "sans élargissement : la clé exacte seule");
  });

  test("la phrase DIT contre quoi on compare, y compris ce qui n'a jamais été précisé (« tous états confondus »)", () => {
    const display: MarketRequest["display"] = { model: "iPhone 12", variant: "128 Go", condition: "Occasion" };
    const text = (variantKey: string | null, conditionKey: string | null, shown = display) => comparisonText({ scope: "exact", variantKey, conditionKey }, shown);
    assert.equal(text("128 go", "occasion"), "Comparé à : iPhone 12 128 Go, Occasion");
    assert.equal(text(null, "occasion"), "Comparé à : iPhone 12, Occasion, toutes variantes confondues");
    assert.equal(text(null, null), "Comparé à : iPhone 12, toutes variantes et tous états confondus");
    assert.equal(text("128 go", null), "Comparé à : iPhone 12 128 Go, tous états confondus");
    assert.equal(text(null, null, { model: "iPhone 12", variant: null, condition: null }), "Comparé à : iPhone 12, toutes variantes et tous états confondus");
  });
});

describe("seuils de confidentialité : 5 VENDEURS distincts, APRÈS le retrait des prix atypiques", () => {
  test("constantes : médiane à partir de 5 vendeurs, fourchette à partir de 10, un point de tendance à partir de 20", () => {
    assert.equal(MARKET_MIN_SELLERS, 5);
    assert.equal(MARKET_RANGE_MIN_SELLERS, 10);
    assert.equal(MARKET_TREND_MIN_SELLERS, 20);
  });

  test("4 vendeurs (quel que soit le nombre de leurs annonces) : « pas assez de données » ; 5 vendeurs : publié (frontières exactes)", () => {
    const prices = [150_000, 152_000, 154_000, 156_000, 158_000];
    assert.equal(meetsThresholds(valuesOf(listings(prices.slice(0, 4)))), false, "4 annonces de 4 vendeurs");
    assert.equal(meetsThresholds(valuesOf(listings(prices, { sellers: 4 }))), false, "5 annonces de 4 vendeurs");
    assert.equal(meetsThresholds(valuesOf(listings(prices, { sellers: 5 }))), true, "5 annonces de 5 vendeurs");
    assert.equal(insufficient(listings(prices.slice(0, 4))), true);
    assert.equal(insufficient(listings(prices, { sellers: 4 })), true);
    assert.equal(insufficient(listings(prices, { sellers: 5 })), false);
    assert.equal(insufficient(listings(Array.from({ length: 40 }, (_, index) => 150_000 + index * 100), { sellers: 4 })), true, "beaucoup d'annonces de 4 vendeurs : jamais publié");
    assert.equal(insufficient(listings(Array.from({ length: 400 }, (_, index) => 150_000 + (index % 20) * 100), { sellers: 4 })), true, "même avec 400 annonces");
  });

  test("un vendeur disparu (null) ne compte pour personne ; un relevé répété n'est jamais une annonce ni un vendeur de plus", () => {
    const orphaned = listings([150_000, 151_000, 152_000, 153_000, 154_000, 155_000]).map((entry, index) => ({ ...entry, sellerId: index < 2 ? entry.sellerId : null }));
    assert.equal(meetsThresholds(valuesOf(orphaned)), false, "2 vendeurs connus seulement");
    assert.equal(valuesOf(orphaned).length, 2);
    const repeated = Array.from({ length: 40 }, (_, index) => row({ priceXof: 150_000, referenceId: `R${index % 4}`, sellerId: `S${index % 4}`, day: addDays(TODAY, -(index % 10)) }));
    assert.equal(insufficient(repeated), true, "40 relevés de 4 annonces de 4 vendeurs");
    assert.equal(meetsThresholds(valuesOf(repeated)), false);
    assert.equal(insufficient([...repeated, row({ priceXof: 150_000, referenceId: "R-5", sellerId: "S4" })]), false, "un cinquième vendeur suffit");
  });

  test("les seuils comptent des vendeurs DISTINCTS même si on leur passe plusieurs valeurs d'un même vendeur", () => {
    const value = (sellerId: string) => ({ sellerId, priceXof: 150_000, listings: 1 });
    assert.equal(meetsThresholds([value("a"), value("a"), value("a"), value("b"), value("b"), value("c")]), false, "6 valeurs, 3 vendeurs");
    assert.equal(meetsThresholds([value("a"), value("b"), value("c"), value("d"), value("e")]), true);
    assert.equal(meetsThresholds([value("a"), value("b"), value("c"), value("d")]), false);
    assert.equal(meetsThresholds([value("a"), value("a"), value("b"), value("c"), value("d")], 4), true, "le minimum est un paramètre : 4 vendeurs distincts");
    assert.equal(meetsThresholds([], 5), false);
  });

  test("le seuil porte sur les vendeurs RETENUS : 5 vendeurs dont un aux prix atypiques ne sont plus que 4 : pas assez de données", () => {
    const rows = listings([100_000, 100_000, 100_000, 100_000, 200_000]);
    assert.equal(discardOutliers(valuesOf(rows)).excluded.length, 1);
    assert.equal(insufficient(rows), true);
    // Un vendeur de plus de ce côté du prix : la valeur de 200 000 n'est plus atypique et l'ensemble est publié.
    assert.equal(insufficient(listings([100_000, 100_000, 100_000, 100_000, 200_000, 200_000])), false);
  });

  test("les vendeurs se comptent APRÈS le retrait : 4 vendeurs retenus et un cinquième aux prix atypiques : pas assez de données, même avec 50 annonces au total", () => {
    const rows = [...listings([150_000, 151_000, 152_000, 153_000], { prefix: "A" }), ...listings(Array.from({ length: 50 }, () => 9_000_000), { prefix: "B", sellers: 1 })];
    assert.equal(insufficient(rows), true);
  });
});

describe("UNE valeur par VENDEUR : la médiane des derniers prix de ses annonces (jamais pondérée par les jours ni par le nombre d'annonces)", () => {
  test("lastPerListing garde le relevé le plus récent de chaque annonce", () => {
    const rows = [
      row({ referenceId: "a", priceXof: 100_000, day: addDays(TODAY, -10) }),
      row({ referenceId: "a", priceXof: 90_000, day: addDays(TODAY, -2) }),
      row({ referenceId: "b", priceXof: 120_000, day: addDays(TODAY, -5) }),
    ];
    assert.deepEqual(lastPerListing(rows).map((entry) => [entry.referenceId, entry.priceXof]).sort(), [["a", 90_000], ["b", 120_000]]);
  });

  test("sellerValues : la médiane (arrondie à 500) des prix arrondis à 500 des annonces du vendeur ; un vendeur inconnu est ignoré", () => {
    const mine = (prices: number[], sellerId: string | null) => prices.map((priceXof, index) => row({ priceXof, referenceId: `${sellerId}-${index}`, sellerId }));
    const values = sellerValues([
      ...mine([100_000, 200_000, 300_000], "impair"), // médiane 200 000
      ...mine([100_000, 101_000], "pair"), // (100 000 + 101 000) / 2 = 100 500
      ...mine([100_000, 100_500], "demi"), // 100 250 → 100 500 (la moitié vers le haut)
      ...mine([149_900, 160_249, 160_250], "arrondi"), // 150 000, 160 000, 160 500 → 160 000
      ...mine([1_000_000, 1_000_000], null),
    ]);
    const bySeller = Object.fromEntries(values.map((value) => [value.sellerId, [value.priceXof, value.listings]]));
    assert.deepEqual(bySeller, { impair: [200_000, 3], pair: [100_500, 2], demi: [100_500, 2], arrondi: [160_000, 3] });
  });

  test("une annonce en ligne 20 jours pèse comme une annonce d'un jour : médiane 120 000 (pondérée par les jours elle vaudrait 100 000)", () => {
    const longLived = Array.from({ length: 20 }, (_, index) => row({ referenceId: "long", sellerId: "S0", priceXof: 100_000, day: addDays(TODAY, -index) }));
    const oneDay = [110_000, 120_000, 130_000, 140_000].map((priceXof, index) => row({ referenceId: `short-${index}`, sellerId: `S${index + 1}`, priceXof, day: TODAY }));
    const listing = published([...longLived, ...oneDay]);
    assert.equal(listing.median, 120_000);
    assert.deepEqual(listing.count, { kind: "approx", value: 5 });
    assert.equal(listing.excluded, null);
  });

  test("le prix d'une annonce est son DERNIER prix de la période (une baisse de prix compte, l'ancien prix non)", () => {
    const rows = [
      ...[150_000, 152_000, 154_000, 156_000].map((priceXof, index) => row({ referenceId: `s-${index}`, sellerId: `S${index}`, priceXof, day: TODAY })),
      row({ referenceId: "moving", sellerId: "S4", priceXof: 200_000, day: addDays(TODAY, -9) }),
      row({ referenceId: "moving", sellerId: "S4", priceXof: 148_000, day: addDays(TODAY, -3) }),
    ];
    // valeurs : 148 000, 150 000, 152 000, 154 000, 156 000 → médiane 152 000 (avec l'ancien prix de 200 000, ce vendeur serait écarté : pas assez de données).
    assert.equal(published(rows).median, 152_000);
  });

  test("une annonce dont le dernier relevé précède la période n'existe pas pour elle", () => {
    const rows = [...listings([150_000, 151_000, 152_000, 153_000, 154_000]), row({ priceXof: 900_000, day: addDays(TODAY, -31) })];
    assert.equal(published(rows).median, 152_000);
  });

  test("la valeur d'un vendeur de plusieurs annonces est la médiane de SES annonces, pas une annonce de plus : 5 annonces à 140 000 d'un vendeur et 4 vendeurs à 150, 155, 160, 165 000 → médiane 155 000 (par annonce : 140 000)", () => {
    const rows = [...listings([140_000, 140_000, 140_000, 140_000, 140_000], { sellers: 1, prefix: "A" }), ...listings([150_000, 155_000, 160_000, 165_000], { prefix: "B" })];
    const listing = published(rows);
    assert.equal(listing.median, 155_000);
    assert.deepEqual(listing.count, { kind: "approx", value: 10 }, "9 annonces affichées « environ 10 »");
    assert.deepEqual(listing.sellers, { kind: "approx", value: 5 }, "5 vendeurs");
    assert.equal(listing.range, null);
  });

  test("RELECTURE DE L'AUDIT (H1-bis : un vendeur fixait la médiane) : 5 vendeurs honnêtes de 160 à 170 000, un vendeur de plus ajoute 1, 2, 6, 50 ou 500 annonces à 1, 10 000, 120 000, 164 000, 200 000 ou 99 000 000 : la médiane reste entre les 2e/3e et 3e/4e prix honnêtes", () => {
    const honest = [160_000, 162_500, 165_000, 167_500, 170_000];
    // Avec 6 valeurs, la médiane est la moyenne des 3e et 4e : au plus une position de décalage parmi les honnêtes → [(h2 + h3) / 2 ; (h3 + h4) / 2] arrondis à 500.
    const low = round500((honest[1] + honest[2]) / 2);
    const high = round500((honest[2] + honest[3]) / 2);
    assert.deepEqual([low, high], [164_000, 166_500]);
    let measured = 0;
    for (const attackerPrice of [1, 500, 10_000, 120_000, 164_000, 200_000, 99_000_000]) {
      for (const attackerListings of [1, 2, 6, 50, 500]) {
        const rows = [
          ...honest.map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` })),
          ...Array.from({ length: attackerListings }, (_, index) => row({ priceXof: attackerPrice, referenceId: `a-${index}`, sellerId: "attaquant" })),
        ];
        const listing = published(rows);
        assert.ok(listing.median >= low && listing.median <= high, `${attackerListings} annonces à ${attackerPrice} : médiane ${listing.median}`);
        assert.equal(listing.range, null, "moins de 10 vendeurs : la médiane seule");
        measured += 1;
      }
    }
    assert.equal(measured, 35);
  });

  test("le cas exact de l'audit : 6 annonces à 120 000 d'un seul vendeur ne déplacent plus la médiane (165 000), ni 10 000, ni 99 000 000 (et Q1 n'est plus jamais 0)", () => {
    const honest = [160_000, 162_500, 165_000, 167_500, 170_000].map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` }));
    for (const price of [120_000, 10_000, 99_000_000]) {
      const attack = Array.from({ length: 6 }, (_, index) => row({ priceXof: price, referenceId: `a-${index}`, sellerId: "attaquant" }));
      const listing = published([...honest, ...attack]);
      assert.equal(listing.median, 165_000, `6 annonces à ${price}`);
      assert.deepEqual(listing.excluded, { kind: "approx", value: 5 }, "les 6 annonces du vendeur aux prix atypiques sont écartées (affichées « environ 5 »)");
      assert.deepEqual(listing.sellers, { kind: "approx", value: 5 });
      assert.equal(listing.range, null);
    }
  });

  test("DEUX VENDEURS COMPLICES : tant qu'ils sont moins nombreux que les vendeurs honnêtes, la médiane reste dans l'étendue des honnêtes ; avec 5 honnêtes elle ne bouge que d'une position (entre le 2e et le 4e)", () => {
    let measured = 0;
    for (const honestCount of [5, 6, 7, 8, 9]) {
      const honest = Array.from({ length: honestCount }, (_, index) => 160_000 + index * 2_500);
      const rowsOf = (colluders: Array<{ price: number; listings: number }>) => [
        ...honest.map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` })),
        ...colluders.flatMap((colluder, seller) => Array.from({ length: colluder.listings }, (_, index) => row({ priceXof: colluder.price, referenceId: `c${seller}-${index}`, sellerId: `complice-${seller}` }))),
      ];
      const low = honest[0];
      const high = honest[honestCount - 1];
      const middle = honest[Math.floor(honestCount / 2)];
      for (const [first, second] of [[1, 1], [99_000_000, 99_000_000], [1, 99_000_000], [low, low], [high, high], [middle, middle], [low - 2_500, high + 2_500], [low - 500, low - 500], [high + 500, high + 500], [middle, 1]]) {
        for (const listings of [1, 7, 100]) {
          const listing = published(rowsOf([{ price: first, listings }, { price: second, listings: 1 }]));
          assert.ok(listing.median >= low && listing.median <= high, `${honestCount} honnêtes, complices à ${first} et ${second} : médiane ${listing.median} hors de [${low} ; ${high}]`);
          if (honestCount % 2 === 1) {
            // 7 valeurs pour 5 honnêtes : la médiane est la 4e, donc entre le 2e et le 4e prix honnête (une position de décalage au plus).
            const m = (honestCount - 1) / 2;
            assert.ok(listing.median >= honest[m - 1] && listing.median <= honest[m + 1], `${honestCount} honnêtes : décalage de plus d'une position (${listing.median})`);
          }
          measured += 1;
        }
      }
    }
    assert.equal(measured, 5 * 10 * 3);
  });

  test("ce que DEUX complices obtiennent de plus : avec seulement 3 vendeurs honnêtes (5 au total, le minimum) ils font PUBLIER une médiane de leur choix dans l'étendue des honnêtes (jamais hors d'elle), ou, en resserrant l'écart interquartile, font écarter un honnête atypique et ramener le marché sous le seuil (déni de publication, aucune fuite)", () => {
    const honest = [150_000, 160_000, 170_000];
    const medians = new Set<number>();
    let withheld = 0;
    for (const target of [1, 99_000_000, 149_500, 150_000, 152_000, 155_000, 159_500, 165_000, 169_500, 170_000, 171_000, 200_000]) {
      const rows = [
        ...honest.map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` })),
        row({ priceXof: target, referenceId: "c-0", sellerId: "complice-0" }),
        row({ priceXof: target, referenceId: "c-1", sellerId: "complice-1" }),
      ];
      const outcome = computeMarketStats(rows, request()).listings;
      if (outcome.status === "insufficient") {
        withheld += 1;
        continue;
      }
      assert.ok(outcome.median >= 150_000 && outcome.median <= 170_000, `cible ${target} : médiane ${outcome.median}`);
      medians.add(outcome.median);
    }
    // Valeurs calculées à la main : complices à 152 000 → 150, 152, 152, 160, 170 : Q1 = 152, Q3 = 160, IQR = 8, bornes 140 et 172, rien d'écarté, médiane 152 000 ; à 169 500 → médiane 169 500 ;
    // à 155 000 → 150, 155, 155, 160, 170 : IQR = 5, borne haute 167 500, le vendeur à 170 000 est écarté, 4 vendeurs : pas assez de données.
    assert.ok(medians.has(152_000) && medians.has(169_500), [...medians].join(" "));
    assert.ok(withheld >= 1, "au moins un choix des complices fait tomber le marché sous le seuil");
    assert.equal(insufficient([
      ...honest.map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` })),
      row({ priceXof: 155_000, referenceId: "c-0", sellerId: "complice-0" }),
      row({ priceXof: 155_000, referenceId: "c-1", sellerId: "complice-1" }),
    ]), true);
  });

  test("LIMITE DOCUMENTÉE : à nombre égal (5 complices pour 5 honnêtes), les complices sortent la médiane de l'étendue des honnêtes ; il leur faut autant de comptes à numéro vérifié que de vendeurs honnêtes", () => {
    const honest = [160_000, 162_500, 165_000, 167_500, 170_000].map((priceXof, index) => row({ priceXof, referenceId: `h-${index}`, sellerId: `honnete-${index}` }));
    const colluders = Array.from({ length: 5 }, (_, index) => row({ priceXof: 120_000, referenceId: `c-${index}`, sellerId: `complice-${index}` }));
    const listing = published([...honest, ...colluders]);
    assert.ok(listing.median < 160_000, `médiane ${listing.median}`);
  });
});

describe("prix atypiques : écartés avant toute publication, et dits", () => {
  test("Q1 = 157 500, Q3 = 172 500, IQR = 15 000 : un vendeur à 1 000 000 est écarté (borne 195 000), médiane des 6 autres = 162 500", () => {
    const rows = listings([150_000, 155_000, 160_000, 165_000, 170_000, 175_000, 1_000_000]);
    const retained = discardOutliers(valuesOf(rows));
    assert.equal(retained.excluded.length, 1);
    assert.equal(retained.kept.length, 6);
    const listing = published(rows);
    assert.equal(listing.median, 162_500);
    assert.deepEqual(listing.count, { kind: "approx", value: 5 }, "6 annonces retenues → environ 5");
    assert.deepEqual(listing.sellers, { kind: "approx", value: 5 }, "6 vendeurs retenus → environ 5");
    assert.deepEqual(listing.excluded, { kind: "below", bound: 5 }, "une annonce écartée → « moins de 5 »");
    assert.equal(listing.range, null, "moins de 10 vendeurs : la médiane seule");
  });

  test("un prix trop bas est écarté de la même façon ; un prix exactement à la borne reste, un demi-millier au-delà sort", () => {
    const low = listings([1_000, 150_000, 155_000, 160_000, 165_000, 170_000, 175_000]);
    assert.equal(discardOutliers(valuesOf(low)).excluded.length, 1);
    // Q1 = 115 000, Q3 = 145 000 (n = 7 : positions 1,5 et 4,5), IQR = 30 000 → borne haute 190 000 (incluse).
    const edge = listings([100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 190_000]);
    assert.equal(discardOutliers(valuesOf(edge)).excluded.length, 0);
    const beyond = listings([100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 190_500]);
    assert.equal(discardOutliers(valuesOf(beyond)).excluded.length, 1);
  });

  test("les annonces écartées sont celles des vendeurs écartés (3 annonces d'un vendeur à 1 000 → « moins de 5 »), publiées arrondies, jamais un compte exact ; aucune écartée : null", () => {
    const honest = listings([150_000, 152_000, 154_000, 156_000, 158_000, 160_000, 162_000], { prefix: "H" });
    const cheap = listings([1_000, 1_000, 1_000], { prefix: "X", sellers: 1 });
    const listing = published([...honest, ...cheap]);
    assert.deepEqual(listing.excluded, { kind: "below", bound: 5 }, "3 annonces d'un vendeur écarté");
    assert.deepEqual(listing.count, { kind: "approx", value: 5 }, "7 annonces retenues");
    assert.equal(published(honest).excluded, null);
  });

  test("7 annonces écartées de 7 vendeurs (30 vendeurs à 150 000, IQR nul) → « environ 5 », 30 retenues", () => {
    // 30 vendeurs à 150 000 et 7 prix extrêmes : Q1 = Q3 = 150 000, IQR nul, les 7 extrêmes sortent.
    const tight = listings(Array.from({ length: 30 }, () => 150_000));
    const extremes = listings([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000], { prefix: "X" });
    const listing = published([...tight, ...extremes]);
    assert.deepEqual(listing.excluded, { kind: "approx", value: 5 }, "7 écartées → environ 5");
    assert.deepEqual(listing.count, { kind: "approx", value: 30 }, "30 retenues");
    assert.deepEqual(listing.sellers, { kind: "approx", value: 30 });
  });
});

describe("fourchette : arrondie en relatif, jamais sous 10 VENDEURS, jamais une borne ≤ 0", () => {
  test("12 vendeurs de 150 000 à 205 000 : médiane 177 500, Q1 = 163 750 → 159 750 (2 pas de 8 875), Q3 = 191 250 → 195 250 ; effectifs « environ 10 »", () => {
    const rows = listings(Array.from({ length: 12 }, (_, index) => 150_000 + index * 5_000));
    const listing = published(rows);
    assert.equal(listing.median, 177_500);
    assert.deepEqual(listing.range, { q1: 159_750, q3: 195_250 });
    assert.deepEqual(listing.count, { kind: "approx", value: 10 });
    assert.deepEqual(listing.sellers, { kind: "approx", value: 10 });
    assert.equal(listing.excluded, null);
    // Les bornes publiées ne sont JAMAIS les quartiles exacts ; ce sont des multiples de 5 % de la médiane (8 875) de part et d'autre d'elle.
    assert.notEqual(listing.range?.q1, 163_750);
    assert.notEqual(listing.range?.q3, 191_250);
    assert.ok(Math.abs(((listing.range?.q1 ?? 0) - 177_500) % 8_875) === 0);
    assert.ok(Math.abs(((listing.range?.q3 ?? 0) - 177_500) % 8_875) === 0);
  });

  test("9 vendeurs : la médiane seule ; 10 vendeurs : la fourchette apparaît (frontière exacte)", () => {
    const nine = listings(Array.from({ length: 9 }, (_, index) => 150_000 + index * 5_000));
    assert.equal(published(nine).range, null);
    const ten = listings(Array.from({ length: 10 }, (_, index) => 150_000 + index * 5_000));
    assert.notEqual(published(ten).range, null);
  });

  test("le seuil de la fourchette porte sur les VENDEURS : 90 annonces de 9 vendeurs ne donnent pas de fourchette", () => {
    const rows = listings(Array.from({ length: 90 }, (_, index) => 150_000 + (index % 30) * 500), { sellers: 9 });
    const listing = published(rows);
    assert.equal(listing.range, null);
    assert.deepEqual(listing.count, { kind: "approx", value: 90 });
  });

  test("le nombre de vendeurs s'entend APRÈS le retrait des prix atypiques : 10 vendeurs dont un atypique : pas de fourchette", () => {
    const rows = listings([150_000, 152_000, 154_000, 156_000, 158_000, 160_000, 162_000, 164_000, 166_000, 5_000_000]);
    const listing = published(rows);
    assert.equal(listing.range, null);
    assert.deepEqual(listing.excluded, { kind: "below", bound: 5 });
  });

  test("une borne ≤ 0 n'est JAMAIS publiée : quand l'arrondi relatif ramène Q1 à 0, la fourchette entière est omise (la médiane reste publiée)", () => {
    // relativeRound(100 000, 500) = 0 : Q1 = 500 est à moins d'un demi-pas (2 500) de zéro.
    assert.equal(relativeRound(100_000, 500), 0);
    const skewed = listings([500, 500, 500, 500, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000]);
    assert.equal(discardOutliers(valuesOf(skewed)).excluded.length, 0, "aucun prix atypique : la borne basse est négative");
    const listing = published(skewed);
    assert.equal(listing.median, 100_000);
    assert.equal(listing.range, null, "Q1 arrondi à 0 : pas de fourchette");
    // Avec des petits prix un peu plus grands, la fourchette réapparaît (et toutes ses bornes sont strictement positives).
    const wider = listings([20_000, 20_000, 20_000, 20_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000]);
    assert.deepEqual(published(wider).range, { q1: 20_000, q3: 100_000 });
  });

  test("dans des centaines de marchés tirés au hasard (dont des prix extrêmes), aucune borne publiée n'est ≤ 0 et Q1 ≤ médiane ≤ Q3", () => {
    let state = 12_345;
    const next = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    let ranges = 0;
    for (let world = 0; world < 400; world += 1) {
      const sellersCount = 5 + Math.floor(next() * 20);
      const prices = Array.from({ length: sellersCount }, () => {
        const kind = next();
        if (kind < 0.3) return 500 + Math.floor(next() * 5_000);
        if (kind < 0.35) return 99_000_000;
        return 100_000 + Math.floor(next() * 100_000);
      });
      const stats = computeMarketStats(listings(prices), request());
      if (stats.listings.status !== "published" || stats.listings.range === null) continue;
      ranges += 1;
      assert.ok(stats.listings.range.q1 > 0 && stats.listings.range.q3 > 0, JSON.stringify(stats.listings.range));
      assert.ok(stats.listings.range.q1 <= stats.listings.median && stats.listings.median <= stats.listings.range.q3);
    }
    assert.ok(ranges >= 30, `${ranges} fourchettes vérifiées`);
  });
});

describe("statistiques sur un jeu connu (calculées à la main)", () => {
  test("médiane des prix arrondis un à un : 140 000, 150 000, 152 500, 160 000, 160 500, 171 000 (190 000 écarté : borne 187 500) → (152 500 + 160 000) / 2 = 156 250 → 156 500", () => {
    const rows = listings([140_000, 149_900, 152_300, 160_249, 160_250, 171_000, 189_999]);
    assert.equal(discardOutliers(valuesOf(rows)).excluded.length, 1);
    assert.equal(published(rows).median, 156_500);
  });

  test("ni minimum, ni maximum, ni identifiant, ni prix de vente dans la sortie ; seules les clés attendues (effectifs arrondis, jamais exacts)", () => {
    const rows = listings([150_000, 152_000, 154_000, 156_000, 158_000, 160_000]);
    const stats = computeMarketStats(rows, request());
    const text = JSON.stringify(stats);
    for (const secret of rows.flatMap((entry) => [entry.referenceId, entry.sellerId as string])) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(Object.keys(stats).sort(), ["listings", "period"], "aucune clé `sales`");
    assert.deepEqual(Object.keys(published(rows)).sort(), ["comparedTo", "count", "excluded", "median", "range", "sellers", "status", "trend"]);
    assert.deepEqual(published(rows).sellers, { kind: "approx", value: 5 }, "6 vendeurs → « environ 5 »");
    assert.ok(!/"(min|max|minimum|maximum|sales|buyers|q1|q3|observations|sellerId)"/.test(text), "ni minimum ni maximum ni acheteurs ni quartile exact ni relevés (la fourchette est absente sous 10 vendeurs)");
  });

  test("une période sans annonce : « pas assez de données »", () => {
    assert.deepEqual(computeMarketStats([], request()).listings, { status: "insufficient" });
  });
});

describe("période", () => {
  test("30 jours = aujourd'hui − 29 à aujourd'hui, bornes comprises ; le 30e jour avant est exclu ; 90 et 365 jours l'incluent", () => {
    const edge = listings([150_000, 151_000, 152_000, 153_000, 154_000], { day: addDays(TODAY, -29), prefix: "E" });
    const outside = listings([160_000, 161_000, 162_000, 163_000, 164_000], { day: addDays(TODAY, -30), prefix: "O" });
    const stats30 = computeMarketStats([...edge, ...outside], request({ periodDays: 30 }));
    assert.deepEqual(stats30.period, { days: 30, from: "2026-09-08", to: TODAY });
    assert.equal((stats30.listings as PublishedListings).median, 152_000, "les annonces du jour limite seulement");
    assert.equal(insufficient(outside, { periodDays: 30 }), true);
    assert.deepEqual(published([...edge, ...outside], { periodDays: 90 }).count, { kind: "approx", value: 10 });
    assert.equal(published(outside, { periodDays: 365 }).median, 162_000);
    assert.deepEqual(computeMarketStats([], request({ periodDays: 365 })).period, { days: 365, from: "2025-10-08", to: TODAY });
  });

  test("un relevé futur n'est jamais compté", () => {
    assert.equal(insufficient(listings([150_000, 151_000, 152_000, 153_000, 154_000], { day: addDays(TODAY, 1) })), true);
  });
});

describe("comparabilité : élargissement dit", () => {
  const group = (variantKey: string, conditionKey: string, count: number, prefix: string, price = 150_000, step = 100) =>
    listings(Array.from({ length: count }, (_, index) => price + index * step), { prefix, variantKey, conditionKey });

  test("exact suffisant : aucun élargissement, ni mélange avec les autres variantes", () => {
    const listing = published([...group("128 go", "occasion", 5, "a"), ...group("256 go", "occasion", 6, "b", 400_000)]);
    assert.equal(listing.comparedTo.scope, "exact");
    assert.equal(listing.comparedTo.text, "Comparé à : iPhone 12 128 Go, Occasion");
    assert.equal(listing.median, 150_000, "les 256 Go n'entrent pas dans le prix des 128 Go");
  });

  test("variante insuffisante : sans la variante, l'élargissement est DIT", () => {
    const listing = published([...group("128 go", "occasion", 3, "a"), ...group("256 go", "occasion", 4, "b", 200_000)]);
    assert.equal(listing.comparedTo.scope, "any_variant");
    assert.equal(listing.comparedTo.text, "Comparé à : iPhone 12, Occasion, toutes variantes confondues");
    assert.deepEqual(listing.count, { kind: "approx", value: 5 }, "7 annonces des deux variantes");
  });

  test("encore insuffisant : sans l'état à son tour", () => {
    const listing = published([...group("128 go", "occasion", 2, "a"), ...group("256 go", "neuf", 3, "b", 300_000), ...group("128 go", "neuf", 2, "c", 280_000)]);
    assert.equal(listing.comparedTo.scope, "any_variant_and_condition");
    assert.equal(listing.comparedTo.text, "Comparé à : iPhone 12, toutes variantes et tous états confondus");
  });

  test("variante non demandée : seul l'état s'élargit ; état non choisi : « tous états confondus » dit d'emblée", () => {
    const rows = [...group("128 go", "occasion", 3, "a"), ...group("128 go", "neuf", 3, "b", 300_000)];
    const listing = published(rows, { variantKey: null, display: { model: "iPhone 12", variant: null, condition: "Occasion" } });
    assert.equal(listing.comparedTo.scope, "any_condition");
    assert.equal(listing.comparedTo.text, "Comparé à : iPhone 12, toutes variantes et tous états confondus");
    const open = published(group("128 go", "occasion", 5, "a"), { variantKey: "128 go", conditionKey: null, display: { model: "iPhone 12", variant: "128 Go", condition: null } });
    assert.equal(open.comparedTo.scope, "exact");
    assert.equal(open.comparedTo.text, "Comparé à : iPhone 12 128 Go, tous états confondus");
  });

  test("sans élargissement (tableau d'administration) : insuffisant plutôt qu'élargi", () => {
    assert.equal(insufficient([...group("128 go", "occasion", 3, "a"), ...group("256 go", "occasion", 4, "b", 200_000)], { allowWidening: false }), true);
  });

  test("toute la comparaison en dessous des seuils : « pas assez de données », aucun chiffre", () => {
    assert.deepEqual(computeMarketStats(group("128 go", "occasion", 3, "a"), request()).listings, { status: "insufficient" });
  });

  test("la clé d'une annonce est celle de son DERNIER relevé (une annonce passée de « neuf » à « occasion » compte pour « occasion »)", () => {
    const moved = [
      row({ referenceId: "m", sellerId: "Sm", priceXof: 150_000, day: addDays(TODAY, -5), conditionKey: "neuf" }),
      row({ referenceId: "m", sellerId: "Sm", priceXof: 150_000, day: addDays(TODAY, -1), conditionKey: "occasion" }),
    ];
    assert.equal(published([...group("128 go", "occasion", 4, "a", 150_000, 1_000), ...moved]).comparedTo.scope, "exact", "5 annonces d'occasion dont la dernière est « m »");
  });
});

describe("tendance : médiane par bloc de 7 jours finissant aujourd'hui, une valeur par vendeur et par bloc, 20 vendeurs au moins par semaine", () => {
  /** `count` annonces (prix croissants par pas de 500) de `sellers` vendeurs, dont le dernier relevé tombe dans le bloc qui finit `lastOffset` jours avant aujourd'hui. */
  const week = (lastOffset: number, price: number, count: number, sellers: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => row({ priceXof: price + index * 500, referenceId: `${prefix}${index}`, sellerId: `S${prefix}${index % sellers}`, day: addDays(TODAY, -(lastOffset - (index % 7))) }));

  test("30 jours = 4 blocs (28 jours) ; un bloc de moins de 20 vendeurs vaut null (même avec 40 annonces, même au-dessus du seuil de 5 vendeurs de la période)", () => {
    const rows = [
      ...week(6, 170_000, 20, 20, "n"), // 20 vendeurs : dernier bloc, publié
      ...week(13, 160_000, 19, 19, "m"), // 19 vendeurs : sous le minimum
      ...week(20, 150_000, 40, 19, "l"), // 40 annonces mais 19 vendeurs : sous le minimum
      ...week(27, 140_000, 20, 20, "k"), // 20 vendeurs : premier bloc, publié
    ];
    const listing = published(rows);
    assert.deepEqual(listing.trend.map((point) => point.from), ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]);
    // premier bloc : 140 000 + 500 × i (i de 0 à 19) → médiane = moyenne de la 10e et de la 11e valeur (144 500 et 145 000) = 144 750, arrondie à 145 000 ; dernier bloc : 170 000 + 500 × i → 175 000.
    assert.deepEqual(listing.trend.map((point) => point.median), [145_000, null, null, 175_000]);
    assert.equal(published(rows, { periodDays: 90 }).trend.length, 12);
    assert.equal(published(rows, { periodDays: 365 }).trend.length, 52);
  });

  test("avec 20 vendeurs dans la semaine, le point est publié ; avec 19, jamais (frontière exacte)", () => {
    const twenty = published(week(6, 150_000, 20, 20, "t"));
    assert.equal(twenty.trend.at(-1)?.median, 155_000, "médiane de 150 000 à 159 500 : 154 750, arrondie à 155 000");
    const nineteen = published(week(6, 150_000, 19, 19, "t"));
    assert.equal(nineteen.trend.at(-1)?.median, null);
  });

  test("les vendeurs d'un point de tendance se comptent APRÈS le retrait des prix atypiques : 20 vendeurs dont un aux prix atypiques : pas de point", () => {
    const rows = [...week(6, 150_000, 19, 19, "t"), row({ priceXof: 9_000_000, referenceId: "extreme", sellerId: "Sextreme", day: addDays(TODAY, -3) })];
    assert.equal(published(rows).trend.at(-1)?.median, null);
  });

  test("un vendeur compte UNE fois par bloc : 60 annonces de 19 vendeurs ne font pas un point", () => {
    assert.equal(published(week(6, 150_000, 60, 19, "t")).trend.at(-1)?.median, null);
  });

  test("une annonce compte UNE fois par bloc, avec son dernier prix du bloc", () => {
    const base = Array.from({ length: 19 }, (_, index) => row({ priceXof: 150_000 + index * 500, referenceId: `q${index}`, sellerId: `Sq${index}`, day: addDays(TODAY, -2) }));
    const rows = [
      ...base,
      row({ referenceId: "q-moving", sellerId: "Sx", priceXof: 400_000, day: addDays(TODAY, -6) }),
      row({ referenceId: "q-moving", sellerId: "Sx", priceXof: 152_000, day: addDays(TODAY, -1) }),
    ];
    // 20 valeurs : 150 000, 150 500, …, 159 000 et 152 000 (le prix de 400 000 n'existe plus : sinon ce vendeur serait écarté, 19 seulement, et le point manquerait) ;
    // triées, la 10e vaut 154 000 et la 11e 154 500 : 154 250, arrondi à 154 500.
    assert.equal(published(rows).trend.at(-1)?.median, 154_500);
  });
});

describe("limite de débit : 60 lectures par minute et par utilisateur", () => {
  test("la 61e lecture de la minute est refusée avec un délai d'au moins 1 s ; la fenêtre est glissante ; les utilisateurs sont indépendants", () => {
    let now = 1_000;
    const limiter = createMarketRateLimiter({ now: () => now });
    for (let index = 0; index < 60; index += 1) {
      assert.deepEqual(limiter.tryAcquire("u1"), { ok: true }, `lecture ${index + 1}`);
      now += 10;
    }
    const refused = limiter.tryAcquire("u1");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
    assert.deepEqual(limiter.tryAcquire("u2"), { ok: true }, "un autre utilisateur n'est pas touché");
    now += 59_000;
    assert.equal(limiter.tryAcquire("u1").ok, false, "encore dans la minute de la première lecture");
    now += 500;
    assert.deepEqual(limiter.tryAcquire("u1"), { ok: true }, "la première lecture est sortie de la fenêtre");
  });

  test("la mémoire est bornée : au plus `maxUsers` utilisateurs", () => {
    let now = 0;
    const limiter = createMarketRateLimiter({ now: () => now, maxUsers: 5 });
    for (let index = 0; index < 50; index += 1) {
      limiter.tryAcquire(`user-${index}`);
      now += 1;
    }
    assert.ok(limiter.size() <= 5, `taille ${limiter.size()}`);
  });
});
