/**
 * Moteur de recherche réutilisable (étape 1 « multi-utilisateur ») : le
 * pipeline de search.ts en FONCTION — état isolé par exécution (journal,
 * compteur IA et compteurs cache via RunCtx), connecteurs/IA injectables,
 * artefacts optionnels. Le CLI (search.ts) et un futur backend/worker
 * appellent la même fonction : plusieurs recherches simultanées ne se
 * mélangent plus.
 */
import { z } from "zod";
import { serpQueries } from "./query";
import { rankAndSplit, type RankResult } from "./pipeline";
import {
  safeFetch,
  withDownloadSlot,
  SafeFetchError,
  type TransportDeps,
} from "./fetch";
import { RawListingSchema, ScoreSchema, type RawListing } from "./normalize";
import { llmJson } from "./llm";
import { fetchCoinAfrique } from "../sources/coinafrique";
import { fetchFacebook } from "../sources/facebook";
import { fetchLocanto } from "../sources/locanto";
import { runGoogleSearch } from "./gsearch";
import { serpLinks, looksLikeListing } from "./serp";
import { parseNeed, anonymiserBesoin, type ParsedNeed } from "./need";
import { classify, type Classification } from "./filter";
import { dedupListings, canonicalUrl } from "./dedup";
import { scoreListings, type AiFn, type ScoredListing } from "./scoring";
import {
  runSources,
  summarizeSources,
  bilanSources,
  type Runner,
} from "./orchestrate";
import {
  runWithCtx,
  logLine,
  ledgerRows,
  ledgerByModel,
  totalCost,
  aiCallCount,
  tokenTotals,
  type RunCtx,
} from "./log";
import type { SourceResult } from "../sources/types";
import { mergeNeedFields } from "../../lib/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyUnderstanding,
  fallbackUnderstanding,
  makeNeedUnderstander,
  type NeedClarification,
  type NeedUnderstander,
  type NeedUnderstanding,
} from "./understanding";

export interface RunSearchOptions {
  needText: string;
  /** Réponse signée à une clarification, séparée du texte original afin de
   *  préserver budget, zone et caractéristiques en fin de phrase. */
  clarificationAnswer?: string;
  /** Présenter aussi les alternatives hors budget (défaut : false). */
  alternatives?: boolean;
  /** Annulation externe (toutes les sources + l'IA). */
  signal?: AbortSignal;
  /** Connecteurs injectables (tests hors ligne / backend sélectif). */
  runners?: Runner[];
  /** Journal du run (défaut : silencieux — le CLI passe console.log). */
  log?: (line: string) => void;
  /** Dossier d'artefacts (CLI : results/run-*) — sinon AUCUN fichier écrit. */
  artifactsDir?: string;
  /** IA injectable ; `null` désactive l'IA (défaut : vraie IA OpenRouter). */
  ai?: AiFn | null;
  /** Plafond de dépense IA de CE run — au-delà, IA désactivée proprement. */
  maxCostUsd?: number;
  /**
   * Émission progressive (backend public) : appelé à chaque ARRIVÉE d'une
   * source (ou d'une cible du secours SERP) avec un instantané COMPLET —
   * déduplication, classification et classement DÉTERMINISTE (mêmes fonctions
   * que le pipeline final, sans IA). Indépendant des artefacts. Jamais
   * appelé après annulation ; les résultats déjà publiés ne sont pas retirés.
   */
  onProgress?: (snapshot: RunProgressSnapshot) => void;
  /**
   * Champs structurés du formulaire public (Lot 2) — fusionnés avec le
   * besoin analysé via mergeNeedFields (contrat partagé) : une valeur
   * explicitement renseignée prime ; une valeur vide laisse la valeur
   * extraite du texte ; AUCUN budget par défaut.
   */
  structured?: {
    budgetFcfa?: number | null;
    location?: string | null;
    /** Mode explicite du formulaire : prime sur le type extrait du texte. */
    mode?: "achat" | "service";
  };
  /**
   * Transport injectable pour la vérification d'accessibilité des annonces
   * du classement principal (tests hors ligne : HTTP simulé, aucun réseau).
   */
  itemCheckTransport?: TransportDeps;
  /** Compréhension sémantique injectable ; null = repli déterministe seul. */
  understander?: NeedUnderstander | null;
  /** Compréhension disponible avant le premier connecteur. */
  onUnderstanding?: (understanding: NeedUnderstanding) => void;
}

