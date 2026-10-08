"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Badge } from "@/components/ui";
import { describeMissionError, shortfallText, type MissionProposal, type MissionSummary, type ProposalEngaged, type ProposalLine } from "@/lib/client/missions-api";
import {
  DECLARE_CONFIRM_LABEL,
  DECLARE_LABEL,
  ENGAGED_NOTE,
  ENGAGED_TITLE,
  LINES_TITLE,
  NO_PAYMENT_NOTICE,
  PROPOSAL_ALL_ENGAGED,
  PROPOSAL_EMPTY,
  PROPOSAL_INACTIVE,
  PROPOSAL_NOTE,
  PROPOSAL_TITLE,
  PROPOSAL_UNAVAILABLE,
  SEE_LISTING_LABEL,
  WRITE_LABEL,
  engagedLineView,
  lineConversationPath,
  parseWholeNumber,
  proposalLineView,
  proposalSummary,
} from "@/lib/client/missions-view";
import { orderPath, parsePriceInput } from "@/lib/client/orders-view";
import { describeSocialError, social } from "@/lib/client/social-api";
import { formatFcfa } from "@/lib/client/wallet-view";
import { ORDER_QUANTITY_MAX, ORDER_QUANTITY_MIN } from "@/lib/missions-rules";
import { ProgressBar } from "@/components/missions/missions-list";

