"use client";

import Link from "next/link";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "./ui";
import { LogoMark } from "./logo";

function HeaderBtn({
  icon: Icon,
  href,
  onClick,
  dot,
  label,
}: {
  icon: LucideIcon;
  href?: string;
  onClick?: () => void;
  dot?: boolean;
  /** Nom accessible : le bouton n'a pas de texte visible. */
  label?: string;
}) {
  const cls =
    "press relative flex size-11 items-center justify-center rounded-full text-ink hover:bg-mist";
  const inner = (
    <>
      <Icon className="size-6" strokeWidth={2} aria-hidden />
      {dot && (
        <span className="animate-pulse-ring absolute right-2 top-2 size-2.5 rounded-full bg-accent ring-2 ring-canvas" />
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} aria-label={label}>
        {inner}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls} aria-label={label}>
      {inner}
    </button>
  );
}

export function TopBar({
  back,
  title,
  right,
  center,
  border,
  avatar,
}: {
  back?: string;
  title?: string;
  right?: ReactNode;
  center?: ReactNode;
  border?: boolean;
  avatar?: string;
}) {
  return (
    <header
      className={`sticky top-0 z-20 bg-canvas/90 px-3 py-2 backdrop-blur-md ${
        border ? "border-b border-line" : ""
      }`}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex items-center gap-1">
          {back ? (
            <Link
              href={back}
              aria-label="Retour"
              className="press flex size-11 items-center justify-center rounded-full text-ink hover:bg-mist"
            >
              <ArrowLeft className="size-6" strokeWidth={2.2} aria-hidden />
            </Link>
          ) : (
            <span className="md:hidden">
              <LogoMark />
            </span>
          )}
        </div>
        <div className="truncate text-center text-[17px] font-extrabold text-ink">
          {center ?? title ?? ""}
        </div>
        <div className="flex items-center justify-end gap-1">
          {right}
          {avatar && <Avatar initials={avatar} className="size-8 text-[12px]" />}
        </div>
      </div>
    </header>
  );
}

export { HeaderBtn };
