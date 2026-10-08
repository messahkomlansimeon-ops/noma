/**
 * Répartition d'une mission d'achat en volume entre plusieurs vendeurs (lot MV1). Fonction PURE : aucune base, aucune horloge, aucun module serveur (testée par des essais de
 * propriétés sur des jeux aléatoires, `tests/server/missions-allocation.test.ts`).
 *
 * ALGORITHME GLOUTON, présenté comme une HEURISTIQUE et non comme un optimum :
 *  1. écarter les annonces sans prix valide (`ignored.noPrice`), au-dessus du budget par unité (`ignored.overUnitBudget`) ou à la quantité illisible (`ignored.invalid`) ;
 *  2. trier le reste par pertinence DÉCROISSANTE, puis prix unitaire CROISSANT, puis identifiant d'annonce (le résultat ne dépend donc jamais de l'ordre d'arrivée) ;
 *  3. parcourir dans cet ordre : de chaque annonce, prendre le plus possible = min(stock annoncé, quantité restante, ⌊budget total restant ÷ prix⌋), sans dépasser 10 vendeurs
 *     (un nouveau vendeur n'est admis que s'il en reste la place ; plusieurs annonces du même vendeur comptent pour UN vendeur).
 * Contraintes TOUJOURS respectées : prix unitaire ≤ budget par unité ; Σ prix × quantité ≤ budget total ; quantité prise ≤ quantité annoncée (1 si elle n'est pas renseignée) ;
 * au plus 10 vendeurs ; chaque annonce au plus une fois ; quantités entières ≥ 1 ; couverture ≤ quantité demandée.
 * Ce que l'heuristique NE garantit PAS : la couverture maximale ni le coût minimal. Une annonce très pertinente mais chère passe avant une annonce un peu moins pertinente et bien
 * moins chère ; remplir d'abord par le prix pourrait couvrir plus de quantité avec le même budget, ou la même quantité pour moins cher. Le choix de la pertinence d'abord est
 * celui du produit (la meilleure correspondance avant le prix) ; c'est l'acheteur qui décide ensuite, ligne par ligne.
 * Garantie de MAXIMALITÉ (testée) : si la quantité n'est pas couverte, aucune annonce retenue ne pourrait fournir une unité de plus sans dépasser son stock, le budget total
 * ou la limite de vendeurs.
 * La fonction répartit le RESTE : l'appelant lui donne la quantité et le budget qui restent après les achats déjà engagés, et les vendeurs de ces achats (`engagedSellers`) : ils
 * comptent dans les 10 vendeurs (une annonce de l'un d'eux ne consomme pas de place de plus) et portent les premiers rangs.
 */

import { MISSION_SELLERS_MAX, SHORTFALL_REASONS, type ShortfallReason } from "../../missions-rules";

export interface AllocationCandidate {
  offerId: string;
  /** Clé du vendeur (jamais affichée) : plusieurs annonces du même vendeur comptent pour UN vendeur. */
  sellerKey: string;
  /** Pertinence organique 0..100 (plus haut = rempli en premier). */
  relevance: number;
  /** Prix unitaire en FCFA entiers ; null ou invalide : annonce écartée. */
  unitPrice: number | null;
  /** Quantité annoncée ; null : 1. */
  stock: number | null;
}

export interface AllocationInput {
  /** Quantité totale voulue (entier ≥ 1). */
  quantity: number;
  /** Budget par unité maximal (FCFA entiers). */
  unitBudget: number;
  /** Budget total maximal (FCFA entiers). */
  totalBudget: number;
  candidates: readonly AllocationCandidate[];
  /** Vendeurs au plus (10 par défaut ; borné à 10). */
  maxSellers?: number;
  /** Clés des vendeurs déjà engagés (achats proposés ou confirmés), dans l'ordre : ils comptent dans les `maxSellers` et ont les premiers rangs (1, 2…). */
  engagedSellers?: readonly string[];
}

export interface AllocationLine {
  offerId: string;
  sellerKey: string;
  /** Rang du vendeur dans la proposition (1, 2, 3… dans l'ordre de remplissage). */
  sellerIndex: number;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  /** Quantité annoncée de l'annonce (1 si elle n'est pas renseignée). */
  stock: number;
}

