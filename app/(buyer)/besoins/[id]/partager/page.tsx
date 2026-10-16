"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Info, Link2, TriangleAlert, Unlink } from "lucide-react";
import { ArtAlert, ArtEmpty, ArtShield } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { EmptyState, IconTile, Skeleton } from "@/components/ui";
import { isUuid } from "@/lib/client/api";
import { describeShareError, shares, type ShareStatus } from "@/lib/client/shares-api";
import { SHARE_COPIED, SHARE_COPY_FAILED, SHARE_ONE_ACTIVE_NOTE, SHARE_REVOKED, SHARE_TITLE, SHARE_WHAT_LINES, SHARE_WHAT_TITLE, shareUrl, statusText } from "@/lib/client/shares-view";

function Share({ demandId }: { demandId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    shares.status(demandId, { signal: controller.signal }).then(setStatus, (failure) => {
      if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
      setError(describeShareError(failure));
    });
    return () => controller.abort();
  }, [demandId, redirectIfUnauthorized]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        await action();
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setError(describeShareError(failure));
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [redirectIfUnauthorized],
  );

  const create = () =>
    run(async () => {
      const created = await shares.create(demandId);
      setLink(shareUrl(window.location.origin, created.path));
      setStatus({ active: true, createdAt: created.createdAt });
    });

  const revoke = () =>
    run(async () => {
      await shares.revoke(demandId);
      setLink(null);
      setStatus({ active: false, createdAt: null });
      setNotice(SHARE_REVOKED);
    });

  const copy = async () => {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      setNotice(SHARE_COPIED);
    } catch {
      setNotice(SHARE_COPY_FAILED);
    }
  };

  if (error && status === null) {
    return (
      <div role="alert">
        <EmptyState art={<ArtAlert className="size-32" />} title={error} />
      </div>
    );
  }
  if (status === null) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Chargement…</span>
        <Skeleton className="h-28 w-full rounded-3xl" />
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    );
  }
  return (
    <div data-testid="share-screen" className="flex flex-col gap-4">
      <div className="animate-rise flex justify-center">
        <ArtShield className="size-32" />
      </div>
      <section aria-labelledby="share-what" className="animate-rise rounded-3xl border border-line bg-white p-4">
        <h2 id="share-what" className="text-[16px] font-extrabold text-ink">
          {SHARE_WHAT_TITLE}
        </h2>
        <ul className="mt-3 flex flex-col gap-2 text-[14px] text-ink">
          {SHARE_WHAT_LINES.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-success-ink" strokeWidth={2.6} aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex items-center gap-3">
        <IconTile icon={Link2} tone={status.active ? "success" : "mist"} />
        <p data-testid="share-status" className="flex-1 text-[15px] font-bold text-ink">
          {statusText(status)}
        </p>
      </div>
      {link ? (
        <div data-testid="share-link" className="animate-pop flex flex-col gap-3 rounded-3xl border-2 border-brand/40 bg-brand-soft p-4">
          <input
            readOnly
            value={link}
            aria-label="Lien à envoyer"
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-12 w-full rounded-2xl border-2 border-line bg-white px-4 py-3 text-[14px] text-ink"
          />
          <button
            onClick={() => void copy()}
            data-testid="share-copy"
            className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white hover:bg-brand-deep"
          >
            <Copy className="size-5" aria-hidden />
            Copier le lien
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-center gap-2 text-[14px] font-semibold text-success-ink">
          <Check className="size-4 shrink-0" strokeWidth={2.6} aria-hidden />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-3 text-[14px] font-semibold text-accent-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2.5 md:flex-row">
        <button
          onClick={() => void create()}
          disabled={pending}
          data-testid="share-create"
          className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white shadow-md shadow-brand/30 hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2 className="size-5" aria-hidden />
          {status.active ? "Créer un nouveau lien (remplace l'ancien)" : "Créer un lien"}
        </button>
        {status.active ? (
          <button
            onClick={() => void revoke()}
            disabled={pending}
            data-testid="share-revoke"
            className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-danger hover:text-danger-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Unlink className="size-5" aria-hidden />
            Désactiver le lien
          </button>
        ) : null}
      </div>
      <p className="flex items-start gap-2 text-[13px] text-ink-soft">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        {SHARE_ONE_ACTIVE_NOTE}
      </p>
    </div>
  );
}

export default function PartagerBesoin() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      <main>
        <TopBar back={isUuid(id) ? `/besoins/${id}` : "/alertes"} title={SHARE_TITLE} />
        <div className="px-4 pb-8 pt-2">
          {isUuid(id) ? (
            <Share demandId={id} />
          ) : (
            <div role="alert">
              <EmptyState art={<ArtEmpty className="size-36" />} title="Besoin introuvable." />
            </div>
          )}
        </div>
      </main>
    </SessionGate>
  );
}
