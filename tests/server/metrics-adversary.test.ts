import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { adversary, makeSpace, sumWorld, type Space, type Verdict, type World } from "./metrics-adversary-engine";
import { exactRatioAdapter, locatePublished, nearestRoundingAdapter, productionAdapter } from "./metrics-adversary-adapter";
import { legacyAdapter } from "./metrics-adversary-legacy-adapter";
import { STRUCTURES, cellVector, enumerateProfiles, type Profile, type Structure } from "./metrics-adversary-model";
import { roundedAdversary, type RoundedAdapter, type RoundedVerdict } from "./metrics-adversary-rounded";
import { auditorRealisticWorld, exactOfRealistic, rawOfRealistic, realisticWorlds, type RealisticWorld } from "./metrics-adversary-utility";
import { maxPerBuyer, mulberry, profileWeight, randomUnsaturatedLargeWorld, randomUnsaturatedWorld } from "./metrics-adversary-worlds";
import { buildOfferStats } from "../../lib/server/metrics/stats";

/**
 * ADVERSAIRE INDÉPENDANT des statistiques du vendeur (lots M1-ter et M1-quater). Ce test n'importe RIEN de privacy.ts : seulement la fonction de publication
 * (`buildOfferStats`, via l'adaptateur) et un générateur de mondes (tests/server/metrics-adversary-*.ts).
 *
 * L'adversaire lit UNE réponse (la réponse JSON complète) et connaît tout ce que sait le vendeur : ses boosts et leurs dates, la date de lecture, les règles
 * d'attribution et la définition de chaque chiffre. Il cherche des MONDES (multiensembles d'acheteurs, chacun décrit par ses événements atomiques : apparitions,
 * ouvertures, contact) qui publient EXACTEMENT la même réponse. Critères d'acceptation :
 *  (a) pour toute valeur vraie de 0 à 4 d'un chiffre (acheteurs ou événements, publié ou non) ET de toute différence de deux chiffres emboîtés (total moins part, période
 *      longue moins courte, total moins boost), au moins DEUX valeurs sont compatibles avec la réponse (des TÉMOINS, vérifiés en rejouant la publication) ;
 *  (b) les témoins échouent à ce même test : la publication du lot M1-bis (copie figée), et la variante qui calcule les pourcentages sur les valeurs EXACTES ;
 *  (c) UTILITÉ : sur des mondes réalistes (10 à 30 acheteurs), la part attribuée au boost est publiée « environ N » dans 100 % des mondes où elle vaut au moins 5,
 *      et les taux le sont quand leurs deux termes valent au moins 10.
 * Le détail du modèle et de ses limites : MESURES.md, « Ce que l'adversaire prouve ».
 */

// ───────────── préparation des espaces de mondes ─────────────

const LEGACY_SEARCH = { cap: 8, maxCandidates: 20_000 } as const;

interface Prepared { structure: Structure; space: Space; light: number[]; limits: Int16Array }

const PREPARED = new Map<number, Prepared>();
function prepared(index: number): Prepared {
  let found = PREPARED.get(index);
  if (!found) {
    const structure = STRUCTURES[index];
    const { profiles, vectors } = enumerateProfiles(structure);
    const space = makeSpace(structure, profiles, vectors);
    found = { structure, space, light: [...space.vectors.keys()].filter((id) => profileWeight(space, id) <= 4), limits: maxPerBuyer(space) };
    PREPARED.set(index, found);
  }
  return found;
}

/**
 * Verdict de l'adversaire contre une publication arrondie : cap = taille du monde + `extra` acheteurs (au plus 40). La recherche est aléatoire : une quantité sans témoin
 * après un premier budget est cherchée de nouveau avec d'autres graines et des budgets plus grands (jusqu'à 3 passes, 480 000 mondes évalués au plus) ; sans témoin
 * après la dernière, le monde est « non résolu » et compte comme un ÉCHEC.
 */
const PASSES = [30_000, 150_000, 300_000] as const;
function roundedVerdict(adapter: RoundedAdapter, prep: Prepared, world: World, seed: number, extra = 6, passes: readonly number[] = PASSES): RoundedVerdict {
  let verdict: RoundedVerdict | null = null;
  for (const [pass, budget] of passes.entries()) {
    verdict = roundedAdversary(prep.space, adapter, world, {
      cap: Math.min(40, Math.max(8, world.ids.length + extra)), budget, random: mulberry(seed + 7_919 * pass), light: prep.light,
      // Sonde (hors suite) : NOMA_ADVERSARY_ZEROS=1 protège aussi les valeurs vraies de 0 (zéros dérivés compris).
      minValue: process.env.NOMA_ADVERSARY_ZEROS === "1" ? 0 : 1,
    });
    if (verdict.status === "witnesses") return verdict;
  }
  return verdict as RoundedVerdict;
}

