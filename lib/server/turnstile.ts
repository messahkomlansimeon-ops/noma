/**
 * Turnstile (Lot 4) — validation côté serveur : jeton, origine (hostname),
 * action. Échec de validation ou configuration absente = refus (fail
 * closed) en production. Le vérificateur est injectable pour les tests.
 */

export interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export type TurnstileVerifier = (
  token: string,
  remoteip: string | null,
) => Promise<SiteverifyResponse>;

/** Vérificateur réel : Cloudflare siteverify. Toute erreur réseau/réponse
 *  invalide est traitée comme un échec (jamais comme un succès). */
export const siteverify = (secret: string): TurnstileVerifier => {
  return async (token, remoteip) => {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.set("remoteip", remoteip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    return (await res.json()) as SiteverifyResponse;
  };
};

export interface TurnstileCheck {
  ok: boolean;
  /** Motif public stable (aucun détail technique brut). */
  reason?: "missing-token" | "invalid" | "config";
}

export interface TurnstileOptions {
  secret: string;
  expectedAction: string;
  expectedHostnames: string[];
  disabledForTests: boolean;
  production: boolean;
}

/** Vérifie le jeton : présence, succès, hostname et action attendus.
 *  - disabledForTests : contournement UNIQUEMENT hors production ;
 *  - production sans secret → refus « config » ;
 *  - exception du vérificateur → refus « invalid » (fail closed). */
export async function verifyTurnstile(
  verify: TurnstileVerifier,
  opts: TurnstileOptions,
  token: string | undefined,
  remoteip: string | null,
): Promise<TurnstileCheck> {
  if (opts.production) {
    if (!opts.secret) return { ok: false, reason: "config" };
    if (opts.disabledForTests) return { ok: false, reason: "config" };
  } else if (opts.disabledForTests) {
    return { ok: true };
  }
  if (!opts.secret) return { ok: true }; // dev local sans configuration
  if (!token || token.trim().length === 0) return { ok: false, reason: "missing-token" };
  try {
    const res = await verify(token.trim(), remoteip);
    if (!res.success) return { ok: false, reason: "invalid" };
    // hostname et action REQUIS et vérifiés — un « success: true » sans ces
    // champs n'est jamais accepté
    if (!res.hostname || !opts.expectedHostnames.includes(res.hostname)) {
      return { ok: false, reason: "invalid" };
    }
    if (!res.action || res.action !== opts.expectedAction) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}