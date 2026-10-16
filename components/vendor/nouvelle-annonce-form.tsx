"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlignLeft, Banknote, CircleAlert, CircleCheck, Layers, LayoutGrid, Loader2, MapPin, Package, Save, Send, Smartphone, Sparkles, Tag } from "lucide-react";
import { PhotoPicker } from "@/components/photos/photo-picker";
import { MarketHint } from "@/components/market/market-hint";
import { TopBar } from "@/components/top-bar";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Btn, IconTile, Input, Segmented, Switch, Textarea } from "@/components/ui";
import { BTN_OUTLINE, IconLabel } from "@/components/vendor/vendor-parts";
import { ApiError, api, describeApiError, type OfferRecord } from "@/lib/client/api";
import {
  CATEGORY_OPTIONS,
  CONDITION_OPTIONS,
  FIELD_LIMITS,
  buildOfferInput,
} from "@/lib/client/catalog-view";
import { photosApi } from "@/lib/client/photos-api";
import { uploadPicked, type PickedPhoto } from "@/lib/client/photos-queue";
import { useNoma } from "@/lib/store";

type Submitting = "publish" | "draft" | null;

function FieldError({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-danger-ink">
      <CircleAlert className="size-4 shrink-0" aria-hidden />
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
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);

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

    // Lot PH1 : les photos choisies partent une à une maintenant que l'annonce existe (une photo refusée n'arrête pas les autres ni ne perd l'annonce).
    if (photos.length > 0) {
      const summary = await uploadPicked(created.id, photos, photosApi, setPhotos);
      if (summary.unauthorized) {
        setSubmitting(null);
        redirectIfUnauthorized(new ApiError(401, "authentication_required", "Authentification requise."));
        return;
      }
      if (summary.failed > 0) {
        // Sans toutes ses photos, l'annonce reste en brouillon : elles se rajoutent depuis la page de l'annonce, qui se publie ensuite.
        onSaved?.(created);
        showToast("Brouillon enregistré, mais des photos n'ont pas pu être envoyées. Ajoutez-les depuis la page de l'annonce, puis publiez.");
        setSubmitting(null);
        if (embedded) onDone?.();
        else router.push(`/vendeur/annonces/${created.id}`);
        return;
      }
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

  const group = embedded ? "space-y-4" : "space-y-4 rounded-3xl border border-line bg-white p-4";
  return (
    <>
      {!embedded && <TopBar back="/vendeur/annonces" />}

      <div className={embedded ? "" : "px-4 pb-6"}>
        {!embedded && (
          <h1 className="flex items-center gap-3 text-[26px] font-extrabold tracking-tight text-ink">
            <IconTile icon={Package} tone="brand" />
            Nouvelle annonce
          </h1>
        )}

        <div className={`mt-5 flex flex-col gap-4 ${embedded ? "" : "md:grid md:grid-cols-2 md:items-start"}`}>
          <div className={group}>
            <div>
              <IconLabel icon={Tag}>Titre</IconLabel>
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
              <IconLabel icon={AlignLeft}>Description (facultatif)</IconLabel>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={FIELD_LIMITS.description}
                rows={3}
                placeholder="État, accessoires, garantie…"
              />
              <FieldError message={errors.description} />
            </div>
          </div>

          <div className={group}>
            <div>
              <IconLabel icon={LayoutGrid}>Catégorie</IconLabel>
              <Segmented
                options={CATEGORY_OPTIONS.map((option) => option.label)}
                value={category ?? ""}
                onChange={(value) => setCategory(value === category ? null : value)}
                size="sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <IconLabel icon={Smartphone}>Marque</IconLabel>
                <Input
                  value={brand}
                  onChange={(event) => setBrand(event.target.value)}
                  maxLength={FIELD_LIMITS.short}
                  placeholder="Apple"
                />
              </div>
              <div>
                <IconLabel icon={Smartphone}>Modèle</IconLabel>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  maxLength={FIELD_LIMITS.short}
                  placeholder="iPhone 12"
                />
              </div>
            </div>

            <div>
              <IconLabel icon={Layers}>Variante (facultatif)</IconLabel>
              <Input
                value={variant}
                onChange={(event) => setVariant(event.target.value)}
                maxLength={FIELD_LIMITS.short}
                placeholder="128 Go"
              />
            </div>
          </div>

          <div className={group}>
            <div>
              <IconLabel icon={Banknote}>Prix</IconLabel>
              <div className="flex items-center gap-2">
                <Input
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  inputMode="numeric"
                  placeholder="150 000"
                  aria-invalid={errors.price ? true : undefined}
                />
                <span className="flex min-h-12 items-center rounded-2xl bg-mist px-4 text-[14px] font-bold text-ink-soft">
                  FCFA
                </span>
              </div>
              <FieldError message={errors.price} />
              <MarketHint category={category} brand={brand} model={model} variant={variant} condition={condition} />
            </div>

            <div>
              <IconLabel icon={Sparkles}>État</IconLabel>
              <Segmented
                options={[...CONDITION_OPTIONS]}
                value={condition ?? ""}
                onChange={(value) => setCondition(value === condition ? null : value)}
                tone="carrot"
              />
            </div>
          </div>

          <div className={group}>
            <div>
              <IconLabel icon={MapPin}>Localisation (facultatif)</IconLabel>
              <Input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={FIELD_LIMITS.location}
                placeholder="Marcory, Abidjan"
              />
            </div>

            <div className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-mist px-4 py-2">
              <span className="flex items-center gap-2 text-[15px] font-bold text-ink">
                <CircleCheck className="size-5 text-success" aria-hidden />
                Disponible
              </span>
              <Switch checked={available} onChange={setAvailable} label="Disponible" />
            </div>
          </div>

          <div className={`${group} ${embedded ? "" : "md:col-span-2"}`}>
            <PhotoPicker items={photos} onChange={setPhotos} disabled={submitting !== null} />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2.5 md:flex-row-reverse md:[&>*]:flex-1">
          <Btn onClick={() => void submit("publish")} disabled={submitting !== null}>
            {submitting === "publish" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Send className="size-5" aria-hidden />}
            {submitting === "publish" ? "Publication…" : "Publier l'annonce"}
          </Btn>
          <button onClick={() => void submit("draft")} disabled={submitting !== null} className={BTN_OUTLINE}>
            {submitting === "draft" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Save className="size-5" aria-hidden />}
            {submitting === "draft" ? "Enregistrement…" : "Enregistrer en brouillon"}
          </button>
        </div>
        <p className="mt-3 text-center text-[13px] text-ink-soft">Un brouillon n'est visible de personne tant que vous ne le publiez pas.</p>
      </div>
    </>
  );
}
