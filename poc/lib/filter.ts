/**
 * Évaluation déterministe du besoin vs annonces — v2 (cahier des charges §3, §5).
 *
 * - champs distincts : modèle, capacité, budget, zone ;
 * - capacité : unité explicite uniquement (lib/need.ts) ;
 * - information manquante = « inconnu », jamais un rejet ;
 * - rejet uniquement sur incompatibilité AVÉRÉE (autre modèle, autre capacité) ;
 * - plus aucune tolérance de +10 % : prix > budget → alternative hors budget,
 *   présentée seulement si l'option est activée ;
 * - devise non comparable (USD vs XOF, devise absente) → « prix non comparable »,
 *   jamais comparée au budget.
 */
import type { RawListing } from "./normalize";
import type { ParsedNeed, Attribute, SemanticCriterion } from "./need";
import { accentNormalize, extractAttributeValues, listingCapacity, parsePrice } from "./need";
import { semanticEvidenceState } from "./understanding";

export type MatchState = "compatible" | "incompatible" | "inconnu";

export interface CriterionCheck {
  state: MatchState;
  /** Valeur observée sur l'annonce (si connue). */
  observed: string | null;
  /** Explication courte factuelle. */
  note?: string;
}

export interface EvaluatedListing {
  listing: RawListing;
  model: CriterionCheck;
  capacity: CriterionCheck;
  budget: CriterionCheck;
  zone: CriterionCheck;
  /** Caractéristiques chiffrées demandées (pointure, pouces, BTU…). */
  attributes: CriterionCheck[];
  /** Contraintes sémantiques prouvées dans la demande, alignées par index. */
  semanticRequirements: CriterionCheck[];
  semanticPreferences: CriterionCheck[];
  semanticExclusions: CriterionCheck[];
  /** Prix existant mais non comparable (devise absente ou étrangère). */
  priceNonComparable: boolean;
}

export interface Classification {
  candidates: EvaluatedListing[];
  alternatives: EvaluatedListing[]; // hors budget (option --alternatives)
  rejected: { listing: RawListing; reason: string }[];
}

// Communes intramuros d'Abidjan = zone compatible avec « Abidjan » ;
// villes annexes du district = signalées « zone annexe », sans rejet.
// Formes normalisées : le tiret devient un espace (« port bouet »).
const ABIDJAN_INTRA = new Set([
  "abidjan", "cocody", "yopougon", "marcory", "treichville", "adjame",
  "plateau", "koumassi", "port bouet", "riviera", "angre",
]);
const ABIDJAN_ANNEXE = new Set([
  "bingerville", "anyama", "songon", "abatta", "grand bassam", "bassam",
]);
/** Synonymes de mots-clés produits (essai réel 4B, décision porteur) :
 *  « TV » est un synonyme de « téléviseur » — les annonces « Smart TV … »
 *  ne doivent plus être rejetées « produit sans rapport ». */
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  televiseur: ["tv"],
};

const keywordHits = (keywords: string[], flat: string, flatDesc: string): string[] => {
  const inText = (k: string): boolean =>
    flat.includes(k) ||
    flatDesc.includes(k) ||
    (KEYWORD_SYNONYMS[k] ?? []).some((s) => flat.includes(s) || flatDesc.includes(s));
  return keywords.filter(inText);
};

