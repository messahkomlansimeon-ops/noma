"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { ApiError, api, describeApiError, isUuid, type WalletTopup } from "@/lib/client/api";
import { safeNextPath } from "@/lib/client/session";
import {
  CHECKOUT_MESSAGES,
  SIMULATION_BANNER,
  SIMULATION_SUBTITLE,
  WALLET_PATH,
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

const linkClass = "flex w-full items-center justify-center rounded-xl px-4 py-3.5 text-[15px] font-bold transition active:scale-[0.99]";

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
        className="sticky top-0 z-20 flex items-center justify-center gap-2 bg-carrot px-4 py-3.5 text-center text-[15px] font-extrabold uppercase tracking-wide text-white"
      >
        <TriangleAlert className="size-5 shrink-0" aria-hidden />
        {SIMULATION_BANNER}
      </div>

      <div className="px-4 pb-10 pt-5">
        <h1 className="font-display text-[26px] font-extrabold text-ink">Paiement simulé</h1>
        <p className="mt-1 text-[13px] text-ink-soft">{SIMULATION_SUBTITLE}</p>

        {view.kind === "loading" ? (
          <p className="mt-8 text-center text-[14px] text-ink-soft" aria-busy="true">
            Chargement de la recharge…
          </p>
        ) : null}

        {view.kind === "pending" ? (
          <>
            <div className="mt-5 rounded-2xl border border-line bg-white p-5 text-center">
              <div className="text-[13px] font-semibold text-ink-soft">Montant de la recharge</div>
              <div data-testid="sim-amount" className="font-display text-[38px] font-extrabold leading-tight text-ink">
                {view.amountText}
              </div>
            </div>
            {actionError ? (
              <p role="alert" data-testid="sim-action-error" className="mt-3 rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">
                {actionError}
              </p>
            ) : null}
            <button
              data-testid="sim-confirm"
              onClick={() => void act("confirm")}
              disabled={busy !== null}
              className="mt-5 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "confirm" ? "Paiement en cours…" : "Confirmer le paiement"}
            </button>
            <button
              data-testid="sim-fail"
              onClick={() => void act("fail")}
              disabled={busy !== null}
              className="mt-3 flex w-full items-center justify-center rounded-xl border border-carrot/50 bg-white px-4 py-3.5 text-[15px] font-bold text-carrot-ink transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "fail" ? "Échec en cours…" : "Faire échouer le paiement"}
            </button>
          </>
        ) : null}

        {view.kind === "succeeded" ? (
          <div className="mt-5">
            <div data-testid="sim-result" data-kind="succeeded" role="status" className="rounded-2xl border border-forest/30 bg-sage p-5 text-center">
              <CircleCheck className="mx-auto size-9 text-forest" aria-hidden />
              <p className="mt-2 text-[16px] font-extrabold text-forest">{view.message}</p>
            </div>
            <Link data-testid="sim-return" href={target} className={`${linkClass} mt-5 bg-forest text-white`}>
              {returnLinkLabel(target)}
            </Link>
            {target !== WALLET_PATH ? (
              <Link href={WALLET_PATH} className={`${linkClass} mt-3 border border-forest/30 bg-white text-forest`}>
                Voir mon porte-monnaie
              </Link>
            ) : null}
          </div>
        ) : null}

        {view.kind === "failed" || view.kind === "expired" ? (
          <div className="mt-5">
            <div data-testid="sim-result" data-kind={view.kind} role="status" className="rounded-2xl border border-carrot/40 bg-carrot-soft p-5 text-center">
              <CircleX className="mx-auto size-9 text-carrot-ink" aria-hidden />
              <p className="mt-2 text-[15px] font-extrabold text-carrot-ink">{view.message}</p>
              <p className="mt-1 text-[13px] text-ink-soft">Montant de la recharge : {view.amountText}.</p>
            </div>
            <Link data-testid="sim-retry" href={retryHref} className={`${linkClass} mt-5 bg-forest text-white`}>
              Réessayer la recharge
            </Link>
            <Link href={target} className={`${linkClass} mt-3 border border-forest/30 bg-white text-forest`}>
              {returnLinkLabel(target) === "Continuer" ? "Retour" : returnLinkLabel(target)}
            </Link>
          </div>
        ) : null}

        {view.kind === "unavailable" || view.kind === "not_found" || view.kind === "error" ? (
          <div className="mt-5">
            <div data-testid="sim-result" data-kind={view.kind} role="alert" className="rounded-2xl border border-line bg-white p-5 text-center">
              <p className="text-[15px] font-bold text-ink">{view.message}</p>
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
    <Paiement topupId={topupId} />
  ) : (
    <main className="flex flex-1 flex-col">
      <div className="bg-carrot px-4 py-3.5 text-center text-[15px] font-extrabold uppercase tracking-wide text-white">
        {SIMULATION_BANNER}
      </div>
      <p role="alert" className="mt-6 px-4 text-center text-[14px] font-semibold text-ink">
        {CHECKOUT_MESSAGES.notFound}
      </p>
    </main>
  );
}

export default function PaiementSimulePage() {
  // Plein écran mobile, sans barre d'onglets (on ne « quitte » pas un paiement par un onglet). Pas de layout propre à cette route.
  // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
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
