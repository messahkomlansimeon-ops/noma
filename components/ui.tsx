"use client";

import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const badgeTones = {
  carrot: "bg-carrot-soft text-carrot-ink",
  sage: "bg-sage text-sage-ink",
  sky: "bg-sky text-sky-ink",
  wash: "bg-wash text-ink-soft",
  forest: "bg-forest text-white",
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
      className={`inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-bold leading-tight ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const avatarTones = {
  sage: "bg-sage text-forest",
  carrot: "bg-carrot-soft text-carrot-ink",
  sky: "bg-sky text-sky-ink",
} as const;

export function Avatar({
  initials,
  tone = "sage",
  className = "size-9 text-[13px]",
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
    "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition";
  const look = active
    ? "bg-forest text-white"
    : soft
      ? "border border-transparent bg-carrot-soft text-carrot-ink"
      : "border border-line bg-white text-ink";
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
  "flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-[15px] font-bold transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40";

export function Btn({
  children,
  href,
  onClick,
  className = "",
  disabled,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const cls = `${btnBase} bg-forest text-white ${className}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

export function BtnOutline({
  children,
  href,
  onClick,
  className = "",
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const cls = `${btnBase} border border-forest/30 bg-white text-forest ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
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
      className={`flex items-center justify-between gap-4 py-2.5 text-[13px] ${className}`}
    >
      <span className="shrink-0 text-ink-soft">{label}</span>
      <span className="text-right font-semibold text-ink">{value}</span>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[16px] font-extrabold text-ink">{children}</h2>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-soft/50 ${props.className ?? ""}`}
    />
  );
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea
      {...props}
      className={`w-full resize-none rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-soft/50 ${props.className ?? ""}`}
    />
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[13px] font-bold text-ink">{children}</div>
  );
}

export function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange?.(!checked)}
      className={`relative h-[26px] w-11 shrink-0 rounded-full transition ${
        checked ? "bg-forest" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-[3px] size-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[22px]" : "left-[3px]"
        }`}
      />
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
      ? "border-carrot/40 bg-carrot-soft text-carrot-ink"
      : "border-transparent bg-forest text-white";
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const selected = o === value;
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`rounded-full border font-semibold transition ${size === "sm" ? "px-3 py-1.5 text-[12px]" : "px-4 py-2 text-[13px]"} ${
              selected ? sel : "border-line bg-white text-ink"
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
      className={`flex w-full items-center gap-3 rounded-xl border p-3.5 text-left text-[14px] font-semibold transition ${
        selected ? "border-carrot bg-carrot-soft/60 text-ink" : "border-line bg-white text-ink"
      }`}
    >
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full ${
          selected ? "bg-carrot" : "border-2 border-line"
        }`}
      >
        {selected && <span className="size-2 rounded-full bg-white" />}
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
      <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
        <Icon className="size-[18px]" strokeWidth={1.9} />
      </span>
      <span className="text-[14px] font-bold text-ink">{label}</span>
      {badge ? (
        <span className="flex size-5 items-center justify-center rounded-full bg-carrot text-[11px] font-extrabold text-white">
          {badge}
        </span>
      ) : null}
      <ChevronRight className="ml-auto size-4 text-ink-soft" />
    </>
  );
  const cls = "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-wash/60";
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
    sage: "bg-sage",
    carrot: "bg-carrot-soft",
    wash: "bg-wash",
  };
  return (
    <div className={`flex flex-col gap-1 rounded-2xl p-3.5 ${tones[tone]}`}>
      <Icon className="size-5 text-forest" strokeWidth={1.9} />
      <div className="font-display text-[22px] font-extrabold leading-none text-ink">
        {value}
      </div>
      <div className="text-[11px] font-semibold leading-tight text-ink-soft">
        {label}
      </div>
    </div>
  );
}
