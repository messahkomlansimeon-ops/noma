"use client";

import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Switch } from "@/components/ui";
import { unreadRefresher } from "@/components/unread-badge";
import { api, describeApiError, isUnauthorized, type NotificationPreferences } from "@/lib/client/api";
import {
  PREFERENCES_HINT,
  PREFERENCES_LABEL,
  PREFERENCES_LOADING,
  PREFERENCES_TITLE,
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
      <p className="mt-4 text-center text-[13px] text-ink-soft" aria-busy="true">
        {PREFERENCES_LOADING}
      </p>
    );
  }
  if (state === "error" || !preferences) {
    return (
      <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-3.5 text-center">
        <p className="text-[13px] font-semibold text-ink">Vos préférences de notification sont indisponibles pour le moment.</p>
        <button
          onClick={() => {
            setState("loading");
            setReloadKey((key) => key + 1);
          }}
          className="mt-2 rounded-xl bg-forest px-4 py-2 text-[13px] font-bold text-white"
        >
          Réessayer
        </button>
      </div>
    );
  }

  const view = preferencesView(preferences);
  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      setPreferences(await api.notifications.setPreferences(next));
      showToast(next ? "Envoi par SMS (simulé) activé" : "Envoi par SMS (simulé) désactivé");
    } catch (failure) {
      showToast(describeApiError(failure, "notifications"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 rounded-2xl border border-line bg-white p-4" aria-label={PREFERENCES_TITLE} data-testid="notification-preferences">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sage text-forest">
          <MessageSquareText className="size-[18px]" strokeWidth={1.9} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-extrabold text-ink">{PREFERENCES_TITLE}</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span id="external-label" className="text-[13px] font-semibold text-ink">
              {PREFERENCES_LABEL}
            </span>
            <span className={saving ? "opacity-50" : ""}>
              <Switch checked={view.enabled} onChange={(next) => void toggle(next)} label={PREFERENCES_LABEL} />
            </span>
          </div>
          <p className="mt-2 text-[12px] text-ink-soft">{PREFERENCES_HINT}</p>
          <p className="mt-1.5 text-[12px] font-semibold text-carrot-ink" data-testid="external-notice">
            {view.notice}
          </p>
          {view.extra ? <p className="mt-1 text-[12px] text-ink-soft">{view.extra}</p> : null}
        </div>
      </div>
    </section>
  );
}
