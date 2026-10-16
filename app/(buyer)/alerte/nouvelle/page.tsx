"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarDays, CircleAlert, FileText, MapPin, Search, Tag, Wallet, Zap } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { FieldLabel, Input, Segmented, Textarea } from "@/components/ui";
import { api, describeApiError } from "@/lib/client/api";
import {
  CATEGORY_OPTIONS,
  CONDITION_OPTIONS,
  FIELD_LIMITS,
  buildDemandInput,
} from "@/lib/client/catalog-view";
import { useNoma } from "@/lib/store";

type Submitting = "activate" | "draft" | null;

const BTN =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[16px] font-bold disabled:cursor-not-allowed disabled:opacity-40";

function FieldError({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="mt-2 flex items-start gap-1.5 text-[13px] font-semibold text-accent-ink">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </div>
  ) : null;
}

/**
 * Création réelle d'un besoin : POST /api/demands (brouillon), puis, sur demande, POST /api/demands/{id}/activate
 * avec la version de contenu renvoyée par le serveur.
 */
function NouveauBesoin() {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [condition, setCondition] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  const [budget, setBudget] = useState("");
  const [deadline, setDeadline] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Submitting>(null);

  const submit = async (mode: "activate" | "draft") => {
    if (submitting) return;
    const today = new Date().toISOString().slice(0, 10);
    const built = buildDemandInput(
      { text, category, brand, model, variant, condition, location, budget, deadline },
      today,
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSubmitting(mode);

    let redirected = false;
    try {
      const created = await api.demands.create(built.input);
      if (mode === "draft") {
        showToast("Brouillon enregistré");
      } else {
        try {
          await api.demands.activate(created.id, created.contentVersion);
          showToast("Besoin activé");
        } catch (failure) {
          // Le besoin existe en brouillon : il reste visible dans « Mes besoins » et peut être activé de là.
          redirected = redirectIfUnauthorized(failure);
          if (!redirected) {
            showToast(`Brouillon enregistré, activation impossible. ${describeApiError(failure, "catalog")}`);
          }
        }
      }
    } catch (failure) {
      redirected = redirectIfUnauthorized(failure);
      if (!redirected) showToast(describeApiError(failure, "catalog"));
      setSubmitting(null);
      return;
    }
    setSubmitting(null);
    if (!redirected) router.push("/alertes");
  };

  return (
    <main>
      <TopBar back="/alertes" title="Nouveau besoin" />

      <div className="flex flex-col gap-4 px-4 pb-6 pt-2">
        <section className="animate-rise flex flex-col gap-4 rounded-3xl border border-line bg-white p-4">
          <div>
            <FieldLabel>
              <span className="flex items-center gap-2">
                <Search className="size-4 text-brand" aria-hidden />
                Que cherchez-vous ?
              </span>
            </FieldLabel>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={FIELD_LIMITS.description}
              rows={3}
              placeholder="Un iPhone 12 en bon état, à Abidjan…"
              aria-invalid={errors.text ? true : undefined}
            />
            <FieldError message={errors.text} />
          </div>

          <div>
            <FieldLabel>
              <span className="flex items-center gap-2">
                <Tag className="size-4 text-brand" aria-hidden />
                Catégorie
              </span>
            </FieldLabel>
            <Segmented
              options={CATEGORY_OPTIONS.map((option) => option.label)}
              value={category ?? ""}
              onChange={(value) => setCategory(value === category ? null : value)}
              size="sm"
            />
          </div>
        </section>

        <section className="animate-rise flex flex-col gap-4 rounded-3xl border border-line bg-white p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Marque</FieldLabel>
              <Input
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
                maxLength={FIELD_LIMITS.short}
                placeholder="Apple"
              />
            </div>
            <div>
              <FieldLabel>Modèle</FieldLabel>
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                maxLength={FIELD_LIMITS.short}
                placeholder="iPhone 12"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Variante</FieldLabel>
            <Input
              value={variant}
              onChange={(event) => setVariant(event.target.value)}
              maxLength={FIELD_LIMITS.short}
              placeholder="128 Go"
            />
          </div>

          <div>
            <FieldLabel>État souhaité</FieldLabel>
            <Segmented
              options={[...CONDITION_OPTIONS]}
              value={condition ?? ""}
              onChange={(value) => setCondition(value === condition ? null : value)}
              tone="carrot"
            />
          </div>
        </section>

        <section className="animate-rise flex flex-col gap-4 rounded-3xl border border-line bg-white p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>
                <span className="flex items-center gap-2">
                  <MapPin className="size-4 text-brand" aria-hidden />
                  Localisation
                </span>
              </FieldLabel>
              <Input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={FIELD_LIMITS.location}
                placeholder="Abidjan"
              />
            </div>
            <div>
              <FieldLabel>
                <span className="flex items-center gap-2">
                  <Wallet className="size-4 text-brand" aria-hidden />
                  Budget max (FCFA)
                </span>
              </FieldLabel>
              <Input
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                inputMode="numeric"
                placeholder="200 000"
                aria-invalid={errors.budget ? true : undefined}
              />
            </div>
          </div>
          <FieldError message={errors.budget} />

          <div>
            <FieldLabel>
              <span className="flex items-center gap-2">
                <CalendarDays className="size-4 text-brand" aria-hidden />
                Besoin avant le
              </span>
            </FieldLabel>
            <Input
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              type="date"
              aria-invalid={errors.deadline ? true : undefined}
            />
            <FieldError message={errors.deadline} />
          </div>
        </section>

        <div className="flex flex-col gap-2.5 md:flex-row-reverse">
          <button
            onClick={() => void submit("activate")}
            disabled={submitting !== null}
            className={`${BTN} bg-brand text-white shadow-md shadow-brand/30 hover:bg-brand-deep`}
          >
            <Zap className="size-5" aria-hidden />
            {submitting === "activate" ? "Activation…" : "Activer le besoin"}
          </button>
          <button
            onClick={() => void submit("draft")}
            disabled={submitting !== null}
            className={`${BTN} border-2 border-line-strong bg-white text-ink hover:border-brand hover:text-brand`}
          >
            <FileText className="size-5" aria-hidden />
            {submitting === "draft" ? "Enregistrement…" : "Enregistrer en brouillon"}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function NouvelleAlerte() {
  return (
    <SessionGate>
      <NouveauBesoin />
    </SessionGate>
  );
}
