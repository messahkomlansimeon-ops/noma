"use client";

import { useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { describeProposalError, proposals, type Proposal } from "@/lib/client/proposals-api";
import { DAILY_LIMIT_TEXT, FORM_NO_PHONE_NOTE, LINES_TITLE, QUOTE_NOTE, QUOTE_TOTAL_LABEL, buildProposal, emptyForm, linesTotal, type ProposalFormState } from "@/lib/client/proposals-view";
import { formatFcfa } from "@/lib/client/wallet-view";
import { PROPOSAL_LINES_MAX, PROPOSAL_LABEL_MAX, PROPOSAL_NOTE_MAX, PROPOSAL_SLOT_MAX, PROPOSAL_VALID_DAYS_MAX, PROPOSAL_VALID_DAYS_MIN, PROPOSAL_WARRANTY_MAX } from "@/lib/proposals-rules";

const FIELD = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink";

/**
 * Formulaire d'une proposition (sans ligne : un prix) ou d'un devis (avec des lignes : le prix est leur somme). Le contenu est contrôlé par la MÊME règle que le serveur (`buildProposal`
 * → `checkProposalInput`) : un contenu refusé ne part pas. Aucun numéro de téléphone.
 */
export function ProposalForm({ demandId, offerId, withLines, onSent }: { demandId: string; offerId: string; withLines: boolean; onSent: (proposal: Proposal) => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [form, setForm] = useState<ProposalFormState>(() => emptyForm(offerId, withLines));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const total = linesTotal(form.lines);
  const set = (patch: Partial<ProposalFormState>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async () => {
    if (busy.current) return;
    const checked = buildProposal(form);
    if (!checked.ok) {
      setError(checked.reason === "phone" ? "Pas de numéro de téléphone dans la proposition : l'acheteur vous répondra dans la messagerie de noma." : "Vérifiez les champs : le prix et les textes ne sont pas valides.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      onSent(await proposals.propose(demandId, checked.value));
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeProposalError(failure, "send"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <form
      data-testid={withLines ? "quote-form" : "proposal-form"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mt-3"
    >
      {withLines ? (
        <fieldset>
          <legend className="text-[15px] font-extrabold text-ink">{LINES_TITLE}</legend>
          <ul className="mt-2 space-y-2">
            {form.lines.map((line, index) => (
              <li key={index} data-testid="quote-line" className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
                <input
                  aria-label={`Libellé de la ligne ${index + 1}`}
                  value={line.label}
                  maxLength={PROPOSAL_LABEL_MAX}
                  onChange={(event) => set({ lines: form.lines.map((entry, i) => (i === index ? { ...entry, label: event.target.value } : entry)) })}
                  className="rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink"
                />
                <input
                  aria-label={`Montant de la ligne ${index + 1} en FCFA`}
                  inputMode="numeric"
                  value={line.amount}
                  onChange={(event) => set({ lines: form.lines.map((entry, i) => (i === index ? { ...entry, amount: event.target.value } : entry)) })}
                  className="rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink"
                />
                <button
                  type="button"
                  onClick={() => set({ lines: form.lines.filter((_, i) => i !== index) })}
                  disabled={form.lines.length <= 1}
                  aria-label={`Retirer la ligne ${index + 1}`}
                  className="rounded-lg border border-line px-2.5 py-2 text-[14px] font-bold text-ink disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => set({ lines: [...form.lines, { label: "", amount: "" }] })}
            disabled={form.lines.length >= PROPOSAL_LINES_MAX}
            data-testid="quote-add-line"
            className="mt-2 rounded-xl border border-brand/30 bg-white px-3.5 py-2 text-[14px] font-bold text-brand disabled:opacity-40"
          >
            Ajouter une ligne
          </button>
          <p data-testid="quote-total" className="mt-2 text-[15px] font-extrabold text-ink">
            {QUOTE_TOTAL_LABEL} : {formatFcfa(total)}
          </p>
          <p className="text-[13px] text-ink-soft">{QUOTE_NOTE}</p>
        </fieldset>
      ) : (
        <div>
          <label htmlFor="proposal-price" className="block text-[15px] font-extrabold text-ink">
            Prix proposé (FCFA)
          </label>
          <input id="proposal-price" inputMode="numeric" value={form.price} onChange={(event) => set({ price: event.target.value })} className={FIELD} />
        </div>
      )}
      <label htmlFor="proposal-slot" className="mt-3 block text-[15px] font-extrabold text-ink">
        Créneau (facultatif)
      </label>
      <input id="proposal-slot" value={form.slot} maxLength={PROPOSAL_SLOT_MAX} onChange={(event) => set({ slot: event.target.value })} className={FIELD} />
      <label htmlFor="proposal-warranty" className="mt-3 block text-[15px] font-extrabold text-ink">
        Garantie (facultatif)
      </label>
      <input id="proposal-warranty" value={form.warranty} maxLength={PROPOSAL_WARRANTY_MAX} onChange={(event) => set({ warranty: event.target.value })} className={FIELD} />
      <label htmlFor="proposal-note" className="mt-3 block text-[15px] font-extrabold text-ink">
        Message (facultatif)
      </label>
      <textarea id="proposal-note" rows={3} value={form.note} maxLength={PROPOSAL_NOTE_MAX} onChange={(event) => set({ note: event.target.value })} className={FIELD} />
      <label htmlFor="proposal-days" className="mt-3 block text-[15px] font-extrabold text-ink">
        Valable pendant (jours, {PROPOSAL_VALID_DAYS_MIN} à {PROPOSAL_VALID_DAYS_MAX})
      </label>
      <input id="proposal-days" inputMode="numeric" value={form.validDays} onChange={(event) => set({ validDays: event.target.value })} className={FIELD} />
      <p className="mt-2 text-[13px] text-ink-soft">
        {FORM_NO_PHONE_NOTE} {DAILY_LIMIT_TEXT}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} data-testid="proposal-submit" className="mt-4 flex w-full items-center justify-center rounded-xl bg-brand py-3 text-[15px] font-bold text-white disabled:opacity-50">
        {pending ? "Envoi…" : withLines ? "Envoyer le devis" : "Envoyer la proposition"}
      </button>
    </form>
  );
}