/** Instantané complet du pipeline à l'arrivée d'une source. */
export interface RunProgressSnapshot {
  /** Source dont l'arrivée a déclenché l'instantané (« serp » = secours SERP). */
  arrivedFrom: string;
  /** Toutes les offres disponibles, classées de façon déterministe
   *  (score déterministe ; aiStatus = « non évalué par IA »). */
  offers: ScoredListing[];
  counts: {
    brutes: number;
    apresDedup: number;
    candidates: number;
    alternatives: number;
    rejets: number;
  };
}

export interface RunSearchResult {
  need: ParsedNeed;
  needText: string;
  understanding: NeedUnderstanding;
  /** Présent uniquement si le choix change le type de résultat recherché. */
  clarification: NeedClarification | null;
  sources: SourceResult[];
  serpListings: RawListing[];
  brutes: RawListing[];
  dedup: {
    kept: RawListing[];
    mergedFrom: Record<string, string[]>;
    possibleDuplicates: { ids: string[]; sources: string[] }[];
    exactDuplicates: number;
  };
  classification: Classification;
  ranked: RankResult;
  finalListings: ScoredListing[];
  artifactsDir?: string;
  stats: {
    offresBrutes: number;
    apresDedup: number;
    fusionsCertaines: number;
    groupesDoublonsPossibles: number;
    candidates: number;
    alternativesHorsBudget: number;
    alternativesScorees: number;
    rejetsIncompatibilite: number;
    /** Annonces du classement principal retirées : 404 confirmé. */
    annoncesInaccessiblesExclues: number;
    /** Accessibilité indéterminée (403/429/timeout/réseau) : conservées,
     *  jamais assimilées à « vendue ». */
    accessibiliteIndeterminee: number;
    appelsIA: number;
    lotsScoring: number;
    tokens: { prompt: number; completion: number };
    cout: { total: number | null; known: boolean };
    couvertureScoring: string;
    cache: { hits: number; misses: number; writes: number; skipped: number; bySource: RunCtx["cache"]["bySource"] };
    cacheEtat: "chaud" | "froid";
    premierResultatMs: number;
    dureeSourcesMs: number;
    dureeTotaleMs: number;
    syntheseSources: ReturnType<typeof summarizeSources>;
    bilanSources: string[];
    parSource: { source: string; status: SourceResult["status"]; annonces: number; dureeMs: number; erreurs: string[] }[];
  };
}

const PageExtractionSchemaForSerp = z.object({
  title: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  currency: z.string().nullable().default("FCFA"),
  zone: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  isListing: z.boolean().default(true),
});

/** IA réelle (OpenRouter via llmJson) — le chemin par défaut du CLI/backend.
 *  Le signal d'annulation du run est transmis jusqu'au fournisseur. */
const makeRealAi = (signal?: AbortSignal): AiFn => async (_need, chunk) => {
  const input = chunk.map((ev, i) => ({
    idx: i,
    titre: ev.listing.title,
    prix: ev.listing.price,
    devise: ev.listing.currency,
    zone: ev.listing.zone,
    fraicheur: ev.listing.date,
    description: ev.listing.description?.slice(0, 150),
  }));
  const { data } = await llmJson(ScoreSchema, {
    arrayKey: "scores",
    task: "scoring",
    system:
      "Tu scores la pertinence d'annonces par rapport à un besoin d'acheteur en Côte d'Ivoire. Renvoie {scores:[{idx, score, criteres:[{nom, valeur, extrait}]}]} avec idx = index de l'annonce, score entre 0 et 1 (1 = correspondance exacte, 0 = sans rapport). criteres = interprétations complémentaires observées dans le titre/description, avec extrait textuel justificatif repris MOT POUR MOT de l'annonce. raison factuelle en français. Une info absente = inconnue, jamais inventée.",
    user: `Besoin: ${_need.text}${_need.budget ? ` (budget max ${_need.budget.amount}${_need.budget.currency ? " " + _need.budget.currency : ""})` : " (budget non défini)"}\n\nAnnonces:\n${JSON.stringify(input, null, 1)}`,
    maxTokens: 3000,
    timeoutMs: 90_000,
    signal,
  });
  return data.scores.map((s) => ({
    idx: s.idx,
    score: s.score,
    criteres: (s.criteres ?? []).map((c) => ({ nom: c.nom, valeur: c.valeur ?? null, extrait: c.extrait ?? null })),
  }));
};

