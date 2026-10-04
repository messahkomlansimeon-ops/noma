export const CATALOG_EXTRACTION_CONTRACT_VERSION = "catalog-extraction/v1" as const;
export const DETERMINISTIC_EXTRACTOR_VERSION = "noma-deterministic/v1" as const;
export const AI_EXTRACTOR_VERSION = "noma-deterministic+ai/v1" as const;

export type CatalogExtractionType = "offer" | "demand";
export type CatalogExtractionProvenance = "deterministic" | "ai";

export interface CatalogExtractionInput {
  type: CatalogExtractionType;
  rawText: string;
}

export interface ProposedMoney {
  amount: number;
  /** `null` signifie que le texte ne donne aucune devise exploitable. */
  currency: string | null;
}

/**
 * Caractéristique prête pour un futur matching : `key` et `unit` sont
 * canoniques, `sourceUnit` conserve l'unité réellement écrite.
 */
export interface ProposedAttribute {
  key: string;
  value: string | number | boolean;
  unit: string | null;
  sourceUnit: string | null;
}

export interface ProposedCriterion {
  key: string;
  operator: "includes" | "excludes" | "equals";
  value: string;
}

export interface CatalogProposedCommonFields {
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: ProposedAttribute[] | null;
  condition: string | null;
  quantity: number | null;
  location: string | null;
  deadlineAt: string | null;
}

export interface CatalogOfferProposedFields extends CatalogProposedCommonFields {
  price: ProposedMoney | null;
}

export interface CatalogDemandProposedFields extends CatalogProposedCommonFields {
  budget: ProposedMoney | null;
  requirements: ProposedCriterion[] | null;
  preferences: ProposedCriterion[] | null;
}

export type CatalogProposedFields =
  | CatalogOfferProposedFields
  | CatalogDemandProposedFields;

export interface CatalogTextEvidence {
  /** Chemin stable, par exemple `model`, `price` ou `attributes.0`. */
  field: string;
  /** Extrait exact du texte d'origine. */
  quote: string;
}

export interface CatalogExtractionAmbiguity {
  field: string;
  code: string;
  message: string;
  /** Extraits exacts et contradictoires ou incomplets. */
  evidence: string[];
}

interface CatalogExtractionProposalBase {
  contractVersion: typeof CATALOG_EXTRACTION_CONTRACT_VERSION;
  extractorVersion:
    | typeof DETERMINISTIC_EXTRACTOR_VERSION
    | typeof AI_EXTRACTOR_VERSION;
  provenance: CatalogExtractionProvenance;
  rawText: string;
  evidence: CatalogTextEvidence[];
  ambiguities: CatalogExtractionAmbiguity[];
}

export type CatalogExtractionProposal =
  | (CatalogExtractionProposalBase & {
      type: "offer";
      fields: CatalogOfferProposedFields;
    })
  | (CatalogExtractionProposalBase & {
      type: "demand";
      fields: CatalogDemandProposedFields;
    });

export interface CatalogAiExtractionRequest {
  contractVersion: typeof CATALOG_EXTRACTION_CONTRACT_VERSION;
  type: CatalogExtractionType;
  rawText: string;
  deterministicFields: CatalogProposedFields;
}

/** Aucun fournisseur n'est instancié par le module. */
export interface CatalogAiExtractor {
  extract(request: CatalogAiExtractionRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface CatalogExtractionOptions {
  mode?: "deterministic" | "ai";
  ai?: CatalogAiExtractor;
  signal?: AbortSignal;
}
