"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Info, Radar, RotateCw, TriangleAlert, Wallet } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Btn, IconTile, Skeleton } from "@/components/ui";
import { useNoma } from "@/lib/store";
import { ApiError, describeApiError } from "@/lib/client/api";
import { activeSearchApi, type ActiveSearchState } from "@/lib/client/active-search-api";
import {
  ACTIVE_SEARCH_BENEFITS, ACTIVE_SEARCH_LABELS, ACTIVE_SEARCH_LOADING, ACTIVE_SEARCH_PRICE_NOTICE, ACTIVE_SEARCH_RULES, ACTIVE_SEARCH_TITLE, EXTERNAL_NOTIFICATION_NOTE, activeSearchView,
  canPurchase, hidesCardOnLoadFailure, purchaseConfirmationText, purchaseDoneText, purchaseState,
} from "@/lib/client/active-search-view";
import { createGenerationGuard } from "@/lib/client/match-view";
import { browserSessionStorage, createIdempotencyKeys, newIdempotencyKey, walletHref } from "@/lib/client/wallet-view";

const KEY_PREFIX = "noma:active-search-key:";
const TONE_CLASS = { active: "border-brand/30 bg-brand-soft", off: "border-line bg-white", paused: "border-accent/40 bg-accent-soft", closed: "border-line bg-mist", unavailable: "border-line bg-mist" } as const;
const TILE_TONE = { active: "brand", off: "mist", paused: "accent", closed: "mist", unavailable: "mist" } as const;
const BIG_BUTTON =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[16px] font-bold disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Carte « Recherche active » de la page d'un besoin actif (lot RA1) : état de l'option, ce qu'elle apporte, ses règles (dites AVANT l'achat), prix PROVISOIRE, achat avec confirmation et clé
 * d'idempotence par tentative (un double appui ou un nouvel essai réseau ne débite jamais deux fois). Les textes viennent de `active-search-view.ts` (testé).
 */
