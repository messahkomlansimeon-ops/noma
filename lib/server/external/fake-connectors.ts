import { createHash } from "node:crypto";
import { normalizeKeyPart } from "./product-key";
import type { ConnectorContext, ExternalListingDraft, ProductKey, SourceConnector } from "./types";

/**
 * Connecteurs FICTIFS déterministes (lot EXT1) : « Annonces Démo A » (`demo_a`) et « Annonces Démo B » (`demo_b`). Ce sont les SEULS connecteurs qui existent.
 * Aucun ne touche le réseau : les adresses des annonces utilisent le domaine réservé `.example` (RFC 2606) et ne sont jamais appelées.
 *
 * Pourquoi ils ne reposent pas sur `lib/server/fake-sources.ts` : ses coureurs alimentent le flux NDJSON de la recherche à la demande (le besoin entier en texte, pas une clé produit),
 * leur lenteur est réglée par une variable d'environnement globale et ils ne simulent ni panne, ni doublons entre sources, ni annonces qui disparaissent. Les conventions sont les mêmes
 * (annonces de démonstration, offre hors budget, accessoire à écarter), mais ce module les rend pilotables et déterministes par clé produit.
 *
 * Catalogue d'une clé : pour chaque source, des annonces du produit, une annonce HORS BUDGET, un ACCESSOIRE (coque), un AUTRE modèle (« … Pro »), une annonce SANS LIEU, et — à la
 * source B — la même annonce que la source A (titre reformulé, prix à 1 % près : DOUBLON ENTRE SOURCES) et une annonce dont le titre porte un NUMÉRO DE TÉLÉPHONE (à retirer).
 *
 * Pilotage (tests, essais) par `controls` : panne, lenteur, annonces qui disparaissent, réponse invalide, dérive des prix, annonces en plus, compteur d'appels.
 */

export interface FakeConnectorControls {
  /** Non nul : chaque recherche échoue avec cette erreur (panne de la source). */
  failure: unknown;
  /** Lenteur simulée avant la réponse ; elle honore le signal d'annulation (délai de la recherche). */
  latencyMs: number;
  /** Identifiants externes retirés de la réponse (annonces disparues). */
  hidden: Set<string>;
  /** Réponse qui n'est pas une liste. */
  malformed: boolean;
  /** Pourcentage ajouté à chaque prix (changement de contenu). */
  priceDriftPercent: number;
  /** Annonces ajoutées à la réponse (essais). */
  extra: ExternalListingDraft[];
  /** Nombre de recherches reçues. */
  calls: number;
  /** Observateur appelé à chaque recherche, avant la réponse. */
  onSearch: ((key: ProductKey) => void | Promise<void>) | null;
}

export interface FakeConnector extends SourceConnector {
  readonly controls: FakeConnectorControls;
}

export const FAKE_SOURCE_A = "demo_a";
export const FAKE_SOURCE_B = "demo_b";

const REFERENCE_PRICES: ReadonlyArray<readonly [string, number]> = [
  ["iphone 12", 150_000],
  ["galaxy s21", 125_000],
  ["macbook air m1", 450_000],
];

const PRETTY_WORDS: Readonly<Record<string, string>> = { iphone: "iPhone", macbook: "MacBook", ipad: "iPad", go: "Go", to: "To", tv: "TV", lg: "LG", hp: "HP" };

