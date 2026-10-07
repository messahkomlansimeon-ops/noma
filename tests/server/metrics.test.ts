import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ATTRIBUTION_WINDOW_DAYS, COUNT_FIRST_BUCKET_MAX, COUNT_ROUNDING_BASE, CONTACT_DAILY_SELLER_LIMIT, METRICS_RETENTION_DAYS, PURGE_PRODUCTION_VARIABLE, RATIO_MIN_PUBLISHED_COUNT,
  RATIO_ROUNDING_PERCENT, STATS_PERIODS,
} from "../../lib/server/metrics/config";
import { buildContactLinks } from "../../lib/server/metrics/contacts";
import { MetricsError, METRICS_ERROR_MESSAGES } from "../../lib/server/metrics/errors";
import { secondsUntilNextUtcDay } from "../../lib/server/metrics/http";
import { PUBLIC_ATTRIBUTE_LIMIT, publicAttributes } from "../../lib/server/metrics/offer-detail";
import { roundCount, roundToBase, roundedRatio } from "../../lib/server/metrics/privacy";
import { purgeEnvironmentRefusal } from "../../lib/server/metrics/purge";
import { buildOfferStats, type BoostRaw, type PeriodRaw } from "../../lib/server/metrics/stats";

describe("décisions des lots M1 à M1-quater (constantes)", () => {
  test("arrondi à 5, tranche « environ 5 » jusqu'à 8, taux sur nombres publiés d'au moins 10 à la dizaine de pour cent ; fenêtre d'attribution 7 jours, rétention 400 jours, 20 vendeurs distincts par jour, trois périodes", () => {
    assert.equal(COUNT_ROUNDING_BASE, 5);
    assert.equal(COUNT_FIRST_BUCKET_MAX, 8);
    assert.equal(RATIO_MIN_PUBLISHED_COUNT, 10);
    assert.equal(RATIO_ROUNDING_PERCENT, 10);
    assert.equal(ATTRIBUTION_WINDOW_DAYS, 7);
    assert.equal(METRICS_RETENTION_DAYS, 400);
    assert.equal(CONTACT_DAILY_SELLER_LIMIT, 20);
    assert.deepEqual([...STATS_PERIODS], ["7d", "30d", "all"]);
    assert.equal(PURGE_PRODUCTION_VARIABLE, "NOMA_METRICS_PURGE_PRODUCTION");
  });
});

const below = { kind: "below", bound: 5 } as const;
const about = (value: number) => ({ kind: "approx", value }) as const;

describe("arrondi des comptes (privacy.ts)", () => {
  test("de 0 à 4 : « moins de 5 » (zéro compris) ; de 5 à 8 : « environ 5 » ; 9 à 12 : « environ 10 » ; 13 à 17 : « environ 15 » ; au-delà le multiple de 5 le plus proche", () => {
    for (const value of [0, 1, 2, 3, 4]) assert.deepEqual(roundCount(value), below, String(value));
    const table: Array<[number, number]> = [
      [5, 5], [6, 5], [7, 5], [8, 5], [9, 10], [10, 10], [11, 10], [12, 10], [13, 15], [14, 15], [15, 15], [16, 15], [17, 15], [18, 20], [22, 20], [23, 25], [100, 100], [102, 100], [103, 105], [1_001, 1_000], [1_003, 1_005],
    ];
    for (const [value, expected] of table) assert.deepEqual(roundCount(value), about(expected), String(value));
  });

  test("aucun compte exact n'est publié : au-dessus de 4, la valeur publiée est toujours un multiple de 5 (jusqu'à 2 000)", () => {
    for (let value = 5; value <= 2_000; value++) {
      const published = roundCount(value);
      assert.equal(published.kind, "approx");
      if (published.kind === "approx") {
        assert.equal(published.value % 5, 0, String(value));
        assert.ok(Math.abs(published.value - value) <= (value <= 8 ? 3 : 2), `${value} → ${published.value}`);
      }
    }
  });

  test("la moitié est arrondie vers le haut (arithmétique entière) : base 10 : 4 → 0, 5 → 10, 14 → 10, 15 → 20 ; base 5 : 7 → 5 (2,5 n'existe pas sur des entiers)", () => {
    assert.equal(roundToBase(4, 10), 0);
    assert.equal(roundToBase(5, 10), 10);
    assert.equal(roundToBase(14, 10), 10);
    assert.equal(roundToBase(15, 10), 20);
    assert.equal(roundToBase(24, 10), 20);
    assert.equal(roundToBase(25, 10), 30);
    assert.equal(roundToBase(7), 5);
    assert.equal(roundToBase(8), 10, "roundToBase seul est l'arrondi au plus proche : la tranche 5 à 8 est celle de roundCount");
    assert.equal(roundToBase(12), 10);
    assert.equal(roundToBase(13), 15);
  });

  test("comptes invalides refusés (négatif, décimal, NaN)", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => roundCount(bad), RangeError, String(bad));
      assert.throws(() => roundToBase(bad), RangeError, String(bad));
    }
  });
});