const semanticProductHit = (need: ParsedNeed, flat: string, flatDesc: string): boolean =>
  (need.semantic?.searchTerms ?? []).some((term) => {
    const normalized = accentNormalize(term);
    if (normalized.length < 2) return false;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phrase = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`);
    return phrase.test(flat) || phrase.test(flatDesc);
  });

const semanticRequirementCheck = (
  criterion: SemanticCriterion,
  text: string,
): CriterionCheck => {
  const state = semanticEvidenceState(text, criterion.value);
  if (state === "affirmed") return { state: "compatible", observed: criterion.value };
  if (state === "negated") {
    return {
      state: "incompatible",
      observed: `contraire indiqué (${criterion.value})`,
    };
  }
  return {
    state: "inconnu",
    observed: null,
    note: `${criterion.value} non confirmé`,
  };
};

const semanticExclusionCheck = (
  criterion: SemanticCriterion,
  text: string,
): CriterionCheck => {
  const state = semanticEvidenceState(text, criterion.value);
  if (state === "negated") {
    return { state: "compatible", observed: `sans ${criterion.value}` };
  }
  if (state === "affirmed") {
    return {
      state: "incompatible",
      observed: `${criterion.value} présent malgré l'exclusion`,
    };
  }
  return {
    state: "inconnu",
    observed: null,
    note: `absence de ${criterion.value} non confirmée`,
  };
};

const CITIES = [
  "abidjan", "cocody", "yopougon", "marcory", "treichville", "adjame",
  "plateau", "koumassi", "port bouet", "bingerville", "grand bassam",
  "riviera", "angre", "bouake", "yamoussoukro", "san pedro", "daloa",
  "korhogo", "abengourou", "dabou", "agboville", "gagnoa",
];
/** Quartiers rattachés à leur commune (Riviera/Angré/Abatta ⊂ Cocody). */
const SUBZONE_OF: Record<string, string> = {
  riviera: "cocody",
  angre: "cocody",
  abatta: "cocody",
};
/** Zone normalisée : minuscules, sans accents, tiret = espace —
 *  « San-Pedro » et « San Pedro » sont la même localité (revue 7 P2). */
const znorm = (s: string): string =>
  accentNormalize(s).replace(/-/g, " ").trim();

function comparableCurrencies(
  budgetCurrency: string | null,
  offerCurrency: string,
): boolean {
  // Budget sans devise explicite → comparable uniquement avec XOF (contexte CI),
  // jamais avec une devise étrangère.
  const b = budgetCurrency ?? "XOF";
  return b === offerCurrency;
}

