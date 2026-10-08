import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MARKET_TREND_MIN_SELLERS } from "../../lib/server/market/config";
import { marketStatsDto } from "../../lib/server/market/http";
import { computeMarketStats, type MarketObservation, type MarketRequest } from "../../lib/server/market/stats";

/**
 * ADVERSAIRE des prix demandés dans les annonces (lots H1, H1-bis et H1-ter). Ce test n'importe RIEN des arrondis ni des seuils : seulement la fonction de publication (`computeMarketStats`) et
 * la correspondance vers la réponse JSON (`marketStatsDto`), plus un générateur de mondes.
 *
 * Modèle de menace. L'adversaire lit les réponses de la route pour DEUX périodes emboîtées (30 et 90 jours) et DEUX niveaux de comparabilité (la variante demandée, puis aucune variante
 * demandée : le même marché élargi) ; il connaît TOUT le reste du monde (toutes les autres annonces, leurs jours, leurs vendeurs) et vise le prix d'UNE annonce (la cible). Il
 * « retrouve exactement » ce prix quand AUCUN autre prix n'aurait donné les mêmes quatre réponses. Il peut aussi OUVRIR des comptes vendeurs (chacun exige un numéro vérifié) et y publier
 * autant d'annonces qu'il veut, aux prix qu'il veut.
 *
 * Ce que le test établit (sur les mondes tirés, jamais « pour tous les mondes ») :
 *  (a) PRIX QUELCONQUES : sur 800 mondes (aléatoires, « de bord », « imbriqués », un vendeur par annonce), le prix cible ± 1 donne les MÊMES quatre réponses (aucune cible n'est retrouvée), et
 *      les prix compatibles couvrent au moins 249 valeurs : conséquence de l'arrondi de CHAQUE prix à 500 FCFA avant tout calcul (médiane, quartiles, prix atypiques, seuils) ;
 *  (b) PRIX RONDS (multiples de 5 000, la norme en FCFA) : un adversaire qui SAIT que les prix sont ronds retrouve une annonce quand elle fait la valeur médiane de son vendeur et que ce vendeur est
 *      au rang médian : le test MESURE cette fuite (marchés de 6 à 25 vendeurs, grands marchés, marchés dont la TENDANCE est publiée) et l'encadre ; ces prix sont des prix DEMANDÉS, que les
 *      acheteurs correspondants voient de toute façon ; HISTORIQUE-PRIX.md le dit sans détour ;
 *  (c) TÉMOINS : une publication SANS arrondi, une publication qui n'arrondit que le RÉSULTAT et surtout la publication de PRIX DE VENTE (Q1, médiane, Q3 de cinq ventes = les 2e, 3e et 4e prix
 *      réels ; trois comptes et quatre ventes fictives fabriquent un groupe qui publie le prix exact d'une vente) font échouer l'adversaire : c'est pourquoi les ventes ne sont pas publiées ;
 *  (d) UTILITÉ : la publication reste informative (médiane à 500 FCFA près de la vraie) ;
 *  (e) UN SEUL COMPTE (relecture de l'audit H1-bis) : un vendeur, quel que soit le nombre de ses annonces et leurs prix, déplace la médiane d'au plus une position parmi les valeurs par vendeur, et des
 *      complices moins nombreux que les vendeurs honnêtes ne la sortent jamais de leur étendue ; il faut 4 comptes (4 numéros vérifiés) pour isoler le prix d'UN vendeur dans un groupe de 5.
 * Limites (HISTORIQUE-PRIX.md) : la sybille sur les annonces (autant de comptes à numéro vérifié que de vendeurs honnêtes pour contrôler la médiane ; n − 1 comptes pour isoler le prix demandé d'un
 * vendeur dans un groupe de n : public pour les acheteurs correspondants), les relevés répétés dans le temps, les mondes que le générateur ne produit pas.
 */

