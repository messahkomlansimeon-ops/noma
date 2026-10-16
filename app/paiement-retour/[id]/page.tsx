"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RotateCw, Wallet } from "lucide-react";
import { ArtAlert, ArtCheck, ArtWallet } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Skeleton } from "@/components/ui";
import { ApiError, api, isUuid, type WalletTopup } from "@/lib/client/api";
import {
  RETURN_POLL_INTERVAL_MS,
  RETURN_POLL_WINDOW_MS,
  WALLET_PATH,
  WAVE_LABEL,
  parseReturnResult,
  returnView,
  walletHref,
} from "@/lib/client/wallet-view";

const linkClass = "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[16px] font-bold";
const PRIMARY = "bg-brand text-white hover:bg-brand-deep";
const OUTLINE = "border-2 border-line-strong bg-white text-ink hover:border-brand hover:text-brand";

/**
 * Retour du navigateur après le paiement Wave (lot PAY1) : AFFICHAGE SEULEMENT. Cette page ne crédite JAMAIS : elle relit l'état de la recharge sur le serveur (qui ne change que sur
 * confirmation authentifiée de Sublymus : webhook ou rattrapage) et dit « Paiement en cours de confirmation » tant qu'elle est en attente. Le paramètre `resultat` de l'adresse
 * (succes ou echec) ne change qu'une phrase d'explication.
 */
function Retour({ topupId }: { topupId: string }) {
  const searchParams = useSearchParams();
  const resultat = parseReturnResult(searchParams.get("resultat"));
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [topup, setTopup] = useState<WalletTopup | null>(null);
  const [failure, setFailure] = useState<{ status: number; code: string } | null>(null);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      api.wallet.topup(topupId, { signal: controller.signal }).then(
        (fresh) => {
          setTopup(fresh);
          setFailure(null);
          if (fresh.status !== "pending") return;
          if (Date.now() - startedAt >= RETURN_POLL_WINDOW_MS) {
            setWaitedTooLong(true);
            return;
          }
          timer = setTimeout(read, RETURN_POLL_INTERVAL_MS);
        },
        (error) => {
          if (controller.signal.aborted || redirectIfUnauthorized(error)) return;
          setFailure(error instanceof ApiError ? { status: error.status, code: error.code } : { status: 0, code: "unexpected" });
        },
      );
    };
    read();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [topupId, reloadKey, redirectIfUnauthorized]);

  const view = returnView({ topup, failure, resultat, waitedTooLong });

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex flex-col gap-4 px-4 pb-10 pt-6">
        <h1 className="flex items-center gap-2.5 text-[26px] font-extrabold tracking-tight text-ink">
          <Wallet className="size-7 text-brand" aria-hidden />
          {WAVE_LABEL}
        </h1>
        {view.kind === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">Vérification du paiement…</span>
            <Skeleton className="h-40 w-full rounded-3xl" />
            <Skeleton className="h-12 w-full rounded-2xl" />
          </div>
        ) : null}

        {view.kind === "pending" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="return-result" data-kind="pending" role="status" className="animate-rise flex flex-col items-center gap-2 rounded-3xl border border-line bg-white p-5 text-center">
              <ArtWallet className="size-28" />
              <p data-testid="return-title" className="text-[17px] font-extrabold text-ink">{view.title}</p>
              <p className="text-[14px] text-ink-soft">{view.detail}</p>
              <p data-testid="return-amount" className="text-[16px] font-bold text-ink">Montant : {view.amountText}</p>
            </div>
            <Link href={WALLET_PATH} className={`${linkClass} ${OUTLINE}`}>
              Voir mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "succeeded" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="return-result" data-kind="succeeded" role="status" className="animate-rise flex flex-col items-center gap-2 rounded-3xl bg-success-soft p-5 text-center">
              <ArtCheck className="size-28" />
              <p data-testid="return-title" className="text-[18px] font-extrabold text-success-ink">{view.title}</p>
              <p className="text-[14px] text-ink-soft">{view.detail}</p>
            </div>
            <Link data-testid="return-wallet" href={WALLET_PATH} className={`${linkClass} ${PRIMARY}`}>
              Voir mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "failed" || view.kind === "expired" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="return-result" data-kind={view.kind} role="status" className="animate-rise flex flex-col items-center gap-2 rounded-3xl bg-accent-soft p-5 text-center">
              <ArtAlert className="size-28" />
              <p data-testid="return-title" className="text-[17px] font-extrabold text-accent-ink">{view.title}</p>
              <p className="text-[14px] text-ink-soft">{view.detail}</p>
            </div>
            <Link data-testid="return-retry" href={walletHref({ recharge: true })} className={`${linkClass} ${PRIMARY}`}>
              <RotateCw className="size-5" aria-hidden />
              Recommencer la recharge
            </Link>
            <Link href={WALLET_PATH} className={`${linkClass} ${OUTLINE}`}>
              Retour à mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "not_found" || view.kind === "error" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="return-result" data-kind={view.kind} role="alert" className="animate-rise flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-5 text-center">
              <ArtAlert className="size-24" />
              <p className="text-[16px] font-bold text-ink">{view.detail}</p>
            </div>
            {view.kind === "error" ? (
              <button
                onClick={() => {
                  setFailure(null);
                  setReloadKey((key) => key + 1);
                }}
                className={`${linkClass} ${PRIMARY}`}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </button>
            ) : null}
            <Link href={WALLET_PATH} className={`${linkClass} ${OUTLINE}`}>
              Retour à mon porte-monnaie
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function PageContent() {
  const params = useParams<{ id: string }>();
  const topupId = typeof params.id === "string" ? params.id : "";
  return isUuid(topupId) ? (
    <Retour topupId={topupId} />
  ) : (
    <main className="flex flex-1 flex-col">
      <div role="alert" className="flex flex-col items-center gap-3 px-4 pt-8 text-center">
        <ArtAlert className="size-28" />
        <p className="text-[16px] font-bold text-ink">Cette recharge est introuvable.</p>
      </div>
    </main>
  );
}

export default function PaiementRetourPage() {
  // Plein écran mobile, sans barre d'onglets, comme la page de paiement simulé. useSearchParams exige une frontière Suspense.
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <SessionGate>
        <Suspense fallback={null}>
          <PageContent />
        </Suspense>
      </SessionGate>
    </div>
  );
}
