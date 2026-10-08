"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CircleCheck, CircleX, Hourglass } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
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

const linkClass = "flex w-full items-center justify-center rounded-xl px-4 py-3.5 text-[15px] font-bold transition active:scale-[0.99]";

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
      <div className="px-4 pb-10 pt-6">
        <h1 className="font-display text-[26px] font-extrabold text-ink">{WAVE_LABEL}</h1>
        {view.kind === "loading" ? (
          <p className="mt-8 text-center text-[14px] text-ink-soft" aria-busy="true">
            Vérification du paiement…
          </p>
        ) : null}

        {view.kind === "pending" ? (
          <div className="mt-5">
            <div data-testid="return-result" data-kind="pending" role="status" className="rounded-2xl border border-line bg-white p-5 text-center">
              <Hourglass className="mx-auto size-9 text-ink-soft" aria-hidden />
              <p data-testid="return-title" className="mt-2 text-[16px] font-extrabold text-ink">{view.title}</p>
              <p className="mt-1 text-[13px] text-ink-soft">{view.detail}</p>
              <p data-testid="return-amount" className="mt-2 text-[13px] font-semibold text-ink">Montant : {view.amountText}</p>
            </div>
            <Link href={WALLET_PATH} className={`${linkClass} mt-5 border border-forest/30 bg-white text-forest`}>
              Voir mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "succeeded" ? (
          <div className="mt-5">
            <div data-testid="return-result" data-kind="succeeded" role="status" className="rounded-2xl border border-forest/30 bg-sage p-5 text-center">
              <CircleCheck className="mx-auto size-9 text-forest" aria-hidden />
              <p data-testid="return-title" className="mt-2 text-[16px] font-extrabold text-forest">{view.title}</p>
              <p className="mt-1 text-[13px] text-ink-soft">{view.detail}</p>
            </div>
            <Link data-testid="return-wallet" href={WALLET_PATH} className={`${linkClass} mt-5 bg-forest text-white`}>
              Voir mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "failed" || view.kind === "expired" ? (
          <div className="mt-5">
            <div data-testid="return-result" data-kind={view.kind} role="status" className="rounded-2xl border border-carrot/40 bg-carrot-soft p-5 text-center">
              <CircleX className="mx-auto size-9 text-carrot-ink" aria-hidden />
              <p data-testid="return-title" className="mt-2 text-[15px] font-extrabold text-carrot-ink">{view.title}</p>
              <p className="mt-1 text-[13px] text-ink-soft">{view.detail}</p>
            </div>
            <Link data-testid="return-retry" href={walletHref({ recharge: true })} className={`${linkClass} mt-5 bg-forest text-white`}>
              Recommencer la recharge
            </Link>
            <Link href={WALLET_PATH} className={`${linkClass} mt-3 border border-forest/30 bg-white text-forest`}>
              Retour à mon porte-monnaie
            </Link>
          </div>
        ) : null}

        {view.kind === "not_found" || view.kind === "error" ? (
          <div className="mt-5">
            <div data-testid="return-result" data-kind={view.kind} role="alert" className="rounded-2xl border border-line bg-white p-5 text-center">
              <p className="text-[15px] font-bold text-ink">{view.detail}</p>
            </div>
            {view.kind === "error" ? (
              <button
                onClick={() => {
                  setFailure(null);
                  setReloadKey((key) => key + 1);
                }}
                className={`${linkClass} mt-5 bg-forest text-white`}
              >
                Réessayer
              </button>
            ) : null}
            <Link href={WALLET_PATH} className={`${linkClass} mt-3 border border-forest/30 bg-white text-forest`}>
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
      <p role="alert" className="mt-6 px-4 text-center text-[14px] font-semibold text-ink">
        Cette recharge est introuvable.
      </p>
    </main>
  );
}

export default function PaiementRetourPage() {
  // Plein écran mobile, sans barre d'onglets, comme la page de paiement simulé. useSearchParams exige une frontière Suspense.
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-cream sm:border-x sm:border-line">
      <SessionGate>
        <Suspense fallback={null}>
          <PageContent />
        </Suspense>
      </SessionGate>
    </div>
  );
}
