"use client";

import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, CalendarPlus, Pause, Play, RotateCw } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert } from "@/components/illustrations";
import { Btn, IconTile, Skeleton } from "@/components/ui";
import { api, describeApiError, type DemandTracking, type TrackingAction } from "@/lib/client/api";
import {
  TRACKING_EXTEND_LABEL,
  TRACKING_LOADING,
  TRACKING_NOTE,
  TRACKING_PAUSE_LABEL,
  TRACKING_RESUME_LABEL,
  TRACKING_TITLE,
  trackingActionDone,
  trackingView,
} from "@/lib/client/notifications-view";
import { trackingMaximumText } from "@/lib/client/active-search-view";
import { useNoma } from "@/lib/store";

const PILL =
  "press inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-line-strong bg-white px-4 text-[14px] font-bold text-ink hover:border-brand disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Suivi d'un besoin actif (lot N1) : « Suivi actif jusqu'au … », Prolonger, Pause / Reprendre. Le matching continue pendant une pause ou après la fin du suivi :
 * seules les notifications s'arrêtent. Les textes viennent de `notifications-view.ts` (testé).
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
      <div role="alert" className="animate-rise mt-3 flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-4 text-center">
        <ArtAlert className="size-20" />
        <p className="text-[15px] font-bold text-ink">{error}</p>
        <div className="w-full max-w-xs">
          <Btn
            onClick={() => {
              setError(null);
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
  if (!tracking) {
    return (
      <div className="mt-3" aria-busy="true">
        <span className="sr-only">{TRACKING_LOADING}</span>
        <Skeleton className="h-20 w-full rounded-3xl" />
      </div>
    );
  }

  const view = trackingView(tracking);
  const Icon = view.tone === "active" ? BellRing : BellOff;
  return (
    <section className="animate-rise mt-3 rounded-3xl border border-line bg-white p-4" aria-label={TRACKING_TITLE} data-testid="tracking-panel" data-tone={view.tone}>
      <div className="flex items-center gap-3">
        <IconTile icon={Icon} tone={view.tone === "active" ? "brand" : "mist"} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-extrabold leading-snug text-ink" data-testid="tracking-headline">
            {view.headline}
          </div>
          {view.tone !== "active" ? <p className="mt-0.5 text-[14px] text-ink-soft">{view.detail}</p> : null}
        </div>
      </div>
      {view.applicable ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {view.canExtend ? (
            <button onClick={() => void run("extend")} disabled={busy !== null} className={PILL}>
              <CalendarPlus className="size-4" aria-hidden />
              {busy === "extend" ? "…" : TRACKING_EXTEND_LABEL}
            </button>
          ) : null}
          {view.canPause ? (
            <button onClick={() => void run("pause")} disabled={busy !== null} className={PILL}>
              <Pause className="size-4" aria-hidden />
              {busy === "pause" ? "…" : TRACKING_PAUSE_LABEL}
            </button>
          ) : null}
          {view.canResume ? (
            <button
              onClick={() => void run("resume")}
              disabled={busy !== null}
              className="press inline-flex min-h-11 items-center gap-1.5 rounded-full bg-brand px-4 text-[14px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="size-4" aria-hidden />
              {busy === "resume" ? "…" : TRACKING_RESUME_LABEL}
            </button>
          ) : null}
          {view.atMaximum ? <span className="text-[13px] text-ink-soft">{trackingMaximumText(tracking)}</span> : null}
        </div>
      ) : null}
      <p className="mt-3 text-[13px] text-ink-soft">{TRACKING_NOTE}</p>
    </section>
  );
}