/** Attente bornée interrompue immédiatement par l'annulation globale. */
/** Accessibilité du classement principal — paramètres de la vérification. */
interface AccessibilityParams {
  /** Borné au top N du classement principal. */
  limit: number;
  /** false = vérification interdite (mode simulé) : aucun réseau réel. */
  allowed: boolean;
  transport?: TransportDeps;
  signal?: AbortSignal;
  log: (s: string) => void;
}

const toCheckAllowed = (simulatedMode: boolean, transport?: TransportDeps): boolean =>
  !simulatedMode || transport !== undefined;

/** Vérifie l'accessibilité du classement principal et exclut les 404
 *  confirmées. L'identité de l'annonce est COMPLÈTE (référence d'objet,
 *  jamais l'id seul : deux sources peuvent partager un id avec des URLs
 *  distinctes). Retourne la liste conservée et transmet via onResult le
 *  nombre d'exclusions 404 et d'indéterminés (403/timeout/réseau). */
async function checkAccessibility(
  finalListings: ScoredListing[],
  params: AccessibilityParams,
  onResult: (removed: { listing: RawListing; status: number }[], indeterminate: number) => void,
): Promise<ScoredListing[]> {
  const toCheck = finalListings
    .slice(0, params.limit)
    .map((f) => f.evaluated.listing)
    .filter((l): l is RawListing & { url: string } => typeof l.url === "string" && l.url.length > 0);
  if (toCheck.length === 0 || params.signal?.aborted || !params.allowed) {
    if (toCheck.length > 0 && !params.allowed) {
      params.log("   (vérification d'accessibilité désactivée : mode simulé — aucun réseau réel)");
    }
    return finalListings;
  }
  params.log(`\n🩺 Accessibilité des annonces (top ${toCheck.length} du classement, 3 téléchargements max)…`);
  const removedListings: { listing: RawListing; status: number }[] = [];
  let indeterminate = 0;
  await Promise.all(
    toCheck.map((l) =>
      withDownloadSlot(async () => {
        if (params.signal?.aborted) return;
        try {
          await safeFetch(l.url, {
            headers: { "Accept-Language": "fr-FR,fr;q=0.9" },
            signal: params.signal
              ? AbortSignal.any([params.signal, AbortSignal.timeout(10_000)])
              : AbortSignal.timeout(10_000),
            ...(params.transport ? { deps: params.transport } : {}),
          });
          // page accessible — le contenu (vendu/retiré) n'est PAS déduit
        } catch (e) {
          if (e instanceof SafeFetchError && e.kind === "http" && e.status === 404) {
            removedListings.push({ listing: l, status: 404 });
          } else {
            // 403/429/timeout/réseau : indéterminé — JAMAIS « vendu »
            indeterminate++;
          }
        }
      }),
    ),
  );
  onResult(removedListings, indeterminate);
  if (removedListings.length > 0) {
    params.log(
      `   ✗ ${removedListings.length} annonce(s) retirée(s) (404 confirmé) — exclue(s) du classement · ${indeterminate} indéterminée(s) (conservée(s))`,
    );
    for (const r of removedListings.slice(0, 3)) {
      params.log(`   ✗ ${r.listing.title.slice(0, 42)} — 404`);
    }
  } else {
    params.log(`   ✔ toutes accessibles · ${indeterminate} indéterminée(s)`);
  }
  // exclusion par IDENTITÉ COMPLÈTE (référence d'objet) — jamais l'id seul :
  // deux sources peuvent partager le même id avec des URLs distinctes
  const removedObjects = new Set(removedListings.map((r) => r.listing));
  return finalListings.filter((f) => !removedObjects.has(f.evaluated.listing));
}

const sleepAbortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export async function runSearch(opts: RunSearchOptions): Promise<RunSearchResult> {
  // anonymisé EN AMONT : aucun téléphone/e-mail ne peut atteindre la console,
  // le parseur, la requête site ou les artefacts (revue P1)
  const needText = anonymiserBesoin(opts.needText);
  const need = parseNeed(needText);
  // champs structurés du formulaire public : valeur explicite > texte ;
  // champ vide = valeur extraite ; jamais de budget par défaut
  if (opts.structured) {
    const merged = mergeNeedFields(
      { budgetFcfa: opts.structured.budgetFcfa ?? null, location: opts.structured.location ?? null },
      {
        budget: need.budget
          ? { amount: need.budget.amount, currency: need.budget.currency ?? "FCFA" }
          : null,
        zone: need.zone,
      },
    );
    // le formulaire n'impose que des FCFA : normalisés « XOF » comme le texte
    if (typeof opts.structured.budgetFcfa === "number" && merged.budget) {
      need.budget = { amount: merged.budget.amount, currency: "XOF", explicitCurrency: true };
    }
    if (
      typeof opts.structured.location === "string" &&
      opts.structured.location.trim().length > 0 &&
      merged.zone
    ) {
      // normalisation identique à l'extraction (zones comparées en minuscules)
      need.zone = merged.zone.toLowerCase();
    }
    if (opts.structured.mode === "service") need.kind = "service";
    else if (opts.structured.mode === "achat") need.kind = "produit";
  }
  const t0 = Date.now();
  const useAlternatives = opts.alternatives ?? false;

  const ctx: RunCtx = {
    log: opts.log ?? (() => {}),
    entries: [],
    maxCostUsd: opts.maxCostUsd,
    // `ai: null` désactive TOUS les chemins IA (llmJson est la porte unique)
    aiEnabled: opts.ai !== null,
    // preuves navigateur écrites seulement ici (dossier par run, par source)
    artifactsDir: opts.artifactsDir,
    cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
  };

  return runWithCtx(ctx, async (): Promise<RunSearchResult> => {
    logLine(`📋 Besoin : « ${needText} »`);
    logLine(
      `   parsé : type=${need.kind} · produit « ${need.product} » · modèle ${need.model ?? "—"} · capacité ${need.capacity ? `${need.capacity.value} ${need.capacity.unit}` : "—"} · budget ${need.budget ? `${need.budget.amount}${need.budget.currency ? " " + need.budget.currency : " (devise non précisée)"}` : "non défini"} · zone ${need.zone ?? "—"}\n`,
    );

    // L'IA enrichit la formulation, mais les contraintes déterministes
    // (modèle, unités, budget, zone) restent l'autorité. `ai:null` coupe aussi
    // cette étape. Une ambiguïté structurante arrête le run avant les sources.
    const understander =
      opts.understander === null || (opts.understander === undefined && opts.ai === null)
        ? async () => fallbackUnderstanding(need, opts.clarificationAnswer)
        : (opts.understander ?? makeNeedUnderstander());
    const understanding = await understander(need, opts.signal, opts.clarificationAnswer);
    applyUnderstanding(need, understanding);
    opts.onUnderstanding?.(understanding);

    if (understanding.clarification) {
      const cost = totalCost(ctx.entries);
      const tokens = tokenTotals(ctx.entries);
      const emptySummary = summarizeSources([]);
      const stats: RunSearchResult["stats"] = {
        offresBrutes: 0,
        apresDedup: 0,
        fusionsCertaines: 0,
        groupesDoublonsPossibles: 0,
        candidates: 0,
        alternativesHorsBudget: 0,
        alternativesScorees: 0,
        rejetsIncompatibilite: 0,
        annoncesInaccessiblesExclues: 0,
        accessibiliteIndeterminee: 0,
        appelsIA: aiCallCount(ctx.entries),
        lotsScoring: 0,
        tokens,
        cout: { total: cost.total, known: cost.known },
        couvertureScoring: "0/0",
        cache: { ...ctx.cache },
        cacheEtat: "froid",
        premierResultatMs: 0,
        dureeSourcesMs: 0,
        dureeTotaleMs: Date.now() - t0,
        syntheseSources: emptySummary,
        bilanSources: [],
        parSource: [],
      };
      return {
        need,
        needText,
        understanding,
        clarification: understanding.clarification,
        sources: [],
        serpListings: [],
        brutes: [],
        dedup: { kept: [], mergedFrom: {}, possibleDuplicates: [], exactDuplicates: 0 },
        classification: { candidates: [], alternatives: [], rejected: [] },
        ranked: { candidates: [], alternatives: [], invalid: [], scoredCount: 0, total: 0, model: "" },
        finalListings: [],
        artifactsDir: opts.artifactsDir,
        stats,
      };
    }

    // ── Connecteurs en parallèle (2 navigateurs max, 3 téléchargements max) ──
    logLine("🔍 Connecteurs (concurrence : 2 navigateurs / 3 téléchargements)…");
    const runners: Runner[] = opts.runners ?? [
      { name: "facebook", browser: true, run: (signal) => fetchFacebook(need, signal) },
      { name: "coinafrique", browser: false, run: (signal) => fetchCoinAfrique(need, signal) },
      { name: "locanto", browser: true, run: (signal) => fetchLocanto(need, signal) },
      { name: "google", browser: false, run: (signal) => runGoogleSearch(need, signal) },
    ];

    const writeArtifacts = opts.artifactsDir !== undefined;
    if (writeArtifacts) mkdirSync(opts.artifactsDir!, { recursive: true });

    // ── Émission progressive (Lot 3) : instantané complet à chaque arrivée ──
    // MÊMES fonctions que le pipeline final (dedupListings + classify +
    // scoreListings sans IA) : aucun second moteur de classement. Le scoring
    // IA reste dans rankAndSplit, en fin de run. Après annulation, plus
    // aucune publication ; les instantanés déjà émis ne sont pas retirés.
    const progressListings: RawListing[] = [];
    const emitProgress = (arrivedFrom: string): void => {
      if (!opts.onProgress || opts.signal?.aborted) return;
      const { kept } = dedupListings(progressListings);
      const { candidates, alternatives, rejected } = classify(kept, need);
      const pool = [...candidates, ...(useAlternatives ? alternatives : [])];
      const offers = scoreListings(need, pool, null).sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0),
      );
      opts.onProgress({
        arrivedFrom,
        offers,
        counts: {
          brutes: progressListings.length,
          apresDedup: kept.length,
          candidates: candidates.length,
          alternatives: alternatives.length,
          rejets: rejected.length,
        },
      });
    };

    const { results: sources, firstResultMs, totalMs: sourcesMs } = await runSources(runners, {
      signal: opts.signal,
      onResult: (r) => {
        if (writeArtifacts) {
          // émission progressive : les annonces disponibles dès une source
          // sont consignées immédiatement, sans attendre les sources lentes
          writeFileSync(
            `${opts.artifactsDir}/partiel-${r.source}.json`,
            JSON.stringify({ source: r.source, status: r.status, annonces: r.listings }, null, 2),
          );
        }
        if (r.listings.length > 0) {
          progressListings.push(...r.listings);
          emitProgress(r.source);
        }
      },
    });

    for (const s of sources) {
      if (s.warnings.length) {
        for (const w of s.warnings) logLine(`   ⚠ ${s.source} : ${w}`);
      }
    }

    // ── SERP publics : uniquement en secours si Google n'a rien donné ───────
    const googleRes = sources.find((s) => s.source === "google");
    const serpListings: RawListing[] = [];
    if (googleRes && googleRes.listings.length === 0 && !opts.signal?.aborted) {
      logLine("\n🪂 SERP publics (secours, téléchargements sécurisés et bornés)…");
      for (const q of serpQueries(need)) {
        if (opts.signal?.aborted) break;
        const links = await serpLinks(q, 6, opts.signal);
        const targets = links.filter((l) => looksLikeListing(l.url)).slice(0, 3);
        logLine(`   « ${q} » → ${links.length} résultats · ${targets.length} cibles`);
        for (const target of targets) {
          if (opts.signal?.aborted) break;
          try {
            const res = await withDownloadSlot(() =>
              safeFetch(target.url, {
                headers: { "Accept-Language": "fr-FR,fr;q=0.9" },
                signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
              }),
            );
            const text = res.body
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .slice(0, 20000);
            const { data } = await llmJson(PageExtractionSchemaForSerp, {
              task: "serp-extraction",
              system:
                "Tu extrais une annonce du texte d'une page web. Si la page n'est pas une annonce de produit unique, mets isListing=false. Prix numériques uniquement, jamais inventés : champ inconnu = null.",
              user: `Page: ${target.url}\nTitre: ${target.title}\n\nTexte:\n${text}`,
              maxTokens: 1500,
              signal: opts.signal,
            });
            if (!data.isListing) continue;
            const serpListing = RawListingSchema.parse({
              id: `serp-${serpListings.length + 1}`,
              source: new URL(target.url).hostname,
              title: data.title ?? target.title,
              price: data.price,
              currency: data.currency ?? "FCFA",
              zone: data.zone,
              vendor: data.vendor,
              url: target.url,
              photo: null,
              date: data.date,
              description: data.description,
            });
            serpListings.push(serpListing);
            progressListings.push(serpListing);
            emitProgress(new URL(target.url).hostname);
          } catch (e) {
            logLine(`   ⚠ ${target.url.slice(0, 50)}: ${(e as Error).message.slice(0, 80)}`);
          }
        }
        if (serpListings.length >= 3) break;
        await sleepAbortable(1000, opts.signal);
      }
    }

    const synthese = summarizeSources(sources);
    logLine(
      `📊 Sources : ${synthese.ok} avec annonces · ${synthese.empty} vides (succès) · ${synthese.indisponibles} indisponibles → ${synthese.verdict}`,
    );
    for (const ligne of bilanSources(sources)) {
      logLine(`   · ${ligne}`);
    }

    // ── Déduplication par identité ──────────────────────────────────────────
    const all: RawListing[] = [
      ...sources.flatMap((s) => s.listings),
      ...serpListings,
    ];
    const { kept: deduped, mergedFrom, possibleDuplicates, exactDuplicates } = dedupListings(all);
    logLine(
      `\n📦 ${all.length} offres brutes → ${deduped.length} après dédup (−${exactDuplicates} fusion${exactDuplicates > 1 ? "s" : ""} certaine${exactDuplicates > 1 ? "s" : ""}) · ${possibleDuplicates.length} groupe${possibleDuplicates.length > 1 ? "s" : ""} de doublon${possibleDuplicates.length > 1 ? "s" : ""} possible${possibleDuplicates.length > 1 ? "s" : ""}`,
    );

    // ── Classification déterministe ─────────────────────────────────────────
    const { candidates: evCandidates, alternatives, rejected } = classify(deduped, need);
    logLine(
      `⚖ Classification : ${evCandidates.length} candidates · ${alternatives.length} hors budget (${useAlternatives ? "incluses" : "non incluses"}) · ${rejected.length} rejetées (incompatibilité avérée)`,
    );
    for (const r of rejected.slice(0, 3)) {
      logLine(`   ✗ ${r.listing.title.slice(0, 42)} — ${r.reason}`);
    }

    // ── Scoring IA via le pipeline (lots validés AVANT décalage) ────────────
    logLine(`\n🎯 Scoring IA sur ${evCandidates.length} candidates${useAlternatives ? ` + ${alternatives.length} hors budget` : ""} (lots de 10)…`);
    const ranked = await rankAndSplit(need, { candidates: evCandidates, alternatives, rejected }, {
      includeAlternatives: useAlternatives,
      batchSize: 10,
      ai: opts.ai === null ? undefined : (opts.ai ?? makeRealAi(opts.signal)),
      signal: opts.signal,
    });
    if (ranked.invalid.length > 0) {
      logLine(`   ⚠ ${ranked.invalid.length} réponse(s) IA invalidée(s) : ${ranked.invalid.slice(0, 2).join(" ; ")}`);
    }
    const evaluatedCount = ranked.scoredCount;
    logLine(
      `   ${evaluatedCount}/${ranked.total} évaluées par IA${evaluatedCount < ranked.total ? ` · ${ranked.total - evaluatedCount} « non évalué par IA » (score déterministe conservé)` : ""}`,
    );

    const finalListingsRaw = [...ranked.candidates, ...(useAlternatives ? ranked.alternatives : [])];

    // ── Annonces inaccessibles (essai réel 4A) : le classement PRINCIPAL ────
    // exclut les 404 confirmées (annonce retirée) ; 403/429/timeout/réseau =
    // indéterminé : l'annonce est CONSERVÉE, jamais assimilée à « vendue ».
    // Statut 200 = page accessible (le contenu n'est pas interprété).
    // Borné au top 10 (3 téléchargements max, annulation honorée).
    // P2 (essai réel) : en mode SIMULÉ (runners injectés), AUCUN réseau réel —
    // la vérification ne s'exécute qu'avec un transport injecté explicite.
    const CHECK_LIMIT = 10;
    const removedListings: { listing: RawListing; status: number }[] = [];
    let indeterminate = 0;
    const simulatedMode = opts.runners !== undefined;
    const checkAllowed =
      toCheckAllowed(simulatedMode, opts.itemCheckTransport);
    const finalListings = await checkAccessibility(
      finalListingsRaw,
      {
        limit: CHECK_LIMIT,
        allowed: checkAllowed,
        transport: opts.itemCheckTransport,
        signal: opts.signal,
        log: logLine,
      },
      (removed, indet) => {
        removedListings.push(...removed);
        indeterminate += indet;
      },
    );

    // ── Statistiques isolées du run (§8) ────────────────────────────────────
    const cost = totalCost(ctx.entries);
    const tokens = tokenTotals(ctx.entries);
    const stats: RunSearchResult["stats"] = {
      offresBrutes: all.length,
      apresDedup: deduped.length,
      fusionsCertaines: exactDuplicates,
      groupesDoublonsPossibles: possibleDuplicates.length,
      candidates: evCandidates.length,
      alternativesHorsBudget: alternatives.length,
      alternativesScorees: useAlternatives ? ranked.alternatives.length : 0,
      rejetsIncompatibilite: rejected.length,
      annoncesInaccessiblesExclues: removedListings.length,
      accessibiliteIndeterminee: indeterminate,
      appelsIA: aiCallCount(ctx.entries),
      lotsScoring: Math.ceil((evCandidates.length + (useAlternatives ? alternatives.length : 0)) / 10),
      tokens,
      cout: { total: cost.total, known: cost.known },
      couvertureScoring: `${ranked.scoredCount}/${ranked.total}`,
      cache: { ...ctx.cache },
      cacheEtat: ctx.cache.hits > 0 ? "chaud" : "froid",
      premierResultatMs: firstResultMs,
      dureeSourcesMs: sourcesMs,
      dureeTotaleMs: Date.now() - t0,
      syntheseSources: synthese,
      bilanSources: bilanSources(sources),
      parSource: sources.map((s) => ({
        source: s.source,
        status: s.status,
        annonces: s.listings.length,
        dureeMs: s.durationMs,
        erreurs: s.errors,
      })),
    };

    // ── Artefacts (optionnels : CLI uniquement — le backend décide) ─────────
    if (writeArtifacts) {
      const dir = opts.artifactsDir!;
      writeFileSync(`${dir}/annonces.json`, JSON.stringify(finalListings, null, 2));
      writeFileSync(`${dir}/hors-budget.json`, JSON.stringify(ranked.alternatives, null, 2));
      writeFileSync(`${dir}/brutes.json`, JSON.stringify(all, null, 2));
      writeFileSync(
        `${dir}/search-results.json`,
        JSON.stringify(
          {
            besoin: needText,
            besoinParse: need,
            ...stats,
            sources,
            top: finalListings.slice(0, 10),
            doublonsPossibles: possibleDuplicates,
            fusions: mergedFrom,
            rejets: rejected.map((r) => ({ title: r.listing.title, reason: r.reason })),
          },
          null,
          2,
        ),
      );
      writeFileSync(
        `${dir}/ledger.json`,
        JSON.stringify(
          { rows: ledgerRows(ctx.entries), parModele: ledgerByModel(ctx.entries), total: cost },
          null,
          2,
        ),
      );
      logLine(`\n→ ${dir}/ (annonces.json · search-results.json · ledger.json)`);
      logLine(`   canonicalUrl exemple : ${canonicalUrl(all[0]?.url ?? null)}`);
    }

    return {
      need,
      needText,
      understanding,
      clarification: null,
      sources,
      serpListings,
      brutes: all,
      dedup: { kept: deduped, mergedFrom, possibleDuplicates, exactDuplicates },
      classification: { candidates: evCandidates, alternatives, rejected },
      ranked,
      finalListings,
      artifactsDir: opts.artifactsDir,
      stats,
    };
  });
}
