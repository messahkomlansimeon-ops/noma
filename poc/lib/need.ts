/**
 * Besoin acheteur structuré — v2.
 *
 * Règles clés (cahier des charges) :
 * - capacité reconnue UNIQUEMENT avec unité explicite (Go/GB/Gigas, To/TB) ;
 *   le numéro de modèle (« iPhone 12 ») n'est jamais une capacité ;
 * - budget : devise explicite (FCFA/XOF/CFA/francs → XOF, USD/$ → USD, EUR/€ → EUR)
 *   ou marqueur (« budget », « max », « moins de », « jusqu'à ») ou montant final
 *   groupé (« canapé 3 places cocody 200 000 ») ; sinon budget = null —
 *   aucun plafond implicite ;
 * - zone et budget sont retirés des mots-clés produit ;
 * - accents, casse et espaces normalisés pour le matching.
 */

export type Currency = "XOF" | "USD" | "EUR";

export interface Budget {
  amount: number;
  /** Devise reconnue ; null = montant sans devise explicite. */
  currency: Currency | null;
  /** true si la devise était écrite dans le besoin. */
  explicitCurrency: boolean;
}

export interface Capacity {
  value: number;
  unit: "Go" | "To";
}

export interface ParsedNeed {
  text: string;
  kind: "produit" | "service";
  /** Libellé produit/service sans budget, zone, capacité ni critères.
   *  La variante (Pro/Max/…) y reste : « iphone 12 pro », pas « pro ». */
  product: string;
  /** Modèle détecté, ex. « iphone 12 » ; null sinon. */
  model: string | null;
  /** Variante détectée (pro, max, plus, mini, ultra) ; null sinon. */
  variant: string | null;
  capacity: Capacity | null;
  budget: Budget | null;
  zone: string | null;
  /** Critères libres reconnus (« bon état », « pas de troc »…). */
  criteria: string[];
  /** Caractéristiques chiffrées génériques (pointure, pouces, BTU, CV,
   *  watts, litres, mètres, cm, kg, places…) — revue « pertinence ». */
  attributes: Attribute[];
  /** Mots-clés produit (sans zone, budget, capacité, critères, attributs). */
  keywords: string[];
  /** Compréhension sémantique facultative. Elle enrichit les formulations de
   *  recherche mais ne remplace aucune contrainte déterministe. */
  semantic?: {
    canonicalProduct: string;
    category: string;
    searchTerms: string[];
    requirements: SemanticCriterion[];
    preferences: SemanticCriterion[];
    exclusions: SemanticCriterion[];
  };
}

export interface SemanticCriterion {
  label: string;
  value: string;
  evidence: string;
}

export interface Attribute {
  /** Nom de caractéristique, ex. « pouces », « pointure », « BTU ». */
  label: string;
  value: number;
}

/** Grammaire numérique partagée (revue 5 P1-2) :
 *  milliers groupés (« 12 000 », « 12.000 »), entier long (« 12000 »),
 *  décimal (« 1,5 », « 42.5 »). Sans elle, « 1,5 CV » se lit « 5 CV » et
 *  « 12 000 BTU » se lit « 000 BTU » → valeur 0 → contrainte perdue. */
const NUM = String.raw`(?:\d{1,3}(?:[ \u00a0.,]\d{3})+|\d{4,6}|\d{1,3}(?:[.,]\d{1,2})?)`;

/** Normalisation d'un nombre extrait : « 12 000 »→12000, « 12.000 »→12000,
 *  « 12,000 »→12000 (virgule suivie d'exactement 3 chiffres en fin = milliers,
 *  revue 6 P2 — sinon parseFloat s'arrête à la virgule : 12 BTU), « 1,5 »→1.5,
 *  « 42.5 »→42.5. Un séparateur suivi de 3 chiffres = milliers ; suivi de
 *  1-2 chiffres = décimales. */
