/**
 * Scoring v3.1 (cahier des charges §5 + revue P1-5/P2-7).
 *
 * - contraintes vérifiables calculées DANS LE CODE (lib/filter.ts) ;
 * - l'IA n'apporte que l'interprétation complémentaire, critère par critère ;
 * - un critère IA n'est affiché que si son extrait existe MOT POUR MOT dans
 *   l'annonce ET si sa valeur est contenue dans l'extrait (pas d'affirmation
 *   inventée, pas de valeur contredite par la citation) ;
 * - « Correspondance exacte » exige : modèle+capacité+budget connus et
 *   compatibles, chaque attribut chiffré confirmé (revue 5 P2-4), zone connue
 *   si demandée, et chaque critère exprimé du besoin
 *   (« bon état »…) vérifié dans le texte de l'annonce ;
 * - indices IA validés PAR LOT avant tout décalage global (revue P2-7) ;
 * - échec IA → offres conservées, statut « non évalué par IA ».
 */
import type { EvaluatedListing } from "./filter";
import type { ParsedNeed } from "./need";
import { accentNormalize } from "./need";

export interface AiCriterion {
  nom: string;
  valeur: string | null;
  extrait: string | null;
}

export interface ScoredListing {
  evaluated: EvaluatedListing;
  baseScore: number;
  score: number | null;
  aiStatus: "évalué par IA" | "non évalué par IA";
  criteria: AiCriterion[];
  raison: string;
  /** Part des informations demandées réellement confirmées (revue 3 P2). */
  confirmedRatio: { known: number; total: number };
}

/**
 * Âge en MINUTES depuis la chaîne de fraîcheur des connecteurs.
 * Unités reconnues explicitement : minutes/min, heures/heure/h, jours/jour/j,
 * semaines, mois, « récente », « Hier ». Format inconnu → null (non confirmé,
 * jamais interprété comme ancien — revue 4 P2-1).
 */
