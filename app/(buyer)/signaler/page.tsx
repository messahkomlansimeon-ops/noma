"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CircleAlert, Flag, Phone, Send, ShieldCheck } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert, ArtCheck, ArtShield } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, Card, EmptyState, IconTile, Skeleton, Textarea } from "@/components/ui";
import { describeReportError, reports, type MyReport } from "@/lib/client/reports-api";
import {
  MY_REPORTS_EMPTY,
  MY_REPORTS_TITLE,
  REPORT_FORM_INTRO,
  REPORT_INVALID_TARGET,
  REPORT_NO_PHONE_NOTE,
  REPORT_PAGE_TITLE,
  REPORT_SENT_MESSAGE,
  myReportRow,
  parseReportTarget,
  type ReportTarget,
} from "@/lib/client/reports-view";
import { REPORT_DETAIL_MAX, REPORT_REASONS, REPORT_REASON_LABELS, type ReportReason } from "@/lib/reports-rules";

/** Formulaire : un motif (obligatoire) et un texte facultatif sans numéro de téléphone. L'envoi est contrôlé par les mêmes règles que le serveur. */
function ReportForm({ target }: { target: ReportTarget }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const busy = useRef(false);

  const submit = async () => {
    if (reason === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await reports.create({
        targetType: target.type,
        targetId: target.type === "offer" ? target.offerId : target.orderId,
        demandId: target.type === "offer" ? target.demandId : null,
        reason,
        detail: detail.trim() === "" ? null : detail,
      });
      setSent(true);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeReportError(failure, "send"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  if (sent) {
    return (
      <div role="status" data-testid="report-sent" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl bg-success-soft p-6 text-center">
        <ArtCheck className="size-28" />
        <p className="text-[17px] font-bold text-success-ink">{REPORT_SENT_MESSAGE}</p>
        <div className="w-full max-w-xs">
          <Btn href="/signaler">
            <Flag className="size-5" aria-hidden />
            Voir mes signalements
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <form
      data-testid="report-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mt-3 flex flex-col gap-4"
    >
      <p className="flex items-start gap-2.5 rounded-2xl bg-mist p-3.5 text-[14px] text-ink-soft">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        {REPORT_FORM_INTRO}
      </p>
      <fieldset>
        <legend className="flex items-center gap-2 text-[17px] font-extrabold text-ink">
          <Flag className="size-5 text-brand" aria-hidden />
          Motif
        </legend>
        <div className="stagger mt-3 grid gap-2.5 md:grid-cols-2">
          {REPORT_REASONS.map((entry) => (
            <label
              key={entry}
              className="press flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border-2 border-line bg-white px-4 py-3 text-[15px] font-semibold text-ink hover:border-line-strong has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input type="radio" name="reason" value={entry} checked={reason === entry} onChange={() => setReason(entry)} className="size-5 shrink-0 accent-brand" />
              {REPORT_REASON_LABELS[entry]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="report-detail" className="mb-1.5 block text-[17px] font-extrabold text-ink">
          Précisions (facultatif)
        </label>
        <Textarea id="report-detail" value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={REPORT_DETAIL_MAX} rows={4} />
        <p className="mt-2 flex items-start gap-2 text-[13px] text-ink-soft">
          <Phone className="mt-0.5 size-4 shrink-0" aria-hidden />
          {REPORT_NO_PHONE_NOTE}
        </p>
      </div>
      {error ? (
        <p role="alert" className="flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[15px] font-semibold text-danger-ink">
          <CircleAlert className="size-5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={reason === null || pending}
        data-testid="report-submit"
        className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send className="size-5" aria-hidden />
        {pending ? "Envoi…" : "Envoyer le signalement"}
      </button>
    </form>
  );
}

/** Mes signalements : ouvert ou clos seulement (jamais la décision ni le motif de l'administrateur). */
function MyReports() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<MyReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    reports.mine({ signal: controller.signal }).then(
      (list) => setItems(list),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeReportError(failure, "list"));
      },
    );
    return () => controller.abort();
  }, [redirectIfUnauthorized]);

  if (error) {
    return (
      <div role="alert">
        <EmptyState art={<ArtAlert className="size-32" />} title={error} />
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
        <span className="sr-only">Chargement…</span>
        <Skeleton className="h-20 w-full rounded-3xl" />
        <Skeleton className="h-20 w-full rounded-3xl" />
      </div>
    );
  }
  return (
    <div data-testid="my-reports">
      <h2 className="mt-3 flex items-center gap-2.5 text-[22px] font-extrabold tracking-tight text-ink">
        <Flag className="size-6 text-brand" aria-hidden />
        {MY_REPORTS_TITLE}
      </h2>
      {items.length === 0 ? (
        <EmptyState art={<ArtShield className="size-36" />} title={MY_REPORTS_EMPTY} />
      ) : (
        <ul className="stagger mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-label={MY_REPORTS_TITLE}>
          {items.map((report) => {
            const row = myReportRow(report);
            return (
              <li key={row.key} data-testid="my-report">
                <Card className="flex h-full items-start gap-3">
                  <IconTile icon={Flag} tone={row.open ? "accent" : "success"} className="size-11" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                      <Badge tone={row.open ? "carrot" : "sage"}>{row.statusText}</Badge>
                    </div>
                    <div className="mt-0.5 text-[13px] text-ink-soft">{row.reasonText}</div>
                    <div className="text-[13px] text-ink-soft">{row.dateText}</div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PageContent() {
  const search = useSearchParams();
  const hasTarget = search.has("annonce") || search.has("besoin") || search.has("commande");
  const target = parseReportTarget(search);
  return (
    <main>
      <TopBar back="/compte" title={REPORT_PAGE_TITLE} />
      <div className="px-4 pb-8">
        {!hasTarget ? (
          <MyReports />
        ) : target ? (
          <ReportForm target={target} />
        ) : (
          <div role="alert">
            <EmptyState art={<ArtAlert className="size-32" />} title={REPORT_INVALID_TARGET} />
          </div>
        )}
      </div>
    </main>
  );
}

export default function SignalerPage() {
  return (
    <SessionGate>
      {/* useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu. */}
      <Suspense fallback={null}>
        <PageContent />
      </Suspense>
    </SessionGate>
  );
}
