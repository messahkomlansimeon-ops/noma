/**
 * Présentation et saisie du catalogue (offres du vendeur, besoins de l'acheteur) : fonctions pures, sans React,
 * partagées par les écrans branchés sur l'API et testées isolément. Aucun accès aux données de démonstration ni au store de prototype.
 */

import { parseBudgetFcfa } from "../contracts";
import type { DemandInput, DemandRecord, DemandStatus, Money, OfferInput, OfferRecord, OfferStatus } from "./api";

export type ArtKey = "phone" | "sofa" | "laptop" | "ac" | "drill" | "car" | "box";
export type Tone = "sage" | "carrot" | "wash" | "sky" | "forest";

export const CURRENCY = "XOF";

export const CATEGORY_OPTIONS: readonly { label: string; art: ArtKey }[] = [
  { label: "Téléphones", art: "phone" },
  { label: "Maison et meubles", art: "sofa" },
  { label: "Électronique", art: "laptop" },
  { label: "Climatisation", art: "ac" },
  { label: "Outillage", art: "drill" },
  { label: "Véhicules", art: "car" },
];

export const CONDITION_OPTIONS = ["Neuf", "Occasion", "Reconditionné"] as const;

/** Illustration d'après la catégorie (sans accent ni casse) ; « box » si inconnue ou absente. */
export function artForCategory(category: string | null): ArtKey {
  if (!category) return "box";
  const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const wanted = normalize(category);
  return CATEGORY_OPTIONS.find((option) => normalize(option.label) === wanted)?.art ?? "box";
}

