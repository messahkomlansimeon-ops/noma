"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CircleAlert, Hash, Layers, MapPin, Package, Rocket, Save, ShieldCheck, Wallet, type LucideIcon } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Card, IconTile, Input } from "@/components/ui";
import { describeMissionError, missions } from "@/lib/client/missions-api";
import { EMPTY_MISSION_FORM, NO_PAYMENT_NOTICE, missionPath, parseMissionForm, type MissionFormValues } from "@/lib/client/missions-view";
import { MISSION_CONDITIONS, MISSION_DEADLINE_DAYS_MAX, MISSION_QUANTITY_MAX, MISSION_QUANTITY_MIN, type MissionField } from "@/lib/missions-rules";

const FIELD_CLASS = "min-h-12 w-full rounded-2xl border-2 border-line bg-white px-4 py-3 text-[16px] text-ink transition-colors hover:border-line-strong";

/** Un bloc du formulaire : une pastille d'icône et un titre court. */
function FormCard({ icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <Card className="animate-rise">
      <h2 className="flex items-center gap-3 text-[17px] font-extrabold text-ink">
        <IconTile icon={icon} className="size-10" />
        {title}
      </h2>
      {children}
    </Card>
  );
}

/**
 * Formulaire d'une mission (création ou modification d'un brouillon), en mots simples. Chaque champ est contrôlé par la MÊME règle que le serveur ; le texte libre ne porte
 * jamais de numéro de téléphone. « Lancer la mission » crée la mission et la lance ; « Enregistrer en brouillon » la garde pour plus tard. Rien n'est envoyé aux vendeurs.
 */
export function MissionForm({ mode, missionId, initial }: { mode: "create" | "edit"; missionId?: string; initial?: MissionFormValues }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [values, setValues] = useState<MissionFormValues>(initial ?? EMPTY_MISSION_FORM);
  const [problems, setProblems] = useState<Partial<Record<MissionField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const set = (key: keyof MissionFormValues) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (activate: boolean) => {
    if (busy.current) return;
    const parsed = parseMissionForm(values);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      setError(null);
      return;
    }
    setProblems({});
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      let id: string;
      if (mode === "edit" && missionId) {
        const updated = await missions.update(missionId, parsed.input);
        id = updated.id;
        if (activate) await missions.act(id, "activate");
      } else {
        id = (await missions.create(parsed.input, activate)).id;
      }
      router.push(missionPath(id));
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeMissionError(failure, "form"));
      setPending(false);
    } finally {
      busy.current = false;
    }
  };

  const field = (key: MissionField, formKey: keyof MissionFormValues, label: string, options: { placeholder?: string; numeric?: boolean; hint?: string } = {}) => (
    <div className="mt-3">
      <label htmlFor={`mission-${key}`} className="mb-1.5 block text-[14px] font-bold text-ink">
        {label}
      </label>
      <Input
        id={`mission-${key}`}
        data-testid={`mission-field-${key}`}
        inputMode={options.numeric ? "numeric" : undefined}
        autoComplete="off"
        value={values[formKey]}
        onChange={set(formKey)}
        placeholder={options.placeholder}
        aria-invalid={problems[key] ? true : undefined}
      />
      {options.hint ? <p className="mt-1 text-[12px] text-ink-soft">{options.hint}</p> : null}
      {problems[key] ? (
        <p role="alert" data-testid={`mission-problem-${key}`} className="mt-1.5 flex items-center gap-2 text-[14px] font-semibold text-danger-ink">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {problems[key]}
        </p>
      ) : null}
    </div>
  );

  return (
    <main>
      {/* Lot FIN1 : titre dit une fois (le h1). */}
      <TopBar back={mode === "edit" && missionId ? missionPath(missionId) : "/missions"} />
      <form
        className="flex flex-col gap-4 px-4 pb-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
      >
        <div>
          <h1 className="flex items-center gap-2.5 text-[24px] font-extrabold tracking-tight text-ink">
            <Layers className="size-6 text-brand" aria-hidden />
            {mode === "edit" ? "Modifier la mission" : "Nouvelle mission"}
          </h1>
          <p className="mt-2 flex items-start gap-2 text-[14px] text-ink-soft">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            Les vendeurs ne voient jamais votre budget ni le nombre total voulu.
          </p>
        </div>

        <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
          <FormCard icon={Package} title="Que voulez-vous acheter ?">
            {field("category", "category", "Catégorie", { placeholder: "Ex. Téléphones" })}
            {field("brand", "brand", "Marque", { placeholder: "Ex. Apple" })}
            {field("model", "model", "Modèle", { placeholder: "Ex. iPhone 12" })}
            {field("variant", "variant", "Variante (facultatif)", { placeholder: "Ex. 128 Go" })}
            <div className="mt-3">
              <label htmlFor="mission-condition" className="mb-1.5 block text-[14px] font-bold text-ink">
                État voulu
              </label>
              <select id="mission-condition" data-testid="mission-field-condition" value={values.condition} onChange={set("condition")} className={FIELD_CLASS}>
                {MISSION_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {condition}
                  </option>
                ))}
                {MISSION_CONDITIONS.includes(values.condition) ? null : <option value={values.condition}>{values.condition}</option>}
              </select>
              {problems.condition ? (
                <p role="alert" className="mt-1.5 flex items-center gap-2 text-[14px] font-semibold text-danger-ink">
                  <CircleAlert className="size-4 shrink-0" aria-hidden />
                  {problems.condition}
                </p>
              ) : null}
            </div>
          </FormCard>

          <div className="flex flex-col gap-4">
            <FormCard icon={Hash} title="Combien ?">
              {field("quantity", "quantity", "Quantité totale", { numeric: true, placeholder: "Ex. 20", hint: `De ${MISSION_QUANTITY_MIN} à ${MISSION_QUANTITY_MAX.toLocaleString("fr-FR")}.` })}
              {field("unit", "unit", "Unité", { placeholder: "pièce" })}
            </FormCard>

            <FormCard icon={Wallet} title="Quel budget ?">
              {field("unitBudgetXof", "unitBudget", "Budget par unité, au plus (FCFA)", { numeric: true, placeholder: "Ex. 170 000" })}
              {field("totalBudgetXof", "totalBudget", "Budget total, au plus (FCFA)", { numeric: true, placeholder: "Ex. 3 200 000", hint: "Au moins égal au budget par unité." })}
            </FormCard>

            <FormCard icon={MapPin} title="Où et jusqu'à quand ?">
              {field("location", "location", "Lieu (facultatif)", { placeholder: "Ex. Abidjan" })}
              {field("deadlineDays", "deadlineDays", "Durée de la mission (jours)", { numeric: true, hint: `De 1 à ${MISSION_DEADLINE_DAYS_MAX} jours.` })}
            </FormCard>
          </div>
        </div>

        <p data-testid="no-payment-notice" className="flex items-start gap-2.5 rounded-2xl bg-mist p-3.5 text-[13px] leading-relaxed text-ink-soft">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          {NO_PAYMENT_NOTICE}
        </p>
        {error ? (
          <p role="alert" data-testid="mission-form-error" className="flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[15px] font-semibold text-danger-ink">
            <CircleAlert className="size-5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="submit"
            disabled={pending}
            data-testid="mission-submit"
            className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Rocket className="size-5" aria-hidden />
            {pending ? "Envoi…" : "Lancer la mission"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit(false)}
            data-testid="mission-save-draft"
            className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="size-5" aria-hidden />
            Enregistrer en brouillon
          </button>
        </div>
      </form>
    </main>
  );
}
