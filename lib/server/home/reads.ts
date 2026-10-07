import "server-only";

import type { Pool } from "pg";
import { DEMAND_COLUMNS, OFFER_COLUMNS, mapDemand, mapOffer, type DemandRow, type OfferRow } from "../catalog/shared";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { readEffectiveBoostDetails } from "../boost/boosts";
import { countDemandOrganicLists } from "../matching/stored-matches";
import { MATCHING_CURRENT_CLOCK_CTE, MATCHING_FRESHNESS_FROM, buildMatchingFreshnessPredicate, resolveMatchingFreshnessParams } from "../matching/persistence";
import { roundCount, type StatCount } from "../metrics/privacy";
import { listNotifications } from "../notifications/inbox";
import { readWalletBalance } from "../wallet/ledger";

/**
 * Lectures des deux ACCUEILS (lot D1) : l'accueil de l'acheteur (ses besoins actifs, leurs correspondances, ses notifications) et le tableau de bord du vendeur
 * (ses annonces par statut, le nombre de besoins correspondants, son solde, ses boosts actifs). Toujours limitées à l'utilisateur de la session. Aucune annonce
 * d'autrui n'est listée : l'acheteur ne voit les annonces que par ses correspondances. Côté vendeur, aucun compte exact de besoins n'est publié : même arrondi que les
 * statistiques d'une annonce (`privacy.ts` : « moins de 5 », « environ N »). Voir DEMO.md et MESURES.md.
 */

export const BUYER_HOME_CONTRACT_VERSION = "home-buyer/v1" as const;
export const VENDOR_HOME_CONTRACT_VERSION = "home-vendor/v1" as const;

/** Besoins actifs montrés sur l'accueil de l'acheteur (les plus récents d'abord) ; le total réel est indiqué à part. */
export const BUYER_HOME_DEMAND_LIMIT = 6;
/** Notifications récentes montrées sur l'accueil de l'acheteur. */
export const BUYER_HOME_NOTIFICATION_LIMIT = 3;
/** Annonces montrées sur le tableau de bord du vendeur (les plus récentes d'abord) ; les compteurs par statut portent sur toutes. */
export const VENDOR_HOME_OFFER_LIMIT = 30;

export interface Money {
  amount: number;
  currency: string;
}

export interface BuyerHomeDemand {
  id: string;
  title: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  location: string | null;
  budget: Money | null;
  /** Nombre d'annonces que la page de résultats de ce besoin sert (exact : ce sont les résultats de l'acheteur lui-même). */
  matchCount: number;
  createdAt: string;
}

export interface BuyerHomeNotification {
  id: string;
  kind: "new_match" | "new_matches_digest" | "new_message";
  title: string | null;
  price: Money | null;
  count: number | null;
  link: string;
  createdAt: string;
  unread: boolean;
}

export interface BuyerHome {
  contractVersion: typeof BUYER_HOME_CONTRACT_VERSION;
  activeDemandCount: number;
  demands: BuyerHomeDemand[];
  unreadNotifications: number;
  notifications: BuyerHomeNotification[];
  readAt: string;
}

const TITLE_MAX = 80;

/** Titre d'affichage de l'annonce ou du besoin de l'utilisateur lui-même : première ligne non vide de son texte ; à défaut marque, modèle, variante. */
export function ownTitle(record: { rawText: string; brand: string | null; model: string | null; variant: string | null }): string {
  const firstLine = record.rawText.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  // Aucun caractère de contrôle, de direction ou invisible dans un titre affiché.
  const text = (firstLine ?? [record.brand, record.model, record.variant].filter(Boolean).join(" ")).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  if (!text) return "Sans titre";
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

function numberOf(amount: string | number | bigint): number {
  const value = Number(amount);
  return Number.isSafeInteger(value) ? value : 0;
}

/** Accueil de l'acheteur : besoins actifs et leur nombre de correspondances, notifications non lues et les plus récentes. */
export async function readBuyerHome(input: { pool: Pool; userId: string; now?: Date }): Promise<BuyerHome> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const rows = await pool.query<DemandRow & { total: number }>(
    `SELECT ${DEMAND_COLUMNS}, count(*) OVER ()::int AS total
       FROM demands
      WHERE owner_id = $1::uuid AND status = 'active' AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2::int`,
    [userId, BUYER_HOME_DEMAND_LIMIT],
  );
  const demands = rows.rows.map(mapDemand);
  const sizes = await countDemandOrganicLists(pool, demands.map((demand) => demand.id));
  const page = await listNotifications({ pool, userId, limit: BUYER_HOME_NOTIFICATION_LIMIT });
  return {
    contractVersion: BUYER_HOME_CONTRACT_VERSION,
    activeDemandCount: rows.rows[0]?.total ?? 0,
    demands: demands.map((demand) => ({
      id: demand.id,
      title: ownTitle(demand),
      category: demand.category,
      brand: demand.brand,
      model: demand.model,
      variant: demand.variant,
      location: demand.location,
      budget: demand.budget === null ? null : { amount: demand.budget.amount, currency: demand.budget.currency },
      matchCount: sizes.get(demand.id) ?? 0,
      createdAt: demand.createdAt.toISOString(),
    })),
    unreadNotifications: page.unreadCount,
    notifications: page.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      price: item.price === null ? null : { amount: item.price.amount, currency: item.price.currency },
      count: item.count,
      link: item.link,
      createdAt: item.createdAt.toISOString(),
      unread: item.readAt === null,
    })),
    readAt: (input.now ?? new Date()).toISOString(),
  };
}

