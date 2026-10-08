"use client";

import { useState } from "react";
import { describeApiError } from "@/lib/client/api";
import { ENTITLEMENTS, proApi, type AdminPlansOverview, type Entitlement } from "@/lib/client/pro-api";
import { PRICES_PROVISIONAL_NOTICE, adminVersionRows, approximateText, buildNewVersion, entitlementLabel, planCodeLabel } from "@/lib/client/pro-view";
import { formatDateFr, formatFcfa } from "@/lib/client/wallet-view";

/**
 * Administration des offres Pro (lot PRO1) : versions des plans en LECTURE SEULE (une version publiée ne se modifie jamais), création d'une NOUVELLE version, abonnés arrondis à
 * 5 près, revenus d'abonnement du mois (lus dans le grand livre). Les prix sont PROVISOIRES.
 */
export function OffersAdmin({ overview, reload }: { overview: AdminPlansOverview; reload: () => void }) {
  const [planCode, setPlanCode] = useState(overview.plans.find((plan) => plan.code !== "free")?.code ?? overview.plans[0]?.code ?? "pro");
  const [form, setForm] = useState({ name: "", monthlyPriceXof: "", promoCreditsXof: "", maxOnlineOffers: "", entitlements: [] as Entitlement[] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (entitlement: Entitlement) =>
    setForm((current) => ({
      ...current,
      entitlements: current.entitlements.includes(entitlement) ? current.entitlements.filter((entry) => entry !== entitlement) : [...current.entitlements, entitlement],
    }));

  const submit = async () => {
    if (pending) return;
    const built = buildNewVersion(form, planCode);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setPending(true);
    setMessage(null);
    try {
      await proApi.adminPlans.createVersion(planCode, built.request);
      setMessage("Nouvelle version créée : elle ne s'applique qu'aux nouveaux abonnements. Les abonnés actuels gardent leur prix.");
      setForm({ name: "", monthlyPriceXof: "", promoCreditsXof: "", maxOnlineOffers: "", entitlements: [] });
      reload();
    } catch (failure) {
      setMessage(describeApiError(failure, "subscription"));
    } finally {
      setPending(false);
    }
  };

  const current = overview.plans.find((plan) => plan.code === planCode);
  return (
    <div data-testid="admin-offers">
      <h1 className="font-display text-[22px] font-extrabold text-ink">Offres Pro</h1>
      <p data-testid="admin-offers-provisional" className="mt-1 rounded-lg bg-carrot-soft px-3 py-2 text-[12px] font-semibold text-carrot-ink">{PRICES_PROVISIONAL_NOTICE}</p>
      <p className="mt-1 text-[12px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <div data-tile="subscribers" className="rounded-2xl border border-line bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Abonnés</div>
          <div data-tile-value className="font-display text-[22px] font-extrabold leading-tight text-ink">{approximateText(overview.totalSubscribersApproximate)}</div>
          <div className="text-[11px] leading-snug text-ink-soft">Arrondi à 5 près.</div>
        </div>
        <div data-tile="revenue" className="rounded-2xl border border-line bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Revenus du mois</div>
          <div data-tile-value className="font-display text-[22px] font-extrabold leading-tight text-ink">{formatFcfa(overview.subscriptionRevenueXof)}</div>
          <div className="text-[11px] leading-snug text-ink-soft">Abonnements, nets des remboursements.</div>
        </div>
        <div data-tile="promo" className="col-span-2 rounded-2xl border border-line bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Crédits promotionnels du mois</div>
          <div data-tile-value className="text-[13px] font-bold text-ink">
            {formatFcfa(overview.promo.issuedXof)} émis · {formatFcfa(overview.promo.spentXof)} dépensés · {formatFcfa(overview.promo.expiredXof)} expirés
          </div>
        </div>
      </div>

      {overview.plans.map((plan) => (
        <section key={plan.code} data-plan={plan.code} className="mt-4 rounded-2xl border border-line bg-white p-4">
          <h2 className="text-[15px] font-extrabold text-ink">
            {planCodeLabel(plan.code)}
            {overview.subscribers.find((entry) => entry.planCode === plan.code) ? (
              <span className="ml-2 text-[12px] font-semibold text-ink-soft">
                {approximateText(overview.subscribers.find((entry) => entry.planCode === plan.code)!.approximateCount)} abonnés
              </span>
            ) : null}
          </h2>
          <ul className="mt-2 divide-y divide-line" aria-label={`Versions du plan ${planCodeLabel(plan.code)}`}>
            {adminVersionRows(plan.versions).map((row, index) => (
              <li key={row.key} data-testid="admin-version" data-version={row.version} className="py-2 text-[12px] text-ink-soft">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-extrabold text-ink">Version {row.version} · {row.name}</span>
                  <span>{index === 0 ? "courante" : "ancienne"} · {row.dateText}</span>
                </div>
                <div>{row.priceText} · crédits promotionnels : {row.promoText} · {row.offersText} annonces en ligne</div>
                <div>{row.rightsText}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="new-version-title" className="mt-4 rounded-2xl border border-line bg-white p-4">
        <h2 id="new-version-title" className="text-[15px] font-extrabold text-ink">Nouvelle version d&apos;un plan</h2>
        <p className="mt-1 text-[12px] text-ink-soft">Une version publiée ne se modifie jamais : on en crée une nouvelle. Elle ne s&apos;applique qu&apos;aux nouveaux abonnements : les abonnés actuels gardent leur prix, renouvellements compris.</p>
        <label htmlFor="new-version-plan" className="mt-3 block text-[13px] font-bold text-ink">Plan</label>
        <select id="new-version-plan" data-testid="new-version-plan" value={planCode} onChange={(event) => setPlanCode(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[14px]">
          {overview.plans.map((plan) => <option key={plan.code} value={plan.code}>{planCodeLabel(plan.code)}</option>)}
        </select>
        {([
          ["name", "Nom (1 à 60 caractères)", "text"],
          ["monthlyPriceXof", "Prix mensuel (FCFA)", "numeric"],
          ["promoCreditsXof", "Crédits promotionnels par mois (FCFA)", "numeric"],
          ["maxOnlineOffers", "Annonces en ligne au plus", "numeric"],
        ] as const).map(([field, label, mode]) => (
          <div key={field}>
            <label htmlFor={`new-version-${field}`} className="mt-3 block text-[13px] font-bold text-ink">{label}</label>
            <input
              id={`new-version-${field}`}
              data-testid={`new-version-${field}`}
              value={form[field]}
              inputMode={mode === "numeric" ? "numeric" : "text"}
              onChange={(event) => setForm((currentForm) => ({ ...currentForm, [field]: event.target.value }))}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[14px]"
            />
            {errors[field] ? <p role="alert" className="mt-1 text-[12px] font-semibold text-carrot-ink">{errors[field]}</p> : null}
          </div>
        ))}
        <fieldset className="mt-3">
          <legend className="text-[13px] font-bold text-ink">Droits</legend>
          {ENTITLEMENTS.map((entitlement) => (
            <label key={entitlement} className="mt-1.5 flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" data-testid={`new-version-right-${entitlement}`} checked={form.entitlements.includes(entitlement)} onChange={() => toggle(entitlement)} />
              {entitlementLabel(entitlement)}
            </label>
          ))}
          {errors.entitlements ? <p role="alert" className="mt-1 text-[12px] font-semibold text-carrot-ink">{errors.entitlements}</p> : null}
        </fieldset>
        <button data-testid="new-version-submit" onClick={() => void submit()} disabled={pending} className="mt-4 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50">
          {pending ? "Création…" : `Créer une version de « ${planCodeLabel(planCode)} »`}
        </button>
        {message ? <p role="status" data-testid="new-version-message" className="mt-3 rounded-xl bg-wash p-3 text-[13px] font-semibold text-ink">{message}</p> : null}
        {current ? <p className="mt-2 text-[11px] text-ink-soft">Version courante actuelle : {current.versions[0]?.version ?? "—"}.</p> : null}
      </section>
    </div>
  );
}
