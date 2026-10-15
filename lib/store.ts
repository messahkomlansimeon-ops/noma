import { create } from "zustand";

/**
 * État d'interface côté navigateur (rien n'est une donnée métier : tout le reste vient du serveur et de PostgreSQL) :
 *  - le message de confirmation affiché à l'écran (`toast`, `showToast`) ;
 *  - la sélection de comparaison (`compare`, `toggleCompare`, `clearCompare`), en attendant l'écran de comparaison (lot suivant).
 * Les anciennes données de maquette (alertes, échanges, commandes, propositions, dossiers, devis, rôle, besoin par défaut) et `lib/data.ts` ont été retirées : aucun écran ne les lisait.
 */
interface NomaState {
  compare: string[];
  toggleCompare: (id: string) => void;
  clearCompare: () => void;
  toast: string | null;
  showToast: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useNoma = create<NomaState>((set, get) => ({
  compare: ["o-iphone-145", "o-iphone-150"],
  toggleCompare: (id) =>
    set((s) => {
      if (s.compare.includes(id)) {
        return { compare: s.compare.filter((c) => c !== id) };
      }
      if (s.compare.length >= 2) {
        get().showToast("Comparez jusqu'à 2 offres");
        return {};
      }
      return { compare: [...s.compare, id] };
    }),
  clearCompare: () => set({ compare: [] }),
  toast: null,
  showToast: (msg) => {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2400);
  },
}));
