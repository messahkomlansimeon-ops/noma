"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleAlert, History, Info, Plus, RotateCw, TriangleAlert, Wallet } from "lucide-react";
import { ArtAlert, ArtWallet } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Btn, EmptyState, IconTile, Input, Skeleton } from "@/components/ui";
import { api, describeApiError, type PaymentProviderName, type WalletTransaction } from "@/lib/client/api";
import { createGenerationGuard } from "@/lib/client/match-view";
import { safeNextPath } from "@/lib/client/session";
import {
  EMPTY_WALLET_HISTORY,
  PAID_CREDITS_LABEL,
  PROMO_CREDITS_LABEL,
  PROMO_CREDITS_NOTE,
  TOPUP_PRESETS,
  checkoutHref,
  createTopupKeys,
  createTopupWithFreshKey,
  externalCheckoutHref,
  formatFcfa,
  mergeTransactionPages,
  parseTopupAmount,
  promoExpiryText,
  rechargeNotice,
  returnTarget,
  VENDOR_WALLET_PATH,
  walletRow,
} from "@/lib/client/wallet-view";

interface Loaded {
  /** Prestataire de paiement ACTIF côté serveur (lot PAY1) : dit à l'écran par quel moyen on recharge. */
  paymentMode: PaymentProviderName | "none";
  balanceXof: number;
  /** Lot PRO1 : crédits promotionnels dépensables et leur prochaine échéance. */
  promoBalanceXof: number;
  promoExpiresAt: string | null;
  transactions: WalletTransaction[];
  nextCursor: string | null;
}

const TONE_CLASS = { credit: "text-success-ink", debit: "text-accent-ink", neutral: "text-ink-soft" } as const;
const TONE_ICON = { credit: ArrowDownLeft, debit: ArrowUpRight, neutral: ArrowLeftRight } as const;
const TONE_TILE = { credit: "success", debit: "accent", neutral: "mist" } as const;

