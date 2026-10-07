/**
 * Modèle de monde de l'ADVERSAIRE des statistiques du vendeur (lots M1-ter et M1-quater). AUCUN import de lib/server/metrics : ce fichier décrit seulement ce que le
 * vendeur peut savoir (événements bruts, dates des boosts, règles d'attribution, définition de chaque chiffre) ; la publication testée est ailleurs.
 *
 * Un MONDE est un multiensemble d'acheteurs (au plus `cap`), chacun décrit par un PROFIL d'événements atomiques :
 *  - apparitions servies (boost, jour, nombre d'apparitions, dont sponsorisées) : journal d'exposition, seulement pendant les jours de fenêtre du boost ;
 *  - ouvertures (jour, attribuée ou non à un boost) : au plus une par jour et par acheteur ;
 *  - un contact au plus (jour du premier contact, attribué ou non, nombre de révélations).
 * Règle d'attribution (nécessaire, MESURES.md « Attribution au boost ») : une ouverture ou un contact n'est attribué au boost j que si l'acheteur a été servi
 * SPONSORISÉ par j au plus 7 jours AVANT (même jour compris). Les jours sont des âges (jours avant la lecture) ; les périodes sont 7 j (âge ≤ 6), 30 j (≤ 29), tout.
 */

export const ATTRIBUTION_DAYS = 7;
export type Period = "7d" | "30d" | "all";
export const PERIODS: readonly Period[] = ["7d", "30d", "all"];
export const PERIOD_MAX_AGE: Readonly<Record<Period, number>> = { "7d": 6, "30d": 29, all: Number.POSITIVE_INFINITY };

export interface Structure {
  name: string;
  /** Âges (jours avant la lecture) des jours distincts du monde, du plus ancien au plus récent. */
  slotAges: readonly number[];
  /** Âge de l'annonce en jours (le vendeur connaît sa date de création) : aucun événement n'est possible un jour plus ancien. */
  offerAge: number;
  /** Pour chaque boost : indices des jours où il est effectif (l'exposition n'est journalisée que pendant un boost). */
  boosts: ReadonlyArray<{ windowSlots: readonly number[] }>;
}

export interface ServeEvent { boost: number; slot: number; servings: number; sponsored: number }
export interface ViewEvent { slot: number; boost: number | null }
export interface ContactEvent { slot: number; boost: number | null; reveals: number }
export interface Profile { serves: ServeEvent[]; views: ViewEvent[]; contact: ContactEvent | null }

export const PERIOD_CELLS = [
  "exposed", "sponsored", "servings", "sponsoredServings", "openers", "openersAttributed", "openersOrganic", "opens", "opensAttributed", "opensOrganic",
  "contactors", "contactorsAttributed", "contactorsOrganic", "reveals",
  // Recoupements des taux par période (lot M1-quater) : acheteurs qui ont ouvert ET ont été servis ; acheteurs qui ont contacté ET ouvert (dans la période).
  "openersExposed", "contactorsOpened",
] as const;
export const BOOST_CELLS = ["exposed", "sponsored", "servings", "sponsoredServings", "openers", "opens", "contactors", "reveals"] as const;
export type CellKind = "buyers" | "events";
const EVENT_CELLS = new Set<string>(["servings", "sponsoredServings", "opens", "opensAttributed", "opensOrganic", "reveals"]);
export const cellKind = (metric: string): CellKind => (EVENT_CELLS.has(metric) ? "events" : "buyers");

/** Pour un compte d'événements, le compte d'acheteurs de son groupe (les acheteurs qui ont fait ces événements). */
export const EVENT_GROUP_METRIC: Readonly<Record<string, string>> = {
  servings: "exposed", sponsoredServings: "sponsored", opens: "openers", opensAttributed: "openersAttributed", opensOrganic: "openersOrganic", reveals: "contactors",
};

export interface CellSpec { name: string; kind: CellKind; scope: Period | `boost${number}`; metric: string }

export function cellSpecs(boostCount: number): CellSpec[] {
  const specs: CellSpec[] = [];
  for (const period of PERIODS) for (const metric of PERIOD_CELLS) specs.push({ name: `${period}.${metric}`, kind: cellKind(metric), scope: period, metric });
  for (let j = 0; j < boostCount; j++) for (const metric of BOOST_CELLS) specs.push({ name: `boost${j}.${metric}`, kind: cellKind(metric), scope: `boost${j}`, metric });
  return specs;
}

