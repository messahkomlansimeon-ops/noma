/**
 * Présentation de l'offre Pro (lot PRO1) : libellés et règles en fonctions PURES, sans React, testées isolément. Écrans :
 *  - « Offre Pro » (vendeur) : comparaison Gratuit / Pro aux prix PROVISOIRES, souscription, état, renouvellement, annulation, crédits promotionnels restants et leur échéance ;
 *  - le badge « Vendeur Pro » (fiche et résultats) et son texte honnête ;
 *  - l'import de catalogue par fichier CSV (aperçu, application, rapport ligne par ligne) ;
 *  - l'administration des plans (/admin/offres).
 * Règles : tout en mots simples ; jamais de code brut ; jamais de promesse de qualité (« Ce n'est pas une garantie de qualité ») ; les prix sont provisoires et le disent. Voir OFFRE-PRO.md.
 */

import type {
  AdminPlansOverview, CatalogImportResult, Entitlement, ImportRowReport, PlanView, SubscriptionNoticeView, SubscriptionState, SubscriptionView,
} from "./pro-api";
import { formatDateFr, formatDateTimeFr, formatFcfa } from "./wallet-view";

export const PRO_PAGE_TITLE = "Offre Pro";
export const PRO_PAGE_PATH = "/vendeur/offre-pro";
export const IMPORT_PAGE_PATH = "/vendeur/annonces/import";
export const ADMIN_OFFERS_PATH = "/admin/offres";

/** Prix, crédits et limites des plans de départ : décision du fondateur en attente. Affiché partout où un prix de plan apparaît. */
export const PRICES_PROVISIONAL_NOTICE = "Prix provisoires : ils peuvent changer avant le lancement. Un changement ne s'applique qu'aux nouveaux abonnements : les abonnés actuels gardent leur prix.";

/** Badge « Vendeur Pro » : texte honnête, jamais une garantie. */
export const PRO_BADGE_LABEL = "Vendeur Pro";
export const PRO_BADGE_NOTICE = "Abonné à l'offre Pro de noma. Ce n'est pas une garantie de qualité.";

/** Crédits promotionnels : leurs règles, en une phrase. */
export const PROMO_CREDITS_RULES =
  "Les crédits promotionnels sont dépensés en premier sur vos boosts, puis vos crédits complètent. Ils ne sont ni remboursables ni retirables, et ils expirent à la fin de chaque période.";

export const NO_REFUND_NOTE = "Annuler n'arrête que le renouvellement : la période déjà payée reste valable, sans remboursement.";

export const ENTITLEMENT_LABELS: Readonly<Record<Entitlement, string>> = Object.freeze({
  badge_pro: "Badge « Vendeur Pro » sur vos annonces",
  catalog_import: "Import de catalogue par fichier CSV",
  priority_support_label: "Étiquette « support prioritaire »",
});

export function entitlementLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(ENTITLEMENT_LABELS, code) ? ENTITLEMENT_LABELS[code as Entitlement] : "Droit de l'offre";
}

// ───────────── comparaison des plans ─────────────

export interface ComparisonRow {
  key: string;
  label: string;
  /** Une valeur par plan, dans l'ordre des colonnes. */
  values: string[];
}

export function planPriceText(plan: Pick<PlanView, "monthlyPriceXof">): string {
  return plan.monthlyPriceXof === 0 ? "Gratuit" : `${formatFcfa(plan.monthlyPriceXof)} par mois`;
}

const YES = "Oui";
const NO = "Non";

/** Tableau Gratuit / Pro : prix, annonces en ligne, crédits promotionnels, badge, import. */
export function comparisonRows(plans: readonly PlanView[]): ComparisonRow[] {
  return [
    { key: "price", label: "Prix", values: plans.map(planPriceText) },
    { key: "offers", label: "Annonces en ligne", values: plans.map((plan) => `${plan.maxOnlineOffers} au plus`) },
    { key: "promo", label: "Crédits promotionnels", values: plans.map((plan) => (plan.promoCreditsXof > 0 ? `${formatFcfa(plan.promoCreditsXof)} par mois` : "Aucun")) },
    { key: "badge", label: ENTITLEMENT_LABELS.badge_pro, values: plans.map((plan) => (plan.entitlements.includes("badge_pro") ? YES : NO)) },
    { key: "import", label: ENTITLEMENT_LABELS.catalog_import, values: plans.map((plan) => (plan.entitlements.includes("catalog_import") ? YES : NO)) },
  ];
}

/** Le plan payant proposé à la souscription : le premier plan à prix strictement positif (« pro »). */
export function subscribablePlan(plans: readonly PlanView[]): PlanView | null {
  return plans.find((plan) => plan.monthlyPriceXof > 0) ?? null;
}

