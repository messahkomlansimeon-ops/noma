"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import {
  ApiError,
  api,
  describeApiError,
  type BoostDurationCode,
  type BoostPurchaseHistoryItem,
  type BoostQuote,
  type OfferRecord,
} from "@/lib/client/api";
import {
  BOOST_DURATIONS,
  BOOST_INTRO,
  boostEligibility,
  durationLabel,
  explainFactors,
  quoteAmountText,
  quoteHistoryRow,
  unavailableReasonText,
} from "@/lib/client/boost-view";
import { createGenerationGuard } from "@/lib/client/match-view";
import {
  BALANCE_UNKNOWN_TEXT,
  BOOST_SUCCESS_NOTE,
  BUY_LABELS,
  PURCHASE_NOT_RECORDED_TEXT,
  UNRESOLVED_PURCHASE_TEXT,
  anchorQuote,
  anchoredQuoteValidity,
  anchoredRemainingMs,
  boostActiveText,
  buyState,
  canBuy,
  confirmButtonState,
  createIdempotencyKeys,
  formatFcfa,
  historyEntryExpired,
  isPurchaseOutcomeUnknown,
  purchaseConfirmationText,
  purchaseFollowUp,
  purchaseHistoryRow,
  reanchorQuote,
  walletHref,
  type BuyState,
  type QuoteClock,
} from "@/lib/client/wallet-view";

const HISTORY_LIMIT = 10;

/** Horloge MONOTONE du compte à rebours : jamais l'horloge murale de l'appareil (voir wallet-view.ts). */
const monotonicNow = () => performance.now();

interface QuoteEntry {
  quote: BoostQuote;
  clock: QuoteClock | null;
}

type WalletState =
  | { status: "loading" }
  | { status: "ready"; balanceXof: number }
  | { status: "error"; message: string };

/** Un achat dont le résultat est INCONNU (réponse perdue) : `verified` = une relecture a abouti et n'y a trouvé aucun achat pour ce devis. */
interface UnresolvedPurchase {
  quote: BoostQuote;
  verified: boolean;
}

/**
 * « Booster cette annonce » : choix de la durée → devis de prix (POST boost-quotes), explication des facteurs, validité
 * (compte à rebours ancré), puis achat avec le solde du porte-monnaie : « Acheter » (actif seulement si le prix est couvert),
 * confirmation, POST boost-purchases avec une clé d'idempotence par devis. Historique des devis et des achats de l'annonce.
 */
