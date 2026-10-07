import Link from "next/link";
import { ArrowLeft, Hourglass } from "lucide-react";
import { LogoMark } from "@/components/logo";

/**
 * Écran « Bientôt disponible » (lot D1) : une seule présentation pour toutes les fonctions qui ne sont pas encore branchées sur le serveur (comparer, partager,
 * messages, commandes, administration…). Aucune donnée d'exemple : un titre, une phrase simple, un bouton de retour.
 */
export const COMING_SOON_LABEL = "Bientôt disponible";

export function ComingSoon({
  title,
  sentence = "Cette fonction arrive bientôt dans noma. Elle n'est pas encore ouverte.",
  backHref = "/",
  backLabel = "Retour",
}: {
  title: string;
  sentence?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <main>
      <div className="px-4 py-3">
        <LogoMark />
      </div>
      <div className="px-4">
        <div className="mt-6 rounded-2xl border border-line bg-white p-6 text-center" data-coming-soon>
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sage text-forest">
            <Hourglass className="size-7" strokeWidth={1.6} aria-hidden />
          </span>
          <div className="mt-3 text-[12px] font-extrabold uppercase tracking-wider text-sage-ink">{COMING_SOON_LABEL}</div>
          <h1 className="mt-1 font-display text-[22px] font-extrabold text-ink">{title}</h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">{sentence}</p>
          <Link
            href={backHref}
            className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-forest px-5 py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {backLabel}
          </Link>
        </div>
      </div>
    </main>
  );
}