export function evaluateListing(
  need: ParsedNeed,
  listing: RawListing,
): EvaluatedListing {
  const flat = accentNormalize(listing.title);
  const flatDesc = accentNormalize(listing.description ?? "");
  const semanticText = `${flat} ${flatDesc}`;
  const semanticRequirements = (need.semantic?.requirements ?? []).map((criterion) =>
    semanticRequirementCheck(criterion, semanticText),
  );
  const semanticPreferences = (need.semantic?.preferences ?? []).map((criterion) =>
    semanticRequirementCheck(criterion, semanticText),
  );
  const semanticExclusions = (need.semantic?.exclusions ?? []).map((criterion) =>
    semanticExclusionCheck(criterion, semanticText),
  );

  // ── modèle ──────────────────────────────────────────────────────────────
  let model: CriterionCheck = { state: "inconnu", observed: null };
  // Accessoire AVANT la marque dans le titre = l'accessoire est le produit
  // vendu (« Coque iPhone 12 » ≠ « iPhone 12 », revue 2 P1-3) ; après la
  // marque (« iPhone 12 avec coque ») c'est le téléphone avec son accessoire.
  const ACCESSORY_HEAD = [
    "coque", "chargeur", "cable", "verre", "film", "etui", "housse",
    "adaptateur", "protection", "ecouteur", "ecouteurs", "airpods",
    "sticker", "skin", "bague", "strap", "support", "telecommande",
  ];
  const flatTitle = accentNormalize(listing.title);
  // Le besoin LUI-MÊME peut être un accessoire : « chargeur USB-C »,
  // « coque iPhone 12 », « AirPods », « table en verre »… Dans ce cas les
  // annonces d'accessoires sont exactement ce qui est recherché (revue 3 P1).
  const needProduct = accentNormalize(need.product);
  const firstWord = needProduct.split(" ")[0] ?? "";
  const needIsAccessory =
    (ACCESSORY_HEAD as string[]).includes(firstWord) ||
    (need.model === null &&
      (ACCESSORY_HEAD as string[]).some((a) => needProduct.includes(a)));
  const accessoryHit = ACCESSORY_HEAD.find((a) => {
    const idx = flatTitle.indexOf(a);
    if (idx === -1) return false;
    const brandIdx = need.model ? flatTitle.indexOf(need.model.split(" ")[0]) : flatTitle.length;
    return idx < brandIdx;
  });
  if (accessoryHit && !needIsAccessory) {
    model = {
      state: "incompatible",
      observed: `accessoire (${accessoryHit}) — le modèle mentionné n'est pas le produit vendu`,
    };
    return {
      listing,
      model,
      capacity: { state: "inconnu", observed: null },
      budget: { state: "inconnu", observed: null },
      zone: { state: "inconnu", observed: null },
      attributes: [],
      semanticRequirements,
      semanticPreferences,
      semanticExclusions,
      priceNonComparable: false,
    };
  }
  if (need.model) {
    const [brand, num] = need.model.split(" ");
    const whole = `${flat} ${flatDesc}`;
    const numbers = new Set<string>();
    for (const m of whole.matchAll(new RegExp(`\\b${brand}\\s?(\\d{1,2})\\b`, "g"))) {
      numbers.add(m[1]);
    }
    const hasBrand = whole.includes(brand);
    if (hasBrand && numbers.has(num)) {
      model = { state: "compatible", observed: `${brand} ${num}` };
      // variante : Pro annoncé vs Pro Max annoncé = produits différents
      if (need.variant) {
        const variantWords = ["pro", "max", "plus", "mini", "ultra"];
        const inTitle = variantWords.filter((w) =>
          new RegExp(`\b${brand}\\s?\\d+\\s+${w}\b`).test(whole) ||
          (whole.match(new RegExp(`\\b${brand}\\s?\\d+\\b([^
]{0,30})`))?.[1] ?? "").includes(w),
        );
        const want = need.variant.split(" ");
        const missing = want.filter((w) => !inTitle.includes(w));
        const extra = inTitle.filter((w) => !want.includes(w));
        if (missing.length > 0 || extra.length > 0) {
          model = {
            state: "incompatible",
            observed: `variante différente (${
              inTitle.length ? inTitle.join(" ") : "non indiquée"
            })`,
          };
        }
      }
    } else if (numbers.size > 0 && !numbers.has(num)) {
      model = {
        state: "incompatible",
        observed: `autre numéro de modèle (${[...numbers].join(", ")})`,
      };
    } else if (!hasBrand) {
      const hit =
        keywordHits(need.keywords, flat, flatDesc).length > 0 ||
        semanticProductHit(need, flat, flatDesc);
      model = hit
        ? { state: "inconnu", observed: null, note: "produit apparenté" }
        : { state: "incompatible", observed: "produit sans rapport" };
    } else {
      model = { state: "inconnu", observed: null, note: "numéro de modèle non indiqué" };
    }
  } else {
    // essai réel 4B (relevé porteur) : pour un besoin à mots-clés DISTINCTIFS
    // multiples (« chargeur » + « usb-c »), un hit PARTIEL n'est pas une
    // correspondance exacte — le token manquant (USB-C) doit être vérifié.
    // Jamais rejeté : « solaire » seul ne justifie pas un rejet.
    const hits = keywordHits(need.keywords, flat, flatDesc);
    const semanticHit = semanticProductHit(need, flat, flatDesc);
    if (semanticHit) {
      model = semanticRequirements.every((check) => check.state === "compatible")
        ? { state: "compatible", observed: "sens du produit compatible" }
        : {
            state: "inconnu",
            observed: "produit apparenté",
            note: "exigences du besoin à confirmer",
          };
    } else if (need.keywords.length > 1 && hits.length > 0 && hits.length < need.keywords.length) {
      model = {
        state: "inconnu",
        observed: hits.join(", "),
        note: "mots-clés partiels — à vérifier",
      };
    } else {
      model = hits.length > 0
        ? { state: "compatible", observed: "mots-clés présents" }
        : { state: "incompatible", observed: "produit sans rapport" };
    }
  }

  // ── capacité ────────────────────────────────────────────────────────────
  let capacity: CriterionCheck = { state: "inconnu", observed: null };
  if (need.capacity) {
    const cap = listingCapacity(listing.title, listing.description);
    if (!cap) {
      capacity = {
        state: "inconnu",
        observed: null,
        note: "capacité non indiquée — non confirmée",
      };
    } else if (cap.value === need.capacity.value && cap.unit === need.capacity.unit) {
      capacity = { state: "compatible", observed: `${cap.value} ${cap.unit}` };
    } else if (cap.unit === need.capacity.unit) {
      capacity = { state: "incompatible", observed: `${cap.value} ${cap.unit}` };
    } else {
      // To vs Go : conversion certaine (1 To = 1000 Go) mais restons prudent
      const inGo = cap.unit === "To" ? cap.value * 1000 : cap.value;
      const needInGo = need.capacity.unit === "To" ? need.capacity.value * 1000 : need.capacity.value;
      capacity =
        inGo === needInGo
          ? { state: "compatible", observed: `${cap.value} ${cap.unit}` }
          : { state: "incompatible", observed: `${cap.value} ${cap.unit}` };
    }
  }

  // ── budget ──────────────────────────────────────────────────────────────
  let budget: CriterionCheck = { state: "inconnu", observed: null };
  let priceNonComparable = false;
  if (listing.price === null || !Number.isFinite(listing.price)) {
    budget = {
      state: "inconnu",
      observed: null,
      note: "prix non affiché — à confirmer auprès du vendeur",
    };
  } else {
    const { currency: offerCurrency } = parsePrice(
      `${listing.price} ${listing.currency}`,
    );
    const curRaw = accentNormalize(listing.currency);
    const effCurrency =
      curRaw === "fcfa" || curRaw === "cfa" || curRaw === "xof"
        ? "XOF"
        : curRaw === "usd" || curRaw === "$"
          ? "USD"
          : curRaw === "eur" || curRaw === "€"
            ? "EUR"
            : offerCurrency === "unknown"
              ? "unknown"
              : listing.currency;
    if (
      effCurrency === "unknown" ||
      !comparableCurrencies(need.budget?.currency ?? null, effCurrency)
    ) {
      priceNonComparable = true;
      budget = {
        state: "inconnu",
        observed: `${listing.price} ${effCurrency === "unknown" ? "(devise absente)" : effCurrency}`,
        note: "prix non comparable avec le budget",
      };
    } else if (need.budget === null) {
      budget = { state: "inconnu", observed: `${listing.price} XOF`, note: "budget non défini" };
    } else if (listing.price <= need.budget.amount) {
      budget = { state: "compatible", observed: `${listing.price} XOF ≤ ${need.budget.amount}` };
    } else {
      budget = {
        state: "incompatible",
        observed: `${listing.price} XOF > ${need.budget.amount}`,
        note: "hors budget",
      };
    }
  }

  // ── zone (revue 7 P2 : précision géographique) ─────────────────────────
  let zone: CriterionCheck = { state: "inconnu", observed: null };
  if (need.zone) {
    const lzRaw = listing.zone ?? "";
    const lz = znorm(lzRaw);
    const primary = znorm(lzRaw.split(",")[0] ?? "");
    const nz = znorm(need.zone);
    const sub = Object.entries(SUBZONE_OF).find(
      ([k]) => new RegExp(`\\b${k}\\b`).test(lz),
    );
    // le besoin peut viser un QUARTIER (« Angré » ⊂ Cocody) — revue 8 P2
    const nzParent = SUBZONE_OF[nz] ?? null;
    if (!lz) {
      zone = { state: "inconnu", observed: null, note: "zone non indiquée" };
    } else if (primary === nz) {
      // « Bingerville » demandé + « Bingerville » annoncé = compatible,
      // même si Bingerville est une annexe du district
      zone = { state: "compatible", observed: lzRaw };
    } else if (ABIDJAN_ANNEXE.has(primary)) {
      // Bingerville/Anyama… restent « annexe » même suffixés Abidjan
      zone = {
        state: "inconnu",
        observed: lzRaw,
        note: `zone annexe d'Abidjan : ${primary}`,
      };
    } else if (lz.includes(nz)) {
      zone = { state: "compatible", observed: lzRaw };
    } else if (sub && (sub[1] === nz || nz === "abidjan")) {
      zone = {
        state: "compatible",
        observed: lzRaw,
        note: `quartier de ${sub[1]} (${sub[0]})`,
      };
    } else if (nzParent && sub && sub[1] === nzParent) {
      // besoin quartier + annonce citant un AUTRE quartier de la même
      // commune : Riviera ≠ Angré (incompatibilité avérée)
      zone = {
        state: "incompatible",
        observed: lzRaw,
        note: `autre quartier de ${sub[1]} : ${sub[0]} (≠ ${nz})`,
      };
    } else if (nzParent && !sub && (primary === nzParent || primary === "abidjan")) {
      // revue 8 P2 : « Cocody » annoncée pour un besoin « Angré » — rien ne
      // prouve que l'offre est hors Angré → incertaine, JAMAIS rejetée
      zone = {
        state: "inconnu",
        observed: lzRaw,
        note:
          primary === "abidjan"
            ? `commune non précisée (quartier « ${nz} » demandé)`
            : `commune ${nzParent} annoncée, quartier « ${nz} » non précisé`,
      };
    } else if (nzParent && ABIDJAN_INTRA.has(primary)) {
      // autre commune : une offre à Yopougon ne peut pas être à Angré
      zone = {
        state: "incompatible",
        observed: lzRaw,
        note: `autre commune d'Abidjan : ${primary} (≠ ${nzParent})`,
      };
    } else if (primary === "abidjan" && (nz === "abidjan" || ABIDJAN_INTRA.has(nz))) {
      // « Abidjan » sans commune : compatible avec un besoin « Abidjan »,
      // JAMAIS confirmé pour une commune précise (revue 7 — « zone ok »
      // mensonger : la commune réelle est inconnue)
      zone = nz === "abidjan"
        ? { state: "compatible", observed: lzRaw }
        : { state: "inconnu", observed: lzRaw, note: "commune non précisée (Abidjan)" };
    } else if (ABIDJAN_INTRA.has(primary) && nz === "abidjan") {
      zone = { state: "compatible", observed: lzRaw, note: "commune d'Abidjan" };
    } else if (ABIDJAN_INTRA.has(primary) && ABIDJAN_INTRA.has(nz)) {
      // deux communes différentes d'Abidjan : incompatibilité avérée
      // (Yopougon n'est pas Cocody — revue 7 P2)
      zone = {
        state: "incompatible",
        observed: lzRaw,
        note: `autre commune d'Abidjan : ${primary} (≠ ${nz})`,
      };
    } else {
      // essai réel 4A (régression géographique) : une annonce qui cite une
      // AUTRE ville connue (« Bouaké », « Abengourou »…) alors que la zone
      // demandée n'y figure pas = incompatibilité AVÉRÉE — jamais « inconnu »
      // (l'inconnu maintenait les offres hors zone parmi les candidates)
      const other = CITIES.find((c) => lz.includes(c));
      zone = other
        ? { state: "incompatible", observed: lzRaw, note: `autre zone : ${other} (≠ ${nz})` }
        : { state: "inconnu", observed: lzRaw, note: "zone à vérifier" };
    }
  }

  // ── attributs chiffrés (pointure, pouces, BTU, CV, places…) ────────────
  const attributes: CriterionCheck[] = (need.attributes ?? []).map(
    (attr) => attributeCheck(attr, flat, flatDesc),
  );

  return {
    listing,
    model,
    capacity,
    budget,
    zone,
    attributes,
    semanticRequirements,
    semanticPreferences,
    semanticExclusions,
    priceNonComparable,
  };
}