function parseNum(raw: string): number {
  const s = raw.trim();
  if (/^\d{1,3}(?:[ \u00a0.]\d{3})+$/.test(s))
    return parseFloat(s.replace(/[ \u00a0.]/g, ""));
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) return parseFloat(s.replace(/,/g, ""));
  if (/^\d{1,3},\d{1,2}$/.test(s)) return parseFloat(s.replace(",", "."));
  return parseFloat(s.replace(/[ \u00a0]/g, ""));
}

/** Unités de caractéristiques reconnues (valeur + libellé).
 *  Le texte est normalisé (sans accents) avant application. */
export const ATTRIBUTE_PATTERNS: [RegExp, string][] = [
  [new RegExp(`pointure\\s*(${NUM})`), "pointure"],
  [new RegExp(`(${NUM})\\s*pointure`), "pointure"],
  [new RegExp(`taille\\s*(${NUM})`), "taille"],
  [new RegExp(`(${NUM})\\s*(?:pouces?|″|po\\b|")`), "pouces"],
  [new RegExp(`(${NUM})\\s*btu\\b`), "BTU"],
  [new RegExp(`(${NUM})\\s*(?:cv|chevaux|ch)\\b`), "CV"],
  [new RegExp(`(${NUM})\\s*(?:watts?|w\\b)`), "W"],
  [new RegExp(`(${NUM})\\s*(?:litres?|l\\b)`), "L"],
  [new RegExp(`(${NUM})\\s*(?:metres?|m\\b)`), "m"],
  [new RegExp(`(${NUM})\\s*(?:cm|centimetres?)\\b`), "cm"],
  [new RegExp(`(${NUM})\\s*(?:kg|kilos?|kilogrammes?)\\b`), "kg"],
  [new RegExp(`(${NUM})\\s*places?\\b`), "places"],
];

/** Unités où les annonces listent plusieurs valeurs (« pointure 42/43 »,
 *  « 40-41-42 », « table 4/6 places ») — revue 6 P2-1. */
const MULTI_VALUE_UNITS = new Set(["pointure", "taille", "places", "pouces"]);

/** Suite de valeurs du MÊME unité après une première (« 42/43 », « 40-45 »).
 *  Séparateurs restreints à / et - (pas de virgule ni d'espace : « TV 43
 *  pouces, 65 000 F » avalerait un prix). Garde : le nombre ne doit pas être
 *  suivi d'espaces/point + chiffres (début d'un nombre groupé type « 65 000 »). */
const VALUE_LIST = /(?:\s*[/]\s*|\s*[-–]\s*)(\d{1,3}(?:[.,]\d{1,2})?)(?![\s\u00a0.]*\d)/g;

/** Toutes les paires valeur+unité trouvées dans un texte d'annonce.
 *  Chaque valeur reste liée à SON unité (revue 5 P1-1) : « 65 pouces,
 *  consommation 55 W » donne [{pouces:65},{W:55}] — le « 55 » du watt ne
 *  peut plus confirmer des pouces. Les valeurs multiples reconnues
 *  (« pointure 42/43 » → 42 ET 43, revue 6 P2-1) évitent de rejeter une
 *  annonce qui propose les deux tailles. */
export function extractAttributeValues(text: string): Attribute[] {
  const found: Attribute[] = [];
  for (const [re, label] of ATTRIBUTE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      const value = parseNum(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      found.push({ label, value });
      if (!MULTI_VALUE_UNITS.has(label)) continue;
      VALUE_LIST.lastIndex = m.index + m[0].length;
      let cont: RegExpExecArray | null;
      while (
        (cont = VALUE_LIST.exec(text)) !== null &&
        cont.index === VALUE_LIST.lastIndex - cont[0].length
      ) {
        const v = parseNum(cont[1]);
        if (Number.isFinite(v) && v > 0) found.push({ label, value: v });
        else break;
      }
    }
  }
  return found;
}

/** Extraction des caractéristiques chiffrées d'un besoin (1re occurrence
 *  par unité) + fragments consommés à retirer des mots-clés produit. */
