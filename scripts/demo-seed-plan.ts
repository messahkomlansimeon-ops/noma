/**
 * Partie PURE de `npm run demo:seed` (lot D1) : aucun accès à la base, aucun module serveur. Le marché de démonstration (vendeurs fictifs, annonces, besoins), les trois
 * comptes de démonstration aux numéros FIXES, les garde-fous de l'environnement (les mêmes que `dev:seed` : base d'essai de CE poste seulement). Testée sans base
 * (tests/scripts/demo-seed.test.ts).
 *
 * Numéros (aucun SMS n'est jamais envoyé : la connexion par code n'existe que sur ce poste, le code s'affiche dans le terminal de `dev:try`) :
 *   Acheteur démo +225 07 00 00 01 01 · Vendeur démo +225 07 00 00 02 02 · Admin démo +225 07 00 00 03 03 (rôle administrateur, attribué par `admin:grant`)
 *   Vendeurs fictifs +225 07 88 88 88 01 à 07 · acheteurs fictifs +225 07 66 66 66 01 à 11 : des numéros qui n'appartiennent à personne.
 */
import { createHash } from "node:crypto";
import { checkSeedEnvironment, type SeedEnvironmentCheck } from "./dev-seed-plan";

export const DEMO_BUYER_PHONE = "+2250700000101";
export const DEMO_VENDOR_PHONE = "+2250700000202";
export const DEMO_ADMIN_PHONE = "+2250700000303";

export const DEMO_VENDOR_PHONE_PREFIX = "+22507888888";
export const DEMO_EXTRA_BUYER_PHONE_PREFIX = "+22507666666";

/**
 * Espace du verrou consultatif qui sérialise deux `demo:seed`. Constante DÉDIÉE (lot D3) : l'ancienne valeur, 1_314_664_955, était celle du plafond de notifications
 * (`NOTIFICATION_CAP_LOCK_NAMESPACE`) ; deux verrous d'usages différents ne partagent jamais un espace. Liste des espaces utilisés : 1_314_664_945 (migrations), 946 et 947 (matching),
 * 948 et 949 (boost : périmètre, devis), 950 (recharges), 951 (achat de boost), 952 (cadence des devis), 953 (dev:seed), 954 (contacts), 955 et 956 (notifications), 957 à 959 (messagerie,
 * conversations, favoris), 960 (demo:seed). Un test (`tests/scripts/demo-seed.test.ts`) vérifie qu'aucun espace n'est déclaré deux fois.
 */
export const DEMO_SEED_LOCK_NAMESPACE = 1_314_664_960;
/** Repère placé dans le texte de chaque annonce et de chaque besoin de démonstration : c'est lui qui rend la commande rejouable sans doublon. */
export const DEMO_MARKER_PREFIX = "[demo:seed:";

export const DEMO_SEED_USAGE = "Usage : npm run demo:seed (aucune option) ; DATABASE_URL doit désigner la base d'essai (noma_essai).";

/** Crédit du porte-monnaie du vendeur démo (FCFA) : de quoi acheter un boost de 24 h ou 3 jours pendant la démonstration. */
export const DEMO_VENDOR_CREDIT_XOF = 25_000;
/** Référence du crédit (unique : le crédit n'est écrit qu'une fois). */
export const DEMO_VENDOR_CREDIT_REFERENCE = "adjustment:demo-seed-vendor-credit";
/** Durée du boost du vendeur démo. */
export const DEMO_BOOST_DURATION = "7d" as const;

/** Acheteurs fictifs qui ouvrent la fiche de l'annonce du vendeur démo (9 à 12 distincts : « environ 10 »), puis ceux qui contactent (5 à 8 : « environ 5 »). */
export const DEMO_EXTRA_BUYER_COUNT = 11;
export const DEMO_OPENERS = 11;
export const DEMO_CONTACTERS = 6;

/**
 * Lot D2 : une conversation de démonstration entre l'acheteur démo et un vendeur FICTIF (3 messages, sans numéro de téléphone), un favori, une commande proposée au
 * vendeur démo par un acheteur fictif, et le rôle d'administrateur du compte Admin démo.
 */
export const DEMO_CONVERSATION_OFFER_KEY = "iphone12-v1";
export const DEMO_CONVERSATION_DEMAND_KEY = "buyer-iphone12";
export const DEMO_CONVERSATION_MESSAGES: ReadonlyArray<{ from: "buyer" | "seller"; body: string }> = Object.freeze([
  { from: "buyer", body: "Bonjour, votre iPhone 12 est-il toujours disponible ?" },
  { from: "seller", body: "Bonjour, oui il est disponible. Vous pouvez passer le voir à Cocody." },
  { from: "buyer", body: "Parfait, merci. Je peux passer demain en fin de journée ?" },
]);
export const DEMO_FAVORITE_OFFER_KEY = "iphone12-v6";
export const DEMO_ORDER_BUYER_INDEX = 1;
export const DEMO_ORDER_OFFER_KEY = "iphone12-demo";
export const DEMO_ORDER_PRICE_XOF = 160_000;

