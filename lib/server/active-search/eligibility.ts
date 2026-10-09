import "server-only";

import { productKeyOf } from "../external/product-key";

/**
 * ÉLIGIBILITÉ d'un besoin à la recherche active payante (lots RA1 et RA1-bis) : UNE seule fonction, appelée par l'achat (sous le verrou de la ligne du besoin) ET par la lecture de l'état (qui
 * dit à l'écran si l'achat est possible). Aucun autre endroit ne décide si un besoin peut recevoir l'option : toute nouvelle règle d'éligibilité (par exemple « jamais sur un besoin
 * interne masqué d'une mission », ajoutée à l'intégration du lot des missions) s'ajoute ICI, avec la colonne correspondante dans `ELIGIBILITY_COLUMNS`, et se propage à l'achat comme à l'écran.
 *
 * Motifs, dans cet ordre :
 *  - `mission_carrier` (lot MV1, intégré avec RA1) : le besoin est le besoin PORTEUR d'une mission d'achat en volume (la ligne de `missions` qui le référence existe, quel que soit son état). Ce
 *    n'est pas un besoin de l'acheteur : il ne le voit pas dans « Mes besoins » (il le voit dans « Mes missions »). Ce motif n'est JAMAIS montré : l'achat comme la lecture de l'état répondent
 *    alors exactement comme pour un besoin d'autrui ou inconnu (404 `resource_not_found`, `CatalogNotFoundError`) ;
 *  - `demand_not_active` : le besoin n'est pas actif (brouillon, satisfait, archivé) ;
 *  - `no_product_key` : le besoin n'a pas de clé produit (catégorie, marque et modèle obligatoires) : il n'y aurait rien à surveiller ;
 *  - `unavailable` : la collecte externe ne peut rien fournir (aucun connecteur résolu ou aucune source active : aujourd'hui TOUJOURS le cas en production). Vendre une option qui ne peut
 *    rien livrer serait vendre du vide : le contexte `collectionAvailable` est calculé par `externalCollectionAvailable` (availability.ts).
 * Les contrôles qui dépendent de la base entière (capacité de collecte accélérée, horizon de 180 jours) ne sont pas de l'éligibilité du besoin : ils sont faits à côté (availability.ts, state.ts).
 */

/** Raison pour laquelle un besoin ne peut pas recevoir l'option (code stable, jamais un texte de la base). */
export type DemandIneligibility = "mission_carrier" | "demand_not_active" | "no_product_key" | "unavailable";

/** Colonnes de `demands` (alias `d`) lues pour décider. */
export const ELIGIBILITY_COLUMNS =
  "d.status AS status, d.archived_at IS NOT NULL AS archived, d.category AS category, d.brand AS brand, d.model AS model, d.variant AS variant, d.location_text AS location_text, "
  + "EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = d.id) AS mission_carrier";

export interface DemandEligibilityInput {
  status: string;
  archived: boolean;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  location_text: string | null;
  /** Le besoin est le besoin porteur d'une mission d'achat en volume (lot MV1). */
  mission_carrier: boolean;
}

export interface EligibilityContext {
  /** La collecte externe peut-elle fournir des annonces (connecteur résolu ET source active) ? */
  collectionAvailable: boolean;
}

/** Clé produit du besoin (texte normalisé) ; null s'il n'en a pas. */
export function eligibilityKeyOf(demand: Pick<DemandEligibilityInput, "category" | "brand" | "model" | "variant" | "location_text">): ReturnType<typeof productKeyOf> {
  return productKeyOf({ category: demand.category, brand: demand.brand, model: demand.model, variant: demand.variant, location: demand.location_text });
}

/** Null : le besoin peut recevoir l'option. Sinon la raison du refus. */
export function demandIneligibility(demand: DemandEligibilityInput, context: EligibilityContext): DemandIneligibility | null {
  if (demand.mission_carrier) return "mission_carrier";
  if (demand.status !== "active" || demand.archived) return "demand_not_active";
  if (eligibilityKeyOf(demand) === null) return "no_product_key";
  if (!context.collectionAvailable) return "unavailable";
  return null;
}
