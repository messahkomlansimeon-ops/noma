/**
 * Présentation des propositions d'extraction du catalogue : fonctions PURES, sans React, partagées par la carte et testées isolément. Voir CATALOG-EXTRACTION-HTTP.md.
 *
 * Règles de sécurité de l'écran :
 *  - rien n'est coché d'avance quand la fiche a DÉJÀ une valeur pour ce champ (on ne remplace jamais une valeur saisie sans que le propriétaire le décide) ;
 *  - un champ ambigu (deux capacités, devise inconnue…) est montré mais ne peut pas être coché ;
 *  - un champ dont la proposition est identique à la fiche n'est pas proposé du tout ;
 *  - les valeurs appliquées viennent du serveur : l'écran n'envoie que les NOMS des champs cochés.
 */

import { ApiError, API_ABORTED, API_NETWORK_ERROR, type JsonObject, type JsonValue, type Money } from "./api";
import { formatAmount } from "./catalog-view";
import { formatDateFr } from "./wallet-view";
import type { ExtractionAttribute, ExtractionCriterion, ExtractionMoney, ExtractionProposal, ExtractionSelection } from "./extraction-api";

export const EXTRACTION_TITLE = "Remplir la fiche depuis mon texte";
export const EXTRACTION_INTRO = "noma lit le texte que vous avez écrit et propose de renseigner la marque, le modèle, l'état, le prix… Rien n'est changé sans votre accord.";
export const EXTRACTION_ANALYZE = "Analyser mon texte";
export const EXTRACTION_ANALYZING = "Analyse en cours…";
export const EXTRACTION_AGAIN = "Analyser à nouveau";
export const EXTRACTION_APPLY = "Appliquer la sélection";
export const EXTRACTION_APPLYING = "Application…";
export const EXTRACTION_NOTHING_FOUND = "Rien de nouveau n'a été trouvé dans votre texte : la fiche contient déjà ces informations, ou le texte ne les donne pas.";
export const EXTRACTION_STALE = "Votre texte ou votre fiche a changé depuis cette analyse. Analysez-le à nouveau pour obtenir des propositions à jour.";
export const EXTRACTION_BLOCKED_NOTE = "Non applicable";
export const EXTRACTION_CURRENT_PREFIX = "Actuellement : ";
export const EXTRACTION_SELECT_NONE = "Cochez au moins une proposition pour l'appliquer.";
/**
 * L'analyse écrit des CODES (« phones », « very_good ») alors que le formulaire, la mise en correspondance (égalité stricte sur la catégorie) et les affichages de noma parlent en français
 * (« Téléphones », « Occasion »). Appliquer ces deux champs ferait passer l'annonce à côté des besoins créés avec le formulaire et afficherait un code à l'écran : ils sont donc MONTRÉS
 * (ce que le texte dit) mais non applicables, tant que le serveur ne les traduit pas dans le vocabulaire de noma.
 */
export const EXTRACTION_VOCABULARY_NOTE = "à choisir dans le formulaire de la fiche (ses choix ne portent pas les mêmes mots que l'analyse).";
export const EXTRACTION_ARCHIVED = "Cette fiche est archivée : elle ne peut plus être modifiée.";

const FIELD_LABELS: Record<string, string> = {
  category: "Catégorie",
  brand: "Marque",
  model: "Modèle",
  variant: "Version",
  condition: "État",
  quantity: "Quantité",
  location: "Lieu",
  deadlineAt: "Échéance",
  price: "Prix",
  budget: "Budget",
  requirements: "Exigences",
  preferences: "Préférences",
};

const CATEGORY_LABELS: Record<string, string> = {
  phones: "Téléphones",
  televisions: "Télévisions",
  computers: "Ordinateurs",
  appliances: "Électroménager",
  furniture: "Meubles",
  vehicles: "Véhicules",
  fashion: "Mode",
};

const CONDITION_LABELS: Record<string, string> = {
  new: "Neuf",
  like_new: "Comme neuf",
  very_good: "Très bon état",
  good: "Bon état",
};