function describeRounded(space: Space, world: World, verdict: RoundedVerdict): string {
  return `monde de ${world.ids.length} acheteurs ${JSON.stringify(world)} (${[...new Set(world.ids)].map((id) => JSON.stringify(space.profiles[id])).join(" ; ")}) : ${verdict.status}, `
    + `quantités sans second témoin ${JSON.stringify(verdict.pinned.slice(0, 5))}, mondes cohérents ${verdict.consistentWorlds}/${verdict.evaluated}`;
}

/** Un monde décrit par ses profils (plusieurs acheteurs identiques) : retrouvés par leurs chiffres, indépendamment de l'ordre d'énumération. */
function worldOfProfiles(space: Space, structure: Structure, entries: Array<[number, Profile]>, needs: number): World {
  const ids: number[] = [];
  for (const [count, profile] of entries) {
    const vector = cellVector(profile, structure);
    const found = space.vectors.findIndex((candidate) => candidate.every((value, at) => value === vector[at]));
    assert.ok(found >= 0, `profil absent du modèle : ${JSON.stringify(profile)}`);
    for (let copy = 0; copy < count; copy++) ids.push(found);
  }
  return { ids: ids.sort((a, b) => a - b), needs };
}

const view = (slot: number, boost: number | null = null) => ({ slot, boost });
const serve = (slot: number, servings: number, sponsored: number, boost = 0) => ({ boost, slot, servings, sponsored });

/** Le jeu K1 de l'audit de M1-bis : 4 ouvreurs (3 attribués au boost, 1 organique), 7 ouvertures (6 attribuées) ; 3 contacts (2 attribués, 1 organique). */
function k1World(space: Space, structure: Structure): World {
  const attributed = (contact: boolean): Profile => ({
    serves: [serve(2, 1, 1)], views: [view(2, 0), view(3, 0)], contact: contact ? { slot: 3, boost: 0, reveals: 1 } : null,
  });
  const organic: Profile = { serves: [], views: [view(3)], contact: { slot: 3, boost: null, reveals: 1 } };
  return worldOfProfiles(space, structure, [[2, attributed(true)], [1, attributed(false)], [1, organic]], 4);
}

const K1_STRUCTURES = [1, 7];

// ───────────── le modèle et la publication disent la même chose ─────────────

/** Arrondi attendu, réécrit ICI (indépendamment de privacy.ts) : « moins de 5 » de 0 à 4 ; « environ 5 » de 5 à 8 ; au-delà le multiple de 5 le plus proche (9 à 12 → 10 ; 13 à 17 → 15…). */
function expectedRound(value: number): { kind: "below"; bound: number } | { kind: "approx"; value: number } {
  if (value < 5) return { kind: "below", bound: 5 };
  if (value <= 8) return { kind: "approx", value: 5 };
  return { kind: "approx", value: Math.floor((2 * value + 5) / 10) * 5 };
}

describe("adversaire : le modèle de monde et la publication disent la même chose", () => {
  test("tout compte publié vaut l'arrondi de la définition recalculée depuis les événements ; AUCUN nombre exact dans la réponse (100 mondes par structure)", () => {
    STRUCTURES.forEach((_, index) => {
      const { space, light, limits } = prepared(index);
      const random = mulberry(7_000 + index);
      for (let draw = 0; draw < 100; draw++) {
        const world = draw % 2 === 0 ? randomUnsaturatedWorld(space, random, 6, light, limits) : randomUnsaturatedLargeWorld(space, random, 7, 30, light, limits);
        const y = sumWorld(space, world.ids);
        const response = productionAdapter.publish(productionAdapter.rawOf(y, world.needs, space.structure));
        space.specs.forEach((spec, cell) => {
          for (const place of locatePublished(response, spec.name)) {
            assert.deepEqual(place, expectedRound(y[cell]), `${space.structure.name} : ${spec.name} publié ${JSON.stringify(place)}, défini ${y[cell]} : ${JSON.stringify(world)}`);
          }
        });
        // Aucun nombre de la réponse n'est un compte exact : seulement `bound` (5), `value` (multiples de 5 ou de 10) ; les dates et identifiants sont des textes.
        const walk = (node: unknown, path: string): void => {
          if (typeof node === "number") {
            const key = path.split(".").pop() as string;
            if (key === "bound") assert.equal(node, 5, path);
            else if (key === "value") assert.ok(node % 5 === 0 && node >= 0 && node <= Math.max(100, y.reduce((m, v) => Math.max(m, v), 0) + 5), `${path} = ${node}`);
            else assert.fail(`nombre nu dans la réponse : ${path} = ${node}`);
          } else if (node instanceof Date) {
            return;
          } else if (Array.isArray(node)) node.forEach((entry, at) => walk(entry, `${path}.${at}`));
          else if (node !== null && typeof node === "object") for (const [key, entry] of Object.entries(node)) walk(entry, `${path}.${key}`);
        };
        walk(response, "réponse");
        const needs = (response as { activeMatches: { needs: unknown } }).activeMatches.needs;
        assert.deepEqual(needs, expectedRound(world.needs), "besoins correspondants arrondis");
      }
    });
  });

  test("les structures couvrent 0, 1 et 2 boosts, une annonce jeune, des boosts anciens, récents et à cheval sur les périodes", () => {
    assert.deepEqual([...new Set(STRUCTURES.map((structure) => structure.boosts.length))].sort(), [0, 1, 2]);
    assert.ok(STRUCTURES.some((structure) => structure.offerAge < 30), "annonce plus jeune que 30 jours");
    assert.ok(STRUCTURES.length >= 9);
  });
});

