import type { ReactNode } from "react";
import { AdminTabBar } from "@/components/tab-bar";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-cream sm:border-x sm:border-line">
      <div className="flex-1 pb-28">{children}</div>
      <AdminTabBar />
    </div>
  );
}