const ATTRIBUTE_LABELS: Record<string, string> = {
  storage_capacity: "Stockage",
  mileage: "Kilométrage",
  shoe_size: "Pointure",
  size: "Taille",
  screen_size: "Écran",
  cooling_capacity: "Puissance de refroidissement",
  power: "Puissance",
  volume: "Volume",
  length: "Longueur",
  weight: "Poids",
  seating_capacity: "Places",
  charger_included: "Chargeur inclus",
  barter_accepted: "Troc accepté",
  warranty_mentioned: "Garantie mentionnée",
};

const UNIT_LABELS: Record<string, string> = { GB: "Go", TB: "To", in: "pouces", hp: "ch", count: "" };

const OPERATOR_LABELS: Record<ExtractionCriterion["operator"], string> = { includes: "avec", excludes: "sans", equals: "exactement" };

export type ExtractionFieldKey = "category" | "brand" | "model" | "variant" | "condition" | "quantity" | "location" | "deadlineAt" | "price" | "budget" | "requirements" | "preferences";

/** Ce que la fiche contient aujourd'hui (offre ou besoin) : sert à ne pas proposer ce qui est déjà là et à ne rien cocher par-dessus une valeur saisie. */
export interface ExtractionCurrent {
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition: string | null;
  quantity: number | null;
  location: string | null;
  deadlineAt: string | null;
  attributes: JsonObject | null;
  price?: Money | null;
  budget?: Money | null;
  requirements?: JsonValue[] | null;
  preferences?: JsonValue[] | null;
}

export interface ExtractionRow {
  /** Identifiant stable de la ligne : `field:<nom>` ou `attr:<clé>`. */
  id: string;
  kind: "field" | "attribute";
  /** Le nom envoyé au serveur (champ de premier niveau ou clé d'attribut). */
  key: string;
  label: string;
  value: string;
  /** L'extrait EXACT du texte de l'utilisateur d'où vient la valeur, quand le serveur l'a donné. */
  quote: string | null;
  /** La valeur actuelle de la fiche, si elle diffère. */
  current: string | null;
  /** Pourquoi la ligne ne peut pas être cochée (ambiguïté, devise inconnue), sinon null. */
  blocked: string | null;
  /** Coché d'avance : seulement quand rien n'est encore saisi dans la fiche pour ce champ. */
  preselected: boolean;
}

const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const norm = (value: string): string => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

function moneyText(money: ExtractionMoney | Money): string {
  return `${formatAmount(money.amount)} ${money.currency === "XOF" ? "FCFA" : (money.currency ?? "")}`.trim();
}

function categoryText(value: string): string {
  return CATEGORY_LABELS[value] ?? value;
}

function conditionText(value: string): string {
  return CONDITION_LABELS[value] ?? value;
}