export type DemoCategory = "Téléphones" | "Électronique" | "Maison et meubles" | "Climatisation";

/** Vendeur : 0 = le vendeur démo, 1 à 7 = vendeurs fictifs. */
export type DemoVendorIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DemoOffer {
  /** Clé stable (jamais affichée) : sert de repère d'idempotence. */
  key: string;
  vendor: DemoVendorIndex;
  category: DemoCategory;
  brand: string;
  model: string;
  variant: string | null;
  condition: "Neuf" | "Occasion" | "Reconditionné";
  /** Quartier d'Abidjan. */
  location: string;
  priceXof: number;
  /** Première ligne du texte de l'annonce (le titre affiché au vendeur). */
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  /** Vrai : publiée APRÈS les besoins de l'acheteur démo (elle fait naître des notifications). */
  afterDemands?: true;
  /** Vrai : l'annonce boostée du vendeur démo. */
  boosted?: true;
}

const phone = (
  storage: string,
  color: string,
  battery: number | null,
  warranty: string | null,
): Record<string, unknown> => {
  const attributes: Record<string, unknown> = { stockage: storage, couleur: color, chargeur_inclus: true };
  if (battery !== null) attributes.etat_batterie = `${battery} %`;
  if (warranty !== null) attributes.garantie = warranty;
  return attributes;
};