function LineCard({ line, mission, onChanged }: { line: ProposalLine; mission: MissionSummary; onChanged: () => void }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const view = proposalLineView(line, mission.status === "active");
  const [declaring, setDeclaring] = useState(false);
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [price, setPrice] = useState(String(line.unitPriceXof));
  const [pending, setPending] = useState<"write" | "declare" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const parsedQuantity = parseWholeNumber(quantity);
  const parsedPrice = parsePriceInput(price);
  const remaining = Math.max(0, mission.quantity - mission.securedQuantity - mission.pendingQuantity);
  // Les limites de la mission sont connues de l'écran : un achat qui les dépasse n'est pas envoyé (le serveur les contrôle de toute façon).
  const overPrice = parsedPrice !== null && parsedPrice > mission.unitBudgetXof;
  const overQuantity = parsedQuantity !== null && parsedQuantity > remaining;
  const valid = parsedQuantity !== null && parsedQuantity >= ORDER_QUANTITY_MIN && parsedQuantity <= ORDER_QUANTITY_MAX && parsedPrice !== null && !overPrice && !overQuantity;
  const demandId = mission.demandId;

  // « Écrire » ouvre (ou retrouve) la conversation puis y va : le message est pré-rempli et MODIFIABLE, il ne part que si l'acheteur l'envoie.
  const write = async () => {
    if (busy.current || demandId === null) return;
    busy.current = true;
    setPending("write");
    setError(null);
    try {
      const opened = await social.conversations.open(demandId, line.offerId);
      router.push(lineConversationPath(opened.conversationId, line));
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeMissionError(failure, "line"));
      setPending(null);
    } finally {
      busy.current = false;
    }
  };

  const declare = async () => {
    if (busy.current || demandId === null || !valid) return;
    busy.current = true;
    setPending("declare");
    setError(null);
    try {
      await social.orders.declare(demandId, line.offerId, parsedPrice as number, undefined, parsedQuantity as number);
      setDeclaring(false);
      setPending(null);
      onChanged();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeSocialError(failure, "order"));
      setPending(null);
    } finally {
      busy.current = false;
    }
  };

  return (
    <li data-testid="proposal-line" data-offer={line.offerId} className="rounded-2xl border border-line bg-white p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div data-testid="line-vendor" className="text-[12px] font-bold uppercase tracking-wide text-ink-soft">
            {view.vendor}
          </div>
          <div className="text-[15px] font-bold text-ink">{view.title}</div>
          {view.location ? (
            <div className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-soft">
              <MapPin className="size-3" aria-hidden />
              {view.location}
            </div>
          ) : null}
          <div className="mt-0.5 text-[11px] text-ink-soft">{view.stockText}</div>
        </div>
        <div className="shrink-0 text-right">
          <div data-testid="line-calcul" className="text-[13px] text-ink-soft">
            {view.calculText}
          </div>
          <div data-testid="line-subtotal" className="font-display text-[17px] font-extrabold text-ink">
            {view.subtotalText}
          </div>
        </div>
      </div>

      {demandId !== null ? (
        <Link href={`/besoins/${demandId}/offres/${line.offerId}`} className="mt-2 inline-block text-[12px] font-bold text-forest">
          {SEE_LISTING_LABEL} ›
        </Link>
      ) : null}

      {view.canAct ? (
        <div className="mt-3">
          {!declaring ? (
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => void write()}
                disabled={pending !== null}
                data-testid="line-write"
                className="rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50"
              >
                {pending === "write" ? "Ouverture…" : WRITE_LABEL}
              </button>
              <button
                onClick={() => {
                  setDeclaring(true);
                  setError(null);
                }}
                disabled={pending !== null}
                data-testid="line-declare"
                className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white disabled:opacity-50"
              >
                {DECLARE_LABEL}
              </button>
            </div>
          ) : (
            <div data-testid="line-declare-form" className="rounded-xl border border-line bg-cream p-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor={`qty-${line.offerId}`} className="mb-1 block text-[12px] font-bold text-ink">
                    Quantité achetée
                  </label>
                  <input
                    id={`qty-${line.offerId}`}
                    data-testid="line-declare-quantity"
                    inputMode="numeric"
                    autoComplete="off"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink"
                  />
                </div>
                <div>
                  <label htmlFor={`price-${line.offerId}`} className="mb-1 block text-[12px] font-bold text-ink">
                    Prix convenu par unité (FCFA)
                  </label>
                  <input
                    id={`price-${line.offerId}`}
                    data-testid="line-declare-price"
                    inputMode="numeric"
                    autoComplete="off"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink"
                  />
                </div>
              </div>
              {overPrice ? (
                <p role="alert" data-testid="line-problem" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
                  Ce prix dépasse votre budget par unité ({formatFcfa(mission.unitBudgetXof)}).
                </p>
              ) : overQuantity ? (
                <p role="alert" data-testid="line-problem" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
                  Il ne reste que {remaining} à acheter pour cette mission.
                </p>
              ) : !valid ? (
                <p role="alert" data-testid="line-problem" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
                  Indiquez une quantité de {ORDER_QUANTITY_MIN} à {ORDER_QUANTITY_MAX.toLocaleString("fr-FR")} et un prix en nombres entiers.
                </p>
              ) : null}
              <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">{NO_PAYMENT_NOTICE}</p>
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <button onClick={() => setDeclaring(false)} disabled={pending !== null} className="rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50">
                  Annuler
                </button>
                <button
                  onClick={() => void declare()}
                  disabled={pending !== null || !valid}
                  data-testid="line-declare-submit"
                  className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white disabled:opacity-50"
                >
                  {pending === "declare" ? "Envoi…" : DECLARE_CONFIRM_LABEL}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="line-error" className="mt-2 text-[12px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** Les achats déjà engagés (proposés ou confirmés) : affichés à part, déjà soustraits de la proposition. */
function EngagedSection({ engaged }: { engaged: ProposalEngaged[] }) {
  if (engaged.length === 0) return null;
  return (
    <section className="mt-3" data-testid="proposal-engaged">
      <h3 className="text-[14px] font-extrabold text-ink">{ENGAGED_TITLE}</h3>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{ENGAGED_NOTE}</p>
      <ul aria-label="Achats déjà engagés" className="mt-2 space-y-2">
        {engaged.map((order) => {
          const view = engagedLineView(order);
          return (
            <li key={view.orderId} data-testid="engaged-line" data-order-status={order.status} data-offer={view.offerId} className="rounded-2xl border border-line bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div data-testid="engaged-vendor" className="text-[12px] font-bold uppercase tracking-wide text-ink-soft">
                    {view.vendor}
                  </div>
                  <div className="text-[14px] font-bold text-ink">{view.title}</div>
                  {view.location ? <div className="text-[12px] text-ink-soft">{view.location}</div> : null}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[13px] text-ink-soft">{view.calculText}</div>
                  <div className="font-display text-[16px] font-extrabold text-ink">{view.subtotalText}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="engaged-status">
                <Badge tone={view.confirmed ? "sage" : "carrot"}>{view.statusText}</Badge>
                <Link href={orderPath("buyer", view.orderId)} className="text-[12px] font-bold text-forest">
                  Voir l'achat ›
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** La proposition de répartition (lecture seule) : couverture, budget, raisons d'une couverture incomplète et une carte par vendeur anonyme. */
export function ProposalSection({ mission, proposal, onChanged }: { mission: MissionSummary; proposal: MissionProposal | null; onChanged: () => void }) {
  return (
    <section className="mt-5" data-testid="proposal">
      <h2 className="text-[16px] font-extrabold text-ink">{PROPOSAL_TITLE}</h2>
      {proposal === null ? (
        <p className="mt-2 text-[13px] text-ink-soft" aria-busy="true">
          Recherche des annonces…
        </p>
      ) : proposal.state === "inactive" ? (
        <p data-testid="proposal-inactive" className="mt-2 text-[13px] text-ink-soft">
          {PROPOSAL_INACTIVE}
        </p>
      ) : proposal.state === "unavailable" ? (
        <p role="status" className="mt-2 text-[13px] text-ink-soft">
          {PROPOSAL_UNAVAILABLE}
        </p>
      ) : (
        (() => {
          const summary = proposalSummary(proposal);
          return (
            <>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{PROPOSAL_NOTE}</p>
              <div className="mt-3 rounded-2xl border border-line bg-white p-3.5">
                <div data-testid="proposal-coverage" className="text-[14px] font-bold text-ink">
                  {summary.coverageText} ({summary.coveragePercent} %)
                </div>
                <div className="mt-1.5">
                  <ProgressBar percent={summary.coveragePercent} label="Couverture de la proposition" />
                </div>
                {summary.committedText ? (
                  <div data-testid="proposal-committed" className="mt-1.5 text-[13px] font-semibold text-ink">
                    {summary.committedText}
                  </div>
                ) : null}
                <div data-testid="proposal-budget" className="mt-2 text-[13px] text-ink-soft">
                  Budget utilisé : {summary.budgetText} · {summary.sellersText}
                </div>
                <div className="text-[12px] text-ink-soft">{summary.remainingText}</div>
              </div>
              {proposal.reasons.length > 0 ? (
                <ul data-testid="proposal-reasons" aria-label="Pourquoi la quantité n'est pas entièrement couverte" className="mt-2 space-y-1 rounded-2xl bg-carrot-soft p-3 text-[12px] text-carrot-ink">
                  {proposal.reasons.map((reason) => (
                    <li key={reason} data-reason={reason}>
                      {shortfallText(reason)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <EngagedSection engaged={proposal.engaged} />
              {proposal.lines.length === 0 ? (
                <p data-testid="proposal-empty" className="mt-3 rounded-2xl bg-wash p-4 text-center text-[13px] text-ink-soft">
                  {proposal.remainingQuantity === 0 ? PROPOSAL_ALL_ENGAGED : PROPOSAL_EMPTY}
                </p>
              ) : (
                <>
                  {proposal.engaged.length > 0 ? <h3 className="mt-4 text-[14px] font-extrabold text-ink">{LINES_TITLE}</h3> : null}
                  <ul aria-label="Lignes de la proposition" className="mt-3 space-y-2.5">
                    {proposal.lines.map((line) => (
                      <LineCard key={line.offerId} line={line} mission={mission} onChanged={onChanged} />
                    ))}
                  </ul>
                </>
              )}
            </>
          );
        })()
      )}
    </section>
  );
}
