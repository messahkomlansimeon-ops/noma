"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ApiError } from "@/lib/client/api";
import { external, type ExternalListing } from "@/lib/client/external-api";
import {
  EXTERNAL_LINK_LABEL,
  EXTERNAL_LOADING,
  EXTERNAL_MORE_LABEL,
  EXTERNAL_SECTION_INTRO,
  EXTERNAL_SECTION_TITLE,
  EXTERNAL_UNAVAILABLE,
  externalCardRow,
  mergeExternalItems,
} from "@/lib/client/external-view";

/**
 * Section « Sur d'autres sites » des résultats d'un besoin (lot EXT1). Toujours SÉPARÉE des résultats noma : jamais dans leur liste, leur classement ni leur « Sponsorisé ».
 * Chaque annonce porte la mention obligatoire et un lien sortant en nouvel onglet (`rel="noopener noreferrer nofollow"`) ; ni favori, ni contact, ni commande. Une panne de
 * cette section n'affecte jamais le reste de la page.
 */

/** Une annonce d'un autre site : la mention, le lien sortant, aucune action de noma. */
export function ExternalCard({ item }: { item: ExternalListing }) {
  const row = externalCardRow(item);
  return (
    <li data-testid="external-card" data-source={item.source.code} className="rounded-2xl border border-line bg-white p-3.5">
      <div className="text-[15px] font-bold text-ink">{row.title}</div>
      <div className="font-display text-[18px] font-extrabold text-ink">{row.priceText}</div>
      {row.locationText ? <div className="text-[12px] text-ink-soft">{row.locationText}</div> : null}
      <div className="mt-1 text-[12px] font-semibold text-forest">{row.compatibilityText}</div>
      {row.alsoOnText ? (
        <div data-testid="external-also-on" className="text-[12px] text-ink-soft">
          {row.alsoOnText}
        </div>
      ) : null}
      <p data-testid="external-mention" className="mt-2 rounded-xl bg-wash px-3 py-2 text-[12px] font-semibold leading-snug text-ink-soft">
        {row.mention}
      </p>
      <div className="mt-1 text-[11px] text-ink-soft">{row.seenText}</div>
      {row.link ? (
        <a
          href={row.link.href}
          target={row.link.target}
          rel={row.link.rel}
          data-testid="external-link"
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-forest/30 bg-white py-2.5 text-[14px] font-bold text-forest"
        >
          {EXTERNAL_LINK_LABEL}
          <ExternalLink className="size-4" aria-hidden />
        </a>
      ) : null}
    </li>
  );
}

export type ExternalSectionState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: ExternalListing[]; nextCursor: string | null };

/** Affichage pur de la section : rien tant qu'il n'y a rien à montrer, une note discrète en cas de panne. */
export function ExternalSectionView({ state, loadingMore, moreError, onMore }: { state: ExternalSectionState; loadingMore: boolean; moreError: boolean; onMore: () => void }) {
  if (state.kind === "loading") {
    return (
      <p data-testid="external-loading" aria-busy="true" className="mt-6 text-center text-[12px] text-ink-soft">
        {EXTERNAL_LOADING}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p data-testid="external-unavailable" role="status" className="mt-6 text-center text-[12px] font-semibold text-ink-soft">
        {EXTERNAL_UNAVAILABLE}
      </p>
    );
  }
  if (state.items.length === 0) return null;
  return (
    <section data-testid="external-section" aria-labelledby="external-section-title" className="mt-8">
      <h2 id="external-section-title" className="text-[16px] font-extrabold text-ink">
        {EXTERNAL_SECTION_TITLE}
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-soft">{EXTERNAL_SECTION_INTRO}</p>
      <ul className="mt-3 space-y-3" aria-label={EXTERNAL_SECTION_TITLE}>
        {state.items.map((item) => (
          <ExternalCard key={item.id} item={item} />
        ))}
      </ul>
      {moreError ? (
        <p role="alert" className="mt-3 text-center text-[13px] font-semibold text-carrot-ink">
          {EXTERNAL_UNAVAILABLE}
        </p>
      ) : null}
      {state.nextCursor ? (
        <button
          onClick={onMore}
          disabled={loadingMore}
          data-testid="external-more"
          className="mt-4 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest disabled:opacity-50"
        >
          {loadingMore ? "Chargement…" : EXTERNAL_MORE_LABEL}
        </button>
      ) : null}
    </section>
  );
}

const PAGE_SIZE = 6;

export function ExternalSection({ demandId }: { demandId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<ExternalSectionState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const token = ++generation.current;
    external.listings(demandId, { limit: PAGE_SIZE }, { signal: controller.signal }).then(
      (page) => {
        if (generation.current === token) setState({ kind: "ready", items: page.items, nextCursor: page.nextCursor });
      },
      (failure: unknown) => {
        if (controller.signal.aborted || generation.current !== token) return;
        if (redirectIfUnauthorized(failure)) return;
        // Une panne ne casse jamais la page : note discrète (un 404 : le besoin a changé, rien à montrer).
        setState(failure instanceof ApiError && failure.status === 404 ? { kind: "ready", items: [], nextCursor: null } : { kind: "error" });
      },
    );
    return () => controller.abort();
  }, [demandId, redirectIfUnauthorized]);

  const loadMore = useCallback(async () => {
    if (state.kind !== "ready" || state.nextCursor === null || loadingMore) return;
    const token = ++generation.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await external.listings(demandId, { limit: PAGE_SIZE, cursor: state.nextCursor });
      if (generation.current === token) setState({ kind: "ready", items: mergeExternalItems(state.items, page.items), nextCursor: page.nextCursor });
    } catch (failure) {
      if (generation.current !== token || redirectIfUnauthorized(failure)) return;
      setMoreError(true);
    } finally {
      if (generation.current === token) setLoadingMore(false);
    }
  }, [demandId, state, loadingMore, redirectIfUnauthorized]);

  return <ExternalSectionView state={state} loadingMore={loadingMore} moreError={moreError} onMore={() => void loadMore()} />;
}
