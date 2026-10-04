/**
 * Compréhension sémantique d'un besoin acheteur.
 *
 * L'IA aide à reformuler et à lever les synonymes, mais ne remplace jamais
 * les contrôles déterministes (budget, unités, modèle, zone). Les contraintes
 * qu'elle extrait ne sont conservées que si leur preuve figure dans le texte
 * de l'acheteur.
 */
import { z } from "zod";
import { llmJson } from "./llm";
import { accentNormalize, type ParsedNeed, type SemanticCriterion } from "./need";

export type UnderstoodCriterion = SemanticCriterion;

export interface NeedClarification {
  id: string;
  question: string;
  options: string[];
}

export interface NeedUnderstanding {
  canonicalProduct: string;
  category: string;
  searchTerms: string[];
  requirements: UnderstoodCriterion[];
  preferences: UnderstoodCriterion[];
  exclusions: UnderstoodCriterion[];
  confidence: number;
  clarification: NeedClarification | null;
  source: "ai" | "fallback";
}

export type NeedUnderstander = (
  need: ParsedNeed,
  signal?: AbortSignal,
  clarificationAnswer?: string,
) => Promise<NeedUnderstanding>;

const CriterionSchema = z.object({
  label: z.string().min(1).max(50),
  value: z.string().min(1).max(100),
  evidence: z.string().min(1).max(160),
});

const UnderstandingSchema = z.object({
  canonicalProduct: z.string().min(1).max(100),
  category: z.string().min(1).max(60),
  searchTerms: z.array(z.string().min(1).max(60)).max(8).default([]),
  requirements: z.array(CriterionSchema).max(10).default([]),
  preferences: z.array(CriterionSchema).max(10).default([]),
  exclusions: z.array(CriterionSchema).max(10).default([]),
  confidence: z.number().min(0).max(1),
  clarification: z
    .object({
      question: z.string().min(1).max(160),
      options: z.array(z.string().min(1).max(60)).min(2).max(4),
    })
    .nullable(),
});

const clean = (value: string, max: number): string =>
  value.replace(/\s+/g, " ").trim().slice(0, max);

const unique = (values: string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw, 60);
    const key = accentNormalize(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
};

