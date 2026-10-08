"use client";

import { useEffect, useMemo, useState } from "react";
import { market } from "@/lib/client/market-api";
import { marketHintText, marketQueryFromForm } from "@/lib/client/market-view";

/** Délai de frappe avant de lire le marché : on n'interroge pas le serveur à chaque lettre. */
const HINT_DELAY_MS = 600;

/**
 * Indication du formulaire d'annonce (lots H1, H1-bis et H1-ter) : « Prix demandés dans les annonces pour ce produit : médiane 165 000 FCFA (environ 15 annonces d'environ 10 vendeurs,
 * 90 jours). Comparé à : … », quand la catégorie, la marque et le modèle sont renseignés ET que les annonces ont assez de données (au moins 5 vendeurs). Sinon, rien n'est affiché (jamais une erreur au vendeur qui remplit son formulaire). Le texte lu n'est montré que
 * pour la requête qui l'a produit : dès que le vendeur change un champ, l'ancienne indication disparaît.
 */
export function MarketHint({ category, brand, model, variant, condition }: { category: string | null; brand: string; model: string; variant: string; condition: string | null }) {
  const query = useMemo(() => marketQueryFromForm({ category, brand, model, variant, condition }), [category, brand, model, variant, condition]);
  const key = query === null ? null : JSON.stringify(query);
  const [result, setResult] = useState<{ key: string; text: string | null } | null>(null);

  useEffect(() => {
    if (query === null || key === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      market.stats(query, { signal: controller.signal }).then(
        (stats) => {
          if (!controller.signal.aborted) setResult({ key, text: marketHintText(stats) });
        },
        () => {
          if (!controller.signal.aborted) setResult({ key, text: null });
        },
      );
    }, HINT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, key]);

  const text = key !== null && result !== null && result.key === key ? result.text : null;
  if (text === null) return null;
  return (
    <p data-testid="market-hint" className="mt-1.5 text-[12px] font-semibold leading-snug text-forest">
      {text}
    </p>
  );
}
