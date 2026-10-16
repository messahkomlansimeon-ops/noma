"use client";

import { useState } from "react";
import { Check, Clock, Crown, FilePlus2, Package, Users, Wallet } from "lucide-react";
import { Notice, PageHeading, Panel, StatTile, adminBtnPrimary, adminField } from "@/components/admin/admin-ui";
import { Badge, Input } from "@/components/ui";
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
    <div data-testid="admin-offers" className="flex flex-col gap-4">
      <PageHeading icon={Crown} tone="accent">
        Offres Pro
      </PageHeading>
      <Notice tone="accent" data-testid="admin-offers-provisional">
        {PRICES_PROVISIONAL_NOTICE}
      </Notice>
      <p className="-mt-2 text-[13px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>

      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile tile="subscribers" icon={Users} tone="brand" label="Abonnés" value={approximateText(overview.totalSubscribersApproximate)} detail="Arrondi à 5 près." />
        <StatTile tile="revenue" icon={Wallet} tone="success" label="Revenus du mois" value={formatFcfa(overview.subscriptionRevenueXof)} detail="Nets des remboursements." />
        <StatTile
          tile="promo"
          icon={Clock}
          tone="accent"
          label="Crédits promotionnels du mois"
          className="col-span-2 md:col-span-1"
          valueClassName="text-[14px]"
          value={`${formatFcfa(overview.promo.issuedXof)} émis · ${formatFcfa(overview.promo.spentXof)} dépensés · ${formatFcfa(overview.promo.expiredXof)} expirés`}
        />
      </div>

      <div className="stagger flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
        {overview.plans.map((plan) => {
          const subscribers = overview.subscribers.find((entry) => entry.planCode === plan.code);
          return (
            <Panel
              key={plan.code}
              icon={Package}
              tone="brand"
              title={planCodeLabel(plan.code)}
              data-plan={plan.code}
              aside={subscribers ? <Badge tone="sky">{approximateText(subscribers.approximateCount)} abonnés</Badge> : null}
            >
              <ul className="mt-3 divide-y divide-line" aria-label={`Versions du plan ${planCodeLabel(plan.code)}`}>
                {adminVersionRows(plan.versions).map((row, index) => (
                  <li key={row.key} data-testid="admin-version" data-version={row.version} className="space-y-0.5 py-3 text-[13px] text-ink-soft first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-extrabold text-ink">Version {row.version} · {row.name}</span>
                      <Badge tone={index === 0 ? "sage" : "wash"}>{index === 0 ? "courante" : "ancienne"}</Badge>
                    </div>
                    <div>{row.dateText}</div>
                    <div>{row.priceText} · crédits promotionnels : {row.promoText} · {row.offersText} annonces en ligne</div>
                    <div>{row.rightsText}</div>
                  </li>
                ))}
              </ul>
            </Panel>
          );
        })}
      </div>

      <Panel icon={FilePlus2} tone="accent" title="Nouvelle version d'un plan" titleId="new-version-title" aria-labelledby="new-version-title">
        <div className="mt-3 flex flex-col gap-3 md:grid md:grid-cols-2">
          <div>
            <label htmlFor="new-version-plan" className="mb-1.5 block text-[14px] font-bold text-ink">Plan</label>
            <select id="new-version-plan" data-testid="new-version-plan" value={planCode} onChange={(event) => setPlanCode(event.target.value)} className={adminField}>
              {overview.plans.map((plan) => <option key={plan.code} value={plan.code}>{planCodeLabel(plan.code)}</option>)}
            </select>
          </div>
          {([
            ["name", "Nom (1 à 60 caractères)", "text"],
            ["monthlyPriceXof", "Prix mensuel (FCFA)", "numeric"],
            ["promoCreditsXof", "Crédits promotionnels par mois (FCFA)", "numeric"],
            ["maxOnlineOffers", "Annonces en ligne au plus", "numeric"],
          ] as const).map(([field, label, mode]) => (
            <div key={field}>
              <label htmlFor={`new-version-${field}`} className="mb-1.5 block text-[14px] font-bold text-ink">{label}</label>
              <Input
                id={`new-version-${field}`}
                data-testid={`new-version-${field}`}
                value={form[field]}
                inputMode={mode === "numeric" ? "numeric" : "text"}
                onChange={(event) => setForm((currentForm) => ({ ...currentForm, [field]: event.target.value }))}
              />
              {errors[field] ? <p role="alert" className="mt-1 text-[13px] font-semibold text-danger-ink">{errors[field]}</p> : null}
            </div>
          ))}
        </div>
        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[14px] font-bold text-ink">Droits</legend>
          <div className="grid gap-2 md:grid-cols-2">
            {ENTITLEMENTS.map((entitlement) => (
              <label key={entitlement} className="press flex min-h-11 items-center gap-3 rounded-2xl border-2 border-line px-3.5 py-2 text-[15px] font-semibold text-ink hover:border-line-strong">
                <input type="checkbox" data-testid={`new-version-right-${entitlement}`} checked={form.entitlements.includes(entitlement)} onChange={() => toggle(entitlement)} className="size-5 accent-brand" />
                {entitlementLabel(entitlement)}
              </label>
            ))}
          </div>
          {errors.entitlements ? <p role="alert" className="mt-1 text-[13px] font-semibold text-danger-ink">{errors.entitlements}</p> : null}
        </fieldset>
        <button data-testid="new-version-submit" onClick={() => void submit()} disabled={pending} className={`${adminBtnPrimary} mt-4 w-full min-h-12 text-[16px]`}>
          <Check className="size-5" aria-hidden />
          {pending ? "Création…" : `Créer une version de « ${planCodeLabel(planCode)} »`}
        </button>
        {message ? <p role="status" data-testid="new-version-message" className="mt-3 rounded-2xl bg-mist p-3 text-[14px] font-semibold text-ink">{message}</p> : null}
        {current ? <p className="mt-2 text-[12px] text-ink-soft">Version courante actuelle : {current.versions[0]?.version ?? "—"}.</p> : null}
      </Panel>
    </div>
  );
}