const TODAY = "2026-10-07";

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function dayOffset(offset: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Les mondes tirés. `single` : un vendeur par annonce ; `boundary`/`nested`/`random` : quelques annonces par vendeur ; `round*` : prix ronds ; `trend` : prix ronds, beaucoup de vendeurs et des annonces
 * en ligne plusieurs semaines (les points de la tendance sont publiés). Une annonce en ligne a un relevé tous les 7 jours (le dernier relevé de chaque bloc de la tendance, comme la lecture SQL).
 */
type Mode = "random" | "boundary" | "boundarySingle" | "nested" | "single" | "round" | "roundLarge" | "trend";

interface World {
  rows: MarketObservation[];
}

const EDGES = [-251, -250, -249, -1, 0, 1, 249, 250, 251];

function buildWorld(random: () => number, mode: Mode): World {
  const int = (max: number): number => Math.floor(random() * (max + 1));
  const choose = <T,>(list: readonly T[]): T => list[int(list.length - 1)];
  const sellerCount = mode === "roundLarge" ? 20 + int(20) : mode === "trend" ? 25 + int(15) : 6 + int(8);
  const sellers = Array.from({ length: sellerCount }, (_, index) => `seller-${index}`);
  const price = (): number => {
    if (mode === "boundary" || mode === "boundarySingle") return 500 * (60 + int(200)) + choose(EDGES);
    if (mode === "round" || mode === "roundLarge" || mode === "trend") return 5_000 * (20 + int(20)); // 100 000 à 195 000 : un marché serré, prix ronds
    return 20_000 + int(480_000);
  };
  const rows: MarketObservation[] = [];
  const count = mode === "nested" ? sellerCount + 4 + int(8) : mode === "roundLarge" ? 60 + int(60) : mode === "trend" ? sellerCount * 2 + int(20) : sellerCount + int(15);
  const single = mode === "single" || mode === "boundarySingle";
  const attributes = () => ({ variantKey: random() < 0.7 ? "128 go" : "256 go", conditionKey: random() < 0.9 ? "occasion" : "neuf" });
  for (let index = 0; index < count; index += 1) {
    const sellerId = single ? `seller-${index}` : index < sellers.length ? sellers[index] : choose(sellers);
    const listing = { referenceId: `listing-${index}`, sellerId, priceXof: price(), ...attributes() };
    if (mode === "trend") {
      // En ligne de 14 à 35 jours, un relevé tous les 7 jours (jusqu'au plus récent).
      const newest = int(60);
      const oldest = Math.min(89, newest + 14 + int(21));
      for (let offset = newest; offset <= oldest; offset += 7) rows.push({ ...listing, day: dayOffset(offset) });
      continue;
    }
    const days = new Set<number>([int(mode === "nested" ? 29 : 89)]);
    for (let seen = 0, wanted = int(3); seen < wanted; seen += 1) days.add(int(mode === "nested" ? 29 : 89));
    for (const day of days) rows.push({ ...listing, day: dayOffset(day) });
  }
  if (mode === "nested") {
    // La cible : la seule annonce présente dans la période de 90 jours et absente de celle de 30 jours.
    const target = { referenceId: "listing-target", sellerId: choose(sellers), priceXof: price(), ...attributes() };
    for (const day of new Set([31 + int(50), 31 + int(50)])) rows.push({ ...target, day: dayOffset(day) });
  }
  return { rows };
}

const baseRequest: Omit<MarketRequest, "periodDays" | "variantKey"> = {
  today: TODAY,
  conditionKey: "occasion",
  display: { model: "iPhone 12", variant: "128 Go", condition: "Occasion" },
};

/** Les quatre lectures de l'adversaire : deux périodes emboîtées × (variante demandée | aucune variante demandée). */
const QUERIES: ReadonlyArray<Pick<MarketRequest, "periodDays" | "variantKey">> = [
  { periodDays: 30, variantKey: "128 go" },
  { periodDays: 90, variantKey: "128 go" },
  { periodDays: 30, variantKey: null },
  { periodDays: 90, variantKey: null },
];

type Publisher = (rows: readonly MarketObservation[]) => string[];

/** La publication de production : les quatre réponses JSON complètes. */
const production: Publisher = (rows) => QUERIES.map((query) => JSON.stringify(marketStatsDto(computeMarketStats(rows, { ...baseRequest, ...query }))));

interface Target { referenceId: string; price: number }

function withPrice(world: World, referenceId: string, price: number): MarketObservation[] {
  return world.rows.map((row) => (row.referenceId === referenceId ? { ...row, priceXof: price } : row));
}

function targetsOf(world: World): Target[] {
  const seen = new Map<string, Target>();
  for (const row of world.rows) seen.set(row.referenceId, { referenceId: row.referenceId, price: row.priceXof });
  return [...seen.values()];
}

const sameAnswers = (publisher: Publisher, rows: readonly MarketObservation[], reference: readonly string[]): boolean => publisher(rows).every((answer, index) => answer === reference[index]);

/** Prix quelconques : vrai quand l'adversaire retrouve EXACTEMENT le prix (ni cible + 1 ni cible − 1 ne donne les mêmes réponses). */
function pinned(publisher: Publisher, world: World, target: Target): boolean {
  const reference = publisher(world.rows);
  const same = (price: number): boolean => price >= 1 && sameAnswers(publisher, withPrice(world, target.referenceId, price), reference);
  return !same(target.price + 1) && !same(target.price - 1);
}

/** Prix ronds : l'adversaire sait que les prix sont des multiples de 5 000 ; retrouvé quand AUCUN autre prix rond voisin (± 100 000) ne donne les mêmes réponses. */
function pinnedOnGrid(publisher: Publisher, world: World, target: Target): boolean {
  const reference = publisher(world.rows);
  for (let step = -20; step <= 20; step += 1) {
    const price = target.price + step * 5_000;
    if (step === 0 || price < 5_000) continue;
    if (sameAnswers(publisher, withPrice(world, target.referenceId, price), reference)) return false;
  }
  return true;
}

function feasibleCount(publisher: Publisher, world: World, target: Target, radius: number): number {
  const reference = publisher(world.rows);
  let count = 0;
  for (let price = Math.max(1, target.price - radius); price <= target.price + radius; price += 1) {
    if (sameAnswers(publisher, withPrice(world, target.referenceId, price), reference)) count += 1;
  }
  return count;
}

const publishedAny = (answers: readonly string[]): boolean => answers.some((answer) => answer.includes('"status":"published"'));

describe("(a) prix quelconques : la cible ± 1 donne les mêmes réponses (production)", () => {
  for (const mode of ["random", "boundary", "nested", "single"] as const) {
    test(`mondes « ${mode} » : aucune annonce n'est retrouvée exactement (deux périodes emboîtées, deux niveaux de comparabilité)`, () => {
      const random = mulberry(mode === "random" ? 20_261_007 : mode === "boundary" ? 77_001 : mode === "single" ? 91_003 : 4_242);
      const worlds = 200;
      let pinnedTargets = 0;
      let checked = 0;
      let publishedWorlds = 0;
      for (let index = 0; index < worlds; index += 1) {
        const world = buildWorld(random, mode);
        if (publishedAny(production(world.rows))) publishedWorlds += 1;
        const targets = targetsOf(world);
        const chosen = mode === "nested" ? [targets.find((target) => target.referenceId === "listing-target") as Target] : Array.from({ length: 6 }, () => targets[Math.floor(random() * targets.length)]);
        for (const target of chosen) {
          checked += 1;
          if (pinned(production, world, target)) pinnedTargets += 1;
        }
      }
      assert.equal(pinnedTargets, 0, `${pinnedTargets} cible(s) retrouvée(s) exactement sur ${checked}`);
      assert.ok(publishedWorlds >= worlds * 0.5, `le test n'est pas vide : ${publishedWorlds}/${worlds} mondes publient`);
      assert.ok(checked >= 150);
    });
  }

  test("l'ensemble des prix compatibles avec les réponses couvre au moins 249 valeurs (la tranche de 500 FCFA) : prix quelconques, bords, imbriqués", () => {
    for (const [mode, seed] of [["random", 31], ["boundary", 32], ["nested", 33], ["single", 34]] as const) {
      const random = mulberry(seed);
      let measured = 0;
      for (let index = 0; index < 40 && measured < 12; index += 1) {
        const world = buildWorld(random, mode);
        if (!publishedAny(production(world.rows))) continue;
        const targets = targetsOf(world);
        const target = mode === "nested" ? (targets.find((entry) => entry.referenceId === "listing-target") as Target) : targets[Math.floor(random() * targets.length)];
        const feasible = feasibleCount(production, world, target, 600);
        assert.ok(feasible >= 249, `${mode} : ${feasible} prix compatibles seulement (cible ${target.price})`);
        measured += 1;
      }
      assert.ok(measured >= 6, `${mode} : ${measured} mondes mesurés`);
    }
  });

  test("tout prix publié est un multiple de 500 FCFA, sauf les bornes de la fourchette (multiples de 5 % de la médiane), dans tous les mondes tirés", () => {
    const random = mulberry(99);
    let ranges = 0;
    for (let index = 0; index < 150; index += 1) {
      const world = buildWorld(random, index % 3 === 0 ? "boundarySingle" : index % 3 === 1 ? "single" : "random");
      for (const answer of production(world.rows)) {
        const parsed = JSON.parse(answer) as { listings: { median?: number; range: { q1: number; q3: number } | null; trend?: Array<{ median: number | null }> } };
        if (parsed.listings.median === undefined) continue;
        assert.equal(parsed.listings.median % 500, 0);
        for (const point of parsed.listings.trend ?? []) assert.ok(point.median === null || point.median % 500 === 0);
        const range = parsed.listings.range;
        if (range !== null) {
          ranges += 1;
          assert.ok(range.q1 > 0 && range.q3 > 0, "jamais une borne ≤ 0");
          const step = parsed.listings.median / 20;
          assert.equal(Math.abs(range.q1 - parsed.listings.median) % step, 0, "Q1 : multiple de 5 % de la médiane");
          assert.equal(Math.abs(range.q3 - parsed.listings.median) % step, 0, "Q3 : multiple de 5 % de la médiane");
        }
      }
    }
    assert.ok(ranges > 5, `${ranges} fourchettes vérifiées`);
  });
});

describe("(b) prix RONDS (multiples de 5 000) : la fuite est mesurée et bornée", () => {
  /** Part des annonces retrouvées par un adversaire qui sait que les prix sont ronds, sur `worlds` mondes, `picks` cibles tirées par monde. */
  function measure(mode: Mode, seed: number, worlds: number, picks: number) {
    const random = mulberry(seed);
    let found = 0;
    let checked = 0;
    let publishing = 0;
    let withTrendPoint = 0;
    for (let index = 0; index < worlds; index += 1) {
      const world = buildWorld(random, mode);
      const answers = production(world.rows);
      if (!publishedAny(answers)) continue;
      publishing += 1;
      // Un monde « à tendance publiée » a au moins un point de tendance (≥ 20 vendeurs dans une semaine) dans l'une des quatre réponses.
      if (answers.some((answer) => (JSON.parse(answer).listings?.trend ?? []).some((point: { median: number | null }) => point.median !== null))) withTrendPoint += 1;
      const targets = targetsOf(world);
      for (let pick = 0; pick < picks; pick += 1) {
        checked += 1;
        if (pinnedOnGrid(production, world, targets[Math.floor(random() * targets.length)])) found += 1;
      }
    }
    return { found, checked, publishing, withTrendPoint, rate: found / checked };
  }

  test("MESURE (prix ronds) : petits marchés (6 à 13 vendeurs), grands marchés (20 à 39 vendeurs, 60 à 119 annonces) et marchés à tendance publiée (25 à 39 vendeurs, annonces en ligne plusieurs semaines)", () => {
    const small = measure("round", 5_000, 300, 5);
    const large = measure("roundLarge", 6_000, 80, 5);
    const trend = measure("trend", 7_000, 60, 5);
    console.log(
      `[adversaire/prix ronds] petits marchés : ${small.found}/${small.checked} annonces retrouvées (${(100 * small.rate).toFixed(1)} %) ; grands marchés : ${large.found}/${large.checked} (${(100 * large.rate).toFixed(1)} %) ; ` +
        `tendance publiée (seuil de ${MARKET_TREND_MIN_SELLERS} vendeurs par semaine ; ${trend.withTrendPoint}/${trend.publishing} mondes avec au moins un point de tendance) : ${trend.found}/${trend.checked} (${(100 * trend.rate).toFixed(1)} %)`,
    );
    assert.ok(trend.withTrendPoint >= 20, `mondes à tendance publiée : ${trend.withTrendPoint} sur ${trend.publishing} (la mesure doit porter sur des tendances réellement publiées)`);
    assert.ok(small.publishing >= 150 && large.publishing >= 40 && trend.publishing >= 40, `mondes qui publient : ${small.publishing}, ${large.publishing} et ${trend.publishing}`);
    // Honnêtement : la médiane de valeurs rondes est la valeur d'UN vendeur, donc le prix d'une annonce de ce vendeur quand il n'en a qu'une (ou la médiane de ses annonces) : un adversaire qui connaît
    // tous les autres vendeurs et sait que les prix sont ronds le retrouve. La fuite décroît avec le NOMBRE DE VENDEURS (l'unité statistique), pas avec le nombre d'annonces.
    // Mesures de référence (HISTORIQUE-PRIX.md) : petits marchés 24 %, grands marchés 7 %, tendance publiée à partir de 20 vendeurs par semaine 14 % (7 % sans tendance ; 24 % quand le seuil était
    // 15 vendeurs : la tendance multiplie les occasions de tomber sur le rang médian, une par semaine en ligne ; le seuil de 20 divise la fuite par 1,7).
    assert.ok(small.rate < 0.3, `petits marchés : ${(100 * small.rate).toFixed(1)} %`);
    assert.ok(large.rate < 0.14, `grands marchés : ${(100 * large.rate).toFixed(1)} %`);
    assert.ok(trend.rate < 0.2, `tendance publiée : ${(100 * trend.rate).toFixed(1)} %`);
    assert.ok(large.rate < small.rate / 2, "la fuite décroît avec le nombre de vendeurs");
  });
});

// ───────────── (c) témoins : des publications plus faibles sont prises en défaut ─────────────

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (position - low) * (sorted[high] - sorted[low]);
}

