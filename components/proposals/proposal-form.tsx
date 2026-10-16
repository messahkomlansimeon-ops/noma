"use client";

import { useRef, useState } from "react";
import { Banknote, Calculator, CalendarClock, Hourglass, Loader2, MessageSquareText, Plus, Send, ShieldCheck, ShieldPlus, X } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Input, Textarea } from "@/components/ui";
import { BTN_PRIMARY, BTN_SMALL, Notice } from "@/components/vendor/vendor-parts";
import { describeProposalError, proposals, type Proposal } from "@/lib/client/proposals-api";
import { DAILY_LIMIT_TEXT, FORM_NO_PHONE_NOTE, LINES_TITLE, QUOTE_NOTE, QUOTE_TOTAL_LABEL, buildProposal, emptyForm, linesTotal, type ProposalFormState } from "@/lib/client/proposals-view";
import { formatFcfa } from "@/lib/client/wallet-view";
import { PROPOSAL_LINES_MAX, PROPOSAL_LABEL_MAX, PROPOSAL_NOTE_MAX, PROPOSAL_SLOT_MAX, PROPOSAL_VALID_DAYS_MAX, PROPOSAL_VALID_DAYS_MIN, PROPOSAL_WARRANTY_MAX } from "@/lib/proposals-rules";

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
      className="mt-3 flex flex-col gap-4"
    >
      {withLines ? (
        <fieldset className="rounded-3xl border border-line bg-white p-4">
          <legend className="flex items-center gap-2 px-1 text-[16px] font-extrabold text-ink">
            <Calculator className="size-5 text-brand" aria-hidden />
            {LINES_TITLE}
          </legend>
          <ul className="space-y-2">
            {form.lines.map((line, index) => (
              <li key={index} data-testid="quote-line" className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
                <Input
                  aria-label={`Libellé de la ligne ${index + 1}`}
                  value={line.label}
                  maxLength={PROPOSAL_LABEL_MAX}
                  onChange={(event) => set({ lines: form.lines.map((entry, i) => (i === index ? { ...entry, label: event.target.value } : entry)) })}
                />
                <Input
                  aria-label={`Montant de la ligne ${index + 1} en FCFA`}
                  inputMode="numeric"
                  value={line.amount}
                  onChange={(event) => set({ lines: form.lines.map((entry, i) => (i === index ? { ...entry, amount: event.target.value } : entry)) })}
                />
                <button
                  type="button"
                  onClick={() => set({ lines: form.lines.filter((_, i) => i !== index) })}
                  disabled={form.lines.length <= 1}
                  aria-label={`Retirer la ligne ${index + 1}`}
                  className="press flex size-11 items-center justify-center rounded-xl text-ink-soft hover:bg-mist disabled:opacity-40"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => set({ lines: [...form.lines, { label: "", amount: "" }] })}
            disabled={form.lines.length >= PROPOSAL_LINES_MAX}
            data-testid="quote-add-line"
            className={`${BTN_SMALL} mt-3`}
          >
            <Plus className="size-4" aria-hidden />
            Ajouter une ligne
          </button>
          <p data-testid="quote-total" className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-brand-soft px-4 py-3 text-[16px] font-extrabold text-brand-ink">
            <span>{QUOTE_TOTAL_LABEL} :</span>
            <span className="text-[20px]">{formatFcfa(total)}</span>
          </p>
          <p className="mt-2 text-[13px] text-ink-soft">{QUOTE_NOTE}</p>
        </fieldset>
      ) : (
        <div>
          <label htmlFor="proposal-price" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
            <Banknote className="size-4 shrink-0 text-brand" aria-hidden />
            Prix proposé (FCFA)
          </label>
          <Input id="proposal-price" inputMode="numeric" value={form.price} onChange={(event) => set({ price: event.target.value })} />
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="proposal-slot" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
            <CalendarClock className="size-4 shrink-0 text-brand" aria-hidden />
            Créneau (facultatif)
          </label>
          <Input id="proposal-slot" value={form.slot} maxLength={PROPOSAL_SLOT_MAX} onChange={(event) => set({ slot: event.target.value })} />
        </div>
        <div>
          <label htmlFor="proposal-warranty" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
            <ShieldPlus className="size-4 shrink-0 text-brand" aria-hidden />
            Garantie (facultatif)
          </label>
          <Input id="proposal-warranty" value={form.warranty} maxLength={PROPOSAL_WARRANTY_MAX} onChange={(event) => set({ warranty: event.target.value })} />
        </div>
      </div>
      <div>
        <label htmlFor="proposal-note" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
          <MessageSquareText className="size-4 shrink-0 text-brand" aria-hidden />
          Message (facultatif)
        </label>
        <Textarea id="proposal-note" rows={3} value={form.note} maxLength={PROPOSAL_NOTE_MAX} onChange={(event) => set({ note: event.target.value })} />
      </div>
      <div>
        <label htmlFor="proposal-days" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
          <Hourglass className="size-4 shrink-0 text-brand" aria-hidden />
          Valable pendant (jours, {PROPOSAL_VALID_DAYS_MIN} à {PROPOSAL_VALID_DAYS_MAX})
        </label>
        <Input id="proposal-days" inputMode="numeric" value={form.validDays} onChange={(event) => set({ validDays: event.target.value })} />
      </div>
      <Notice tone="info" icon={ShieldCheck} small>
        {FORM_NO_PHONE_NOTE} {DAILY_LIMIT_TEXT}
      </Notice>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <button type="submit" disabled={pending} data-testid="proposal-submit" className={BTN_PRIMARY}>
        {pending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Send className="size-5" aria-hidden />}
        {pending ? "Envoi…" : withLines ? "Envoyer le devis" : "Envoyer la proposition"}
      </button>
    </form>
  );
}
