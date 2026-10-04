"use client";

import { useRouter } from "next/navigation";
import { ChevronDown, Phone, Smartphone } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { TopBar } from "@/components/top-bar";
import { Btn } from "@/components/ui";

export default function Connexion() {
  const router = useRouter();

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        center=" "
        right={
          <button
            onClick={() => router.push("/")}
            className="rounded-full px-2 py-1.5 text-[14px] font-bold text-forest transition hover:bg-wash"
          >
            Fermer
          </button>
        }
      />

      <main className="relative flex flex-1 flex-col overflow-hidden px-6 pb-8">
        <div className="pointer-events-none absolute -bottom-16 left-6 h-56 w-44 rounded-t-full bg-sage" />
        <div className="pointer-events-none absolute -bottom-10 left-28 h-40 w-32 rounded-t-full bg-sage/70" />
        <div className="pointer-events-none absolute bottom-24 right-10 size-14 rounded-full bg-carrot-soft" />

        <div className="mt-6 flex justify-center">
          <LogoMark size="lg" />
        </div>

        <h1 className="mt-4 text-center font-display text-[32px] font-extrabold text-ink">
          Bienvenue
        </h1>
        <p className="mt-1 text-center text-[14px] text-ink-soft">
          Votre compte, en quelques secondes.
        </p>

        <div className="relative mt-6 rounded-2xl border border-line bg-white p-4">
          <div className="text-[14px] font-bold text-ink">
            Numéro de téléphone
          </div>
          <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-line bg-cream/50 px-3 py-3">
            <Smartphone className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="flex items-center gap-1 border-r border-line pr-2 text-[15px] font-bold text-ink">
              +225
              <ChevronDown className="size-3.5 text-ink-soft" />
            </span>
            <input
              defaultValue="07 00 00 00 42"
              inputMode="tel"
              className="w-full bg-transparent text-[15px] font-semibold text-ink"
            />
          </div>
          <div className="mt-2 text-[12px] text-ink-soft">
            Un code vous sera envoyé par SMS.
          </div>
        </div>

        <Btn onClick={() => router.push("/verification")} className="relative mt-5 py-4">
          Recevoir un code
          <Phone className="size-4" />
        </Btn>

        <div className="relative mt-4 text-center">
          <button
            onClick={() => router.push("/")}
            className="text-[14px] font-bold text-forest underline decoration-forest/30 underline-offset-4"
          >
            Continuer sans compte
          </button>
        </div>

        <div className="relative mt-auto pt-10 text-center text-[12px] text-ink-soft">
          <span className="font-semibold">Conditions d'utilisation</span>
          <span className="mx-2">·</span>
          <span className="font-semibold">Confidentialité</span>
        </div>
      </main>
    </div>
  );
}
