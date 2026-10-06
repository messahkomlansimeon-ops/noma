/**
 * Partie PURE de `npm run dev:seed` (aucun accès à la base, aucun module serveur) : lecture des arguments, garde-fous de l'environnement, numéros
 * des vendeurs fictifs, catégories et plan des annonces d'exemple. Testée sans base (tests/scripts/dev-seed.test.ts).
 */
import { createHash } from "node:crypto";
import { CATEGORY_OPTIONS } from "../lib/client/catalog-view";
import { checkDevelopmentNodeEnv } from "./dev-proxy";
import { checkLocalDatabaseUrl } from "./dev-try";

/**
 * Bloc de numéros FICTIFS des vendeurs d'exemple : +225 07 99 99 99 01, 02, … (jusqu'à 50). Ces numéros n'appartiennent à personne : aucun SMS ne
 * leur est jamais envoyé (la connexion par code n'existe que sur ce poste, le code s'affiche dans le terminal de `dev:try`).
 */
export const FAKE_PHONE_PREFIX = "+2250799999";
export const MAX_SEED_OFFERS = 50;
export const DEFAULT_SEED_OFFERS = 8;
export const DEFAULT_SEED_BASE_PRICE = 150_000;
/** Repère placé dans la description de chaque annonce d'exemple : c'est lui qui rend la commande rejouable sans doublon. */
export const SEED_MARKER = "[dev:seed]";
export const SEED_DESCRIPTION = `${SEED_MARKER} Annonce d'exemple : aucun vrai vendeur, aucun vrai produit.`;

export const SEED_USAGE =
  'Usage : npm run dev:seed -- --category phones --brand apple --model "iphone 12" [--offers 8] [--price 150000]';

/** Alias courts des catégories de l'interface (la clé de l'annonce d'exemple doit être celle des annonces créées dans l'application). */
const CATEGORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  phones: "Téléphones",
  furniture: "Maison et meubles",
  electronics: "Électronique",
  cooling: "Climatisation",
  tools: "Outillage",
  vehicles: "Véhicules",
});

const normalizeText = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** `phones` ou le libellé exact de l'interface (casse et accents ignorés) → le libellé de l'interface ; sinon `null`. */
export function resolveSeedCategory(value: string): string | null {
  const wanted = normalizeText(value);
  if (Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, wanted)) return CATEGORY_ALIASES[wanted];
  return CATEGORY_OPTIONS.find((option) => normalizeText(option.label) === wanted)?.label ?? null;
}

export interface SeedOptions {
  /** Libellé de l'interface (« Téléphones »). */
  category: string;
  brand: string;
  model: string;
  offers: number;
  basePrice: number;
}

export class SeedUsageError extends Error {}

const TEXT_VALUE = /^[^\u0000-\u001f\u007f]{1,60}$/u;

/** Arguments : `--category`, `--brand`, `--model` obligatoires ; `--offers` (1 à 50, défaut 8) ; `--price` (prix de référence, défaut 150 000). */
export function parseSeedArguments(args: readonly string[]): SeedOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new SeedUsageError(`valeur manquante pour ${flag ?? "l'option"}`);
    if (!["--category", "--brand", "--model", "--offers", "--price"].includes(flag) || values.has(flag)) {
      throw new SeedUsageError(`option inconnue ou répétée : ${flag}`);
    }
    values.set(flag, value);
  }
  const category = values.get("--category");
  const brand = values.get("--brand")?.trim();
  const model = values.get("--model")?.trim();
  if (category === undefined) throw new SeedUsageError("--category est obligatoire");
  if (!brand) throw new SeedUsageError("--brand est obligatoire");
  if (!model) throw new SeedUsageError("--model est obligatoire");
  const resolved = resolveSeedCategory(category);
  if (resolved === null) {
    throw new SeedUsageError(`catégorie inconnue « ${category.slice(0, 40)} » (essayez : phones, ou ${CATEGORY_OPTIONS.map((option) => `« ${option.label} »`).join(", ")})`);
  }
  for (const [name, text] of [["--brand", brand], ["--model", model]] as const) {
    if (!TEXT_VALUE.test(text)) throw new SeedUsageError(`${name} doit être un texte de 1 à 60 caractères sans caractère de contrôle`);
  }
  const offersText = values.get("--offers");
  const offers = offersText === undefined ? DEFAULT_SEED_OFFERS : /^[0-9]{1,3}$/.test(offersText) ? Number(offersText) : Number.NaN;
  if (!Number.isInteger(offers) || offers < 1 || offers > MAX_SEED_OFFERS) throw new SeedUsageError(`--offers doit être un entier de 1 à ${MAX_SEED_OFFERS}`);
  const priceText = values.get("--price");
  const basePrice = priceText === undefined ? DEFAULT_SEED_BASE_PRICE : /^[0-9]{4,9}$/.test(priceText) ? Number(priceText) : Number.NaN;
  if (!Number.isSafeInteger(basePrice) || basePrice < 1_000 || basePrice > 100_000_000) throw new SeedUsageError("--price doit être un entier de 1 000 à 100 000 000 FCFA");
  return { category: resolved, brand, model, offers, basePrice };
}