export function parseFreshness(date: string | null | undefined): number | null {
  const d = accentNormalize((date ?? "").trim());
  if (!d) return null;
  if (/recente|recent/.test(d)) return 5;
  if (/hier/.test(d)) return 1440;
  const m = d.match(/(\d+)\s*(minutes?|min\b|heures?|h\b|jours?|j\b|semaines?|mois)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (/^min/.test(unit)) return n;
  if (/^h/.test(unit)) return n * 60;
  if (/^j/.test(unit)) return n * 1440;
  if (/^semaine/.test(unit)) return n * 7 * 1440;
  if (/^mois/.test(unit)) return n * 30 * 1440;
  return null;
}

/** Grading monotone sur l'âge en minutes. */
function freshnessScore(date: string | null | undefined): number {
  const min = parseFreshness(date);
  if (min === null) return 0.3; // non confirmée
  if (min <= 60) return 1;
  if (min <= 24 * 60) return 0.85;
  if (min <= 7 * 24 * 60) return 0.6;
  if (min <= 30 * 24 * 60) return 0.4;
  return 0.25;
}

/**
 * Score déterministe de PERTINENCE (revue 3 P2) :
 * - intègre la capacité, la zone et les critères exprimés du besoin
 *   (une information demandée mais absente de l'annonce ne rapporte pas
 *   tous les points — « inconnu » vaut 0,45, pas 1) ;
 * - la fraîcheur est graduelle : récente > jours > mois > absente ;
 * - un critère non demandé par le besoin est neutre (plein score) —
 *   le score 1,00 signifie « tout ce qui est DEMANDÉ est confirmé et récent ».
 * La distinction pertinence / informations confirmées est portée par
 * `confirmedRatio` (voir buildRaison).
 */
export function baseScore(ev: EvaluatedListing, need: ParsedNeed): number {
  const weight = (state: "compatible" | "incompatible" | "inconnu") =>
    state === "compatible" ? 1 : state === "inconnu" ? 0.45 : 0;

  // fraîcheur graduelle, âge normalisé en minutes (revue 4 P2-1)
  const freshness = freshnessScore(ev.listing.date);

  const text = listingText(ev);
  const criterionItems: number[] = need.criteria.map((c) =>
    phraseSatisfied(text, c) ? 1 : 0,
  );
  // ev.attributes est aligné par INDEX sur need.attributes (filter.ts) —
  // revue 5 P2-3 : une caractéristique confirmée ne valide pas les autres.
  const attributeItems: number[] = (need.attributes ?? []).map(
    (_attr, i) => ev.attributes[i]?.state === "compatible" ? 1 : 0,
  );
  const semanticRequiredItems = [
    ...ev.semanticRequirements,
    ...ev.semanticExclusions,
  ].map((check) => check.state === "compatible" ? 1 : 0);
  // Une préférence aide au classement sans devenir un rejet dur. Son absence
  // reste moins pénalisante qu'une exigence obligatoire manquante.
  const semanticPreferenceItems = ev.semanticPreferences.map((check) =>
    check.state === "compatible" ? 1 : check.state === "inconnu" ? 0.7 : 0,
  );
  const criteriaItems = [
    ...criterionItems,
    ...attributeItems,
    ...semanticRequiredItems,
    ...semanticPreferenceItems,
  ];
  const criteriaRatio =
    criteriaItems.length === 0
      ? 1
      : criteriaItems.reduce((sum, value) => sum + value, 0) / criteriaItems.length;

  const score =
    weight(ev.model.state) * 0.25 +
    (ev.listing.price === null
      ? 0.45
      : need.budget
        ? weight(ev.budget.state)
        : 1) * 0.2 +
    (need.capacity ? weight(ev.capacity.state) : 1) * 0.15 +
    (need.zone ? weight(ev.zone.state) : 1) * 0.1 +
    criteriaRatio * 0.15 +
    freshness * 0.15;
  return Math.round(score * 100) / 100;
}

/**
 * Part des informations DEMANDÉES réellement confirmées sur l'annonce
 * (pertinence ≠ confirmations : revue 3 P2).
 */
export function confirmedRatio(ev: EvaluatedListing, need: ParsedNeed): {
  known: number;
  total: number;
} {
  // Le dénominateur dépend UNIQUEMENT du besoin : un critère demandé mais
  // invérifiable (prix absent, devise inconnue) compte comme non confirmé,
  // il n'est jamais retiré du calcul (revue 4 P2-2).
  const items: boolean[] = [];
  items.push(ev.model.state === "compatible");
  if (need.capacity) items.push(ev.capacity.state === "compatible");
  if (need.budget)
    items.push(
      ev.listing.price !== null &&
        !ev.priceNonComparable &&
        ev.budget.state === "compatible",
    );
  if (need.zone) items.push(ev.zone.state === "compatible");
  if (need.criteria.length > 0)
    items.push(need.criteria.every((c) => phraseSatisfied(listingText(ev), c)));
  for (let i = 0; i < (need.attributes ?? []).length; i++) {
    // correspondance indexée : l'attribut i du besoin ↔ la vérification i
    // (revue 5 P2-3 — jamais « n'importe lequel est compatible »)
    items.push(ev.attributes[i]?.state === "compatible");
  }
  for (const check of ev.semanticRequirements) items.push(check.state === "compatible");
  for (const check of ev.semanticPreferences) items.push(check.state === "compatible");
  for (const check of ev.semanticExclusions) items.push(check.state === "compatible");
  return {
    known: items.filter(Boolean).length,
    total: items.length,
  };
}

const listingText = (ev: EvaluatedListing): string =>
  accentNormalize(`${ev.listing.title} ${ev.listing.description ?? ""}`);

/** L'extrait cité existe mot pour mot (accents/casse normalisés) dans l'annonce. */
export function quoteVerified(quote: string | null, ev: EvaluatedListing): boolean {
  if (!quote || quote.trim().length < 3) return false;
  return listingText(ev).includes(accentNormalize(quote));
}

const tokensOf = (s: string): string[] =>
  accentNormalize(s)
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);

