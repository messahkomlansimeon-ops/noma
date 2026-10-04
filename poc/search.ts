/**
 * CLI de recherche — enveloppe mince autour du moteur réutilisable
 * (lib/engine.ts, étape 1 « multi-utilisateur ») : parsing d'arguments,
 * affichage console, fichier latest.json. Tout le pipeline vit dans
 * runSearch() — le futur backend/worker appelle la même fonction.
 */
import { runSearch } from "./lib/engine";
import { NEED } from "./lib/env";
import { mkdirSync, writeFileSync } from "node:fs";

// ─── Arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const useAlternatives = argv.includes("--alternatives");
const positional = argv.filter((a) => !a.startsWith("--"));
const isDemo = positional.length === 0;
if (isDemo) {
  console.log(
    "ℹ Aucun besoin fourni → besoin de DÉMONSTRATION utilisé (précisez un besoin en argument pour une recherche réelle).",
  );
}

const artifactsDir = `results/run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const result = await runSearch({
  needText: positional.join(" ") || NEED.text,
  alternatives: useAlternatives,
  artifactsDir,
  log: (l) => console.log(l),
});

const { need, needText, stats, finalListings, dedup, classification, sources } = result;

// ─── Sortie console ────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────────────");
console.log(`TOP 8 (sur ${finalListings.length}) :`);
for (const s of finalListings.slice(0, 8)) {
  const l = s.evaluated.listing;
  const price =
    s.evaluated.priceNonComparable
      ? `${l.price} ${l.currency} (non comparable)`
      : l.price === null
        ? "sur demande"
        : `${l.price} FCFA`;
  console.log(
    `  ⭐${s.score?.toFixed(2)} ${s.aiStatus === "non évalué par IA" ? " (IA n/a)" : ""} ${l.source.padEnd(16)} ${l.title.slice(0, 34).padEnd(34)} ${price}`,
  );
  console.log(`      ${s.raison}`);
}

console.log("\n📊 Statistiques :");
console.log(
  `   annonces ${stats.offresBrutes} → ${stats.apresDedup} (dédup) → ${stats.candidates} (candidates) | appels IA ${stats.appelsIA} (dont ${stats.lotsScoring} lots de scoring)`,
);
console.log(
  `   coût : ${stats.cout.known ? `$${(stats.cout.total ?? 0).toFixed(4)} connu` : `$${(stats.cout.total ?? 0).toFixed(4)} PARTIEL — coût inconnu`} · tokens ${stats.tokens.prompt} in / ${stats.tokens.completion} out`,
);
console.log(
  `   cache ${stats.cacheEtat} : ${stats.cache.hits} lecture(s) réussie(s), ${stats.cache.misses} échec(s), ${stats.cache.writes} écriture(s), ${stats.cache.skipped} non mémorisé(s) · 1er résultat ${stats.premierResultatMs} ms · total ${stats.dureeTotaleMs} ms`,
);
const cacheParSourceTxt = Object.entries(stats.cache.bySource)
  .map(([s, v]) => `${s} ${v.hits}✓/${v.misses}✗/${v.skipped}≠`)
  .join(" · ");
if (cacheParSourceTxt) console.log(`   cache par source : ${cacheParSourceTxt}`);

// ─── Fichiers : le moteur a écrit le dossier d'artefacts ; latest ici ──────
writeFileSync(
  "results/latest.json",
  JSON.stringify(
    {
      besoin: needText,
      besoinParse: need,
      ...stats,
      sources,
      top: finalListings.slice(0, 10),
      doublonsPossibles: dedup.possibleDuplicates,
      fusions: dedup.mergedFrom,
      rejets: classification.rejected.map((r) => ({ title: r.listing.title, reason: r.reason })),
    },
    null,
    2,
  ),
);
mkdirSync("results", { recursive: true });
console.log(`\n→ ${result.artifactsDir}/ (annonces.json · search-results.json · ledger.json)`);
