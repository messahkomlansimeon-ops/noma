"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/logo";
import { SHARE_TOKEN_PATTERN, type PublicNeed } from "@/lib/shares-rules";
import { ApiError } from "@/lib/client/api";
import { shares } from "@/lib/client/shares-api";
import { PUBLIC_CTA, PUBLIC_DEAD, PUBLIC_LOADING, PUBLIC_NOTE, PUBLIC_TITLE, publicNeedLines } from "@/lib/client/shares-view";

type State = { kind: "loading" } | { kind: "ready"; need: PublicNeed } | { kind: "dead" } | { kind: "error" };

export default function BesoinPartage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [fetched, setFetched] = useState<State>({ kind: "loading" });
  // Un jeton mal formé est « mort » sans appel : calculé au rendu, pas dans un effet.
  const state: State = SHARE_TOKEN_PATTERN.test(token) ? fetched : { kind: "dead" };

  useEffect(() => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return;
    const controller = new AbortController();
    shares.shared(token, { signal: controller.signal }).then(
      (need) => setFetched({ kind: "ready", need }),
      (failure) => {
        if (controller.signal.aborted) return;
        setFetched(failure instanceof ApiError && failure.status === 404 ? { kind: "dead" } : { kind: "error" });
      },
    );
    return () => controller.abort();
  }, [token]);

  return (
    <main className="px-4 pb-10" data-testid="shared-need">
      <div className="py-3">
        <LogoMark />
      </div>
      {state.kind === "loading" ? (
        <p aria-busy="true" className="mt-8 text-center text-[14px] text-ink-soft">
          {PUBLIC_LOADING}
        </p>
      ) : state.kind === "ready" ? (
        <Need need={state.need} />
      ) : (
        <p role="alert" data-testid="shared-dead" className="mt-8 text-center text-[15px] font-semibold text-ink">
          {state.kind === "dead" ? PUBLIC_DEAD : "Le service est temporairement indisponible. Réessayez dans un instant."}
        </p>
      )}
    </main>
  );
}

function Need({ need }: { need: PublicNeed }) {
  const view = publicNeedLines(need);
  return (
    <div>
      <p className="mt-4 text-[12px] font-extrabold uppercase tracking-wider text-sage-ink">{PUBLIC_TITLE}</p>
      <h1 className="mt-1 font-display text-[24px] font-extrabold text-ink">{view.title}</h1>
      <ul className="mt-3 space-y-1.5 rounded-2xl border border-line bg-white p-4 text-[14px] text-ink" aria-label="Le besoin">
        {view.lines.length === 0 ? <li className="text-ink-soft">Aucun autre détail.</li> : view.lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="mt-3 text-[13px] text-ink-soft">{PUBLIC_NOTE}</p>
      <Link href="/vendeur/annonces/nouvelle" data-testid="shared-cta" className="mt-5 flex w-full items-center justify-center rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white">
        {PUBLIC_CTA}
      </Link>
    </div>
  );
}
