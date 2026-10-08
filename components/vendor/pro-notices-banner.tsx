"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { proApi, type SubscriptionNoticeView } from "@/lib/client/pro-api";
import { PRO_PAGE_PATH, noticeView } from "@/lib/client/pro-view";

/**
 * Avis sur l'abonnement (lot PRO1) en haut de l'espace vendeur : renouvellement refusé, abonnement terminé, annonces mises en pause. Seuls les avis NON LUS s'affichent ;
 * « Compris » les marque lus. Toute erreur (pas de session, service indisponible) : rien n'est affiché, jamais un message d'erreur sur chaque page.
 */
export function ProNoticesBanner() {
  const [notices, setNotices] = useState<SubscriptionNoticeView[]>([]);

  useEffect(() => {
    let alive = true;
    proApi.subscription.state().then(
      (state) => {
        if (alive) setNotices(state.notices.filter((notice) => notice.readAt === null));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  if (notices.length === 0) return null;
  const dismiss = () => {
    const ids = notices.map((notice) => notice.id);
    setNotices([]);
    void proApi.subscription.markNoticesRead({ ids }).catch(() => undefined);
  };
  return (
    <section data-testid="pro-notices-banner" aria-label="Avis sur votre abonnement" className="mx-4 mt-2 space-y-2">
      {notices.map((notice) => {
        const view = noticeView(notice);
        return (
          <div key={notice.id} data-testid="pro-banner-notice" data-code={notice.code} className="rounded-2xl border border-carrot/50 bg-carrot-soft p-3">
            <div className="text-[13px] font-extrabold text-carrot-ink">{view.title}</div>
            <p className="mt-0.5 text-[12px] text-carrot-ink">{view.detail}</p>
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-3 text-[12px] font-bold">
        <Link href={PRO_PAGE_PATH} className="text-carrot-ink underline">Voir mon offre</Link>
        <button data-testid="pro-banner-dismiss" onClick={dismiss} className="rounded-lg bg-white px-3 py-1.5 text-ink">Compris</button>
      </div>
    </section>
  );
}
