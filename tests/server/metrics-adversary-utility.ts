/**
 * Mondes RÉALISTES du test d'UTILITÉ (lot M1-quater, critère (c)) : de 10 à 30 acheteurs, tous servis sponsorisés ou une partie seulement, boost récent, toute l'activité
 * dans les 7 derniers jours (7 j = 30 j = depuis la publication). Un monde est décrit acheteur par acheteur ; `rawOfRealistic` en tire les chiffres EXACTS que la
 * publication reçoit, `exactOfRealistic` les valeurs que le vendeur DEVRAIT lire si rien n'était arrondi (les comparaisons du test les prennent pour référence).
 * Ce fichier n'importe rien de lib/server/metrics sauf les TYPES du brut.
 */
import type { BoostRaw, OfferStatsRaw, PeriodRaw } from "../../lib/server/metrics/stats";

export interface RealisticBuyer { sponsored: boolean; exposed: boolean; servings: number; opens: number; contact: boolean; reveals: number }

export interface RealisticWorld { buyers: RealisticBuyer[]; sponsoredShare: number }

export const REALISTIC_READ_AT = new Date(Date.UTC(2026, 9, 7, 12, 0, 0));
const DAY = 86_400_000;

export interface ExactNumbers {
  buyers: number;
  exposed: number; sponsored: number; servings: number;
  openers: number; openersAttributed: number; opens: number; opensAttributed: number;
  contactors: number; contactorsAttributed: number; reveals: number;
  openersExposed: number; contactorsOpened: number;
}

export function exactOfRealistic(world: RealisticWorld): ExactNumbers {
  const { buyers } = world;
  const count = (predicate: (buyer: RealisticBuyer) => boolean): number => buyers.filter(predicate).length;
  const sum = (value: (buyer: RealisticBuyer) => number): number => buyers.reduce((total, buyer) => total + value(buyer), 0);
  return {
    buyers: buyers.length,
    exposed: count((b) => b.exposed), sponsored: count((b) => b.sponsored), servings: sum((b) => b.servings),
    openers: count((b) => b.opens > 0), openersAttributed: count((b) => b.opens > 0 && b.sponsored),
    opens: sum((b) => b.opens), opensAttributed: sum((b) => (b.sponsored ? b.opens : 0)),
    contactors: count((b) => b.contact), contactorsAttributed: count((b) => b.contact && b.sponsored), reveals: sum((b) => b.reveals),
    openersExposed: count((b) => b.opens > 0 && b.exposed), contactorsOpened: count((b) => b.contact && b.opens > 0),
  };
}

/** Le brut d'un monde réaliste : boost de 3 jours commencé il y a 2 jours, un seul boost. */
export function rawOfRealistic(world: RealisticWorld): OfferStatsRaw {
  const exact = exactOfRealistic(world);
  const sponsoredServings = world.buyers.reduce((total, buyer) => total + (buyer.sponsored ? buyer.servings : 0), 0);
  const period: PeriodRaw = {
    since: null, exposedBuyers: exact.exposed, sponsoredBuyers: exact.sponsored, servings: exact.servings, sponsoredServings,
    openerBuyers: exact.openers, openerBuyersAttributed: exact.openersAttributed, opens: exact.opens, opensAttributed: exact.opensAttributed,
    contactBuyers: exact.contactors, contactBuyersAttributed: exact.contactorsAttributed, reveals: exact.reveals,
    openerBuyersExposed: exact.openersExposed, contactBuyersOpened: exact.contactorsOpened,
  };
  const boost: BoostRaw = {
    boostId: "00000000-0000-4000-8000-000000000000", durationCode: "3d", status: "effective",
    startsAt: new Date(REALISTIC_READ_AT.getTime() - 2 * DAY), endsAt: new Date(REALISTIC_READ_AT.getTime() + DAY),
    exposedBuyers: exact.exposed, sponsoredBuyers: exact.sponsored, servings: exact.servings, sponsoredServings,
    attributedOpens: exact.opensAttributed, attributedOpeners: exact.openersAttributed,
    attributedContactBuyers: exact.contactorsAttributed, attributedReveals: world.buyers.reduce((total, buyer) => total + (buyer.sponsored && buyer.contact ? buyer.reveals : 0), 0),
  };
  return { needs: world.buyers.length, readAt: REALISTIC_READ_AT, periods: { "7d": period, "30d": period, all: period }, boosts: [boost] };
}

/** Générateur déterministe (mulberry32). */
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

/** `count` mondes réalistes de 10 à 30 acheteurs : la moitié « tous servis sponsorisés », l'autre moitié avec 30 à 90 % d'acheteurs servis sponsorisés. */
export function realisticWorlds(count: number, seed: number): RealisticWorld[] {
  const random = mulberry(seed);
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
  const worlds: RealisticWorld[] = [];
  for (let at = 0; at < count; at++) {
    const size = int(10, 30);
    const allSponsored = at % 2 === 0;
    const share = allSponsored ? 1 : int(30, 90) / 100;
    const buyers: RealisticBuyer[] = Array.from({ length: size }, () => {
      const sponsored = allSponsored || random() < share;
      // Un acheteur servi non sponsorisé existe aussi (exposé sans gain de place) ; les autres n'ont jamais vu l'annonce servie.
      const exposed = sponsored || random() < 0.3;
      const opens = random() < 0.75 ? int(1, 3) : 0;
      const contact = opens > 0 && random() < 0.4;
      return { sponsored, exposed, servings: exposed ? int(1, 3) : 0, opens, contact, reveals: contact ? int(1, 2) : 0 };
    });
    worlds.push({ buyers, sponsoredShare: share });
  }
  return worlds;
}

/** Le cas réaliste de l'audit : 20 acheteurs servis (17 sponsorisés), 16 ouvreurs dont 12 attribués, 6 contacts dont 5 attribués, toute l'activité dans les 7 derniers jours. */
export function auditorRealisticWorld(): RealisticWorld {
  const buyers: RealisticBuyer[] = [];
  const add = (count: number, buyer: RealisticBuyer): void => { for (let i = 0; i < count; i++) buyers.push({ ...buyer }); };
  // 12 ouvreurs sponsorisés (dont 5 contactent), 5 sponsorisés qui n'ouvrent pas, 3 exposés non sponsorisés dont 3 ouvreurs organiques (un contact), 1 ouvreur jamais servi.
  add(5, { sponsored: true, exposed: true, servings: 2, opens: 2, contact: true, reveals: 1 });
  add(7, { sponsored: true, exposed: true, servings: 2, opens: 1, contact: false, reveals: 0 });
  add(5, { sponsored: true, exposed: true, servings: 2, opens: 0, contact: false, reveals: 0 });
  add(1, { sponsored: false, exposed: true, servings: 1, opens: 1, contact: true, reveals: 1 });
  add(2, { sponsored: false, exposed: true, servings: 1, opens: 1, contact: false, reveals: 0 });
  add(1, { sponsored: false, exposed: false, servings: 0, opens: 1, contact: false, reveals: 0 });
  return { buyers, sponsoredShare: 17 / 20 };
}
