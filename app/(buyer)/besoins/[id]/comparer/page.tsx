"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { api, describeApiError, isUuid, type StoredMatch } from "@/lib/client/api";
import {
  COMPARE_INVALID_MESSAGE,
  COMPARE_MISSING_MESSAGE,
  COMPARE_NOTE,
  compareRows,
  parseCompareSelection,
  pickCompared,
  type CompareRow,
} from "@/lib/client/compare-view";
import { productTitle } from "@/lib/client/match-view";
import { offerDetailPath } from "@/lib/client/metrics-view";

/** Nombre maximal de pages de résultats parcourues pour retrouver les deux offres choisies (200 correspondances au plus sont triées). */
const MAX_PAGES = 8;

type State =
  | { kind: "loading" }
  | { kind: "ready"; pair: [StoredMatch, StoredMatch] }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function Cell({ text, best }: { text: string; best: boolean }) {
  return (
    <td className={`px-2 py-2 align-top text-[14px] ${best ? "font-bold text-brand" : "text-ink"}`}>
      {text}
      {best ? <span className="ml-1 text-[12px] font-extrabold uppercase text-brand">Le plus avantageux</span> : null}
    </td>
  );
}

function Table({ demandId, pair }: { demandId: string; pair: [StoredMatch, StoredMatch] }) {
  const rows: CompareRow[] = compareRows(pair[0], pair[1]);
  const titles = pair.map((item) => productTitle(item.candidate, "Offre"));
  return (
    <div>
      <div className="overflow-x-auto rounded-2xl border border-line bg-white">
        <table data-testid="compare-table" className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">Comparaison de deux offres</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-[28%] px-2 py-2 text-[13px] font-semibold text-ink-soft">
                &nbsp;
              </th>
              {titles.map((title, index) => (
                <th key={pair[index].candidateId} scope="col" className="px-2 py-2 text-[14px] font-extrabold text-ink">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-row={row.key} className="border-b border-line last:border-0">
                <th scope="row" className="px-2 py-2 align-top text-[13px] font-semibold text-ink-soft">
                  {row.label}
                </th>
                <Cell text={row.a} best={row.better === "a"} />
                <Cell text={row.b} best={row.better === "b"} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {pair.map((item) => {
          const href = offerDetailPath(demandId, item.candidateId);
          return href ? (
            <Link
              key={item.candidateId}
              href={href}
              className="flex items-center justify-center rounded-xl border border-brand/30 bg-white py-2.5 text-[14px] font-bold text-brand"
            >
              Voir l'annonce
            </Link>
          ) : null;
        })}
      </div>
      <p className="mt-3 text-[13px] text-ink-soft">{COMPARE_NOTE}</p>
    </div>
  );
}

function Compared({ demandId, selection }: { demandId: string; selection: [string, string] }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        let cursor: string | undefined;
        const seen: StoredMatch[] = [];
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await api.demands.storedMatches(demandId, { sort: "relevance", ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
          seen.push(...result.items);
          const pair = pickCompared(seen, selection);
          if (pair) {
            setState({ kind: "ready", pair });
            return;
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        setState({ kind: "missing" });
      } catch (failure) {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setState({ kind: "error", message: describeApiError(failure, "matches") });
      }
    })();
    return () => controller.abort();
  }, [demandId, selection, redirectIfUnauthorized]);

  if (state.kind === "loading") {
    return (
      <p role="status" aria-busy="true" className="mt-6 text-center text-[15px] text-ink-soft">
        Chargement de la comparaison…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        {state.message}
      </p>
    );
  }
  if (state.kind === "missing") {
    return (
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        {COMPARE_MISSING_MESSAGE}
      </p>
    );
  }
  return <Table demandId={demandId} pair={state.pair} />;
}

function PageContent() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const demandId = typeof params.id === "string" ? params.id : "";
  const valid = isUuid(demandId);
  const selection = parseCompareSelection(search.get("offres"));
  return (
    <main>
      <TopBar back={valid ? `/besoins/${demandId}` : "/alertes"} title="Comparer" />
      <div className="px-4 pb-6">
        {valid && selection ? (
          <Compared demandId={demandId} selection={selection} />
        ) : (
          <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
            {valid ? COMPARE_INVALID_MESSAGE : "Besoin introuvable."}
          </p>
        )}
      </div>
    </main>
  );
}

export default function ComparerPage() {
  return (
    <SessionGate>
      {/* useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu. */}
      <Suspense fallback={null}>
        <PageContent />
      </Suspense>
    </SessionGate>
  );
}
