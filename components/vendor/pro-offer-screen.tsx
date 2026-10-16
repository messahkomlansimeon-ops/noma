"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, BellRing, ChevronRight, CircleCheck, Crown, Gift, Loader2, Scale, Upload, Wallet } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { IconTile } from "@/components/ui";
import { BTN_OUTLINE, BTN_PRIMARY, ErrorState, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
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
const TONE_CLASS = { good: "border-brand/30 bg-brand-soft", neutral: "border-line bg-white", warn: "border-accent/50 bg-accent-soft" } as const;
const TONE_ICON = { good: "success", neutral: "mist", warn: "accent" } as const;

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
      <div className="px-4 pb-8 pt-2">
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoadError(null); setReloadKey((key) => key + 1); }} />
        ) : state === null ? (
          <LoadingBlock label="Chargement de votre offre…" />
        ) : (
          <div className="stagger flex flex-col gap-4">
            {state.notices.slice(0, 5).map((notice) => {
              const view = noticeView(notice, undefined, state.current.maxOnlineOffers);
              return (
                <section key={notice.id} data-testid="pro-notice" data-code={notice.code} className="flex items-start gap-3 rounded-3xl border border-accent/50 bg-accent-soft p-4">
                  <BellRing className="mt-0.5 size-5 shrink-0 text-accent-ink" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-extrabold text-accent-ink">{view.title}</div>
                    <p className="mt-1 text-[14px] text-accent-ink">{view.detail}</p>
                    <div className="mt-1 text-[13px] text-accent-ink/80">{view.dateText}</div>
                  </div>
                </section>
              );
            })}

            {(() => {
              const status = statusView(state);
              return (
                <section data-testid="pro-status" data-tone={status.tone} data-source={state.current.source} className={`rounded-3xl border p-4 ${TONE_CLASS[status.tone]}`}>
                  <div className="flex items-center gap-3 text-[17px] font-extrabold text-ink">
                    <IconTile icon={state.current.source === "subscription" ? BadgeCheck : Crown} tone={TONE_ICON[status.tone]} />
                    {status.title}
                  </div>
                  <ul className="mt-3 space-y-1 text-[14px] text-ink-soft">
                    {status.lines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  {state.subscription ? (
                    <button
                      data-testid="pro-toggle-renewal"
                      onClick={() => toggleRenewal(!state.subscription!.autoRenew)}
                      disabled={pending}
                      className={`${BTN_OUTLINE} mt-3`}
                    >
                      {pending ? SUBSCRIBE_LABELS.working : state.subscription.autoRenew ? SUBSCRIBE_LABELS.disableRenewal : SUBSCRIBE_LABELS.enableRenewal}
                    </button>
                  ) : null}
                  {state.subscription?.autoRenew ? <p className="mt-2 text-[13px] text-ink-soft">{NO_REFUND_NOTE}</p> : null}
                </section>
              );
            })()}

            {(() => {
              const promo = promoView(state.promo);
              return (
                <section data-testid="pro-promo" className="rounded-3xl border border-line bg-white p-4">
                  <div className="flex items-center gap-3">
                    <IconTile icon={Gift} tone="accent" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-ink-soft">Crédits promotionnels</div>
                      <div data-testid="pro-promo-amount" className="text-[26px] font-extrabold leading-tight text-ink">{promo.amountText}</div>
                    </div>
                  </div>
                  {promo.expiryText ? <div data-testid="pro-promo-expiry" className="mt-1 text-[14px] text-ink-soft">{promo.expiryText}</div> : null}
                  <p className="mt-2 text-[13px] text-ink-soft">{PROMO_CREDITS_RULES}</p>
                </section>
              );
            })()}

            {state.current.entitlements.includes("catalog_import") ? (
              <Link
                href={IMPORT_PAGE_PATH}
                data-testid="pro-import-link"
                className="press flex min-h-16 items-center gap-3 rounded-3xl border border-line bg-white p-4 text-[15px] font-bold text-ink hover:border-brand"
              >
                <IconTile icon={Upload} tone="info" />
                <span className="flex-1">Importer un catalogue (fichier CSV)</span>
                <ChevronRight className="size-5 text-ink-soft" aria-hidden />
              </Link>
            ) : null}

            <div className="mt-2 flex flex-col gap-3">
              <SectionHeading icon={Scale}>Gratuit ou Pro</SectionHeading>
              <Notice tone="accent" data-testid="pro-prices-notice" small>{PRICES_PROVISIONAL_NOTICE}</Notice>
              <table data-testid="pro-plan-table" className="w-full overflow-hidden rounded-3xl border border-line bg-white text-left text-[14px]">
                <thead>
                  <tr className="bg-mist text-ink-soft">
                    <th className="px-3 py-3 font-bold" scope="col"><span className="sr-only">Critère</span></th>
                    {state.plans.map((entry) => <th key={entry.code} scope="col" className="px-3 py-3 font-extrabold text-ink">{entry.name}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {comparisonRows(state.plans).map((row) => (
                    <tr key={row.key} data-testid={`pro-row-${row.key}`}>
                      <th scope="row" className="px-3 py-3 font-semibold text-ink">{row.label}</th>
                      {row.values.map((value, index) => <td key={`${row.key}-${state.plans[index].code}`} className="px-3 py-3 font-semibold text-ink">{value}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!state.subscription && plan ? (
              <section className="flex flex-col gap-3">
                {subscribe.kind === "balance_unknown" ? (
                  <Notice tone="danger" role="alert">Votre solde n&apos;a pas pu être lu : l&apos;abonnement est impossible pour le moment.</Notice>
                ) : null}
                {subscribe.kind === "insufficient" ? (
                  <div data-testid="pro-insufficient" className="rounded-3xl bg-accent-soft p-4 text-[14px] text-accent-ink">
                    <div className="font-extrabold">{subscribe.text}</div>
                    <p className="mt-0.5">{subscribe.detail}</p>
                    <Link href={walletHref({ next: "/vendeur/offre-pro", recharge: true })} data-testid="pro-recharge" className={`${BTN_OUTLINE} mt-3`}>
                      <Wallet className="size-5" aria-hidden />
                      {SUBSCRIBE_LABELS.recharge}
                    </Link>
                  </div>
                ) : null}
                {!confirming ? (
                  <button
                    data-testid="pro-subscribe"
                    onClick={() => { setActionError(null); setDone(null); setConfirming(true); }}
                    disabled={!canSubscribe(subscribe, pending)}
                    className={BTN_PRIMARY}
                  >
                    <Crown className="size-5" aria-hidden />
                    {subscribableLabelFor(plan)}
                  </button>
                ) : subscribe.kind === "ready" ? (
                  <div data-testid="pro-confirmation" className="animate-pop rounded-3xl border border-brand/30 bg-brand-soft p-4">
                    <p className="text-[15px] font-semibold text-ink">{subscribeConfirmationText(subscribe)}</p>
                    <p className="mt-1 text-[13px] text-ink-soft">{planPriceText(plan)}. {PRICES_PROVISIONAL_NOTICE}</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        data-testid="pro-confirm"
                        onClick={() => void confirmSubscribe()}
                        disabled={pending}
                        className={`${BTN_PRIMARY} sm:flex-1`}
                      >
                        {pending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <CircleCheck className="size-5" aria-hidden />}
                        {pending ? SUBSCRIBE_LABELS.confirming : SUBSCRIBE_LABELS.confirm}
                      </button>
                      <button onClick={() => setConfirming(false)} disabled={pending} className={`${BTN_OUTLINE} sm:w-auto`}>
                        {SUBSCRIBE_LABELS.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {actionError ? <Notice tone="danger" role="alert" data-testid="pro-error">{actionError}</Notice> : null}
            {done ? <Notice tone="brand" icon={CircleCheck} role="status" data-testid="pro-done">{done}</Notice> : null}
            <p className="flex items-center gap-2 text-[14px] font-semibold text-ink-soft">
              <Wallet className="size-5 text-brand" aria-hidden />
              <span>Solde en crédits : {balance === null ? "inconnu" : <span data-testid="pro-balance" className="font-extrabold text-ink">{formatFcfa(balance)}</span>}</span>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