describe("adversaire : annonce sans boost", () => {
  test("aucune cellule d'exposition ni de part attribuée ni de taux d'ouverture n'est publiée : tout est organique (le taux de contact des ouvreurs, lui, l'est)", () => {
    const { space, light, limits } = prepared(0);
    const random = mulberry(31);
    for (let draw = 0; draw < 60; draw++) {
      const world = randomUnsaturatedLargeWorld(space, random, 1, 30, light, limits);
      const response = productionAdapter.publish(productionAdapter.rawOf(sumWorld(space, world.ids), world.needs, space.structure)) as ReturnType<typeof buildOfferStats>;
      assert.deepEqual(response.boosts, []);
      for (const period of response.periods) {
        assert.equal(period.exposure, null);
        assert.equal(period.opens.attributedToBoost, null);
        assert.equal(period.contacts.attributedToBoost, null);
        assert.equal(period.ratios.openRate, null);
        assert.ok(period.ratios.contactRate.kind === "percent" || period.ratios.contactRate.kind === "insufficient");
      }
    }
  });
});

// ───────────── (a) l'adversaire ne trouve aucun petit compte ───────────────

describe("adversaire (a) : le jeu K1 de l'audit et des mondes construits", () => {
  for (const index of K1_STRUCTURES) {
    test(`K1, ${STRUCTURES[index].name} : 4 ouvreurs publiés « moins de 5 », aucune quantité de 0 à 4 ne se déduit (témoins)`, () => {
      const prep = prepared(index);
      const world = k1World(prep.space, prep.structure);
      const y = sumWorld(prep.space, world.ids);
      assert.equal(y[prep.space.specs.findIndex((spec) => spec.name === "all.openers")], 4);
      assert.equal(y[prep.space.specs.findIndex((spec) => spec.name === "all.opens")], 7);
      const verdict = roundedVerdict(productionAdapter, prep, world, 1);
      assert.equal(verdict.status, "witnesses", describeRounded(prep.space, world, verdict));
      const stats = productionAdapter.publish(productionAdapter.rawOf(y, world.needs, prep.structure)) as ReturnType<typeof buildOfferStats>;
      const all = stats.periods.find((period) => period.period === "all")!;
      assert.deepEqual(all.opens.uniqueBuyers, { kind: "below", bound: 5 });
      assert.deepEqual(all.opens.total, { kind: "approx", value: 5 }, "7 ouvertures : environ 5");
    });
  }

  const cases: Array<{ label: string; structure: number; entries: Array<[number, Profile]>; needs: number }> = [
    {
      label: "6 ouvreurs dont 5 attribués au boost et 1 organique : total « environ 5 », part « environ 5 », la différence (1) n'est pas déterminée",
      structure: 4, needs: 6, entries: [
        [5, { serves: [serve(3, 2, 2)], views: [view(3, 0)], contact: null }],
        [1, { serves: [], views: [view(3)], contact: null }],
      ],
    },
    {
      label: "7 ouvreurs dont 5 attribués et 2 organiques (total 7 et part 5 : « environ 5 » et « environ 5 », différence 2)",
      structure: 4, needs: 7, entries: [
        [5, { serves: [serve(3, 2, 2)], views: [view(3, 0)], contact: null }],
        [2, { serves: [], views: [view(3)], contact: null }],
      ],
    },
    {
      label: "12 acheteurs exposés dont 11 ont ouvert : le taux d'ouverture « environ 100 % » (calculé sur « environ 10 » et « environ 10 ») ne dit pas qu'un acheteur exposé n'a pas ouvert",
      structure: 4, needs: 12, entries: [
        [11, { serves: [serve(3, 2, 2)], views: [view(3, 0)], contact: null }],
        [1, { serves: [serve(3, 1, 0)], views: [], contact: null }],
      ],
    },
    {
      label: "13 acheteurs exposés dont 12 ont ouvert (arrondis 15 et 10)",
      structure: 4, needs: 13, entries: [
        [12, { serves: [serve(3, 2, 2)], views: [view(3, 0)], contact: null }],
        [1, { serves: [serve(3, 1, 0)], views: [], contact: null }],
      ],
    },
    {
      label: "5 acheteurs qui ont ouvert UNE fois, il y a 1 jour, après un contact organique : aucune ouverture attribuée n'est possible hors des 7 derniers jours",
      structure: 2, needs: 1, entries: [[5, { serves: [], views: [view(3)], contact: { slot: 1, boost: null, reveals: 2 } }]],
    },
    {
      label: "6 acheteurs, 3 ouvertures chacun (18 ouvertures) : des mondes plus petits ou plus grands donnent la même réponse",
      structure: 1, needs: 5, entries: [[6, { serves: [], views: [view(0), view(2), view(3)], contact: null }]],
    },
    {
      label: "10 acheteurs servis sponsorisés il y a 45 jours, contact attribué ce jour-là, deux ouvertures organiques chacun",
      structure: 2, needs: 6, entries: [[10, { serves: [serve(0, 1, 1)], views: [view(1), view(3)], contact: { slot: 0, boost: 0, reveals: 1 } }]],
    },
    {
      label: "deux boosts : 8 acheteurs du premier, 8 du second, 2 sans boost",
      structure: 5, needs: 3, entries: [
        [8, { serves: [serve(1, 1, 1, 0)], views: [view(1, 0)], contact: null }],
        [8, { serves: [serve(2, 1, 1, 1)], views: [view(2, 1)], contact: { slot: 2, boost: 1, reveals: 1 } }],
        [2, { serves: [], views: [view(3)], contact: null }],
      ],
    },
  ];
  for (const entry of cases) {
    test(entry.label, () => {
      const prep = prepared(entry.structure);
      const world = worldOfProfiles(prep.space, prep.structure, entry.entries, entry.needs);
      const verdict = roundedVerdict(productionAdapter, prep, world, 99);
      assert.equal(verdict.status, "witnesses", describeRounded(prep.space, world, verdict));
    });
  }
});

