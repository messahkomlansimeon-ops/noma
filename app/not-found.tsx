import { APP_TITLE } from "@/lib/site";

/**
 * Page 404 UNIQUE de l'application (lot D3-bis) : une adresse qui n'existe pas ET un espace refusé (`notFound()` appelé par le gabarit d'administration pour un compte ordinaire) rendent
 * exactement la même page, avec le même titre d'onglet (celui de l'application), pour que l'existence de l'espace d'administration ne se devine ni au texte ni au titre. Le texte est celui
 * de la page 404 standard de Next (« 404 » puis « This page could not be found. »).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6" data-testid="not-found">
      <title>{APP_TITLE}</title>
      <div className="flex items-center text-ink">
        <h1 className="mr-5 border-r border-ink/30 pr-6 text-[24px] font-medium leading-[49px]">404</h1>
        <h2 className="text-[14px] font-normal leading-[49px]">This page could not be found.</h2>
      </div>
    </main>
  );
}
