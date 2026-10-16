import type { ReactNode } from "react";
import { RoleSwitcher } from "@/components/role-switcher";
import { VendorTabBar } from "@/components/tab-bar";
import { ProNoticesBanner } from "@/components/vendor/pro-notices-banner";

export default function VendorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <VendorTabBar />
      <div className="flex min-w-0 flex-col">
        <RoleSwitcher />
        <ProNoticesBanner />
        <div className="mx-auto w-full max-w-3xl flex-1 pb-28 md:pb-12">{children}</div>
      </div>
    </div>
  );
}
