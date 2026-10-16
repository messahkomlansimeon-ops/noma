import { ArrowLeft, Hourglass } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Btn, IconTile } from "@/components/ui";

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
      <div className="px-4 py-3 md:hidden">
        <LogoMark />
      </div>
      <div className="px-4">
        <div className="animate-rise mt-6 flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-6 text-center" data-coming-soon>
          <IconTile icon={Hourglass} tone="accent" className="size-16" />
          <div className="text-[13px] font-extrabold uppercase tracking-wider text-brand-ink">{COMING_SOON_LABEL}</div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink">{title}</h1>
          <p className="text-[15px] leading-relaxed text-ink-soft">{sentence}</p>
          <div className="mt-2 w-full max-w-xs">
            <Btn href={backHref}>
              <ArrowLeft className="size-5" aria-hidden />
              {backLabel}
            </Btn>
          </div>
        </div>
      </div>
    </main>
  );
}
