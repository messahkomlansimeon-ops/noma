"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Input } from "@/components/ui";
import { describeMissionError, missions } from "@/lib/client/missions-api";
import { EMPTY_MISSION_FORM, NO_PAYMENT_NOTICE, missionPath, parseMissionForm, type MissionFormValues } from "@/lib/client/missions-view";
import { MISSION_CONDITIONS, MISSION_DEADLINE_DAYS_MAX, MISSION_QUANTITY_MAX, MISSION_QUANTITY_MIN, type MissionField } from "@/lib/missions-rules";

const FIELD_CLASS = "w-full rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] text-ink";

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
      <label htmlFor={`mission-${key}`} className="mb-1.5 block text-[13px] font-bold text-ink">
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
      {options.hint ? <p className="mt-1 text-[11px] text-ink-soft">{options.hint}</p> : null}
      {problems[key] ? (
        <p role="alert" data-testid={`mission-problem-${key}`} className="mt-1 text-[12px] font-semibold text-carrot-ink">
          {problems[key]}
        </p>
      ) : null}
    </div>
  );

  return (
    <main>
      <TopBar back={mode === "edit" && missionId ? missionPath(missionId) : "/missions"} title={mode === "edit" ? "Modifier la mission" : "Nouvelle mission"} />
      <form
        className="px-4 pb-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
      >
        <h1 className="font-display text-[22px] font-extrabold text-ink">{mode === "edit" ? "Modifier la mission" : "Nouvelle mission"}</h1>
        <p className="mt-1 text-[13px] text-ink-soft">
          Achetez plusieurs exemplaires du même objet, chez plusieurs vendeurs. Les vendeurs ne voient jamais votre budget ni le nombre total voulu.
        </p>

        <h2 className="mt-5 text-[15px] font-extrabold text-ink">Que voulez-vous acheter ?</h2>
        {field("category", "category", "Catégorie", { placeholder: "Ex. Téléphones" })}
        {field("brand", "brand", "Marque", { placeholder: "Ex. Apple" })}
        {field("model", "model", "Modèle", { placeholder: "Ex. iPhone 12" })}
        {field("variant", "variant", "Variante (facultatif)", { placeholder: "Ex. 128 Go" })}
        <div className="mt-3">
          <label htmlFor="mission-condition" className="mb-1.5 block text-[13px] font-bold text-ink">
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
            <p role="alert" className="mt-1 text-[12px] font-semibold text-carrot-ink">
              {problems.condition}
            </p>
          ) : null}
        </div>

        <h2 className="mt-5 text-[15px] font-extrabold text-ink">Combien ?</h2>
        {field("quantity", "quantity", "Quantité totale", { numeric: true, placeholder: "Ex. 20", hint: `De ${MISSION_QUANTITY_MIN} à ${MISSION_QUANTITY_MAX.toLocaleString("fr-FR")}.` })}
        {field("unit", "unit", "Unité", { placeholder: "pièce" })}

        <h2 className="mt-5 text-[15px] font-extrabold text-ink">Quel budget ?</h2>
        {field("unitBudgetXof", "unitBudget", "Budget par unité, au plus (FCFA)", { numeric: true, placeholder: "Ex. 170 000" })}
        {field("totalBudgetXof", "totalBudget", "Budget total, au plus (FCFA)", { numeric: true, placeholder: "Ex. 3 200 000", hint: "Au moins égal au budget par unité." })}

        <h2 className="mt-5 text-[15px] font-extrabold text-ink">Où et jusqu'à quand ?</h2>
        {field("location", "location", "Lieu (facultatif)", { placeholder: "Ex. Abidjan" })}
        {field("deadlineDays", "deadlineDays", "Durée de la mission (jours)", { numeric: true, hint: `De 1 à ${MISSION_DEADLINE_DAYS_MAX} jours.` })}

        <p data-testid="no-payment-notice" className="mt-5 text-[12px] leading-relaxed text-ink-soft">
          {NO_PAYMENT_NOTICE}
        </p>
        {error ? (
          <p role="alert" data-testid="mission-form-error" className="mt-3 text-[13px] font-semibold text-carrot-ink">
            {error}
          </p>
        ) : null}
        <div className="mt-4 grid gap-2.5">
          <button type="submit" disabled={pending} data-testid="mission-submit" className="rounded-xl bg-forest px-4 py-3 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50">
            {pending ? "Envoi…" : "Lancer la mission"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit(false)}
            data-testid="mission-save-draft"
            className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50"
          >
            Enregistrer en brouillon
          </button>
        </div>
      </form>
    </main>
  );
}