export function ActiveSearchCard({ demandId, onChanged }: { demandId: string; onChanged?: () => void }) {
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<ActiveSearchState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 404 (besoin porteur d'une mission, indiscernable d'un besoin d'autrui) : la carte n'est pas affichée.
  const [hidden, setHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Verrou synchrone : un second appui avant le prochain rendu n'envoie rien de plus.
  const submitting = useRef(false);
  const keys = useRef(createIdempotencyKeys(newIdempotencyKey, browserSessionStorage(), KEY_PREFIX));
  const guard = useRef(createGenerationGuard());

  useEffect(() => {
    const controller = new AbortController();
    const token = guard.current.begin();
    activeSearchApi.state(demandId, { signal: controller.signal }).then(
      (loaded) => {
        if (controller.signal.aborted || !guard.current.isCurrent(token)) return;
        setState(loaded);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || !guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
        if (hidesCardOnLoadFailure(failure)) {
          setHidden(true);
          return;
        }
        setLoadError(describeApiError(failure, "active-search"));
      },
    );
    return () => controller.abort();
  }, [demandId, reloadKey, redirectIfUnauthorized]);

  const confirmPurchase = useCallback(async () => {
    if (submitting.current || state === null) return;
    // Le prix envoyé est celui que l'écran AFFICHE : si le tarif a changé entre-temps, le serveur refuse (`price_changed`, aucun débit) et l'écran se recharge.
    const displayedPriceXof = state.priceXof;
    submitting.current = true;
    setPending(true);
    setActionError(null);
    setDone(null);
    // Une clé par tentative, conservée dans l'onglet : un nouvel essai réseau réutilise la MÊME clé (jamais deux débits).
    const key = keys.current.keyFor(demandId);
    try {
      const result = await activeSearchApi.purchase(demandId, key, displayedPriceXof);
      keys.current.forget(demandId);
      setState(result.state);
      setConfirming(false);
      setDone(purchaseDoneText(result));
      showToast(result.reused ? "Achat déjà enregistré" : "Recherche active enregistrée");
      onChanged?.();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setActionError(describeApiError(failure, "active-search"));
      // Un refus définitif (solde insuffisant, besoin plus actif, limite de 180 jours) : la clé n'a servi à rien, l'écran est relu.
      if (failure instanceof ApiError && failure.status === 409) {
        keys.current.forget(demandId);
        setConfirming(false);
        setReloadKey((value) => value + 1);
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }, [demandId, onChanged, redirectIfUnauthorized, showToast, state]);

  if (hidden) return null;
  return (
    <ActiveSearchCardView
      demandId={demandId}
      state={state}
      loadError={loadError}
      confirming={confirming}
      pending={pending}
      actionError={actionError}
      done={done}
      onRetry={() => { setLoadError(null); setReloadKey((value) => value + 1); }}
      onBuy={() => { setActionError(null); setDone(null); setConfirming(true); }}
      onConfirm={() => void confirmPurchase()}
      onCancel={() => setConfirming(false)}
    />
  );
}

export interface ActiveSearchCardViewProps {
  demandId: string;
  /** null : chargement en cours (ou échec, voir `loadError`). */
  state: ActiveSearchState | null;
  loadError: string | null;
  confirming: boolean;
  pending: boolean;
  actionError: string | null;
  done: string | null;
  onRetry: () => void;
  onBuy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Présentation PURE de la carte (rendue sans navigateur par les essais) : tous les états de l'option, aucun accès réseau. */
export function ActiveSearchCardView(props: ActiveSearchCardViewProps) {
  const { demandId, state, loadError, confirming, pending, actionError, done } = props;
  if (loadError) {
    return (
      <div role="alert" data-testid="active-search-error" className="animate-rise mt-3 flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-4 text-center">
        <ArtAlert className="size-20" />
        <p className="text-[15px] font-bold text-ink">{loadError}</p>
        <div className="w-full max-w-xs">
          <Btn onClick={props.onRetry}>
            <RotateCw className="size-5" aria-hidden />
            Réessayer
          </Btn>
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="mt-3" aria-busy="true">
        <span className="sr-only">{ACTIVE_SEARCH_LOADING}</span>
        <Skeleton className="h-28 w-full rounded-3xl" />
      </div>
    );
  }

  const view = activeSearchView(state);
  // Un besoin ni actif ni suspendu n'a rien à montrer.
  if (view.tone === "closed") return null;
  const purchase = purchaseState(state);
  // Option suspendue (besoin satisfait) ou indisponible : l'état est DIT en deux lignes, sans avantages, sans prix et sans bouton d'achat.
  const compact = view.tone === "paused" || view.tone === "unavailable";
  return (
    <section
      className={`mt-3 rounded-3xl border p-4 ${TONE_CLASS[view.tone]}`}
      aria-label={ACTIVE_SEARCH_TITLE}
      data-testid="active-search-card"
      data-tone={view.tone}
      data-active={state.active ? "true" : "false"}
      data-acceleration={state.accelerationPending ? "pending" : state.active ? "running" : "none"}
    >
      <div className="flex items-center gap-3">
        <IconTile icon={Radar} tone={TILE_TONE[view.tone]} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold uppercase tracking-wide text-ink-soft">{ACTIVE_SEARCH_TITLE}</div>
          <div className="text-[16px] font-extrabold leading-snug text-ink" data-testid="active-search-headline">{view.headline}</div>
        </div>
      </div>
      <p className="mt-2 text-[14px] text-ink-soft" data-testid="active-search-detail">{view.detail}</p>

      {compact ? null : (
        <>
          <ul className="mt-3 flex flex-col gap-2 text-[14px] text-ink" data-testid="active-search-benefits">
            {ACTIVE_SEARCH_BENEFITS.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-success-ink" strokeWidth={2.6} aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-3 flex flex-col gap-2 text-[13px] text-ink-soft" data-testid="active-search-rules">
            {ACTIVE_SEARCH_RULES.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-ink-soft">{EXTERNAL_NOTIFICATION_NOTE}</p>
          <div className="mt-3 flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-2.5 text-accent-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p data-testid="active-search-price-notice" className="text-[13px] font-semibold">{ACTIVE_SEARCH_PRICE_NOTICE}</p>
          </div>
        </>
      )}

      {!compact && purchase.kind === "blocked" ? (
        <p data-testid="active-search-blocked" className="mt-3 rounded-2xl bg-mist p-3.5 text-[14px] font-semibold text-ink-soft">{purchase.text}</p>
      ) : null}
      {!compact && purchase.kind === "none" ? (
        <p role="alert" className="mt-3 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">Votre solde n&apos;a pas pu être lu : l&apos;achat est impossible pour le moment.</p>
      ) : null}
      {!compact && purchase.kind === "insufficient" ? (
        <div data-testid="active-search-insufficient" className="mt-3 rounded-2xl bg-accent-soft p-3.5 text-[14px] text-accent-ink">
          <div className="font-extrabold">{purchase.text}</div>
          <p className="mt-0.5">{purchase.detail}</p>
          <Link href={walletHref({ next: `/besoins/${demandId}`, recharge: true })} data-testid="active-search-recharge" className="press mt-2 inline-flex min-h-11 items-center gap-1.5 font-bold underline">
            <Wallet className="size-4" aria-hidden />
            {ACTIVE_SEARCH_LABELS.recharge}
          </Link>
        </div>
      ) : null}

      {!compact && purchase.kind !== "blocked" && !confirming ? (
        <button
          data-testid="active-search-buy"
          onClick={props.onBuy}
          disabled={!canPurchase(purchase, pending)}
          className={`${BIG_BUTTON} mt-3 bg-brand text-white shadow-md shadow-brand/30 hover:bg-brand-deep`}
        >
          {view.buttonLabel}
        </button>
      ) : null}
      {!compact && purchase.kind === "ready" && confirming ? (
        <div data-testid="active-search-confirmation" className="animate-pop mt-3 rounded-3xl border-2 border-brand/30 bg-white p-4">
          <p className="text-[15px] font-semibold text-ink">{purchaseConfirmationText(purchase, view.isExtension)}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              data-testid="active-search-confirm"
              onClick={props.onConfirm}
              disabled={pending}
              className={`${BIG_BUTTON} bg-brand text-white hover:bg-brand-deep sm:flex-1`}
            >
              {pending ? ACTIVE_SEARCH_LABELS.confirming : ACTIVE_SEARCH_LABELS.confirm}
            </button>
            <button
              onClick={props.onCancel}
              disabled={pending}
              className={`${BIG_BUTTON} border-2 border-line-strong bg-white text-ink hover:border-brand sm:w-auto`}
            >
              {ACTIVE_SEARCH_LABELS.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {actionError ? <p role="alert" data-testid="active-search-action-error" className="mt-3 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">{actionError}</p> : null}
      {done ? <p role="status" data-testid="active-search-done" className="mt-3 rounded-2xl bg-white p-3.5 text-[14px] font-semibold text-success-ink">{done}</p> : null}
    </section>
  );
}