/**
 * Valeurs par VENDEUR sur 90 jours, toutes variantes, avec le seuil de la production (5 vendeurs) mais SANS retrait des prix atypiques ni arrondi de chaque prix : seule la façon d'arrondir diffère
 * (le témoin « sans arrondi » ne dispose d'aucune protection de plus que le seuil). La valeur d'un vendeur est la médiane de ses derniers prix.
 */
function listingValues(rows: readonly MarketObservation[]): number[] | null {
  const last = new Map<string, MarketObservation>();
  for (const row of rows) if (row.day >= dayOffset(89) && (!last.has(row.referenceId) || row.day >= (last.get(row.referenceId) as MarketObservation).day)) last.set(row.referenceId, row);
  const perSeller = new Map<string, number[]>();
  for (const row of last.values()) perSeller.set(row.sellerId as string, [...(perSeller.get(row.sellerId as string) ?? []), row.priceXof]);
  if (perSeller.size < 5) return null;
  return [...perSeller.values()].map((prices) => percentile(prices, 0.5));
}

/** TÉMOIN 1 : médiane et quartiles EXACTS, sans aucun arrondi. */
const unrounded: Publisher = (rows) => {
  const values = listingValues(rows);
  return [values === null ? "insuffisant" : JSON.stringify([percentile(values, 0.25), percentile(values, 0.5), percentile(values, 0.75)])];
};

