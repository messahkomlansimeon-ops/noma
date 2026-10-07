import { buildOfferStats, type BoostRaw, type OfferStatsRaw, type PeriodRaw } from "../../lib/server/metrics/stats";
import type { Published, RoundedAdapter } from "./metrics-adversary-rounded";
export type { Published };
import { BOOST_CELLS, PERIODS, PERIOD_CELLS, boostAgeRange, cellSpecs, type Structure } from "./metrics-adversary-model";

/**
 * Adaptateurs de la publication TESTÉE (lot M1-quater) : `buildOfferStats` du code de production, et une variante qui calcule les pourcentages sur les valeurs EXACTES
 * (la règle R2 de la décision initiale), que l'adversaire met en échec (voir metrics-adversary.test.ts, « TÉMOIN »).
 */
type Response = ReturnType<typeof buildOfferStats>;
type PeriodResponse = Response["periods"][number];
type BoostResponse = Response["boosts"][number];

const present = (...values: Array<Published | null | undefined>): Published[] => values.filter((value): value is Published => value !== null && value !== undefined);

const PERIOD_PLACES: Record<(typeof PERIOD_CELLS)[number], (p: PeriodResponse) => Published[]> = {
  exposed: (p) => present(p.exposure?.buyersExposed),
  sponsored: (p) => present(p.exposure?.buyersSponsored),
  servings: (p) => present(p.exposure?.servings),
  sponsoredServings: (p) => present(p.exposure?.sponsoredServings),
  openers: (p) => present(p.opens.uniqueBuyers),
  openersAttributed: (p) => present(p.opens.attributedToBoost?.uniqueBuyers),
  openersOrganic: (p) => present(p.opens.organic?.uniqueBuyers),
  opens: (p) => present(p.opens.total),
  opensAttributed: (p) => present(p.opens.attributedToBoost?.opens),
  opensOrganic: (p) => present(p.opens.organic?.opens),
  contactors: (p) => present(p.contacts.uniqueBuyers),
  contactorsAttributed: (p) => present(p.contacts.attributedToBoost?.uniqueBuyers),
  contactorsOrganic: (p) => present(p.contacts.organic?.uniqueBuyers),
  reveals: (p) => present(p.contacts.reveals),
  // Les recoupements ne sont publiés que par leurs pourcentages.
  openersExposed: () => [],
  contactorsOpened: () => [],
};
const BOOST_PLACES: Record<(typeof BOOST_CELLS)[number], (b: BoostResponse) => Published[]> = {
  exposed: (b) => present(b.exposure?.buyersExposed),
  sponsored: (b) => present(b.exposure?.buyersSponsored),
  servings: (b) => present(b.exposure?.servings),
  sponsoredServings: (b) => present(b.exposure?.sponsoredServings),
  openers: (b) => present(b.attributed?.uniqueOpeners),
  opens: (b) => present(b.attributed?.opens),
  contactors: (b) => present(b.attributed?.uniqueContacts),
  reveals: (b) => present(b.attributed?.reveals),
};

/** Les comptes publiés qui correspondent au chiffre `cell` du modèle (zéro, un ou plusieurs emplacements de la réponse). */
export function locatePublished(response: unknown, cell: string): Published[] {
  const r = response as Response;
  const [scope, metric] = cell.split(".");
  if (scope.startsWith("boost")) {
    const boost = r.boosts[Number(scope.slice(5))];
    return boost ? BOOST_PLACES[metric as (typeof BOOST_CELLS)[number]](boost) : [];
  }
  const period = r.periods.find((entry) => entry.period === scope);
  return period ? PERIOD_PLACES[metric as (typeof PERIOD_CELLS)[number]](period) : [];
}

export const READ_AT = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
const DAY = 86_400_000;

