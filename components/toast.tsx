"use client";

import { useNoma } from "@/lib/store";

export function Toast() {
  const toast = useNoma((s) => s.toast);
  if (!toast) return null;
  return (
    <div role="status" className="animate-toast fixed bottom-24 left-1/2 z-50 w-max max-w-[min(92vw,28rem)] -translate-x-1/2 rounded-full bg-ink px-5 py-3 text-center text-[15px] font-semibold text-white shadow-xl md:bottom-8">
      {toast}
    </div>
  );
}
