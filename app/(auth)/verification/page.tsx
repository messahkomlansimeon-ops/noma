"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Delete, MessageSquareText } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Btn } from "@/components/ui";
import { api, describeApiError } from "@/lib/client/api";
import { clearOtpFlow, readOtpFlow, saveOtpFlow } from "@/lib/client/otp-flow";
import { STORAGE_BLOCKED_MESSAGE, changeNumberHref } from "@/lib/client/otp-start";
import { maskPhoneForDisplay } from "@/lib/client/phone";
import { useOtpFlow } from "@/lib/client/use-otp-flow";
import { useNoma } from "@/lib/store";

const CODE_LENGTH = 6;

function countdown(resendAvailableAt: string, now: number): { seconds: number; label: string } {
  const seconds = Math.max(0, Math.ceil((Date.parse(resendAvailableAt) - now) / 1000));
  const label = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return { seconds, label };
}

export default function Verification() {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const flow = useOtpFlow();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"verify" | "resend" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Sans parcours dans cet onglet (page ouverte directement, onglet rouvert) : retour à la saisie du numéro.
  // La lecture se fait directement dans le stockage : la valeur rendue pendant l'hydratation est encore nulle.
  useEffect(() => {
    if (!readOtpFlow()) router.replace("/connexion");
  }, [router]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const push = (digit: string) => {
    setError(null);
    setCode((current) => (current.length >= CODE_LENGTH ? current : current + digit));
  };
  const pop = () => {
    setError(null);
    setCode((current) => current.slice(0, -1));
  };

  const verify = async () => {
    if (!flow || pending || code.length !== CODE_LENGTH) return;
    setPending("verify");
    setError(null);
    try {
      await api.auth.verifyOtp(flow.challengeId, code);
      clearOtpFlow();
      showToast("Numéro vérifié · Bienvenue !");
      router.replace(flow.next);
    } catch (failure) {
      setError(describeApiError(failure, "otp-verify"));
      setCode("");
    } finally {
      setPending(null);
    }
  };

  const resend = async () => {
    if (!flow || pending) return;
    setPending("resend");
    setError(null);
    try {
      const challenge = await api.auth.requestOtp(flow.phone);
      if (!saveOtpFlow({ phone: flow.phone, ...challenge, next: flow.next })) {
        // Le nouveau challenge n'a pas pu être conservé : le code reçu ne pourrait pas être vérifié.
        setError(STORAGE_BLOCKED_MESSAGE);
        return;
      }
      setCode("");
      setNow(Date.now());
      showToast("Nouveau code envoyé");
    } catch (failure) {
      setError(describeApiError(failure, "otp-request"));
    } finally {
      setPending(null);
    }
  };

  const changeNumber = () => {
    // La destination est lue avant l'effacement du parcours : elle suit l'utilisateur jusqu'à /connexion?next=…
    const href = changeNumberHref(flow);
    clearOtpFlow();
    router.push(href);
  };

  const wait = flow ? countdown(flow.resendAvailableAt, now) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        center={
          <span className="flex items-center justify-center gap-1.5">
            <span className="font-display text-[20px] font-extrabold text-forest">
              noma
            </span>
          </span>
        }
      />

      <main className="flex flex-1 flex-col px-6 pb-6">
        <div className="mt-4 flex justify-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-sage text-forest">
            <MessageSquareText className="size-8" strokeWidth={1.7} />
          </span>
        </div>

        <h1 className="mt-4 text-center font-display text-[24px] font-extrabold text-ink">
          Vérifiez votre numéro
        </h1>
        <p className="mt-1 text-center text-[14px] text-ink-soft">
          {flow ? `Code envoyé au ${maskPhoneForDisplay(flow.phone)}` : " "}
        </p>
        <div className="mt-2 text-center">
          <button
            onClick={changeNumber}
            className="text-[13px] font-bold text-forest underline underline-offset-2"
          >
            Modifier le numéro
          </button>
        </div>

        <div className="relative mt-6 flex justify-center gap-2">
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <div
              key={i}
              className={`flex h-14 w-11 items-center justify-center rounded-xl border-2 bg-white font-display text-[24px] font-extrabold text-ink ${
                code.length === i
                  ? "border-carrot"
                  : code.length > i
                    ? "border-forest/60"
                    : "border-line"
              }`}
            >
              {code[i] ?? ""}
            </div>
          ))}
          <input
            value={code}
            onChange={(event) => {
              setError(null);
              setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, CODE_LENGTH));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void verify();
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Code reçu par SMS, 6 chiffres"
            maxLength={CODE_LENGTH}
            className="absolute inset-0 w-full cursor-text opacity-0"
          />
        </div>

        {error ? (
          <div role="alert" className="mt-3 text-center text-[13px] font-semibold text-carrot-ink">
            {error}
          </div>
        ) : null}

        <Btn
          onClick={() => void verify()}
          disabled={!flow || code.length !== CODE_LENGTH || pending !== null}
          className="mt-6 py-4"
        >
          {pending === "verify" ? "Vérification…" : "Vérifier"}
        </Btn>
        <div className="mt-3 text-center text-[13px] text-ink-soft">
          {wait && wait.seconds > 0 ? (
            <>
              Renvoyer le code dans <span className="font-bold text-ink">{wait.label}</span>
            </>
          ) : (
            <button
              onClick={() => void resend()}
              disabled={!flow || pending !== null}
              className="font-bold text-forest underline underline-offset-2 disabled:opacity-40"
            >
              {pending === "resend" ? "Envoi…" : "Renvoyer le code"}
            </button>
          )}
        </div>

        <div className="mt-auto rounded-2xl bg-wash p-3">
          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map(
              (k) =>
                k === "" ? (
                  <span key="blank" />
                ) : k === "del" ? (
                  <button
                    key={k}
                    onClick={pop}
                    className="flex h-12 items-center justify-center rounded-xl bg-white text-ink transition active:bg-line"
                    aria-label="Effacer"
                  >
                    <Delete className="size-5" strokeWidth={1.8} />
                  </button>
                ) : (
                  <button
                    key={k}
                    onClick={() => push(k)}
                    className="h-12 rounded-xl bg-white font-display text-[20px] font-bold text-ink transition active:bg-line"
                  >
                    {k}
                  </button>
                ),
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
