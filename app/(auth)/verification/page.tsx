"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Delete, MessageSquareText } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Btn } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function Verification() {
  const router = useRouter();
  const setRole = useNoma((s) => s.setRole);
  const showToast = useNoma((s) => s.showToast);
  const [code, setCode] = useState("");
  const [left, setLeft] = useState(28);

  useEffect(() => {
    const t = setInterval(() => setLeft((l) => (l > 0 ? l - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);

  const push = (d: string) => setCode((c) => (c.length >= 5 ? c : c + d));
  const pop = () => setCode((c) => c.slice(0, -1));

  const verify = () => {
    setRole("buyer");
    showToast("Numéro vérifié · Bienvenue !");
    router.push("/");
  };

  const mmss = `00:${left.toString().padStart(2, "0")}`;

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
          Code envoyé au +225 07 •• •••• 42
        </p>
        <div className="mt-2 text-center">
          <button className="text-[13px] font-bold text-forest underline underline-offset-2">
            Modifier le numéro
          </button>
        </div>

        <div className="mt-6 flex justify-center gap-2.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`flex h-14 w-12 items-center justify-center rounded-xl border-2 bg-white font-display text-[24px] font-extrabold text-ink ${
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
        </div>

        <Btn onClick={verify} disabled={code.length < 5} className="mt-6 py-4">
          Vérifier
        </Btn>
        <div className="mt-3 text-center text-[13px] text-ink-soft">
          Renvoyer le code dans{" "}
          <span className="font-bold text-ink">{mmss}</span>
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