export function parseAttributes(text: string): {
  attributes: Attribute[];
  consumed: string[];
} {
  const attributes: Attribute[] = [];
  const consumed: string[] = [];
  const seen = new Set<string>();
  for (const [re, label] of ATTRIBUTE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const value = parseNum(m[1]);
    if (Number.isFinite(value) && value > 0 && !seen.has(label)) {
      attributes.push({ label, value });
      consumed.push(m[0]);
      seen.add(label);
    }
  }
  return { attributes, consumed };
}

/** minuscules, sans accents, espaces simples. */
export function accentNormalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Anonymise une demande AVANT toute sortie (console, JSON, artefacts, et
 * donc avant la requête envoyée aux sites).
 * - espaces insécables normalisés AVANT détection (revue P1 : les paires
 *   d'un numéro peuvent être séparées par U+00A0/U+202F) ;
 * - coordonnées masquées : préfixe +225/225, run de 8-10 chiffres avec 0
 *   INITIAL (les prix ne commencent jamais par 0 — revue P2 : « 15000000
 *   FCFA » est préservé), paires « 07 58 96 75 41 » (tout séparateur) dont
 *   la PREMIÈRE paire commence par 0 (revue P1 : sans ce marqueur, « 12 »
 *   d'« iphone 12 07 58 96 75 41 » serait absorbé comme première paire et
 *   la requête partirait en « iphone 41 » — le run démarre au vrai numéro) ;
 * - e-mails masqués ; e-mails et groupes de 3 (« 150 000 », « 4,700,000 »)
 *   jamais touchés.
 * Limite assumée : un numéro sans 0 initial ni préfixe (« 758967541 »)
 * n'est pas masquable sans risque d'effacer un montant.
 */
export function anonymiserBesoin(text: string): string {
  const t = text.replace(/[\u00a0\u202f\u2007]/g, " ");
  return t
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[e-mail]")
    .replace(/\+?225\d{7,10}\b/g, "[téléphone]")
    .replace(/\b0\d{7,9}\b/g, "[téléphone]")
    .replace(/\b0\d(?:[ .-]\d{2}){2,4}\b/g, "[téléphone]");
}

const CURRENCY_MAP: Record<string, Currency> = {
  fcfa: "XOF", "f cfa": "XOF", "f.cfa": "XOF", cfa: "XOF", xof: "XOF",
  franc: "XOF", francs: "XOF", frs: "XOF", f: "XOF",
  usd: "USD", "$": "USD",
  eur: "EUR", "€": "EUR",
};

/** Alternance des devises reconnues (need + annonces) : F.CFA / FCFA / F /
 *  frs / francs… (revue 7 P2). Pas de frontière APRÈS la famille CFA —
 *  les titres FB sont collés (« 85 000 CFAiPhone ») ; frontière requise
 *  pour « f »/« frs » seuls (« 45 fourchettes » n'est pas un prix). */
const CURRENCY_ALT =
  String.raw`f[.\s]?cfa|fcfa|cfa|xof|francs?\b|frs\b|usd\b|eur\b|f\b|€|\$`;

/** Montant tolérant — JAMAIS tronqué (revue 7 P1) : milliers groupés
 *  (« 12 000 », « 12.000 », « 4,700,000 »), décimales (« 1,5 ») et
 *  abréviations locales « k » / « mille » / « million(s) ». */
const AMOUNT_SUFFIX = String.raw`(?:k|mille|millions?)`;
const AMOUNT_WITH_OPTIONAL_SUFFIX = String.raw`\d[\d\s.,]{0,15}(?:${AMOUNT_SUFFIX})?`;

function amountOf(raw: string): number | null {
  const s = raw.trim();
  const abbreviated = s.match(
    /^(\d{1,4}(?:[.,]\d{1,2})?)\s*(k|mille|millions?)$/i,
  );
  if (abbreviated) {
    const v = parseNum(abbreviated[1]);
    const multiplier = abbreviated[2].toLowerCase().startsWith("million")
      ? 1_000_000
      : 1_000;
    return Number.isFinite(v) && v > 0 ? v * multiplier : null;
  }
  const v = parseNum(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const SERVICE_WORDS = [
  "plombier", "plomberie", "reparation", "reparer", "electricien", "menage",
  "coiffure", "coiffeur", "macon", "mecanicien", "demenagement", "couture",
  "couturier", "climatisation", "installation", "peinture", "peintre",
  "carrelage", "menuiserie", "serrurerie", "informatique", "developpement",
  "photographe", "traiteur", "nettoyage", "montage", "reparateur",
];

const ZONES = [
  "abidjan", "cocody", "yopougon", "marcory", "treichville", "adjame",
  "plateau", "koumassi", "port-bouet", "bingerville", "grand-bassam",
  "riviera", "angre", "bouake", "yamoussoukro", "san-pedro", "daloa",
  "korhogo", "man", "gagnoa", "abatta", "songon", "anyama", "bassam",
];

/** Abréviations de localités courantes en Côte d'Ivoire (revue 7 P2). */
const ZONE_ALIASES: Record<string, string> = {
  yop: "yopougon",
};

/** Détecteurs de zone tolérants : « San Pedro »/« San-Pedro »,
 *  « Port Bouët »/« Port-Bouet » — le tiret devient une variante d'espace. */
const ZONE_HITS: { key: string; canonical: string; re: RegExp }[] = [
  ...ZONES,
  ...Object.keys(ZONE_ALIASES),
].map((k) => ({
  key: k,
  canonical: ZONE_ALIASES[k] ?? k,
  re: new RegExp(`\\b${k.replace(/-/g, "[ -]")}\\b`),
}));

const CRITERIA_PATTERNS = [
  "bon etat", "tres bon etat", "casi neuf", "comme neuf", "neuf",
  "pas de troc", "sans troc", "troc possible", "sous blister", "scelle",
  "avec chargeur", "sans chargeur", "garantie", "debloque", "originaire",
];

const STOPWORDS = new Set([
  "un", "une", "de", "des", "du", "le", "la", "les", "à", "a", "au", "en",
  "et", "pour", "je", "cherche", "recherche", "besoin", "que", "quel",
  "vous", "d", "l", "sur", "dans", "pas", "plus", "moins", "bon", "bonne",
  "veux", "voudrais", "vers", "autour", "proche", "environ",
]);

function parseBudget(text: string): { budget: Budget | null; consumed: string } {
  // 1. devise explicite — le montant passe par amountOf : « 4,700,000 FCFA »
  //    = 4 700 000 (revue 7 P1 : plus de troncature en « 4,7 »),
  //    « 150k FCFA » = 150 000, « 5k FCFA » = 5 000 (revue 8 : la garde ≥ 50
  //    ne s'applique QU'À la voie sans devise), « 150 000 F » / « frs » /
  //    « F.CFA » reconnus
  const mCur = text.match(
    new RegExp(`(${AMOUNT_WITH_OPTIONAL_SUFFIX})\\s*(${CURRENCY_ALT})`, "i"),
  );
  if (mCur) {
    const amount = amountOf(mCur[1]);
    const key = accentNormalize(mCur[2]).replace(/\s/g, " ");
    const currency = CURRENCY_MAP[key] ?? CURRENCY_MAP[key.replace(/\s/g, "")] ?? null;
    if (amount && currency) {
      return {
        budget: { amount, currency, explicitCurrency: true },
        consumed: mCur[0],
      };
    }
  }
  // 2. marqueur explicite sans devise — « jusqu'à 150 000 » avec apostrophe
  //    droite ' OU typographique ' (revue 7 P2 : le plafond était perdu).
  //    NB : le texte est accent-strippé (accentNormalize) → « jusqu'à »
  //    s'écrit « jusqu'a » à ce stade ; « jusqu'au » ne doit pas matcher.
  const mMarker = text.match(
    new RegExp(
      String.raw`(?:\b(?:budget|max|maximum|moins de|au plus|pas plus de)\b|jusqu['\u2019\u02BC]?a\b)\s*[:=]?\s*(${AMOUNT_WITH_OPTIONAL_SUFFIX})`,
      "i",
    ),
  );
  if (mMarker) {
    const amount = amountOf(mMarker[1]);
    if (amount) {
      return { budget: { amount, currency: null, explicitCurrency: false }, consumed: mMarker[0] };
    }
  }
  // 3. montant final groupé (« … cocody 200 000 ») ou « … cocody 150k » —
  //    le k final doit valoir ≥ 50 pour ne pas avaler une résolution
  //    (« téléviseur 4k » ≠ un budget de 4 000)
  const mTrail = text.match(
    /(\d{1,3}(?:[ \u00a0.]\d{3})+|\d{4,7}|(\d{1,4})\s*(k|mille|millions?))\s*(?:fcfa|cfa|xof|francs?|frs|f)?\s*$/i,
  );
  if (mTrail) {
    if (mTrail[2] !== undefined) {
      const mult = parseInt(mTrail[2], 10);
      const suffix = mTrail[3].toLowerCase();
      const factor = suffix.startsWith("million") ? 1_000_000 : 1_000;
      if (Number.isFinite(mult) && (factor === 1_000_000 || mult >= 50)) {
        return {
          budget: { amount: mult * factor, currency: null, explicitCurrency: false },
          consumed: mTrail[0],
        };
      }
    } else {
      const amount = parseNum(mTrail[1]);
      if (Number.isFinite(amount) && amount >= 1000) {
        return { budget: { amount, currency: null, explicitCurrency: false }, consumed: mTrail[0] };
      }
    }
  }
  return { budget: null, consumed: "" };
}

function parseCapacity(text: string): { capacity: Capacity | null; consumed: string } {
  const m = text.match(/(\d{1,4})\s*(gigas?|go|gb|to|tb)\b/i);
  if (!m) return { capacity: null, consumed: "" };
  const value = parseInt(m[1], 10);
  const rawUnit = m[2].toLowerCase();
  const unit: "Go" | "To" = rawUnit.startsWith("t") ? "To" : "Go";
  if (!Number.isFinite(value) || value <= 0) return { capacity: null, consumed: "" };
  return { capacity: { value, unit }, consumed: m[0] };
}

function parseModel(text: string): {
  model: string | null;
  variant: string | null;
  consumed: string;
} {
  const m = text.match(
    /\b(iphone|ipad|galaxy|redmi|tecno|infinix|pixel|note|camon|spark)\s*(\d{1,2})((?:\s+(?:pro|max|plus|mini|ultra))*)\b/i,
  );
  if (!m) return { model: null, variant: null, consumed: "" };
  const variant = m[3].trim() ? accentNormalize(m[3].trim()) : null;
  return {
    model: `${m[1]} ${m[2]}`.toLowerCase(),
    variant,
    // consommé : marque + numéro seulement — la variante reste dans le produit
    consumed: `${m[1]} ${m[2]}`,
  };
}

export function parseNeed(text: string): ParsedNeed {
  const flat = accentNormalize(text); // minuscules sans accents
  // ordre important : modèle/capacité AVANT budget — sinon « Pro Max 256 Go »
  // lit « max 256 » comme un budget (« max » est aussi une variante)
  const { model, variant, consumed: modelConsumed } = parseModel(flat);
  // CONSOMMATION SÉQUENTIELLE : modèle puis capacité puis budget, chacun lu
  // sur le reste du texte — sinon « Pro Max 256 Go » lit « max 256 » comme un
  // budget (« max » est aussi une variante) et « go » se retrouve orphelin.
  let rest = modelConsumed ? flat.replace(modelConsumed, " ") : flat;
  const { capacity, consumed: capConsumed } = parseCapacity(rest);
  rest = capConsumed ? rest.replace(capConsumed, " ") : rest;
  const { budget, consumed: budgetConsumed } = parseBudget(rest);
  rest = budgetConsumed ? rest.replace(budgetConsumed, " ") : rest;
  // caractéristiques chiffrées (pointure, pouces, BTU, CV, places…)
  const { attributes, consumed: attrConsumed } = parseAttributes(rest);
  for (const part of attrConsumed) rest = rest.replace(part, " ");

  // zone : la commune la plus spécifique gagne (« cocody abidjan » → cocody)
  const zoneHits = ZONE_HITS.filter((z) => z.re.test(flat));
  const zoneHit = zoneHits.find((z) => z.key !== "abidjan") ?? zoneHits[0] ?? null;
  const zone = zoneHit ? zoneHit.canonical : null;

  const kind: ParsedNeed["kind"] = SERVICE_WORDS.some((w) =>
    new RegExp(`\\b${w}\\b`).test(flat),
  )
    ? "service"
    : "produit";

  const criteria = CRITERIA_PATTERNS.filter((c) => flat.includes(c));

  // produit = texte restant moins budget, zone, critères
  let product = rest;
  if (budgetConsumed) product = product.replace(budgetConsumed, " ");
  // toutes les localités détectées sont retirées du produit (zone + alias +
  // ville simultanées : « climatiseur à Cocody Abidjan » → « climatiseur »)
  for (const h of zoneHits) {
    product = product.replace(new RegExp(h.re.source, "g"), " ");
  }
  for (const c of criteria) product = product.replace(c, " ");
  product = product
    .replace(/\[(?:telephone|e-mail)\]/g, " ")
    .replace(/[·,;:.!?()]+/g, " ")
    .replace(/\b(a|à|et|d|de|du|des|le|la|les|un|une|je|cherche|recherche|besoin|veux|voudrais|pour|avec|sans|max|maximum|budget|moins|jusqu|jusqua|au|plus|vers|autour|proche|environ)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const keywords = product
    .split(" ")
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d{1,2}$/.test(w))
    .slice(0, 5);

  return {
    text: text.trim(),
    kind,
    product: product || (model ? `${model}${variant ? " " + variant : ""}` : ""),
    model,
    variant,
    capacity,
    budget,
    zone,
    criteria,
    attributes,
    keywords,
  };
}

/** Capacité plausible d'une annonce (16–1024 Go ou 1–2 To). */
export function listingCapacity(
  title: string,
  description?: string | null,
): Capacity | null {
  const flat = accentNormalize(`${title} ${description ?? ""}`);
  const matches = flat.matchAll(/(\d{1,4})\s*(gigas?|go|gb|to|tb)\b/gi);
  for (const m of matches) {
    const v = parseInt(m[1], 10);
    const unit = m[2].toLowerCase().startsWith("t") ? "To" : "Go";
    if (unit === "Go" && v >= 16 && v <= 1024) return { value: v, unit };
    if (unit === "To" && v >= 1 && v <= 2) return { value: v, unit };
  }
  return null;
}

/** Devise d'un prix d'annonce ; unknown si absente (jamais supposée).
 *  Montants variés des annonces ivoiriennes : « 150 000 F », « F.CFA »,
 *  « frs », « 4,700,000 FCFA » — le montant passe par amountOf, jamais
 *  tronqué (revue 7 P1/P2). */
export function parsePrice(text: string): {
  amount: number | null;
  currency: Currency | "unknown";
} {
  const flat = accentNormalize(text);
  const curLast = flat.match(
    new RegExp(`(${AMOUNT_WITH_OPTIONAL_SUFFIX})\\s*(${CURRENCY_ALT})`, "i"),
  );
  const curFirst = flat.match(
    new RegExp(`(${CURRENCY_ALT})\\s*(${AMOUNT_WITH_OPTIONAL_SUFFIX})`, "i"),
  );
  const match = curLast ?? curFirst;
  if (!match) {
    const bare = flat.match(/(\d{4,7})(?!\d)/);
    if (!bare) return { amount: null, currency: "unknown" };
    const amount = parseFloat(bare[1]);
    return {
      amount: Number.isFinite(amount) ? amount : null,
      currency: "unknown",
    };
  }
  const amountStr = (curLast ? match[1] : match[2]) ?? "";
  const amount = amountOf(amountStr);
  const key = accentNormalize(curLast ? match[2] : match[1]).replace(/\s/g, " ");
  const currency =
    CURRENCY_MAP[key] ?? CURRENCY_MAP[key.replace(/\s/g, "")] ?? "unknown";
  return { amount: amount ?? null, currency };
}
