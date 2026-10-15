import { create } from "zustand";

/**
 * État d'interface côté navigateur : le message de confirmation affiché à l'écran (`toast`, `showToast`). Rien n'est une donnée métier : tout le reste vient du serveur et de
 * PostgreSQL. Les anciennes données de maquette (alertes, échanges, commandes, propositions, dossiers, devis, rôle, besoin par défaut, sélection de comparaison) et `lib/data.ts`
 * ont été retirées : aucun écran ne les lisait. La sélection de comparaison est dans l'adresse de la page `/besoins/[id]/comparer`.
 */
interface NomaState {
  toast: string | null;
  showToast: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useNoma = create<NomaState>((set) => ({
  toast: null,
  showToast: (msg) => {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2400);
  },
}));
