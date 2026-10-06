/**
 * Présentation du porte-monnaie, de la recharge simulée et de l'achat de boost (lot P2) : libellés et règles en fonctions
 * PURES, sans React, testées isolément (tests/client/wallet-view.test.ts).
 *
 * Règles :
 *  - monnaie : francs CFA, entiers uniquement (jamais de flottant dans un montant) ; un montant s'affiche « 2 000 FCFA » ;
 *  - l'historique parle en mots simples (Recharge, Achat de boost, Remboursement de boost, Ajustement), jamais en codes ;
 *  - une recharge : 500 à 500 000 FCFA, multiple de 100 (les bornes du serveur : le serveur reste juge) ;
 *  - une clé d'idempotence est créée UNE fois par tentative (par montant de recharge, par devis d'achat) et réutilisée à chaque
 *    nouvel essai : un essai réseau répété ne peut jamais débiter ni créer deux fois ;
 *  - « Acheter » n'est actif que pour un devis disponible, non expiré à l'écran, dont le prix est couvert par le solde connu ;
 *  - le compte à rebours d'un devis est ANCRÉ : fenêtre de validité du devis moins le temps écoulé depuis sa réception, mesuré
 *    par une horloge monotone (`performance.now()`) passée en paramètre. L'horloge murale de l'appareil (changement d'heure,
 *    fuseau, appareil déréglé) n'y entre jamais ; le serveur reste juge (`quote_expired`) ;
 *  - tout retour (après paiement, après recharge) passe par `safeNextPath` : jamais une URL fournie par l'adresse.
 */

import type {
  BoostDurationCode,
  BoostPurchaseHistoryItem,
  BoostQuote,
  WalletTopup,
  WalletTransaction,
} from "./api";
import { durationLabel, formatCountdown, validityWindowMs } from "./boost-view";
import { formatAmount } from "./catalog-view";
import { safeNextPath } from "./session";

// ─── Montants ───────────────────────────────────────────────────────────────────────────────────

/** Bornes d'une recharge (celles du serveur : lib/server/wallet/config.ts). */
export const TOPUP_MIN_XOF = 500;
export const TOPUP_MAX_XOF = 500_000;
export const TOPUP_STEP_XOF = 100;
/** Montants proposés en un appui. */
export const TOPUP_PRESETS: readonly number[] = Object.freeze([1_000, 2_000, 5_000, 10_000]);

export const UNKNOWN_AMOUNT_TEXT = "montant inconnu";

/** « 2 000 FCFA » (espaces insécables ordinaires entre les milliers) ; un montant illisible n'est jamais montré comme un nombre. */
export function formatFcfa(amountXof: number): string {
  if (!Number.isSafeInteger(amountXof)) return UNKNOWN_AMOUNT_TEXT;
  return `${formatAmount(amountXof)} FCFA`;
}

/** « +2 000 FCFA » pour un crédit, « −1 300 FCFA » (vrai signe moins) pour un débit, « 0 FCFA » sinon. */
export function formatSignedFcfa(amountXof: number): string {
  if (!Number.isSafeInteger(amountXof)) return UNKNOWN_AMOUNT_TEXT;
  const text = formatFcfa(Math.abs(amountXof));
  if (amountXof > 0) return `+${text}`;
  return amountXof < 0 ? `−${text}` : text;
}

// ─── Dates ──────────────────────────────────────────────────────────────────────────────────────

const UNKNOWN_DATE_TEXT = "date inconnue";

function frenchParts(iso: string, timeZone?: string): Record<string, string> | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const result: Record<string, string> = {};
  for (const part of parts) result[part.type] = part.value;
  return result;
}

/** « 06/10/2026 à 17:01 » (fuseau local, ou celui qu'on lui donne en test) ; « date inconnue » si la date est illisible. */
export function formatDateTimeFr(iso: string, timeZone?: string): string {
  const parts = frenchParts(iso, timeZone);
  if (!parts) return UNKNOWN_DATE_TEXT;
  return `${parts.day}/${parts.month}/${parts.year} à ${parts.hour}:${parts.minute}`;
}

/** « 06/10/2026 ». */
export function formatDateFr(iso: string, timeZone?: string): string {
  const parts = frenchParts(iso, timeZone);
  if (!parts) return UNKNOWN_DATE_TEXT;
  return `${parts.day}/${parts.month}/${parts.year}`;
}

// ─── Historique du porte-monnaie ────────────────────────────────────────────────────────────────

