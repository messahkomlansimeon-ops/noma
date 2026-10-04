"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, X } from "lucide-react";
import { useNoma, type Role } from "@/lib/store";

const defs: { role: Role; label: string; href: string }[] = [
  { role: "buyer", label: "Acheteur", href: "/" },
  { role: "vendor", label: "Vendeur", href: "/vendeur" },
  { role: "admin", label: "Admin", href: "/admin" },
];

export function RoleSwitcher() {
  const role = useNoma((s) => s.role);
  const setRole = useNoma((s) => s.setRole);
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const current = defs.find((d) => d.role === role);

  return (
    <div className="fixed right-3 top-16 z-40 flex flex-col items-end gap-1.5">
      {open &&
        defs
          .filter((d) => d.role !== role)
          .map((d) => (
            <button
              key={d.role}
              onClick={() => {
                setRole(d.role);
                router.push(d.href);
                setOpen(false);
              }}
              className="rounded-full border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink shadow-md transition hover:bg-wash"
            >
              {d.label}
            </button>
          ))}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-2 text-[11px] font-extrabold uppercase tracking-wide text-white shadow-lg transition hover:bg-ink/90"
      >
        {open ? <X className="size-3.5" /> : <ArrowLeftRight className="size-3.5" />}
        {current?.label ?? "Acheteur"}
      </button>
    </div>
  );
}
