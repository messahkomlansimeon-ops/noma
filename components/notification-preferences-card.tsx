"use client";

import { useEffect, useState } from "react";
import { MessageSquareText, RotateCw } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { Btn, IconTile, Skeleton, Switch } from "@/components/ui";
import { unreadRefresher } from "@/components/unread-badge";
import { api, describeApiError, isUnauthorized, type NotificationPreferences } from "@/lib/client/api";
import {
  PREFERENCES_HINT,
  PREFERENCES_LOADING,
  PREFERENCES_TITLE,
  preferencesLabel,
  preferencesToast,
  preferencesView,
} from "@/lib/client/notifications-view";
import { useNoma } from "@/lib/store";

/**
 * Préférences de notification de la page Compte (lot N1) : l'envoi externe SIMULÉ (désactivé par défaut) et le texte fixe « Les envois par SMS ne sont pas encore
 * disponibles : ils sont simulés en développement. ». Sans session (page Compte ouverte sans être connecté), la carte ne s'affiche pas.
 */
export function NotificationPreferencesCard() {
  const showToast = useNoma((s) => s.showToast);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.notifications.preferences({ signal: controller.signal }).then(
      (loaded) => {
        setPreferences(loaded);
        setState("ready");
        // La session est confirmée : le compteur de non-lues peut être relu (au plus une fois par minute).
        void unreadRefresher.refresh();
      },
      (failure) => {
        if (controller.signal.aborted) return;
        // Pas de session : la carte n'a rien à montrer (l'écran Compte reste utilisable).
        setState(isUnauthorized(failure) ? "hidden" : "error");
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  if (state === "hidden") return null;
  if (state === "loading") {
    return (
      <div className="mt-4" aria-busy="true">
        <span className="sr-only">{PREFERENCES_LOADING}</span>
        <Skeleton className="h-24 w-full rounded-3xl" />
      </div>
    );
  }
  if (state === "error" || !preferences) {
    return (
      <div role="alert" className="animate-rise mt-4 flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-4 text-center">
        <ArtAlert className="size-20" />
        <p className="text-[15px] font-bold text-ink">Vos préférences de notification sont indisponibles pour le moment.</p>
        <div className="w-full max-w-xs">
          <Btn
            onClick={() => {
              setState("loading");
              setReloadKey((key) => key + 1);
            }}
          >
            <RotateCw className="size-5" aria-hidden />
            Réessayer
          </Btn>
        </div>
      </div>
    );
  }

  const view = preferencesView(preferences);
  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await api.notifications.setPreferences(next);
      setPreferences(saved);
      showToast(preferencesToast(next, saved));
    } catch (failure) {
      showToast(describeApiError(failure, "notifications"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="animate-rise mt-4 rounded-3xl border border-line bg-white p-4" aria-label={PREFERENCES_TITLE} data-testid="notification-preferences">
      <div className="flex items-center gap-3">
        <IconTile icon={MessageSquareText} tone="brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-extrabold text-ink">{PREFERENCES_TITLE}</div>
          <span id="external-label" className="text-[14px] font-semibold text-ink-soft">
            {preferencesLabel(preferences)}
          </span>
        </div>
        <span className={saving ? "opacity-50" : ""}>
          <Switch checked={view.enabled} onChange={(next) => void toggle(next)} label={preferencesLabel(preferences)} />
        </span>
      </div>
      <p className="mt-3 text-[13px] text-ink-soft">{PREFERENCES_HINT}</p>
      <p className="mt-1.5 rounded-2xl bg-accent-soft px-3 py-2 text-[13px] font-semibold text-accent-ink" data-testid="external-notice">
        {view.notice}
      </p>
      {view.extra ? <p className="mt-1.5 text-[13px] text-ink-soft">{view.extra}</p> : null}
    </section>
  );
}