/** Contribution d'UN acheteur à chaque chiffre du modèle (définitions exactes de MESURES.md, recalculées ici depuis les événements). */
export function cellVector(profile: Profile, structure: Structure): Int8Array {
  const specs = cellSpecs(structure.boosts.length);
  const out = new Int8Array(specs.length);
  const age = (slot: number): number => structure.slotAges[slot];
  PERIODS.forEach((period, pIndex) => {
    const inside = (slot: number): boolean => age(slot) <= PERIOD_MAX_AGE[period];
    const serves = profile.serves.filter((e) => inside(e.slot));
    const views = profile.views.filter((e) => inside(e.slot));
    const contact = profile.contact && inside(profile.contact.slot) ? profile.contact : null;
    const servings = serves.reduce((s, e) => s + e.servings, 0);
    const sponsoredServings = serves.reduce((s, e) => s + e.sponsored, 0);
    const opens = views.length;
    const opensAttributed = views.filter((e) => e.boost !== null).length;
    const exposed = servings > 0 ? 1 : 0;
    const openers = opens > 0 ? 1 : 0;
    const contactors = contact ? 1 : 0;
    const values: Record<(typeof PERIOD_CELLS)[number], number> = {
      exposed, sponsored: sponsoredServings > 0 ? 1 : 0, servings, sponsoredServings,
      openers, openersAttributed: opensAttributed > 0 ? 1 : 0, openersOrganic: openers - (opensAttributed > 0 ? 1 : 0), opens, opensAttributed, opensOrganic: opens - opensAttributed,
      contactors, contactorsAttributed: contact && contact.boost !== null ? 1 : 0,
      contactorsOrganic: contact && contact.boost === null ? 1 : 0, reveals: contact ? contact.reveals : 0,
      openersExposed: exposed === 1 && openers === 1 ? 1 : 0, contactorsOpened: contactors === 1 && openers === 1 ? 1 : 0,
    };
    PERIOD_CELLS.forEach((metric, m) => { out[pIndex * PERIOD_CELLS.length + m] = values[metric]; });
  });
  structure.boosts.forEach((_, j) => {
    const serves = profile.serves.filter((e) => e.boost === j);
    const views = profile.views.filter((e) => e.boost === j);
    const servings = serves.reduce((s, e) => s + e.servings, 0);
    const sponsoredServings = serves.reduce((s, e) => s + e.sponsored, 0);
    const contactor = profile.contact && profile.contact.boost === j ? 1 : 0;
    const openers = views.length > 0 ? 1 : 0;
    const values: Record<(typeof BOOST_CELLS)[number], number> = {
      exposed: servings > 0 ? 1 : 0, sponsored: sponsoredServings > 0 ? 1 : 0, servings, sponsoredServings,
      openers, opens: views.length, contactors: contactor, reveals: contactor ? profile.contact!.reveals : 0,
    };
    BOOST_CELLS.forEach((metric, m) => { out[PERIODS.length * PERIOD_CELLS.length + j * BOOST_CELLS.length + m] = values[metric]; });
  });
  return out;
}

// ───────────── énumération des profils ─────────────

export interface ProfileOptions {
  /** Options (apparitions, sponsorisées) par (boost, jour de fenêtre). */
  serveOptions: ReadonlyArray<readonly [number, number] | null>;
  /** Révélations possibles d'un contact. */
  reveals: readonly number[];
}

const DEFAULT_OPTIONS: ProfileOptions = { serveOptions: [null, [1, 0], [1, 1], [2, 0], [2, 1], [2, 2]], reveals: [1, 2] };

