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

/**
 * Noms AFFICHÉS des deux sources simulées (lot FIN1) : le nom d'une source est montré à l'écran sur chaque annonce ; « demo-rapide » et « demo-lente » étaient des noms techniques.
 * Les identifiants d'annonces gardent leur forme (`demo-rapide-1`) : ils ne sont jamais montrés.
 */
export const FAKE_FAST_SOURCE_NAME = "Annonces Abidjan (démo)";
export const FAKE_SLOW_SOURCE_NAME = "Marché Cocody (démo)";

/** Prix de référence plausible (FCFA) selon ce que le texte du besoin nomme ; à défaut, celui d'un téléphone d'occasion courant. */
export function fakeReferencePriceFor(needText: string): number {
  const text = needText.toLowerCase();
  if (/macbook|ordinateur|laptop|portable/.test(text)) return 450_000;
  if (/iphone\s*1[3-5]/.test(text)) return 260_000;
  if (/iphone/.test(text)) return 160_000;
  if (/galaxy|samsung/.test(text)) return 140_000;
  if (/t[ée]l[ée]vision|\btv\b|t[ée]l[ée]\b/.test(text)) return 180_000;
  if (/bureau|chaise|canap[ée]|armoire|lit\b/.test(text)) return 85_000;
  return 120_000;
}

const roundTo500 = (value: number): number => Math.round(value / 500) * 500;

/** Annonces simulées alignées sur le besoin (mots-clés du texte) pour que la
 *  classification les accepte ; une « coque » et une offre hors budget
 *  exercent les rejets. Lot FIN1 : des prix crédibles autour d'un prix de référence du produit
 *  (de 94 % à 102 % de ce prix), et une offre « hors budget » à plus de deux fois ce prix. */
export const fakeRunners = (needText = "téléphone"): Runner[] => {
  const base = needText.slice(0, 60);
  const reference = fakeReferencePriceFor(needText);
  const listing = (slug: string, source: string, n: number, over: Partial<RawListing> = {}): RawListing => ({
    id: `${slug}-${n}`,
    source,
    title: `${base} · annonce simulée n°${n}`,
    price: roundTo500(reference * (0.9 + n * 0.02)),
    currency: "FCFA",
    zone: "Cocody",
    vendor: null,
    url: `https://exemple.local/annonce/${slug}/${n}`,
    photo: null,
    date: "il y a 2 h",
    description: "Annonce de démonstration (source simulée).",
    ...over,
  });

  return [
    {
      name: FAKE_FAST_SOURCE_NAME,
      browser: false,
      run: async () =>
        result(FAKE_FAST_SOURCE_NAME, [
          listing("demo-rapide", FAKE_FAST_SOURCE_NAME, 1),
          listing("demo-rapide", FAKE_FAST_SOURCE_NAME, 2),
          listing("demo-rapide", FAKE_FAST_SOURCE_NAME, 3, { price: roundTo500(reference * 2.4), date: "il y a 3 j" }), // hors budget
        ]),
    },
    {
      name: FAKE_SLOW_SOURCE_NAME,
      browser: false,
      run: (signal) =>
        new Promise<SourceResult>((resolve) => {
          const delay = slowDelayMs();
          const t = setTimeout(
            () =>
              resolve(
                result(FAKE_SLOW_SOURCE_NAME, [
                  listing("demo-lente", FAKE_SLOW_SOURCE_NAME, 4),
                  listing("demo-lente", FAKE_SLOW_SOURCE_NAME, 5, { title: "Coque téléphone", price: 2_500 }), // rejet attendu
                ]),
              ),
            delay,
          );
          t.unref?.();
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve(result(FAKE_SLOW_SOURCE_NAME, [], "timeout"));
            },
            { once: true },
          );
        }),
    },
  ];
};