export const TRANSACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  topup: "Recharge",
  boost_purchase: "Achat de boost",
  boost_refund: "Remboursement de boost",
  adjustment: "Ajustement",
});

export const UNKNOWN_TRANSACTION_LABEL = "Opération";

/** Libellé en mots simples ; un type inconnu (ou « __proto__ ») ne s'affiche jamais tel quel. */
export function transactionLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(TRANSACTION_LABELS, kind) ? TRANSACTION_LABELS[kind] : UNKNOWN_TRANSACTION_LABEL;
}

export type AmountTone = "credit" | "debit" | "neutral";

export function amountTone(amountXof: number): AmountTone {
  if (amountXof > 0) return "credit";
  return amountXof < 0 ? "debit" : "neutral";
}

export interface WalletRow {
  key: string;
  label: string;
  /** Montant signé : « +2 000 FCFA » ou « −1 300 FCFA ». */
  amountText: string;
  tone: AmountTone;
  dateText: string;
}

export function walletRow(transaction: WalletTransaction, timeZone?: string): WalletRow {
  return {
    key: transaction.id,
    label: transactionLabel(transaction.kind),
    amountText: formatSignedFcfa(transaction.amountXof),
    tone: amountTone(transaction.amountXof),
    dateText: formatDateTimeFr(transaction.createdAt, timeZone),
  };
}

/** Ajoute la page suivante à la liste sans doublon (un identifiant déjà présent est ignoré) ; l'ordre du serveur est conservé. */
export function mergeTransactionPages(
  current: readonly WalletTransaction[],
  next: readonly WalletTransaction[],
): WalletTransaction[] {
  const seen = new Set(current.map((entry) => entry.id));
  const merged = [...current];
  for (const entry of next) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

export const EMPTY_WALLET_HISTORY = "Aucune opération pour le moment.";

// ─── Montant d'une recharge ─────────────────────────────────────────────────────────────────────

export type TopupAmountResult = { ok: true; amountXof: number } | { ok: false; message: string };

export const TOPUP_AMOUNT_MESSAGES = Object.freeze({
  empty: "Saisissez un montant en FCFA.",
  notInteger: "Saisissez un montant entier en FCFA, sans virgule ni lettre.",
  tooLow: `Le montant minimum est de ${formatAmount(TOPUP_MIN_XOF)} FCFA.`,
  tooHigh: `Le montant maximum est de ${formatAmount(TOPUP_MAX_XOF)} FCFA.`,
  notMultiple: `Le montant doit être un multiple de ${TOPUP_STEP_XOF} FCFA (par exemple 2 500 FCFA).`,
});

/**
 * Montant saisi → montant de recharge valide. Espaces (y compris insécables) tolérés comme séparateurs de milliers ; tout le
 * reste que des chiffres est refusé. Bornes et pas du serveur : 500 à 500 000 FCFA, multiple de 100.
 */
export function parseTopupAmount(input: unknown): TopupAmountResult {
  if (typeof input !== "string") return { ok: false, message: TOPUP_AMOUNT_MESSAGES.empty };
  const typed = input.replace(/[\s  ]/g, "");
  if (typed.length === 0) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.empty };
  if (!/^[0-9]+$/.test(typed)) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.notInteger };
  // Zéros de tête ignorés (« 000000000500 » vaut 500) ; « 0 » reste « 0 ». Plus de 9 chiffres significatifs : bien au-delà du maximum.
  const digits = typed.replace(/^0+(?=[0-9])/, "");
  if (digits.length > 9) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.tooHigh };
  const amountXof = Number(digits);
  if (amountXof < TOPUP_MIN_XOF) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.tooLow };
  if (amountXof > TOPUP_MAX_XOF) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.tooHigh };
  if (amountXof % TOPUP_STEP_XOF !== 0) return { ok: false, message: TOPUP_AMOUNT_MESSAGES.notMultiple };
  return { ok: true, amountXof };
}

/** Vrai pour un montant de recharge que le serveur accepte. */
export function isValidTopupAmount(amountXof: unknown): amountXof is number {
  return (
    typeof amountXof === "number" &&
    Number.isSafeInteger(amountXof) &&
    amountXof >= TOPUP_MIN_XOF &&
    amountXof <= TOPUP_MAX_XOF &&
    amountXof % TOPUP_STEP_XOF === 0
  );
}

export const SIMULATION_NOTICE =
  "Pour l'instant, la recharge est simulée : aucun argent réel n'est utilisé et aucun paiement n'est effectué.";