describe("taux publiés (privacy.ts)", () => {
  test("calculé sur les nombres PUBLIÉS : 12 sur 17 → 10 sur 15 → 67 % → « 70 % » ; 11 sur 12 → 10 sur 10 → 100 % (jamais « 90 % », qui dirait qu'un seul acheteur manque)", () => {
    assert.deepEqual(roundedRatio(12, 17), { kind: "percent", value: 70 });
    assert.deepEqual(roundedRatio(11, 12), { kind: "percent", value: 100 });
    assert.deepEqual(roundedRatio(10, 20), { kind: "percent", value: 50 });
    assert.deepEqual(roundedRatio(0, 30), { kind: "insufficient" }, "numérateur « moins de 5 »");
  });

  test("la moitié est arrondie vers le haut : 15 sur 20 = 75 % → 80 % ; 10 sur 40 = 25 % → 30 % ; 25 sur 40 = 62,5 % → 60 %", () => {
    assert.deepEqual(roundedRatio(15, 20), { kind: "percent", value: 80 });
    assert.deepEqual(roundedRatio(10, 40), { kind: "percent", value: 30 });
    assert.deepEqual(roundedRatio(25, 40), { kind: "percent", value: 60 });
    assert.deepEqual(roundedRatio(5 * 3 + 0, 10 * 2), { kind: "percent", value: 80 });
  });

  test("publié seulement si le numérateur ET le dénominateur PUBLIÉS valent au moins 10 (au moins 9 exacts) ; sinon « pas assez d'acheteurs pour un pourcentage »", () => {
    for (const [numerator, denominator] of [[9, 8], [8, 8], [5, 40], [7, 7], [10, 4], [4, 30], [30, 4], [0, 0]] as const) {
      assert.deepEqual(roundedRatio(Math.min(numerator, denominator), denominator), { kind: "insufficient" }, `${numerator}/${denominator}`);
    }
    assert.deepEqual(roundedRatio(9, 9), { kind: "percent", value: 100 }, "9 et 9 publiés « environ 10 » : 100 %");
    assert.deepEqual(roundedRatio(8, 9), { kind: "insufficient" }, "8 publié « environ 5 »");
    assert.deepEqual(roundedRatio(9, 30), { kind: "percent", value: 30 }, "9 → 10 sur 30 : 33 % → 30 %");
  });

  test("un taux ne dépend que des comptes publiés (post-traitement) : deux couples qui publient les mêmes comptes ont le même taux ; toujours un multiple de 10, de 0 à 100", () => {
    const published = (value: number) => JSON.stringify(roundCount(value));
    const byPublication = new Map<string, string>();
    for (let denominator = 0; denominator <= 70; denominator++) {
      for (let numerator = 0; numerator <= denominator; numerator++) {
        const ratio = roundedRatio(numerator, denominator);
        const key = `${published(numerator)}|${published(denominator)}`;
        const text = JSON.stringify(ratio);
        const known = byPublication.get(key);
        if (known === undefined) byPublication.set(key, text);
        else assert.equal(text, known, `${numerator}/${denominator}`);
        if (ratio.kind === "percent") {
          assert.equal(ratio.value % 10, 0);
          assert.ok(ratio.value >= 0 && ratio.value <= 100);
        }
      }
    }
  });
});

