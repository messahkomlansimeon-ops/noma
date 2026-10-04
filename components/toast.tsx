"use client";

import { useNoma } from "@/lib/store";

export function Toast() {
  const toast = useNoma((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="animate-toast fixed bottom-24 left-1/2 z-50 max-w-[440px] -translate-x-1/2 rounded-full bg-ink px-4 py-2.5 text-center text-[13px] font-semibold text-white shadow-lg">
      {toast}
    </div>
  );
}
