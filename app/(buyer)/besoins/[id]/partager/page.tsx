"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { isUuid } from "@/lib/client/api";
import { describeShareError, shares, type ShareStatus } from "@/lib/client/shares-api";
import { SHARE_COPIED, SHARE_COPY_FAILED, SHARE_INTRO, SHARE_ONE_ACTIVE_NOTE, SHARE_REVOKED, SHARE_TITLE, SHARE_WHAT_LINES, SHARE_WHAT_TITLE, shareUrl, statusText } from "@/lib/client/shares-view";

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
      <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (status === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[14px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  return (
    <div data-testid="share-screen">
      <p className="mt-3 text-[14px] text-ink">{SHARE_INTRO}</p>
      <section aria-labelledby="share-what" className="mt-4 rounded-2xl border border-line bg-white p-3.5">
        <h2 id="share-what" className="text-[14px] font-extrabold text-ink">
          {SHARE_WHAT_TITLE}
        </h2>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-ink">
          {SHARE_WHAT_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <p data-testid="share-status" className="mt-4 text-[13px] font-semibold text-ink">
        {statusText(status)}
      </p>
      {link ? (
        <div data-testid="share-link" className="mt-2 rounded-2xl border-2 border-forest/40 bg-sage p-3.5">
          <input readOnly value={link} aria-label="Lien à envoyer" onFocus={(event) => event.currentTarget.select()} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-ink" />
          <button onClick={() => void copy()} data-testid="share-copy" className="mt-2 w-full rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white">
            Copier le lien
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-[13px] font-semibold text-forest">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-2.5">
        <button onClick={() => void create()} disabled={pending} data-testid="share-create" className="rounded-xl bg-forest px-3 py-3 text-[14px] font-bold text-white disabled:opacity-50">
          {status.active ? "Créer un nouveau lien (remplace l'ancien)" : "Créer un lien"}
        </button>
        {status.active ? (
          <button onClick={() => void revoke()} disabled={pending} data-testid="share-revoke" className="rounded-xl border border-line bg-white px-3 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
            Désactiver le lien
          </button>
        ) : null}
      </div>
      <p className="mt-3 text-[12px] text-ink-soft">{SHARE_ONE_ACTIVE_NOTE}</p>
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
        <div className="px-4 pb-8">
          {isUuid(id) ? (
            <Share demandId={id} />
          ) : (
            <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
              Besoin introuvable.
            </p>
          )}
        </div>
      </main>
    </SessionGate>
  );
}