const READ_AT = new Date("2026-10-06T12:00:00.000Z");
const DAY_MS = 86_400_000;

const period = (overrides: Partial<PeriodRaw> = {}): PeriodRaw => ({
  since: null, exposedBuyers: 0, sponsoredBuyers: 0, servings: 0, sponsoredServings: 0, openerBuyers: 0, openerBuyersAttributed: 0, opens: 0, opensAttributed: 0,
  contactBuyers: 0, contactBuyersAttributed: 0, reveals: 0, openerBuyersExposed: 0, contactBuyersOpened: 0, ...overrides,
});

const boost = (overrides: Partial<BoostRaw> = {}): BoostRaw => ({
  boostId: "11111111-1111-4111-8111-111111111111", durationCode: "3d", status: "effective",
  startsAt: new Date("2026-10-04T08:00:00.000Z"), endsAt: new Date("2026-10-07T08:00:00.000Z"),
  exposedBuyers: 0, sponsoredBuyers: 0, servings: 0, sponsoredServings: 0, attributedOpens: 0, attributedOpeners: 0, attributedContactBuyers: 0, attributedReveals: 0, ...overrides,
});

/** Un jeu de comptes bruts avec un boost récent : de quoi publier chaque cellule, avec des valeurs qui s'arrondissent. */
const BUSY = period({
  exposedBuyers: 20, sponsoredBuyers: 14, servings: 61, sponsoredServings: 30, openerBuyers: 16, openerBuyersAttributed: 9, opens: 40, opensAttributed: 20,
  contactBuyers: 10, contactBuyersAttributed: 5, reveals: 18, openerBuyersExposed: 12, contactBuyersOpened: 9,
});
const BUSY_BOOST = boost({ exposedBuyers: 20, sponsoredBuyers: 14, servings: 61, sponsoredServings: 30, attributedOpens: 20, attributedOpeners: 9, attributedContactBuyers: 5, attributedReveals: 9 });

/** Une seule période renseignée (7 jours, 30 jours et tout identiques) : suffit pour lire une période construite. */
const statsOf = (raw: PeriodRaw, boosts: BoostRaw[] = [], needs = 8) => buildOfferStats({ needs, readAt: READ_AT, periods: { "7d": raw, "30d": raw, all: raw }, boosts });