/** 150000 → « 150 000 » (espace insécable). */
export function formatAmount(amount: number): string {
  return Math.trunc(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Montant lisible : XOF s'affiche « FCFA », toute autre devise garde son code. */
export function formatMoney(money: Money | null): string | null {
  if (!money) return null;
  return `${formatAmount(money.amount)} ${money.currency === CURRENCY ? "FCFA" : money.currency}`;
}

const TITLE_MAX = 80;

/** Titre d'affichage : première ligne non vide du texte ; à défaut marque, modèle, variante. */
export function recordTitle(record: Pick<OfferRecord, "rawText" | "brand" | "model" | "variant">): string {
  const firstLine = record.rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = firstLine ?? [record.brand, record.model, record.variant].filter(Boolean).join(" ");
  if (!text) return "Sans titre";
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

export const OFFER_STATUS_VIEW: Record<OfferStatus, { label: string; tone: Tone }> = {
  draft: { label: "Brouillon", tone: "wash" },
  published: { label: "En ligne", tone: "sage" },
  paused: { label: "En pause", tone: "carrot" },
  archived: { label: "Archivée", tone: "wash" },
};

export const DEMAND_STATUS_VIEW: Record<DemandStatus, { label: string; tone: Tone }> = {
  draft: { label: "Brouillon", tone: "wash" },
  active: { label: "Active", tone: "sage" },
  satisfied: { label: "Satisfait", tone: "sky" },
  archived: { label: "Archivé", tone: "wash" },
};

export type OfferAction = "publish" | "pause" | "archive";
export type DemandAction = "activate" | "satisfy" | "archive";

/** Actions proposées par statut : exactement les transitions que le serveur autorise. */
export function offerActions(status: OfferStatus): { action: OfferAction; label: string }[] {
  switch (status) {
    case "draft":
      return [{ action: "publish", label: "Publier" }, { action: "archive", label: "Archiver" }];
    case "published":
      return [{ action: "pause", label: "Mettre en pause" }, { action: "archive", label: "Archiver" }];
    case "paused":
      return [{ action: "publish", label: "Remettre en ligne" }, { action: "archive", label: "Archiver" }];
    default:
      return [];
  }
}

export function demandActions(status: DemandStatus): { action: DemandAction; label: string }[] {
  switch (status) {
    case "draft":
      return [{ action: "activate", label: "Activer" }, { action: "archive", label: "Archiver" }];
    case "active":
      return [{ action: "satisfy", label: "Marquer satisfait" }, { action: "archive", label: "Archiver" }];
    case "satisfied":
      return [{ action: "activate", label: "Réactiver" }, { action: "archive", label: "Archiver" }];
    default:
      return [];
  }
}

export type OfferFilter = "all" | "published" | "paused" | "draft" | "archived";
export const OFFER_FILTERS: readonly { id: OfferFilter; label: string }[] = [
  { id: "all", label: "Actives" },
  { id: "published", label: "En ligne" },
  { id: "paused", label: "En pause" },
  { id: "draft", label: "Brouillon" },
  { id: "archived", label: "Archivées" },
];

/** « Actives » ne montre pas les annonces archivées (elles ont leur propre filtre). */
export function filterOffers(offers: readonly OfferRecord[], filter: OfferFilter): OfferRecord[] {
  return offers.filter((offer) => (filter === "all" ? offer.status !== "archived" : offer.status === filter));
}

export function countOffers(offers: readonly OfferRecord[], filter: OfferFilter): number {
  return filterOffers(offers, filter).length;
}

export type DemandFilter = "all" | "active" | "draft" | "satisfied" | "archived";
export const DEMAND_FILTERS: readonly { id: DemandFilter; label: string }[] = [
  { id: "all", label: "Actifs" },
  { id: "active", label: "En cours" },
  { id: "draft", label: "Brouillon" },
  { id: "satisfied", label: "Satisfaits" },
  { id: "archived", label: "Archivés" },
];

/** « Actifs » ne montre pas les besoins archivés (ils ont leur propre filtre) ; « En cours » = statut actif seulement. */
export function filterDemands(demands: readonly DemandRecord[], filter: DemandFilter): DemandRecord[] {
  return demands.filter((demand) => (filter === "all" ? demand.status !== "archived" : demand.status === filter));
}

/** Message fixe affiché quand la liste dépasse le plafond de pages de `listAll` (liste incomplète). */
export const LIST_TRUNCATED_MESSAGE = "Liste incomplète : trop d'éléments à afficher.";

/** Compteur d'un filtre (« · 7 ») ; vide quand la liste est tronquée : un nombre partiel ne doit pas passer pour exact. */
export function countSuffix(count: number, truncated: boolean): string {
  return truncated ? "" : ` · ${count}`;
}

/** Plus récentes d'abord (le serveur trie par création croissante). */
export function newestFirst<T extends { createdAt: string; id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Remplace l'enregistrement du même identifiant (nouvelle version de contenu après une action). */
export function replaceRecord<T extends { id: string }>(records: readonly T[], updated: T): T[] {
  return records.map((record) => (record.id === updated.id ? updated : record));
}

// ─── Saisie ────────────────────────────────────────────────────────────────

export const FIELD_LIMITS = { title: 120, description: 2000, short: 60, location: 100 } as const;

export type FormResult<T> = { ok: true; input: T } | { ok: false; errors: Record<string, string> };

function clean(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function parseMoneyField(
  text: string,
  field: string,
  label: string,
  errors: Record<string, string>,
  options: { positive?: string } = {},
): Money | null {
  if (text.trim().length === 0) return null;
  const parsed = parseBudgetFcfa(text);
  if (!parsed.ok) {
    // « parseBudgetFcfa » parle de « Budget » : pour un autre champ (prix), le libellé du champ le remplace.
    errors[field] =
      label !== "Budget" && parsed.reason.startsWith("Budget « ")
        ? parsed.reason.replace(/^Budget /, `${label} `)
        : `${label} : ${parsed.reason}`;
    return null;
  }
  if (options.positive && parsed.value <= 0) {
    errors[field] = options.positive;
    return null;
  }
  return { amount: parsed.value, currency: CURRENCY };
}

export interface OfferFormValues {
  title: string;
  description: string;
  category: string | null;
  brand: string;
  model: string;
  variant: string;
  condition: string | null;
  location: string;
  price: string;
  available: boolean;
}

/** Valeurs du formulaire « Nouvelle annonce » → corps de POST /api/offers ; erreurs par champ en français. */
export function buildOfferInput(values: OfferFormValues): FormResult<OfferInput> {
  const errors: Record<string, string> = {};
  const title = clean(values.title);
  if (!title) errors.title = "Le titre est requis.";
  else if (title.length > FIELD_LIMITS.title) errors.title = `Le titre est limité à ${FIELD_LIMITS.title} caractères.`;
  const description = clean(values.description);
  if (description && description.length > FIELD_LIMITS.description) {
    errors.description = `La description est limitée à ${FIELD_LIMITS.description} caractères.`;
  }
  const price = parseMoneyField(values.price, "price", "Prix", errors, {
    positive: "Le prix doit être supérieur à 0.",
  });
  if (Object.keys(errors).length > 0 || !title) return { ok: false, errors };

  return {
    ok: true,
    input: {
      rawText: [title, description].filter(Boolean).join("\n\n"),
      category: values.category,
      brand: clean(values.brand),
      model: clean(values.model),
      variant: clean(values.variant),
      condition: values.condition,
      location: clean(values.location),
      price,
      availabilityStatus: values.available ? "available" : "unavailable",
    },
  };
}

export interface DemandFormValues {
  text: string;
  category: string | null;
  brand: string;
  model: string;
  variant: string;
  condition: string | null;
  location: string;
  budget: string;
  /** Date au format AAAA-MM-JJ (champ date), facultative. */
  deadline: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** AAAA-MM-JJ valide (calendrier réel) → fin de journée UTC au format ISO strict attendu par le serveur. */
export function deadlineToIso(value: string): string | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month}-${day}T23:59:59Z`;
}

/** Valeurs du formulaire « Nouveau besoin » → corps de POST /api/demands. `today` (AAAA-MM-JJ UTC) sert à refuser une échéance passée. */
export function buildDemandInput(values: DemandFormValues, today: string): FormResult<DemandInput> {
  const errors: Record<string, string> = {};
  const text = clean(values.text);
  if (!text) errors.text = "Décrivez ce que vous cherchez.";
  else if (text.length > FIELD_LIMITS.description) {
    errors.text = `La description est limitée à ${FIELD_LIMITS.description} caractères.`;
  }
  const budget = parseMoneyField(values.budget, "budget", "Budget", errors);
  let deadlineAt: string | null = null;
  if (values.deadline.trim().length > 0) {
    deadlineAt = deadlineToIso(values.deadline.trim());
    if (!deadlineAt) errors.deadline = "Date invalide.";
    else if (values.deadline.trim() < today) errors.deadline = "La date doit être aujourd'hui ou plus tard.";
  }
  if (Object.keys(errors).length > 0 || !text) return { ok: false, errors };

  return {
    ok: true,
    input: {
      rawText: text,
      category: values.category,
      brand: clean(values.brand),
      model: clean(values.model),
      variant: clean(values.variant),
      condition: values.condition,
      location: clean(values.location),
      budget,
      deadlineAt,
    },
  };
}

/** Résumé d'un besoin pour la liste : « Abidjan · 200 000 FCFA max ». */
export function demandSummary(demand: Pick<DemandRecord, "location" | "budget" | "condition">): string {
  const parts = [demand.location, demand.condition];
  const budget = formatMoney(demand.budget);
  if (budget) parts.push(`${budget} max`);
  return parts.filter(Boolean).join(" · ");
}

/** Résumé d'une annonce pour la liste : « Apple · iPhone 12 · 128 Go ». */
export function offerSummary(offer: Pick<OfferRecord, "brand" | "model" | "variant" | "condition" | "location">): string {
  return [offer.brand, offer.model, offer.variant, offer.condition, offer.location].filter(Boolean).join(" · ");
}