export type SeedEnvironmentCheck = { ok: true; databaseName: string } | { ok: false; reason: string };

/** Nom de la base d'une adresse PostgreSQL, lu comme `pg` le lit (chemin décodé avec decodeURI) ; chaîne vide si illisible. */
export function databaseNameOf(databaseUrl: string): string {
  try {
    return decodeURI(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/**
 * Garde-fous AVANT toute connexion : `NODE_ENV` absent, vide ou « development » (même règle que `dev:try`) ; `DATABASE_URL` présent dans
 * l'environnement de lancement (aucun fichier .env lu) ; base de CE poste (même règle que `dev:try`) ; nom de base commençant par `noma_` et
 * différent de `noma_dev` (la base de développement habituelle n'est jamais peuplée d'exemples). Le motif de refus ne contient jamais l'adresse.
 */
export function checkSeedEnvironment(env: Readonly<Record<string, string | undefined>>): SeedEnvironmentCheck {
  const nodeEnv = checkDevelopmentNodeEnv(env.NODE_ENV);
  if (!nodeEnv.ok) {
    return {
      ok: false,
      reason: `NODE_ENV vaut « ${nodeEnv.received} » : dev:seed ne s'exécute que hors production (retirez NODE_ENV ou mettez NODE_ENV=development).`,
    };
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return {
      ok: false,
      reason:
        "DATABASE_URL est obligatoire dans l'environnement de lancement : indiquez la base d'essai (aucune valeur par défaut, aucun fichier .env* lu). Voir ESSAYER.md.",
    };
  }
  const local = checkLocalDatabaseUrl(databaseUrl);
  if (!local.ok) return { ok: false, reason: local.reason.replace("dev:try n'envoie", "dev:seed n'écrit") };
  const databaseName = databaseNameOf(databaseUrl);
  if (!databaseName.startsWith("noma_")) {
    return { ok: false, reason: "Le nom de la base d'essai doit commencer par « noma_ » (par exemple noma_essai) : dev:seed refuse toute autre base." };
  }
  if (databaseName.toLowerCase() === "noma_dev") {
    return { ok: false, reason: "dev:seed refuse la base noma_dev (base de développement) : utilisez une base d'essai (noma_essai, noma_e2e…)." };
  }
  return { ok: true, databaseName };
}

/** Numéro E.164 du vendeur fictif n° `index` (1 à 50) : +22507999999NN. */
export function fakeSellerPhone(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_SEED_OFFERS) throw new RangeError("index de vendeur fictif hors de 1 à 50");
  return `${FAKE_PHONE_PREFIX}${String(index).padStart(2, "0")}`;
}

/** Vrai pour un numéro du bloc fictif. */
export function isFakeSellerPhone(phone: string): boolean {
  return new RegExp(`^\\+2250799999(0[1-9]|[1-4][0-9]|50)$`).test(phone);
}

/** Identifiant (UUID v4 de forme) stable d'un vendeur fictif : le même numéro donne toujours le même compte, d'une exécution à l'autre. */
export function fakeSellerId(phone: string): string {
  const hex = createHash("sha256").update(`noma-dev-seed:${phone}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export interface PlannedSeedOffer {
  index: number;
  phone: string;
  title: string;
  /** Texte brut enregistré : titre, ligne vide, description d'exemple (avec le repère). */
  rawText: string;
  price: number;
}

/** Première lettre en majuscule (« apple » → « Apple ») : le reste du texte est conservé tel quel. */
export const capitalizeFirst = (text: string): string => (text.length === 0 ? text : text[0].toUpperCase() + text.slice(1));

/**
 * Plan des annonces : une par vendeur fictif, prix étalés de 70 % à 105 % du prix de référence (arrondis à 1 000 FCFA), du moins cher au plus
 * cher. Le plan ne dépend QUE des options : un nouvel appel produit les mêmes annonces (c'est ce qui permet de ne rien dupliquer).
 */
export function planSeedOffers(options: SeedOptions): PlannedSeedOffer[] {
  const planned: PlannedSeedOffer[] = [];
  for (let index = 1; index <= options.offers; index += 1) {
    // Calcul en entiers (70 % + 35 % × rang/(n-1)) : aucune erreur d'arrondi à virgule flottante sur les demi-milliers.
    const steps = options.offers - 1;
    const thousands = steps === 0 ? options.basePrice / 1_000 : (options.basePrice * (70 * steps + 35 * (index - 1))) / (100 * steps * 1_000);
    const price = Math.max(1_000, Math.round(thousands) * 1_000);
    const title = `${capitalizeFirst(options.brand)} ${options.model} · offre d'exemple n° ${index}`;
    planned.push({ index, phone: fakeSellerPhone(index), title, rawText: `${title}\n\n${SEED_DESCRIPTION}`, price });
  }
  return planned;
}