describe("construction des statistiques (stats.ts, sans base)", () => {
  test("jeu connu avec un boost : chaque compte est arrondi (jamais exact), la part attribuée ET la part organique sont publiées, les taux se calculent sur les nombres publiés", () => {
    const stats = statsOf(BUSY, [BUSY_BOOST], 23);
    for (const entry of stats.periods) {
      assert.deepEqual(entry.exposure, { servings: about(60), sponsoredServings: about(30), buyersExposed: about(20), buyersSponsored: about(15) });
      assert.deepEqual(entry.opens, {
        total: about(40), uniqueBuyers: about(15), attributedToBoost: { opens: about(20), uniqueBuyers: about(10) }, organic: { opens: about(20), uniqueBuyers: about(5) },
      });
      assert.deepEqual(entry.contacts, { uniqueBuyers: about(10), reveals: about(20), attributedToBoost: { uniqueBuyers: about(5) }, organic: { uniqueBuyers: about(5) } });
      assert.deepEqual(entry.ratios.openRate, { kind: "percent", value: 50 }, "12 → 10 ouvreurs servis sur 20 acheteurs servis");
      assert.deepEqual(entry.ratios.contactRate, { kind: "percent", value: 70 }, "9 → 10 contacts parmi 16 → 15 ouvreurs : 67 %");
    }
    const [entry] = stats.boosts;
    assert.deepEqual(entry.exposure, { servings: about(60), sponsoredServings: about(30), buyersExposed: about(20), buyersSponsored: about(15) });
    assert.deepEqual(entry.attributed, { opens: about(20), uniqueOpeners: about(10), uniqueContacts: about(5), reveals: about(10) });
    // Les deux taux d'un boost : 9 → 10 sur 14 → 15 : 67 % → 70 % ; 5 contacts : moins de 10 publiés : pas de pourcentage.
    assert.deepEqual(entry.ratios.openRate, { kind: "percent", value: 70 });
    assert.deepEqual(entry.ratios.contactRate, { kind: "insufficient" });
    assert.deepEqual(stats.activeMatches.needs, about(25));
  });

  test("aucune valeur exacte dans la réponse : tout nombre est une borne (5), un compte publié (multiple de 5) ou un pourcentage (multiple de 10)", () => {
    const text = JSON.stringify(statsOf(BUSY, [BUSY_BOOST], 23));
    const numbers = [...text.matchAll(/"(\w+)":(-?\d+)/g)].map((match) => [match[1], Number(match[2])] as const);
    assert.ok(numbers.length > 40);
    for (const [key, value] of numbers) {
      assert.ok(key === "bound" || key === "value", `${key} = ${value} : un nombre nu`);
      assert.equal(value % 5, 0, `${key} = ${value}`);
    }
    for (const exactValue of [61, 14, 18, 9, 23, 16, 12]) assert.equal(new RegExp(`:${exactValue}[,}]`).test(text), false, `la valeur exacte ${exactValue} ne fuit pas`);
  });

  test("le cas de l'audit (16 ouvreurs dont 12 attribués, 6 contacts dont 5 attribués, 20 acheteurs servis dont 17 sponsorisés) : environ 15, environ 10, environ 5, des taux", () => {
    const audit = period({
      exposedBuyers: 20, sponsoredBuyers: 17, servings: 45, sponsoredServings: 40, openerBuyers: 16, openerBuyersAttributed: 12, opens: 30, opensAttributed: 22,
      contactBuyers: 6, contactBuyersAttributed: 5, reveals: 7, openerBuyersExposed: 15, contactBuyersOpened: 6,
    });
    const stats = statsOf(audit, [boost({ exposedBuyers: 20, sponsoredBuyers: 17, servings: 45, sponsoredServings: 40, attributedOpens: 22, attributedOpeners: 12, attributedContactBuyers: 5, attributedReveals: 6 })], 25);
    const [week] = stats.periods;
    assert.deepEqual(week.opens.uniqueBuyers, about(15));
    assert.deepEqual(week.opens.attributedToBoost?.uniqueBuyers, about(10));
    assert.deepEqual(week.contacts.uniqueBuyers, about(5));
    assert.deepEqual(week.contacts.attributedToBoost?.uniqueBuyers, about(5));
    assert.deepEqual(week.ratios.openRate, { kind: "percent", value: 80 }, "15 → 15 sur 20 : 75 % → 80 %");
    assert.deepEqual(stats.boosts[0].ratios.openRate, { kind: "percent", value: 70 }, "12 → 10 sur 17 → 15");
  });

  test("taux par période : le taux de contact compte les acheteurs qui ont contacté ET ouvert (pas tous les contacts), le taux d'ouverture ceux qui ont ouvert ET ont été servis (pas tous les ouvreurs)", () => {
    // 20 ouvreurs, 20 contacts dont 10 seulement ont ouvert dans la période (les 10 autres ont ouvert avant) ; 20 servis dont 10 ont ouvert, 20 ouvreurs en tout.
    const entry = statsOf(period({ exposedBuyers: 20, sponsoredBuyers: 20, openerBuyers: 20, openerBuyersExposed: 10, contactBuyers: 20, contactBuyersOpened: 10, opens: 25, reveals: 25, servings: 25, sponsoredServings: 25 }), [boost({ exposedBuyers: 20, sponsoredBuyers: 20 })]).periods[0];
    assert.deepEqual(entry.ratios.contactRate, { kind: "percent", value: 50 }, "10 contacts qui ont ouvert sur 20 ouvreurs : 50 % (et non 100 % : 20 contacts sur 20 ouvreurs)");
    assert.deepEqual(entry.ratios.openRate, { kind: "percent", value: 50 }, "10 ouvreurs servis sur 20 servis : 50 % (et non 100 % : 20 ouvreurs sur 20 servis)");
  });

  test("annonce SANS boost : ni exposition, ni part attribuée ou organique, ni taux d'ouverture ; aucun boost ; ouvertures, contacts et taux de contact publiés (tout est organique)", () => {
    const stats = statsOf(period({ openerBuyers: 12, opens: 19, contactBuyers: 10, reveals: 5, contactBuyersOpened: 10 }), [], 8);
    assert.deepEqual(stats.boosts, []);
    for (const entry of stats.periods) {
      assert.equal(entry.exposure, null);
      assert.deepEqual(entry.opens, { total: about(20), uniqueBuyers: about(10), attributedToBoost: null, organic: null });
      assert.deepEqual(entry.contacts, { uniqueBuyers: about(10), reveals: about(5), attributedToBoost: null, organic: null });
      assert.equal(entry.ratios.openRate, null);
      assert.deepEqual(entry.ratios.contactRate, { kind: "percent", value: 100 }, "10 sur 12 → 10 sur 10");
    }
    // Aucune valeur d'exposition fournie dans le brut (elle n'existe pas sans boost) : rien n'en transparaît, même quand le brut en porte par erreur.
    const withNoise = statsOf(period({ exposedBuyers: 50, servings: 90, openerBuyers: 12, opens: 19, contactBuyers: 10, reveals: 5, contactBuyersOpened: 10 }), [], 8);
    assert.deepEqual(withNoise, stats);
    assert.equal(JSON.stringify(stats).includes("sponsor"), false);
  });

  test("un boost qui touche seulement une période ancienne : pas d'exposition ni de part attribuée dans les périodes qu'il ne peut pas toucher (null), elles existent dans les autres", () => {
    const old = boost({ status: "expired", startsAt: new Date(READ_AT.getTime() - 20 * DAY_MS), endsAt: new Date(READ_AT.getTime() - 18 * DAY_MS), exposedBuyers: 20, sponsoredBuyers: 14, servings: 60, sponsoredServings: 30, attributedOpens: 20, attributedOpeners: 9, attributedContactBuyers: 5, attributedReveals: 9 });
    const stats = buildOfferStats({ needs: 20, readAt: READ_AT, periods: { "7d": period({ openerBuyers: 5, opens: 8, contactBuyers: 3, reveals: 4 }), "30d": BUSY, all: BUSY }, boosts: [old] });
    const [week, month, everything] = stats.periods;
    assert.equal(week.exposure, null, "le boost s'est terminé il y a 18 jours : aucune apparition possible dans la semaine");
    assert.equal(week.opens.attributedToBoost, null, "et aucune ouverture attribuée (la fenêtre d'attribution de 7 jours est close)");
    assert.equal(week.contacts.attributedToBoost, null);
    assert.equal(week.ratios.openRate, null);
    for (const entry of [month, everything]) {
      assert.notEqual(entry.exposure, null);
      assert.notEqual(entry.opens.attributedToBoost, null);
      assert.notEqual(entry.ratios.openRate, null);
    }
    assert.notEqual(stats.boosts[0].exposure, null);
    // Un boost terminé il y a 10 jours (fenêtre d'attribution de 7 jours : jusqu'à 3 jours avant la semaine) : pas d'exposition dans la semaine, mais une part attribuée possible.
    const recent = boost({ status: "expired", startsAt: new Date(READ_AT.getTime() - 12 * DAY_MS), endsAt: new Date(READ_AT.getTime() - 10 * DAY_MS) });
    const touching = buildOfferStats({ needs: 20, readAt: READ_AT, periods: { "7d": BUSY, "30d": BUSY, all: BUSY }, boosts: [recent] });
    assert.equal(touching.periods[0].exposure, null);
    assert.notEqual(touching.periods[0].opens.attributedToBoost, null, "le boost a servi il y a 10 à 12 jours : une ouverture d'il y a 3 à 6 jours (dans la semaine) peut lui être attribuée (7 jours de fenêtre)");
  });

  test("un boost qui n'a pas commencé : ni exposition, ni part attribuée, ni taux (null) ; les ouvertures et contacts restent organiques", () => {
    const future = boost({ status: "scheduled", startsAt: new Date("2026-10-08T08:00:00.000Z"), endsAt: new Date("2026-10-09T08:00:00.000Z") });
    const stats = statsOf(period({ openerBuyers: 6, opens: 9, contactBuyers: 3, reveals: 4 }), [future]);
    assert.deepEqual([stats.boosts[0].exposure, stats.boosts[0].attributed, stats.boosts[0].ratios.openRate, stats.boosts[0].ratios.contactRate], [null, null, null, null]);
    assert.equal(stats.boosts[0].status, "scheduled");
    for (const entry of stats.periods) assert.deepEqual([entry.exposure, entry.opens.attributedToBoost, entry.contacts.organic, entry.ratios.openRate], [null, null, null, null]);
  });

  test("1 à 4 acheteurs partout : tout est « moins de 5 », aucun taux, aucun nombre ne fuit", () => {
    const small = period({
      exposedBuyers: 4, sponsoredBuyers: 3, servings: 30, sponsoredServings: 1, openerBuyers: 1, openerBuyersAttributed: 1, opens: 3, opensAttributed: 3,
      contactBuyers: 1, contactBuyersAttributed: 1, reveals: 2, openerBuyersExposed: 1, contactBuyersOpened: 1,
    });
    const stats = statsOf(small, [boost({ exposedBuyers: 4, sponsoredBuyers: 3, servings: 30, sponsoredServings: 1, attributedOpens: 3, attributedOpeners: 1, attributedContactBuyers: 1, attributedReveals: 2 })], 2);
    // Seules les valeurs publiées « environ 30 » (30 apparitions : un événement, pas un acheteur) apparaissent ; aucun petit nombre exact.
    const text = JSON.stringify(stats);
    assert.equal(/"value":[0-4]\b/.test(text), false, text);
    assert.deepEqual(stats.periods[2].opens.total, below);
    assert.deepEqual(stats.periods[2].exposure?.buyersExposed, below);
    assert.deepEqual(stats.periods[2].exposure?.servings, about(30));
    assert.deepEqual(stats.periods[2].ratios, { openRate: { kind: "insufficient" }, contactRate: { kind: "insufficient" } });
    assert.deepEqual([stats.boosts[0].ratios.openRate, stats.boosts[0].ratios.contactRate], [{ kind: "insufficient" }, { kind: "insufficient" }]);
    assert.deepEqual(stats.activeMatches.needs, below);
  });

  test("aucune activité : « moins de 5 » partout (zéro compris), aucun taux", () => {
    const stats = statsOf(period(), [boost()], 0);
    const entry = stats.periods[1];
    assert.deepEqual(entry.opens.total, below);
    assert.deepEqual(entry.opens.organic, { opens: below, uniqueBuyers: below });
    assert.deepEqual(stats.boosts[0].ratios.openRate, { kind: "insufficient" });
    assert.deepEqual(stats.activeMatches.needs, below);
    assert.equal(/"value":\d/.test(JSON.stringify(stats)), false);
  });

  test("annonce de plus de 30 jours : les trois périodes publient chacune leurs comptes arrondis, chaque période sa propre valeur", () => {
    const week = period({ openerBuyers: 4, opens: 6, contactBuyers: 3, reveals: 4 });
    const month = period({ openerBuyers: 11, opens: 33, contactBuyers: 6, reveals: 9 });
    const everything = period({ openerBuyers: 22, opens: 70, contactBuyers: 9, reveals: 14 });
    const spread = buildOfferStats({ needs: 8, readAt: READ_AT, periods: { "7d": week, "30d": month, all: everything }, boosts: [] });
    assert.deepEqual(spread.periods.map((entry) => [entry.opens.total, entry.opens.uniqueBuyers, entry.contacts.uniqueBuyers, entry.contacts.reveals]), [
      [about(5), below, below, below], [about(35), about(10), about(5), about(10)], [about(70), about(20), about(10), about(15)],
    ]);
  });

  test("par boost : mêmes arrondis ; taux aux dénominateurs « servis sponsorisés » (l'attribution l'exige : numérateur emboîté)", () => {
    const raw = boost({
      exposedBuyers: 12, sponsoredBuyers: 12, servings: 20, sponsoredServings: 12, attributedOpens: 9, attributedOpeners: 11, attributedContactBuyers: 2, attributedReveals: 3,
    });
    const entry = statsOf(period({
      exposedBuyers: 12, sponsoredBuyers: 12, servings: 20, sponsoredServings: 12, opens: 15, opensAttributed: 9, openerBuyers: 11, openerBuyersAttributed: 11,
      contactBuyers: 6, contactBuyersAttributed: 2, reveals: 8,
    }), [raw]).boosts[0];
    assert.deepEqual(entry.exposure?.buyersExposed, about(10));
    assert.deepEqual(entry.exposure?.buyersSponsored, about(10));
    assert.deepEqual(entry.attributed?.uniqueOpeners, about(10));
    assert.deepEqual(entry.attributed?.opens, about(10), "9 ouvertures attribuées : environ 10");
    assert.deepEqual(entry.attributed?.uniqueContacts, below);
    assert.deepEqual(entry.attributed?.reveals, below);
    assert.deepEqual(entry.ratios.openRate, { kind: "percent", value: 100 }, "11 → 10 ouvreurs attribués sur 12 → 10 servis sponsorisés");
    assert.deepEqual(entry.ratios.contactRate, { kind: "insufficient" }, "2 contacts : moins de 5");
    assert.equal("bestGain" in (entry.exposure ?? {}), false, "les meilleures places et jours actifs ne sont plus publiés");
  });
});

