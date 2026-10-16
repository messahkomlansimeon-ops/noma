"use client";

import Link from "next/link";
import { ChevronRight, RotateCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ArtAlert } from "@/components/illustrations";

/** Les noms de tons (carrot, sage…) sont des valeurs métier déjà utilisées partout : seule leur apparence change. */
const badgeTones = {
  carrot: "bg-accent-soft text-accent-ink",
  sage: "bg-success-soft text-success-ink",
  sky: "bg-info-soft text-info-ink",
  wash: "bg-mist text-ink-soft",
  forest: "bg-brand text-white",
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({
  tone,
  children,
  className = "",
}: {
  tone: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold leading-tight ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const avatarTones = {
  sage: "bg-brand-soft text-brand",
  carrot: "bg-accent-soft text-accent-ink",
  sky: "bg-info-soft text-info-ink",
} as const;

export function Avatar({
  initials,
  tone = "sage",
  className = "size-10 text-[14px]",
}: {
  initials: string;
  tone?: keyof typeof avatarTones;
  className?: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-extrabold ${avatarTones[tone]} ${className}`}
    >
      {initials}
    </span>
  );
}

/** Pastille ronde : un filtre, une option. Touchable (44 px de haut) quand elle a une action. */
export function Chip({
  children,
  active,
  soft,
  onClick,
  className = "",
}: {
  children: ReactNode;
  active?: boolean;
  soft?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const base =
    "press inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 py-2 text-[14px] font-semibold";
  const look = active
    ? "border border-transparent bg-brand text-white"
    : soft
      ? "border border-transparent bg-brand-soft text-brand-ink"
      : "border border-line-strong bg-white text-ink";
  if (onClick) {
    return (
      <button onClick={onClick} className={`${base} ${look} ${className}`}>
        {children}
      </button>
    );
  }
  return <span className={`${base} ${look} ${className}`}>{children}</span>;
}

const btnBase =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[16px] font-bold disabled:cursor-not-allowed disabled:opacity-40";

/** Attributs transmis tels quels au bouton ou au lien : `type`, `data-*`, `aria-*`, `id`, `title`… */
type PassThrough = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "className" | "disabled" | "children"
>;

interface BtnProps extends PassThrough {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

function renderBtn(cls: string, { children, href, onClick, disabled, ...rest }: BtnProps) {
  if (href && !disabled) {
    return (
      <Link href={href} className={cls} {...(rest as Record<string, unknown>)}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} disabled={disabled} className={cls} {...rest}>
      {children}
    </button>
  );
}

export function Btn({ className = "", ...props }: BtnProps) {
  return renderBtn(
    `${btnBase} bg-brand text-white shadow-[0_6px_16px_-8px_rgb(43_63_214/0.8)] hover:bg-brand-deep ${className}`,
    props,
  );
}

export function BtnOutline({ className = "", ...props }: BtnProps) {
  return renderBtn(
    `${btnBase} border-2 border-line-strong bg-white text-ink hover:border-brand hover:text-brand ${className}`,
    props,
  );
}

export function KvRow({
  label,
  value,
  className = "",
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3 text-[14px] ${className}`}
    >
      <span className="shrink-0 text-ink-soft">{label}</span>
      <span className="text-right font-semibold text-ink">{value}</span>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-[18px] font-extrabold tracking-tight text-ink">{children}</h2>;
}

const fieldBase =
  "w-full rounded-2xl border-2 border-line bg-white px-4 py-3 text-[16px] text-ink transition-colors placeholder:text-ink-soft/60 hover:border-line-strong";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldBase} min-h-12 ${props.className ?? ""}`} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return <textarea {...props} className={`${fieldBase} resize-none ${props.className ?? ""}`} />;
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[14px] font-bold text-ink">{children}</div>;
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  /** Nom accessible du commutateur (lecteurs d'écran). */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange?.(!checked)}
      className="press flex h-11 w-16 shrink-0 items-center justify-center"
    >
      <span
        className={`relative h-8 w-14 rounded-full transition-colors ${
          checked ? "bg-brand" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute top-1 size-6 rounded-full bg-white shadow-md transition-all duration-200 ${
            checked ? "left-7" : "left-1"
          }`}
        />
      </span>
    </button>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  tone = "forest",
  size = "md",
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  tone?: "forest" | "carrot";
  size?: "sm" | "md";
}) {
  const sel =
    tone === "carrot"
      ? "border-accent bg-accent-soft text-accent-ink"
      : "border-transparent bg-brand text-white";
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const selected = o === value;
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`press min-h-11 rounded-full border-2 font-semibold ${size === "sm" ? "px-3.5 py-2 text-[13px]" : "px-5 py-2.5 text-[14px]"} ${
              selected ? sel : "border-line bg-white text-ink hover:border-line-strong"
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function OptionCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`press flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 p-4 text-left text-[15px] font-semibold ${
        selected ? "border-brand bg-brand-soft text-ink" : "border-line bg-white text-ink hover:border-line-strong"
      }`}
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
          selected ? "bg-brand" : "border-2 border-line-strong"
        }`}
      >
        {selected && <span className="size-2.5 rounded-full bg-white" />}
      </span>
      {children}
    </button>
  );
}

export function WhatsAppIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

const tileTones = {
  brand: "bg-brand-soft text-brand",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success-ink",
  info: "bg-info-soft text-info-ink",
  danger: "bg-danger-soft text-danger-ink",
  mist: "bg-mist text-ink-soft",
} as const;

export type TileTone = keyof typeof tileTones;

/** Pastille colorée qui porte une icône : l'image remplace le texte. */
export function IconTile({
  icon: Icon,
  tone = "brand",
  className = "size-11",
}: {
  icon: LucideIcon;
  tone?: TileTone;
  className?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-2xl ${tileTones[tone]} ${className}`}>
      <Icon className="size-[55%]" strokeWidth={2} aria-hidden />
    </span>
  );
}

