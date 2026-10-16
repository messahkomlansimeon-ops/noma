"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, MessageSquareText, Smartphone, TriangleAlert } from "lucide-react";
import { ArtShield } from "@/components/illustrations";
import { LogoMark } from "@/components/logo";
import { TopBar } from "@/components/top-bar";
import { Btn, Input } from "@/components/ui";
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
            className="press min-h-11 rounded-full px-4 text-[15px] font-bold text-brand hover:bg-mist"
          >
            Fermer
          </button>
        }
      />

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-6 pb-8">
        <section className="animate-rise flex flex-col items-center gap-2 rounded-[2rem] bg-brand-soft px-5 pb-6 pt-6 text-center">
          <ArtShield className="size-36" />
          <LogoMark size="lg" />
          <h1 className="text-[28px] font-extrabold tracking-tight text-ink">Bienvenue</h1>
        </section>

        <div className="animate-rise flex flex-col gap-3">
          <label htmlFor="phone" className="sr-only">
            Numéro de téléphone
          </label>
          <div className="flex items-center gap-2">
            <span className="flex min-h-14 shrink-0 items-center gap-2 rounded-2xl border-2 border-line bg-white px-3.5 text-[18px] font-bold text-ink">
              <Smartphone className="size-5 text-brand" aria-hidden />
              {COUNTRY_PREFIX}
            </span>
            <Input
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
              className="min-w-0 flex-1 py-3.5 text-[20px] font-bold tracking-wide"
            />
          </div>
          <p className="flex items-center gap-2 text-[14px] font-semibold text-ink-soft">
            <MessageSquareText className="size-5 shrink-0 text-brand" aria-hidden />
            Un code vous sera envoyé par SMS.
          </p>
          {error ? (
            <div id="phone-error" role="alert" className="animate-pop flex items-start gap-2 rounded-2xl bg-danger-soft px-3.5 py-2.5 text-[14px] font-semibold text-danger-ink">
              <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
              {error}
            </div>
          ) : null}
        </div>

        <Btn onClick={() => void submit()} disabled={pending || phoneInput.trim().length === 0} className="min-h-14 text-[18px]">
          {pending ? "Envoi du code…" : "Recevoir un code"}
          <ArrowRight className="size-5" aria-hidden />
        </Btn>

        <div className="text-center">
          <button onClick={() => router.push("/")} className="press min-h-11 px-4 text-[15px] font-bold text-brand underline decoration-brand/30 underline-offset-4">
            Continuer sans compte
          </button>
        </div>

        {/* Lot FIN1 : plus de « Conditions d'utilisation · Confidentialité » : deux mots qui ressemblaient à des liens sans mener nulle part (aucune page n'existe). */}
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