describe("fiche : attributs publics en liste blanche (offer-detail.ts)", () => {
  test("valeurs scalaires gardées, objet { value, unit } rendu, tout le reste écarté", () => {
    const result = publicAttributes({
      couleur: "noir", stockage: { value: 128, unit: "Go" }, garantie: true, poids: 164.5, vide: "  ", objet: { a: 1 }, tableau: [1, 2], nul: null,
    });
    assert.deepEqual(result, [
      { key: "couleur", value: "noir" }, { key: "garantie", value: "oui" }, { key: "poids", value: "164.5" }, { key: "stockage", value: "128 Go" },
    ]);
  });

  test("un texte qui ressemble à un numéro de téléphone n'est jamais publié, où qu'il soit (valeur, unité)", () => {
    const result = publicAttributes({
      a: "07 00 00 00 42", b: "+225 07 00 00 00 42", c: "0700000042", d: { value: "x", unit: "0700000042" }, e: { value: "appelez le 0700000042" },
      ok: "128 Go", date: "2026-10-06",
    });
    assert.deepEqual(result, [{ key: "date", value: "2026-10-06" }, { key: "ok", value: "128 Go" }]);
    assert.equal(JSON.stringify(result).includes("0700000042"), false);
  });

  test("chiffres NON ASCII : pleine chasse, arabes-indiens, dévanagari, exposants, mélangés ne contournent pas la liste blanche (NFKC et \\p{Nd}) ; valeur + unité contrôlées assemblées", () => {
    const fullWidth = "０７０８１２３４５６";
    const arabicIndic = "٠٧٠٨١٢٣٤٥٦";
    const devanagari = "०७०८१२३४५६";
    const superscript = "⁰⁷⁰⁸¹²³⁴⁵⁶";
    const mixed = "0७٠8１2٣4५6";
    const result = publicAttributes({
      a: fullWidth, b: arabicIndic, c: devanagari, d: superscript, e: mixed, f: `Appelez le ${fullWidth.slice(0, 3)} ${arabicIndic.slice(3)}`,
      g: { value: "12345 6789", unit: "x" }, h: { value: "1234", unit: "56789" },
      ok: "128 Go", okFull: "１２８ Go", okArabic: "٢٥٦ Go",
    });
    assert.deepEqual(result.map((entry) => entry.key), ["ok", "okArabic", "okFull"], "seuls les textes à moins de 9 chiffres survivent");
    const text = JSON.stringify(result);
    for (const forbidden of [fullWidth, arabicIndic, devanagari, superscript, mixed]) assert.equal(text.includes(forbidden), false);
  });

  test("clés invalides, caractères de contrôle ou de direction, texte trop long écartés ; 12 attributs au plus, ordre alphabétique", () => {
    const result = publicAttributes({
      "mauvaise cle": "x", "1abc": "x", ok: "bon", bidi: "abc\u202edef", zero: "a\u200bb", long: "x".repeat(81), nl: "a\nb", __proto__x: "y",
    } as never);
    assert.deepEqual(result, [{ key: "ok", value: "bon" }]);
    const many: Record<string, string> = {};
    for (let index = 0; index < 30; index++) many[`k${String(index).padStart(2, "0")}`] = `v${index}`;
    const limited = publicAttributes(many);
    assert.equal(limited.length, PUBLIC_ATTRIBUTE_LIMIT);
    assert.deepEqual(limited.map((entry) => entry.key), Object.keys(many).slice(0, PUBLIC_ATTRIBUTE_LIMIT));
    assert.deepEqual(publicAttributes(null), []);
    assert.deepEqual(publicAttributes([] as never), []);
  });
});

