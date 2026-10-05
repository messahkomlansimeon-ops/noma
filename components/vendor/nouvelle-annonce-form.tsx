"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TopBar } from "@/components/top-bar";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { FieldLabel, Input, Segmented, Switch, Textarea } from "@/components/ui";
import { api, describeApiError, type OfferRecord } from "@/lib/client/api";
import {
  CATEGORY_OPTIONS,
  CONDITION_OPTIONS,
  FIELD_LIMITS,
  buildOfferInput,
} from "@/lib/client/catalog-view";
import { useNoma } from "@/lib/store";

type Submitting = "publish" | "draft" | null;

function FieldError({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
      {message}
    </div>
  ) : null;
}

/**
 * Création réelle d'une annonce : POST /api/offers (brouillon), puis, sur demande, POST /api/offers/{id}/publish
 * avec la version de contenu renvoyée par le serveur. `onSaved` reçoit l'annonce dans son état final.
 */
export function NouvelleAnnonceForm({
  embedded,
  onDone,
  onSaved,
}: {
  embedded?: boolean;
  onDone?: () => void;
  onSaved?: (offer: OfferRecord) => void;
}) {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [condition, setCondition] = useState<string | null>("Occasion");
  const [location, setLocation] = useState("");
  const [price, setPrice] = useState("");
  const [available, setAvailable] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Submitting>(null);

  const finish = () => {
    if (embedded) onDone?.();
    else router.push("/vendeur/annonces");
  };

  const submit = async (mode: "publish" | "draft") => {
    if (submitting) return;
    const built = buildOfferInput({
      title,
      description,
      category,
      brand,
      model,
      variant,
      condition,
      location,
      price,
      available,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSubmitting(mode);

    let created: OfferRecord;
    try {
      created = await api.offers.create(built.input);
    } catch (failure) {
      setSubmitting(null);
      if (redirectIfUnauthorized(failure)) return;
      showToast(describeApiError(failure, "catalog"));
      return;
    }

    if (mode === "draft") {
      onSaved?.(created);
      showToast("Brouillon enregistré");
      setSubmitting(null);
      finish();
      return;
    }

    let redirected = false;
    try {
      const published = await api.offers.publish(created.id, created.contentVersion);
      onSaved?.(published);
      showToast("Annonce publiée");
    } catch (failure) {
      // L'annonce existe en brouillon : elle reste visible dans « Mes annonces » et peut être publiée de là.
      onSaved?.(created);
      redirected = redirectIfUnauthorized(failure);
      if (!redirected) {
        showToast(`Brouillon enregistré, publication impossible. ${describeApiError(failure, "catalog")}`);
      }
    } finally {
      setSubmitting(null);
    }
    if (!redirected) finish();
  };

  return (
    <>
      {!embedded && (
        <TopBar
          back="/vendeur/annonces"
          right={
            <span className="pr-2 text-[12px] font-semibold text-ink-soft">
              Brouillon
            </span>
          }
        />
      )}

      <div className={embedded ? "" : "px-4"}>
        {!embedded && (
          <h1 className="font-display text-[26px] font-extrabold text-ink">
            Nouvelle annonce
          </h1>
        )}

        <div className="mt-5 space-y-4">
          <div>
            <FieldLabel>Titre</FieldLabel>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={FIELD_LIMITS.title}
              placeholder="iPhone 12 · 128 Go"
              aria-invalid={errors.title ? true : undefined}
            />
            <FieldError message={errors.title} />
          </div>

          <div>
            <FieldLabel>Description (facultatif)</FieldLabel>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={FIELD_LIMITS.description}
              rows={3}
              placeholder="État, accessoires, garantie…"
            />
            <FieldError message={errors.description} />
          </div>

          <div>
            <FieldLabel>Catégorie</FieldLabel>
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
            <FieldLabel>Prix</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                inputMode="numeric"
                placeholder="150 000"
                aria-invalid={errors.price ? true : undefined}
              />
              <span className="rounded-xl bg-wash px-3 py-3 text-[13px] font-bold text-ink-soft">
                FCFA
              </span>
            </div>
            <FieldError message={errors.price} />
          </div>

          <div>
            <FieldLabel>État</FieldLabel>
            <Segmented
              options={[...CONDITION_OPTIONS]}
              value={condition ?? ""}
              onChange={(value) => setCondition(value === condition ? null : value)}
              tone="carrot"
            />
          </div>

          <div>
            <FieldLabel>Localisation (facultatif)</FieldLabel>
            <Input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              maxLength={FIELD_LIMITS.location}
              placeholder="Marcory, Abidjan"
            />
          </div>

          <div className="flex items-center justify-between rounded-xl border border-line bg-white px-3.5 py-3">
            <span className="text-[14px] font-semibold text-ink">Disponible</span>
            <Switch checked={available} onChange={setAvailable} />
          </div>
        </div>

        <button
          onClick={() => void submit("publish")}
          disabled={submitting !== null}
          className="mt-5 w-full rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting === "publish" ? "Publication…" : "Publier l'annonce"}
        </button>
        <button
          onClick={() => void submit("draft")}
          disabled={submitting !== null}
          className="mt-2.5 w-full rounded-xl border border-forest/30 bg-white py-3.5 text-[15px] font-bold text-forest transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting === "draft" ? "Enregistrement…" : "Enregistrer en brouillon"}
        </button>
        <div className="py-4 text-center text-[12px] text-ink-soft">
          Un brouillon n'est visible de personne tant que vous ne le publiez pas.
        </div>
      </div>
    </>
  );
}
