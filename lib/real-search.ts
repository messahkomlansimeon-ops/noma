/**
 * Store de la recherche RÉELLE (Lot 6) — consomme le flux NDJSON de
 * /api/search via fetch : attente, résultats partiels, fin, annulation,
 * erreur, absence d'offres, sources indisponibles. Les résultats restent
 * 30 minutes en sessionStorage ; AUCUN lancement automatique après
 * rechargement (hydratation sans relance). Les événements d'une recherche
 * annulée/remplacée sont ignorés (jeton de run).
 */
import { create } from "zustand";
import {
  parseBudgetFcfa,
  parseSearchEvent,
  type PublicClarification,
  type PublicOffer,
  type PublicUnderstanding,
  type SourceEventStatus,
} from "./contracts";
import { useNoma } from "./store";

const STORAGE_KEY = "noma-real-search";
const TTL_MS = 30 * 60 * 1000;

export type RealSearchStatus = "idle" | "loading" | "clarification" | "done" | "error" | "cancelled";

export interface NeedInput {
  text: string;
  mode: "achat" | "service";
  location: string;
  budgetFcfa: string;
}

interface StoredSearch {
  offers: PublicOffer[];
  need: NeedInput;
  sources: { source: string; status: SourceEventStatus }[];
  aiEnabled: boolean | null;
  /** Retrait attesté par le serveur (completed.retired.count) : l'état vide
   *  restauré reste explicite. */
  offersRetired?: number;
  understanding?: PublicUnderstanding | null;
  savedAt: number;
}

interface RealSearchState {
  need: NeedInput;
  setNeed: (patch: Partial<NeedInput>) => void;
  offers: PublicOffer[];
  status: RealSearchStatus;
  error: string | null;
  aiEnabled: boolean | null;
  sources: { source: string; status: SourceEventStatus }[];
  /** Nombre d'annonces retirées (inaccessibles) attesté PAR LE SERVEUR
   *  (événement completed.retired). 0 = cause non établie → message neutre :
   *  une liste devenue vide ne suffit pas à identifier la cause. */
  offersRetired: number;
  understanding: PublicUnderstanding | null;
  clarification: PublicClarification | null;
  /** Texte original lié au jeton signé ; jamais remplacé par le libellé du
   *  choix, afin qu'un nouvel essai conserve budget et zone. */
  clarificationRequestText: string | null;
  hydrated: boolean;
  /** Lance la recherche (annule la précédente ; ses événements tardifs sont
   *  ignorés). Budget/location vides = extraits du texte côté serveur ;
   *  budget non reconnaissable = refus explicite, jamais supprimé en
   *  silence. `turnstileToken` transmis quand la protection est configurée. */
  startSearch: (opts?: {
    turnstileToken?: string;
    continuationToken?: string;
    clarification?: { id: string; answer: string };
    requestText?: string;
  }) => Promise<void>;
  /** Répond à la question en un clic, sans nouveau défi anti-robot. */
  answerClarification: (answer: string) => Promise<void>;
  /** Annule la recherche en cours ; les résultats déjà reçus sont conservés. */
  cancelSearch: () => void;
  /** Restaure les résultats < 30 min du sessionStorage — sans relance. */
  hydrate: () => void;
  reset: () => void;
}

let controller: AbortController | null = null;
let runToken = 0;

