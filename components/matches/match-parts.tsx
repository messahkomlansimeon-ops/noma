"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, Info, Megaphone, Minus, TriangleAlert, type LucideIcon } from "lucide-react";
import { ProBadge } from "@/components/pro-badge";
import { Thumb } from "@/components/thumb";
import { Badge, type BadgeTone } from "@/components/ui";
import { artForCategory } from "@/lib/client/catalog-view";
import type { StoredMatch } from "@/lib/client/api";
import {
  buyerMatchRow,
  interestedBuyerRow,
  type IndicatorTone,
  type IndicatorView,
} from "@/lib/client/match-view";

const TONE: Record<IndicatorTone, BadgeTone> = { good: "sage", neutral: "sky", warn: "carrot", muted: "wash" };
const TONE_ICON: Record<IndicatorTone, LucideIcon> = { good: CircleCheck, neutral: Info, warn: TriangleAlert, muted: Minus };

/** Un indicateur en mots simples : une pastille et, dessous, sa précision. */
export function IndicatorLine({ indicator }: { indicator: IndicatorView }) {
  const Icon = TONE_ICON[indicator.tone];
  return (
    <li className="flex flex-col items-start gap-0.5" data-indicator={indicator.key}>
      <Badge tone={TONE[indicator.tone]}>
        <Icon className="size-3.5" aria-hidden />
        {indicator.label}
      </Badge>
      {indicator.detail ? <span className="pl-1 text-[13px] text-ink-soft">{indicator.detail}</span> : null}
    </li>
  );
}

/** Jauge de compatibilité : texte et barre (la valeur ne dit jamais « garantie »). */
function CompatibilityBar({ text, percent }: { text: string; percent: number | null }) {
  return (
    <div className="mt-3">
      <div className="text-[14px] font-bold text-ink">{text}</div>
      {percent !== null ? (
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-mist" aria-hidden>
          <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** « Sponsorisé » bien visible et distinct (résultats et fiche d'une annonce) : jamais affiché sans que le serveur l'ait dit. */
export function SponsoredNotice({ badge, notice }: { badge: string; notice: string | null }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span
        title={notice ?? undefined}
        className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-[12px] font-extrabold uppercase leading-tight tracking-wide text-ink"
      >
        <Megaphone className="size-3.5" aria-hidden />
        {badge}
      </span>
      <span className="text-[13px] font-semibold text-accent-ink">{notice}</span>
    </div>
  );
}

/**
 * Offre dans les résultats d'un besoin : « Sponsorisé » bien visible et distinct quand l'offre a gagné des places grâce à un boost ;
 * `detailHref` (lot M1) mène à la fiche de l'annonce, dans le contexte de ce besoin.
 */
export interface CompareControl {
  selected: boolean;
  onToggle: () => void;
}

export function BuyerMatchCard({ item, detailHref, compare }: { item: StoredMatch; detailHref?: string | null; compare?: CompareControl }) {
  const row = buyerMatchRow(item);
  return (
    <li
      data-testid="match-card"
      data-sponsored={row.sponsored ? "true" : "false"}
      className={`rounded-3xl border bg-white p-4 ${row.sponsored ? "border-accent ring-2 ring-accent/30" : "border-line"}`}
    >
      {row.sponsoredBadge ? <SponsoredNotice badge={row.sponsoredBadge} notice={row.sponsoredNotice} /> : null}
      <div className="flex items-center gap-3">
        <Thumb art={artForCategory(item.candidate.category)} className="size-16" iconClassName="size-8" photoId={item.coverPhotoId} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{row.title}</div>
          <div className="text-[20px] font-extrabold leading-tight text-ink">{row.priceText}</div>
          {row.subtitle ? <div className="text-[13px] text-ink-soft">{row.subtitle}</div> : null}
          {row.proBadge ? <div className="mt-1"><ProBadge /></div> : null}
        </div>
      </div>
      <CompatibilityBar text={row.compatibility} percent={row.compatibilityPercent} />
      {row.indicators.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Indicateurs de l'offre">
          {row.indicators.map((indicator) => (
            <IndicatorLine key={indicator.key} indicator={indicator} />
          ))}
        </ul>
      ) : null}
      {compare ? (
        <label className="press mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl bg-mist px-3.5 text-[14px] font-semibold text-ink">
          <input
            type="checkbox"
            data-testid="match-compare"
            checked={compare.selected}
            onChange={compare.onToggle}
            className="size-5 accent-brand"
          />
          Comparer
        </label>
      ) : null}
      {detailHref ? (
        <Link
          href={detailHref}
          data-testid="match-detail-link"
          className="press mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand"
        >
          Voir l'annonce
          <ArrowRight className="size-5" aria-hidden />
        </Link>
      ) : null}
    </li>
  );
}

/** Besoin d'acheteur dans « Acheteurs intéressés » : jamais d'identité, de nom ni de téléphone. */
export function InterestedBuyerCard({ item }: { item: StoredMatch }) {
  const row = interestedBuyerRow(item);
  return (
    <li data-testid="interested-buyer" className="rounded-3xl border border-line bg-white p-4">
      <div className="flex items-center gap-3">
        <Thumb art={artForCategory(item.candidate.category)} className="size-14" iconClassName="size-7" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{row.title}</div>
          <div className="text-[15px] font-bold text-ink">{row.budgetText}</div>
          {row.subtitle ? <div className="text-[13px] text-ink-soft">{row.subtitle}</div> : null}
        </div>
      </div>
      <CompatibilityBar text={row.compatibility} percent={row.compatibilityPercent} />
      <ul className="mt-3 flex flex-col gap-2" aria-label="Confiance dans l'acheteur">
        <IndicatorLine indicator={row.confidence} />
      </ul>
    </li>
  );
}
