import "server-only";

import type { Pool } from "pg";
import { mapDemand, type DemandRow } from "../catalog/shared";
import { runCollectStep } from "../external/collect";
import { createFakeConnectors, fakeReferencePrice, FAKE_SOURCE_A } from "../external/fake-connectors";
import { describeProductKey, productKeyOf, productKeyString } from "../external/product-key";
import { syncMarketWatches } from "../external/watches";
import { SOURCE_DEMAND_COLUMNS } from "../matching/service";
import { runActiveSearchStep } from "./step";

/**
 * OUTIL DE DÉVELOPPEMENT (lot RA1, `npm run active-search:simulate`) : fait APPARAÎTRE une nouvelle annonce FICTIVE d'un autre site pour un besoin, puis collecte sa surveillance avec les
 * connecteurs FICTIFS (aucun réseau) et passe l'étape « activeSearch » du worker (comme le cycle réel : collecte, puis balayage). Sert à la démonstration et aux essais : sans lui, les connecteurs fictifs renvoient toujours les mêmes annonces et la recherche active ne
 * notifierait jamais rien. L'annonce est compatible avec le besoin (même produit, même zone, prix sous le budget) ; les notifications sont créées par le VRAI service de la
 * recherche active. Les garde-fous d'environnement sont dans le script (base d'essai seulement).
 */

export interface SimulatedListingResult {
  watchId: string;
  externalId: string;
  title: string;
  priceAmount: number;
  /** Annonces créées par la collecte (1 si l'annonce est nouvelle). */
  created: number;
  /** Notifications « annonce d'un autre site » créées par cette collecte, tous besoins confondus. */
  notified: number;
  sourceFailures: number;
  errors: string[];
}

const round500 = (value: number): number => Math.max(500, Math.round(value / 500) * 500);

const titleCase = (text: string): string => text.split(" ").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export async function simulateNewExternalListing(input: { pool: Pool; demandId: string; now?: () => Date; title?: string }): Promise<SimulatedListingResult> {
  const now = input.now ?? (() => new Date());
  const loaded = await input.pool.query<DemandRow>(`SELECT ${SOURCE_DEMAND_COLUMNS} FROM demands d WHERE d.id = $1::uuid`, [input.demandId]);
  if (!loaded.rows[0]) throw new Error("besoin introuvable");
  const demand = mapDemand(loaded.rows[0]);
  const key = productKeyOf({ category: demand.category, brand: demand.brand, model: demand.model, variant: demand.variant, location: demand.location });
  if (key === null) throw new Error("ce besoin n'a pas de clé produit (catégorie, marque et modèle sont nécessaires)");
  await syncMarketWatches(input.pool, now());
  const watch = await input.pool.query<{ id: string }>("SELECT id FROM market_watches WHERE product_key = $1 AND status = 'active'", [productKeyString(key)]);
  if (!watch.rows[0]) throw new Error("aucune surveillance active pour ce besoin");

  const budget = demand.budget === null ? null : demand.budget.amount;
  const reference = fakeReferencePrice(key) * 0.8;
  const price = round500(budget === null ? reference : Math.min(reference, budget * 0.9));
  const stamp = now().getTime();
  const externalId = `${FAKE_SOURCE_A}-simulation-${stamp}`;
  const product = titleCase(describeProductKey(key));
  const title = input.title ?? `${product} comme neuf, nouvelle annonce du jour`;
  const location = key.zone === "" || key.zone === "abidjan" ? "Cocody" : titleCase(key.zone);
  const connectors = createFakeConnectors();
  connectors[0].controls.extra = [
    { externalId, title, price, currency: "XOF", url: `https://annonces-${FAKE_SOURCE_A.replace(/_/g, "-")}.example/annonce/${externalId}`, location, listedAt: now(), availability: "available" },
  ];
  const before = await input.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'new_external_match'");
  const step = await runCollectStep({ pool: input.pool, connectors, now, only: [watch.rows[0].id], maxWatches: 1, stepBudgetMs: 60_000 });
  // Comme le worker : l'étape « activeSearch » passe APRÈS la collecte et crée les notifications par le VRAI service.
  const search = await runActiveSearchStep({ pool: input.pool, now });
  const after = await input.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'new_external_match'");
  return {
    watchId: watch.rows[0].id,
    externalId,
    title,
    priceAmount: price,
    created: step.created,
    notified: after.rows[0].n - before.rows[0].n,
    sourceFailures: step.sourceFailures,
    errors: [...step.errors, ...search.errors.map((code) => `active_search_${code}`)],
  };
}