export function enumerateProfiles(structure: Structure, options: ProfileOptions = DEFAULT_OPTIONS): { profiles: Profile[]; vectors: Int8Array[] } {
  const slots = structure.slotAges.length;
  const serveSlots: Array<{ boost: number; slot: number }> = [];
  const available = (slot: number): boolean => structure.slotAges[slot] <= structure.offerAge;
  structure.boosts.forEach((boost, j) => boost.windowSlots.forEach((slot) => { if (available(slot)) serveSlots.push({ boost: j, slot }); }));
  const profiles: Profile[] = [];
  const vectors: Int8Array[] = [];
  const seen = new Set<string>();

  const eligible = (serves: ServeEvent[], slot: number): number[] => {
    const found = new Set<number>();
    for (const e of serves) {
      if (e.sponsored > 0 && structure.slotAges[e.slot] >= structure.slotAges[slot] && structure.slotAges[e.slot] - structure.slotAges[slot] <= ATTRIBUTION_DAYS) found.add(e.boost);
    }
    return [...found].sort((a, b) => a - b);
  };
  const push = (profile: Profile): void => {
    if (profile.serves.length === 0 && profile.views.length === 0 && profile.contact === null) return;
    const vector = cellVector(profile, structure);
    const key = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("latin1");
    if (seen.has(key)) return;
    seen.add(key);
    profiles.push(profile);
    vectors.push(vector);
  };

  const serveChoice: Array<readonly [number, number] | null> = new Array(serveSlots.length).fill(null);
  const recurseServes = (index: number): void => {
    if (index < serveSlots.length) {
      for (const option of options.serveOptions) {
        serveChoice[index] = option;
        recurseServes(index + 1);
      }
      return;
    }
    const serves: ServeEvent[] = [];
    serveChoice.forEach((option, i) => {
      if (option) serves.push({ boost: serveSlots[i].boost, slot: serveSlots[i].slot, servings: option[0], sponsored: option[1] });
    });
    // ouvertures : par jour, aucune, organique, ou attribuée à un boost éligible
    const viewOptions: Array<Array<ViewEvent | null>> = [];
    for (let slot = 0; slot < slots; slot++) viewOptions.push(available(slot) ? [null, { slot, boost: null }, ...eligible(serves, slot).map((boost) => ({ slot, boost }))] : [null]);
    const contactOptions: Array<ContactEvent | null> = [null];
    for (let slot = 0; slot < slots; slot++) {
      if (!available(slot)) continue;
      for (const boost of [null, ...eligible(serves, slot)]) for (const reveals of options.reveals) contactOptions.push({ slot, boost, reveals });
    }
    const viewChoice: Array<ViewEvent | null> = new Array(slots).fill(null);
    const recurseViews = (slot: number): void => {
      if (slot < slots) {
        for (const option of viewOptions[slot]) {
          viewChoice[slot] = option;
          recurseViews(slot + 1);
        }
        return;
      }
      const views = viewChoice.filter((e): e is ViewEvent => e !== null);
      for (const contact of contactOptions) push({ serves, views, contact });
    };
    recurseViews(0);
  };
  recurseServes(0);
  return { profiles, vectors };
}

/** Structures de l'adversaire : mêmes boosts et mêmes dates pour le monde vrai et pour tous les mondes énumérés (âges 45, 10, 5 et 1 jours avant la lecture). */
const AGES = [45, 10, 5, 1] as const;
export const STRUCTURES: readonly Structure[] = [
  { name: "sans boost", slotAges: AGES, offerAge: 100, boosts: [] },
  { name: "1 boost à cheval sur 30 j et 7 j (jours 10 et 5)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [1, 2] }] },
  { name: "1 boost ancien (jour 45)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [0] }] },
  { name: "1 boost entre 7 et 30 jours (jour 10)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [1] }] },
  { name: "1 boost récent (jour 1)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [3] }] },
  { name: "2 boosts (jour 10, puis jour 5)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [1] }, { windowSlots: [2] }] },
  { name: "2 boosts (jour 45, puis jour 1)", slotAges: AGES, offerAge: 100, boosts: [{ windowSlots: [0] }, { windowSlots: [3] }] },
  { name: "annonce de 6 jours, 1 boost récent (jours 5 et 1)", slotAges: AGES, offerAge: 6, boosts: [{ windowSlots: [2, 3] }] },
  { name: "annonce de 20 jours, 1 boost (jour 10)", slotAges: AGES, offerAge: 20, boosts: [{ windowSlots: [1] }] },
];

/** Jours d'apparition possibles du boost j, en âges : du plus récent au plus ancien (tous les jours entre ses jours de fenêtre, pas seulement ceux du modèle). */
export function boostAgeRange(structure: Structure, j: number): { newest: number; oldest: number } {
  const ages = structure.boosts[j].windowSlots.map((slot) => structure.slotAges[slot]);
  return { newest: Math.min(...ages), oldest: Math.max(...ages) };
}
