/**
 * Seuils et poids des indicateurs et de la pertinence (lot 2H1). SEUL endroit où ils sont définis : aucun nombre
 * magique ailleurs (indicators.ts, market.ts et stored-matches.ts lisent cette constante). Valeurs figées : les
 * modifier change les indicateurs et la pertinence servis à la lecture, jamais les évaluations enregistrées
 * (les indicateurs sont calculés à la lecture et ne sont pas enregistrés ; les versions de moteur 2A/2B ne changent pas).
 * Voir MATCHING-RELEVANCE.md.
 */
export interface RelevanceConfig {
  /** Poids de la pertinence. Une composante absente (null / non applicable) est retirée et les poids restants sont renormalisés. */
  readonly weights: {
    /** Score de compatibilité enregistré (0 à 100). */
    readonly compatibility: number;
    readonly availability: number;
    readonly price: number;
    readonly confidence: number;
  };
  readonly availability: {
    /** Une confirmation de moins de ce nombre d'heures (inclus) est « récente ». */
    readonly recentConfirmationHours: number;
    /** Une confirmation de moins de ce nombre d'heures (inclus) reste « confirmée » ; au-delà, elle ne compte plus. */
    readonly confirmationValidityHours: number;
    readonly scores: {
      readonly confirmedRecent: number;
      readonly confirmed: number;
      readonly unconfirmed: number;
      readonly reserved: number;
      /** Statut `unavailable` : inatteignable par une correspondance confirmée (exclue par l'éligibilité), défensif. */
      readonly unavailable: number;
    };
    /** Plafond du score quand la quantité de l'offre est connue et inférieure à la quantité demandée. */
    readonly insufficientQuantityCap: number;
  };
  readonly price: {
    /** Échantillon de marché minimal (hors l'offre évaluée) ; en dessous : `insufficient_data`. */
    readonly minSampleSize: number;
    readonly scores: { readonly belowMarket: number; readonly inMarket: number; readonly aboveMarket: number };
    /** Percentiles qui bornent « sous le marché » (≤ p25) et « dans le marché » (≤ p75). */
    readonly lowerPercentile: number;
    readonly upperPercentile: number;
  };
  readonly confidence: {
    readonly points: {
      readonly phoneVerified: number;
      readonly accountAgeGte30Days: number;
      readonly accountAgeGte7Days: number;
      /** Maximum de la complétude des champs structurés applicables (au prorata). */
      readonly completenessMax: number;
      /** Offre dont la disponibilité a déjà été confirmée (ne s'applique pas à une demande). */
      readonly availabilityEverConfirmed: number;
    };
    readonly accountAgeDays: { readonly established: number; readonly recent: number };
    /** Niveaux : high si score ≥ high, medium si ≥ medium, low sinon. */
    readonly levels: { readonly high: number; readonly medium: number };
    /** Champs structurés pris en compte pour la complétude, par type d'annonce. */
    readonly completenessFields: {
      readonly offer: readonly ["category", "brand", "model", "condition", "price", "location"];
      readonly demand: readonly ["category", "brand", "model", "condition", "location"];
    };
  };
  readonly relevance: {
    /** Nombre maximal de correspondances lues pour un tri par pertinence ; au-delà, `truncated` est vrai. */
    readonly window: number;
    /** Bornes de l'option de test `relevanceWindow` (non exposée par HTTP). */
    readonly maxWindowOption: number;
    /** Décalage maximal accepté dans un curseur de pertinence. */
    readonly maxOffset: number;
    readonly decimals: number;
  };
}

export const RELEVANCE_CONFIG: RelevanceConfig = Object.freeze({
  weights: Object.freeze({ compatibility: 0.55, availability: 0.2, price: 0.15, confidence: 0.1 }),
  availability: Object.freeze({
    recentConfirmationHours: 72,
    confirmationValidityHours: 14 * 24,
    scores: Object.freeze({ confirmedRecent: 100, confirmed: 70, unconfirmed: 40, reserved: 20, unavailable: 0 }),
    insufficientQuantityCap: 30,
  }),
  price: Object.freeze({
    minSampleSize: 5,
    scores: Object.freeze({ belowMarket: 100, inMarket: 60, aboveMarket: 20 }),
    lowerPercentile: 0.25,
    upperPercentile: 0.75,
  }),
  confidence: Object.freeze({
    points: Object.freeze({
      phoneVerified: 40,
      accountAgeGte30Days: 20,
      accountAgeGte7Days: 10,
      completenessMax: 30,
      availabilityEverConfirmed: 10,
    }),
    accountAgeDays: Object.freeze({ established: 30, recent: 7 }),
    levels: Object.freeze({ high: 70, medium: 40 }),
    completenessFields: Object.freeze({
      offer: Object.freeze(["category", "brand", "model", "condition", "price", "location"] as const),
      demand: Object.freeze(["category", "brand", "model", "condition", "location"] as const),
    }),
  }),
  relevance: Object.freeze({ window: 200, maxWindowOption: 1000, maxOffset: 100_000, decimals: 2 }),
}) as RelevanceConfig;

export const RELEVANCE_WINDOW = RELEVANCE_CONFIG.relevance.window;
