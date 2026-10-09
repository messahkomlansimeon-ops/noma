"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, Gift, Upload, Wallet } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { ApiError, api, describeApiError } from "@/lib/client/api";
import { createGenerationGuard } from "@/lib/client/match-view";
import type { SubscriptionState } from "@/lib/client/pro-api";
import { proApi } from "@/lib/client/pro-api";
import {
  IMPORT_PAGE_PATH, NO_REFUND_NOTE, PRICES_PROVISIONAL_NOTICE, PRO_PAGE_TITLE, PROMO_CREDITS_RULES, SUBSCRIBE_LABELS, canSubscribe, comparisonRows, noticeView, planPriceText,
  promoView, statusView, subscribableLabelFor, subscribeConfirmationText, subscribeState, subscribablePlan,
} from "@/lib/client/pro-view";
import { browserSessionStorage, createIdempotencyKeys, formatFcfa, newIdempotencyKey, walletHref } from "@/lib/client/wallet-view";

const SUBSCRIBE_KEY_PREFIX = "noma:subscribe-key:";
const TONE_CLASS = { good: "border-forest/30 bg-sage", neutral: "border-line bg-white", warn: "border-carrot/50 bg-carrot-soft" } as const;

/** Écran « Offre Pro » du vendeur : comparaison aux prix provisoires, souscription avec les crédits, état, renouvellement, annulation, crédits promotionnels, avis. */
export function ProOfferScreen() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Verrou synchrone : un second appui avant le prochain rendu n'envoie rien de plus.
  const submitting = useRef(false);
  const keys = useRef(createIdempotencyKeys(newIdempotencyKey, browserSessionStorage(), SUBSCRIBE_KEY_PREFIX));
  const guard = useRef(createGenerationGuard());

  useEffect(() => {
    const controller = new AbortController();
    const token = guard.current.begin();
    Promise.allSettled([proApi.subscription.state({ signal: controller.signal }), api.wallet.overview({ limit: 1 }, { signal: controller.signal })]).then(([stateResult, walletResult]) => {
      if (controller.signal.aborted || !guard.current.isCurrent(token)) return;
      if (stateResult.status === "rejected") {
        if (redirectIfUnauthorized(stateResult.reason)) return;
        setLoadError(describeApiError(stateResult.reason, "subscription"));
        return;
      }
      setState(stateResult.value);
      setBalance(walletResult.status === "fulfilled" ? walletResult.value.balanceXof : null);
      setLoadError(null);
    });
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  // Les avis affichés ici sont marqués lus (une seule fois par ouverture).
  useEffect(() => {
    if (state === null || state.unreadNotices === 0) return;
    void proApi.subscription.markNoticesRead({ all: true }).catch(() => undefined);
  }, [state]);

  const plan = state ? subscribablePlan(state.plans) : null;
  const subscribe = state === null ? { kind: "none" as const } : subscribeState({ plan, balanceXof: balance });

  const run = useCallback(async (action: () => Promise<SubscriptionState>, successText: string) => {
    if (submitting.current) return false;
    submitting.current = true;
    setPending(true);
    setActionError(null);
    setDone(null);
    try {
      const next = await action();
      setState(next);
      setDone(successText);
      return true;
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return false;
      setActionError(describeApiError(failure, "subscription"));
      // Un refus définitif (déjà abonné, plus d'abonnement, période terminée) : l'écran est relu.
      if (failure instanceof ApiError && failure.status === 409 && failure.code !== "insufficient_balance") setReloadKey((key) => key + 1);
      // Le prix a changé : la confirmation se ferme, l'acheteur relit le nouveau prix avant de confirmer.
      if (failure instanceof ApiError && failure.code === "price_changed") setConfirming(false);
      return false;
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }, [redirectIfUnauthorized]);

  const confirmSubscribe = async () => {
    if (!plan || subscribe.kind !== "ready") return;
    // Le prix envoyé est celui que la confirmation AFFICHE : si le tarif a changé entre-temps, le serveur refuse (`price_changed`, aucun débit) et l'écran se recharge.
    const displayedPriceXof = subscribe.priceXof;
    // Une clé par tentative, conservée dans l'onglet : un nouvel essai réseau réutilise la MÊME clé (jamais deux débits).
    const key = keys.current.keyFor(plan.code);
    const ok = await run(async () => {
      const result = await proApi.subscription.subscribe({ planCode: plan.code, idempotencyKey: key, expectedPriceXof: displayedPriceXof });
      return result.state;
    }, "Votre abonnement est actif. Bienvenue dans l'offre Pro !");
    if (ok) {
      keys.current.forget(plan.code);
      setConfirming(false);
      const overview = await api.wallet.overview({ limit: 1 }).catch(() => null);
      setBalance(overview ? overview.balanceXof : null);
    }
  };

  const toggleRenewal = (autoRenew: boolean) =>
    void run(() => proApi.subscription.setAutoRenew(autoRenew), autoRenew ? "Le renouvellement automatique est réactivé." : "Le renouvellement automatique est désactivé : votre offre prend fin à la fin de la période.");

  return (
    <main>
      <TopBar back="/vendeur/profil" title={PRO_PAGE_TITLE} />
      <div className="px-4 pb-8">
        {loadError ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{loadError}</p>
            <button onClick={() => { setLoadError(null); setReloadKey((key) => key + 1); }} className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white">
              Réessayer
            </button>
          </div>
        ) : state === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">Chargement de votre offre…</p>
        ) : (
          <>
            {state.notices.slice(0, 5).map((notice) => {
              const view = noticeView(notice, undefined, state.current.maxOnlineOffers);
              return (
                <section key={notice.id} data-testid="pro-notice" data-code={notice.code} className="mt-4 rounded-2xl border border-carrot/50 bg-carrot-soft p-4">
                  <div className="text-[14px] font-extrabold text-carrot-ink">{view.title}</div>
                  <p className="mt-1 text-[13px] text-carrot-ink">{view.detail}</p>
                  <div className="mt-1 text-[12px] text-carrot-ink/80">{view.dateText}</div>
                </section>
              );
            })}

            {(() => {
              const status = statusView(state);
              return (
                <section data-testid="pro-status" data-tone={status.tone} data-source={state.current.source} className={`mt-4 rounded-2xl border p-4 ${TONE_CLASS[status.tone]}`}>
                  <div className="flex items-center gap-2 text-[16px] font-extrabold text-ink">
                    {state.current.source === "subscription" ? <BadgeCheck className="size-5 text-forest" aria-hidden /> : null}
                    {status.title}
                  </div>
                  <ul className="mt-1.5 space-y-1 text-[13px] text-ink-soft">
                    {status.lines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  {state.subscription ? (
                    <button
                      data-testid="pro-toggle-renewal"
                      onClick={() => toggleRenewal(!state.subscription!.autoRenew)}
                      disabled={pending}
                      className="mt-3 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white px-4 py-3 text-[14px] font-bold text-forest disabled:opacity-50"
                    >
                      {pending ? SUBSCRIBE_LABELS.working : state.subscription.autoRenew ? SUBSCRIBE_LABELS.disableRenewal : SUBSCRIBE_LABELS.enableRenewal}
                    </button>
                  ) : null}
                  {state.subscription?.autoRenew ? <p className="mt-2 text-[12px] text-ink-soft">{NO_REFUND_NOTE}</p> : null}
                </section>
              );
            })()}

            {(() => {
              const promo = promoView(state.promo);
              return (
                <section data-testid="pro-promo" className="mt-3 rounded-2xl border border-line bg-white p-4">
                  <div className="flex items-center gap-2 text-[14px] font-extrabold text-ink">
                    <Gift className="size-4 text-forest" aria-hidden />
                    Crédits promotionnels
                  </div>
                  <div data-testid="pro-promo-amount" className="mt-1 font-display text-[26px] font-extrabold text-ink">{promo.amountText}</div>
                  {promo.expiryText ? <div data-testid="pro-promo-expiry" className="text-[13px] text-ink-soft">{promo.expiryText}</div> : null}
                  <p className="mt-2 text-[12px] text-ink-soft">{PROMO_CREDITS_RULES}</p>
                </section>
              );
            })()}

            {state.current.entitlements.includes("catalog_import") ? (
              <Link
                href={IMPORT_PAGE_PATH}
                data-testid="pro-import-link"
                className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-white p-4 text-[14px] font-bold text-ink"
              >
                <Upload className="size-5 text-forest" aria-hidden />
                Importer un catalogue (fichier CSV)
              </Link>
            ) : null}

            <h2 className="mt-6 text-[16px] font-extrabold text-ink">Gratuit ou Pro</h2>
            <p data-testid="pro-prices-notice" className="mt-1 rounded-lg bg-carrot-soft px-3 py-2 text-[12px] font-semibold text-carrot-ink">{PRICES_PROVISIONAL_NOTICE}</p>
            <table data-testid="pro-plan-table" className="mt-3 w-full overflow-hidden rounded-2xl border border-line bg-white text-left text-[13px]">
              <thead>
                <tr className="bg-wash text-ink-soft">
                  <th className="px-3 py-2 font-bold" scope="col"><span className="sr-only">Critère</span></th>
                  {state.plans.map((entry) => <th key={entry.code} scope="col" className="px-3 py-2 font-extrabold text-ink">{entry.name}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {comparisonRows(state.plans).map((row) => (
                  <tr key={row.key} data-testid={`pro-row-${row.key}`}>
                    <th scope="row" className="px-3 py-2 font-semibold text-ink">{row.label}</th>
                    {row.values.map((value, index) => <td key={`${row.key}-${state.plans[index].code}`} className="px-3 py-2 text-ink">{value}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>

            {!state.subscription && plan ? (
              <section className="mt-4">
                {subscribe.kind === "balance_unknown" ? (
                  <p role="alert" className="rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">Votre solde n&apos;a pas pu être lu : l&apos;abonnement est impossible pour le moment.</p>
                ) : null}
                {subscribe.kind === "insufficient" ? (
                  <div data-testid="pro-insufficient" className="rounded-xl bg-carrot-soft p-3 text-[13px] text-carrot-ink">
                    <div className="font-extrabold">{subscribe.text}</div>
                    <p className="mt-0.5">{subscribe.detail}</p>
                    <Link href={walletHref({ next: "/vendeur/offre-pro", recharge: true })} data-testid="pro-recharge" className="mt-2 inline-flex items-center gap-1.5 font-bold underline">
                      <Wallet className="size-4" aria-hidden />
                      {SUBSCRIBE_LABELS.recharge}
                    </Link>
                  </div>
                ) : null}
                {!confirming ? (
                  <button
                    data-testid="pro-subscribe"
                    onClick={() => { setActionError(null); setDone(null); setConfirming(true); }}
                    disabled={!canSubscribe(subscribe, pending)}
                    className="mt-3 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {subscribableLabelFor(plan)}
                  </button>
                ) : subscribe.kind === "ready" ? (
                  <div data-testid="pro-confirmation" className="mt-3 rounded-2xl border border-forest/30 bg-sage p-4">
                    <p className="text-[14px] font-semibold text-ink">{subscribeConfirmationText(subscribe)}</p>
                    <p className="mt-1 text-[12px] text-ink-soft">{planPriceText(plan)}. {PRICES_PROVISIONAL_NOTICE}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        data-testid="pro-confirm"
                        onClick={() => void confirmSubscribe()}
                        disabled={pending}
                        className="flex-1 rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50"
                      >
                        {pending ? SUBSCRIBE_LABELS.confirming : SUBSCRIBE_LABELS.confirm}
                      </button>
                      <button onClick={() => setConfirming(false)} disabled={pending} className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
                        {SUBSCRIBE_LABELS.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {actionError ? <p role="alert" data-testid="pro-error" className="mt-3 rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">{actionError}</p> : null}
            {done ? <p role="status" data-testid="pro-done" className="mt-3 rounded-xl bg-sage p-3 text-[13px] font-semibold text-forest">{done}</p> : null}
            <p className="mt-4 text-[12px] text-ink-soft">Solde en crédits : {balance === null ? "inconnu" : <span data-testid="pro-balance">{formatFcfa(balance)}</span>}</p>
          </>
        )}
      </div>
    </main>
  );
}