export function attributeLabel(key: string): string {
  if (ATTRIBUTE_LABELS[key]) return ATTRIBUTE_LABELS[key];
  const words = key.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function attributeValueText(attribute: Pick<ExtractionAttribute, "value" | "unit">): string {
  if (typeof attribute.value === "boolean") return attribute.value ? "Oui" : "Non";
  const unit = attribute.unit === null ? "" : (UNIT_LABELS[attribute.unit] ?? attribute.unit);
  return `${attribute.value}${unit ? ` ${unit}` : ""}`;
}

function criteriaText(criteria: readonly ExtractionCriterion[]): string {
  return criteria.map((criterion) => `${OPERATOR_LABELS[criterion.operator]} ${criterion.key.replace(/_/g, " ")} ${criterion.value}`.trim()).join(" ; ");
}

function jsonCriteriaText(value: JsonValue[] | null | undefined): string | null {
  if (!value || value.length === 0) return null;
  const parts = value.map((item) => (typeof item === "object" && item !== null && !Array.isArray(item) && typeof item.key === "string" ? `${item.key} ${String(item.value ?? "")}`.trim() : "")).filter(Boolean);
  return parts.length > 0 ? parts.join(" ; ") : null;
}

function currentAttributeText(attributes: JsonObject | null, key: string): string | null {
  const stored = attributes?.[key];
  if (stored === undefined || stored === null) return null;
  if (typeof stored === "object" && !Array.isArray(stored) && "value" in stored) {
    const value = stored.value;
    const unit = typeof stored.unit === "string" ? stored.unit : null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return attributeValueText({ value, unit });
    return null;
  }
  if (typeof stored === "string" || typeof stored === "number" || typeof stored === "boolean") return attributeValueText({ value: stored, unit: null });
  return null;
}

function ambiguityFor(proposal: ExtractionProposal, matches: (field: string) => boolean): string | null {
  const found = proposal.ambiguities.find((ambiguity) => matches(ambiguity.field));
  return found ? found.message : null;
}

function quoteFor(proposal: ExtractionProposal, field: string): string | null {
  return proposal.evidence.find((item) => item.field === field)?.quote ?? null;
}

/** Les lignes à montrer : uniquement ce que le texte donne ET qui change la fiche. Les valeurs déjà identiques sont omises. */
export function extractionRows(proposal: ExtractionProposal, current: ExtractionCurrent): ExtractionRow[] {
  const rows: ExtractionRow[] = [];
  const f = proposal.fields;

  const scalar = (key: ExtractionFieldKey, proposed: string | null, currentText: string | null, same: boolean, blockedReason: string | null = null): void => {
    if (proposed === null || same) return;
    const blocked = ambiguityFor(proposal, (field) => field === key) ?? blockedReason;
    rows.push({
      id: `field:${key}`,
      kind: "field",
      key,
      label: FIELD_LABELS[key],
      value: proposed,
      quote: quoteFor(proposal, key),
      current: currentText,
      blocked,
      preselected: blocked === null && isEmpty(currentText),
    });
  };
  const sameText = (a: string | null, b: string | null): boolean => a !== null && b !== null && norm(a) === norm(b);

  if (f.category !== null) scalar("category", categoryText(f.category), current.category === null ? null : categoryText(current.category), sameText(f.category, current.category) || sameText(categoryText(f.category), current.category), EXTRACTION_VOCABULARY_NOTE);
  if (f.brand !== null) scalar("brand", f.brand, current.brand, sameText(f.brand, current.brand));
  if (f.model !== null) scalar("model", f.model, current.model, sameText(f.model, current.model));
  if (f.variant !== null) scalar("variant", f.variant, current.variant, sameText(f.variant, current.variant));
  if (f.condition !== null) scalar("condition", conditionText(f.condition), current.condition, sameText(f.condition, current.condition) || sameText(conditionText(f.condition), current.condition), EXTRACTION_VOCABULARY_NOTE);
  if (f.quantity !== null) scalar("quantity", String(f.quantity), current.quantity === null ? null : String(current.quantity), f.quantity === current.quantity);
  if (f.location !== null) scalar("location", f.location, current.location, sameText(f.location, current.location));
  if (f.deadlineAt !== null) {
    const same = current.deadlineAt !== null && Date.parse(current.deadlineAt) === Date.parse(f.deadlineAt);
    scalar("deadlineAt", formatDateFr(f.deadlineAt), current.deadlineAt === null ? null : formatDateFr(current.deadlineAt), same);
  }
  const proposedMoney = proposal.resourceType === "offer" ? f.price : f.budget;
  const currentMoney = proposal.resourceType === "offer" ? current.price : current.budget;
  const moneyKey: ExtractionFieldKey = proposal.resourceType === "offer" ? "price" : "budget";
  if (proposedMoney) {
    const noCurrency = proposedMoney.currency === null ? "La devise n'est pas indiquée dans votre texte." : null;
    const same = !!currentMoney && currentMoney.amount === proposedMoney.amount && currentMoney.currency === proposedMoney.currency;
    scalar(moneyKey, proposedMoney.currency === null ? `${formatAmount(proposedMoney.amount)} (devise inconnue)` : moneyText(proposedMoney), currentMoney ? moneyText(currentMoney) : null, same, noCurrency);
  }

  (f.attributes ?? []).forEach((attribute, index) => {
    const currentText = currentAttributeText(current.attributes, attribute.key);
    const proposedText = attributeValueText(attribute);
    if (currentText !== null && norm(currentText) === norm(proposedText)) return;
    const blocked = ambiguityFor(proposal, (field) => field === "attributes" || field === `attributes.${index}` || field === `attributes.${attribute.key}`);
    rows.push({
      id: `attr:${attribute.key}`,
      kind: "attribute",
      key: attribute.key,
      label: attributeLabel(attribute.key),
      value: proposedText,
      quote: quoteFor(proposal, `attributes.${index}`),
      current: currentText,
      blocked,
      preselected: blocked === null && currentText === null,
    });
  });

  if (proposal.resourceType === "demand") {
    for (const key of ["requirements", "preferences"] as const) {
      const proposed = f[key];
      if (!proposed || proposed.length === 0) continue;
      const currentText = jsonCriteriaText(current[key]);
      const proposedText = criteriaText(proposed);
      scalar(key, proposedText, currentText, currentText !== null && norm(currentText) === norm(proposedText));
    }
  }
  return rows;
}

/** La sélection à envoyer au serveur d'après les lignes cochées (les lignes non applicables sont toujours ignorées). */
export function selectionFor(rows: readonly ExtractionRow[], checked: ReadonlySet<string>): ExtractionSelection {
  const fields: string[] = [];
  const attributeKeys: string[] = [];
  for (const row of rows) {
    if (row.blocked !== null || !checked.has(row.id)) continue;
    (row.kind === "field" ? fields : attributeKeys).push(row.key);
  }
  return { fields, attributeKeys };
}

export const selectionCount = (selection: ExtractionSelection): number => selection.fields.length + selection.attributeKeys.length;

/** L'étendue de la clé d'idempotence : la proposition ET la sélection (le serveur refuse la même clé avec d'autres paramètres). */
export function selectionScope(proposalId: string, selection: ExtractionSelection): string {
  return `${proposalId}:${[...selection.fields].sort().join(",")}:${[...selection.attributeKeys].sort().join(",")}`;
}

export function initialChecked(rows: readonly ExtractionRow[]): Set<string> {
  return new Set(rows.filter((row) => row.preselected).map((row) => row.id));
}

export function appliedMessage(receipt: { versionBefore: number; versionAfter: number; changedFields: readonly string[] }): string {
  if (receipt.versionAfter === receipt.versionBefore || receipt.changedFields.length === 0) return "Rien à modifier : la fiche était déjà à jour.";
  const count = receipt.changedFields.length;
  return count === 1 ? "Fiche mise à jour : 1 information reportée." : `Fiche mise à jour : ${count} informations reportées.`;
}

/** Message FIXE pour l'utilisateur d'après (statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeExtractionError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "resource_archived") return EXTRACTION_ARCHIVED;
  if (error.code === "stale_proposal" || error.code === "stale_version" || error.code === "extraction_conflict" || error.code === "conflict") {
    return "Votre fiche a changé depuis l'analyse. Analysez-la à nouveau, puis appliquez.";
  }
  if (error.code === "extraction_validation_error") return "Votre texte est trop long pour être analysé. Raccourcissez-le puis réessayez.";
  if (error.status === 404) return "Cette fiche est introuvable : elle n'existe plus ou n'est pas à vous.";
  if (error.status === 400) return "Une des informations cochées ne peut pas être appliquée. Décochez-la et réessayez.";
  if (error.status === 413) return "Votre texte est trop long pour être analysé.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}

/** Les erreurs après lesquelles il faut relancer une analyse (la clé d'idempotence ne doit pas être gardée). */
export function needsNewAnalysis(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "stale_proposal" || error.code === "stale_version" || error.code === "extraction_conflict" || error.code === "conflict");
}