/** La valeur affirmée est composée de tokens COMPLETS de la citation
 *  (« 5 % » ≠ « 85 % » — une sous-chaîne ne suffit pas, revue 2 P1-2). */
function valueSupported(valeur: string | null, extrait: string | null): boolean {
  if (!valeur) return true; // simple annotation sans valeur chiffrée
  if (!extrait) return false;
  const v = tokensOf(valeur);
  const e = new Set(tokensOf(extrait));
  return v.length > 0 && v.every((w) => e.has(w));
}

const NEGATION_TAIL = /(?:^|[\s,;.])(pas|non|sans|jamais|plus|ni)\s+(?:en\s+|de\s+|d'\s+)?$/;

/** Vrai si au moins UNE occurrence de la phrase n'est pas niée dans le texte
 *  (« pas en bon état » ne confirme pas « bon état », revue 2 P1-2). */
export function phraseSatisfied(text: string, phrase: string): boolean {
  const t = accentNormalize(text);
  const p = accentNormalize(phrase);
  if (!t.includes(p)) return false;
  let idx = t.indexOf(p);
  while (idx !== -1) {
    const before = t.slice(Math.max(0, idx - 20), idx);
    if (!NEGATION_TAIL.test(before)) return true; // occurrence non niée
    idx = t.indexOf(p, idx + p.length);
  }
  return false; // toutes les occurrences sont niées
}

/** Critère exprimé du besoin vérifié dans le texte de l'annonce. */
function criterionInText(need: ParsedNeed, ev: EvaluatedListing): boolean {
  if (need.criteria.length === 0) return true;
  const text = listingText(ev);
  return need.criteria.every((c) => phraseSatisfied(text, c));
}

/** Raison affichable construite UNIQUEMENT à partir de critères validés. */
export function buildRaison(
  need: ParsedNeed,
  ev: EvaluatedListing,
  aiCriteria: AiCriterion[],
  aiScore: number | null,
): string {
  const parts: string[] = [];

  if (ev.model.state === "compatible") parts.push(`modèle confirmé (${ev.model.observed})`);
  else if (ev.model.state === "inconnu") parts.push("modèle à confirmer");
  else parts.push(`modèle écarté (${ev.model.observed})`);

  if (ev.capacity.state === "compatible") parts.push(`capacité ${ev.capacity.observed}`);
  else if (ev.capacity.state === "inconnu") parts.push("capacité inconnue (non confirmée)");

  if (ev.priceNonComparable) parts.push("prix non comparable (devise)");
  else if (ev.listing.price === null) parts.push("prix sur demande");
  else if (ev.budget.state === "compatible") parts.push(`dans le budget (${ev.budget.observed})`);
  else if (ev.budget.state === "incompatible") parts.push(`hors budget (${ev.budget.observed})`);
  else parts.push("budget à préciser");

  if (ev.zone.state === "compatible") parts.push(`zone ok (${ev.zone.observed})`);
  else if (ev.zone.observed)
    parts.push(`zone : ${ev.zone.observed}${ev.zone.note ? ` — ${ev.zone.note}` : ""}`);
  else if (need.zone) parts.push("zone non indiquée");

  for (let i = 0; i < (need.attributes ?? []).length; i++) {
    const attr = (need.attributes ?? [])[i];
    const check = ev.attributes[i]; // indexé (revue 5 P2-3)
    if (check?.state === "compatible") parts.push(`${attr.label} : ${attr.value} confirmé`);
    else if (check?.state === "incompatible") parts.push(`${attr.label} : ${check.observed}`);
    else parts.push(`${attr.label} ${attr.value} non confirmé`);
  }

  const semantic = need.semantic;
  for (let i = 0; i < (semantic?.requirements.length ?? 0); i++) {
    const criterion = semantic!.requirements[i];
    const check = ev.semanticRequirements[i];
    if (check?.state === "compatible") parts.push(`${criterion.label} : ${criterion.value} confirmé`);
    else if (check?.state === "incompatible") parts.push(`${criterion.label} : ${criterion.value} contredit`);
    else parts.push(`${criterion.label} : ${criterion.value} non confirmé`);
  }
  for (let i = 0; i < (semantic?.preferences.length ?? 0); i++) {
    const criterion = semantic!.preferences[i];
    const check = ev.semanticPreferences[i];
    if (check?.state === "compatible") parts.push(`préférence ${criterion.value} confirmée`);
    else if (check?.state === "incompatible") parts.push(`préférence ${criterion.value} contredite`);
    else parts.push(`préférence ${criterion.value} non confirmée`);
  }
  for (let i = 0; i < (semantic?.exclusions.length ?? 0); i++) {
    const criterion = semantic!.exclusions[i];
    const check = ev.semanticExclusions[i];
    if (check?.state === "compatible") parts.push(`exclusion ${criterion.value} confirmée`);
    else if (check?.state === "incompatible") parts.push(`exclusion ${criterion.value} contredite`);
    else parts.push(`exclusion ${criterion.value} non confirmée`);
  }

  for (const c of aiCriteria) {
    if (c.valeur) {
      parts.push(
        `${c.nom} : ${c.valeur}${c.extrait ? ` (« ${c.extrait} »)` : ""}`,
      );
    }
  }

  // critères exprimés dans le besoin (« bon état »…) : vérifiés ou non
  // (négations prises en compte : « pas en bon état » ≠ « bon état »)
  const unsatisfiedCriteria = need.criteria.filter(
    (c) => !phraseSatisfied(listingText(ev), c),
  );
  for (const c of unsatisfiedCriteria) {
    parts.push(`« ${c} » non vérifié`);
  }

  const exactnessPossible =
    ev.model.state === "compatible" &&
    (!need.capacity || ev.capacity.state === "compatible") &&
    !ev.priceNonComparable &&
    ev.listing.price !== null &&
    (!need.budget || ev.budget.state === "compatible") &&
    (!need.zone || ev.zone.state === "compatible") &&
    unsatisfiedCriteria.length === 0 &&
    criterionInText(need, ev) &&
    // revue 5 P2-4 : « exacte » exige chaque attribut chiffré confirmé —
    // une TV sans taille indiquée n'est pas une correspondance exacte
    // pour un besoin « 55 pouces »
    (need.attributes ?? []).every((_, i) => ev.attributes[i]?.state === "compatible") &&
    ev.semanticRequirements.every((check) => check.state === "compatible") &&
    ev.semanticPreferences.every((check) => check.state === "compatible") &&
    ev.semanticExclusions.every((check) => check.state === "compatible");

  let header: string;
  if (ev.priceNonComparable) header = "Prix non comparable";
  else if (exactnessPossible) header = "Correspondance exacte";
  else if (
    ev.model.state === "inconnu" ||
    (need.capacity && ev.capacity.state === "inconnu") ||
    unsatisfiedCriteria.length > 0 ||
    ev.semanticRequirements.some((check) => check.state === "inconnu") ||
    ev.semanticExclusions.some((check) => check.state === "inconnu")
  ) {
    header = "Correspondance partielle";
  } else if ((aiScore ?? 0) >= 0.9 || baseScore(ev, need) >= 0.9) {
    header = "Correspondance forte";
  } else {
    header = "Correspondance possible";
  }

  const { known, total } = confirmedRatio(ev, need);
  return `${header} — ${parts.join(" · ")} — informations confirmées : ${known}/${total}`;
}

/** Interface du résultat IA brut attendu (schéma Zod côté appelant). */
export interface AiScoreItem {
  idx: number;
  score: number;
  criteres?: { nom: string; valeur: string | null; extrait: string | null }[];
}

export function validateAiBatch(
  items: AiScoreItem[],
  expectedCount: number,
): { valid: AiScoreItem[]; invalid: string[] } {
  const valid: AiScoreItem[] = [];
  const invalid: string[] = [];
  const seen = new Set<number>();
  for (const it of items ?? []) {
    const idx = it.idx;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      invalid.push(`idx hors lot: ${JSON.stringify(idx)}`);
      continue;
    }
    if (seen.has(idx)) {
      invalid.push(`idx dupliqué: ${idx}`);
      continue;
    }
    seen.add(idx);
    valid.push(it);
  }
  return { valid, invalid };
}