/** TÉMOIN 2 : arrondit le RÉSULTAT à 500 FCFA mais pas chaque prix. */
const roundedOutputOnly: Publisher = (rows) => {
  const values = listingValues(rows);
  const round = (value: number) => Math.floor((value + 250) / 500) * 500;
  return [values === null ? "insuffisant" : JSON.stringify([round(percentile(values, 0.25)), round(percentile(values, 0.5)), round(percentile(values, 0.75))])];
};

describe("(c) témoins : l'adversaire détecte une publication plus faible", () => {
  test("sans arrondi : le prix de l'annonce du vendeur médian d'un nombre impair de vendeurs (une annonce chacun) est retrouvé EXACTEMENT (dans tous les mondes de ce genre)", () => {
    const random = mulberry(5);
    let odd = 0;
    for (let index = 0; index < 120; index += 1) {
      const world = buildWorld(random, "single");
      const values = listingValues(world.rows);
      if (values === null || values.length % 2 === 0) continue;
      odd += 1;
      const exact = targetsOf(world).filter((target) => pinned(unrounded, world, target));
      assert.ok(exact.length >= 1, "au moins une annonce est retrouvée (celle du milieu)");
      assert.ok(exact.some((target) => target.price === percentile(values, 0.5)), "l'annonce retrouvée est la médiane");
    }
    assert.ok(odd >= 15, `${odd} mondes impairs publiés`);
  });

  test("arrondi du seul résultat : un monde construit à la main (6 vendeurs) fait retrouver un prix EXACT par qui connaît les autres, Q1 et la médiane arrondies se complétant (p − 1 change Q1, p + 1 change la médiane) ; la production, sur le MÊME monde, jamais", () => {
    // Valeurs triées v0..v5 : Q1 = 0,75 × v1 + 0,25 × p = 150 250 (juste au-dessus de la frontière 150 250 → arrondi 150 500) et la médiane = (p + v3) / 2 = 310 749,5 (juste sous la frontière 310 750).
    // Avec p = 301 000 : p − 1 ramène Q1 à 150 249,75 (arrondi 150 000), p + 1 porte la médiane à 310 750 (arrondi 311 000) : aucun autre prix ne donne les mêmes trois chiffres arrondis.
    const prices = [90_000, 100_000, 301_000, 320_499, 330_000, 340_000];
    const world: World = { rows: prices.map((priceXof, index) => ({ referenceId: `listing-${index}`, sellerId: `seller-${index}`, day: TODAY, priceXof, variantKey: "128 go", conditionKey: "occasion" })) };
    const target: Target = { referenceId: "listing-2", price: 301_000 };
    assert.equal(roundedOutputOnly(world.rows)[0], JSON.stringify([150_500, 310_500, 327_500]), "publication du témoin pour p (calculée à la main : 150 250, 310 749,5, 327 624,75 arrondis)");
    assert.equal(pinned(roundedOutputOnly, world, target), true, "arrondir seulement le résultat laisse retrouver le prix exact");
    assert.equal(pinned(production, world, target), false, "la production protège la même cible du même monde");
    // Les prix voisins (± 1, ± 249, la même tranche de 500) donnent les mêmes quatre réponses.
    const reference = production(world.rows);
    for (const delta of [-249, -1, 1, 249]) assert.equal(sameAnswers(production, withPrice(world, "listing-2", 301_000 + delta), reference), true, `p ${delta >= 0 ? "+" : "−"} ${Math.abs(delta)}`);
  });

  /** TÉMOIN 3 : PUBLIER LES PRIX DE VENTE (Q1, médiane, Q3 arrondis à 500) avec les seuils de la première version : 5 ventes de 4 acheteurs et 4 vendeurs. */
  interface Sale { price: number; buyer: string; seller: string }
  const salesPublisher = (sales: readonly Sale[]): string | null => {
    if (sales.length < 5 || new Set(sales.map((sale) => sale.buyer)).size < 4 || new Set(sales.map((sale) => sale.seller)).size < 4) return null;
    const round = (value: number) => Math.floor((value + 250) / 500) * 500;
    const prices = sales.map((sale) => sale.price);
    return JSON.stringify([round(percentile(prices, 0.25)), round(percentile(prices, 0.5)), round(percentile(prices, 0.75))]);
  };

  test("ventes publiées : avec cinq ventes, Q1, la médiane et Q3 SONT les 2e, 3e et 4e prix réels (prix ronds : retrouvés exactement) ; l'adversaire réussit dans 100 % des mondes de cinq ventes", () => {
    const random = mulberry(55);
    let worlds = 0;
    for (let index = 0; index < 100; index += 1) {
      const prices = new Set<number>();
      while (prices.size < 5) prices.add(5_000 * (20 + Math.floor(random() * 20)));
      const sales: Sale[] = [...prices].map((price, rank) => ({ price, buyer: `B${rank}`, seller: `S${rank}` }));
      const published = JSON.parse(salesPublisher(sales) as string) as number[];
      const sorted = [...prices].sort((a, b) => a - b);
      assert.deepEqual(published, [sorted[1], sorted[2], sorted[3]], "les trois statistiques sont des prix de vente exacts");
      // L'adversaire (qui connaît les ventes des autres) retrouve la cible quand son rang est 2, 3 ou 4 : aucun autre prix rond ne donne la même publication.
      let recovered = 0;
      for (const [position, sale] of sales.entries()) {
        const same = (price: number) => salesPublisher(sales.map((entry, otherPosition) => (otherPosition === position ? { ...entry, price } : entry))) === JSON.stringify(published);
        let unique = true;
        for (let step = -20; step <= 20 && unique; step += 1) {
          const candidate = sale.price + step * 5_000;
          if (step !== 0 && candidate >= 5_000 && same(candidate)) unique = false;
        }
        if (unique) recovered += 1;
      }
      assert.ok(recovered >= 3, `${recovered} vente(s) retrouvée(s)`);
      worlds += 1;
    }
    assert.equal(worlds, 100);
  });

  test("sybille sur les ventes publiées : 3 comptes et 4 ventes fictives (1 000, 1 500, 99 000 000, 100 000 000) font publier EXACTEMENT le prix de la vente visée", () => {
    const target = 158_000;
    const sales: Sale[] = [
      { price: 1_000, buyer: "A1", seller: "A2" },
      { price: 1_500, buyer: "A2", seller: "A3" },
      { price: 99_000_000, buyer: "A3", seller: "A1" },
      { price: 100_000_000, buyer: "A1", seller: "A3" },
      { price: target, buyer: "vrai-acheteur", seller: "vrai-vendeur" },
    ];
    assert.equal(salesPublisher(sales.slice(0, 4)), null, "sans la vente visée : « pas assez de données »");
    assert.equal((JSON.parse(salesPublisher(sales) as string) as number[])[1], target, "avec elle : la médiane publiée EST le prix de la vente visée, et le passage à « publié » en révèle le moment");
  });

  test("la production ne publie AUCUN prix de vente : aucune clé « sales » dans la réponse, quoi que contienne le monde", () => {
    const random = mulberry(77);
    for (let index = 0; index < 50; index += 1) {
      const world = buildWorld(random, "random");
      for (const answer of production(world.rows)) {
        assert.deepEqual(Object.keys(JSON.parse(answer)).sort(), ["contractVersion", "currency", "listings", "period", "roundingXof"]);
        assert.ok(!/sale|vente|buyer|acheteur/i.test(answer));
      }
    }
  });

  test("LIMITE DOCUMENTÉE : la sybille sur les annonces fixe la médiane sur un prix DEMANDÉ visé, mais il faut QUATRE faux vendeurs (quatre numéros vérifiés) ; avec trois, rien n'est publié", () => {
    const target = 158_000;
    const fake = (price: number, seller: string, index: number): MarketObservation => ({ referenceId: `fake-${index}`, sellerId: seller, day: TODAY, priceXof: price, variantKey: "128 go", conditionKey: "occasion" });
    const victim: MarketObservation = { referenceId: "visee", sellerId: "vrai-vendeur", day: TODAY, priceXof: target, variantKey: "128 go", conditionKey: "occasion" };
    // Quatre faux comptes, chacun avec plusieurs annonces (le nombre d'annonces ne sert à rien : une seule valeur par vendeur) : 1 000, 1 500, 99 000 000, 100 000 000.
    const four: MarketObservation[] = [
      fake(1_000, "A1", 1), fake(1_000, "A1", 11), fake(1_500, "A2", 2), fake(99_000_000, "A3", 3), fake(99_000_000, "A3", 33), fake(100_000_000, "A4", 4), victim,
    ];
    const answer = JSON.parse(production(four)[0]) as { listings: { status: string; median?: number } };
    assert.equal(answer.listings.status, "published");
    assert.equal(answer.listings.median, target, "limite assumée, documentée : le prix demandé d'une annonce visée est retrouvé avec 4 comptes");
    // Trois faux comptes (même avec 100 annonces chacun) et la cible : 4 vendeurs, « pas assez de données ».
    const three: MarketObservation[] = [
      ...Array.from({ length: 100 }, (_, index) => fake(1_000, "A1", 100 + index)),
      ...Array.from({ length: 100 }, (_, index) => fake(99_000_000, "A2", 300 + index)),
      ...Array.from({ length: 100 }, (_, index) => fake(100_000_000, "A3", 500 + index)),
      victim,
    ];
    assert.equal((JSON.parse(production(three)[0]) as { listings: { status: string } }).listings.status, "insufficient", "trois comptes ne suffisent pas, quel que soit leur nombre d'annonces");
  });
});