/** Unités équivalentes sur les annonces : « pointure 42 » et « taille 42 »
 *  désignent la même grandeur pour des chaussures (les listings écrivent
 *  l'un ou l'autre). */
const UNIT_ALIASES: Record<string, string[]> = {
  pointure: ["taille"],
  taille: ["pointure"],
};

/** Vérifie une caractéristique chiffrée sur l'annonce (revue « pertinence »,
 *  durcie revue 5 P1-1) : chaque valeur extraite reste liée à SON unité —
 *  un nombre nu ailleurs dans le texte (« 55 W ») ne confirme jamais une
 *  autre caractéristique (« 55 pouces »). */
function attributeCheck(attr: Attribute, flat: string, flatDesc: string): CriterionCheck {
  const pairs = extractAttributeValues(`${flat} ${flatDesc}`);
  const labels = [attr.label, ...(UNIT_ALIASES[attr.label] ?? [])];
  const sameUnit = pairs.filter((p) => labels.includes(p.label));
  if (sameUnit.some((p) => Math.abs(p.value - attr.value) < 1e-9)) {
    return { state: "compatible", observed: `${attr.value} ${attr.label}` };
  }
  // même unité, valeur différente → incompatibilité avérée
  if (sameUnit.length > 0) {
    const others = [...new Set(sameUnit.map((p) => p.value))]
      .map((v) => `${v} ${attr.label}`)
      .join(" / ");
    return {
      state: "incompatible",
      observed: `${others} (≠ ${attr.value})`,
    };
  }
  return {
    state: "inconnu",
    observed: null,
    note: `${attr.label} ${attr.value} non confirmé sur l'annonce`,
  };
}