// ───────────── état de l'abonnement ─────────────

export function onlineOffersText(online: number, max: number): string {
  const unit = online > 1 ? "annonces en ligne" : "annonce en ligne";
  return `${online} ${unit} sur ${max}`;
}

export type StatusTone = "good" | "neutral" | "warn";

export interface StatusView {
  tone: StatusTone;
  title: string;
  lines: string[];
}

/** Titre et phrases de l'état de l'offre (sans abonnement, actif, renouvellement désactivé, paiement en attente). */
export function statusView(state: Pick<SubscriptionState, "current" | "subscription" | "onlineOffers">, timeZone?: string): StatusView {
  const offers = onlineOffersText(state.onlineOffers, state.current.maxOnlineOffers);
  const sub = state.subscription;
  if (sub === null) {
    return { tone: "neutral", title: `Vous êtes sur l'offre ${state.current.planName}`, lines: [offers] };
  }
  const end = formatDateFr(sub.periodEnd, timeZone);
  if (sub.status === "past_due") {
    return {
      tone: "warn",
      title: "Paiement en attente",
      lines: [
        "Le renouvellement n'a pas pu être payé : votre solde est insuffisant.",
        sub.graceEndsAt === null
          ? "Rechargez votre porte-monnaie : nous réessayons automatiquement."
          : `Rechargez votre porte-monnaie avant le ${formatDateTimeFr(sub.graceEndsAt, timeZone)} : nous réessayons automatiquement. Vos droits sont conservés jusque-là.`,
        offers,
      ],
    };
  }
  if (!sub.autoRenew) {
    return { tone: "warn", title: `Offre ${planNameOf(state)} annulée`, lines: [`Elle prend fin le ${end}, sans nouveau paiement.`, NO_REFUND_NOTE, offers] };
  }
  return {
    tone: "good",
    title: `Offre ${planNameOf(state)} active`,
    lines: [`Période en cours jusqu'au ${end}.`, renewalText(sub, timeZone), offers],
  };
}

function planNameOf(state: Pick<SubscriptionState, "current">): string {
  return state.current.planName;
}

/** « Renouvellement automatique : 10 000 FCFA le 06/11/2026. » */
export function renewalText(sub: Pick<SubscriptionView, "autoRenew" | "periodEnd" | "renewalPriceXof">, timeZone?: string): string {
  if (!sub.autoRenew) return "Renouvellement automatique désactivé.";
  return `Renouvellement automatique : ${formatFcfa(sub.renewalPriceXof)} le ${formatDateFr(sub.periodEnd, timeZone)}, avec vos crédits.`;
}

export interface PromoView {
  /** Montant « 5 000 FCFA ». */
  amountText: string;
  /** « valables jusqu'au 06/11/2026 à 17:01 », ou null s'il n'y en a plus. */
  expiryText: string | null;
}

export function promoView(promo: { balanceXof: number; expiresAt: string | null }, timeZone?: string): PromoView {
  return {
    amountText: formatFcfa(promo.balanceXof),
    expiryText: promo.balanceXof > 0 && promo.expiresAt !== null ? `valables jusqu'au ${formatDateTimeFr(promo.expiresAt, timeZone)}` : null,
  };
}

// ───────────── avis ─────────────

export interface NoticeRowView {
  id: string;
  title: string;
  detail: string;
  dateText: string;
  unread: boolean;
}

const annonces = (count: number): string => (count === 1 ? "1 annonce" : `${count} annonces`);

/**
 * Détail de l'avis « annonces remises en ligne » (lot T3) : combien ont été remises en ligne, combien restent en pause et POURQUOI (la limite du plan, ou le vendeur lui-même). `stillPaused` est
 * relu à l'affichage (annonces en pause à cet instant) ; `null` (serveur plus ancien) : la phrase d'avant, sans nombre.
 */
