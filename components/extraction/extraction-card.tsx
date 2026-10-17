"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Info, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Btn, BtnOutline, IconTile } from "@/components/ui";
import { ApiError, API_ABORTED, API_NETWORK_ERROR } from "@/lib/client/api";
import { extraction, type ExtractionKind, type ExtractionProposal } from "@/lib/client/extraction-api";
import {
  EXTRACTION_AGAIN, EXTRACTION_ANALYZE, EXTRACTION_ANALYZING, EXTRACTION_APPLY, EXTRACTION_APPLYING, EXTRACTION_BLOCKED_NOTE, EXTRACTION_CURRENT_PREFIX, EXTRACTION_INTRO, EXTRACTION_NOTHING_FOUND,
  EXTRACTION_SELECT_NONE, EXTRACTION_STALE, EXTRACTION_TITLE, appliedMessage, describeExtractionError, extractionRows, initialChecked, needsNewAnalysis, selectionCount, selectionFor, selectionScope,
  type ExtractionCurrent,
} from "@/lib/client/extraction-view";
import { browserSessionStorage, createIdempotencyKeys, newIdempotencyKey } from "@/lib/client/wallet-view";

const KEY_PREFIX = "noma:extraction-key:";

/** La fiche (offre ou besoin) telle que la carte en a besoin : sa version de contenu, son état d'archivage et ses valeurs actuelles. */
export type ExtractionCardRecord = ExtractionCurrent & { id: string; contentVersion: number; archivedAt: string | null };

/**
 * Carte « Remplir la fiche depuis mon texte » : le serveur lit le texte écrit par le propriétaire et PROPOSE des champs ; le propriétaire coche ce qu'il veut reporter et appuie sur « Appliquer ».
 * Rien n'est modifié avant. Les lignes viennent de `extraction-view.ts` (testé) ; la clé d'idempotence est liée à la proposition ET aux champs cochés (un double appui ou un nouvel essai réseau
 * ne s'applique jamais deux fois). `onChanged` : la fiche a changé (application réussie, ou texte modifié ailleurs) et la page doit la relire.
 */