/** Panneau de recharge : montants proposés, montant libre validé, puis page de paiement simulé (prestataire fictif) ou page de paiement Wave (Sublymus). */
function RechargePanel({ next, provider }: { next: string; provider: PaymentProviderName | "none" }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Verrou synchrone : un second appui avant le prochain rendu ne crée jamais une seconde intention.
  const submitting = useRef(false);
  // Une clé d'idempotence par tentative (par montant), conservée dans l'onglet jusqu'à ce que la recharge soit terminée (la page de paiement
  // l'oublie alors) : un nouvel essai réseau, ou un aller-retour avec la page de paiement, réutilise la MÊME clé et ne crée pas une seconde intention.
  const keys = useRef(createTopupKeys());
  const parsed = parseTopupAmount(amountText);

  const submit = async () => {
    if (submitting.current) return;
    const result = parseTopupAmount(amountText);
    if (!result.ok) {
      setTouched(true);
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    let navigating = false;
    try {
      const scope = String(result.amountXof);
      // Une intention réutilisée déjà TERMINÉE (payée dans un autre onglet qui partageait la clé) : clé neuve, recréée une seule fois.
      const { topup } = await createTopupWithFreshKey({
        create: (request) => api.wallet.createTopup(request),
        keys: keys.current,
        scope,
        amountXof: result.amountXof,
      });
      // Paiement par Wave (lot PAY1) : le lien de la session est vérifié (https) avant toute navigation ; le retour se fait sur /paiement-retour/<id>, qui ne crédite jamais.
      if (topup.provider === "sublymus") {
        const waveHref = externalCheckoutHref(topup.checkoutUrl);
        if (waveHref === null) {
          setError("La page de paiement Wave n'a pas pu être ouverte. Réessayez dans un instant.");
          return;
        }
        navigating = true;
        window.location.assign(waveHref);
        return;
      }
      const href = checkoutHref(topup.checkoutPath, next);
      if (href === null) {
        setError("La page de paiement n'a pas pu être ouverte. Réessayez dans un instant.");
        return;
      }
      // La clé reste : la page de paiement l'oublie quand la recharge est terminée (réussie, échouée ou expirée).
      navigating = true;
      router.push(href);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeApiError(failure, "wallet"));
    } finally {
      // Après une navigation lancée, le bouton reste inactif jusqu'au changement de page.
      if (!navigating) {
        submitting.current = false;
        setPending(false);
      }
    }
  };

  return (
    <section data-testid="topup-panel" aria-labelledby="topup-title" className="animate-rise rounded-3xl border border-line bg-white p-4">
      <h2 id="topup-title" className="flex items-center gap-2.5 text-[18px] font-extrabold tracking-tight text-ink">
        <IconTile icon={Plus} tone="brand" className="size-9" />
        Recharger mon porte-monnaie
      </h2>
      <p
        data-testid={provider === "fake" ? "topup-simulation-notice" : "topup-provider-notice"}
        data-provider={provider}
        className={`mt-3 flex items-start gap-2.5 rounded-2xl px-3.5 py-3 text-[14px] font-bold ${provider === "sublymus" ? "bg-brand-soft text-brand-ink" : "bg-accent-soft text-accent-ink"}`}
      >
        {provider === "sublymus" ? <Info className="mt-0.5 size-5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />}
        {rechargeNotice(provider)}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4" role="group" aria-label="Montants proposés">
        {TOPUP_PRESETS.map((preset) => {
          const selected = parsed.ok && parsed.amountXof === preset;
          return (
            <button
              key={preset}
              data-testid={`topup-preset-${preset}`}
              onClick={() => {
                setAmountText(String(preset));
                setTouched(true);
                setError(null);
              }}
              disabled={pending}
              aria-pressed={selected}
              className={`press min-h-12 rounded-2xl border-2 px-3 py-3 text-[15px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${
                selected ? "border-transparent bg-brand text-white" : "border-line bg-white text-ink hover:border-line-strong"
              }`}
            >
              {formatFcfa(preset)}
            </button>
          );
        })}
      </div>

      <label htmlFor="topup-amount" className="mb-1.5 mt-4 block text-[14px] font-bold text-ink">
        Ou un autre montant (en FCFA)
      </label>
      <Input
        id="topup-amount"
        data-testid="topup-amount-input"
        value={amountText}
        onChange={(event) => {
          setAmountText(event.target.value);
          setTouched(true);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
        inputMode="numeric"
        autoComplete="off"
        placeholder="2 500"
        maxLength={12}
        disabled={pending}
        aria-invalid={touched && !parsed.ok ? true : undefined}
        aria-describedby={touched && !parsed.ok ? "topup-amount-error" : undefined}
        className="font-semibold disabled:opacity-60"
      />
      {touched && !parsed.ok && amountText.trim().length > 0 ? (
        <p id="topup-amount-error" role="alert" data-testid="topup-amount-error" className="mt-2 flex items-center gap-2 text-[14px] font-semibold text-danger-ink">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {parsed.message}
        </p>
      ) : null}

      {error ? (
        <p role="alert" data-testid="topup-error" className="mt-3 flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[14px] font-semibold text-danger-ink">
          <CircleAlert className="size-5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      <button
        data-testid="topup-submit"
        onClick={() => void submit()}
        disabled={!parsed.ok || pending || provider === "none"}
        className="press mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3.5 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Ouverture du paiement…" : parsed.ok ? `Continuer vers le paiement de ${formatFcfa(parsed.amountXof)}` : "Continuer vers le paiement"}
      </button>
    </section>
  );
}

export function PorteMonnaie({ space }: { space: "buyer" | "vendor" }) {
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  // Retour nettoyé (chemin interne seulement) : la valeur brute de l'adresse n'est JAMAIS utilisée.
  const backPath = returnTarget(rawNext, space === "vendor" ? "/vendeur/profil" : "/compte");
  // Lot FIN1 : le porte-monnaie du vendeur reste dans l'espace vendeur (barre d'onglets vendeur) ; sans retour demandé, une recharge ramène à ce porte-monnaie-là.
  const next = safeNextPath(rawNext, space === "vendor" ? VENDOR_WALLET_PATH : "");
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [rechargeOpen, setRechargeOpen] = useState(searchParams.get("recharger") === "1");
  // Un nouveau chargement ouvre une nouvelle génération : une réponse de « Voir plus » partie avant est ignorée.
  const guard = useRef(createGenerationGuard());

  useEffect(() => {
    const controller = new AbortController();
    const token = guard.current.begin();
    api.wallet.overview({}, { signal: controller.signal }).then(
      (overview) => {
        if (!guard.current.isCurrent(token)) return;
        setLoaded({
          paymentMode: overview.paymentMode,
          balanceXof: overview.balanceXof,
          promoBalanceXof: overview.promoBalanceXof,
          promoExpiresAt: overview.promoExpiresAt,
          transactions: overview.transactions,
          nextCursor: overview.nextCursor,
        });
        setLoadError(null);
        setMoreError(null);
        setLoadingMore(false);
      },
      (failure) => {
        if (controller.signal.aborted || !guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "wallet"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const loadMore = useCallback(async () => {
    if (!loaded?.nextCursor || loadingMore) return;
    const token = guard.current.begin();
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.wallet.overview({ cursor: loaded.nextCursor });
      if (!guard.current.isCurrent(token)) return;
      setLoaded((current) =>
        current
          ? {
              paymentMode: page.paymentMode,
              balanceXof: page.balanceXof,
              promoBalanceXof: page.promoBalanceXof,
              promoExpiresAt: page.promoExpiresAt,
              transactions: mergeTransactionPages(current.transactions, page.transactions),
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch (failure) {
      if (!guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
      setMoreError(describeApiError(failure, "wallet"));
    } finally {
      if (guard.current.isCurrent(token)) setLoadingMore(false);
    }
  }, [loaded, loadingMore, redirectIfUnauthorized]);

  return (
    <main>
      <TopBar back={backPath} title="Mon porte-monnaie" />
      <div className="px-4 pb-6">
        {loadError ? (
          <div role="alert" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl border border-line bg-white p-6 text-center">
            <ArtAlert className="size-24" />
            <p className="text-[16px] font-bold text-ink">{loadError}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setLoadError(null);
                  setReloadKey((key) => key + 1);
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
          </div>
        ) : !loaded ? (
          <div className="mt-4 flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">Chargement de votre porte-monnaie…</span>
            <Skeleton className="h-44 w-full rounded-[2rem]" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-16 w-full rounded-3xl" />
            <Skeleton className="h-16 w-full rounded-3xl" />
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-5">
            <div className="animate-rise relative overflow-hidden rounded-[2rem] bg-brand p-5 text-white">
              <span aria-hidden className="absolute -right-6 -top-6 size-28 rounded-full bg-white/10" />
              <span aria-hidden className="absolute -bottom-8 right-10 size-20 rounded-full bg-white/10" />
              <div className="relative flex items-center gap-2 text-[14px] font-semibold text-white/90">
                <Wallet className="size-5" aria-hidden />
                Solde disponible · {PAID_CREDITS_LABEL}
              </div>
              <div data-testid="wallet-balance" className="relative mt-1 text-[40px] font-extrabold leading-tight">
                {formatFcfa(loaded.balanceXof)}
              </div>
              {loaded.promoBalanceXof > 0 || loaded.transactions.some((entry) => entry.promoAmountXof !== 0) ? (
                <div data-testid="wallet-promo" className="relative mt-3 rounded-2xl bg-white/15 px-4 py-3">
                  <div className="text-[13px] font-semibold text-white/90">{PROMO_CREDITS_LABEL}</div>
                  <div data-testid="wallet-promo-balance" className="text-[22px] font-extrabold leading-tight">
                    {formatFcfa(loaded.promoBalanceXof)}
                  </div>
                  {promoExpiryText(loaded.promoBalanceXof, loaded.promoExpiresAt) ? (
                    <div data-testid="wallet-promo-expiry" className="text-[13px] text-white/90">
                      {promoExpiryText(loaded.promoBalanceXof, loaded.promoExpiresAt)}
                    </div>
                  ) : null}
                  <p className="mt-1 text-[12px] leading-snug text-white/80">{PROMO_CREDITS_NOTE}</p>
                </div>
              ) : null}
              <button
                data-testid="wallet-recharge"
                onClick={() => setRechargeOpen((open) => !open)}
                aria-expanded={rechargeOpen}
                className="press relative mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3 text-[16px] font-bold text-brand hover:bg-brand-soft"
              >
                <Plus className="size-5" aria-hidden />
                Recharger
              </button>
            </div>

            {rechargeOpen ? <RechargePanel next={next} provider={loaded.paymentMode} /> : null}

            <section className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-[18px] font-extrabold tracking-tight text-ink">
                <History className="size-5 text-brand" aria-hidden />
                Historique
              </h2>
              {loaded.transactions.length === 0 ? (
                <div data-testid="wallet-empty">
                  <EmptyState art={<ArtWallet className="size-32" />} title={EMPTY_WALLET_HISTORY} />
                </div>
              ) : (
                <ul data-testid="wallet-history" className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white" aria-label="Opérations du porte-monnaie">
                  {loaded.transactions.map((transaction) => {
                    const row = walletRow(transaction);
                    return (
                      <li key={row.key} data-testid="wallet-row" data-kind={transaction.kind} className="flex items-center gap-3 px-4 py-3">
                        <IconTile icon={TONE_ICON[row.tone]} tone={TONE_TILE[row.tone]} className="size-10" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[15px] font-bold text-ink">{row.label}</div>
                          <div className="text-[13px] text-ink-soft">{row.dateText}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div data-testid="wallet-row-amount" data-tone={row.tone} className={`text-[16px] font-extrabold ${TONE_CLASS[row.tone]}`}>
                            {row.amountText}
                          </div>
                          {row.promoText ? <div data-testid="wallet-row-promo" className="text-[12px] font-semibold text-ink-soft">{row.promoText}</div> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {moreError ? (
                <p role="alert" className="flex items-center justify-center gap-2 text-center text-[14px] font-semibold text-danger-ink">
                  <CircleAlert className="size-4 shrink-0" aria-hidden />
                  {moreError}
                </p>
              ) : null}
              {loaded.nextCursor ? (
                <button
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {loadingMore ? "Chargement…" : "Voir plus"}
                </button>
              ) : null}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

/** Page « Mon porte-monnaie » d'un espace (acheteur : `/compte/porte-monnaie`, vendeur : `/vendeur/porte-monnaie`) : le même écran, dans la navigation de son espace. */
export function WalletPage({ space }: { space: "buyer" | "vendor" }) {
  // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
  return (
    <SessionGate>
      <Suspense fallback={null}>
        <PorteMonnaie space={space} />
      </Suspense>
    </SessionGate>
  );
}