describe("adversaire (a) : mondes tirés au hasard", () => {
  // Réglages d'un passage plus long (hors suite) : NOMA_ADVERSARY_WORLDS = mondes par structure et par famille (défaut 120), NOMA_ADVERSARY_SEED = autre graine (défaut 0).
  const PER_STRUCTURE = Number(process.env.NOMA_ADVERSARY_WORLDS ?? 120);
  const SEED = Number(process.env.NOMA_ADVERSARY_SEED ?? 0) * 100_000;

  function run(label: string, minBuyers: number, maxBuyers: number, baseSeed: number): { worlds: number; protectedTotal: number; derivedTotal: number; approxWorlds: number } {
    const seen = { worlds: 0, protectedTotal: 0, derivedTotal: 0, approxWorlds: 0 };
    STRUCTURES.forEach((_, index) => {
      const prep = prepared(index);
      const random = mulberry(baseSeed + index + SEED);
      for (let draw = 0; draw < PER_STRUCTURE; draw++) {
        const world = randomUnsaturatedLargeWorld(prep.space, random, minBuyers, maxBuyers, prep.light, prep.limits);
        const verdict = roundedVerdict(productionAdapter, prep, world, 1_000 * index + draw + SEED);
        assert.equal(verdict.status, "witnesses", `${label} · ${prep.space.structure.name} : ${describeRounded(prep.space, world, verdict)}`);
        seen.worlds++;
        seen.protectedTotal += verdict.protectedCount;
        seen.derivedTotal += verdict.derivedCount;
        const response = JSON.stringify(productionAdapter.publish(productionAdapter.rawOf(sumWorld(prep.space, world.ids), world.needs, prep.space.structure)));
        if (response.includes('"approx"')) seen.approxWorlds++;
      }
    });
    return seen;
  }

  test("de 1 à 6 acheteurs (mondes d'au plus 12 acheteurs) : chaque chiffre de 1 à 4 (acheteurs ou événements) et chaque différence emboîtée de 1 à 4 ont au moins deux valeurs possibles", (t) => {
    const seen = run("1 à 6", 1, 6, 20_261_007);
    t.diagnostic(`mondes ${seen.worlds}, quantités protégées ${seen.protectedTotal}, dont différences emboîtées ${seen.derivedTotal}, mondes avec « environ N » ${seen.approxWorlds}`);
    assert.ok(seen.worlds >= 1_000, `mondes : ${seen.worlds}`);
    // Le test n'est pas vide : de nombreuses quantités protégées, dont des différences emboîtées, dans chaque famille de mondes.
    assert.ok(seen.protectedTotal > 20_000, `quantités protégées examinées : ${seen.protectedTotal}`);
    assert.ok(seen.derivedTotal > 2_000, `différences emboîtées examinées : ${seen.derivedTotal}`);
  });

  test("de 7 à 30 acheteurs (arrondis à 5, 10, 15… : les bornes de l'arrondi se jouent là) : mêmes garanties", (t) => {
    const seen = run("7 à 30", 7, 30, 30_261_007);
    t.diagnostic(`mondes ${seen.worlds}, quantités protégées ${seen.protectedTotal}, dont différences emboîtées ${seen.derivedTotal}, mondes avec « environ N » ${seen.approxWorlds}`);
    assert.ok(seen.worlds >= 1_000, `mondes : ${seen.worlds}`);
    assert.ok(seen.protectedTotal > 5_000, `quantités protégées examinées : ${seen.protectedTotal}`);
    assert.ok(seen.derivedTotal > 1_000, `différences emboîtées examinées : ${seen.derivedTotal}`);
    assert.ok(seen.approxWorlds > seen.worlds * 0.8, `mondes qui publient un « environ N » : ${seen.approxWorlds}`);
  });

  test("les besoins correspondants : de 0 à 4, la même réponse pour toutes les valeurs ; à partir de 5, l'arrondi cache au moins 3 valeurs voisines", () => {
    const { space } = prepared(0);
    const publishNeeds = (needs: number): string => JSON.stringify((productionAdapter.publish(productionAdapter.rawOf(new Int16Array(space.dims), needs, space.structure)) as ReturnType<typeof buildOfferStats>).activeMatches.needs);
    const byResponse = new Map<string, number[]>();
    for (let needs = 0; needs <= 80; needs++) byResponse.set(publishNeeds(needs), [...(byResponse.get(publishNeeds(needs)) ?? []), needs]);
    for (const [response, values] of byResponse) {
      if (response.includes("below")) assert.deepEqual(values, [0, 1, 2, 3, 4]);
      else assert.ok(values.length >= 3, `${response} : ${values.join(",")}`);
    }
  });
});