/** Les 30 annonces du marché de démonstration : 17 téléphones (9 iPhone 12, 8 Galaxy S21), 8 informatique et électronique, 4 maison, 1 climatisation. Aucun numéro de téléphone dans aucun champ. */
export const DEMO_OFFERS: readonly DemoOffer[] = Object.freeze([
  // ── iPhone 12 : 8 annonces avant les besoins (assez pour qu'un boost fasse monter l'annonce), 1 après ──
  { key: "iphone12-v1", vendor: 1, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Cocody", priceXof: 175_000,
    title: "iPhone 12 128 Go noir, très bon état", description: "Débloqué tout opérateur, vendu avec chargeur et coque. Remise en main propre à Cocody.", attributes: phone("128 Go", "Noir", 88, "1 mois") },
  { key: "iphone12-v2", vendor: 2, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Marcory", priceXof: 158_000,
    title: "iPhone 12 128 Go bleu, batterie correcte", description: "Quelques micro-rayures, écran intact. Facture d'achat disponible.", attributes: phone("128 Go", "Bleu", 84, null) },
  { key: "iphone12-v3", vendor: 3, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Yopougon", priceXof: 142_000,
    title: "iPhone 12 128 Go blanc, prix serré", description: "Téléphone sans Face ID réparé, tout le reste fonctionne.", attributes: phone("128 Go", "Blanc", 81, null) },
  { key: "iphone12-v4", vendor: 4, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Reconditionné", location: "Plateau", priceXof: 185_000,
    title: "iPhone 12 128 Go reconditionné, garantie 6 mois", description: "Batterie neuve, boîtier d'origine. Garantie boutique de six mois.", attributes: phone("128 Go", "Noir", 100, "6 mois") },
  { key: "iphone12-v5", vendor: 5, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Treichville", priceXof: 150_000,
    title: "iPhone 12 128 Go vert, bon état", description: "Utilisé avec une coque depuis le premier jour. Vendu avec câble.", attributes: phone("128 Go", "Vert", 86, null) },
  { key: "iphone12-v6", vendor: 6, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Riviera", priceXof: 168_000,
    title: "iPhone 12 128 Go noir, comme neuf", description: "Acheté il y a un an, jamais tombé. Boîte et accessoires d'origine.", attributes: phone("128 Go", "Noir", 92, "2 mois") },
  { key: "iphone12-v7", vendor: 7, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Angré", priceXof: 162_000,
    title: "iPhone 12 128 Go rouge, état correct", description: "Légère usure sur les bords, écran parfait. Échange possible contre un Samsung.", attributes: phone("128 Go", "Rouge", 83, null) },
  { key: "iphone12-demo", vendor: 0, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", location: "Cocody", priceXof: 165_000, boosted: true,
    title: "iPhone 12 128 Go noir, parfait état", description: "Entretenu avec soin, écran protégé depuis l'achat. Vendu avec chargeur d'origine et facture.", attributes: phone("128 Go", "Noir", 90, "1 mois") },
  { key: "iphone12-news", vendor: 3, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "64 Go", condition: "Occasion", location: "Yopougon", priceXof: 128_000, afterDemands: true,
    title: "iPhone 12 64 Go, nouvel arrivage", description: "Arrivé cette semaine, testé avant mise en vente. Prix de départ.", attributes: phone("64 Go", "Blanc", 85, null) },

  // ── Samsung Galaxy S21 : 4 avant, 1 après ──
  { key: "s21-v1", vendor: 1, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Cocody", priceXof: 135_000,
    title: "Samsung Galaxy S21 128 Go gris, très bon état", description: "Écran sans rayure, vendu avec chargeur rapide.", attributes: phone("128 Go", "Gris", 87, "1 mois") },
  { key: "s21-v3", vendor: 3, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Yopougon", priceXof: 118_000,
    title: "Samsung Galaxy S21 128 Go violet", description: "Petit choc sur un coin, fonctionne parfaitement.", attributes: phone("128 Go", "Violet", 80, null) },
  { key: "s21-demo", vendor: 0, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Marcory", priceXof: 140_000,
    title: "Samsung Galaxy S21 128 Go noir, bon état", description: "Premier propriétaire, batterie en bonne santé.", attributes: phone("128 Go", "Noir", 89, "1 mois") },
  { key: "s21-v6", vendor: 6, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Reconditionné", location: "Riviera", priceXof: 125_000,
    title: "Samsung Galaxy S21 128 Go reconditionné", description: "Reconditionné en boutique, garantie trois mois.", attributes: phone("128 Go", "Blanc", 95, "3 mois") },
  { key: "s21-news", vendor: 7, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Angré", priceXof: 130_000, afterDemands: true,
    title: "Samsung Galaxy S21 128 Go, offre du jour", description: "Mis en ligne aujourd'hui, très peu servi.", attributes: phone("128 Go", "Gris", 91, null) },

  // ── Galaxy S21 (suite) : trois annonces de plus avant les besoins, pour que le vendeur démo puisse acheter un boost de son Galaxy S21 (7 annonces avant le besoin) ──
  { key: "s21-v2", vendor: 2, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Adjamé", priceXof: 128_000,
    title: "Samsung Galaxy S21 128 Go bleu, bon état", description: "Quelques traces d'usage, écran sans rayure, chargeur inclus.", attributes: phone("128 Go", "Bleu", 82, null) },
  { key: "s21-v4", vendor: 4, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Reconditionné", location: "Plateau", priceXof: 138_000,
    title: "Samsung Galaxy S21 128 Go reconditionné, garantie 3 mois", description: "Reconditionné, batterie remplacée, garantie boutique.", attributes: phone("128 Go", "Noir", 100, "3 mois") },
  { key: "s21-v5", vendor: 5, category: "Téléphones", brand: "Samsung", model: "Galaxy S21", variant: "128 Go", condition: "Occasion", location: "Treichville", priceXof: 122_000,
    title: "Samsung Galaxy S21 128 Go blanc, prix doux", description: "Téléphone propre, utilisé avec une coque, vendu avec câble.", attributes: phone("128 Go", "Blanc", 80, null) },

  // ── informatique et électronique ──
  { key: "macbook-v4", vendor: 4, category: "Électronique", brand: "Apple", model: "MacBook Air M1", variant: "8 Go · 256 Go", condition: "Occasion", location: "Plateau", priceXof: 475_000,
    title: "MacBook Air M1 8 Go 256 Go gris sidéral", description: "Cycles de batterie faibles, vendu avec son chargeur d'origine.", attributes: { memoire: "8 Go", stockage: "256 Go", couleur: "Gris sidéral", chargeur_inclus: true } },
  { key: "macbook-v2", vendor: 2, category: "Électronique", brand: "Apple", model: "MacBook Air M1", variant: "8 Go · 256 Go", condition: "Occasion", location: "Adjamé", priceXof: 455_000,
    title: "MacBook Air M1 256 Go argent, bon état", description: "Quelques traces sur le capot, clavier AZERTY.", attributes: { memoire: "8 Go", stockage: "256 Go", couleur: "Argent", chargeur_inclus: true } },
  { key: "macbook-demo", vendor: 0, category: "Électronique", brand: "Apple", model: "MacBook Air M1", variant: "8 Go · 256 Go", condition: "Occasion", location: "Plateau", priceXof: 480_000,
    title: "MacBook Air M1 8 Go 256 Go or, très bon état", description: "Acheté en France, utilisé pour les études, aucune réparation.", attributes: { memoire: "8 Go", stockage: "256 Go", couleur: "Or", chargeur_inclus: true, garantie: "1 mois" } },
  { key: "macbook-news", vendor: 6, category: "Électronique", brand: "Apple", model: "MacBook Air M1", variant: "8 Go · 256 Go", condition: "Reconditionné", location: "Riviera", priceXof: 460_000, afterDemands: true,
    title: "MacBook Air M1 reconditionné, garantie 3 mois", description: "Reconditionné, batterie testée, garantie boutique.", attributes: { memoire: "8 Go", stockage: "256 Go", couleur: "Gris sidéral", garantie: "3 mois" } },
  { key: "hp-v4", vendor: 4, category: "Électronique", brand: "HP", model: "Pavilion 15", variant: "8 Go · 512 Go", condition: "Occasion", location: "Plateau", priceXof: 285_000,
    title: "HP Pavilion 15 8 Go 512 Go SSD", description: "Ordinateur portable fiable pour le bureau, écran 15 pouces.", attributes: { memoire: "8 Go", stockage: "512 Go", couleur: "Argent", chargeur_inclus: true } },
  { key: "dell-v2", vendor: 2, category: "Électronique", brand: "Dell", model: "Latitude 5420", variant: "16 Go · 256 Go", condition: "Occasion", location: "Adjamé", priceXof: 240_000,
    title: "Dell Latitude 5420 16 Go 256 Go", description: "Ancien parc d'entreprise, très solide, clavier rétroéclairé.", attributes: { memoire: "16 Go", stockage: "256 Go", couleur: "Noir", chargeur_inclus: true } },
  { key: "tv-v6", vendor: 6, category: "Électronique", brand: "Samsung", model: "Smart TV 43", variant: "43 pouces", condition: "Occasion", location: "Riviera", priceXof: 195_000,
    title: "TV Samsung 43 pouces Smart TV", description: "Télécommande d'origine, support mural non inclus.", attributes: { taille: { value: 43, unit: "pouces" }, resolution: "Full HD" } },
  { key: "tv-v2", vendor: 2, category: "Électronique", brand: "Samsung", model: "Smart TV 43", variant: "43 pouces", condition: "Occasion", location: "Adjamé", priceXof: 180_000,
    title: "TV Samsung 43 pouces écran sans défaut", description: "Écran impeccable, fonctionne avec la box.", attributes: { taille: { value: 43, unit: "pouces" }, resolution: "Full HD" } },

  // ── maison et climatisation ──
  { key: "fridge-v5", vendor: 5, category: "Maison et meubles", brand: "Hisense", model: "Réfrigérateur 2 portes", variant: "300 L", condition: "Occasion", location: "Treichville", priceXof: 210_000,
    title: "Réfrigérateur Hisense 2 portes 300 L", description: "Froid parfait, léger défaut esthétique sur la porte.", attributes: { capacite: { value: 300, unit: "L" }, couleur: "Gris" } },
  { key: "washer-demo", vendor: 0, category: "Maison et meubles", brand: "LG", model: "Machine à laver 8 kg", variant: "8 kg", condition: "Occasion", location: "Marcory", priceXof: 245_000,
    title: "Machine à laver LG 8 kg chargement frontal", description: "Programmes complets, essorage silencieux, livrée possible dans Abidjan.", attributes: { capacite: { value: 8, unit: "kg" }, couleur: "Blanc" } },
  { key: "washer-v6", vendor: 6, category: "Maison et meubles", brand: "LG", model: "Machine à laver 8 kg", variant: "8 kg", condition: "Occasion", location: "Riviera", priceXof: 260_000,
    title: "Machine à laver LG 8 kg, bon état", description: "Utilisée pour une petite famille, tuyaux inclus.", attributes: { capacite: { value: 8, unit: "kg" }, couleur: "Gris" } },
  { key: "sofa-v5", vendor: 5, category: "Maison et meubles", brand: "Maison Treichville", model: "Canapé 3 places", variant: null, condition: "Occasion", location: "Treichville", priceXof: 165_000,
    title: "Canapé 3 places en tissu gris", description: "Confortable, sans tache, démontable pour le transport.", attributes: { places: { value: 3, unit: "places" }, couleur: "Gris" } },
  { key: "ac-v7", vendor: 7, category: "Climatisation", brand: "LG", model: "Split 1,5 CV", variant: "12000 BTU", condition: "Neuf", location: "Angré", priceXof: 235_000,
    title: "Climatiseur LG split 1,5 CV 12000 BTU", description: "Neuf, installation possible en option, garantie deux ans.", attributes: { puissance: { value: 12000, unit: "BTU" }, garantie: "24 mois" } },
]);

