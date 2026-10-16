"use client";

import { Info, RotateCw, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { ArtAlert } from "@/components/illustrations";
import { FieldLabel, IconTile, Skeleton, type TileTone } from "@/components/ui";

/**
 * Petites briques de l'espace vendeur, composées avec `components/ui.tsx` sans le modifier. Les boutons qui portent un `data-testid`, un `type` ou un `aria-*` restent
 * des `<button>` natifs (les primitives `Btn` n'acceptent pas ces attributs) : ils prennent le même aspect par ces classes.
 */
export const BTN_PRIMARY =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white shadow-[0_6px_16px_-8px_rgb(43_63_214/0.8)] hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40";
export const BTN_OUTLINE =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40";
/** Bouton de taille réduite (actions de carte) : 44 px de haut, qui s'étire dans une rangée. */
export const BTN_SMALL =
  "press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-2xl border-2 border-line-strong bg-white px-4 py-2 text-[14px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40";
/** Lien-texte touchable (44 px) : « Actualiser », « Mon porte-monnaie »… */
export const LINK_ACTION =
  "press inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-bold text-brand hover:bg-brand-soft disabled:opacity-50";
/** Carte blanche de l'espace vendeur. */
export const CARD = "rounded-3xl border border-line bg-white p-4";

const noticeTones = {
  info: "bg-info-soft text-info-ink",
  brand: "bg-brand-soft text-brand-ink",
  accent: "bg-accent-soft text-accent-ink",
  danger: "bg-danger-soft text-danger-ink",
  mist: "bg-mist text-ink-soft",
} as const;

/** Encart de texte court (avertissement, confirmation, erreur) : une icône et une phrase. Les attributs `role` et `data-*` passent tels quels. */
export function Notice({
  tone = "mist",
  icon: Icon = Info,
  children,
  className = "",
  small = false,
  ...rest
}: {
  tone?: keyof typeof noticeTones;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  /** Légende : 13 px, graisse moyenne (au lieu de 14 px gras). */
  small?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`flex items-start gap-2.5 rounded-2xl px-3.5 py-3 leading-snug ${small ? "text-[13px] font-medium" : "text-[14px] font-semibold"} ${noticeTones[tone]} ${className}`}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Erreur de chargement : une illustration, le message, et « Réessayer » quand l'écran sait relancer. */
export function ErrorState({ message, onRetry, className = "" }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={`animate-rise flex flex-col items-center gap-4 px-4 py-8 text-center ${className}`}>
      <ArtAlert className="size-28" />
      <p className="max-w-[32ch] text-[16px] font-bold leading-snug text-ink">{message}</p>
      {onRetry ? (
        <div className="w-full max-w-xs">
          <button onClick={onRetry} className={BTN_PRIMARY}>
            <RotateCw className="size-5" aria-hidden />
            Réessayer
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Chargement : des rectangles qui brillent ; le texte d'origine reste pour les lecteurs d'écran. */
export function LoadingBlock({ label, rows = 3, rowClassName = "h-24 w-full rounded-3xl", className = "" }: { label: string; rows?: number; rowClassName?: string; className?: string }) {
  return (
    <div aria-busy="true" className={`flex flex-col gap-3 ${className}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={rowClassName} />
      ))}
    </div>
  );
}

/** Titre de section : une icône devant, un mot. `aside` se place à droite. */
export function SectionHeading({
  icon: Icon,
  children,
  id,
  aside,
  level = 2,
}: {
  icon: LucideIcon;
  children: ReactNode;
  id?: string;
  aside?: ReactNode;
  level?: 2 | 3;
}) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <div className="flex items-center justify-between gap-3">
      <Tag id={id} className={`flex items-center gap-2 font-extrabold tracking-tight text-ink ${level === 2 ? "text-[18px]" : "text-[16px]"}`}>
        <Icon className="size-5 shrink-0 text-brand" aria-hidden />
        {children}
      </Tag>
      {aside}
    </div>
  );
}

/** Libellé de champ avec son icône. */
export function IconLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <FieldLabel>
      <span className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-brand" aria-hidden />
        {children}
      </span>
    </FieldLabel>
  );
}

/** Ligne de carte : pastille d'icône, titre et valeur. */
export function IconRow({ icon, tone = "brand", children }: { icon: LucideIcon; tone?: TileTone; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <IconTile icon={icon} tone={tone} className="size-11" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
