/**
 * Flux de recherche (Lot 5) — adaptateur entre le moteur PoC et l'API
 * NDJSON. SERVEUR UNIQUEMENT (marqué server-only) : le moteur n'est jamais
 * importé par le bundle navigateur. Budget IA imposé côté serveur, journal
 * filtré, aucun artefact ; publication annulée après coupure ; réserve
 * réconciliée dans tous les cas (finally).
 */
import "server-only";
import { appendFileSync } from "node:fs";
import {
  runSearch as engineRunSearch,
  type RunSearchOptions,
  type RunSearchResult,
} from "../../poc/lib/engine";
import type { Runner } from "../../poc/lib/orchestrate";
import type { NeedClarification, NeedUnderstanding } from "../../poc/lib/understanding";
import { toPublicOffer } from "./offer-mapping";
import type { PublicUnderstanding, SearchEvent, SourceEventStatus } from "../contracts";

export interface SearchStreamParams {
  searchId: string;
  needText: string;
  clarificationAnswer?: string;
  alternatives: boolean;
  /** false = recherche SANS IA (aucun appel, aucun centime). */
  aiEnabled: boolean;
  /** Plafond IA de CE run, imposé côté serveur (= réserve prévisionnelle). */
  maxCostUsd?: number;
  /** Champs structurés du formulaire (fusion contrat dans le moteur). */
  structured?: { budgetFcfa?: number | null; location?: string | null; mode?: "achat" | "service" };
  /** Signal d'arrêt combiné : déconnexion client + échéance globale. */
  signal: AbortSignal;
  /** Connecteurs injectables (sources simulées pour la validation locale). */
  runners?: Runner[];
  /** Moteur injectable (tests). */
  runSearch?: typeof engineRunSearch;
  /** Produit un jeton lié à la question, sans exposer le secret au client. */
  makeContinuationToken?: (clarification: NeedClarification) => string;
  /** Clôture des compteurs/réservations — appelé dans TOUS les cas. */
  onComplete: (reconciliation: { totalCostKnown: boolean; costMicros: number }) => void;
}

export interface SearchStreamHandle {
  stream: ReadableStream<Uint8Array>;
}

const SOURCE_STATUS: Set<SourceEventStatus> = new Set(["ok", "empty", "blocked", "timeout", "error"]);

const toPublicUnderstanding = (value: NeedUnderstanding): PublicUnderstanding => ({
  product: value.canonicalProduct,
  category: value.category,
  requirements: value.requirements.map((item) => `${item.label} : ${item.value}`),
  preferences: value.preferences.map((item) => `${item.label} : ${item.value}`),
  exclusions: value.exclusions.map((item) => `${item.label} : ${item.value}`),
  confidence: value.confidence,
  source: value.source,
});

/** Tap DIAGNOSTIQUE des événements (capture fiable côté serveur — l'instrument
 *  navigateur peut rejeter la lecture d'un flux long-lived) : NOMA_DEBUG_EVENT_LOG
 *  = chemin d'un fichier où CHAQUE événement émis est ajouté (aucun secret :
 *  offres publiques, quota, budget). Inactif si la variable est absente. */
const debugEventLog = (): string => process.env.NOMA_DEBUG_EVENT_LOG ?? "";

/** Construit la réponse NDJSON : started → (source?) results* → completed,
 *  ou error public structuré (aucune trace technique). Aucune republication
 *  après annulation ; les résultats déjà envoyés ne sont pas retirés. */