export interface DemoDemand {
  key: string;
  /** Texte brut du besoin (première ligne = titre). */
  title: string;
  category: DemoCategory;
  brand: string;
  model: string;
  location: string;
  budgetXof: number;
}

/**
 * Les trois besoins ACTIFS de l'acheteur démo : chacun a plusieurs correspondances. Créés dans cet ordre : le plus récent (l'iPhone 12, celui de la démonstration, avec
 * l'annonce « Sponsorisé ») s'affiche en premier sur l'accueil.
 */
export const DEMO_BUYER_DEMANDS: readonly DemoDemand[] = Object.freeze([
  { key: "buyer-s21", title: "Samsung Galaxy S21 pas trop cher", category: "Téléphones", brand: "Samsung", model: "Galaxy S21", location: "Abidjan", budgetXof: 160_000 },
  { key: "buyer-macbook", title: "MacBook Air M1 pour mes études", category: "Électronique", brand: "Apple", model: "MacBook Air M1", location: "Abidjan", budgetXof: 520_000 },
  { key: "buyer-iphone12", title: "Je cherche un iPhone 12 en bon état à Abidjan", category: "Téléphones", brand: "Apple", model: "iPhone 12", location: "Abidjan", budgetXof: 200_000 },
]);

/** Besoin « iPhone 12 » d'un acheteur fictif n° `index` (1 à 11) : ces acheteurs sont ceux qui ouvrent et contactent l'annonce du vendeur démo. */
export function extraBuyerDemand(index: number): DemoDemand {
  if (!Number.isInteger(index) || index < 1 || index > DEMO_EXTRA_BUYER_COUNT) throw new RangeError("index d'acheteur fictif hors de 1 à 11");
  return {
    key: `extra-iphone12-${String(index).padStart(2, "0")}`,
    title: `iPhone 12 recherché, acheteur n° ${index}`,
    category: "Téléphones",
    brand: "Apple",
    model: "iPhone 12",
    location: "Abidjan",
    budgetXof: 170_000 + (index % 4) * 10_000,
  };
}

