"use client";

import { Megaphone } from "lucide-react";
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

/** Un indicateur en mots simples : une pastille et, dessous, sa précision. */
export function IndicatorLine({ indicator }: { indicator: IndicatorView }) {
  return (
    <li className="flex flex-col items-start gap-0.5" data-indicator={indicator.key}>
      <Badge tone={TONE[indicator.tone]}>{indicator.label}</Badge>
      {indicator.detail ? <span className="pl-0.5 text-[12px] text-ink-soft">{indicator.detail}</span> : null}
    </li>
  );
}

/** Jauge de compatibilité : texte et barre (la valeur ne dit jamais « garantie »). */
function CompatibilityBar({ text, percent }: { text: string; percent: number | null }) {
  return (
    <div className="mt-2">
      <div className="text-[13px] font-bold text-ink">{text}</div>
      {percent !== null ? (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-wash" aria-hidden>
          <div className="h-full rounded-full bg-forest" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Offre dans les résultats d'un besoin : « Sponsorisé » bien visible et distinct quand l'offre a gagné des places grâce à un boost. */
export function BuyerMatchCard({ item }: { item: StoredMatch }) {
  const row = buyerMatchRow(item);
  return (
    <li
      data-testid="match-card"
      data-sponsored={row.sponsored ? "true" : "false"}
      className={`rounded-2xl border bg-white p-3.5 ${row.sponsored ? "border-carrot/60 ring-1 ring-carrot/30" : "border-line"}`}
    >
      {row.sponsoredBadge ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span
            title={row.sponsoredNotice ?? undefined}
            className="inline-flex items-center gap-1 rounded-md bg-carrot px-2 py-[3px] text-[11px] font-extrabold uppercase leading-tight tracking-wide text-white"
          >
            <Megaphone className="size-3" aria-hidden />
            {row.sponsoredBadge}
          </span>
          <span className="text-[12px] font-semibold text-carrot-ink">{row.sponsoredNotice}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Thumb art={artForCategory(item.candidate.category)} className="size-14" iconClassName="size-7" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">{row.title}</div>
          <div className="font-display text-[18px] font-extrabold text-ink">{row.priceText}</div>
          {row.subtitle ? <div className="text-[12px] text-ink-soft">{row.subtitle}</div> : null}
        </div>
      </div>
      <CompatibilityBar text={row.compatibility} percent={row.compatibilityPercent} />
      {row.indicators.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5" aria-label="Indicateurs de l'offre">
          {row.indicators.map((indicator) => (
            <IndicatorLine key={indicator.key} indicator={indicator} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Besoin d'acheteur dans « Acheteurs intéressés » : jamais d'identité, de nom ni de téléphone. */
export function InterestedBuyerCard({ item }: { item: StoredMatch }) {
  const row = interestedBuyerRow(item);
  return (
    <li data-testid="interested-buyer" className="rounded-2xl border border-line bg-white p-3.5">
      <div className="flex items-center gap-3">
        <Thumb art={artForCategory(item.candidate.category)} className="size-12" iconClassName="size-6" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">{row.title}</div>
          <div className="text-[13px] font-semibold text-ink">{row.budgetText}</div>
          {row.subtitle ? <div className="text-[12px] text-ink-soft">{row.subtitle}</div> : null}
        </div>
      </div>
      <CompatibilityBar text={row.compatibility} percent={row.compatibilityPercent} />
      <ul className="mt-2.5 space-y-1.5" aria-label="Confiance dans l'acheteur">
        <IndicatorLine indicator={row.confidence} />
      </ul>
    </li>
  );
}
