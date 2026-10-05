/**
 * Sources simulées (Lot 5) — UNIQUEMENT pour la validation locale (tests
 * flux HTTP, parcours UI, Playwright) : deux connecteurs factices, l'un
 * rapide, l'autre lent, honorant l'annulation. Jamais actif en production ;
 * force le mode sans IA (aucun centime dépensé sur des offres fictives).
 */
import type { Runner } from "../../poc/lib/orchestrate";
import type { SourceResult } from "../../poc/sources/types";
import type { RawListing } from "../../poc/lib/normalize";

const result = (
  source: string,
  listings: RawListing[],
  status: SourceResult["status"] = "ok",
): SourceResult => ({
  source,
  query: "simulé",
  capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
  warnings: [],
  listings,
  status,
  durationMs: 10,
  errors: [],
});

/** Délai par défaut de la source lente : inchangé (parcours UI, Playwright). */
export const FAKE_SLOW_DEFAULT_MS = 1_500;

/**
 * Délai de la source lente, lu à CHAQUE appel de `run` (jamais mis en cache). Seule NOMA_FAKE_SLOW_MS, réservée aux tests
 * d'intégration de la route, le remplace : entier de 1 à 3 600 000 ms, toute autre valeur retombe sur le défaut. Ce module
 * n'est atteint que sous `fakeSources` (NOMA_FAKE_SOURCES=1 ET Turnstile désactivé pour les tests) : aucun effet en production.
 */
const slowDelayMs = (): number => {
  const raw = process.env.NOMA_FAKE_SLOW_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return FAKE_SLOW_DEFAULT_MS;
  const value = Number(raw);
  return value >= 1 && value <= 3_600_000 ? value : FAKE_SLOW_DEFAULT_MS;
};

/** Annonces simulées alignées sur le besoin (mots-clés du texte) pour que la
 *  classification les accepte ; une « coque » et une offre hors budget
 *  exercent les rejets. */
export const fakeRunners = (needText = "téléphone"): Runner[] => {
  const base = needText.slice(0, 60);
  const listing = (source: string, n: number, over: Partial<RawListing> = {}): RawListing => ({
    id: `${source}-${n}`,
    source,
    title: `${base} · annonce simulée n°${n}`,
    price: 45_000 + n * 5_000,
    currency: "FCFA",
    zone: "Cocody",
    vendor: null,
    url: `https://exemple.local/annonce/${source}/${n}`,
    photo: null,
    date: "il y a 2 h",
    description: "Annonce de démonstration (source simulée).",
    ...over,
  });

  return [
    {
      name: "demo-rapide",
      browser: false,
      run: async () =>
        result("demo-rapide", [
          listing("demo-rapide", 1),
          listing("demo-rapide", 2),
          listing("demo-rapide", 3, { price: 900_000, date: "il y a 3 j" }), // hors budget
        ]),
    },
    {
      name: "demo-lente",
      browser: false,
      run: (signal) =>
        new Promise<SourceResult>((resolve) => {
          const delay = slowDelayMs();
          const t = setTimeout(
            () =>
              resolve(
                result("demo-lente", [
                  listing("demo-lente", 4),
                  listing("demo-lente", 5, { title: "Coque téléphone", price: 2_500 }), // rejet attendu
                ]),
              ),
            delay,
          );
          t.unref?.();
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve(result("demo-lente", [], "timeout"));
            },
            { once: true },
          );
        }),
    },
  ];
};