export function restoredDetail(restored: number, stillPaused: { planLimit: number; byOwner: number } | null, maxOnlineOffers: number | null): string {
  const base = "Votre offre Pro est de nouveau active : les annonces mises en pause à la fin de votre précédent abonnement ont été remises en ligne, les plus récentes d'abord, dans la limite de votre offre.";
  if (stillPaused === null) return `${base} Celles que vous aviez mises en pause vous-même restent en pause.`;
  const parts = [base, `Remises en ligne : ${restored}.`];
  if (stillPaused.planLimit > 0) {
    const limit = maxOnlineOffers !== null && maxOnlineOffers > 0 ? ` (votre offre permet ${annonces(maxOnlineOffers)} en ligne)` : "";
    parts.push(
      `Toujours en pause : ${annonces(stillPaused.planLimit)}, faute de place dans la limite de votre offre${limit} ou parce que ${stillPaused.planLimit === 1 ? "son contenu ne respecte" : "leur contenu ne respecte"} plus les règles de publication. Mettez-en une autre en pause pour en remettre une en ligne.`,
    );
  }
  if (stillPaused.byOwner > 0) parts.push(`Toujours en pause : ${annonces(stillPaused.byOwner)} que vous aviez mise${stillPaused.byOwner === 1 ? "" : "s"} en pause vous-même.`);
  if (stillPaused.planLimit === 0 && stillPaused.byOwner === 0) parts.push("Aucune annonce ne reste en pause.");
  return parts.join(" ");
}

/** Texte fixe d'un avis (renouvellement refusé, abonnement terminé, annonces mises en pause, annonces remises en ligne) : jamais un code. */
export function noticeView(notice: SubscriptionNoticeView, timeZone?: string, maxOnlineOffers?: number | null): NoticeRowView {
  let title: string;
  let detail: string;
  switch (notice.code) {
    case "renewal_failed":
      title = "Renouvellement impossible";
      detail = "Votre solde était insuffisant pour renouveler l'offre Pro. Vous avez 3 jours de grâce pendant lesquels votre offre reste active : rechargez votre porte-monnaie, nous réessayons automatiquement.";
      break;
    case "subscription_ended":
      title = "Offre Pro terminée";
      detail = "Vous êtes revenu à l'offre Gratuit. Vos annonces au-delà de la limite de l'offre Gratuit ont été mises en pause.";
      break;
    case "listings_paused": {
      const count = notice.listingCount ?? 0;
      title = count === 1 ? "1 annonce mise en pause" : `${count} annonces mises en pause`;
      detail = "Les plus anciennes ont été mises en pause pour respecter la limite de l'offre Gratuit. Si vous repassez à l'offre Pro, elles seront remises en ligne automatiquement, dans la limite de votre offre. Vous pouvez aussi en remettre une en ligne vous-même en en mettant une autre en pause.";
      break;
    }
    case "listings_restored": {
      const count = notice.listingCount ?? 0;
      title = count === 1 ? "1 annonce remise en ligne" : `${count} annonces remises en ligne`;
      detail = restoredDetail(count, notice.stillPaused ?? null, maxOnlineOffers ?? null);
      break;
    }
    default:
      title = "Avis";
      detail = "";
  }
  return { id: notice.id, title, detail, dateText: formatDateTimeFr(notice.createdAt, timeZone), unread: notice.readAt === null };
}

// ───────────── souscription ─────────────

export const SUBSCRIBE_LABELS = Object.freeze({
  subscribe: "Passer à l'offre Pro",
  confirm: "Confirmer l'abonnement",
  confirming: "Abonnement en cours…",
  cancel: "Annuler",
  recharge: "Recharger mon porte-monnaie",
  disableRenewal: "Désactiver le renouvellement",
  enableRenewal: "Réactiver le renouvellement",
  working: "En cours…",
});

export type SubscribeState =
  | { kind: "none" }
  | { kind: "balance_unknown" }
  | { kind: "insufficient"; balanceXof: number; missingXof: number; text: string; detail: string }
  | { kind: "ready"; priceXof: number; balanceXof: number; balanceAfterXof: number; promoXof: number };

/** « Passer à l'offre Pro » est actif seulement si le plan existe, son prix est connu et le SOLDE DE CRÉDITS PAYÉS le couvre (les crédits promotionnels ne paient jamais un abonnement). */
export function subscribeState(input: { plan: Pick<PlanView, "monthlyPriceXof" | "promoCreditsXof"> | null; balanceXof: number | null }): SubscribeState {
  const { plan, balanceXof } = input;
  if (plan === null || !Number.isSafeInteger(plan.monthlyPriceXof) || plan.monthlyPriceXof <= 0) return { kind: "none" };
  if (balanceXof === null || !Number.isSafeInteger(balanceXof) || balanceXof < 0) return { kind: "balance_unknown" };
  if (balanceXof < plan.monthlyPriceXof) {
    const missingXof = plan.monthlyPriceXof - balanceXof;
    return {
      kind: "insufficient",
      balanceXof,
      missingXof,
      text: `Solde insuffisant (${formatFcfa(balanceXof)})`,
      detail: `Il vous manque ${formatFcfa(missingXof)}. Seuls vos crédits payés règlent l'abonnement, pas les crédits promotionnels.`,
    };
  }
  return { kind: "ready", priceXof: plan.monthlyPriceXof, balanceXof, balanceAfterXof: balanceXof - plan.monthlyPriceXof, promoXof: plan.promoCreditsXof };
}

