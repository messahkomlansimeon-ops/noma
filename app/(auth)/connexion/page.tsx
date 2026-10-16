"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Phone, Smartphone } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { TopBar } from "@/components/top-bar";
import { Btn } from "@/components/ui";
import { api, describeApiError } from "@/lib/client/api";
import { isOtpFlowStorageAvailable, saveOtpFlow } from "@/lib/client/otp-flow";
import { startOtpFlow } from "@/lib/client/otp-start";
import { COUNTRY_PREFIX, toCanonicalPhone } from "@/lib/client/phone";
import { safeNextPath } from "@/lib/client/session";

const INVALID_PHONE_MESSAGE =
  "Numéro invalide. Saisissez les 10 chiffres de votre numéro, par exemple 07 00 00 00 42.";

function ConnexionScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Chemin interne uniquement : toute URL absolue ou « // » est ramenée à l'accueil.
  const next = safeNextPath(searchParams.get("next"));
  const [phoneInput, setPhoneInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    const phone = toCanonicalPhone(phoneInput);
    if (!phone) {
      setError(INVALID_PHONE_MESSAGE);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await startOtpFlow(phone, next, {
        canStore: () => isOtpFlowStorageAvailable(),
        requestOtp: (value) => api.auth.requestOtp(value),
        save: (flow) => saveOtpFlow(flow),
        describeError: (failure) => describeApiError(failure, "otp-request"),
      });
      // Stockage bloqué : on reste ici avec un message fixe (aller sur /verification ramènerait à /connexion).
      if (result.ok) router.push("/verification");
      else setError(result.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        center=" "
        right={
          <button
            onClick={() => router.push("/")}
            className="rounded-full px-2 py-1.5 text-[15px] font-bold text-brand transition hover:bg-mist"
          >
            Fermer
          </button>
        }
      />

      <main className="relative flex flex-1 flex-col overflow-hidden px-6 pb-8">
        <div className="pointer-events-none absolute -bottom-16 left-6 h-56 w-44 rounded-t-full bg-brand-soft" />
        <div className="pointer-events-none absolute -bottom-10 left-28 h-40 w-32 rounded-t-full bg-brand-soft/70" />
        <div className="pointer-events-none absolute bottom-24 right-10 size-14 rounded-full bg-accent-soft" />

        <div className="mt-6 flex justify-center">
          <LogoMark size="lg" />
        </div>

        <h1 className="mt-4 text-center text-[32px] font-extrabold text-ink">
          Bienvenue
        </h1>
        <p className="mt-1 text-center text-[15px] text-ink-soft">
          Votre compte, en quelques secondes.
        </p>

        <div className="relative mt-6 rounded-2xl border border-line bg-white p-4">
          <label htmlFor="phone" className="text-[15px] font-bold text-ink">
            Numéro de téléphone
          </label>
          <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-line bg-canvas/50 px-3 py-3">
            <Smartphone className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="flex items-center gap-1 border-r border-line pr-2 text-[15px] font-bold text-ink">
              {COUNTRY_PREFIX}
              <ChevronDown className="size-3.5 text-ink-soft" />
            </span>
            <input
              id="phone"
              value={phoneInput}
              onChange={(event) => {
                setPhoneInput(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="07 00 00 00 42"
              maxLength={24}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "phone-error" : undefined}
              className="w-full bg-transparent text-[15px] font-semibold text-ink"
            />
          </div>
          <div className="mt-2 text-[13px] text-ink-soft">
            Un code vous sera envoyé par SMS.
          </div>
          {error ? (
            <div id="phone-error" role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
              {error}
            </div>
          ) : null}
        </div>

        <Btn
          onClick={() => void submit()}
          disabled={pending || phoneInput.trim().length === 0}
          className="relative mt-5 py-4"
        >
          {pending ? "Envoi du code…" : "Recevoir un code"}
          <Phone className="size-4" />
        </Btn>

        <div className="relative mt-4 text-center">
          <button
            onClick={() => router.push("/")}
            className="text-[15px] font-bold text-brand underline decoration-brand/30 underline-offset-4"
          >
            Continuer sans compte
          </button>
        </div>

        {/* Lot FIN1 : plus de « Conditions d'utilisation · Confidentialité » : deux mots qui ressemblaient à des liens sans mener nulle part (aucune page n'existe). */}
        <div className="mt-auto" />
      </main>
    </div>
  );
}

export default function Connexion() {
  // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
  return (
    <Suspense fallback={null}>
      <ConnexionScreen />
    </Suspense>
  );
}
