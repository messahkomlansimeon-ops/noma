import { ChevronLeft, ChevronRight, CircleHelp, Info, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { IconTile, type TileTone } from "@/components/ui";

/**
 * Éléments visuels communs aux écrans d'administration (refonte visuelle) : uniquement du rendu, aucune logique. Les boutons d'administration portent des attributs (`data-testid`, `disabled`,
 * `aria-*`) que `Btn` ne transmet pas : ils gardent donc l'élément natif, avec les mêmes classes que les boutons de `components/ui.tsx`.
 */

const btnBase = "press inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 py-2 text-[15px] font-bold disabled:cursor-not-allowed disabled:opacity-40";
export const adminBtnPrimary = `${btnBase} bg-brand text-white hover:bg-brand-deep`;
export const adminBtnOutline = `${btnBase} border-2 border-line-strong bg-white text-ink hover:border-brand hover:text-brand`;
export const adminField = "w-full min-h-12 rounded-2xl border-2 border-line bg-white px-4 py-3 text-[16px] text-ink transition-colors hover:border-line-strong";

/** Titre de page : une pastille d'icône puis le titre. */
export function PageHeading({ icon, tone = "brand", children }: { icon: LucideIcon; tone?: TileTone; children: ReactNode }) {
  return (
    <div className="animate-rise flex items-center gap-3 pt-2">
      <IconTile icon={icon} tone={tone} className="size-12" />
      <h1 className="text-[22px] font-extrabold tracking-tight text-ink md:text-[26px]">{children}</h1>
    </div>
  );
}

const noticeTones = {
  accent: "bg-accent-soft text-accent-ink",
  brand: "bg-brand-soft text-brand-ink",
  mist: "bg-mist text-ink-soft",
} as const;

/** Avertissement compact : une icône d'information et une phrase. Les attributs `data-*` passent au paragraphe. */
export function Notice({ tone = "mist", className = "", children, ...rest }: { tone?: keyof typeof noticeTones } & ComponentProps<"p">) {
  return (
    <p {...rest} className={`flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[13px] font-semibold leading-snug ${noticeTones[tone]} ${className}`}>
      <Info className="mt-px size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Aide repliée : une icône d'aide (nom accessible `label`) qui déplie une explication. Le texte reste dans la page, sans encombrer l'écran. */
export function HelpNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="mt-1">
      <summary aria-label={label} className="press flex size-11 cursor-pointer list-none items-center justify-center rounded-full [&::-webkit-details-marker]:hidden text-ink-soft hover:bg-mist">
        <CircleHelp className="size-5" aria-hidden />
      </summary>
      <p className="rounded-2xl bg-mist px-3.5 py-2.5 text-[13px] leading-snug text-ink-soft">{children}</p>
    </details>
  );
}

/** Carte à titre : icône, titre, contenu. Les attributs (`data-*`, `aria-labelledby`) passent à la section. */
export function Panel({
  icon,
  tone = "brand",
  title,
  titleId,
  aside,
  children,
  className = "",
  ...rest
}: {
  icon: LucideIcon;
  tone?: TileTone;
  title: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentProps<"section">, "title">) {
  return (
    <section {...rest} className={`rounded-3xl border border-line bg-white p-4 ${className}`}>
      <div className="flex items-center gap-3">
        <IconTile icon={icon} tone={tone} className="size-10" />
        <h2 id={titleId} className="min-w-0 flex-1 text-[16px] font-extrabold leading-snug tracking-tight text-ink">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Tuile de chiffre du tableau de bord. L'entrée en cascade vient du parent (`stagger`). */
export function StatTile({
  icon,
  tone = "brand",
  label,
  value,
  detail,
  tile,
  className = "",
  valueClassName = "text-[22px] md:text-[24px]",
}: {
  icon: LucideIcon;
  tone?: TileTone;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tile: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div data-tile={tile} className={`flex min-w-0 flex-col gap-2 rounded-3xl border border-line bg-white p-4 ${className}`}>
      <IconTile icon={icon} tone={tone} className="size-10" />
      <div>
        <div className="text-[13px] font-bold leading-tight text-ink-soft">{label}</div>
        <div data-tile-value className={`mt-0.5 font-extrabold leading-tight text-ink [overflow-wrap:anywhere] ${valueClassName}`}>
          {value}
        </div>
        {detail ? <div className="mt-0.5 text-[12px] leading-snug text-ink-soft">{detail}</div> : null}
      </div>
    </div>
  );
}

/** Pagination : deux boutons ronds d'icône (noms accessibles « Précédents » et « Suivants ») et la plage affichée. */
export function Pager({
  rangeText,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  previousTestId,
  nextTestId,
}: {
  rangeText: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousTestId?: string;
  nextTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-[14px] font-semibold text-ink-soft">
      <span>{rangeText}</span>
      <span className="flex gap-2">
        <button disabled={!hasPrevious} onClick={onPrevious} data-testid={previousTestId} aria-label="Précédents" className="press flex size-11 items-center justify-center rounded-full border-2 border-line-strong bg-white text-ink hover:border-brand disabled:opacity-40">
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <button disabled={!hasNext} onClick={onNext} data-testid={nextTestId} aria-label="Suivants" className="press flex size-11 items-center justify-center rounded-full border-2 border-line-strong bg-white text-ink hover:border-brand disabled:opacity-40">
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </span>
    </div>
  );
}
