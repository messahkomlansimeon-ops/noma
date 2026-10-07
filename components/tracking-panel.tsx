"use client";

import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, CalendarPlus } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { api, describeApiError, type DemandTracking, type TrackingAction } from "@/lib/client/api";
import {
  TRACKING_AT_MAXIMUM,
  TRACKING_EXTEND_LABEL,
  TRACKING_LOADING,
  TRACKING_NOTE,
  TRACKING_PAUSE_LABEL,
  TRACKING_RESUME_LABEL,
  TRACKING_TITLE,
  trackingActionDone,
  trackingView,
} from "@/lib/client/notifications-view";
import { useNoma } from "@/lib/store";

/**
 * Suivi d'un besoin actif (lot N1) : « Suivi actif jusqu'au … », Prolonger, Pause / Reprendre. Le matching continue pendant une pause ou après la fin du suivi :
 * seules les notifications s'arrêtent (la note le dit). Les textes viennent de `notifications-view.ts` (testé).
 */
export function TrackingPanel({ demandId }: { demandId: string }) {
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [tracking, setTracking] = useState<DemandTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TrackingAction | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.demands.tracking(demandId, { signal: controller.signal }).then(
      (loaded) => {
        setTracking(loaded);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeApiError(failure, "tracking"));
      },
    );
    return () => controller.abort();
  }, [demandId, reloadKey, redirectIfUnauthorized]);

  const run = useCallback(
    async (action: TrackingAction) => {
      if (busy) return;
      setBusy(action);
      try {
        setTracking(await api.demands.trackingAction(demandId, action));
        setError(null);
        showToast(trackingActionDone(action));
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        showToast(describeApiError(failure, "tracking"));
        setReloadKey((key) => key + 1);
      } finally {
        setBusy(null);
      }
    },
    [busy, demandId, redirectIfUnauthorized, showToast],
  );

  if (error) {
    return (
      <div role="alert" className="mt-3 rounded-2xl border border-line bg-white p-3.5 text-center">
        <p className="text-[13px] font-semibold text-ink">{error}</p>
        <button
          onClick={() => {
            setError(null);
            setReloadKey((key) => key + 1);
          }}
          className="mt-2 rounded-xl bg-forest px-4 py-2 text-[13px] font-bold text-white"
        >
          Réessayer
        </button>
      </div>
    );
  }
  if (!tracking) {
    return (
      <p className="mt-3 text-center text-[13px] text-ink-soft" aria-busy="true">
        {TRACKING_LOADING}
      </p>
    );
  }

  const view = trackingView(tracking);
  const Icon = view.tone === "active" ? BellRing : BellOff;
  return (
    <section className="mt-3 rounded-2xl border border-line bg-white p-3.5" aria-label={TRACKING_TITLE} data-testid="tracking-panel" data-tone={view.tone}>
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 size-5 shrink-0 ${view.tone === "active" ? "text-forest" : "text-ink-soft"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-extrabold text-ink" data-testid="tracking-headline">
            {view.headline}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-soft">{view.detail}</p>
        </div>
      </div>
      {view.applicable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.canExtend ? (
            <button
              onClick={() => void run("extend")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
            >
              <CalendarPlus className="size-3.5" aria-hidden />
              {busy === "extend" ? "…" : TRACKING_EXTEND_LABEL}
            </button>
          ) : null}
          {view.canPause ? (
            <button
              onClick={() => void run("pause")}
              disabled={busy !== null}
              className="rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
            >
              {busy === "pause" ? "…" : TRACKING_PAUSE_LABEL}
            </button>
          ) : null}
          {view.canResume ? (
            <button
              onClick={() => void run("resume")}
              disabled={busy !== null}
              className="rounded-full bg-forest px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
            >
              {busy === "resume" ? "…" : TRACKING_RESUME_LABEL}
            </button>
          ) : null}
          {view.atMaximum ? <span className="self-center text-[12px] text-ink-soft">{TRACKING_AT_MAXIMUM}</span> : null}
        </div>
      ) : null}
      <p className="mt-2.5 text-[11px] text-ink-soft">{TRACKING_NOTE}</p>
    </section>
  );
}