// ─── Clés d'idempotence ─────────────────────────────────────────────────────────────────────────

export interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * UUID v4 pour une clé d'idempotence. `crypto.randomUUID` quand il existe ; sinon (page servie hors contexte sécurisé) un UUID v4
 * construit avec `crypto.getRandomValues`. Jamais `Math.random`. Lève si aucune source cryptographique n'existe.
 */
export function newIdempotencyKey(source: RandomSource | undefined = (globalThis as { crypto?: RandomSource }).crypto): string {
  if (source && typeof source.randomUUID === "function") {
    const value = source.randomUUID();
    if (UUID_V4.test(value)) return value;
  }
  if (source && typeof source.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("aucune source aléatoire cryptographique");
}

export interface IdempotencyKeys {
  /** La clé de cette tentative : créée au premier appel pour ce `scope`, RENVOYÉE À L'IDENTIQUE aux appels suivants. */
  keyFor(scope: string): string;
  /** Oublie la clé de ce `scope` (la tentative est terminée : la suivante en aura une nouvelle). */
  forget(scope: string): void;
}

/** Stockage minimal d'une clé (l'API de `sessionStorage`) : toute erreur de lecture ou d'écriture est avalée par `createIdempotencyKeys`. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `scope` : le montant de la recharge, ou l'identifiant du devis acheté. Avec un `storage`, la clé survit au changement de page de l'onglet
 * (les allers-retours entre le porte-monnaie et la page de paiement ne créent pas de nouvelle intention) ; une valeur stockée qui n'est pas un
 * UUID v4, ou un stockage qui lève, est ignoré (la clé reste alors en mémoire seulement).
 */
export function createIdempotencyKeys(
  generate: () => string = newIdempotencyKey,
  storage?: KeyStorage,
  prefix = "noma:idempotency:",
): IdempotencyKeys {
  const keys = new Map<string, string>();
  const stored = (scope: string): string | null => {
    if (!storage) return null;
    try {
      const value = storage.getItem(`${prefix}${scope}`);
      return value !== null && UUID_V4.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  return {
    keyFor(scope) {
      const existing = keys.get(scope) ?? stored(scope);
      if (existing !== null && existing !== undefined) {
        keys.set(scope, existing);
        return existing;
      }
      const created = generate();
      keys.set(scope, created);
      if (storage) {
        try {
          storage.setItem(`${prefix}${scope}`, created);
        } catch {
          // Stockage bloqué (navigation privée, quota) : la clé reste en mémoire.
        }
      }
      return created;
    },
    forget(scope) {
      keys.delete(scope);
      if (storage) {
        try {
          storage.removeItem(`${prefix}${scope}`);
        } catch {
          // Rien à effacer si le stockage est inaccessible.
        }
      }
    },
  };
}

/** `sessionStorage` de l'onglet, ou `undefined` s'il n'existe pas ou refuse l'accès (jamais une exception). */
export function browserSessionStorage(): KeyStorage | undefined {
  try {
    const candidate = (globalThis as { sessionStorage?: KeyStorage }).sessionStorage;
    return candidate ?? undefined;
  } catch {
    return undefined;
  }
}

/** Clés d'idempotence des RECHARGES : par montant, conservées dans l'onglet jusqu'à ce que la recharge soit terminée (réussie, échouée ou expirée). */
export const TOPUP_KEY_PREFIX = "noma:topup-key:";
export function createTopupKeys(storage: KeyStorage | undefined = browserSessionStorage()): IdempotencyKeys {
  return createIdempotencyKeys(newIdempotencyKey, storage, TOPUP_KEY_PREFIX);
}

/**
 * Crée une recharge avec la clé du montant. Si le serveur renvoie une intention RÉUTILISÉE déjà TERMINÉE (réussie, échouée ou expirée : par
 * exemple payée dans un autre onglet qui partageait cette clé), la clé n'a plus d'objet : elle est oubliée, une clé neuve est générée et la recharge
 * est recréée UNE seule fois. Sans cela, la page de paiement afficherait « crédité » pour un paiement que l'utilisateur n'a pas fait.
 */
export async function createTopupWithFreshKey<T extends Pick<WalletTopup, "status">>(input: {
  create: (request: { amountXof: number; idempotencyKey: string }) => Promise<{ topup: T; reused: boolean }>;
  keys: IdempotencyKeys;
  scope: string;
  amountXof: number;
}): Promise<{ topup: T; reused: boolean }> {
  const first = await input.create({ amountXof: input.amountXof, idempotencyKey: input.keys.keyFor(input.scope) });
  if (!first.reused || first.topup.status === "pending") return first;
  input.keys.forget(input.scope);
  return input.create({ amountXof: input.amountXof, idempotencyKey: input.keys.keyFor(input.scope) });
}

// ─── Adresses et retours ────────────────────────────────────────────────────────────────────────

export const WALLET_PATH = "/compte/porte-monnaie";
export const CHECKOUT_PREFIX = "/paiement-simule/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Vrai seulement pour `/paiement-simule/<uuid>` : le chemin renvoyé par le serveur est vérifié avant toute navigation. */
export function isCheckoutPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CHECKOUT_PREFIX) && UUID.test(value.slice(CHECKOUT_PREFIX.length));
}

/** Retour demandé par l'adresse (`?next=`) : chemin interne sûr, sinon `fallback`. JAMAIS la valeur brute. */
export function returnTarget(raw: unknown, fallback: string = WALLET_PATH): string {
  return safeNextPath(raw, fallback);
}

/** `/compte/porte-monnaie`, avec `?recharger=1` (panneau de recharge ouvert) et `next` (retour, nettoyé) quand ils sont demandés. */
export function walletHref(options: { next?: string | null; recharge?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.recharge) params.set("recharger", "1");
  const next = safeNextPath(options.next, "");
  if (next !== "" && next !== "/") params.set("next", next);
  const text = params.toString();
  return text ? `${WALLET_PATH}?${text}` : WALLET_PATH;
}

/** Adresse de la page de paiement simulé (chemin vérifié, retour nettoyé) ; `null` si le chemin du serveur n'a pas la forme attendue. */
export function checkoutHref(checkoutPath: unknown, next?: string | null): string | null {
  if (!isCheckoutPath(checkoutPath)) return null;
  const safe = safeNextPath(next, "");
  return safe !== "" && safe !== "/" ? `${checkoutPath}?next=${encodeURIComponent(safe)}` : checkoutPath;
}

/** Libellé du lien de retour après une recharge réussie. */
export function returnLinkLabel(path: string): string {
  if (path === WALLET_PATH) return "Voir mon porte-monnaie";
  if (/^\/vendeur\/annonces\/[^/?#]+$/.test(path.split(/[?#]/, 1)[0])) return "Retour à mon annonce";
  return "Continuer";
}

// ─── Page de paiement simulé ────────────────────────────────────────────────────────────────────

export const SIMULATION_BANNER = "SIMULATION — aucun argent réel";
export const SIMULATION_SUBTITLE =
  "Cette page imite le prestataire de paiement. Vous choisissez vous-même l'issue : aucun vrai paiement n'a lieu.";

export interface CheckoutFailure {
  status: number;
  code: string;
}

export type CheckoutView =
  | { kind: "loading" }
  | { kind: "pending"; amountText: string }
  | { kind: "succeeded"; amountText: string; message: string }
  | { kind: "failed"; amountText: string; message: string }
  | { kind: "expired"; amountText: string; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

/** Recharge réussie, déjà terminée avant cette visite (lot P3-bis) : dit que le crédit a bien eu lieu, une seule fois. */
export const checkoutAlreadyCreditedMessage = (amountText: string): string =>
  `Cette recharge a déjà été créditée sur votre porte-monnaie (${amountText}, une seule fois).`;

export const CHECKOUT_MESSAGES = Object.freeze({
  /**
   * Recharge déjà terminée AVANT cette visite (page rouverte, rechargée après le paiement, ou payée ailleurs). Lot P3-bis : elle dit ce qui est vrai (réussie :
   * déjà créditée, une seule fois ; échouée ou expirée : terminée sans paiement), sans alarmer ni annoncer un crédit « de cette page » (« a été crédité de »
   * reste réservé à la recharge payée sur cette page).
   */
  alreadyEndedUnpaid: "Cette recharge est terminée sans paiement : aucun montant n'a été crédité.",
  failed: "Le paiement a échoué. Votre porte-monnaie n'a pas été crédité. Vous pouvez réessayer.",
  expired: "Cette recharge a expiré. Votre porte-monnaie n'a pas été crédité. Vous pouvez recommencer.",
  unavailable: "Le paiement simulé n'est pas disponible pour le moment.",
  notFound: "Cette recharge est introuvable.",
  error: "La recharge n'a pas pu être lue. Réessayez dans un instant.",
});

/**
 * Ce que la page de paiement simulé affiche, d'après l'état LU de la recharge (jamais d'après la réponse d'un bouton). `paidHere` : cette page a
 * VU la recharge en attente (c'est elle qu'on vient de payer) ; une recharge déjà réussie à la première lecture n'est pas annoncée « créditée »
 * (lot P3 : une clé de recharge partagée entre deux onglets menait ici sans aucun paiement).
 */
export function checkoutView(input: { topup: WalletTopup | null; failure: CheckoutFailure | null; paidHere?: boolean }): CheckoutView {
  const { topup, failure } = input;
  if (topup) {
    const amountText = formatFcfa(topup.amountXof);
    switch (topup.status) {
      case "pending":
        return { kind: "pending", amountText };
      case "succeeded":
        return {
          kind: "succeeded", amountText,
          message: input.paidHere === false ? checkoutAlreadyCreditedMessage(amountText) : `Votre porte-monnaie a été crédité de ${amountText}.`,
        };
      case "failed":
        return { kind: "failed", amountText, message: input.paidHere === false ? CHECKOUT_MESSAGES.alreadyEndedUnpaid : CHECKOUT_MESSAGES.failed };
      default:
        return { kind: "expired", amountText, message: input.paidHere === false ? CHECKOUT_MESSAGES.alreadyEndedUnpaid : CHECKOUT_MESSAGES.expired };
    }
  }
  if (failure) {
    if (failure.status === 404) return { kind: "not_found", message: CHECKOUT_MESSAGES.notFound };
    // 503 : prestataire inactif (hors développement) ou service indisponible.
    if (failure.status === 503) return { kind: "unavailable", message: CHECKOUT_MESSAGES.unavailable };
    return { kind: "error", message: CHECKOUT_MESSAGES.error };
  }
  return { kind: "loading" };
}

// ─── Compte à rebours ancré d'un devis ──────────────────────────────────────────────────────────

/** Fenêtre de validité maximale crue : le serveur borne la validité d'un devis à 60 – 3 600 s. */
export const MAX_QUOTE_WINDOW_MS = 3_600_000;

/**
 * Un devis reçu : sa validité restante À LA RÉCEPTION (`windowMs`) et l'instant de réception sur l'horloge MONOTONE (`performance.now()`).
 * Le restant à l'instant t vaut `windowMs − (t − receivedAtMs)`.
 */
export interface QuoteClock {
  windowMs: number;
  receivedAtMs: number;
}

/** L'en-tête HTTP `Date` a une résolution de 1 seconde : l'heure réelle du serveur est entre `Date` et `Date + 999 ms`. */
export const SERVER_DATE_RESOLUTION_MS = 1_000;

/**
 * Ancre un devis à sa réception. Sans heure du serveur : restant = fenêtre = `expiresAt − computedAt` (bornée à `MAX_QUOTE_WINDOW_MS`).
 * AVEC l'heure du serveur de la réponse (`quote.serverTime`, en-tête `Date`) : restant = `expiresAt − Date − 1 s` (la résolution de l'en-tête :
 * on ne promet jamais plus que le temps réel), borné par la fenêtre. C'est ce qui rend juste le décompte d'un devis RÉUTILISÉ (déjà vieux à la
 * réception : son âge est `Date − computedAt`). Une heure du serveur incohérente avec le devis (avant son calcul de plus d'une seconde, ou
 * après son échéance de plus d'une seconde) est ignorée : comportement sans en-tête. Dates illisibles ou fenêtre nulle ou négative :
 * `null` (le devis est tenu pour expiré, jamais pour valable). Aucune horloge murale de l'appareil n'intervient.
 */
export function anchorQuote(
  quote: Pick<BoostQuote, "computedAt" | "expiresAt"> & { serverTime?: number | null },
  receivedAtMs: number,
): QuoteClock | null {
  const window = validityWindowMs(quote);
  if (window === null || !Number.isFinite(receivedAtMs)) return null;
  const bounded = Math.min(window, MAX_QUOTE_WINDOW_MS);
  const server = quote.serverTime;
  if (typeof server === "number" && Number.isFinite(server)) {
    const computedAt = Date.parse(quote.computedAt);
    const expiresAt = Date.parse(quote.expiresAt);
    if (server >= computedAt - SERVER_DATE_RESOLUTION_MS && server <= expiresAt + SERVER_DATE_RESOLUTION_MS) {
      return { windowMs: Math.max(0, Math.min(bounded, expiresAt - server - SERVER_DATE_RESOLUTION_MS)), receivedAtMs };
    }
  }
  return { windowMs: bounded, receivedAtMs };
}

/**
 * Validité restante en ms : fenêtre − (maintenant − réception), jamais négative ni supérieure à la fenêtre. `nowMs` est la lecture
 * COURANTE de l'horloge monotone ; aucune horloge murale (Date.now, new Date) n'intervient.
 */
export function anchoredRemainingMs(clock: QuoteClock | null, nowMs: number): number {
  if (clock === null || !Number.isFinite(nowMs)) return 0;
  const elapsed = Math.max(0, nowMs - clock.receivedAtMs);
  return Math.max(0, clock.windowMs - elapsed);
}

export interface QuoteValidity {
  expired: boolean;
  text: string;
}

export const QUOTE_EXPIRED_TEXT = "Ce devis a expiré. Demandez-en un nouveau.";

export function anchoredQuoteValidity(
  quote: Pick<BoostQuote, "status">,
  clock: QuoteClock | null,
  nowMs: number,
): QuoteValidity {
  const left = anchoredRemainingMs(clock, nowMs);
  if (left <= 0) return { expired: true, text: QUOTE_EXPIRED_TEXT };
  const prefix = quote.status === "available" ? "Prix valable encore" : "Résultat valable encore";
  return { expired: false, text: `${prefix} ${formatCountdown(left)}` };
}

/**
 * Re-ancrage d'un devis AFFICHÉ à partir d'une relecture de l'historique des devis (retour au premier plan après une veille, échec d'achat) :
 * le devis est retrouvé par son identifiant ; expiré à la lecture → expiré à l'écran (jamais un nouveau prix glissé en silence) ; sinon le
 * décompte repart de la validité réelle (heure du serveur de la relecture). Devis absent de la lecture : inchangé.
 */
export function reanchorQuote<T extends { quote: Pick<BoostQuote, "id">; clock: QuoteClock | null }>(
  current: T,
  reread: ReadonlyArray<Pick<BoostQuote, "id" | "computedAt" | "expiresAt" | "expired" | "serverTime">>,
  receivedAtMs: number,
): T {
  const found = reread.find((entry) => entry.id === current.quote.id);
  if (!found) return current;
  if (found.expired === true) return { ...current, clock: { windowMs: 0, receivedAtMs } };
  return { ...current, clock: anchorQuote(found, receivedAtMs) };
}

/**
 * Un élément de l'historique (lu à `receivedAtMs`) est expiré si le serveur l'a dit à la lecture, ou si la fenêtre entière s'est
 * écoulée depuis (une borne sûre : on ne sait pas depuis combien de temps il valait, mais jamais au-delà d'une fenêtre).
 */
export function historyEntryExpired(
  quote: Pick<BoostQuote, "computedAt" | "expiresAt" | "expired"> & { serverTime?: number | null },
  receivedAtMs: number,
  nowMs: number,
): boolean {
  if (quote.expired === true) return true;
  return anchoredRemainingMs(anchorQuote(quote, receivedAtMs), nowMs) <= 0;
}

// ─── Achat : « Acheter » actif ou non ───────────────────────────────────────────────────────────

export type BuyState =
  /** Pas de prix (devis indisponible ou absent) : aucun achat à proposer. */
  | { kind: "none" }
  /** Le devis a expiré à l'écran : on en demande un nouveau. */
  | { kind: "expired" }
  /** Le solde n'est pas (encore) connu : on n'achète pas à l'aveugle. */
  | { kind: "balance_unknown" }
  | { kind: "insufficient"; balanceXof: number; missingXof: number; text: string; detail: string }
  | { kind: "ready"; amountXof: number; balanceXof: number; balanceAfterXof: number };

export interface BuyInputs {
  quote: Pick<BoostQuote, "status" | "amount" | "currency"> | null;
  /** Devis expiré sur l'horloge ancrée de l'écran. */
  expired: boolean;
  /** Solde connu en FCFA, ou `null` s'il n'a pas pu être lu. */
  balanceXof: number | null;
}

export const BUY_LABELS = Object.freeze({
  buy: "Acheter",
  recharge: "Recharger",
  confirm: "Confirmer l'achat",
  confirming: "Achat en cours…",
  updatingPrice: "Mise à jour du prix…",
  cancel: "Annuler",
  verify: "Vérifier / réessayer",
  refreshBalance: "Relire mon solde",
});

export const BALANCE_UNKNOWN_TEXT = "Votre solde n'a pas pu être lu : l'achat est impossible pour le moment.";

/**
 * « Acheter » est ACTIF seulement si : devis disponible (prix entier positif en FCFA), non expiré à l'écran, solde connu et
 * au moins égal au prix. Sinon : expiré, solde inconnu, ou « Solde insuffisant (X FCFA) » (X = le solde actuel) avec ce qui
 * manque ; sans prix, rien à acheter.
 */
export function buyState(input: BuyInputs): BuyState {
  const { quote, expired, balanceXof } = input;
  if (
    quote === null ||
    quote.status !== "available" ||
    quote.currency !== "XOF" ||
    quote.amount === null ||
    !Number.isSafeInteger(quote.amount) ||
    quote.amount <= 0
  ) {
    return { kind: "none" };
  }
  if (expired) return { kind: "expired" };
  if (balanceXof === null || !Number.isSafeInteger(balanceXof) || balanceXof < 0) return { kind: "balance_unknown" };
  if (balanceXof < quote.amount) {
    const missingXof = quote.amount - balanceXof;
    return {
      kind: "insufficient",
      balanceXof,
      missingXof,
      text: `Solde insuffisant (${formatFcfa(balanceXof)})`,
      detail: `Il vous manque ${formatFcfa(missingXof)} pour ce boost.`,
    };
  }
  return { kind: "ready", amountXof: quote.amount, balanceXof, balanceAfterXof: balanceXof - quote.amount };
}

/** Le bouton « Acheter » est actif seulement à l'état « ready » et hors requête en cours. */
export function canBuy(state: BuyState, pending: boolean): boolean {
  return state.kind === "ready" && !pending;
}

/**
 * Le résultat d'un achat est-il INCONNU après cet échec ? Panne réseau, réponse illisible, erreur du serveur (5xx) : la demande a pu aboutir
 * (réponse perdue). Un refus explicite (400, 401, 403, 404, 409, 429…) est définitif : rien n'a été débité.
 */
export function isPurchaseOutcomeUnknown(failure: { status: number; code: string }): boolean {
  // Lot P3-bis : `reach_check_unavailable` est une réponse EXPLICITE du serveur (la transaction a été annulée : rien n'est débité ni enregistré) ; réessayer
  // avec la même clé est sans risque, ce n'est pas un résultat inconnu.
  if (failure.status === 503 && failure.code === "reach_check_unavailable") return false;
  return failure.code === "network_error" || failure.code === "invalid_response" || failure.status >= 500;
}

export const UNRESOLVED_PURCHASE_TEXT =
  "Nous ne savons pas si votre achat est passé. Appuyez sur « Vérifier / réessayer » : vous ne serez débité qu'une seule fois.";
export const PURCHASE_NOT_RECORDED_TEXT =
  "Pas encore enregistré : l'achat peut encore aboutir. Nous revérifions automatiquement, ou appuyez sur « Vérifier / réessayer » : vous ne serez débité qu'une seule fois.";

/**
 * Tant que l'issue d'un achat est INCONNUE (réponse perdue), l'écran relit les achats de l'annonce (le serveur peut encore enregistrer l'achat :
 * constaté, une réponse perdue à 0,8 s pour un achat qui aboutit à 3,5 s) après 2 s, 5 s puis 10 s, comptées depuis l'incident. Délais en ms.
 */
export const PURCHASE_RECHECK_DELAYS_MS: readonly number[] = Object.freeze([2_000, 5_000, 10_000]);

/**
 * Programme les relectures `PURCHASE_RECHECK_DELAYS_MS` ; renvoie la fonction qui les annule toutes (changement d'écran, issue connue). `onTick`
 * reçoit le rang de la relecture (0, 1, 2). Les minuteries sont injectables (tests sans attente réelle).
 */
export function schedulePurchaseRechecks(
  onTick: (attempt: number) => void,
  timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): () => void {
  const handles = PURCHASE_RECHECK_DELAYS_MS.map((delay, attempt) => timers.set(() => onTick(attempt), delay));
  return () => {
    for (const handle of handles) timers.clear(handle);
  };
}
/** Précision sur ce que fait un boost acheté (aucune promesse de position ni de vente). */
export const BOOST_SUCCESS_NOTE =
  "Votre boost est actif : votre annonce peut monter dans les résultats des acheteurs concernés, avec le badge « Sponsorisé », parmi des offres déjà pertinentes. Ce n'est pas une garantie de position ni de vente.";

/** Texte de la confirmation, avant tout paiement. */
export function purchaseConfirmationText(input: { amountXof: number; durationCode: BoostDurationCode; balanceXof: number }): string {
  const after = input.balanceXof - input.amountXof;
  return (
    `Vous allez payer ${formatFcfa(input.amountXof)} pour un boost de ${durationLabel(input.durationCode)}. ` +
    `Solde après achat : ${formatFcfa(after)}.`
  );
}

export interface ConfirmButtonState {
  label: string;
  disabled: boolean;
}

/**
 * Bouton de confirmation : DÉSACTIVÉ pendant la requête d'achat (un double clic ne peut rien déclencher de plus) ET pendant qu'un nouveau devis
 * est demandé (le prix confirmé n'est plus celui que l'écran va afficher : on n'achète pas un devis en cours de remplacement).
 */
export function confirmButtonState(pending: boolean, quotePending = false): ConfirmButtonState {
  if (pending) return { label: BUY_LABELS.confirming, disabled: true };
  if (quotePending) return { label: BUY_LABELS.updatingPrice, disabled: true };
  return { label: BUY_LABELS.confirm, disabled: false };
}

export interface PurchaseFollowUp {
  /** Redemander un devis (le prix affiché n'est plus celui qui vaut). */
  refreshQuote: boolean;
  /** Relire le solde. */
  refreshBalance: boolean;
  /** Recharger l'annonce (elle a disparu ou n'est plus éligible). */
  reloadOffer: boolean;
  /** Fermer la confirmation (sinon elle reste ouverte pour un nouvel essai avec la MÊME clé). */
  closeConfirmation: boolean;
}

const QUOTE_CODES: readonly string[] = [
  "quote_expired",
  "quote_already_used",
  "quote_unavailable",
  "offer_already_boosted",
  "no_slot_available",
  "seller_boost_limit_reached",
  "no_visible_effect",
  "idempotency_conflict",
];

/**
 * Que faire après un refus d'achat. Panne réseau, 503 et réponse inattendue : rien (la confirmation reste ouverte, un nouvel essai
 * réutilise la même clé). Devis périmé, déjà servi ou sans place : nouveau devis. Solde insuffisant : relire le solde.
 */
export function purchaseFollowUp(failure: { status: number; code: string }): PurchaseFollowUp {
  const none: PurchaseFollowUp = { refreshQuote: false, refreshBalance: false, reloadOffer: false, closeConfirmation: false };
  if (failure.status === 409 && QUOTE_CODES.includes(failure.code)) {
    return { ...none, refreshQuote: true, closeConfirmation: true };
  }
  if (failure.status === 409 && failure.code === "insufficient_balance") {
    return { ...none, refreshBalance: true, closeConfirmation: true };
  }
  if (failure.status === 404 || (failure.status === 409 && failure.code === "offer_not_eligible")) {
    return { ...none, reloadOffer: true, closeConfirmation: true };
  }
  return none;
}

/** « Boost actif jusqu'au 09/10/2026 à 17:01 » après un achat (ou un rejeu). */
export function boostActiveText(endsAt: string, timeZone?: string): string {
  return `Boost actif jusqu'au ${formatDateTimeFr(endsAt, timeZone)}`;
}

export interface PurchaseHistoryRow {
  key: string;
  /** « 3 jours · 1 300 FCFA ». */
  title: string;
  /** « Acheté le 06/10/2026 à 17:01 · jusqu'au 09/10/2026 à 17:01 ». */
  detail: string;
  /** « Remboursé le 06/10/2026 à 17:01 », ou `null`. */
  refundedText: string | null;
}

export function purchaseHistoryRow(item: BoostPurchaseHistoryItem, timeZone?: string): PurchaseHistoryRow {
  return {
    key: item.id,
    title: `${durationLabel(item.durationCode)} · ${formatFcfa(item.amountXof)}`,
    detail: `Acheté le ${formatDateTimeFr(item.createdAt, timeZone)} · jusqu'au ${formatDateTimeFr(item.endsAt, timeZone)}`,
    refundedText: item.refundedAt === null ? null : `Remboursé le ${formatDateTimeFr(item.refundedAt, timeZone)}`,
  };
}