const uniqueCriteria = (items: UnderstoodCriterion[]): UnderstoodCriterion[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = accentNormalize(item.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const evidenceIsPresent = (text: string, evidence: string): boolean =>
  accentNormalize(text).includes(accentNormalize(evidence));

const positiveExclusionValue = (value: string): string =>
  value.replace(/^(?:sans|pas(?:\s+de)?|non)\s+/i, "").trim();

export const semanticTokens = (value: string): string[] =>
  accentNormalize(value)
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);

/** Une valeur IA doit être réellement portée par sa citation : une preuve
 * « 300 litres » ne peut pas justifier une valeur « 500 litres ». */
export const valueSupportedByEvidence = (value: string, evidence: string): boolean => {
  const expected = semanticTokens(value);
  const quoted = new Set(semanticTokens(evidence));
  return expected.length > 0 && expected.every((token) => quoted.has(token));
};

const NEGATION_TAIL = /(?:^|[\s,;.])(pas|non|sans|jamais|plus|ni)\s+(?:en\s+|de\s+|d'\s+)?$/;

/** État textuel d'une valeur dans une annonce. Les séparateurs varient
 * librement (« USB-C » = « USB C »), mais les tokens restent complets. */
export function semanticEvidenceState(
  text: string,
  value: string,
): "affirmed" | "negated" | "absent" {
  const normalized = accentNormalize(text);
  const tokens = semanticTokens(value);
  if (tokens.length === 0) return "absent";
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped.join("[^a-z0-9]+")}(?=$|[^a-z0-9])`, "g");
  let foundNegated = false;
  for (const match of normalized.matchAll(pattern)) {
    // Le groupe de frontière peut consommer l'espace précédant la valeur ;
    // la fenêtre doit finir au vrai début du premier token pour voir « sans ».
    const boundaryLength = /^[^a-z0-9]/.test(match[0]) ? 1 : 0;
    const start = (match.index ?? 0) + boundaryLength;
    const before = normalized.slice(Math.max(0, start - 24), start);
    if (NEGATION_TAIL.test(before)) foundNegated = true;
    else return "affirmed";
  }
  return foundNegated ? "negated" : "absent";
}

const ATTRIBUTE_EVIDENCE_TOKENS: Record<string, string[]> = {
  L: ["l", "litre", "litres"],
  W: ["w", "watt", "watts"],
  BTU: ["btu"],
  CV: ["cv", "cheval", "chevaux"],
  pouces: ["pouce", "pouces"],
  pointure: ["pointure", "taille"],
  taille: ["taille", "pointure"],
  places: ["place", "places"],
  kg: ["kg", "kilo", "kilos"],
  cm: ["cm", "centimetre", "centimetres"],
  m: ["m", "metre", "metres"],
};

/** Les champs déjà contrôlés par le parseur ne doivent pas être comptés une
 * seconde fois comme exigences sémantiques de l'annonce. */
const isDeterministicCriterion = (
  need: ParsedNeed,
  criterion: UnderstoodCriterion,
): boolean => {
  const label = accentNormalize(criterion.label);
  if (need.budget && /\b(budget|prix|price|montant|plafond)\b/.test(label)) return true;
  if (
    need.zone &&
    /\b(zone|lieu|location|localisation|ville|quartier|commune)\b/.test(label)
  ) return true;
  if (
    need.capacity &&
    /\b(capacite|capacity|stockage|storage|memoire|memory)\b/.test(label)
  ) return true;

  const evidenceTokens = new Set(semanticTokens(criterion.evidence));
  return (need.attributes ?? []).some((attribute) => {
    const value = String(attribute.value);
    const units = ATTRIBUTE_EVIDENCE_TOKENS[attribute.label] ?? [accentNormalize(attribute.label)];
    return evidenceTokens.has(value) && units.some((unit) => evidenceTokens.has(unit));
  });
};

/** Taxonomie minimale des mots réellement polysémiques. Elle est centralisée
 * ici pour pouvoir être enrichie par les cas observés, sans disperser des
 * exceptions dans le filtre ou les connecteurs. */
const KNOWN_AMBIGUITIES: {
  products: string[];
  question: string;
  options: string[];
}[] = [
  {
    products: ["console"],
    question: "Quel type de console cherchez-vous ?",
    options: ["Console de jeux", "Meuble console"],
  },
];

/** Valide la sortie IA et retire toute contrainte sans preuve utilisateur. */
export function normalizeUnderstanding(
  need: ParsedNeed,
  raw: {
    canonicalProduct: string;
    category: string;
    searchTerms?: string[];
    requirements?: UnderstoodCriterion[];
    preferences?: UnderstoodCriterion[];
    exclusions?: UnderstoodCriterion[];
    confidence: number;
    clarification: { question: string; options: string[] } | null;
  },
  clarificationAnswer?: string,
): NeedUnderstanding {
  const evidenceText = clarificationAnswer
    ? `${need.text} ${clarificationAnswer}`
    : need.text;
  const keepProven = (items: UnderstoodCriterion[] = [], exclusion = false) =>
    items
      .map((item) => {
        const value = clean(item.value, 100);
        return {
          label: clean(item.label, 50),
          value: exclusion
            ? positiveExclusionValue(value)
            : value,
          evidence: clean(item.evidence, 160),
        };
      })
      .filter(
        (item) =>
          evidenceIsPresent(evidenceText, item.evidence) &&
          valueSupportedByEvidence(item.value, item.evidence),
      )
      .filter((item) => exclusion || !isDeterministicCriterion(need, item));

  const provenRequirements = keepProven(raw.requirements);
  const provenPreferences = keepProven(raw.preferences);
  const explicitExclusions = keepProven(raw.exclusions, true);
  const evidenceNegates = (item: UnderstoodCriterion): boolean => {
    const value = positiveExclusionValue(item.value);
    return semanticEvidenceState(item.evidence, value) === "negated";
  };
  const movedExclusions = [...provenRequirements, ...provenPreferences]
    .filter(evidenceNegates)
    .map((item) => ({ ...item, value: positiveExclusionValue(item.value) }));
  const exclusions = uniqueCriteria([...explicitExclusions, ...movedExclusions]);

  const options = raw.clarification
    ? unique(raw.clarification.options, 4)
    : [];
  const knownAmbiguity = KNOWN_AMBIGUITIES.find((entry) =>
    entry.products.includes(accentNormalize(need.product).trim()),
  );
  // Une clarification est réservée à une ambiguïté structurante. Un niveau
  // de confiance élevé ou moins de deux choix concrets ne bloque jamais la
  // recherche.
  const modelClarification =
    !clarificationAnswer &&
    raw.clarification &&
    options.length >= 2 &&
    (raw.confidence < 0.8 || Boolean(knownAmbiguity))
      ? {
          id: "product-intent",
          question: clean(raw.clarification.question, 160),
          options,
        }
      : null;
  const clarification = modelClarification ?? (
    !clarificationAnswer && knownAmbiguity
      ? {
          id: "product-intent",
          question: knownAmbiguity.question,
          options: knownAmbiguity.options,
        }
      : null
  );

  // Le choix signé de l'acheteur est l'autorité : même si le modèle IA
  // l'ignore, le produit recherché reste exactement l'option sélectionnée.
  const canonicalProduct =
    clean(clarificationAnswer ?? "", 100) ||
    clean(raw.canonicalProduct, 100) ||
    need.product;
  const terms = unique(
    [...(raw.searchTerms ?? []), canonicalProduct, need.product],
    8,
  );

  return {
    canonicalProduct,
    category: clean(raw.category, 60) || (need.kind === "service" ? "service" : "produit"),
    searchTerms: terms,
    requirements: provenRequirements.filter((item) => !evidenceNegates(item)),
    preferences: provenPreferences.filter((item) => !evidenceNegates(item)),
    exclusions,
    confidence: raw.confidence,
    clarification,
    source: "ai",
  };
}

export function fallbackUnderstanding(
  need: ParsedNeed,
  clarificationAnswer?: string,
): NeedUnderstanding {
  const product = clean(clarificationAnswer ?? "", 100) || need.product || need.model || need.text.slice(0, 100);
  return {
    canonicalProduct: product,
    category: need.kind === "service" ? "service" : "produit",
    searchTerms: unique([product], 8),
    requirements: [],
    preferences: [],
    exclusions: [],
    confidence: 0,
    clarification: null,
    source: "fallback",
  };
}

/** Compréhension réelle via la porte IA commune (budget, annulation, ledger). */
export const makeNeedUnderstander = (): NeedUnderstander => async (need, signal, clarificationAnswer) => {
  const fallback = fallbackUnderstanding(need, clarificationAnswer);
  try {
    const { data } = await llmJson(UnderstandingSchema, {
      task: "need-understanding",
      system:
        "Tu comprends une demande d'achat ou de service en Côte d'Ivoire. " +
        "Retourne un objet JSON avec EXACTEMENT cette structure et ces noms de clés en anglais : " +
        '{"canonicalProduct":"...","category":"...","searchTerms":["..."],"requirements":[{"label":"...","value":"...","evidence":"..."}],"preferences":[],"exclusions":[],"confidence":0.85,"clarification":null}. ' +
        "requirements, preferences, exclusions et searchTerms sont toujours des tableaux. clarification vaut null ou {\"question\":\"...\",\"options\":[\"...\",\"...\"]}. " +
        "Retourne le produit canonique, sa catégorie, et 2 à 8 noms courts équivalents réellement utiles pour chercher des annonces (français, abréviations courantes et vocabulaire local). Place en PREMIER le terme le plus utilisé dans les annonces ivoiriennes ; n'ajoute ni budget, ni zone, ni caractéristique chiffrée dans ces termes. " +
        "Sépare exigences obligatoires, préférences et exclusions. Ne répète pas dans ces tableaux les champs déjà présents dans extractionDeterministe (budget, zone, capacité, caractéristiques chiffrées, modèle). Toute négation explicite avec 'sans', 'pas' ou 'pas de' doit apparaître dans exclusions ; par exemple 'pas de contrefaçon' donne value='contrefaçon' et evidence='pas de contrefaçon'. Chaque élément doit citer dans evidence un extrait MOT POUR MOT de la demande ou de la précision choisie, et sa value doit être présente dans cet extrait. Pour une exclusion, écris la value sous forme positive (exemple : congélateur pour 'sans congélateur'). N'invente jamais une marque, un état, un usage, une zone ou un budget. " +
        "Si une précision choisie est fournie, utilise-la pour déterminer le produit et retourne clarification=null. Sinon, pose une clarification si plusieurs TYPES DE PRODUITS OU SERVICES sont plausibles et que le choix changerait les résultats. Ne choisis jamais un sens seulement parce qu'il est plus fréquent : 'console' seule est ambiguë entre console de jeux et meuble console et exige une clarification. Ne demande jamais une préférence facultative absente (couleur, état, budget ou quartier). Donne 2 à 4 choix courts. Sinon clarification=null.",
      user: JSON.stringify({
        demande: need.text,
        precisionChoisie: clarificationAnswer ?? null,
        extractionDeterministe: {
          type: need.kind,
          produit: need.product,
          modele: need.model,
          variante: need.variant,
          capacite: need.capacity,
          budget: need.budget,
          zone: need.zone,
          caracteristiques: need.attributes,
          criteres: need.criteria,
        },
      }),
      maxTokens: 900,
      timeoutMs: 30_000,
      signal,
    });
    return normalizeUnderstanding(need, data, clarificationAnswer);
  } catch {
    // La compréhension enrichie est une amélioration : une panne ou un
    // budget insuffisant ne doit jamais supprimer la recherche de base.
    return fallback;
  }
};

/** Enrichit le besoin sans toucher aux contraintes déterministes. */
export function applyUnderstanding(
  need: ParsedNeed,
  understanding: NeedUnderstanding,
): ParsedNeed {
  need.semantic = {
    canonicalProduct: understanding.canonicalProduct,
    category: understanding.category,
    searchTerms: understanding.searchTerms,
    requirements: understanding.requirements,
    preferences: understanding.preferences,
    exclusions: understanding.exclusions,
  };
  return need;
}