/** Critères IA filtrés : extrait vérifié dans l'annonce, valeur soutenue par l'extrait. */
export function verifiedAiCriteria(
  raw: AiScoreItem["criteres"],
  ev: EvaluatedListing,
): AiCriterion[] {
  return (raw ?? []).filter((c) => {
    if (!quoteVerified(c.extrait ?? null, ev)) return false;
    if (!valueSupported(c.valeur ?? null, c.extrait ?? null)) return false;
    return true;
  });
}

export interface AiFn {
  (need: ParsedNeed, chunk: EvaluatedListing[]): Promise<AiScoreItem[] | null>;
}

export interface BatchResult {
  items: AiScoreItem[];
  invalid: string[];
  model: string;
}

/**
 * Collecte des scores IA lot par lot : chaque réponse est validée AVANT le
 * décalage global — un idx invalide d'un lot ne peut jamais noter une annonce
 * d'un autre lot (revue P2-7). `ai` injectable pour les tests hors ligne.
 */
export async function collectBatchScores(
  need: ParsedNeed,
  evaluated: EvaluatedListing[],
  opts: { ai?: AiFn; batchSize?: number; signal?: AbortSignal; onBatch?: (offset: number, items: AiScoreItem[], invalid: string[]) => void } = {},
): Promise<BatchResult> {
  const batchSize = opts.batchSize ?? 10;
  const items: AiScoreItem[] = [];
  const invalid: string[] = [];
  let model = "";

  for (let offset = 0; offset < evaluated.length; offset += batchSize) {
    const chunk = evaluated.slice(offset, offset + batchSize);
    if (chunk.length === 0) break;
    if (!opts.ai) continue;
    // annulation : les lots restants sont sautés (aucun appel fournisseur)
    if (opts.signal?.aborted) break;
    try {
      const res = await opts.ai(need, chunk);
      const raw = res ?? [];
      const { valid, invalid: bad } = validateAiBatch(raw, chunk.length);
      for (const b of bad) invalid.push(`lot ${offset}+: ${b}`);
      for (const v of valid) {
        items.push({ ...v, idx: offset + v.idx });
      }
      if (res) model = "ai";
      opts.onBatch?.(offset, valid, bad);
    } catch (e) {
      invalid.push(`lot ${offset}+ : ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return { items, invalid, model };
}

export const scoreWithAi = collectBatchScores;

export function scoreListings(
  need: ParsedNeed,
  evaluated: EvaluatedListing[],
  aiBatches: AiScoreItem[] | null,
): ScoredListing[] {
  let aiByIdx = new Map<number, AiScoreItem>();
  if (aiBatches) {
    const { valid } = validateAiBatch(aiBatches, evaluated.length);
    aiByIdx = new Map(valid.map((v) => [v.idx, v]));
  }

  const base = evaluated.map((ev) => ({ ev, b: baseScore(ev, need) }));

  return base.map(({ ev, b }, idx) => {
    const ai = aiByIdx.get(idx);
    const criteria = verifiedAiCriteria(ai?.criteres, ev);
    const score =
      ai && typeof ai.score === "number" && ai.score >= 0 && ai.score <= 1
        ? Math.round(((b + ai.score) / 2) * 100) / 100
        : b;
    return {
      evaluated: ev,
      baseScore: b,
      score,
      aiStatus: ai ? "évalué par IA" : "non évalué par IA",
      criteria,
      raison: buildRaison(need, ev, criteria, ai?.score ?? null),
      confirmedRatio: confirmedRatio(ev, need),
    };
  });
}
