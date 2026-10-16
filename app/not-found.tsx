import Link from "next/link";
import { House } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { APP_TITLE } from "@/lib/site";

/**
 * Page 404 UNIQUE de l'application (lot D3-bis) : une adresse qui n'existe pas ET un espace refusé (`notFound()` appelé par le gabarit d'administration pour un compte ordinaire) rendent
 * exactement la même page, avec le même titre d'onglet (celui de l'application), pour que l'existence de l'espace d'administration ne se devine ni au texte ni au titre. Le texte est celui
 * de la page 404 standard de Next (« 404 » puis « This page could not be found. »).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center" data-testid="not-found">
      <title>{APP_TITLE}</title>
      <ArtAlert className="size-40" />
      <div className="animate-rise flex flex-col items-center gap-1">
        <h1 className="text-[56px] font-extrabold leading-none tracking-tight text-brand">404</h1>
        <h2 className="text-[17px] font-bold text-ink">This page could not be found.</h2>
      </div>
      <Link
        href="/"
        aria-label="Accueil"
        className="press flex size-14 items-center justify-center rounded-full bg-brand text-white hover:bg-brand-deep"
      >
        <House className="size-6" aria-hidden />
      </Link>
    </main>
  );
}
