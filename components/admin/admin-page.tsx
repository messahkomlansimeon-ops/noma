"use client";

import { notFound } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Btn, Skeleton } from "@/components/ui";
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
          <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
            <span className="sr-only">{ADMIN_LOADING}</span>
            <Skeleton className="h-14 w-full rounded-3xl md:col-span-2" />
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
          </div>
        ) : state.kind === "not-found" ? (
          <AdminNotFound />
        ) : state.kind === "error" ? (
          <div role="alert" className="animate-rise mt-4 flex flex-col items-center gap-4 px-2 py-8 text-center">
            <ArtAlert />
            <p className="text-[17px] font-bold leading-snug text-ink">{state.message}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setState({ kind: "loading" });
                  reload();
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
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