// ───────────── (b) les témoins échouent ────────────────────────────────────────

describe("adversaire (b) : les témoins échouent au même test", () => {
  test("TÉMOIN : la publication du lot M1-bis (copie figée) laisse retrouver le 1 organique et le 6 / 3 par identité linéaire exacte (valable pour toute taille de monde)", () => {
    for (const index of K1_STRUCTURES) {
      const { space, structure } = prepared(index);
      const world = k1World(space, structure);
      const verdict = adversary(space, legacyAdapter, world, { ...LEGACY_SEARCH, random: mulberry(1) });
      assert.equal(verdict.status, "leak-proven", `${structure.name} : ${verdict.linearLeaks.join(" ; ")}`);
      assert.ok(verdict.linearLeaks.includes("all.openersOrganic = 1"), verdict.linearLeaks.join(" ; "));
      assert.ok(verdict.linearLeaks.includes("all.opensOrganic = 1"));
      assert.ok(verdict.linearLeaks.includes("all.openersAttributed = 3"));
      assert.ok(verdict.linearLeaks.includes("all.opensAttributed = 6"));
    }
  });

  test("TÉMOIN : la publication du lot M1-bis échoue à ce même test (identités linéaires exactes) sur une large part des mondes à boost, et sur tous les mondes sans boost (zéros structurels publiés)", () => {
    const outcome: Record<string, { failed: number; total: number }> = {};
    STRUCTURES.forEach((structure, index) => {
      const { space, light, limits } = prepared(index);
      const random = mulberry(20_261_007 + index);
      const entry = { failed: 0, total: 0 };
      for (let draw = 0; draw < 60; draw++) {
        const world = randomUnsaturatedWorld(space, random, 6, light, limits);
        const verdict: Verdict = adversary(space, legacyAdapter, world, { ...LEGACY_SEARCH, random: mulberry(draw) });
        entry.total++;
        if (verdict.status !== "witnesses") entry.failed++;
      }
      outcome[structure.name] = entry;
    });
    const withBoost = Object.entries(outcome).filter(([name]) => name !== "sans boost");
    const failedWithBoost = withBoost.reduce((sum, [, entry]) => sum + entry.failed, 0);
    const totalWithBoost = withBoost.reduce((sum, [, entry]) => sum + entry.total, 0);
    assert.ok(failedWithBoost / totalWithBoost > 0.4, `M1-bis : ${failedWithBoost} mondes en échec sur ${totalWithBoost} : ${JSON.stringify(outcome)}`);
    assert.equal(outcome["sans boost"].failed, outcome["sans boost"].total, "sans boost, M1-bis publie des zéros structurels (« moins de 3 » attribués) que l'adversaire retrouve");
  });

  test("TÉMOIN : l'arrondi au plus proche sans la tranche « environ 5 » étendue à 8 (règle initiale : 8 → « environ 10 ») laisse retrouver 4 et 4 : deux boosts de 4 ouvreurs chacun, total « environ 10 » ; la production répond « environ 5 » (5 à 8)", () => {
    const prep = prepared(5);
    const world = worldOfProfiles(prep.space, prep.structure, [
      [4, { serves: [serve(1, 1, 1, 0)], views: [view(1, 0)], contact: null }],
      [4, { serves: [serve(2, 1, 1, 1)], views: [view(2, 1)], contact: null }],
    ], 5);
    const y = sumWorld(prep.space, world.ids);
    const attributed = (adapter: RoundedAdapter): unknown => (adapter.publish(adapter.rawOf(y, world.needs, prep.structure)) as ReturnType<typeof buildOfferStats>).periods[1].opens.attributedToBoost?.uniqueBuyers;
    assert.deepEqual(attributed(nearestRoundingAdapter), { kind: "approx", value: 10 }, "8 ouvreurs attribués : environ 10 (8 à 12)");
    assert.deepEqual(attributed(productionAdapter), { kind: "approx", value: 5 }, "8 ouvreurs attribués : environ 5 (5 à 8)");
    const bad = roundedVerdict(nearestRoundingAdapter, prep, world, 5, 6, [60_000]);
    assert.equal(bad.status, "unresolved", "l'arrondi au plus proche est mis en échec");
    assert.ok(bad.pinned.some((item) => item.what === "boost0.openers" && item.value === 4), JSON.stringify(bad.pinned.slice(0, 6)));
    assert.ok(bad.pinned.some((item) => item.what === "boost1.openers" && item.value === 4));
    const good = roundedVerdict(productionAdapter, prep, world, 5);
    assert.equal(good.status, "witnesses", describeRounded(prep.space, world, good));
  });

  test("TÉMOIN : le pourcentage calculé sur les valeurs EXACTES (règle initiale) laisse retrouver un acheteur qui n'a pas ouvert : 12 acheteurs exposés dont 11 ont ouvert → « 90 % », « environ 10 », « environ 10 » ne laissent qu'une différence possible (1) ; la production, elle, répond « 100 % »", () => {
    const prep = prepared(4);
    const world = worldOfProfiles(prep.space, prep.structure, [
      [11, { serves: [serve(3, 2, 2)], views: [view(3, 0)], contact: null }],
      [1, { serves: [serve(3, 1, 0)], views: [], contact: null }],
    ], 12);
    const y = sumWorld(prep.space, world.ids);
    const ratioOf = (adapter: RoundedAdapter): unknown => (adapter.publish(adapter.rawOf(y, world.needs, prep.structure)) as ReturnType<typeof buildOfferStats>).periods[2].ratios.openRate;
    assert.deepEqual(ratioOf(exactRatioAdapter), { kind: "percent", value: 90 }, "11 sur 12 : 92 % → 90 %");
    assert.deepEqual(ratioOf(productionAdapter), { kind: "percent", value: 100 }, "« environ 10 » sur « environ 10 » : 100 %");
    const bad = roundedVerdict(exactRatioAdapter, prep, world, 5);
    assert.equal(bad.status, "unresolved", "le pourcentage sur valeurs exactes est mis en échec");
    assert.ok(bad.pinned.some((item) => item.what === "all.exposed − all.openersExposed" && item.value === 1), JSON.stringify(bad.pinned.slice(0, 6)));
    const good = roundedVerdict(productionAdapter, prep, world, 5);
    assert.equal(good.status, "witnesses", describeRounded(prep.space, world, good));
  });

  test("TÉMOIN : le pourcentage sur valeurs exactes échoue sur au moins 10 mondes tirés au hasard de 10 à 16 acheteurs (1 200 mondes) ; la production réussit sur chacun de ces mondes", (t) => {
    let exactFailures = 0;
    let productionFailures = 0;
    let worlds = 0;
    STRUCTURES.forEach((_, index) => {
      if (STRUCTURES[index].boosts.length === 0) return;
      const prep = prepared(index);
      const random = mulberry(555_000 + index);
      for (let draw = 0; draw < 150; draw++) {
        const world = randomUnsaturatedLargeWorld(prep.space, random, 10, 16, prep.light, prep.limits);
        worlds++;
        if (roundedVerdict(exactRatioAdapter, prep, world, draw + 100 * index, 6, [15_000]).status === "witnesses") continue;
        exactFailures++;
        // Sur le même monde, la publication de production (pourcentages sur les nombres publiés) a au moins deux valeurs possibles pour chaque quantité.
        if (roundedVerdict(productionAdapter, prep, world, draw + 100 * index, 6).status !== "witnesses") productionFailures++;
      }
    });
    t.diagnostic(`pourcentages sur valeurs exactes : ${exactFailures} mondes en échec sur ${worlds} ; production sur ces mêmes mondes : ${productionFailures} échec`);
    assert.equal(worlds, 1_200);
    assert.ok(exactFailures >= 10, `pourcentages sur valeurs exactes : ${exactFailures} échecs sur ${worlds} mondes`);
    assert.equal(productionFailures, 0, `production : ${productionFailures} échecs sur les ${exactFailures} mondes où les pourcentages exacts échouent`);
  });
});

