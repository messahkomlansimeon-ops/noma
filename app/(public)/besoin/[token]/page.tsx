"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { ArtAlert, ArtSearch } from "@/components/illustrations";
import { LogoMark } from "@/components/logo";
import { Badge, IconTile, Skeleton } from "@/components/ui";
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
        <div aria-busy="true" className="mt-4 flex flex-col gap-4">
          <span className="sr-only">{PUBLIC_LOADING}</span>
          <Skeleton className="h-48 w-full rounded-[2rem]" />
          <Skeleton className="h-24 w-full rounded-3xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      ) : state.kind === "ready" ? (
        <Need need={state.need} />
      ) : (
        <div role="alert" data-testid="shared-dead" className="animate-rise mt-8 flex flex-col items-center gap-4 text-center">
          <ArtAlert />
          <p className="text-[17px] font-bold leading-snug text-ink">
            {state.kind === "dead" ? PUBLIC_DEAD : "Le service est temporairement indisponible. Réessayez dans un instant."}
          </p>
        </div>
      )}
    </main>
  );
}

function Need({ need }: { need: PublicNeed }) {
  const view = publicNeedLines(need);
  return (
    <div className="flex flex-col gap-4">
      <section className="animate-rise flex flex-col items-center gap-3 rounded-[2rem] bg-brand-soft px-5 pb-6 pt-6 text-center">
        <ArtSearch className="size-36" />
        <Badge tone="carrot">{PUBLIC_TITLE}</Badge>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink">{view.title}</h1>
      </section>
      <ul className="stagger flex flex-col gap-2 rounded-3xl border border-line bg-white p-4 text-[16px] text-ink" aria-label="Le besoin">
        {view.lines.length === 0 ? (
          <li className="text-ink-soft">Aucun autre détail.</li>
        ) : (
          view.lines.map((line) => (
            <li key={line} className="flex items-start gap-3">
              <span aria-hidden className="mt-2 size-2.5 shrink-0 rounded-full bg-accent" />
              {line}
            </li>
          ))
        )}
      </ul>
      <p className="flex items-start gap-3 rounded-3xl bg-mist p-4 text-[14px] font-semibold leading-snug text-ink-soft">
        <IconTile icon={ShieldCheck} tone="success" className="size-10" />
        <span className="min-w-0 self-center">{PUBLIC_NOTE}</span>
      </p>
      <Link
        href="/vendeur/annonces/nouvelle"
        data-testid="shared-cta"
        className="press flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[17px] font-bold text-white hover:bg-brand-deep"
      >
        {PUBLIC_CTA}
        <ArrowRight className="size-5" aria-hidden />
      </Link>
    </div>
  );
}
