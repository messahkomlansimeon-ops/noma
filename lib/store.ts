import { create } from "zustand";
import {
  alertsSeed,
  casesSeed,
  ordersSeed,
  proposalsSeed,
  quoteSeed,
  threadsSeed,
  vendorOrdersSeed,
  NEED_DEFAULT,
  type AlertItem,
  type CaseItem,
  type Order,
  type Proposal,
  type QuoteLine,
  type Thread,
  type VendorOrder,
} from "./data";

export type Role = "buyer" | "vendor" | "admin";

interface NomaState {
  role: Role;
  setRole: (r: Role) => void;
  need: string;
  setNeed: (t: string) => void;
  favorites: string[];
  toggleFavorite: (id: string) => void;
  compare: string[];
  toggleCompare: (id: string) => void;
  clearCompare: () => void;
  alerts: AlertItem[];
  addAlert: (a: Omit<AlertItem, "id" | "news">) => void;
  threads: Thread[];
  sendMessage: (threadId: string, text: string) => void;
  acceptOffer: (threadId: string) => void;
  orders: Order[];
  proposals: Proposal[];
  cases: CaseItem[];
  addReport: (r: { motif: string; offer: string; detail: string }) => void;
  decide: (caseId: string, decision: string, motif: string) => void;
  vendorOrders: VendorOrder[];
  advanceVendorOrder: (id: string) => void;
  declarePayment: (id: string, paid: boolean) => void;
  quoteLines: QuoteLine[];
  addQuoteLine: () => void;
  removeQuoteLine: (index: number) => void;
  toast: string | null;
  showToast: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useNoma = create<NomaState>((set, get) => ({
  role: "buyer",
  setRole: (role) => set({ role }),
  need: NEED_DEFAULT,
  setNeed: (need) => set({ need }),
  favorites: ["o-iphone-145", "o-canape", "o-iphone-140"],
  toggleFavorite: (id) =>
    set((s) => ({
      favorites: s.favorites.includes(id)
        ? s.favorites.filter((f) => f !== id)
        : [...s.favorites, id],
    })),
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
  alerts: alertsSeed,
  addAlert: (a) =>
    set((s) => ({
      alerts: [
        {
          ...a,
          id: `a-${s.alerts.length + 1}`,
          news: 0,
        },
        ...s.alerts,
      ],
    })),
  threads: threadsSeed,
  sendMessage: (threadId, text) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              snippet: text,
              time: "Maintenant",
              messages: [
                ...t.messages,
                {
                  id: `m-${t.messages.length + 1}`,
                  from: "buyer" as const,
                  text,
                  time: "14:35",
                },
              ],
            }
          : t,
      ),
    })),
  acceptOffer: (threadId) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.offer ? { ...m, state: "accepted" as const } : m,
              ),
            }
          : t,
      ),
    })),
  orders: ordersSeed,
  proposals: proposalsSeed,
  cases: casesSeed,
  addReport: ({ motif, offer, detail }) =>
    set((s) => ({
      cases: [
        {
          id: `S-${s.cases.length + 105}`,
          motif,
          offer,
          meta: `1 signalement · Noma${detail ? " · " + detail : ""}`,
          time: "À l'instant",
          art: "box" as const,
          status: "open" as const,
        },
        ...s.cases,
      ],
    })),
  decide: (caseId, decision, motif) =>
    set((s) => ({
      cases: s.cases.map((c) =>
        c.id === caseId
          ? { ...c, status: "closed" as const, decision, motifDecision: motif }
          : c,
      ),
    })),
  vendorOrders: vendorOrdersSeed,
  advanceVendorOrder: (id) =>
    set((s) => ({
      vendorOrders: s.vendorOrders.map((o) =>
        o.id === id ? { ...o, step: Math.min((o.step ?? 0) + 1, 2) } : o,
      ),
    })),
  declarePayment: (id, paid) =>
    set((s) => ({
      vendorOrders: s.vendorOrders.map((o) =>
        o.id === id ? { ...o, payment: paid } : o,
      ),
    })),
  quoteLines: quoteSeed.lines,
  addQuoteLine: () =>
    set((s) => {
      get().showToast("Ligne ajoutée au devis");
      return {
        quoteLines: [
          ...s.quoteLines,
          { label: `Frais supplémentaires ${s.quoteLines.length - 2}`, amount: 1000 },
        ],
      };
    }),
  removeQuoteLine: (index) =>
    set((s) => ({ quoteLines: s.quoteLines.filter((_, i) => i !== index) })),
  toast: null,
  showToast: (msg) => {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2400);
  },
}));
