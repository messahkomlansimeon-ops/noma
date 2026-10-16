"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { describeReportError, reports, type MyReport } from "@/lib/client/reports-api";
import {
  MY_REPORTS_EMPTY,
  MY_REPORTS_HINT,
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
      <div role="status" data-testid="report-sent" className="mt-4 rounded-2xl bg-brand-soft p-4 text-center">
        <p className="text-[15px] font-bold text-brand">{REPORT_SENT_MESSAGE}</p>
        <Link href="/signaler" className="mt-3 inline-flex rounded-xl bg-brand px-5 py-2.5 text-[15px] font-bold text-white">
          Voir mes signalements
        </Link>
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
      className="mt-3"
    >
      <p className="text-[14px] text-ink-soft">{REPORT_FORM_INTRO}</p>
      <fieldset className="mt-3">
        <legend className="text-[15px] font-extrabold text-ink">Motif</legend>
        <div className="mt-2 space-y-2">
          {REPORT_REASONS.map((entry) => (
            <label key={entry} className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink">
              <input type="radio" name="reason" value={entry} checked={reason === entry} onChange={() => setReason(entry)} className="size-4 accent-brand" />
              {REPORT_REASON_LABELS[entry]}
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="report-detail" className="mt-4 block text-[15px] font-extrabold text-ink">
        Précisions (facultatif)
      </label>
      <textarea
        id="report-detail"
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        maxLength={REPORT_DETAIL_MAX}
        rows={4}
        className="mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink"
      />
      <p className="mt-1 text-[13px] text-ink-soft">{REPORT_NO_PHONE_NOTE}</p>
      {error ? (
        <p role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={reason === null || pending}
        data-testid="report-submit"
        className="mt-4 flex w-full items-center justify-center rounded-xl bg-brand py-3 text-[15px] font-bold text-white disabled:opacity-50"
      >
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
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (items === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[15px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  return (
    <div data-testid="my-reports">
      <h2 className="mt-3 text-[20px] font-extrabold text-ink">{MY_REPORTS_TITLE}</h2>
      {items.length === 0 ? (
        <p className="mt-3 rounded-2xl bg-mist p-4 text-center text-[15px] text-ink-soft">{MY_REPORTS_EMPTY}</p>
      ) : (
        <ul className="mt-3 space-y-2.5" aria-label={MY_REPORTS_TITLE}>
          {items.map((report) => {
            const row = myReportRow(report);
            return (
              <li key={row.key} data-testid="my-report" className="rounded-2xl border border-line bg-white p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-ink">{row.title}</span>
                  <Badge tone={row.open ? "carrot" : "sage"}>{row.statusText}</Badge>
                </div>
                <div className="mt-0.5 text-[13px] text-ink-soft">{row.reasonText}</div>
                <div className="text-[13px] text-ink-soft">{row.dateText}</div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-[13px] text-ink-soft">{MY_REPORTS_HINT}</p>
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
          <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
            {REPORT_INVALID_TARGET}
          </p>
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