export type VendorOfferStatus = "draft" | "published" | "paused";

export interface VendorHomeOffer {
  id: string;
  title: string;
  status: VendorOfferStatus;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  price: Money | null;
  /** Besoins d'acheteurs qui correspondent à l'annonce, ARRONDIS (jamais de compte exact). */
  needs: StatCount;
  /** Boost actif : date de fin ; sinon null. */
  boostEndsAt: string | null;
}

export interface VendorHomeBoost {
  offerId: string;
  endsAt: string;
}

export interface VendorHome {
  contractVersion: typeof VENDOR_HOME_CONTRACT_VERSION;
  counts: { published: number; paused: number; draft: number };
  /**
   * Nombre de BESOINS DISTINCTS (un besoin qui correspond à plusieurs annonces du vendeur compte une seule fois) correspondant à ses annonces EN LIGNE, arrondi comme les
   * statistiques d'une annonce. Jamais la somme des couples (annonce, besoin) : 10 couples pour 2 besoins se publient « moins de 5 ».
   */
  needs: StatCount;
  balance: number;
  currency: "XOF";
  activeBoosts: VendorHomeBoost[];
  offers: VendorHomeOffer[];
  readAt: string;
}

/** Tableau de bord du vendeur. Les annonces archivées ne sont ni comptées ni listées. */
export async function readVendorHome(input: { pool: Pool; userId: string; now?: Date }): Promise<VendorHome> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const at = input.now ?? new Date();
  const result = await pool.query<OfferRow>(
    `SELECT ${OFFER_COLUMNS} FROM offers
      WHERE owner_id = $1::uuid AND archived_at IS NULL AND status IN ('draft', 'published', 'paused')
      ORDER BY created_at DESC, id DESC
      LIMIT 500`,
    [userId],
  );
  const offers = result.rows.map(mapOffer);
  const counts = { published: 0, paused: 0, draft: 0 };
  for (const offer of offers) {
    if (offer.status === "published" || offer.status === "paused" || offer.status === "draft") counts[offer.status] += 1;
  }
  const published = offers.filter((offer) => offer.status === "published");

  // Besoins correspondants : même prédicat que la lecture des correspondances et que les statistiques d'une annonce (confirmées et fraîches), par annonce ;
  // le total du vendeur compte les besoins DISTINCTS (lot D3), jamais la somme des couples.
  const needsByOffer = new Map<string, number>();
  let distinctNeeds = 0;
  if (published.length > 0) {
    const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 2);
    const counted = await pool.query<{ offer_id: string; needs: number }>(
      `WITH ${MATCHING_CURRENT_CLOCK_CTE}
       SELECT e.offer_id, count(*)::int AS needs
         FROM ${MATCHING_FRESHNESS_FROM}
        WHERE e.offer_id = ANY($1::uuid[]) AND e.is_confirmed_match = TRUE
          AND ${freshness.conditions.join("\n          AND ")}
        GROUP BY e.offer_id`,
      [published.map((offer) => offer.id), ...freshness.values],
    );
    for (const row of counted.rows) needsByOffer.set(row.offer_id, row.needs);
    const distinct = await pool.query<{ needs: number }>(
      `WITH ${MATCHING_CURRENT_CLOCK_CTE}
       SELECT count(DISTINCT e.demand_id)::int AS needs
         FROM ${MATCHING_FRESHNESS_FROM}
        WHERE e.offer_id = ANY($1::uuid[]) AND e.is_confirmed_match = TRUE
          AND ${freshness.conditions.join("\n          AND ")}`,
      [published.map((offer) => offer.id), ...freshness.values],
    );
    distinctNeeds = distinct.rows[0]?.needs ?? 0;
  }

  // Boosts effectifs (mêmes conditions que le classement des résultats), puis leur date de fin.
  const effective = await readEffectiveBoostDetails(pool, published.map((offer) => offer.id), at.toISOString());
  const endsByOffer = new Map<string, string>();
  if (effective.size > 0) {
    const ends = await pool.query<{ offer_id: string; ends_at: Date }>(
      "SELECT offer_id, ends_at FROM offer_boosts WHERE id = ANY($1::uuid[])",
      [[...effective.values()].map((boost) => boost.boostId)],
    );
    for (const row of ends.rows) endsByOffer.set(row.offer_id, row.ends_at.toISOString());
  }

  const balance = await readWalletBalance(pool, userId);
  return {
    contractVersion: VENDOR_HOME_CONTRACT_VERSION,
    counts,
    needs: roundCount(distinctNeeds),
    balance: numberOf(balance),
    currency: "XOF",
    activeBoosts: [...endsByOffer].map(([offerId, endsAt]) => ({ offerId, endsAt })).sort((a, b) => a.endsAt.localeCompare(b.endsAt)),
    offers: offers.slice(0, VENDOR_HOME_OFFER_LIMIT).map((offer) => ({
      id: offer.id,
      title: ownTitle(offer),
      status: offer.status as VendorOfferStatus,
      category: offer.category,
      brand: offer.brand,
      model: offer.model,
      variant: offer.variant,
      price: offer.price === null ? null : { amount: offer.price.amount, currency: offer.price.currency },
      needs: roundCount(needsByOffer.get(offer.id) ?? 0),
      boostEndsAt: endsByOffer.get(offer.id) ?? null,
    })),
    readAt: at.toISOString(),
  };
}