/** Brut (entrée de la publication) d'un monde : les chiffres sommés de tous les acheteurs, dans la structure donnée. */
export function rawOfWorld(y: ArrayLike<number>, needs: number, structure: Structure): OfferStatsRaw {
  const periods = {} as Record<(typeof PERIODS)[number], PeriodRaw>;
  PERIODS.forEach((period, p) => {
    const at = (metric: (typeof PERIOD_CELLS)[number]): number => y[p * PERIOD_CELLS.length + PERIOD_CELLS.indexOf(metric)];
    periods[period] = {
      since: null, exposedBuyers: at("exposed"), sponsoredBuyers: at("sponsored"), servings: at("servings"), sponsoredServings: at("sponsoredServings"),
      openerBuyers: at("openers"), openerBuyersAttributed: at("openersAttributed"), opens: at("opens"), opensAttributed: at("opensAttributed"),
      contactBuyers: at("contactors"), contactBuyersAttributed: at("contactorsAttributed"), reveals: at("reveals"),
      openerBuyersExposed: at("openersExposed"), contactBuyersOpened: at("contactorsOpened"),
    };
  });
  const today = Math.floor(READ_AT.getTime() / DAY);
  const boosts: BoostRaw[] = structure.boosts.map((_, j) => {
    const at = (metric: (typeof BOOST_CELLS)[number]): number => y[PERIODS.length * PERIOD_CELLS.length + j * BOOST_CELLS.length + BOOST_CELLS.indexOf(metric)];
    const { newest, oldest } = boostAgeRange(structure, j);
    return {
      boostId: `00000000-0000-4000-8000-${String(j).padStart(12, "0")}`, durationCode: "24h", status: "expired",
      startsAt: new Date((today - oldest) * DAY), endsAt: new Date((today - newest) * DAY + DAY - 1),
      exposedBuyers: at("exposed"), sponsoredBuyers: at("sponsored"), servings: at("servings"), sponsoredServings: at("sponsoredServings"),
      attributedOpens: at("opens"), attributedOpeners: at("openers"), attributedContactBuyers: at("contactors"), attributedReveals: at("reveals"),
    };
  });
  return { needs, readAt: READ_AT, periods, boosts };
}

export const productionAdapter: RoundedAdapter = {
  name: "buildOfferStats (production)",
  rawOf: (y, needs, structure) => rawOfWorld(y, needs, structure),
  publish: (raw) => buildOfferStats(raw as OfferStatsRaw),
  locate: locatePublished,
};

type PercentOrNot = { kind: "percent"; value: number } | { kind: "insufficient" };

/** Pourcentage de la décision initiale (R2) : sur les valeurs EXACTES, publié si numérateur ET dénominateur valent au moins 10, arrondi à la dizaine de pour cent. */
export function exactRatio(numerator: number, denominator: number): PercentOrNot {
  if (numerator < 10 || denominator < 10) return { kind: "insufficient" };
  return { kind: "percent", value: Math.min(100, Math.floor((2 * 100 * numerator + 10 * denominator) / (2 * 10 * denominator)) * 10) };
}

/** Variante de la publication : mêmes comptes arrondis, pourcentages calculés sur les valeurs EXACTES (échoue à l'adversaire : démonstration du choix de MESURES.md). */
export const exactRatioAdapter: RoundedAdapter = {
  name: "comptes arrondis, pourcentages sur valeurs exactes (R2 initial)",
  rawOf: (y, needs, structure) => rawOfWorld(y, needs, structure),
  publish: (raw) => {
    const input = raw as OfferStatsRaw;
    const response: Response = buildOfferStats(input);
    response.periods.forEach((period) => {
      const exact = input.periods[period.period];
      if (period.ratios.openRate !== null) period.ratios.openRate = exactRatio(exact.openerBuyersExposed, exact.exposedBuyers);
      period.ratios.contactRate = exactRatio(exact.contactBuyersOpened, exact.openerBuyers);
    });
    response.boosts.forEach((boost, index) => {
      const exact = input.boosts[index];
      if (boost.ratios.openRate !== null) boost.ratios.openRate = exactRatio(exact.attributedOpeners, exact.sponsoredBuyers);
      if (boost.ratios.contactRate !== null) boost.ratios.contactRate = exactRatio(exact.attributedContactBuyers, exact.sponsoredBuyers);
    });
    return response;
  },
  locate: locatePublished,
};

/**
 * Variante de la publication : arrondi AU PLUS PROCHE sans la tranche « environ 5 » étendue à 8 (la règle R1 initiale : 8 → « environ 10 »). Les comptes publiés sont recalculés
 * ICI depuis les chiffres exacts du monde ; le reste de la réponse est celui de la production. Échoue à l'adversaire : un total « environ 10 » dont deux parties sont
 * « moins de 5 » vaut 8, donc 4 et 4 (voir metrics-adversary.test.ts, « TÉMOIN »).
 */
export const nearestRoundingAdapter: RoundedAdapter = {
  name: "arrondi au plus proche, 8 → environ 10 (R1 initial)",
  rawOf: (y, needs, structure) => ({ raw: rawOfWorld(y, needs, structure), y: Array.from(y), structure }),
  publish: (input) => {
    const { raw, y, structure } = input as { raw: OfferStatsRaw; y: number[]; structure: Structure };
    const response: Response = buildOfferStats(raw);
    cellSpecs(structure.boosts.length).forEach((spec, cell) => {
      for (const place of locatePublished(response, spec.name)) {
        const value = y[cell];
        const target = place as { kind: string; bound?: number; value?: number };
        if (value < 5) {
          target.kind = "below";
          target.bound = 5;
          delete target.value;
        } else {
          target.kind = "approx";
          target.value = Math.floor((2 * value + 5) / 10) * 5;
          delete target.bound;
        }
      }
    });
    return response;
  },
  locate: locatePublished,
};
