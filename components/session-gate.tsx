"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, isUnauthorized } from "@/lib/client/api";
import { clearOtpFlow } from "@/lib/client/otp-flow";
import {
  INITIAL_GATE_STATE,
  loginHref,
  runSessionGate,
  type GateState,
} from "@/lib/client/session";
import { useNoma } from "@/lib/store";

/** Chemin courant avec sa requête : destination de retour après connexion (nettoyée par `loginHref`). */
function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Affichage de la garde, sans hook : rien d'autre que « vérification en cours » ou « indisponible » n'est montré
 * tant que la session n'est pas confirmée. Les enfants (donc leurs appels d'API) n'existent qu'à l'état « allowed ».
 */
export function SessionGateView({
  state,
  onRetry,
  children,
}: {
  state: GateState;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (state.kind === "allowed") return <>{children}</>;

  if (state.kind === "unavailable") {
    return (
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <p className="text-[14px] font-semibold text-ink">
          Le service est temporairement indisponible.
        </p>
        <button
          onClick={onRetry}
          className="rounded-xl bg-forest px-5 py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
        >
          Réessayer
        </button>
      </main>
    );
  }

  return (
    <main
      className="flex min-h-[60dvh] items-center justify-center px-6 text-center text-[14px] text-ink-soft"
      aria-busy="true"
    >
      Vérification de votre session…
    </main>
  );
}

/**
 * Garde de session des espaces vendeur et acheteur branchés sur l'API : lit GET /api/auth/session ; sans session,
 * redirige vers /connexion?next=<chemin interne>. C'est une commodité d'interface (l'autorisation réelle est
 * appliquée par chaque route de l'API).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>(INITIAL_GATE_STATE);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    runSessionGate({
      sessionOutcome: () => api.auth.sessionOutcome({ signal: controller.signal }),
      currentPath: currentLocation(),
      navigate: (to) => router.replace(to),
    }).then(
      (next) => {
        if (!controller.signal.aborted) setState(next);
      },
      () => {
        // Requête interrompue au démontage : rien à afficher.
      },
    );
    return () => controller.abort();
  }, [attempt, router]);

  const retry = useCallback(() => {
    setState(INITIAL_GATE_STATE);
    setAttempt((value) => value + 1);
  }, []);

  return (
    <SessionGateView state={state} onRetry={retry}>
      {children}
    </SessionGateView>
  );
}

/**
 * À appeler quand un appel d'API échoue : si c'est un 401 (session expirée ou absente), redirige vers la connexion
 * avec retour sur la page courante et renvoie `true` ; sinon renvoie `false` et l'erreur reste à afficher.
 */
export function useUnauthorizedRedirect(): (error: unknown) => boolean {
  const router = useRouter();
  return useCallback(
    (error: unknown) => {
      if (!isUnauthorized(error)) return false;
      router.replace(loginHref(currentLocation()));
      return true;
    },
    [router],
  );
}

/** Déconnexion réelle : POST /api/auth/logout, puis retour à la connexion. Échec : message fixe, session conservée. */
export function useLogout(): { logout: () => Promise<void>; pending: boolean } {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const [pending, setPending] = useState(false);

  const logout = useCallback(async () => {
    setPending(true);
    try {
      await api.auth.logout();
      clearOtpFlow();
      router.replace("/connexion");
    } catch {
      showToast("Déconnexion impossible pour le moment. Réessayez.");
    } finally {
      setPending(false);
    }
  }, [router, showToast]);

  return { logout, pending };
}
