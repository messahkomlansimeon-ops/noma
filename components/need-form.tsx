"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui";
import { parseBudgetFcfa } from "@/lib/contracts";
import { useRealSearch } from "@/lib/real-search";

const modes = ["Acheter", "Louer", "Un service"];
// Location temporairement désactivée : achat et service seuls.
const DISABLED_MODES = new Set<string>(["Louer"]);

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
    <div>
      <div className="flex gap-2">
        {modes.map((m) => (
          <button
            key={m}
            disabled={DISABLED_MODES.has(m)}
            onClick={() =>
              setNeed({
                mode: m === "Un service" ? "service" : "achat",
              })
            }
            className={`rounded-full px-4 py-2 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              mode === m
                ? "bg-forest text-white"
                : "border border-line bg-white text-ink"
            }`}
          >
            {m}
            {m === "Louer" ? " (bientôt)" : ""}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-2xl border border-line bg-white p-4">
        <div className="text-[13px] font-bold text-ink">
          Que cherchez-vous ?
        </div>
        <textarea
          value={need.text}
          onChange={(e) => setNeed({ text: e.target.value })}
          rows={2}
          maxLength={1000}
          className="mt-2 w-full resize-none bg-transparent text-[15px] font-medium leading-relaxed text-ink placeholder:text-ink-soft/50"
          placeholder="Un iPhone 12 en bon état, à Abidjan…"
        />
        <div className="mt-2 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-line bg-cream/60 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-ink-soft">
              Localisation
              <span className="ml-1 font-normal">(facultatif)</span>
            </div>
            <Input
              value={need.location}
              onChange={(e) => setNeed({ location: e.target.value })}
              placeholder="Valeur du texte"
              className="mt-0.5 border-0 bg-transparent p-0 text-[14px] font-bold"
            />
          </div>
          <div className="rounded-xl border border-line bg-cream/60 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-ink-soft">
              Budget maximum
              <span className="ml-1 font-normal">(facultatif)</span>
            </div>
            <Input
              value={need.budgetFcfa}
              onChange={(e) => {
                setNeed({ budgetFcfa: e.target.value });
                setBudgetError(null);
              }}
              inputMode="numeric"
              placeholder="FCFA"
              className="mt-0.5 border-0 bg-transparent p-0 text-[14px] font-bold"
            />
          </div>
        </div>
        {budgetError ? (
          <div className="mt-2 text-[12px] font-semibold text-carrot-ink">
            {budgetError}
          </div>
        ) : null}
        {TURNSTILE_SITE_KEY ? (
          <div className="mt-3 flex justify-center">
            <div ref={widgetRef} />
          </div>
        ) : null}
      </div>

      <button
        onClick={search}
        disabled={need.text.trim().length === 0}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Trouver des offres
      </button>
      <div className="mt-2 text-center text-[12px] text-ink-soft">
        Première recherche sans compte. Champs vides = extraits de votre texte.
      </div>
    </div>
  );
}