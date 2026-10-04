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
          const t = setTimeout(
            () =>
              resolve(
                result("demo-lente", [
                  listing("demo-lente", 4),
                  listing("demo-lente", 5, { title: "Coque téléphone", price: 2_500 }), // rejet attendu
                ]),
              ),
            1_500,
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