describe("contact : liens, délai, erreurs, purge", () => {
  test("liens : tel: et https://wa.me/<chiffres> depuis un numéro E.164 ; tout autre texte refusé", () => {
    assert.deepEqual(buildContactLinks("+2250700000042"), { telUrl: "tel:+2250700000042", whatsappUrl: "https://wa.me/2250700000042" });
    for (const bad of ["0700000042", "+0123456", "+225 07", "tel:+225", "+2250700000042 ", "javascript:alert(1)", ""]) {
      assert.throws(() => buildContactLinks(bad), RangeError, bad);
    }
  });

  test("Retry-After du quota quotidien : secondes jusqu'à minuit UTC, au moins 1", () => {
    assert.equal(secondsUntilNextUtcDay(new Date("2026-10-06T00:00:00.000Z")), 86_400);
    assert.equal(secondsUntilNextUtcDay(new Date("2026-10-06T23:59:59.000Z")), 1);
    assert.equal(secondsUntilNextUtcDay(new Date("2026-10-06T23:59:59.999Z")), 1);
    assert.equal(secondsUntilNextUtcDay(new Date("2026-10-06T12:00:00.000Z")), 43_200);
    assert.equal(secondsUntilNextUtcDay(new Date("2026-12-31T23:30:00.000Z")), 1_800, "changement d'année");
  });

  test("erreurs de domaine : code stable et texte fixe", () => {
    for (const code of ["resource_not_found", "offer_not_available", "contact_unavailable", "rate_limited"] as const) {
      const error = new MetricsError(code);
      assert.equal(error.code, code);
      assert.equal(error.message, METRICS_ERROR_MESSAGES[code]);
    }
  });

  test("purge : seulement si NODE_ENV est absent, development ou test (casse exacte) ; production exige la variable explicite ; toute autre valeur est refusée", () => {
    assert.match(purgeEnvironmentRefusal({ NODE_ENV: "production" }) ?? "", /NOMA_METRICS_PURGE_PRODUCTION=1/);
    assert.match(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "0" }) ?? "", /refus en production/);
    assert.match(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "true" }) ?? "", /refus en production/);
    assert.equal(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" }), null);
    for (const env of [{}, { NODE_ENV: undefined }, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) assert.equal(purgeEnvironmentRefusal(env), null, JSON.stringify(env));
    // M2 : la casse compte ; toute autre valeur est refusée, avec ou sans la variable de production.
    for (const value of ["Production", "PRODUCTION", "production ", " production", "prod", "staging", "Development", "TEST", "dev", "", " ", "0", "undefined"]) {
      const refusal = purgeEnvironmentRefusal({ NODE_ENV: value });
      assert.match(refusal ?? "", /refus : NODE_ENV doit être absent/, JSON.stringify(value));
      assert.equal(refusal?.includes(JSON.stringify(value)) && value !== "", false, "la valeur reçue n'est jamais répétée");
      assert.notEqual(purgeEnvironmentRefusal({ NODE_ENV: value, NOMA_METRICS_PURGE_PRODUCTION: "1" }), null, `${JSON.stringify(value)} refusé même avec la variable de production`);
    }
    assert.equal(purgeEnvironmentRefusal({ NOMA_METRICS_PURGE_PRODUCTION: "1" }), null, "NODE_ENV absent : permis (la variable de production ne sert qu'à production)");
  });
});
