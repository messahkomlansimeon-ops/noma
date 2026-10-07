import { legacyPublish, type LegacyBoostRaw, type LegacyPeriodRaw, type LegacyRaw } from "./metrics-legacy-m1bis";
import { BOOST_CELLS, PERIODS, PERIOD_CELLS, type Structure } from "./metrics-adversary-model";
import type { Counted, PublicationAdapter } from "./metrics-adversary-engine";

/** Adaptateur du témoin : la publication du lot M1-bis (copie figée). */
type Response = ReturnType<typeof legacyPublish>;

const PERIOD_PLACES: Record<(typeof PERIOD_CELLS)[number], (p: Response["periods"][number]) => Counted[]> = {
  exposed: (p) => [p.exposure.buyersExposed, p.ratios.openRate.denominator],
  sponsored: (p) => [p.exposure.buyersSponsored],
  servings: (p) => [p.exposure.servings],
  sponsoredServings: (p) => [p.exposure.sponsoredServings],
  openers: (p) => [p.opens.uniqueBuyers, p.ratios.contactRate.denominator],
  openersAttributed: (p) => [p.opens.attributedToBoost.uniqueBuyers],
  openersOrganic: (p) => [p.opens.organic.uniqueBuyers],
  opens: (p) => [p.opens.total],
  opensAttributed: (p) => [p.opens.attributedToBoost.opens],
  opensOrganic: (p) => [p.opens.organic.opens],
  contactors: (p) => [p.contacts.uniqueBuyers],
  contactorsAttributed: (p) => [p.contacts.attributedToBoost.uniqueBuyers],
  contactorsOrganic: (p) => [p.contacts.organic.uniqueBuyers],
  reveals: (p) => [p.contacts.reveals],
  openersExposed: (p) => [p.ratios.openRate.numerator],
  contactorsOpened: (p) => [p.ratios.contactRate.numerator],
};
const BOOST_PLACES: Record<(typeof BOOST_CELLS)[number], (b: Response["boosts"][number]) => Counted[]> = {
  exposed: (b) => [b.exposure.buyersExposed],
  sponsored: (b) => [b.exposure.buyersSponsored, b.ratios.openRate.denominator],
  servings: (b) => [b.exposure.servings],
  sponsoredServings: (b) => [b.exposure.sponsoredServings],
  openers: (b) => [b.attributed.uniqueOpeners, b.ratios.openRate.numerator, b.ratios.contactRate.denominator],
  opens: (b) => [b.attributed.opens],
  contactors: (b) => [b.attributed.uniqueContacts],
  reveals: (b) => [b.attributed.reveals],
};

export const legacyAdapter: PublicationAdapter = {
  name: "M1-bis (copie figée)",
  rawOf(y, needs, structure: Structure): LegacyRaw {
    const periods = {} as Record<(typeof PERIODS)[number], LegacyPeriodRaw>;
    PERIODS.forEach((period, p) => {
      const at = (metric: (typeof PERIOD_CELLS)[number]): number => y[p * PERIOD_CELLS.length + PERIOD_CELLS.indexOf(metric)];
      periods[period] = {
        since: null, exposedBuyers: at("exposed"), sponsoredBuyers: at("sponsored"), servings: at("servings"), sponsoredServings: at("sponsoredServings"),
        openerBuyers: at("openers"), openerBuyersAttributed: at("openersAttributed"), opens: at("opens"), opensAttributed: at("opensAttributed"),
        openersExposed: at("openersExposed"), contactBuyers: at("contactors"), contactBuyersAttributed: at("contactorsAttributed"), reveals: at("reveals"),
        contactsOpened: at("contactorsOpened"),
      };
    });
    const boosts: LegacyBoostRaw[] = structure.boosts.map((_, j) => {
      const at = (metric: (typeof BOOST_CELLS)[number]): number => y[PERIODS.length * PERIOD_CELLS.length + j * BOOST_CELLS.length + BOOST_CELLS.indexOf(metric)];
      return {
        boostId: `00000000-0000-4000-8000-${String(j).padStart(12, "0")}`, durationCode: "24h", status: "expired", startsAt: new Date(0), endsAt: new Date(1),
        exposedBuyers: at("exposed"), sponsoredBuyers: at("sponsored"), servings: at("servings"), sponsoredServings: at("sponsoredServings"),
        bestPosition: 0, bestGain: 2, activeDays: 1,
        attributedOpens: at("opens"), attributedOpeners: at("openers"), attributedContactBuyers: at("contactors"), attributedReveals: at("reveals"),
        attributedContactsOpened: 0,
      };
    });
    return { needs, periods, boosts };
  },
  publish: (raw) => legacyPublish(raw as LegacyRaw),
  locate(response, cell) {
    const r = response as Response;
    const [scope, metric] = cell.split(".");
    if (scope.startsWith("boost")) {
      const boost = r.boosts[Number(scope.slice(5))];
      return boost ? BOOST_PLACES[metric as (typeof BOOST_CELLS)[number]](boost) : [];
    }
    const period = r.periods.find((entry) => entry.period === scope);
    return period ? PERIOD_PLACES[metric as (typeof PERIOD_CELLS)[number]](period) : [];
  },
  needsOf: (response) => (response as Response).activeMatches.needs,
};