/** Libellé du bouton de souscription : « Passer à l'offre Pro — 10 000 FCFA par mois ». */
export function subscribableLabelFor(plan: Pick<PlanView, "name" | "monthlyPriceXof">): string {
  return `${SUBSCRIBE_LABELS.subscribe} — ${plan.monthlyPriceXof === 0 ? "gratuit" : `${formatFcfa(plan.monthlyPriceXof)} par mois`}`;
}

export function canSubscribe(state: SubscribeState, pending: boolean): boolean {
  return state.kind === "ready" && !pending;
}

/** Texte de la confirmation, avant tout paiement. */
export function subscribeConfirmationText(state: Extract<SubscribeState, { kind: "ready" }>): string {
  const promo = state.promoXof > 0 ? ` Vous recevez ${formatFcfa(state.promoXof)} de crédits promotionnels pour cette période.` : "";
  return `Vous allez payer ${formatFcfa(state.priceXof)} avec vos crédits pour un mois d'offre Pro. Solde après paiement : ${formatFcfa(state.balanceAfterXof)}.${promo}`;
}

// ───────────── import de catalogue ─────────────

export const IMPORT_PAGE_TITLE = "Importer un catalogue";
export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 256 * 1024;
export const IMPORT_COLUMNS_HELP =
  "titre (obligatoire), description, categorie, marque, modele, variante, etat, localisation, prix, disponible. Séparateur : virgule, point-virgule ou tabulation. Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.";
export const IMPORT_EXAMPLE = "titre,description,categorie,marque,modele,variante,etat,localisation,prix,disponible\niPhone 12 128 Go,Très bon état,Téléphones,Apple,iPhone 12,128 Go,Occasion,Cocody,175000,oui";

export type ImportFileCheck = { ok: true } | { ok: false; message: string };

/** Contrôle côté écran AVANT l'envoi (le serveur refait les mêmes contrôles) : taille et nombre de lignes. */
export function checkImportText(text: string): ImportFileCheck {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, message: "Le fichier est vide." };
  if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES) return { ok: false, message: "Le fichier dépasse 256 Ko : découpez-le en plusieurs fichiers." };
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "").length - 1;
  if (lines > IMPORT_MAX_ROWS) return { ok: false, message: `Le fichier compte plus de ${IMPORT_MAX_ROWS} lignes : découpez-le en plusieurs fichiers.` };
  if (lines < 1) return { ok: false, message: "Le fichier ne contient aucune ligne de données sous l'en-tête." };
  return { ok: true };
}

const FIELD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  title: "le titre", description: "la description", category: "la catégorie", brand: "la marque", model: "le modèle", variant: "la variante",
  condition: "l'état", location: "la localisation", price: "le prix", available: "la disponibilité",
});

export function importFieldName(field: string | null): string {
  return field !== null && Object.prototype.hasOwnProperty.call(FIELD_NAMES, field) ? FIELD_NAMES[field] : "un champ";
}

/** Raison d'un refus de ligne, en mots simples (jamais le code ni la donnée du fichier). */
export function importRejectionText(row: Pick<ImportRowReport, "code" | "field">): string {
  switch (row.code) {
    case "invalid_field":
      return `Ligne refusée : ${importFieldName(row.field)} n'est pas valide.`;
    case "too_many_columns":
      return "Ligne refusée : elle a plus de cellules que l'en-tête n'a de colonnes.";
    case "phone_number_in_offer":
      return "Ligne refusée : pas de numéro de téléphone dans l'annonce. L'acheteur vous contactera par noma.";
    case "offer_limit_reached":
      return "Ligne refusée : vous avez atteint le nombre maximal d'annonces en ligne de votre offre.";
    case "invalid_row":
      return "Ligne refusée : ses informations ne sont pas acceptées.";
    default:
      return "Ligne refusée.";
  }
}

export interface ImportRowView {
  line: number;
  ok: boolean;
  text: string;
}

export function importRowView(row: ImportRowReport, mode: "preview" | "apply"): ImportRowView {
  if (row.outcome === "rejected") return { line: row.line, ok: false, text: importRejectionText(row) };
  return { line: row.line, ok: true, text: row.outcome === "would_create" || mode === "preview" ? "Sera créée et mise en ligne." : "Créée et mise en ligne." };
}

export interface ImportSummaryView {
  title: string;
  detail: string;
  /** Vrai : le fichier a déjà été appliqué (rien n'a été recréé). */
  replayed: boolean;
}