const save = (state: Pick<RealSearchState, "offers" | "need" | "sources" | "aiEnabled" | "offersRetired" | "understanding">) => {
  try {
    const payload: StoredSearch = {
      offers: state.offers,
      need: state.need,
      sources: state.sources,
      aiEnabled: state.aiEnabled,
      ...(state.offersRetired > 0 ? { offersRetired: state.offersRetired } : {}),
      understanding: state.understanding,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* sessionStorage indisponible (navigation privée) : résultats non persistés */
  }
};

const readStored = (): StoredSearch | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSearch;
    if (!Array.isArray(parsed.offers) || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > TTL_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const useRealSearch = create<RealSearchState>((set, get) => ({
  need: { text: "", mode: "achat", location: "", budgetFcfa: "" },
  setNeed: (patch) => set((s) => ({ need: { ...s.need, ...patch } })),
  offers: [],
  status: "idle",
  error: null,
  aiEnabled: null,
  sources: [],
  offersRetired: 0,
  understanding: null,
  clarification: null,
  clarificationRequestText: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const stored = readStored();
    if (stored) {
      // au rechargement, le store réintroduit les 2 ids de démonstration de
      // sa seed : ils bloqueraient la sélection réelle (compare.length >= 2).
      // Les offres réelles restaurées ne se mélangent JAMAIS à la démo.
      useNoma.getState().clearCompare();
    }
    set({
      hydrated: true,
      ...(stored
        ? {
            offers: stored.offers,
            need: stored.need,
            sources: stored.sources,
            aiEnabled: stored.aiEnabled,
            offersRetired: stored.offersRetired ?? 0,
            understanding: stored.understanding ?? null,
            status: "done" as const,
          }
        : {}),
    });
  },

  startSearch: async (opts) => {
    const state = get();
    const { need } = state;
    const pendingClarification = opts?.clarification ? state.clarification : null;
    const requestText = (
      opts?.requestText ??
      (opts?.clarification ? state.clarificationRequestText : null) ??
      need.text
    ).trim();
    if (requestText.length === 0) {
      set({ status: "error", error: "Décrivez ce que vous cherchez." });
      return;
    }
    // budget facultatif : vide = valeur extraite du texte ; saisi mais non
    // reconnaissable = refus explicite (jamais de plafond silencieusement perdu)
    const budgetTrim = need.budgetFcfa.trim();
    let budgetNumber: number | null = null;
    if (budgetTrim.length > 0) {
      const parsed = parseBudgetFcfa(budgetTrim);
      if (!parsed.ok) {
        set({ status: "error", error: parsed.reason });
        return;
      }
      budgetNumber = parsed.value;
    }
    // nouvelle recherche : la sélection de comparaison repart à zéro (les ids
    // de l'écran de démonstration ne doivent jamais se mélanger aux réelles)
    useNoma.getState().clearCompare();
    // annule la recherche précédente : plus aucun de ses événements ne sera lu
    controller?.abort();
    runToken += 1;
    const token = runToken;
    const localController = new AbortController();
    controller = localController;
    set({
      offers: [],
      sources: [],
      status: "loading",
      error: null,
      aiEnabled: null,
      offersRetired: 0,
      understanding: null,
      clarification: pendingClarification,
      clarificationRequestText: opts?.clarification ? requestText : null,
      need: { ...need, text: requestText },
    });
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: requestText,
          mode: need.mode,
          location: need.location.trim() || null,
          budgetFcfa: budgetNumber,
          alternatives: false,
          ...(opts?.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
          ...(opts?.continuationToken ? { continuationToken: opts.continuationToken } : {}),
          ...(opts?.clarification ? { clarification: opts.clarification } : {}),
        }),
        signal: localController.signal,
      });
      if (!res.ok || !res.body) {
        let message = "La recherche n'a pas pu démarrer.";
        let retryAfter: string | null = null;
        try {
          const err = (await res.json()) as { error?: { code?: string; message?: string } };
          message = err.error?.message ?? message;
        } catch {
          /* corps non JSON */
        }
        retryAfter = res.headers.get("retry-after");
        if (token !== runToken) return; // remplacée entre-temps
        set({
          status: pendingClarification ? "clarification" : "error",
          clarification: pendingClarification,
          clarificationRequestText: pendingClarification ? requestText : null,
          error:
            retryAfter && res.status === 429
              ? `${message} Réessayez dans ${retryAfter} s.`
              : message,
        });
        return;
      }
      // lecture du flux NDJSON ligne par ligne
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (token !== runToken) {
          localController.abort(); // recherche remplacée : arrêt immédiat
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseSearchEvent(line);
          if (!event || token !== runToken) continue;
          if (event.type === "started") {
            set({ aiEnabled: event.aiEnabled });
          } else if (event.type === "understanding") {
            set({ understanding: event.understanding });
          } else if (event.type === "clarification") {
            set({
              status: "clarification",
              clarification: event.clarification,
              clarificationRequestText: requestText,
            });
          } else if (event.type === "results") {
            set({ offers: event.offers });
          } else if (event.type === "completed") {
            // retrait attesté UNIQUEMENT par le serveur (completed.retired) :
            // une liste devenue vide ne suffit pas à identifier la cause
            const retired = event.retired?.count ?? 0;
            set({
              sources: event.sources,
              status: "done",
              clarification: null,
              clarificationRequestText: null,
              ...(retired > 0 ? { offersRetired: retired } : {}),
            });
            save(get());
          } else if (event.type === "error") {
            set({
              status: pendingClarification ? "clarification" : "error",
              clarification: pendingClarification,
              clarificationRequestText: pendingClarification ? requestText : null,
              error: event.message,
            });
          }
        }
      }
      // flux clos sans completed ni error (coupure) : clôturer honnêtement
      if (token === runToken && get().status === "loading") {
        set({
          status: get().offers.length > 0 ? "done" : "error",
          error: get().offers.length > 0 ? null : "La recherche a été interrompue. Réessayez.",
        });
        save(get());
      }
    } catch (e) {
      if (token !== runToken) return; // annulée/remplacée : ignorer
      if ((e as Error).name === "AbortError") {
        set({ status: "cancelled" });
        return;
      }
      set({
        status: pendingClarification ? "clarification" : "error",
        clarification: pendingClarification,
        clarificationRequestText: pendingClarification ? requestText : null,
        error: "Réseau indisponible. Réessayez dans un instant.",
      });
    }
  },

  answerClarification: async (answer) => {
    const current = get().clarification;
    if (!current || !current.options.includes(answer)) return;
    await get().startSearch({
      continuationToken: current.continuationToken,
      clarification: { id: current.id, answer },
      requestText: get().clarificationRequestText ?? get().need.text,
    });
  },

  cancelSearch: () => {
    if (get().status !== "loading") return;
    controller?.abort();
    set({ status: "cancelled" }); // résultats partiels déjà affichés conservés
  },

  reset: () => {
    controller?.abort();
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    set({
      offers: [], status: "idle", error: null, sources: [], aiEnabled: null,
      offersRetired: 0, understanding: null, clarification: null,
      clarificationRequestText: null,
    });
  },
}));

/** Sources toutes indisponibles (bloquées/timeout/erreur) — pour l'état
 *  « sources indisponibles » distinct de « aucune offre ». */
export const sourcesAllUnavailable = (sources: { status: SourceEventStatus }[]): boolean =>
  sources.length > 0 &&
  sources.every((s) => s.status === "blocked" || s.status === "timeout" || s.status === "error");
