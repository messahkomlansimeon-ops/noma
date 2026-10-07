"use client";

import { notFound } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { ApiError } from "@/lib/client/api";
import { ADMIN_LOADING } from "@/lib/client/admin-view";
import { describeSocialError } from "@/lib/client/social-api";

type State<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "not-found" } | { kind: "error"; message: string };

/**
 * Un 404 reçu du serveur (le compte n'est plus administrateur, ou ne l'a jamais été sans que le gabarit l'ait vu) : la page 404 STANDARD de Next (`notFound()`, lot D3), sans titre
 * « Administration » ni aucune indication que l'espace existe. Composant à part : `notFound()` lève une exception que l'on peut vérifier sans navigateur.
 */
export function AdminNotFound(): never {
  notFound();
}

/**
 * Page d'administration (lots D2 et D3) : session exigée, puis lecture du serveur. Un compte qui n'est pas administrateur obtient la page 404 standard de Next : par le gabarit
 * `app/(admin)/layout.tsx` (avant tout affichage), ou ici si le serveur répond 404 (rôle retiré pendant la session). L'autorisation réelle est celle des routes `/api/admin/*`.
 */
function Content<T>({ title, back, load, children }: { title: string; back: string; load: (signal: AbortSignal) => Promise<T>; children: (data: T, reload: () => void) => ReactNode }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<State<T>>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => setState({ kind: "ready", data }),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        if (failure instanceof ApiError && failure.status === 404) setState({ kind: "not-found" });
        else setState({ kind: "error", message: describeSocialError(failure, "admin") });
      },
    );
    return () => controller.abort();
  }, [load, reloadKey, redirectIfUnauthorized]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return (
    <main>
      <TopBar back={back} title={title} />
      <div className="px-4 pb-6">
        {state.kind === "loading" ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {ADMIN_LOADING}
          </p>
        ) : state.kind === "not-found" ? (
          <AdminNotFound />
        ) : state.kind === "error" ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{state.message}</p>
            <button
              onClick={() => {
                setState({ kind: "loading" });
                reload();
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : (
          children(state.data, reload)
        )}
      </div>
    </main>
  );
}

export function AdminPage<T>(props: { title: string; back: string; load: (signal: AbortSignal) => Promise<T>; children: (data: T, reload: () => void) => ReactNode }) {
  return (
    <SessionGate>
      <Content {...props} />
    </SessionGate>
  );
}