export function BoostSection({ offer, onOfferChanged }: { offer: OfferRecord; onOfferChanged: () => void }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const eligibility = boostEligibility(offer);
  const offerId = offer.id;
  const eligible = eligibility.eligible;
  const offerPath = `/vendeur/annonces/${offerId}`;

  const [entry, setEntry] = useState<QuoteEntry | null>(null);
  const [pending, setPending] = useState<BoostDurationCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ quotes: BoostQuote[]; receivedAtMs: number } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [wallet, setWallet] = useState<WalletState>({ status: "loading" });
  const [walletKey, setWalletKey] = useState(0);
  const [purchases, setPurchases] = useState<BoostPurchaseHistoryItem[] | null>(null);
  const [purchasesKey, setPurchasesKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedPurchase | null>(null);
  const [success, setSuccess] = useState<{ endsAt: string } | null>(null);
  // Horloge de l'écran (compte à rebours) : lecture monotone, une mise à jour par seconde tant qu'un devis est affiché.
  const [now, setNow] = useState(() => monotonicNow());
  // Verrou synchrone : un second clic arrivé avant le prochain rendu ne lance JAMAIS une seconde requête.
  const buyingRef = useRef(false);
  // Une clé d'idempotence par devis, créée au premier achat et réutilisée à chaque nouvel essai du MÊME devis.
  const keys = useRef(createIdempotencyKeys());
  // Garde de génération des devis : un achat réussi invalide toute demande de devis partie avant lui (sa réponse tardive est ignorée : elle
  // afficherait un prix « disponible » sur une annonce déjà boostée).
  const quoteGuard = useRef(createGenerationGuard());
  // Dernier achat au résultat inconnu, lu par l'écouteur de retour au premier plan (qui ne se recrée pas à chaque rendu).
  const unresolvedRef = useRef<UnresolvedPurchase | null>(null);
  const ticking = entry !== null || (history?.quotes.length ?? 0) > 0;

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(monotonicNow()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    api.boostQuotes.list(offerId, { limit: HISTORY_LIMIT }, { signal: controller.signal }).then(
      (quotes) => {
        const receivedAtMs = monotonicNow();
        setNow(receivedAtMs);
        setHistory({ quotes, receivedAtMs });
        setHistoryError(null);
        // Le devis affiché est re-ancré sur cette relecture (heure du serveur) : couvre la veille de l'appareil et les devis réutilisés.
        setEntry((current) => (current ? reanchorQuote(current, quotes, receivedAtMs) : current));
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setHistoryError(describeApiError(failure, "boost"));
      },
    );
    return () => controller.abort();
  }, [offerId, eligible, historyKey, redirectIfUnauthorized]);

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    api.wallet.overview({ limit: 1 }, { signal: controller.signal }).then(
      (overview) => setWallet({ status: "ready", balanceXof: overview.balanceXof }),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setWallet({ status: "error", message: describeApiError(failure, "wallet") });
      },
    );
    return () => controller.abort();
  }, [eligible, walletKey, redirectIfUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    api.boostPurchases.list(offerId, { limit: HISTORY_LIMIT }, { signal: controller.signal }).then(
      (items) => setPurchases(items),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        // L'historique des achats est une information en plus : son absence ne bloque rien.
        setPurchases(null);
      },
    );
    return () => controller.abort();
  }, [offerId, purchasesKey, redirectIfUnauthorized]);

  const request = useCallback(
    async (durationCode: BoostDurationCode) => {
      if (pending) return;
      // La confirmation d'un achat se ferme dès qu'un devis est demandé : le prix confirmé n'est plus celui que l'écran va afficher.
      setConfirming(false);
      setPending(durationCode);
      setError(null);
      const token = quoteGuard.current.begin();
      try {
        const created = await api.boostQuotes.create(offerId, durationCode);
        // Un achat a réussi depuis l'envoi de cette demande : ce devis (réponse tardive) est périmé, il ne s'affiche jamais.
        if (!quoteGuard.current.isCurrent(token)) return;
        const receivedAtMs = monotonicNow();
        setNow(receivedAtMs);
        setEntry({ quote: created, clock: anchorQuote(created, receivedAtMs) });
        setHistoryKey((key) => key + 1);
      } catch (failure) {
        if (!quoteGuard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
        setError(describeApiError(failure, "boost"));
        // Annonce disparue ou plus éligible : l'écran affichait un état périmé.
        if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) onOfferChanged();
      } finally {
        setPending(null);
      }
    },
    [offerId, pending, onOfferChanged, redirectIfUnauthorized],
  );

  /** L'achat a abouti (réponse reçue, ou relecture qui le retrouve) : le devis est consommé, tout devis demandé avant est périmé. */
  const applyPurchaseSuccess = useCallback((endsAt: string) => {
    quoteGuard.current.begin();
    setEntry(null);
    setConfirming(false);
    setBuyError(null);
    setUnresolved(null);
    setSuccess({ endsAt });
  }, []);

  /**
   * Après TOUT échec d'un achat (réseau ou refus) : relit solde, achats de l'annonce et historique des devis, puis cherche l'achat tenté parmi
   * les achats. Retrouvé (réponse perdue, ou devis acheté depuis un autre onglet) : l'écran affiche le succès, jamais une erreur périmée avec
   * un solde faux. Introuvable alors que le résultat était inconnu : « aucun achat enregistré » + « Vérifier / réessayer » (même clé). Renvoie
   * vrai si l'achat est retrouvé.
   */
  const reconcile = useCallback(
    async (attempt: BoostQuote | null, outcomeUnknown: boolean): Promise<boolean> => {
      const [walletResult, purchasesResult, quotesResult] = await Promise.allSettled([
        api.wallet.overview({ limit: 1 }),
        api.boostPurchases.list(offerId, { limit: HISTORY_LIMIT }),
        api.boostQuotes.list(offerId, { limit: HISTORY_LIMIT }),
      ]);
      for (const result of [walletResult, purchasesResult, quotesResult]) {
        if (result.status === "rejected" && redirectIfUnauthorized(result.reason)) return false;
      }
      const receivedAtMs = monotonicNow();
      setNow(receivedAtMs);
      if (walletResult.status === "fulfilled") setWallet({ status: "ready", balanceXof: walletResult.value.balanceXof });
      if (quotesResult.status === "fulfilled") {
        const quotes = quotesResult.value;
        setHistory({ quotes, receivedAtMs });
        setHistoryError(null);
        setEntry((current) => (current ? reanchorQuote(current, quotes, receivedAtMs) : current));
      }
      if (purchasesResult.status === "fulfilled") {
        setPurchases(purchasesResult.value);
        const bought = attempt ? purchasesResult.value.find((item) => item.quoteId === attempt.id) : undefined;
        if (bought) {
          applyPurchaseSuccess(bought.endsAt);
          return true;
        }
        if (attempt && outcomeUnknown) setUnresolved({ quote: attempt, verified: true });
      }
      return false;
    },
    [offerId, redirectIfUnauthorized, applyPurchaseSuccess],
  );

  // Retour au premier plan (après une veille, un changement d'onglet) : l'erreur d'achat périmée est effacée ; solde, achats et devis sont
  // relus (le devis affiché est re-ancré sur l'heure du serveur) ; un achat au résultat inconnu est vérifié.
  useEffect(() => {
    if (!eligible) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setBuyError(null);
      setWalletKey((key) => key + 1);
      setHistoryKey((key) => key + 1);
      setPurchasesKey((key) => key + 1);
      if (unresolvedRef.current) void reconcile(unresolvedRef.current.quote, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [eligible, reconcile]);

  useEffect(() => {
    unresolvedRef.current = unresolved;
  }, [unresolved]);

  // Un devis acheté est consommé : l'historique des devis le dit (« Acheté »), il ne reste jamais « En cours de validité ».
  const purchasedQuoteIds = new Set((purchases ?? []).map((item) => item.quoteId));
  const quotePending = pending !== null;
  const quoteExpired = entry !== null && anchoredRemainingMs(entry.clock, now) <= 0;
  const state: BuyState = buyState({
    quote: entry?.quote ?? null,
    expired: quoteExpired,
    balanceXof: wallet.status === "ready" ? wallet.balanceXof : null,
  });

  const askToBuy = () => {
    if (!canBuy(state, buying || quotePending)) return;
    setBuyError(null);
    setConfirming(true);
  };

  /**
   * Achète le devis `quote` avec SA clé d'idempotence (créée une fois, réutilisée à chaque essai, même quand le devis a expiré à l'écran :
   * le serveur rejoue la clé). Un seul envoi à la fois (verrou synchrone).
   */
  const confirmPurchase = async (quote: BoostQuote) => {
    if (buyingRef.current) return;
    buyingRef.current = true;
    setBuying(true);
    setBuyError(null);
    try {
      const result = await api.boostPurchases.create(offerId, {
        quoteId: quote.id,
        idempotencyKey: keys.current.keyFor(quote.id),
      });
      setWallet({ status: "ready", balanceXof: result.balanceXof });
      applyPurchaseSuccess(result.purchase.endsAt);
      setHistoryKey((key) => key + 1);
      setPurchasesKey((key) => key + 1);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      const apiFailure = failure instanceof ApiError ? failure : null;
      setBuyError(describeApiError(failure, "purchase"));
      const unknown = apiFailure ? isPurchaseOutcomeUnknown(apiFailure) : true;
      setUnresolved(unknown ? { quote, verified: false } : null);
      const next = apiFailure ? purchaseFollowUp(apiFailure) : null;
      if (next?.closeConfirmation) setConfirming(false);
      const found = await reconcile(quote, unknown);
      if (!found && next) {
        if (next.refreshQuote) {
          // Une clé qui aurait servi à autre chose ne se réutilise pas ; le devis suivant aura la sienne.
          keys.current.forget(quote.id);
          void request(quote.durationCode);
        }
        if (next.reloadOffer) onOfferChanged();
      }
    } finally {
      buyingRef.current = false;
      setBuying(false);
    }
  };

  return (
    <section aria-labelledby="boost-title" className="mt-6">
      <h2 id="boost-title" className="text-[16px] font-extrabold text-ink">
        Booster cette annonce
      </h2>

      {!eligibility.eligible ? (
        <p role="status" data-testid="boost-not-eligible" className="mt-3 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
          {eligibility.message}
        </p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-soft">{BOOST_INTRO}</p>

          <WalletLine
            wallet={wallet}
            walletLink={walletHref({ next: offerPath })}
            onRetry={() => {
              setWallet({ status: "loading" });
              setWalletKey((key) => key + 1);
            }}
            onRefresh={() => {
              setBuyError(null);
              setWalletKey((key) => key + 1);
            }}
          />

          <div className="mt-3 flex gap-2" role="group" aria-label="Durée du boost">
            {BOOST_DURATIONS.map((duration) => {
              const selected = entry?.quote.durationCode === duration.code;
              return (
                <button
                  key={duration.code}
                  onClick={() => {
                    setBuyError(null);
                    void request(duration.code);
                  }}
                  disabled={pending !== null || buying}
                  aria-pressed={selected}
                  className={`flex-1 rounded-xl border px-3 py-2.5 text-[14px] font-bold transition disabled:opacity-50 ${
                    selected ? "border-transparent bg-forest text-white" : "border-line bg-white text-ink"
                  }`}
                >
                  {pending === duration.code ? "…" : duration.label}
                </button>
              );
            })}
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-[13px] font-semibold text-carrot-ink">
              {error}
            </p>
          ) : null}

          {buyError ? (
            <p role="alert" data-testid="boost-buy-error" className="mt-3 rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">
              {buyError}
            </p>
          ) : null}

          {unresolved ? (
            <div data-testid="boost-unresolved" role="alert" className="mt-3 rounded-xl border border-carrot/40 bg-carrot-soft/50 p-3.5">
              <p className="text-[13px] font-semibold text-ink">{unresolved.verified ? PURCHASE_NOT_RECORDED_TEXT : UNRESOLVED_PURCHASE_TEXT}</p>
              <p className="mt-0.5 text-[12px] text-ink-soft">
                Achat de {durationLabel(unresolved.quote.durationCode)}
                {unresolved.quote.amount !== null ? ` · ${formatFcfa(unresolved.quote.amount)}` : ""}
              </p>
              <button
                data-testid="boost-verify"
                onClick={() => void confirmPurchase(unresolved.quote)}
                disabled={buying}
                aria-disabled={buying}
                className="mt-2 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {buying ? BUY_LABELS.confirming : BUY_LABELS.verify}
              </button>
            </div>
          ) : null}

          {success ? (
            <div data-testid="boost-success" role="status" className="mt-4 rounded-2xl border border-forest/30 bg-sage p-4">
              <p className="text-[15px] font-extrabold text-forest">{boostActiveText(success.endsAt)}</p>
              <p data-testid="boost-success-note" className="mt-1 text-[13px] text-sage-ink">
                {BOOST_SUCCESS_NOTE}
              </p>
            </div>
          ) : null}

          {entry ? (
            <QuoteCard
              entry={entry}
              now={now}
              state={state}
              confirming={confirming}
              buying={buying}
              quotePending={quotePending}
              busy={pending !== null || buying}
              onRefresh={() => {
                setBuyError(null);
                void request(entry.quote.durationCode);
              }}
              onBuy={askToBuy}
              onConfirm={() => {
                if (entry && state.kind === "ready") void confirmPurchase(entry.quote);
              }}
              onCancel={() => setConfirming(false)}
              onRecharge={() => router.push(walletHref({ next: offerPath, recharge: true }))}
              onRetryBalance={() => {
                setWallet({ status: "loading" });
                setWalletKey((key) => key + 1);
              }}
            />
          ) : null}

          {purchases && purchases.length > 0 ? (
            <div className="mt-5" data-testid="boost-purchase-history">
              <h3 className="text-[14px] font-extrabold text-ink">Achats de boost de cette annonce</h3>
              <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white">
                {purchases.map((item) => {
                  const row = purchaseHistoryRow(item);
                  return (
                    <li key={row.key} data-testid="boost-purchase-row" className="px-3.5 py-2.5">
                      <div className="text-[14px] font-bold text-ink">{row.title}</div>
                      <div className="text-[12px] text-ink-soft">{row.detail}</div>
                      {row.refundedText ? (
                        <div data-testid="boost-purchase-refunded" className="mt-0.5 text-[12px] font-semibold text-carrot-ink">
                          {row.refundedText}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {historyError ? (
            <p role="alert" className="mt-4 text-[13px] font-semibold text-carrot-ink">
              {historyError}
            </p>
          ) : null}
          {history && history.quotes.length > 0 ? (
            <div className="mt-5" data-testid="boost-history">
              <h3 className="text-[14px] font-extrabold text-ink">Historique des devis</h3>
              <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white">
                {history.quotes.map((quote) => {
                  const row = quoteHistoryRow(quote, historyEntryExpired(quote, history.receivedAtMs, now), undefined, purchasedQuoteIds.has(quote.id));
                  return (
                    <li key={row.key} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                      <div>
                        <div className="text-[14px] font-bold text-ink">{row.title}</div>
                        <div className="text-[12px] text-ink-soft">{row.detail}</div>
                      </div>
                      <Badge tone={row.tone === "good" ? "sage" : row.tone === "warn" ? "carrot" : "wash"}>{row.status}</Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Solde du porte-monnaie et lien vers la page « Mon porte-monnaie ». */
function WalletLine({
  wallet,
  walletLink,
  onRetry,
  onRefresh,
}: {
  wallet: WalletState;
  walletLink: string;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  if (wallet.status === "loading") {
    return (
      <p className="mt-3 text-[13px] text-ink-soft" aria-busy="true">
        Lecture de votre solde…
      </p>
    );
  }
  if (wallet.status === "error") {
    return (
      <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-wash px-3.5 py-2.5 text-[13px]">
        <span className="font-semibold text-carrot-ink">{wallet.message}</span>
        <button onClick={onRetry} className="shrink-0 font-bold text-forest underline">
          Réessayer
        </button>
      </div>
    );
  }
  return (
    <div data-testid="boost-balance" className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-wash px-3.5 py-2.5 text-[13px]">
      <span className="text-ink-soft">
        Votre solde : <strong data-testid="boost-balance-amount" className="text-ink">{formatFcfa(wallet.balanceXof)}</strong>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <button data-testid="boost-balance-refresh" onClick={onRefresh} className="font-bold text-forest underline">
          {BUY_LABELS.refreshBalance}
        </button>
        <Link href={walletLink} className="font-bold text-forest underline">
          Mon porte-monnaie
        </Link>
      </span>
    </div>
  );
}

function QuoteCard({
  entry,
  now,
  state,
  confirming,
  buying,
  quotePending,
  busy,
  onRefresh,
  onBuy,
  onConfirm,
  onCancel,
  onRecharge,
  onRetryBalance,
}: {
  entry: QuoteEntry;
  now: number;
  state: BuyState;
  confirming: boolean;
  buying: boolean;
  quotePending: boolean;
  busy: boolean;
  onRefresh: () => void;
  onBuy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRecharge: () => void;
  onRetryBalance: () => void;
}) {
  const { quote } = entry;
  const validity = anchoredQuoteValidity(quote, entry.clock, now);
  const amount = quoteAmountText(quote);
  return (
    <div data-testid="boost-quote" data-status={quote.status} className="mt-4 rounded-2xl border border-line bg-white p-4">
      {quote.status === "available" && amount ? (
        <>
          <div className="text-[13px] font-semibold text-ink-soft">Boost de {durationLabel(quote.durationCode)}</div>
          <div data-testid="boost-amount" className="font-display text-[30px] font-extrabold leading-tight text-ink">
            {amount}
          </div>
          <ul className="mt-3 space-y-2" aria-label="Comment ce prix est calculé">
            {explainFactors(quote).map((line) => (
              <li key={line.key} className="text-[13px]">
                <span className="font-bold text-ink">{line.title}</span>
                <span className="text-ink-soft"> : {line.text} </span>
                <span className="font-semibold text-forest">({line.effect})</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="text-[13px] font-semibold text-ink-soft">Boost de {durationLabel(quote.durationCode)}</div>
          <p data-testid="boost-unavailable" className="mt-1 rounded-xl bg-carrot-soft p-3 text-[14px] font-semibold text-carrot-ink">
            {unavailableReasonText(quote.unavailableReason)}
          </p>
        </>
      )}

      <p data-testid="boost-validity" className={`mt-3 text-[13px] font-semibold ${validity.expired ? "text-carrot-ink" : "text-ink"}`}>
        {validity.text}
      </p>
      {validity.expired ? (
        <button
          onClick={onRefresh}
          disabled={busy}
          className="mt-2 rounded-xl border border-forest/30 bg-white px-4 py-2 text-[13px] font-bold text-forest disabled:opacity-50"
        >
          Demander un nouveau devis
        </button>
      ) : null}

      <BuyArea
        quote={quote}
        state={state}
        confirming={confirming}
        buying={buying}
        quotePending={quotePending}
        onBuy={onBuy}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRecharge={onRecharge}
        onRetryBalance={onRetryBalance}
      />
    </div>
  );
}

/** Achat : « Acheter » (actif seulement si le prix est couvert), solde insuffisant + « Recharger », confirmation. */
function BuyArea({
  quote,
  state,
  confirming,
  buying,
  quotePending,
  onBuy,
  onConfirm,
  onCancel,
  onRecharge,
  onRetryBalance,
}: {
  quote: BoostQuote;
  state: BuyState;
  confirming: boolean;
  buying: boolean;
  quotePending: boolean;
  onBuy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRecharge: () => void;
  onRetryBalance: () => void;
}) {
  // Pas de prix (devis indisponible) : rien à acheter.
  if (state.kind === "none") return null;

  if (confirming && state.kind === "ready") {
    const confirmButton = confirmButtonState(buying, quotePending);
    return (
      <div data-testid="boost-confirm" role="group" aria-label="Confirmer l'achat" className="mt-4 rounded-xl border border-carrot/40 bg-carrot-soft/50 p-3.5">
        <p data-testid="boost-confirm-text" className="text-[14px] font-semibold text-ink">
          {purchaseConfirmationText({ amountXof: state.amountXof, durationCode: quote.durationCode, balanceXof: state.balanceXof })}
        </p>
        <div className="mt-3 flex gap-2">
          <button
            data-testid="boost-confirm-button"
            onClick={onConfirm}
            disabled={confirmButton.disabled}
            aria-disabled={confirmButton.disabled}
            className="flex-1 rounded-xl bg-forest px-4 py-3 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirmButton.label}
          </button>
          <button
            data-testid="boost-cancel-button"
            onClick={onCancel}
            disabled={buying || quotePending}
            className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50"
          >
            {BUY_LABELS.cancel}
          </button>
        </div>
      </div>
    );
  }

  const enabled = canBuy(state, buying || quotePending);
  return (
    <div className="mt-4">
      <button
        data-testid="boost-buy"
        onClick={onBuy}
        disabled={!enabled}
        aria-disabled={!enabled}
        className="flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        {BUY_LABELS.buy}
      </button>

      {state.kind === "insufficient" ? (
        <div data-testid="boost-insufficient" role="status" className="mt-3 rounded-xl bg-carrot-soft p-3.5">
          <p className="text-[14px] font-extrabold text-carrot-ink">{state.text}</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">{state.detail}</p>
          <button
            data-testid="boost-recharge"
            onClick={onRecharge}
            className="mt-3 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white px-4 py-3 text-[14px] font-bold text-forest"
          >
            {BUY_LABELS.recharge}
          </button>
        </div>
      ) : null}

      {state.kind === "balance_unknown" ? (
        <div data-testid="boost-balance-unknown" role="status" className="mt-3 rounded-xl bg-wash p-3.5">
          <p className="text-[13px] font-semibold text-ink-soft">{BALANCE_UNKNOWN_TEXT}</p>
          <button onClick={onRetryBalance} className="mt-2 text-[13px] font-bold text-forest underline">
            Réessayer la lecture
          </button>
        </div>
      ) : null}
    </div>
  );
}
