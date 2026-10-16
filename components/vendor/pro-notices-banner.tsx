"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BellRing, ChevronRight } from "lucide-react";
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
    <section data-testid="pro-notices-banner" aria-label="Avis sur votre abonnement" className="animate-rise mx-4 mt-2 space-y-2">
      {notices.map((notice) => {
        const view = noticeView(notice);
        return (
          <div key={notice.id} data-testid="pro-banner-notice" data-code={notice.code} className="flex items-start gap-3 rounded-3xl border border-accent/50 bg-accent-soft p-3.5">
            <BellRing className="mt-0.5 size-5 shrink-0 text-accent-ink" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-extrabold text-accent-ink">{view.title}</div>
              <p className="mt-0.5 text-[13px] text-accent-ink">{view.detail}</p>
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2 text-[14px] font-bold">
        <Link href={PRO_PAGE_PATH} className="press flex min-h-11 items-center gap-1 rounded-full px-3 text-accent-ink hover:bg-accent-soft">
          Voir mon offre
          <ChevronRight className="size-4" aria-hidden />
        </Link>
        <button data-testid="pro-banner-dismiss" onClick={dismiss} className="press min-h-11 rounded-full border border-line-strong bg-white px-4 text-ink">
          Compris
        </button>
      </div>
    </section>
  );
}
