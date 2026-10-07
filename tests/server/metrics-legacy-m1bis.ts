/**
 * COPIE FIGÉE de la publication des statistiques du lot M1-bis (avant M1-ter) : suppression complémentaire par couples emboîtés écrits à la main.
 * Elle sert de TÉMOIN à l'adversaire (tests/server/metrics-adversary.test.ts) : il doit la mettre en échec (constat K1 de l'audit de M1-bis). Ce fichier est
 * autonome : il n'importe rien de lib/server/metrics (ni privacy.ts, ni stats.ts), pour que le témoin ne change jamais avec le code de production.
 */

const THRESHOLD = 3;
export const LEGACY_PERIODS = ["7d", "30d", "all"] as const;
type Period = (typeof LEGACY_PERIODS)[number];

export interface LegacyPeriodRaw {
  since: string | null;
  exposedBuyers: number; sponsoredBuyers: number; servings: number; sponsoredServings: number;
  openerBuyers: number; openerBuyersAttributed: number; opens: number; opensAttributed: number; openersExposed: number;
  contactBuyers: number; contactBuyersAttributed: number; reveals: number; contactsOpened: number;
}

export interface LegacyBoostRaw {
  boostId: string; durationCode: string; status: string; startsAt: Date; endsAt: Date;
  exposedBuyers: number; sponsoredBuyers: number; servings: number; sponsoredServings: number;
  bestPosition: number | null; bestGain: number | null; activeDays: number;
  attributedOpens: number; attributedOpeners: number; attributedContactBuyers: number; attributedReveals: number; attributedContactsOpened: number;
}

export interface LegacyRaw {
  needs: number;
  periods: Readonly<Record<Period, LegacyPeriodRaw>>;
  boosts: readonly LegacyBoostRaw[];
}

interface Counted { value: number | null; belowThreshold: boolean }
interface Ratio { numerator: Counted; denominator: Counted; value: number | null; reason: "below_threshold" | null }

// ───────────── suppression complémentaire du lot M1-bis (copie) ─────────────

interface StatNode { kind: "buyers" | "events"; value: number; group?: string }
interface Plan {
  nodes: Map<string, StatNode>;
  nested: Array<readonly [string, string]>;
  sums: Array<{ total: string; parts: readonly string[] }>;
}

function node(plan: Plan, key: string): StatNode {
  const found = plan.nodes.get(key);
  if (!found) throw new RangeError(`compte inconnu : ${key}`);
  return found;
}

function legacySuppress(plan: Plan): ReadonlySet<string> {
  const masked = new Set<string>();
  for (const [key, stat] of plan.nodes) if (stat.kind === "buyers" && stat.value < THRESHOLD) masked.add(key);
  for (;;) {
    let changed = false;
    const mask = (key: string): void => {
      if (!masked.has(key)) { masked.add(key); changed = true; }
    };
    for (const [key, stat] of plan.nodes) if (stat.kind === "events" && stat.group !== undefined && masked.has(stat.group)) mask(key);
    for (const [outer, inner] of plan.nested) {
      if (masked.has(outer) || masked.has(inner)) continue;
      const difference = node(plan, outer).value - node(plan, inner).value;
      if (difference >= 1 && difference < THRESHOLD) mask(inner);
    }
    for (const rule of plan.sums) {
      if (masked.has(rule.total)) continue;
      const published = rule.parts.filter((part) => !masked.has(part));
      const remainder = node(plan, rule.total).value - published.reduce((sum, part) => sum + node(plan, part).value, 0);
      if (remainder >= 1 && remainder < THRESHOLD && published.length > 0) {
        let smallest = published[0];
        for (const part of published) if (node(plan, part).value < node(plan, smallest).value) smallest = part;
        mask(smallest);
      }
    }
    if (!changed) return masked;
  }
}

const published = (plan: Plan, masked: ReadonlySet<string>, key: string): Counted =>
  masked.has(key) ? { value: null, belowThreshold: true } : { value: node(plan, key).value, belowThreshold: false };

function publishedRatio(plan: Plan, masked: ReadonlySet<string>, numeratorKey: string, denominatorKey: string): Ratio {
  const numerator = published(plan, masked, numeratorKey);
  const denominator = published(plan, masked, denominatorKey);
  if (numerator.value === null || denominator.value === null || denominator.value === 0) return { numerator, denominator, value: null, reason: "below_threshold" };
  return { numerator, denominator, value: Math.round((numerator.value / denominator.value) * 10_000) / 10_000, reason: null };
}

// ───────────── plan de la réponse (copie de stats.ts du lot M1-bis) ─────────────