/** Carte blanche à bords doux : le conteneur de base de toutes les listes. */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-3xl border border-line bg-white p-4 shadow-[0_1px_0_rgb(17_20_43/0.03)] ${className}`}>
      {children}
    </div>
  );
}

/** Liste vide : une illustration, une phrase, au plus une action. */
export function EmptyState({
  art,
  title,
  action,
  ...rest
}: {
  art: ReactNode;
  title: string;
  action?: ReactNode;
  role?: string;
  "data-testid"?: string;
}) {
  return (
    <div {...rest} className="animate-rise flex flex-col items-center gap-5 px-6 py-10 text-center">
      {art}
      <p className="max-w-[28ch] text-[17px] font-bold leading-snug text-ink">{title}</p>
      {action ? <div className="w-full max-w-xs">{action}</div> : null}
    </div>
  );
}

/** Erreur de chargement : illustration, phrase, bouton « Réessayer ». */
export function ErrorState({
  message,
  onRetry,
  retryLabel = "Réessayer",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="animate-rise flex flex-col items-center gap-4 px-6 py-10 text-center">
      <ArtAlert />
      <p className="max-w-[30ch] text-[17px] font-bold leading-snug text-ink">{message}</p>
      {onRetry ? (
        <div className="w-full max-w-xs">
          <Btn onClick={onRetry}>
            <RotateCw className="size-5" aria-hidden />
            {retryLabel}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/** Rectangle qui brille pendant un chargement. */
export function Skeleton({ className = "h-5 w-full" }: { className?: string }) {
  return <div className={`skeleton rounded-xl ${className}`} aria-hidden />;
}

export function MenuRow({
  icon: Icon,
  label,
  badge,
  href,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  badge?: number;
  href?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <IconTile icon={Icon} className="size-10" />
      <span className="text-[16px] font-bold text-ink">{label}</span>
      {badge ? (
        <span className="flex min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-[12px] font-extrabold leading-6 text-ink">
          {badge}
        </span>
      ) : null}
      <ChevronRight className="ml-auto size-5 text-ink-soft" aria-hidden />
    </>
  );
  const cls = "press flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-mist/70";
  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

export function StatCard({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  tone: "sage" | "carrot" | "wash";
}) {
  const tones = {
    sage: "bg-success-soft text-success-ink",
    carrot: "bg-accent-soft text-accent-ink",
    wash: "bg-mist text-ink-soft",
  };
  return (
    <div className={`animate-pop flex flex-col gap-1.5 rounded-3xl p-4 ${tones[tone]}`}>
      <Icon className="size-6" strokeWidth={2} aria-hidden />
      <div className="text-[28px] font-extrabold leading-none text-ink">{value}</div>
      <div className="text-[13px] font-semibold leading-tight">{label}</div>
    </div>
  );
}
