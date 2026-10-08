"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { api, describeApiError, type WalletTransaction } from "@/lib/client/api";
import { createGenerationGuard } from "@/lib/client/match-view";
import { safeNextPath } from "@/lib/client/session";
import {
  EMPTY_WALLET_HISTORY,
  PAID_CREDITS_LABEL,
  PROMO_CREDITS_LABEL,
  PROMO_CREDITS_NOTE,
  SIMULATION_NOTICE,
  TOPUP_PRESETS,
  checkoutHref,
  createTopupKeys,
  createTopupWithFreshKey,
  formatFcfa,
  mergeTransactionPages,
  parseTopupAmount,
  promoExpiryText,
  returnTarget,
  walletRow,
} from "@/lib/client/wallet-view";

interface Loaded {
  balanceXof: number;
  /** Lot PRO1 : crédits promotionnels dépensables et leur prochaine échéance. */
  promoBalanceXof: number;
  promoExpiresAt: string | null;
  transactions: WalletTransaction[];
  nextCursor: string | null;
}

const TONE_CLASS = { credit: "text-forest", debit: "text-carrot-ink", neutral: "text-ink-soft" } as const;

/** Panneau de recharge : montants proposés, montant libre validé, puis page de paiement simulé. */
function RechargePanel({ next }: { next: string }) {
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
    <section data-testid="topup-panel" aria-labelledby="topup-title" className="mt-4 rounded-2xl border border-line bg-white p-4">
      <h2 id="topup-title" className="text-[16px] font-extrabold text-ink">
        Recharger mon porte-monnaie
      </h2>
      <p data-testid="topup-simulation-notice" className="mt-1 rounded-lg bg-carrot-soft px-3 py-2 text-[12px] font-semibold text-carrot-ink">
        {SIMULATION_NOTICE}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Montants proposés">
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
              className={`rounded-xl border px-3 py-3 text-[14px] font-bold transition disabled:opacity-50 ${
                selected ? "border-transparent bg-forest text-white" : "border-line bg-white text-ink"
              }`}
            >
              {formatFcfa(preset)}
            </button>
          );
        })}
      </div>

      <label htmlFor="topup-amount" className="mt-4 block text-[13px] font-bold text-ink">
        Ou un autre montant (en FCFA)
      </label>
      <input
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
        className="mt-1.5 w-full rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] font-semibold text-ink disabled:opacity-60"
      />
      {touched && !parsed.ok && amountText.trim().length > 0 ? (
        <p id="topup-amount-error" role="alert" data-testid="topup-amount-error" className="mt-1.5 text-[13px] font-semibold text-carrot-ink">
          {parsed.message}
        </p>
      ) : null}

      {error ? (
        <p role="alert" data-testid="topup-error" className="mt-3 rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}

      <button
        data-testid="topup-submit"
        onClick={() => void submit()}
        disabled={!parsed.ok || pending}
        className="mt-4 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Ouverture du paiement…" : parsed.ok ? `Continuer vers le paiement de ${formatFcfa(parsed.amountXof)}` : "Continuer vers le paiement"}
      </button>
    </section>
  );
}

function PorteMonnaie() {
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  // Retour nettoyé (chemin interne seulement) : la valeur brute de l'adresse n'est JAMAIS utilisée.
  const backPath = returnTarget(rawNext, "/compte");
  const next = safeNextPath(rawNext, "");
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
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                setReloadKey((key) => key + 1);
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : !loaded ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            Chargement de votre porte-monnaie…
          </p>
        ) : (
          <>
            <div className="mt-3 rounded-2xl bg-forest p-5 text-white">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-white/80">
                <Wallet className="size-4" aria-hidden />
                Solde disponible · {PAID_CREDITS_LABEL}
              </div>
              <div data-testid="wallet-balance" className="mt-1 font-display text-[40px] font-extrabold leading-tight">
                {formatFcfa(loaded.balanceXof)}
              </div>
              {loaded.promoBalanceXof > 0 || loaded.transactions.some((entry) => entry.promoAmountXof !== 0) ? (
                <div data-testid="wallet-promo" className="mt-3 rounded-xl bg-white/15 px-3 py-2.5">
                  <div className="text-[12px] font-semibold text-white/80">{PROMO_CREDITS_LABEL}</div>
                  <div data-testid="wallet-promo-balance" className="font-display text-[22px] font-extrabold leading-tight">
                    {formatFcfa(loaded.promoBalanceXof)}
                  </div>
                  {promoExpiryText(loaded.promoBalanceXof, loaded.promoExpiresAt) ? (
                    <div data-testid="wallet-promo-expiry" className="text-[12px] text-white/80">
                      {promoExpiryText(loaded.promoBalanceXof, loaded.promoExpiresAt)}
                    </div>
                  ) : null}
                  <p className="mt-1 text-[11px] leading-snug text-white/70">{PROMO_CREDITS_NOTE}</p>
                </div>
              ) : null}
              <button
                data-testid="wallet-recharge"
                onClick={() => setRechargeOpen((open) => !open)}
                aria-expanded={rechargeOpen}
                className="mt-3 flex w-full items-center justify-center rounded-xl bg-white px-4 py-3 text-[15px] font-bold text-forest transition active:scale-[0.99]"
              >
                Recharger
              </button>
            </div>

            {rechargeOpen ? <RechargePanel next={next} /> : null}

            <h2 className="mt-6 text-[16px] font-extrabold text-ink">Historique</h2>
            {loaded.transactions.length === 0 ? (
              <p data-testid="wallet-empty" className="mt-2 rounded-2xl bg-wash p-4 text-center text-[14px] font-semibold text-ink-soft">
                {EMPTY_WALLET_HISTORY}
              </p>
            ) : (
              <ul data-testid="wallet-history" className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white" aria-label="Opérations du porte-monnaie">
                {loaded.transactions.map((transaction) => {
                  const row = walletRow(transaction);
                  return (
                    <li key={row.key} data-testid="wallet-row" data-kind={transaction.kind} className="flex items-center justify-between gap-3 px-3.5 py-3">
                      <div className="min-w-0">
                        <div className="text-[14px] font-bold text-ink">{row.label}</div>
                        <div className="text-[12px] text-ink-soft">{row.dateText}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div data-testid="wallet-row-amount" data-tone={row.tone} className={`text-[15px] font-extrabold ${TONE_CLASS[row.tone]}`}>
                          {row.amountText}
                        </div>
                        {row.promoText ? <div data-testid="wallet-row-promo" className="text-[11px] font-semibold text-ink-soft">{row.promoText}</div> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {moreError ? (
              <p role="alert" className="mt-3 text-center text-[13px] font-semibold text-carrot-ink">
                {moreError}
              </p>
            ) : null}
            {loaded.nextCursor ? (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="mt-4 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest disabled:opacity-50"
              >
                {loadingMore ? "Chargement…" : "Voir plus"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

export default function PorteMonnaiePage() {
  // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
  return (
    <SessionGate>
      <Suspense fallback={null}>
        <PorteMonnaie />
      </Suspense>
    </SessionGate>
  );
}