const PERIOD_BUYER_METRICS = ["exposed", "sponsored", "openers", "openersAttributed", "openersOrganic", "openersExposed", "contactors", "contactorsAttributed", "contactorsOrganic", "contactorsOpened"] as const;
const PERIOD_EVENT_METRICS = ["servings", "sponsoredServings", "opens", "opensAttributed", "opensOrganic", "reveals"] as const;
const PERIOD_EVENT_GROUP: Readonly<Record<(typeof PERIOD_EVENT_METRICS)[number], (typeof PERIOD_BUYER_METRICS)[number]>> = {
  servings: "exposed", sponsoredServings: "sponsored", opens: "openers", opensAttributed: "openersAttributed", opensOrganic: "openersOrganic", reveals: "contactors",
};
const PERIOD_MONOTONE = [
  "exposed", "sponsored", "openers", "openersAttributed", "openersExposed", "contactors", "contactorsAttributed", "contactorsOpened",
  "servings", "sponsoredServings", "opens", "opensAttributed", "opensOrganic", "reveals",
] as const;
const PERIOD_NESTED: ReadonlyArray<readonly [string, string]> = [
  ["exposed", "sponsored"], ["exposed", "openersExposed"],
  ["openers", "openersAttributed"], ["openers", "openersOrganic"], ["openers", "openersExposed"], ["openers", "contactorsOpened"],
  ["contactors", "contactorsAttributed"], ["contactors", "contactorsOrganic"], ["contactors", "contactorsOpened"],
  ["servings", "sponsoredServings"], ["opens", "opensAttributed"], ["opens", "opensOrganic"],
];
const PERIOD_PAIRS: ReadonlyArray<readonly [Period, Period]> = [["all", "30d"], ["30d", "7d"], ["all", "7d"]];
const BOOST_BUYER_METRICS = ["exposed", "sponsored", "openers", "contactors", "contactorsOpened"] as const;
const BOOST_EVENT_METRICS = ["servings", "sponsoredServings", "opens", "reveals"] as const;
const BOOST_EVENT_GROUP: Readonly<Record<(typeof BOOST_EVENT_METRICS)[number], (typeof BOOST_BUYER_METRICS)[number]>> = {
  servings: "exposed", sponsoredServings: "sponsored", opens: "openers", reveals: "contactors",
};
const BOOST_TO_PERIOD: Readonly<Record<(typeof BOOST_BUYER_METRICS)[number] | (typeof BOOST_EVENT_METRICS)[number], (typeof PERIOD_MONOTONE)[number]>> = {
  exposed: "exposed", sponsored: "sponsored", openers: "openersAttributed", contactors: "contactorsAttributed", contactorsOpened: "contactorsOpened",
  servings: "servings", sponsoredServings: "sponsoredServings", opens: "opensAttributed", reveals: "reveals",
};
const BOOST_NESTED: ReadonlyArray<readonly [string, string]> = [
  ["exposed", "sponsored"], ["sponsored", "openers"], ["openers", "contactorsOpened"], ["contactors", "contactorsOpened"], ["servings", "sponsoredServings"],
];
const pKey = (period: Period, metric: string): string => `period.${period}.${metric}`;
const bKey = (index: number, metric: string): string => `boost.${index}.${metric}`;

function periodValues(raw: LegacyPeriodRaw): Record<(typeof PERIOD_BUYER_METRICS)[number] | (typeof PERIOD_EVENT_METRICS)[number], number> {
  return {
    exposed: raw.exposedBuyers, sponsored: raw.sponsoredBuyers, openers: raw.openerBuyers, openersAttributed: raw.openerBuyersAttributed,
    openersOrganic: raw.openerBuyers - raw.openerBuyersAttributed, openersExposed: raw.openersExposed,
    contactors: raw.contactBuyers, contactorsAttributed: raw.contactBuyersAttributed, contactorsOrganic: raw.contactBuyers - raw.contactBuyersAttributed,
    contactorsOpened: raw.contactsOpened,
    servings: raw.servings, sponsoredServings: raw.sponsoredServings, opens: raw.opens, opensAttributed: raw.opensAttributed,
    opensOrganic: raw.opens - raw.opensAttributed, reveals: raw.reveals,
  };
}

function boostValues(raw: LegacyBoostRaw): Record<(typeof BOOST_BUYER_METRICS)[number] | (typeof BOOST_EVENT_METRICS)[number], number> {
  return {
    exposed: raw.exposedBuyers, sponsored: raw.sponsoredBuyers, openers: raw.attributedOpeners, contactors: raw.attributedContactBuyers,
    contactorsOpened: raw.attributedContactsOpened,
    servings: raw.servings, sponsoredServings: raw.sponsoredServings, opens: raw.attributedOpens, reveals: raw.attributedReveals,
  };
}