// ───────────── (c) utilité ──────────────────────────────────────────────────────

describe("adversaire (c) : UTILITÉ sur des mondes réalistes (10 à 30 acheteurs)", () => {
  test("le cas de l'audit : 16 ouvreurs dont 12 attribués, 6 contacts dont 5 attribués, toute l'activité en 7 jours → environ 15 ouvreurs, environ 10 attribués, environ 5 contacts, des taux", () => {
    const world = auditorRealisticWorld();
    const exact = exactOfRealistic(world);
    assert.deepEqual([exact.openers, exact.openersAttributed, exact.contactors, exact.contactorsAttributed, exact.exposed, exact.sponsored], [16, 12, 6, 5, 20, 17]);
    const stats = buildOfferStats(rawOfRealistic(world));
    for (const period of stats.periods) {
      assert.deepEqual(period.opens.uniqueBuyers, { kind: "approx", value: 15 }, period.period);
      assert.deepEqual(period.opens.attributedToBoost?.uniqueBuyers, { kind: "approx", value: 10 });
      assert.deepEqual(period.contacts.uniqueBuyers, { kind: "approx", value: 5 });
      assert.deepEqual(period.contacts.attributedToBoost?.uniqueBuyers, { kind: "approx", value: 5 });
      assert.deepEqual(period.exposure?.buyersExposed, { kind: "approx", value: 20 });
      assert.deepEqual(period.ratios.openRate, { kind: "percent", value: 80 }, "15 ouvreurs servis (environ 15) sur 20 acheteurs servis (environ 20) : 75 % → 80 %");
      assert.deepEqual(period.ratios.contactRate, { kind: "insufficient" }, "environ 5 contacts : pas assez pour un pourcentage");
    }
    const boost = stats.boosts[0];
    assert.deepEqual(boost.attributed?.uniqueOpeners, { kind: "approx", value: 10 });
    assert.deepEqual(boost.attributed?.uniqueContacts, { kind: "approx", value: 5 });
    assert.deepEqual(boost.exposure?.buyersSponsored, { kind: "approx", value: 15 });
    assert.deepEqual(boost.ratios.openRate, { kind: "percent", value: 70 }, "environ 10 sur environ 15 : 67 % → 70 %");
    assert.deepEqual(boost.ratios.contactRate, { kind: "insufficient" });
  });

  test("2 000 mondes réalistes (tous servis sponsorisés ou une partie) : la part attribuée est publiée « environ N » dans 100 % des mondes où elle vaut au moins 5 ; les taux, quand leurs deux termes valent au moins 10", (t) => {
    const worlds = realisticWorlds(2_000, 4_242);
    const tally = { attributedEligible: 0, attributedPublished: 0, ratioEligible: 0, ratioPublished: 0, ratioTotal: 0, ratioShownWhenSmall: 0, errorSum: 0, errorMax: 0 };
    const failures: string[] = [];
    for (const [at, world] of worlds.entries()) {
      const exact = exactOfRealistic(world);
      const stats = buildOfferStats(rawOfRealistic(world));
      const [p7] = stats.periods;
      const boost = stats.boosts[0];
      const parts: Array<[string, number, unknown]> = [
        ["ouvreurs attribués (période)", exact.openersAttributed, p7.opens.attributedToBoost?.uniqueBuyers],
        ["ouvertures attribuées (période)", exact.opensAttributed, p7.opens.attributedToBoost?.opens],
        ["contacts attribués (période)", exact.contactorsAttributed, p7.contacts.attributedToBoost?.uniqueBuyers],
        ["ouvreurs attribués (boost)", exact.openersAttributed, boost.attributed?.uniqueOpeners],
        ["ouvertures attribuées (boost)", exact.opensAttributed, boost.attributed?.opens],
        ["contacts attribués (boost)", exact.contactorsAttributed, boost.attributed?.uniqueContacts],
      ];
      for (const [name, value, published] of parts) {
        if (value < 5) continue;
        tally.attributedEligible++;
        const expected = expectedRound(value);
        if (JSON.stringify(published) === JSON.stringify(expected)) tally.attributedPublished++;
        else failures.push(`monde ${at} : ${name} = ${value}, publié ${JSON.stringify(published)}`);
      }
      const ratios: Array<[string, number, number, unknown]> = [
        ["taux d'ouverture (période)", exact.openersExposed, exact.exposed, p7.ratios.openRate],
        ["taux de contact (période)", exact.contactorsOpened, exact.openers, p7.ratios.contactRate],
        ["taux d'ouverture (boost)", exact.openersAttributed, exact.sponsored, boost.ratios.openRate],
        ["taux de contact (boost)", exact.contactorsAttributed, exact.sponsored, boost.ratios.contactRate],
      ];
      for (const [name, numerator, denominator, published] of ratios) {
        tally.ratioTotal++;
        const kind = (published as { kind: string }).kind;
        if (numerator >= 10 && denominator >= 10) {
          tally.ratioEligible++;
          if (kind === "percent") {
            tally.ratioPublished++;
            const value = (published as { value: number }).value;
            const error = Math.abs(value - (100 * numerator) / denominator);
            tally.errorSum += error;
            tally.errorMax = Math.max(tally.errorMax, error);
          } else failures.push(`monde ${at} : ${name} = ${numerator}/${denominator}, publié ${JSON.stringify(published)}`);
        } else if (kind === "percent") tally.ratioShownWhenSmall++;
      }
    }
    t.diagnostic(`mondes ${worlds.length} ; parts attribuées d'au moins 5 : ${tally.attributedEligible}, publiées « environ N » : ${tally.attributedPublished} ; taux aux deux termes d'au moins 10 : ${tally.ratioEligible}, publiés : ${tally.ratioPublished} ; écart moyen ${(tally.errorSum / tally.ratioPublished).toFixed(2)} points, maximal ${tally.errorMax.toFixed(1)}`);
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} publications manquantes`);
    assert.ok(tally.attributedEligible > 5_000, `parts attribuées d'au moins 5 : ${tally.attributedEligible}`);
    assert.equal(tally.attributedPublished, tally.attributedEligible, "100 % des parts attribuées d'au moins 5 sont publiées « environ N »");
    assert.ok(tally.ratioEligible > 1_000, `taux dont les deux termes valent au moins 10 : ${tally.ratioEligible}`);
    assert.equal(tally.ratioPublished, tally.ratioEligible, "100 % des taux aux deux termes d'au moins 10 sont publiés");
    // Précision : un pourcentage calculé sur des nombres arrondis s'écarte de la valeur exacte, de peu en moyenne (jamais de plus de 40 points).
    assert.ok(tally.errorSum / tally.ratioPublished < 12, `écart moyen ${tally.errorSum / tally.ratioPublished} points`);
    assert.ok(tally.errorMax <= 40, `écart maximal ${tally.errorMax} points`);
    // Un taux n'est publié que sur des nombres publiés d'au moins 10 : jamais sur de petits comptes (au moins 8 exacts pour un « environ 10 »).
    assert.ok(tally.ratioShownWhenSmall < tally.ratioTotal, "des taux sont publiés pour des termes de 8 ou 9 (arrondis à 10)");
  });

  test("sans taux inventé : un seul acheteur, 4 acheteurs, 9 acheteurs : aucun pourcentage ; « environ 10 » sur « environ 10 » (8 à 12) : un pourcentage", () => {
    const tiny: RealisticWorld = { sponsoredShare: 1, buyers: Array.from({ length: 4 }, () => ({ sponsored: true, exposed: true, servings: 1, opens: 1, contact: true, reveals: 1 })) };
    const stats = buildOfferStats(rawOfRealistic(tiny));
    assert.deepEqual(stats.periods[0].ratios, { openRate: { kind: "insufficient" }, contactRate: { kind: "insufficient" } });
    assert.deepEqual(stats.periods[0].opens.uniqueBuyers, { kind: "below", bound: 5 });
    const nine: RealisticWorld = { sponsoredShare: 1, buyers: Array.from({ length: 9 }, () => ({ sponsored: true, exposed: true, servings: 1, opens: 1, contact: false, reveals: 0 })) };
    assert.deepEqual(buildOfferStats(rawOfRealistic(nine)).periods[0].ratios.openRate, { kind: "percent", value: 100 }, "9 → environ 10");
  });
});
