"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, RotateCw, ShieldCheck, TriangleAlert, Wallet } from "lucide-react";
import { ArtAlert, ArtCheck, ArtWallet } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Skeleton } from "@/components/ui";
import { ApiError, api, describeApiError, isUuid, type WalletTopup } from "@/lib/client/api";
import { safeNextPath } from "@/lib/client/session";
import {
  CHECKOUT_MESSAGES,
  SIMULATION_BANNER,
  SIMULATION_SUBTITLE,
  walletPathFor,
  checkoutView,
  createTopupKeys,
  returnLinkLabel,
  returnTarget,
  walletHref,
  type CheckoutFailure,
} from "@/lib/client/wallet-view";

type Action = "confirm" | "fail";

type ReadResult = { ok: true; topup: WalletTopup } | { ok: false; error: unknown };

/** Lecture de la recharge sur le serveur (aucun état React ici : l'appelant décide de ce qu'il en fait). */
async function readTopup(topupId: string, signal?: AbortSignal): Promise<ReadResult> {
  try {
    return { ok: true, topup: await api.wallet.topup(topupId, { signal }) };
  } catch (error) {
    return { ok: false, error };
  }
}

function failureOf(error: unknown): CheckoutFailure {
  return error instanceof ApiError ? { status: error.status, code: error.code } : { status: 0, code: "unexpected" };
}

const linkClass = "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[16px] font-bold";
const PRIMARY = "bg-brand text-white hover:bg-brand-deep";
const OUTLINE = "border-2 border-line-strong bg-white text-ink hover:border-brand hover:text-brand";