function legacyPlan(raw: LegacyRaw): Plan {
  const plan: Plan = { nodes: new Map(), nested: [], sums: [] };
  plan.nodes.set("needs", { kind: "buyers", value: raw.needs });
  for (const period of LEGACY_PERIODS) {
    const values = periodValues(raw.periods[period]);
    for (const metric of PERIOD_BUYER_METRICS) plan.nodes.set(pKey(period, metric), { kind: "buyers", value: values[metric] });
    for (const metric of PERIOD_EVENT_METRICS) plan.nodes.set(pKey(period, metric), { kind: "events", value: values[metric], group: pKey(period, PERIOD_EVENT_GROUP[metric]) });
    for (const [outer, inner] of PERIOD_NESTED) plan.nested.push([pKey(period, outer), pKey(period, inner)]);
  }
  for (const [longer, shorter] of PERIOD_PAIRS) for (const metric of PERIOD_MONOTONE) plan.nested.push([pKey(longer, metric), pKey(shorter, metric)]);
  raw.boosts.forEach((boost, index) => {
    const values = boostValues(boost);
    for (const metric of BOOST_BUYER_METRICS) plan.nodes.set(bKey(index, metric), { kind: "buyers", value: values[metric] });
    for (const metric of BOOST_EVENT_METRICS) plan.nodes.set(bKey(index, metric), { kind: "events", value: values[metric], group: bKey(index, BOOST_EVENT_GROUP[metric]) });
    for (const [outer, inner] of BOOST_NESTED) plan.nested.push([bKey(index, outer), bKey(index, inner)]);
    for (const metric of [...BOOST_BUYER_METRICS, ...BOOST_EVENT_METRICS]) plan.nested.push([pKey("all", BOOST_TO_PERIOD[metric]), bKey(index, metric)]);
  });
  if (raw.boosts.length > 0) {
    for (const metric of [...BOOST_BUYER_METRICS, ...BOOST_EVENT_METRICS]) plan.sums.push({ total: pKey("all", BOOST_TO_PERIOD[metric]), parts: raw.boosts.map((_, index) => bKey(index, metric)) });
  }
  return plan;
}

/** Réponse publiée par le lot M1-bis (forme `offer-stats/v1` d'alors), pour les statistiques BRUTES `raw`. */
export function legacyPublish(raw: LegacyRaw) {
  const plan = legacyPlan(raw);
  const masked = legacySuppress(plan);
  const count = (key: string): Counted => published(plan, masked, key);
  const ratio = (numerator: string, denominator: string): Ratio => publishedRatio(plan, masked, numerator, denominator);
  const periods = LEGACY_PERIODS.map((period) => {
    const p = (metric: string): string => pKey(period, metric);
    return {
      period,
      since: raw.periods[period].since,
      exposure: { servings: count(p("servings")), sponsoredServings: count(p("sponsoredServings")), buyersExposed: count(p("exposed")), buyersSponsored: count(p("sponsored")) },
      opens: {
        total: count(p("opens")), uniqueBuyers: count(p("openers")),
        attributedToBoost: { opens: count(p("opensAttributed")), uniqueBuyers: count(p("openersAttributed")) },
        organic: { opens: count(p("opensOrganic")), uniqueBuyers: count(p("openersOrganic")) },
      },
      contacts: {
        uniqueBuyers: count(p("contactors")), reveals: count(p("reveals")),
        attributedToBoost: { uniqueBuyers: count(p("contactorsAttributed")) }, organic: { uniqueBuyers: count(p("contactorsOrganic")) },
      },
      ratios: { openRate: ratio(p("openersExposed"), p("exposed")), contactRate: ratio(p("contactorsOpened"), p("openers")) },
    };
  });
  const boosts = raw.boosts.map((boost, index) => {
    const b = (metric: string): string => bKey(index, metric);
    return {
      boostId: boost.boostId, durationCode: boost.durationCode, status: boost.status, startsAt: boost.startsAt.toISOString(), endsAt: boost.endsAt.toISOString(),
      exposure: {
        servings: count(b("servings")), sponsoredServings: count(b("sponsoredServings")), buyersExposed: count(b("exposed")), buyersSponsored: count(b("sponsored")),
        bestPosition: boost.bestPosition, bestGain: boost.bestGain, activeDays: boost.activeDays,
      },
      attributed: { opens: count(b("opens")), uniqueOpeners: count(b("openers")), uniqueContacts: count(b("contactors")), reveals: count(b("reveals")) },
      ratios: { openRate: ratio(b("openers"), b("sponsored")), contactRate: ratio(b("contactorsOpened"), b("openers")) },
    };
  });
  return { activeMatches: { needs: count("needs") }, periods, boosts };
}