// ───────────── (e) un seul compte, des complices ─────────────

describe("(e) un vendeur (ou des complices) qui publie beaucoup d'annonces : une seule valeur par vendeur", () => {
  /** Les 4 lectures sont inutiles ici : la période de 90 jours, la variante demandée. */
  const read = (rows: readonly MarketObservation[]) => computeMarketStats(rows, { ...baseRequest, periodDays: 90, variantKey: "128 go" }).listings;

  /** Valeur d'un vendeur honnête : une annonce, un prix tiré dans une plage serrée (aucun prix atypique parmi les honnêtes). */
  function honestRows(random: () => number, count: number): { rows: MarketObservation[]; values: number[] } {
    const rows: MarketObservation[] = [];
    for (let index = 0; index < count; index += 1) rows.push({ referenceId: `h-${index}`, sellerId: `honnete-${index}`, day: dayOffset(Math.floor(random() * 29)), priceXof: 150_000 + Math.floor(random() * 30) * 1_000, variantKey: "128 go", conditionKey: "occasion" });
    // Les valeurs retenues par la production pour les seuls honnêtes (oracle indépendant : prix arrondis à 500, triés).
    return { rows, values: rows.map((row) => Math.floor((row.priceXof + 250) / 500) * 500).sort((a, b) => a - b) };
  }

  function attackerRows(seller: string, count: number, price: number): MarketObservation[] {
    return Array.from({ length: count }, (_, index) => ({ referenceId: `${seller}-${index}`, sellerId: seller, day: dayOffset(index % 29), priceXof: price, variantKey: "128 go", conditionKey: "occasion" }));
  }

  /** Oracle INDÉPENDANT de la production : prix arrondis à 500, bornes Q1 − 1,5 × IQR et Q3 + 1,5 × IQR, médiane des valeurs retenues arrondie. */
  function oracle(values: readonly number[]): { median: number | null; keeps: (value: number) => boolean } {
    const rounded = values.map((value) => Math.floor((value + 250) / 500) * 500);
    const q1 = percentile(rounded, 0.25);
    const q3 = percentile(rounded, 0.75);
    const keeps = (value: number) => value >= q1 - 1.5 * (q3 - q1) && value <= q3 + 1.5 * (q3 - q1);
    const kept = rounded.filter(keeps);
    return { median: kept.length < 5 ? null : Math.floor((percentile(kept, 0.5) + 250) / 500) * 500, keeps };
  }

  test("UN compte, 1 à 500 annonces, n'importe quel prix : la médiane reste dans l'étendue des honnêtes, et entre les voisins immédiats de la médiane honnête (au plus une position) tant que le compte ne fait écarter aucun honnête", () => {
    const random = mulberry(20_261_007);
    const prices = [1, 500, 10_000, 120_000, 150_000, 165_000, 179_500, 200_000, 1_000_000, 99_000_000];
    const counts = [1, 2, 6, 50, 500];
    let worlds = 0;
    let onePosition = 0;
    let fenceShifts = 0;
    for (let index = 0; index < 400; index += 1) {
      const honestCount = 5 + Math.floor(random() * 11);
      const { rows, values } = honestRows(random, honestCount);
      const baseline = read(rows);
      // Les honnêtes seuls doivent publier sans prix atypique : sinon l'oracle ci-dessous (qui suppose que tous les honnêtes sont retenus) ne s'applique pas.
      if (baseline.status !== "published" || baseline.excluded !== null) continue;
      worlds += 1;
      const n = values.length;
      const round = (value: number) => Math.floor((value + 250) / 500) * 500;
      // n impair : n + 1 valeurs, médiane = moyenne de deux valeurs voisines du milieu → [(h[m−1] + h[m]) / 2 ; (h[m] + h[m+1]) / 2] ; n pair : la médiane est une valeur → [h[n/2 − 1] ; h[n/2]].
      const lower = n % 2 === 1 ? round((values[(n - 1) / 2 - 1] + values[(n - 1) / 2]) / 2) : values[n / 2 - 1];
      const upper = n % 2 === 1 ? round((values[(n - 1) / 2] + values[(n - 1) / 2 + 1]) / 2) : values[n / 2];
      for (const price of [prices[Math.floor(random() * prices.length)], prices[Math.floor(random() * prices.length)]]) {
        const count = counts[Math.floor(random() * counts.length)];
        const outcome = read([...rows, ...attackerRows("attaquant", count, price)]);
        assert.equal(outcome.status, "published");
        if (outcome.status !== "published") continue;
        assert.ok(outcome.median >= values[0] && outcome.median <= values[n - 1], `${n} honnêtes, ${count} annonces à ${price} : médiane ${outcome.median} hors de l'étendue des honnêtes`);
        const expected = oracle([...values, price]);
        assert.equal(outcome.median, expected.median, "la production et l'oracle indépendant publient la même médiane");
        if (values.every((value) => expected.keeps(value))) {
          onePosition += 1;
          assert.ok(outcome.median >= lower && outcome.median <= upper, `${n} honnêtes, ${count} annonces à ${price} : médiane ${outcome.median} hors de [${lower} ; ${upper}]`);
        } else {
          fenceShifts += 1; // le compte a resserré l'écart interquartile et fait écarter un honnête à la frontière : la médiane reste dans leur étendue
        }
      }
    }
    console.log(`[adversaire/un compte] ${onePosition} attaques à une position au plus, ${fenceShifts} avec un honnête de la frontière écarté (sur ${2 * worlds})`);
    assert.ok(worlds >= 200 && onePosition >= 300, `${worlds} marchés, ${onePosition} attaques vérifiées`);
    assert.ok(fenceShifts < onePosition / 4, `${fenceShifts} déplacements par la frontière des prix atypiques`);
  });

  test("DES COMPLICES moins nombreux que les honnêtes (k < n) ne sortent jamais la médiane de l'étendue des honnêtes, quels que soient leurs prix et leur nombre d'annonces", () => {
    const random = mulberry(424_242);
    let worlds = 0;
    for (let index = 0; index < 200; index += 1) {
      const honestCount = 5 + Math.floor(random() * 8);
      const { rows, values } = honestRows(random, honestCount);
      const colluders = 1 + Math.floor(random() * (honestCount - 1)); // 1 à n − 1
      const attack: MarketObservation[] = [];
      for (let seller = 0; seller < colluders; seller += 1) {
        const price = [1, 10_000, 120_000, values[0], values[honestCount - 1], values[Math.floor(honestCount / 2)], 200_000, 99_000_000][Math.floor(random() * 8)];
        attack.push(...attackerRows(`complice-${seller}`, 1 + Math.floor(random() * 30), price));
      }
      const outcome = read([...rows, ...attack]);
      if (outcome.status !== "published") continue; // les complices peuvent faire tomber un marché sous le seuil (déni de publication), jamais le fausser
      worlds += 1;
      assert.ok(outcome.median >= values[0] && outcome.median <= values[honestCount - 1], `${honestCount} honnêtes, ${colluders} complices : médiane ${outcome.median} hors de [${values[0]} ; ${values[honestCount - 1]}]`);
    }
    assert.ok(worlds >= 120, `${worlds} marchés vérifiés`);
  });

  test("LIMITE DOCUMENTÉE : des complices aussi nombreux que les honnêtes (n comptes pour n vendeurs) peuvent fixer la médiane hors de l'étendue des honnêtes", () => {
    const random = mulberry(5);
    const { rows, values } = honestRows(random, 6);
    const outcome = read([...rows, ...Array.from({ length: 6 }, (_, seller) => attackerRows(`complice-${seller}`, 3, 100_000)).flat()]);
    assert.equal(outcome.status, "published");
    if (outcome.status === "published") assert.ok(outcome.median < values[0], `médiane ${outcome.median} contre ${values[0]}`);
  });
});