export interface AllocationResult {
  lines: AllocationLine[];
  requestedQuantity: number;
  coveredQuantity: number;
  /** coveredQuantity ÷ requestedQuantity, de 0 à 1. */
  coverage: number;
  budgetUsed: number;
  budgetRemaining: number;
  /** Vendeurs de la mission dans cette répartition : engagés d'abord, puis ceux des lignes. */
  sellerCount: number;
  /** Rang de chaque vendeur (clé → 1, 2, 3…) : les vendeurs engagés d'abord, puis dans l'ordre de remplissage. */
  sellerIndexes: ReadonlyMap<string, number>;
  /** Vide si la quantité est entièrement couverte ; sinon au moins une raison. */
  reasons: ShortfallReason[];
  ignored: { noPrice: number; overUnitBudget: number; invalid: number };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function compareCandidates(a: { relevance: number; price: number; offerId: string }, b: { relevance: number; price: number; offerId: string }): number {
  if (a.relevance !== b.relevance) return b.relevance - a.relevance;
  if (a.price !== b.price) return a.price - b.price;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

interface Eligible {
  offerId: string;
  sellerKey: string;
  relevance: number;
  price: number;
  stock: number;
}

export function allocateMission(input: AllocationInput): AllocationResult {
  const quantity = input.quantity;
  if (!isCount(quantity) || quantity < 1) throw new RangeError("quantity doit être un entier d'au moins 1.");
  const sellers = engagedSellerRanks(input.engagedSellers);
  if (!isCount(input.unitBudget) || !isCount(input.totalBudget)) throw new RangeError("Les budgets doivent être des entiers positifs ou nuls.");
  const maxSellers = Math.min(MISSION_SELLERS_MAX, Math.max(1, Math.trunc(input.maxSellers ?? MISSION_SELLERS_MAX)));

  const ignored = { noPrice: 0, overUnitBudget: 0, invalid: 0 };
  const eligible: Eligible[] = [];
  // Annonces dans un ordre qui ne dépend pas de l'ordre d'arrivée : une même annonce donnée deux fois n'est comptée qu'une fois (la meilleure version : pertinence, puis prix).
  const ordered = [...input.candidates]
    .map((candidate) => ({
      candidate,
      relevance: Number.isFinite(candidate.relevance) ? candidate.relevance : 0,
      price: isCount(candidate.unitPrice) ? candidate.unitPrice : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => compareCandidates({ relevance: a.relevance, price: a.price, offerId: a.candidate.offerId }, { relevance: b.relevance, price: b.price, offerId: b.candidate.offerId }));
  const seenOffers = new Set<string>();
  for (const { candidate, relevance } of ordered) {
    if (seenOffers.has(candidate.offerId)) continue;
    seenOffers.add(candidate.offerId);
    const price = candidate.unitPrice;
    if (!isCount(price) || price < 1) {
      ignored.noPrice += 1;
      continue;
    }
    if (price > input.unitBudget) {
      ignored.overUnitBudget += 1;
      continue;
    }
    const stock = candidate.stock === null ? 1 : candidate.stock;
    if (!isCount(stock) || stock < 1) {
      ignored.invalid += 1;
      continue;
    }
    eligible.push({ offerId: candidate.offerId, sellerKey: candidate.sellerKey, relevance, price, stock });
  }
  eligible.sort(compareCandidates);

  let remaining = quantity;
  let budget = input.totalBudget;
  const lines: AllocationLine[] = [];
  let budgetBound = false;
  let sellerBound = false;
  let capacity = 0;
  for (const item of eligible) capacity += item.stock;

  for (const item of eligible) {
    if (remaining === 0) break;
    let sellerIndex = sellers.get(item.sellerKey);
    if (sellerIndex === undefined) {
      if (sellers.size >= maxSellers) {
        // Écartée par la limite de vendeurs : si le budget ne permettait de toute façon pas une unité, c'est le budget qui limite.
        if (budget >= item.price) sellerBound = true;
        else budgetBound = true;
        continue;
      }
    }
    const wanted = Math.min(item.stock, remaining);
    const affordable = Math.floor(budget / item.price);
    const taken = Math.min(wanted, affordable);
    if (taken < wanted) budgetBound = true;
    if (taken <= 0) continue;
    if (sellerIndex === undefined) {
      sellerIndex = sellers.size + 1;
      sellers.set(item.sellerKey, sellerIndex);
    }
    const subtotal = taken * item.price;
    lines.push({ offerId: item.offerId, sellerKey: item.sellerKey, sellerIndex, quantity: taken, unitPrice: item.price, subtotal, stock: item.stock });
    remaining -= taken;
    budget -= subtotal;
  }

  const covered = quantity - remaining;
  const reasonSet = new Set<ShortfallReason>();
  if (remaining > 0) {
    if (capacity < quantity) reasonSet.add("not_enough_offers");
    if (ignored.overUnitBudget > 0) reasonSet.add("unit_budget_too_low");
    if (budgetBound) reasonSet.add("total_budget_too_low");
    if (sellerBound) reasonSet.add("seller_limit");
  }
  return {
    lines,
    requestedQuantity: quantity,
    coveredQuantity: covered,
    coverage: covered / quantity,
    budgetUsed: input.totalBudget - budget,
    budgetRemaining: budget,
    sellerCount: sellers.size,
    sellerIndexes: sellers,
    reasons: SHORTFALL_REASONS.filter((reason) => reasonSet.has(reason)),
    ignored,
  };
}

/** Rang des vendeurs déjà engagés : 1, 2… dans l'ordre donné, sans doublon. */
function engagedSellerRanks(engaged: readonly string[] | undefined): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const key of engaged ?? []) if (!ranks.has(key)) ranks.set(key, ranks.size + 1);
  return ranks;
}

/** Répartition VIDE : plus rien à acheter (la quantité totale est déjà engagée). Aucune ligne, couverture complète du reste (0 sur 0), budget intact. */
export function emptyAllocation(input: { totalBudget: number; engagedSellers?: readonly string[] }): AllocationResult {
  const sellers = engagedSellerRanks(input.engagedSellers);
  return {
    lines: [],
    requestedQuantity: 0,
    coveredQuantity: 0,
    coverage: 1,
    budgetUsed: 0,
    budgetRemaining: input.totalBudget,
    sellerCount: sellers.size,
    sellerIndexes: sellers,
    reasons: [],
    ignored: { noPrice: 0, overUnitBudget: 0, invalid: 0 },
  };
}