function prettyWord(word: string): string {
  if (word in PRETTY_WORDS) return PRETTY_WORDS[word];
  if (/\d/.test(word) && /[a-z]/.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const pretty = (text: string): string => text.split(" ").filter(Boolean).map(prettyWord).join(" ");

const slugOf = (text: string): string => normalizeKeyPart(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

/** Prix de référence de la clé (fictif) : table pour les produits de la démonstration, sinon dérivé du modèle (de 20 000 à 299 000). */
export function fakeReferencePrice(key: ProductKey): number {
  const model = normalizeKeyPart(key.model);
  for (const [name, price] of REFERENCE_PRICES) if (model === name) return price;
  const digest = createHash("sha256").update(model).digest();
  return 20_000 + (digest.readUInt16BE(0) % 280) * 1_000;
}

const round500 = (value: number): number => Math.max(500, Math.round(value / 500) * 500);

function communesOf(zone: string): string[] {
  if (zone === "") return ["Abidjan", "Cocody", "Marcory", "Plateau", "Yopougon"];
  if (zone === "abidjan") return ["Cocody", "Marcory", "Yopougon", "Plateau", "Riviera"];
  return [pretty(zone)];
}

function hostOf(code: string): string {
  return `annonces-${code.replace(/[^a-z0-9]+/g, "-")}.example`;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Catalogue DÉTERMINISTE d'une source pour une clé (même clé, même source, même jour : mêmes annonces). Fonction pure.
 * La source dont le code est `demo_b` ajoute le doublon de la source A et l'annonce au titre porteur d'un numéro.
 */
export function fakeCatalog(code: string, key: ProductKey, now: Date = new Date()): ExternalListingDraft[] {
  const product = pretty([normalizeKeyPart(key.model), key.variant ?? ""].join(" ").trim());
  const base = fakeReferencePrice(key);
  const communes = communesOf(key.zone);
  const idPrefix = `${code}-${slugOf(`${key.model} ${key.variant ?? ""}`)}-${slugOf(key.zone) === "x" ? "all" : slugOf(key.zone)}`;
  const url = (id: string): string => `https://${hostOf(code)}/annonce/${id}`;
  const day = startOfUtcDay(now);
  const posted = (hoursAgo: number): Date => new Date(day - hoursAgo * 3_600_000);
  const isB = code === FAKE_SOURCE_B;
  const currency = isB ? "FCFA" : "XOF";
  const make = (n: number, title: string, price: number | null, location: string | null, hoursAgo: number): ExternalListingDraft => {
    const id = `${idPrefix}-${n}`;
    return { externalId: id, title, price, currency, url: url(id), location, listedAt: posted(hoursAgo), availability: "available" };
  };
  const list: ExternalListingDraft[] = [];
  if (!isB) {
    list.push(
      make(1, `${product} noir, bon état`, round500(base), communes[0], 5),
      make(2, `${product} blanc, utilisé avec soin`, round500(base * 0.85), communes[1 % communes.length], 9),
      make(3, `${product} sous blister, jamais ouvert`, round500(base * 1.9), communes[2 % communes.length], 20),
      make(4, `Coque silicone pour ${product}`, 3_500, communes[3 % communes.length], 30),
      make(5, `${product} Pro Max reconditionné`, round500(base * 1.4), communes[0], 48),
      make(6, `${product} vert, très bon état`, round500(base * 0.93), null, 52),
    );
  } else {
    list.push(
      // Le doublon de l'annonce n° 1 de la source A : titre reformulé, prix à 1 % près.
      make(1, `${product} noir (très bon état)`, round500(base * 1.01), communes[0], 4),
      make(2, `${product} gris, garantie 1 mois`, round500(base * 0.92), communes[4 % communes.length], 15),
      make(3, `${product} appelez 07 08 09 10 11`, round500(base * 0.9), communes[1 % communes.length], 22),
      make(4, `${product} très propre`, round500(base * 1.05), communes[0], 40),
    );
  }
  return list;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Un connecteur fictif pour le code donné (une ligne `external_sources` de type « fake » doit exister pour qu'il serve). */
export function createFakeConnector(code: string): FakeConnector {
  const controls: FakeConnectorControls = { failure: null, latencyMs: 0, hidden: new Set(), malformed: false, priceDriftPercent: 0, extra: [], calls: 0, onSearch: null };
  return {
    code,
    kind: "fake",
    controls,
    async search(key: ProductKey, context: ConnectorContext): Promise<ExternalListingDraft[]> {
      controls.calls += 1;
      if (controls.onSearch) await controls.onSearch(key);
      if (controls.latencyMs > 0) await waitFor(controls.latencyMs, context.signal);
      if (controls.failure !== null) throw controls.failure;
      if (controls.malformed) return { not: "a list" } as unknown as ExternalListingDraft[];
      const drift = 1 + controls.priceDriftPercent / 100;
      const listings = [...fakeCatalog(code, key, context.now), ...controls.extra].filter((listing) => !controls.hidden.has(listing.externalId));
      return listings.map((listing) => (listing.price === null || controls.priceDriftPercent === 0 ? { ...listing } : { ...listing, price: Math.round(listing.price * drift) }));
    },
  };
}

/** Les deux connecteurs fictifs, « Annonces Démo A » puis « Annonces Démo B ». */
export function createFakeConnectors(): FakeConnector[] {
  return [createFakeConnector(FAKE_SOURCE_A), createFakeConnector(FAKE_SOURCE_B)];
}