// ───────────── (d) utilité ─────────────

describe("(d) utilité : la publication reste informative", () => {
  test("sur des annonces tirées au hasard, la médiane publiée est à 500 FCFA de la médiane des prix demandés RETENUS (oracle indépendant : bornes de 1,5 × IQR sur les prix arrondis)", () => {
    const random = mulberry(123);
    let compared = 0;
    const round500 = (value: number) => Math.floor((value + 250) / 500) * 500;
    for (let index = 0; index < 300; index += 1) {
      const count = 5 + Math.floor(random() * 20);
      const prices = Array.from({ length: count }, () => 140_000 + Math.floor(random() * 40_000));
      const rows: MarketObservation[] = prices.map((priceXof, position) => ({ referenceId: `x${position}`, sellerId: `s${position}`, day: dayOffset(position % 29), priceXof, variantKey: "128 go", conditionKey: "occasion" }));
      const stats = computeMarketStats(rows, { ...baseRequest, periodDays: 30, variantKey: "128 go" });
      // Oracle : les prix arrondis, les bornes Q1 − 1,5 × IQR et Q3 + 1,5 × IQR, la médiane des prix retenus (non arrondie).
      const rounded = prices.map(round500);
      const q1 = percentile(rounded, 0.25);
      const q3 = percentile(rounded, 0.75);
      const retained = prices.filter((_, position) => rounded[position] >= q1 - 1.5 * (q3 - q1) && rounded[position] <= q3 + 1.5 * (q3 - q1));
      if (retained.length < 5) {
        assert.equal(stats.listings.status, "insufficient");
        continue;
      }
      assert.equal(stats.listings.status, "published");
      if (stats.listings.status !== "published") continue;
      compared += 1;
      const exactMedian = percentile(retained, 0.5);
      assert.ok(Math.abs(stats.listings.median - exactMedian) <= 500, `${stats.listings.median} contre ${exactMedian}`);
    }
    assert.ok(compared >= 150, `${compared} mondes comparés`);
  });

  test("avec des vendeurs de plusieurs annonces : la médiane publiée est à 500 FCFA de la médiane des valeurs par vendeur RETENUES (oracle indépendant : médiane des prix arrondis de chaque vendeur, bornes de 1,5 × IQR)", () => {
    const random = mulberry(321);
    let compared = 0;
    const round500 = (value: number) => Math.floor((value + 250) / 500) * 500;
    for (let index = 0; index < 300; index += 1) {
      const sellersCount = 5 + Math.floor(random() * 10);
      const rows: MarketObservation[] = [];
      const bySeller = new Map<number, number[]>();
      for (let listing = 0; listing < sellersCount * 3; listing += 1) {
        const seller = listing < sellersCount ? listing : Math.floor(random() * sellersCount);
        const priceXof = 140_000 + Math.floor(random() * 40_000);
        rows.push({ referenceId: `y${listing}`, sellerId: `s${seller}`, day: dayOffset(listing % 29), priceXof, variantKey: "128 go", conditionKey: "occasion" });
        bySeller.set(seller, [...(bySeller.get(seller) ?? []), round500(priceXof)]);
      }
      const stats = computeMarketStats(rows, { ...baseRequest, periodDays: 30, variantKey: "128 go" });
      const sellerValues = [...bySeller.values()].map((prices) => round500(percentile(prices, 0.5)));
      const q1 = percentile(sellerValues, 0.25);
      const q3 = percentile(sellerValues, 0.75);
      const retained = sellerValues.filter((value) => value >= q1 - 1.5 * (q3 - q1) && value <= q3 + 1.5 * (q3 - q1));
      if (retained.length < 5) {
        assert.equal(stats.listings.status, "insufficient");
        continue;
      }
      assert.equal(stats.listings.status, "published");
      if (stats.listings.status !== "published") continue;
      compared += 1;
      assert.ok(Math.abs(stats.listings.median - percentile(retained, 0.5)) <= 500, `${stats.listings.median} contre ${percentile(retained, 0.5)}`);
    }
    assert.ok(compared >= 150, `${compared} mondes comparés`);
  });
});
