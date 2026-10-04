/**
 * Pseudonymisation IP (Lot 4) — les en-têtes X-Forwarded-For ne sont crus
 * QUE depuis le reverse proxy configuré ; l'IP n'est jamais stockée ni
 * journalisée en clair, seule son empreinte HMAC l'est.
 */
import { createHmac } from "node:crypto";

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_HINT_RE = /^[0-9a-f:]+$/i;

const looksLikeIp = (value: string): boolean =>
  value.length > 0 && (IPV4_RE.test(value) || IPV6_HINT_RE.test(value));

/** IP du client : headers + adresse de connexion directe.
 *  - secret du reverse proxy configuré ET correspondant → X-Forwarded-For
 *    cru (proxy configuré, seul à connaître le secret) ;
 *  - sinon proxy de confiance par adresse de connexion ;
 *  - sinon : en-têtes ignorés, adresse de connexion seule. */
export function clientIpFromRequest(
  headers: { get(name: string): string | null },
  remoteAddress: string,
  trustedProxies: string[],
  proxySecret?: string,
): string | null {
  const xff = headers.get("x-forwarded-for");
  const fromXff = (): string | null => {
    if (!xff) return null;
    for (const part of xff.split(",")) {
      const candidate = part.trim().replace(/^::ffff:/, "");
      if (looksLikeIp(candidate)) return candidate;
    }
    return null;
  };
  // proxy configuré : le secret partagé (posé par LE reverse proxy) autorise
  // la lecture de X-Forwarded-For — aucun autre en-tête n'est cru.
  if (proxySecret && headers.get("x-noma-proxy-secret") === proxySecret) {
    return fromXff();
  }
  const direct = remoteAddress.replace(/^::ffff:/, "").split("%")[0] || null;
  if (trustedProxies.length === 0) return direct;
  if (!direct || !trustedProxies.includes(direct)) return direct;
  return fromXff() ?? direct;
}

/** Empreinte pseudonyme stable — détermine les quotas IP sans jamais
 *  exposer l'adresse. */
export function pseudonymizeIp(ip: string | null, secret: string): string {
  if (!ip) return "inconnu";
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 24);
}