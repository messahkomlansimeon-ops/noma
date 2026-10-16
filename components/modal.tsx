"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        aria-label="Fermer"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/50 backdrop-blur-sm"
      />
      <div className="animate-sheet absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-[28px] bg-canvas shadow-2xl md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:rounded-[28px]">
        <div className="flex items-center gap-3 px-4 pb-1 pt-3">
          <span className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-line-strong" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="text-[19px] font-extrabold text-ink">
            {title}
          </span>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="press flex size-11 items-center justify-center rounded-full bg-white text-ink-soft hover:bg-mist"
          >
            <X className="size-6" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-7">{children}</div>
      </div>
    </div>
  );
}