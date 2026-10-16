"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { AdminNotFound, AdminPage } from "@/components/admin/admin-page";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ArrowRight, Flag, Gavel, ListChecks, ScrollText, TextQuote } from "lucide-react";
import { Notice, Panel, adminBtnOutline, adminBtnPrimary } from "@/components/admin/admin-ui";
import { Badge, IconTile, Textarea } from "@/components/ui";
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
    <div data-testid="admin-dossier" className="flex flex-col gap-4">
      <div className="animate-rise flex items-start gap-3 pt-2">
        <IconTile icon={Flag} tone={row.open ? "accent" : "success"} className="size-12" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-[20px] font-extrabold leading-snug tracking-tight text-ink md:text-[24px]">{row.title}</h1>
            <Badge tone={row.open ? "carrot" : "sage"}>{row.decisionText ?? "À traiter"}</Badge>
          </div>
          <p className="mt-0.5 text-[15px] font-semibold text-ink">{row.reasonText}</p>
          <p className="text-[13px] tabular-nums text-ink-soft">{row.reportedText}</p>
          <p className="text-[13px] tabular-nums text-ink-soft">{row.reporterText}</p>
          <p className="text-[13px] text-ink-soft">{row.dateText}</p>
        </div>
      </div>
      {notice ? (
        <p role="status" data-testid="admin-notice" className="animate-pop rounded-2xl bg-success-soft px-3.5 py-2.5 text-[15px] font-semibold text-success-ink">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
        <div className="flex flex-col gap-4">
          <Panel icon={ListChecks} tone="brand" title="Faits" titleId="dossier-facts" aria-labelledby="dossier-facts">
            <ul className="mt-3 space-y-1.5 text-[15px] text-ink">
              {dossierFacts(report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Notice className="mt-3">{AI_SUMMARY_NOTE}</Notice>
          </Panel>

          <Panel icon={TextQuote} tone="info" title="Texte de l'auteur" titleId="dossier-text" aria-labelledby="dossier-text">
            <p data-testid="dossier-detail" className="mt-3 whitespace-pre-wrap text-[15px] text-ink">
              {report.detail ?? "Aucune précision."}
            </p>
          </Panel>
        </div>

        {report.status === "closed" ? (
          <Panel icon={ScrollText} tone="success" title="Décision" titleId="dossier-decision" aria-labelledby="dossier-decision" data-testid="dossier-decision">
            <p className="mt-3 text-[15px] font-semibold text-ink">{row.decisionText}</p>
            <p className="mt-1 whitespace-pre-wrap text-[15px] text-ink">{report.decisionNote}</p>
            <p className="mt-1 text-[13px] text-ink-soft">
              {report.decidedAt ? formatDateTimeFr(report.decidedAt) : ""}
              {report.decidedByMaskedPhone ? ` · par ${report.decidedByMaskedPhone}` : ""}
            </p>
          </Panel>
        ) : (
          <Panel icon={Gavel} tone="accent" title="Décider" titleId="dossier-decide" aria-labelledby="dossier-decide" data-testid="dossier-decide">
            <div className="mt-3 space-y-2">
              {REPORT_DECISIONS.map((entry) => (
                <label key={entry} className={`press flex min-h-12 items-center gap-3 rounded-2xl border-2 px-3.5 py-2 text-[15px] font-semibold text-ink ${decision === entry ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong"}`}>
                  <input type="radio" name="decision" value={entry} checked={decision === entry} onChange={() => { setDecision(entry); setConfirming(false); }} className="size-5 accent-brand" />
                  {REPORT_DECISION_LABELS[entry]}
                </label>
              ))}
            </div>
            <label htmlFor="decision-note" className="mb-1.5 mt-4 block text-[14px] font-extrabold text-ink">
              {DECISION_NOTE_LABEL}
            </label>
            <Textarea id="decision-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={REPORT_NOTE_MAX} rows={3} />
            <Notice className="mt-2">{DECISION_NOTE_HINT}</Notice>
            {!confirming ? (
              <button
                disabled={decision === null || note.trim() === ""}
                onClick={() => { setError(null); setConfirming(true); }}
                data-testid="dossier-continue"
                className={`${adminBtnPrimary} mt-4 w-full min-h-12 text-[16px]`}
              >
                Continuer
                <ArrowRight className="size-5" aria-hidden />
              </button>
            ) : (
              <div role="alertdialog" aria-modal="false" aria-labelledby="dossier-confirm-title" data-testid="admin-confirm" className="animate-rise mt-4 rounded-3xl border-2 border-accent p-4">
                <h3 id="dossier-confirm-title" className="text-[16px] font-extrabold text-ink">
                  Confirmer
                </h3>
                <p className="mt-1 text-[14px] text-ink-soft">{decision ? decisionConfirmText(decision, report.reportedMaskedPhone) : ""}</p>
                {error ? (
                  <p role="alert" className="mt-2 text-[14px] font-semibold text-danger-ink">
                    {error}
                  </p>
                ) : null}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <button onClick={() => setConfirming(false)} disabled={pending} className={adminBtnOutline}>
                    Annuler
                  </button>
                  <button onClick={() => void apply()} disabled={pending} data-testid="admin-confirm-yes" className={adminBtnPrimary}>
                    {decision ? REPORT_DECISION_LABELS[decision] : "Confirmer"}
                  </button>
                </div>
              </div>
            )}
            {!confirming && error ? (
              <p role="alert" className="mt-2 text-[14px] font-semibold text-danger-ink">
                {error}
              </p>
            ) : null}
          </Panel>
        )}
      </div>
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
