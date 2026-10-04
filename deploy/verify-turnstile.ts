/**
 * Vérification Turnstile ISOLÉE — appelle uniquement Cloudflare siteverify.
 * Ne lance NI le moteur de recherche, NI Chromium, NI un appel IA, ni
 * /api/search. Sert à valider la configuration réelle (secret, domaine,
 * action) pendant la préproduction, avant d'activer les recherches.
 *
 * Le jeton doit être produit par le vrai widget sur le domaine configuré
 * (ou par les clés factices documentées de Cloudflare pour tester le
 * câblage sans le domaine réel).
 *
 * Usage :
 *   NOMA_TURNSTILE_SECRET=<secret> NOMA_TURNSTILE_HOSTNAMES=<domaine> \
 *     node_modules/.bin/tsx deploy/verify-turnstile.ts "<jeton>" [action]
 *
 * Sortie : succès/échec + hostname + action renvoyés par siteverify.
 * Le secret n'est jamais affiché ; le jeton n'est jamais affiché.
 */
import { siteverify, verifyTurnstile } from "../lib/server/turnstile";

async function main(): Promise<void> {
  const token = process.argv[2];
  const expectedAction = process.argv[3] ?? "search";
  const secret = process.env.NOMA_TURNSTILE_SECRET ?? "";
  const hostnames = (process.env.NOMA_TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!token || !secret || hostnames.length === 0) {
    console.error(
      "Usage : NOMA_TURNSTILE_SECRET=<secret> NOMA_TURNSTILE_HOSTNAMES=<domaine> \\\n" +
        "  node_modules/.bin/tsx deploy/verify-turnstile.ts <jeton> [action]\n" +
        "(jeton produit par le vrai widget sur le domaine configuré)",
    );
    process.exit(2);
  }

  const check = await verifyTurnstile(
    siteverify(secret),
    { secret, expectedAction, expectedHostnames: hostnames, disabledForTests: false, production: true },
    token,
    null,
  );

  if (check.ok) {
    console.log("✔ siteverify : succès — hostname et action validés côté serveur");
  } else {
    // motifs publics stables : missing-token | invalid | config
    console.log(`✖ siteverify : refus (${check.reason}) — voir lib/server/turnstile.ts`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