export function classify(
  listings: RawListing[],
  need: ParsedNeed,
): Classification {
  const candidates: EvaluatedListing[] = [];
  const alternatives: EvaluatedListing[] = [];
  const rejected: Classification["rejected"] = [];

  for (const l of listings) {
    const ev = evaluateListing(need, l);
    const hardIncompatible =
      ev.model.state === "incompatible" ||
      ev.capacity.state === "incompatible" ||
      ev.attributes.some((a) => a.state === "incompatible") ||
      ev.semanticRequirements.some((check) => check.state === "incompatible") ||
      ev.semanticExclusions.some((check) => check.state === "incompatible") ||
      ev.zone.state === "incompatible";

    if (hardIncompatible) {
      const reason =
        ev.model.state === "incompatible"
          ? `autre modèle (${ev.model.observed ?? "?"})`
          : ev.capacity.state === "incompatible"
            ? `capacité incompatible (${ev.capacity.observed ?? "?"})`
            : ev.zone.state === "incompatible"
              ? `zone incompatible (${ev.zone.note ?? ev.zone.observed ?? "?"})`
              : ev.semanticRequirements.some((check) => check.state === "incompatible")
                ? `exigence contredite (${ev.semanticRequirements.find((check) => check.state === "incompatible")?.observed ?? "?"})`
                : ev.semanticExclusions.some((check) => check.state === "incompatible")
                  ? `exclusion contredite (${ev.semanticExclusions.find((check) => check.state === "incompatible")?.observed ?? "?"})`
              : `caractéristique incompatible (${ev.attributes.find((a) => a.state === "incompatible")?.observed ?? "?"})`;
      rejected.push({ listing: l, reason });
      continue;
    }

    const overBudget =
      ev.budget.state === "incompatible" &&
      !ev.priceNonComparable &&
      need.budget !== null;

    if (overBudget) {
      // présentée dans `alternatives` UNIQUEMENT — jamais fusionnée ici :
      // la décision de les inclure appartient à l'orchestration (§3)
      alternatives.push(ev);
      continue;
    }
    candidates.push(ev);
  }

  return { candidates, alternatives, rejected };
}
