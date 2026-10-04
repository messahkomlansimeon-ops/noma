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
}: {
  icon: LucideIcon;
  href?: string;
  onClick?: () => void;
  dot?: boolean;
}) {
  const cls =
    "relative flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash";
  const inner = (
    <>
      <Icon className="size-5" strokeWidth={1.9} />
      {dot && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-carrot ring-2 ring-cream" />
      )}
    </>
  );
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
      className={`sticky top-0 z-20 bg-cream/95 px-3 py-2 backdrop-blur ${
        border ? "border-b border-line" : ""
      }`}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex items-center gap-1">
          {back ? (
            <Link
              href={back}
              aria-label="Retour"
              className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
            >
              <ArrowLeft className="size-5" strokeWidth={2} />
            </Link>
          ) : (
            <LogoMark />
          )}
        </div>
        <div className="truncate text-center text-[15px] font-bold text-ink">
          {center ?? title ?? ""}
        </div>
        <div className="flex items-center justify-end gap-1">
          {right}
          {avatar && <Avatar initials={avatar} className="size-8 text-[11px]" />}
        </div>
      </div>
    </header>
  );
}

export { HeaderBtn };
