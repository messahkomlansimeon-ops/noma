"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { AdminNotFound, AdminPage } from "@/components/admin/admin-page";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Badge } from "@/components/ui";
import { isUuid } from "@/lib/client/api";
import { describeReportError, reports, type AdminReportDetail } from "@/lib/client/reports-api";
import {
  AI_SUMMARY_NOTE,
  DECISION_NOTE_HINT,
  DECISION_NOTE_LABEL,
  decisionConfirmText,
  decisionOutcomeText,
  dossierFacts,
  dossierRow,
} from "@/lib/client/reports-view";
import { REPORT_DECISION_LABELS, REPORT_DECISIONS, REPORT_NOTE_MAX, type ReportDecision } from "@/lib/reports-rules";
import { formatDateTimeFr } from "@/lib/client/wallet-view";

function Dossier({ report, reload }: { report: AdminReportDetail; reload: () => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [decision, setDecision] = useState<ReportDecision | null>(null);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const row = dossierRow(report);

  const apply = async () => {
    if (decision === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await reports.admin.decide(report.id, { decision, note });
      setNotice(decisionOutcomeText(result.decision, result.suspended));
      setConfirming(false);
      reload();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeReportError(failure, "admin"));
      if (failure instanceof Error && "code" in failure && (failure as { code?: string }).code === "report_closed") reload();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <div data-testid="admin-dossier">
      <div className="flex items-start justify-between gap-2">
        <h1 className="text-[20px] font-extrabold text-ink">{row.title}</h1>
        <Badge tone={row.open ? "carrot" : "sage"}>{row.decisionText ?? "À traiter"}</Badge>
      </div>
      <p className="mt-0.5 text-[14px] font-semibold text-ink">{row.reasonText}</p>
      <p className="font-mono text-[13px] text-ink-soft">{row.reportedText}</p>
      <p className="font-mono text-[13px] text-ink-soft">{row.reporterText}</p>
      <p className="text-[13px] text-ink-soft">{row.dateText}</p>
      {notice ? (
        <p role="status" data-testid="admin-notice" className="mt-2 rounded-xl bg-brand-soft px-3 py-2 text-[14px] font-semibold text-brand">
          {notice}
        </p>
      ) : null}

      <section aria-labelledby="dossier-facts" className="mt-4 rounded-2xl border border-line bg-white p-3.5">
        <h2 id="dossier-facts" className="text-[15px] font-extrabold text-ink">
          Faits
        </h2>
        <ul className="mt-1.5 space-y-1 text-[14px] text-ink">
          {dossierFacts(report).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-[13px] text-ink-soft">{AI_SUMMARY_NOTE}</p>
      </section>

      <section aria-labelledby="dossier-text" className="mt-3 rounded-2xl border border-line bg-white p-3.5">
        <h2 id="dossier-text" className="text-[15px] font-extrabold text-ink">
          Texte de l'auteur
        </h2>
        <p data-testid="dossier-detail" className="mt-1.5 whitespace-pre-wrap text-[14px] text-ink">
          {report.detail ?? "Aucune précision."}
        </p>
      </section>

      {report.status === "closed" ? (
        <section aria-labelledby="dossier-decision" className="mt-3 rounded-2xl border border-line bg-white p-3.5" data-testid="dossier-decision">
          <h2 id="dossier-decision" className="text-[15px] font-extrabold text-ink">
            Décision
          </h2>
          <p className="mt-1 text-[14px] font-semibold text-ink">{row.decisionText}</p>
          <p className="mt-1 whitespace-pre-wrap text-[14px] text-ink">{report.decisionNote}</p>
          <p className="mt-1 text-[13px] text-ink-soft">
            {report.decidedAt ? formatDateTimeFr(report.decidedAt) : ""}
            {report.decidedByMaskedPhone ? ` · par ${report.decidedByMaskedPhone}` : ""}
          </p>
        </section>
      ) : (
        <section aria-labelledby="dossier-decide" className="mt-3 rounded-2xl border border-line bg-white p-3.5" data-testid="dossier-decide">
          <h2 id="dossier-decide" className="text-[15px] font-extrabold text-ink">
            Décider
          </h2>
          <div className="mt-2 space-y-2">
            {REPORT_DECISIONS.map((entry) => (
              <label key={entry} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5 text-[15px] text-ink">
                <input type="radio" name="decision" value={entry} checked={decision === entry} onChange={() => { setDecision(entry); setConfirming(false); }} className="size-4 accent-brand" />
                {REPORT_DECISION_LABELS[entry]}
              </label>
            ))}
          </div>
          <label htmlFor="decision-note" className="mt-3 block text-[14px] font-extrabold text-ink">
            {DECISION_NOTE_LABEL}
          </label>
          <textarea id="decision-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={REPORT_NOTE_MAX} rows={3} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink" />
          <p className="mt-1 text-[13px] text-ink-soft">{DECISION_NOTE_HINT}</p>
          {!confirming ? (
            <button
              disabled={decision === null || note.trim() === ""}
              onClick={() => { setError(null); setConfirming(true); }}
              data-testid="dossier-continue"
              className="mt-3 flex w-full items-center justify-center rounded-xl bg-brand py-3 text-[15px] font-bold text-white disabled:opacity-50"
            >
              Continuer
            </button>
          ) : (
            <div role="alertdialog" aria-modal="false" aria-labelledby="dossier-confirm-title" data-testid="admin-confirm" className="mt-3 rounded-2xl border-2 border-accent p-3.5">
              <h3 id="dossier-confirm-title" className="text-[15px] font-extrabold text-ink">
                Confirmer
              </h3>
              <p className="mt-1 text-[14px] text-ink-soft">{decision ? decisionConfirmText(decision, report.reportedMaskedPhone) : ""}</p>
              {error ? (
                <p role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
                  {error}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <button onClick={() => setConfirming(false)} disabled={pending} className="rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] font-bold text-ink disabled:opacity-50">
                  Annuler
                </button>
                <button onClick={() => void apply()} disabled={pending} data-testid="admin-confirm-yes" className="rounded-xl bg-brand px-3 py-2.5 text-[15px] font-bold text-white disabled:opacity-50">
                  {decision ? REPORT_DECISION_LABELS[decision] : "Confirmer"}
                </button>
              </div>
            </div>
          )}
          {!confirming && error ? (
            <p role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
              {error}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}

export default function DossierDetail() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = typeof params.id === "string" ? params.id : "";
  const valid = isUuid(id);
  const load = useCallback((signal: AbortSignal) => (valid ? reports.admin.get(id, { signal }) : Promise.reject(new Error("invalid"))), [id, valid]);
  if (!valid) return <AdminNotFound />;
  return (
    <AdminPage title="Dossier" back="/admin/dossiers" load={load}>
      {(report, reload) => <Dossier report={report} reload={() => { reload(); router.refresh(); }} />}
    </AdminPage>
  );
}