export function buildSearchStream(params: SearchStreamParams): SearchStreamHandle {
  const run = params.runSearch ?? engineRunSearch;
  const encoder = new TextEncoder();
  let closed = false;
  const cancelled = (): boolean => closed || params.signal.aborted;
  const tapPath = debugEventLog();
  /** Événements RÉELLEMENT ÉMIS au client (jamais les supprimés) + raison
   *  de fin distinguée : fin normale (completed), erreur publique, ou
   *  annulation sans publication. HTTP 200 + réconciliation ne prouvent
   *  PAS une fin normale du flux — seul ce journal le montre. */
  const emitted: string[] = [];
  let publishedCompleted = false;
  let publishedError = false;
  let publishedClarification = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: SearchEvent): void => {
        if (cancelled()) return; // jamais de publication après annulation
        const line = JSON.stringify(event);
        emitted.push(line); // journalisé APRÈS le contrôle : émis = publié
        if (event.type === "completed") publishedCompleted = true;
        if (event.type === "error") publishedError = true;
        if (event.type === "clarification") publishedClarification = true;
        controller.enqueue(encoder.encode(`${line}\n`));
      };
      let reconciliation: { totalCostKnown: boolean; costMicros: number } = {
        totalCostKnown: false,
        costMicros: 0,
      };
      try {
        emit({ type: "started", searchId: params.searchId, aiEnabled: params.aiEnabled });

        const opts: RunSearchOptions = {
          needText: params.needText,
          clarificationAnswer: params.clarificationAnswer,
          alternatives: params.alternatives,
          // ai:null = tous les chemins IA muets ; sinon IA réelle (OpenRouter)
          ai: params.aiEnabled ? undefined : null,
          maxCostUsd: params.aiEnabled ? params.maxCostUsd : undefined,
          structured: params.structured,
          log: () => {}, // journal filtré : rien vers le client, rien de brut
          signal: params.signal,
          onProgress: (snapshot) => {
            emit({
              type: "results",
              offers: snapshot.offers.map(toPublicOffer),
            });
          },
          onUnderstanding: (understanding) => {
            emit({ type: "understanding", understanding: toPublicUnderstanding(understanding) });
          },
          ...(params.runners ? { runners: params.runners } : {}),
        };
        const result: RunSearchResult = await run(opts);

        reconciliation = {
          totalCostKnown: result.stats.cout.known,
          costMicros: Math.round((result.stats.cout.total ?? 0) * 1_000_000),
        };

        if (result.clarification) {
          if (!params.makeContinuationToken) {
            throw new Error("continuation signer unavailable");
          }
          emit({
            type: "clarification",
            clarification: {
              ...result.clarification,
              continuationToken: params.makeContinuationToken(result.clarification),
            },
          });
          return;
        }

        // résultats FINAUX (scoring IA du pipeline existant) remplacent l'instantané
        emit({ type: "results", offers: result.finalListings.map(toPublicOffer) });
        emit({
          type: "completed",
          offersCount: result.finalListings.length,
          sources: result.sources.map((s) => ({
            source: s.source,
            status: SOURCE_STATUS.has(s.status) ? s.status : ("error" as SourceEventStatus),
          })),
          // preuve serveur du retrait d'annonces inaccessibles : transmis
          // SEULEMENT quand des exclusions ont eu lieu (sinon absent = le
          // client ne peut pas déduire la cause d'une liste vide)
          ...(result.stats.annoncesInaccessiblesExclues > 0
            ? {
                retired: {
                  count: result.stats.annoncesInaccessiblesExclues,
                  indeterminate: result.stats.accessibiliteIndeterminee,
                },
              }
            : {}),
        });
      } catch {
        emit({
          type: "error",
          code: "search_failed",
          message: "La recherche n'a pas pu aboutir. Réessayez dans un instant.",
        });
        // coût inconnu → réserve conservée (arrêt conservateur)
        reconciliation = { totalCostKnown: false, costMicros: 0 };
      } finally {
        closed = true;
        if (tapPath) {
          try {
            // marqueur terminal : le journal distingue la fin RÉELLEMENT
            // publiée d'une annulation (jamais une fin non publiée)
            const reason = publishedCompleted
              ? "completed"
              : publishedClarification
                ? "clarification"
              : publishedError
                ? "error"
                : "annulé-sans-publication";
            emitted.push(JSON.stringify({
              tap: "end",
              reason,
              eventsPublished: emitted.length,
              moteurTerminé: true,
              signalAborted: params.signal.aborted,
            }));
            appendFileSync(tapPath, emitted.join("\n") + "\n");
          } catch {
            /* journal diagnostic indisponible : jamais bloquant */
          }
        }
        params.onComplete(reconciliation);
        try {
          controller.close();
        } catch {
          /* flux déjà fermé par le client */
        }
      }
    },
    cancel() {
      closed = true; // déconnexion : plus aucune écriture ; l'arrêt du moteur
      // et la clôture des réservations sont portés par le signal combiné
    },
  });

  return { stream };
}