export type DemoSeedEnvironmentCheck = SeedEnvironmentCheck;

/**
 * Garde-fous AVANT toute connexion : exactement ceux de `dev:seed` (`NODE_ENV` absent, vide ou « development » ; `DATABASE_URL` présente dans l'environnement de lancement,
 * base de CE poste, nom de base dans la liste blanche `noma_essai`, `noma_e2e`, `noma_essai_*`). `noma_dev`, `noma_test` et toute autre base sont refusées.
 */
export function checkDemoSeedEnvironment(env: Readonly<Record<string, string | undefined>>): DemoSeedEnvironmentCheck {
  const checked = checkSeedEnvironment(env);
  if (checked.ok) return checked;
  return { ok: false, reason: checked.reason.replace(/dev:seed/g, "demo:seed") };
}

/** Numéro E.164 du vendeur fictif n° `index` (1 à 7). */
export function demoVendorPhone(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 7) throw new RangeError("index de vendeur fictif hors de 1 à 7");
  return `${DEMO_VENDOR_PHONE_PREFIX}${String(index).padStart(2, "0")}`;
}

/** Numéro E.164 de l'acheteur fictif n° `index` (1 à 11). */
export function demoExtraBuyerPhone(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > DEMO_EXTRA_BUYER_COUNT) throw new RangeError("index d'acheteur fictif hors de 1 à 11");
  return `${DEMO_EXTRA_BUYER_PHONE_PREFIX}${String(index).padStart(2, "0")}`;
}

/** Numéro du vendeur n° `index` : 0 = vendeur démo, 1 à 7 = vendeurs fictifs. */
export function vendorPhoneOf(index: DemoVendorIndex): string {
  return index === 0 ? DEMO_VENDOR_PHONE : demoVendorPhone(index);
}

/** Identifiant stable (UUID v4 de forme) d'un compte de démonstration : le même numéro donne toujours le même compte. */
export function demoAccountId(phoneE164: string): string {
  const hex = createHash("sha256").update(`noma-demo-seed:${phoneE164}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** Repère d'idempotence d'une annonce ou d'un besoin : placé en fin de texte brut. */
export function demoMarker(key: string): string {
  return `${DEMO_MARKER_PREFIX}${key}]`;
}

export function offerRawText(offer: DemoOffer): string {
  return `${offer.title}\n\n${offer.description} ${demoMarker(offer.key)}`;
}

export function demandRawText(demand: DemoDemand): string {
  return `${demand.title}\n\n${demoMarker(demand.key)}`;
}
