import type { ReactNode } from "react";
import { RoleSwitcher } from "@/components/role-switcher";
import { VendorTabBar } from "@/components/tab-bar";
import { ProNoticesBanner } from "@/components/vendor/pro-notices-banner";

export default function VendorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-cream sm:border-x sm:border-line">
      <RoleSwitcher />
      <ProNoticesBanner />
      <div className="flex-1 pb-28">{children}</div>
      <VendorTabBar />
    </div>
  );
}
