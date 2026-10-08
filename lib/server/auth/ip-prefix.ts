import { isIP } from "node:net";

/**
 * Agrégation des adresses IP par préfixe (lot SMS1-bis, B1-d) : un attaquant qui dispose d'un bloc d'adresses (un /24 en IPv4, un /64 en IPv6, l'unité d'attribution à un abonné) ne
 * contourne plus les compteurs par adresse en changeant d'adresse dans son bloc. Module PUR (aucun accès base ou environnement) : il fournit la clé de regroupement et les limites.
 *
 *  - IPv4 : les 3 premiers octets (/24) ; limites 100 par 15 minutes et 500 par jour (5 fois celles d'une adresse : plusieurs abonnés peuvent partager un /24, par exemple derrière la passerelle d'un opérateur mobile) ;
 *  - IPv6 : les 4 premiers groupes (/64) ; limites 20 par 15 minutes et 100 par jour (celles d'une adresse : un /64 est UN abonné) ;
 *  - IPv6 qui encapsule une adresse IPv4 (::ffff:a.b.c.d, 0:0:0:0:0:ffff:…) : traitée comme l'adresse IPv4 ;
 *  - toute autre valeur (non-adresse) : la valeur elle-même, avec les limites d'une adresse (pas d'agrégation).
 */

export interface IpAggregation {
  /** Clé stable du regroupement (jamais l'adresse entière pour un préfixe) : sert d'entrée à l'empreinte signée. */
  key: string;
  family: "ipv4" | "ipv6" | "other";
  limitPer15Minutes: number;
  limitPerDay: number;
}

export const IP_PREFIX_V4_LIMIT_15M = 100;
export const IP_PREFIX_V4_LIMIT_DAY = 500;
export const IP_PREFIX_V6_LIMIT_15M = 20;
export const IP_PREFIX_V6_LIMIT_DAY = 100;

function parseGroups(address: string): number[] | null {
  let text = address.split("%")[0].toLowerCase();
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon < 0) return null;
    const octets = text.slice(lastColon + 1).split(".").map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : Number.NaN));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  }
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return parsed.some((value) => Number.isNaN(value)) ? null : parsed;
}

function aggregateIpv4(octets: readonly [number, number, number, number]): IpAggregation {
  return { key: `v4:${octets[0]}.${octets[1]}.${octets[2]}`, family: "ipv4", limitPer15Minutes: IP_PREFIX_V4_LIMIT_15M, limitPerDay: IP_PREFIX_V4_LIMIT_DAY };
}

/** Clé de regroupement et limites d'une adresse (voir l'en-tête du fichier). */
export function ipAggregation(address: string): IpAggregation {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    return aggregateIpv4([a, b, c, d]);
  }
  if (version === 6) {
    const groups = parseGroups(address);
    if (groups) {
      // ::ffff:a.b.c.d (IPv4 encapsulée) : le regroupement est celui de l'adresse IPv4.
      if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        return aggregateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
      }
      const prefix = groups.slice(0, 4).map((group) => group.toString(16).padStart(4, "0")).join(":");
      return { key: `v6:${prefix}`, family: "ipv6", limitPer15Minutes: IP_PREFIX_V6_LIMIT_15M, limitPerDay: IP_PREFIX_V6_LIMIT_DAY };
    }
  }
  return { key: `raw:${address}`, family: "other", limitPer15Minutes: IP_PREFIX_V6_LIMIT_15M, limitPerDay: IP_PREFIX_V6_LIMIT_DAY };
}
