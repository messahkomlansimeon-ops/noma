"use client";

import { CloudOff, ExternalLink, Globe, MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { IconTile, Skeleton } from "@/components/ui";
import { ApiError } from "@/lib/client/api";
import { external, type ExternalListing } from "@/lib/client/external-api";
import {
  EXTERNAL_DEMO_SITE_HINT,
  EXTERNAL_DEMO_SITE_LABEL,
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
    <li data-testid="external-card" data-source={item.source.code} className="rounded-3xl border border-line bg-white p-4">
      <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{row.title}</div>
      <div className="text-[20px] font-extrabold leading-tight text-ink">{row.priceText}</div>
      {row.locationText ? (
        <div className="mt-0.5 flex items-center gap-1 text-[14px] text-ink-soft">
          <MapPin className="size-4 shrink-0" aria-hidden />
          {row.locationText}
        </div>
      ) : null}
      <div className="mt-1.5 text-[13px] font-semibold text-brand">{row.compatibilityText}</div>
      {row.alsoOnText ? (
        <div data-testid="external-also-on" className="text-[13px] text-ink-soft">
          {row.alsoOnText}
        </div>
      ) : null}
      <p data-testid="external-mention" className="mt-3 rounded-2xl bg-mist px-3 py-2.5 text-[13px] font-semibold leading-snug text-ink-soft">
        {row.mention}
      </p>
      <div className="mt-1.5 text-[12px] text-ink-soft">{row.seenText}</div>
      {row.link ? (
        <a
          href={row.link.href}
          target={row.link.target}
          rel={row.link.rel}
          data-testid="external-link"
          className="press mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand"
        >
          {EXTERNAL_LINK_LABEL}
          <ExternalLink className="size-5" aria-hidden />
        </a>
      ) : row.demoSite ? (
        <div data-testid="external-link-demo" className="mt-3">
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="flex min-h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl border-2 border-line bg-mist px-5 py-3 text-[16px] font-bold text-ink-soft opacity-70"
          >
            {EXTERNAL_LINK_LABEL}
            <ExternalLink className="size-5" aria-hidden />
          </button>
          <p className="mt-1.5 text-center text-[12px] font-semibold text-ink-soft">
            {EXTERNAL_DEMO_SITE_LABEL} : {EXTERNAL_DEMO_SITE_HINT}
          </p>
        </div>
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
      <div data-testid="external-loading" aria-busy="true" className="mt-8">
        <span className="sr-only">{EXTERNAL_LOADING}</span>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="mt-3 h-32 w-full rounded-3xl" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p data-testid="external-unavailable" role="status" className="mt-8 flex items-start gap-2 rounded-2xl bg-mist px-4 py-3 text-[14px] font-semibold text-ink-soft">
        <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        {EXTERNAL_UNAVAILABLE}
      </p>
    );
  }
  if (state.items.length === 0) return null;
  return (
    <section data-testid="external-section" aria-labelledby="external-section-title" className="mt-8">
      <div className="flex items-center gap-3">
        <IconTile icon={Globe} tone="info" className="size-10" />
        <h2 id="external-section-title" className="text-[18px] font-extrabold tracking-tight text-ink">
          {EXTERNAL_SECTION_TITLE}
        </h2>
      </div>
      <p className="mt-2 text-[13px] text-ink-soft">{EXTERNAL_SECTION_INTRO}</p>
      <ul className="stagger mt-3 flex flex-col gap-3 md:grid md:grid-cols-2" aria-label={EXTERNAL_SECTION_TITLE}>
        {state.items.map((item) => (
          <ExternalCard key={item.id} item={item} />
        ))}
      </ul>
      {moreError ? (
        <p role="alert" className="mt-3 text-center text-[14px] font-semibold text-accent-ink">
          {EXTERNAL_UNAVAILABLE}
        </p>
      ) : null}
      {state.nextCursor ? (
        <button
          onClick={onMore}
          disabled={loadingMore}
          data-testid="external-more"
          className="press mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
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