/** Page du prestataire de paiement SIMULÉ : l'utilisateur choisit l'issue ; l'état affiché est celui LU sur le serveur. */
function Paiement({ topupId }: { topupId: string }) {
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  // Retour nettoyé : jamais la valeur brute de l'adresse (une URL étrangère ramène à l'écran du porte-monnaie).
  const target = returnTarget(rawNext);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [topup, setTopup] = useState<WalletTopup | null>(null);
  const [failure, setFailure] = useState<CheckoutFailure | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Cette page a VU la recharge en attente : c'est elle qu'on vient de payer (sinon, « déjà terminée avant cette visite », jamais « crédité »).
  const [sawPending, setSawPending] = useState(false);
  // Verrou synchrone : deux appuis rapprochés ne lancent jamais deux événements.
  const busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    readTopup(topupId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setTopup(result.topup);
        setFailure(null);
        if (result.topup.status === "pending") setSawPending(true);
        return;
      }
      if (redirectIfUnauthorized(result.error)) return;
      setFailure(failureOf(result.error));
    });
    return () => controller.abort();
  }, [topupId, reloadKey, redirectIfUnauthorized]);

  const act = async (action: Action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setActionError(null);
    try {
      if (action === "confirm") await api.devPayments.confirm(topupId);
      else await api.devPayments.fail(topupId);
    } catch (error) {
      if (redirectIfUnauthorized(error)) {
        busyRef.current = false;
        return;
      }
      // 404 : les routes de simulation n'existent pas (prestataire fictif inactif) ; sinon message fixe.
      setActionError(error instanceof ApiError && error.status === 404 ? CHECKOUT_MESSAGES.unavailable : describeApiError(error, "wallet"));
    }
    // L'état affiché est TOUJOURS relu sur le serveur, jamais déduit du bouton appuyé.
    const result = await readTopup(topupId);
    if (result.ok) {
      setTopup(result.topup);
      setFailure(null);
      if (result.topup.status === "pending") setSawPending(true);
    } else if (!redirectIfUnauthorized(result.error)) {
      setFailure(failureOf(result.error));
    }
    busyRef.current = false;
    setBusy(null);
  };

  // Recharge terminée (réussie, échouée ou expirée) : la clé d'idempotence de ce montant n'a plus d'objet, la prochaine recharge en aura une neuve.
  const finishedAmount = topup && topup.status !== "pending" ? topup.amountXof : null;
  useEffect(() => {
    if (finishedAmount !== null) createTopupKeys().forget(String(finishedAmount));
  }, [finishedAmount]);

  const view = checkoutView({ topup, failure, paidHere: sawPending });
  const retryHref = walletHref({ next: safeNextPath(rawNext, ""), recharge: true });

  return (
    <main className="flex flex-1 flex-col">
      <div
        data-testid="sim-banner"
        role="note"
        className="sticky top-0 z-20 flex items-center justify-center gap-2 rounded-b-3xl bg-accent px-4 py-3.5 text-center text-[15px] font-extrabold uppercase tracking-wide text-ink"
      >
        <TriangleAlert className="size-5 shrink-0" aria-hidden />
        {SIMULATION_BANNER}
      </div>

      <div className="flex flex-col gap-4 px-4 pb-10 pt-5">
        <h1 className="flex items-center gap-2.5 text-[26px] font-extrabold tracking-tight text-ink">
          <Wallet className="size-7 text-brand" aria-hidden />
          Paiement simulé
        </h1>
        <p className="flex items-start gap-2.5 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
          {SIMULATION_SUBTITLE}
        </p>

        {view.kind === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">Chargement de la recharge…</span>
            <Skeleton className="h-40 w-full rounded-3xl" />
            <Skeleton className="h-12 w-full rounded-2xl" />
          </div>
        ) : null}

        {view.kind === "pending" ? (
          <>
            <div className="animate-rise flex flex-col items-center gap-2 rounded-3xl border border-line bg-white p-5 text-center">
              <ArtWallet className="size-28" />
              <div className="text-[14px] font-semibold text-ink-soft">Montant de la recharge</div>
              <div data-testid="sim-amount" className="text-[40px] font-extrabold leading-tight text-ink">
                {view.amountText}
              </div>
            </div>
            {actionError ? (
              <p role="alert" data-testid="sim-action-error" className="flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[14px] font-semibold text-danger-ink">
                <TriangleAlert className="size-5 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <button
                data-testid="sim-confirm"
                onClick={() => void act("confirm")}
                disabled={busy !== null}
                className={`${linkClass} ${PRIMARY} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <CircleCheck className="size-5" aria-hidden />
                {busy === "confirm" ? "Paiement en cours…" : "Confirmer le paiement"}
              </button>
              <button
                data-testid="sim-fail"
                onClick={() => void act("fail")}
                disabled={busy !== null}
                className={`${linkClass} border-2 border-danger bg-white text-danger-ink hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <CircleX className="size-5" aria-hidden />
                {busy === "fail" ? "Échec en cours…" : "Faire échouer le paiement"}
              </button>
            </div>
          </>
        ) : null}

        {view.kind === "succeeded" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="sim-result" data-kind="succeeded" role="status" className="animate-rise flex flex-col items-center gap-2 rounded-3xl bg-success-soft p-5 text-center">
              <ArtCheck className="size-28" />
              <p className="text-[18px] font-extrabold text-success-ink">{view.message}</p>
            </div>
            <Link data-testid="sim-return" href={target} className={`${linkClass} ${PRIMARY}`}>
              {returnLinkLabel(target)}
            </Link>
            {target !== walletPathFor(target) ? (
              <Link href={walletPathFor(target)} className={`${linkClass} ${OUTLINE}`}>
                Voir mon porte-monnaie
              </Link>
            ) : null}
          </div>
        ) : null}

        {view.kind === "failed" || view.kind === "expired" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="sim-result" data-kind={view.kind} role="status" className="animate-rise flex flex-col items-center gap-2 rounded-3xl bg-accent-soft p-5 text-center">
              <ArtAlert className="size-28" />
              <p className="text-[17px] font-extrabold text-accent-ink">{view.message}</p>
              <p className="text-[14px] text-ink-soft">Montant de la recharge : {view.amountText}.</p>
            </div>
            <Link data-testid="sim-retry" href={retryHref} className={`${linkClass} ${PRIMARY}`}>
              <RotateCw className="size-5" aria-hidden />
              Réessayer la recharge
            </Link>
            <Link href={target} className={`${linkClass} ${OUTLINE}`}>
              {returnLinkLabel(target) === "Continuer" ? "Retour" : returnLinkLabel(target)}
            </Link>
          </div>
        ) : null}

        {view.kind === "unavailable" || view.kind === "not_found" || view.kind === "error" ? (
          <div className="flex flex-col gap-3">
            <div data-testid="sim-result" data-kind={view.kind} role="alert" className="animate-rise flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-5 text-center">
              <ArtAlert className="size-24" />
              <p className="text-[16px] font-bold text-ink">{view.message}</p>
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
            <Link href={walletPathFor(target)} className={`${linkClass} ${OUTLINE}`}>
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
    <Paiement topupId={topupId} />
  ) : (
    <main className="flex flex-1 flex-col">
      <div className="flex items-center justify-center gap-2 rounded-b-3xl bg-accent px-4 py-3.5 text-center text-[15px] font-extrabold uppercase tracking-wide text-ink">
        <TriangleAlert className="size-5 shrink-0" aria-hidden />
        {SIMULATION_BANNER}
      </div>
      <div role="alert" className="flex flex-col items-center gap-3 px-4 pt-8 text-center">
        <ArtAlert className="size-28" />
        <p className="text-[16px] font-bold text-ink">{CHECKOUT_MESSAGES.notFound}</p>
      </div>
    </main>
  );
}

export default function PaiementSimulePage() {
  // Plein écran mobile, sans barre d'onglets (on ne « quitte » pas un paiement par un onglet). Pas de layout propre à cette route.
  // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
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