export function ExtractionCard({ kind, record, onChanged }: { kind: ExtractionKind; record: ExtractionCardRecord; onChanged?: () => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [proposal, setProposal] = useState<ExtractionProposal | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busy = useRef(false);
  const keys = useRef(createIdempotencyKeys(newIdempotencyKey, browserSessionStorage(), KEY_PREFIX));
  // La fiche telle qu'elle était quand la proposition a été CHOISIE pour l'affichage : les lignes ne bougent pas pendant que l'utilisateur coche.
  const recordRef = useRef(record);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  const show = useCallback((next: ExtractionProposal | null) => {
    setProposal(next);
    setChecked(next ? initialChecked(extractionRows(next, recordRef.current)) : new Set());
  }, []);

  // Au chargement : la dernière analyse encore valable pour CETTE version de la fiche (lecture seule, rien n'est calculé).
  useEffect(() => {
    // Une fiche archivée n'affiche pas la carte (voir plus bas) : rien à charger.
    if (record.archivedAt !== null) return;
    const controller = new AbortController();
    extraction.list(kind, record.id, { signal: controller.signal }).then(
      (history) => {
        if (controller.signal.aborted) return;
        const fresh = history.find((item) => !item.isStale && item.sourceContentVersion === recordRef.current.contentVersion) ?? null;
        show(fresh);
        setLoading(false);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        // Un historique illisible n'empêche pas d'analyser : la carte reste utilisable.
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [kind, record.id, record.archivedAt, redirectIfUnauthorized, show]);

  const rows = useMemo(() => (proposal ? extractionRows(proposal, record) : []), [proposal, record]);
  const selection = useMemo(() => selectionFor(rows, checked), [rows, checked]);
  const chosen = selectionCount(selection);

  const analyze = async () => {
    if (busy.current) return;
    busy.current = true;
    setAnalyzing(true);
    setError(null);
    setDone(null);
    try {
      const next = await extraction.propose(kind, record.id);
      show(next);
      // La fiche a été modifiée ailleurs (autre onglet, autre appareil) : la page relit la fiche, puis les lignes se calculent contre la version à jour.
      if (next.sourceContentVersion !== record.contentVersion) onChanged?.();
    } catch (failure) {
      if (!redirectIfUnauthorized(failure)) setError(describeExtractionError(failure));
    } finally {
      busy.current = false;
      setAnalyzing(false);
    }
  };

  const apply = async () => {
    if (busy.current || !proposal || chosen === 0) return;
    busy.current = true;
    setApplying(true);
    setError(null);
    const scope = selectionScope(proposal.id, selection);
    try {
      const receipt = await extraction.apply(kind, record.id, proposal, selection, keys.current.keyFor(scope));
      keys.current.forget(scope);
      show(null);
      setDone(appliedMessage(receipt));
      onChanged?.();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      // Une réponse perdue (réseau) garde la même clé pour le nouvel essai ; tout refus du serveur l'efface.
      const networkFailure = failure instanceof ApiError && (failure.code === API_NETWORK_ERROR || failure.code === API_ABORTED);
      if (!networkFailure) keys.current.forget(scope);
      if (needsNewAnalysis(failure)) show(null);
      setError(describeExtractionError(failure));
    } finally {
      busy.current = false;
      setApplying(false);
    }
  };

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (record.archivedAt !== null) return null;
  const stale = proposal !== null && (proposal.isStale || proposal.sourceContentVersion !== record.contentVersion);

  return (
    <section data-testid="extraction-card" aria-busy={loading || analyzing || applying} className="flex flex-col gap-3 rounded-3xl border border-line bg-white p-4">
      <div className="flex items-center gap-3">
        <IconTile icon={Sparkles} tone="brand" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-extrabold leading-snug text-ink">{EXTRACTION_TITLE}</h2>
          <p className="text-[13px] leading-snug text-ink-soft">{EXTRACTION_INTRO}</p>
        </div>
      </div>

      {error ? (
        <p role="alert" data-testid="extraction-error" className="flex items-start gap-2 rounded-2xl bg-danger-soft p-3 text-[14px] font-semibold text-danger-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" data-testid="extraction-done" className="flex items-start gap-2 rounded-2xl bg-brand-soft p-3 text-[14px] font-semibold text-ink">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          {done}
        </p>
      ) : null}

      {proposal && !stale ? (
        rows.length === 0 ? (
          <p role="status" data-testid="extraction-empty" className="flex items-start gap-2 rounded-2xl bg-mist p-3 text-[14px] font-semibold text-ink-soft">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {EXTRACTION_NOTHING_FOUND}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} data-testid="extraction-row" data-row={row.id} className="rounded-2xl border border-line bg-white">
                <label className={`flex min-h-12 items-start gap-3 p-3 ${row.blocked ? "opacity-60" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    data-testid={`extraction-check-${row.id}`}
                    className="mt-0.5 size-5 shrink-0 accent-brand"
                    checked={row.blocked === null && checked.has(row.id)}
                    disabled={row.blocked !== null || applying}
                    onChange={() => toggle(row.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-bold uppercase tracking-wide text-ink-soft">{row.label}</span>
                    <span className="block text-[16px] font-bold text-ink">{row.value}</span>
                    {row.current ? <span className="block text-[13px] text-ink-soft">{EXTRACTION_CURRENT_PREFIX}{row.current}</span> : null}
                    {row.quote ? <span className="block text-[13px] italic text-ink-soft">« {row.quote} »</span> : null}
                    {row.blocked ? (
                      <span className="mt-1 block text-[13px] font-semibold text-accent-ink">
                        {EXTRACTION_BLOCKED_NOTE} : {row.blocked}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {stale ? (
        <p role="status" data-testid="extraction-stale" className="flex items-start gap-2 rounded-2xl bg-mist p-3 text-[14px] font-semibold text-ink-soft">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {EXTRACTION_STALE}
        </p>
      ) : null}

      {proposal && !stale && rows.length > 0 ? (
        <>
          {chosen === 0 ? <p className="text-[13px] text-ink-soft">{EXTRACTION_SELECT_NONE}</p> : null}
          <Btn data-testid="extraction-apply" onClick={() => void apply()} disabled={chosen === 0 || applying || analyzing}>
            {applying ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : <Check className="size-5" aria-hidden />}
            {applying ? EXTRACTION_APPLYING : `${EXTRACTION_APPLY} (${chosen})`}
          </Btn>
        </>
      ) : null}

      {loading ? null : proposal && !stale ? (
        <BtnOutline data-testid="extraction-analyze" onClick={() => void analyze()} disabled={analyzing || applying}>
          {analyzing ? EXTRACTION_ANALYZING : EXTRACTION_AGAIN}
        </BtnOutline>
      ) : (
        <Btn data-testid="extraction-analyze" onClick={() => void analyze()} disabled={analyzing || applying}>
          {analyzing ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : <Sparkles className="size-5" aria-hidden />}
          {analyzing ? EXTRACTION_ANALYZING : stale ? EXTRACTION_AGAIN : EXTRACTION_ANALYZE}
        </Btn>
      )}
    </section>
  );
}
