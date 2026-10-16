"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Briefcase, MapPin, Search, ShoppingBag, TriangleAlert, Wallet, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui";
import { parseBudgetFcfa } from "@/lib/contracts";
import { useRealSearch } from "@/lib/real-search";

const modes = ["Acheter", "Un service"];
// Location temporairement désactivée : achat et service seuls.
const MODE_ICONS: Record<string, LucideIcon> = { Acheter: ShoppingBag, "Un service": Briefcase };

/** Clé publique Turnstile — absente = widget non rendu (dev local) ;
 *  présente = jeton requis avant chaque recherche. */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: {
          sitekey: string;
          action: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

export function NeedForm({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const need = useRealSearch((s) => s.need);
  const setNeed = useRealSearch((s) => s.setNeed);
  const startSearch = useRealSearch((s) => s.startSearch);

  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileFailed, setTurnstileFailed] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const mode = need.mode === "service" ? "Un service" : "Acheter";

  // widget Turnstile : rendu seulement quand la clé publique est configurée
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    const render = () => {
      if (!widgetRef.current || widgetRef.current.dataset.rendered) return;
      widgetRef.current.dataset.rendered = "1";
      widgetIdRef.current =
        window.turnstile?.render(widgetRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: "search",
          callback: (token) => {
            setTurnstileToken(token);
            setTurnstileFailed(false);
          },
          "expired-callback": () => setTurnstileToken(null),
          "error-callback": () => setTurnstileFailed(true),
        }) ?? null;
    };
    if (window.turnstile) {
      render();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = render;
    script.onerror = () => setTurnstileFailed(true);
    document.head.appendChild(script);
  }, []);

  const search = async () => {
    // budget : normalisé ou refus explicitement — jamais supprimé en silence
    if (need.budgetFcfa.trim().length > 0) {
      const parsed = parseBudgetFcfa(need.budgetFcfa);
      if (!parsed.ok) {
        setBudgetError(parsed.reason);
        return;
      }
    }
    setBudgetError(null);
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      // jeton absent (widget en cours ou échec) : la recherche ne part pas
      setBudgetError(
        turnstileFailed
          ? "Vérification anti-robot indisponible. Rechargez la page."
          : "Vérification anti-robot en cours…",
      );
      return;
    }
    onDone?.();
    router.push("/recherche");
    await startSearch(
      turnstileToken ? { turnstileToken } : undefined,
    );
    if (widgetIdRef.current) {
      window.turnstile?.reset(widgetIdRef.current);
      setTurnstileToken(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {modes.map((m) => {
          const ModeIcon = MODE_ICONS[m] ?? ShoppingBag;
          return (
            <button
              key={m}
              onClick={() =>
                setNeed({
                  mode: m === "Un service" ? "service" : "achat",
                })
              }
              className={`press inline-flex min-h-11 items-center gap-2 rounded-full border-2 px-4 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                mode === m
                  ? "border-transparent bg-brand text-white"
                  : "border-line-strong bg-white text-ink hover:border-brand"
              }`}
            >
              <ModeIcon className="size-4" aria-hidden />
              {m}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 rounded-3xl border border-line bg-white p-4">
        <label htmlFor="need-text" className="flex items-center gap-2 text-[15px] font-bold text-ink">
          <Search className="size-5 text-brand" aria-hidden />
          Que cherchez-vous ?
        </label>
        <textarea
          id="need-text"
          value={need.text}
          onChange={(e) => setNeed({ text: e.target.value })}
          rows={2}
          maxLength={1000}
          className="w-full resize-none rounded-2xl border-2 border-line bg-white px-4 py-3 text-[16px] font-medium leading-relaxed text-ink placeholder:text-ink-soft/60 hover:border-line-strong"
          placeholder="Un iPhone 12 en bon état, à Abidjan…"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="need-location" className="mb-1.5 flex items-center gap-1.5 text-[14px] font-bold text-ink">
              <MapPin className="size-4 text-ink-soft" aria-hidden />
              Localisation
            </label>
            <Input
              id="need-location"
              value={need.location}
              onChange={(e) => setNeed({ location: e.target.value })}
              placeholder="Ex. Cocody"
            />
          </div>
          <div>
            <label htmlFor="need-budget" className="mb-1.5 flex items-center gap-1.5 text-[14px] font-bold text-ink">
              <Wallet className="size-4 text-ink-soft" aria-hidden />
              Budget maximum
            </label>
            <Input
              id="need-budget"
              value={need.budgetFcfa}
              onChange={(e) => {
                setNeed({ budgetFcfa: e.target.value });
                setBudgetError(null);
              }}
              inputMode="numeric"
              placeholder="FCFA"
            />
          </div>
        </div>
        {budgetError ? (
          <div role="alert" className="flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-2.5 text-[14px] font-semibold text-accent-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {budgetError}
          </div>
        ) : null}
        {TURNSTILE_SITE_KEY ? (
          <div className="flex justify-center">
            <div ref={widgetRef} />
          </div>
        ) : null}
      </div>

      <button
        onClick={search}
        disabled={need.text.trim().length === 0}
        className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white shadow-md shadow-brand/30 hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Search className="size-5" aria-hidden />
        Trouver des offres
      </button>
    </div>
  );
}
