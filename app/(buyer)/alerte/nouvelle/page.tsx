"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck } from "lucide-react";
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

function FieldError({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
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

      <div className="px-4">
        <div className="space-y-4">
          <div>
            <FieldLabel>Que cherchez-vous ?</FieldLabel>
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
            <FieldLabel>Catégorie (facultatif)</FieldLabel>
            <Segmented
              options={CATEGORY_OPTIONS.map((option) => option.label)}
              value={category ?? ""}
              onChange={(value) => setCategory(value === category ? null : value)}
              size="sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
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
            <FieldLabel>Variante (facultatif)</FieldLabel>
            <Input
              value={variant}
              onChange={(event) => setVariant(event.target.value)}
              maxLength={FIELD_LIMITS.short}
              placeholder="128 Go"
            />
          </div>

          <div>
            <FieldLabel>État souhaité (facultatif)</FieldLabel>
            <Segmented
              options={[...CONDITION_OPTIONS]}
              value={condition ?? ""}
              onChange={(value) => setCondition(value === condition ? null : value)}
              tone="carrot"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <FieldLabel>Localisation</FieldLabel>
              <Input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={FIELD_LIMITS.location}
                placeholder="Abidjan"
              />
            </div>
            <div>
              <FieldLabel>Budget max (FCFA)</FieldLabel>
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
            <FieldLabel>Besoin avant le (facultatif)</FieldLabel>
            <Input
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              type="date"
              aria-invalid={errors.deadline ? true : undefined}
            />
            <FieldError message={errors.deadline} />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-forest">
          <CheckCheck className="size-4" />
          Vous pouvez archiver ce besoin à tout moment.
        </div>

        <button
          onClick={() => void submit("activate")}
          disabled={submitting !== null}
          className="mt-5 w-full rounded-xl bg-forest py-4 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting === "activate" ? "Activation…" : "Activer le besoin"}
        </button>
        <button
          onClick={() => void submit("draft")}
          disabled={submitting !== null}
          className="mt-2.5 w-full rounded-xl border border-forest/30 bg-white py-3.5 text-[15px] font-bold text-forest transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting === "draft" ? "Enregistrement…" : "Enregistrer en brouillon"}
        </button>
        <div className="py-4 text-center text-[12px] text-ink-soft">
          Un besoin brouillon n'est pas pris en compte tant qu'il n'est pas activé.
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