export function importSummary(result: CatalogImportResult): ImportSummaryView {
  const accepted = result.acceptedCount;
  const rejected = result.rejectedCount;
  const plural = (count: number, one: string, many: string): string => `${count} ${count > 1 ? many : one}`;
  if (result.alreadyApplied) {
    return {
      title: "Ce fichier a déjà été importé",
      detail: `Rien n'a été recréé. Il avait donné ${plural(accepted, "annonce", "annonces")} et ${plural(rejected, "ligne refusée", "lignes refusées")}.`,
      replayed: true,
    };
  }
  if (result.mode === "preview") {
    return {
      title: "Aperçu : rien n'a encore été créé",
      detail: `${plural(accepted, "annonce serait créée", "annonces seraient créées")} et ${plural(rejected, "ligne serait refusée", "lignes seraient refusées")}.`,
      replayed: false,
    };
  }
  return {
    title: accepted > 0 ? "Import terminé" : "Aucune annonce créée",
    detail: `${plural(accepted, "annonce créée", "annonces créées")} et ${plural(rejected, "ligne refusée", "lignes refusées")}.`,
    replayed: false,
  };
}

/** Les seules lignes refusées, pour l'affichage du rapport (les lignes acceptées sont résumées). */
export function rejectedRows(result: CatalogImportResult): ImportRowView[] {
  return result.rows.filter((row) => row.outcome === "rejected").map((row) => importRowView(row, result.mode));
}

// ───────────── administration ─────────────

/** Nombre arrondi à 5 près rendu en clair : « moins de 5 » pour un arrondi nul (jamais « environ 0 » : il y a peut-être un ou deux abonnés), sinon « environ N ». */
export function approximateText(count: number): string {
  return count < 5 ? "moins de 5" : `environ ${count}`;
}

export function planCodeLabel(code: string): string {
  return code === "free" ? "Gratuit" : code === "pro" ? "Pro" : code;
}

export interface AdminVersionRow {
  key: string;
  version: number;
  name: string;
  priceText: string;
  promoText: string;
  offersText: string;
  rightsText: string;
  dateText: string;
}

export function adminVersionRows(versions: AdminPlansOverview["plans"][number]["versions"], timeZone?: string): AdminVersionRow[] {
  return versions.map((version) => ({
    key: String(version.version),
    version: version.version,
    name: version.name,
    priceText: version.monthlyPriceXof === 0 ? "Gratuit" : `${formatFcfa(version.monthlyPriceXof)} par mois`,
    promoText: version.promoCreditsXof === 0 ? "Aucun" : `${formatFcfa(version.promoCreditsXof)} par mois`,
    offersText: `${version.maxOnlineOffers} au plus`,
    rightsText: version.entitlements.length === 0 ? "Aucun droit" : version.entitlements.map(entitlementLabel).join(", "),
    dateText: formatDateFr(version.createdAt, timeZone),
  }));
}

export type NewVersionForm = { name: string; monthlyPriceXof: string; promoCreditsXof: string; maxOnlineOffers: string; entitlements: readonly Entitlement[] };

export type NewVersionResult =
  | { ok: true; request: { name: string; monthlyPriceXof: number; promoCreditsXof: number; maxOnlineOffers: number; entitlements: Entitlement[] } }
  | { ok: false; errors: Record<string, string> };

/** Saisie d'une nouvelle version (mêmes bornes que le serveur) : erreurs par champ, en français. */
export function buildNewVersion(form: NewVersionForm, planCode: string): NewVersionResult {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (name.length < 1 || name.length > 60) errors.name = "Le nom compte de 1 à 60 caractères.";
  const integer = (text: string, field: string, label: string, min: number, max: number): number => {
    const value = /^[0-9]{1,10}$/.test(text.trim()) ? Number(text.trim()) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      errors[field] = `${label} : un entier de ${min} à ${max}.`;
      return 0;
    }
    return value;
  };
  const price = integer(form.monthlyPriceXof, "monthlyPriceXof", "Prix mensuel (FCFA)", planCode === "free" ? 0 : 1, planCode === "free" ? 0 : 1_000_000_000);
  const promo = integer(form.promoCreditsXof, "promoCreditsXof", "Crédits promotionnels (FCFA)", 0, planCode === "free" ? 0 : 1_000_000_000);
  const offers = integer(form.maxOnlineOffers, "maxOnlineOffers", "Annonces en ligne", 1, 100_000);
  if (planCode === "free" && form.entitlements.length > 0) errors.entitlements = "Le plan Gratuit n'a aucun droit.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, request: { name, monthlyPriceXof: price, promoCreditsXof: promo, maxOnlineOffers: offers, entitlements: [...form.entitlements] } };
}
