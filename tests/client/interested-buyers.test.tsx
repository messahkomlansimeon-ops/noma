import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";
import { InterestedList } from "../../components/vendor/interested-buyers";
import type { StoredMatch } from "../../lib/client/api";
import { NEEDS_NOTE } from "../../lib/client/match-view";

/**
 * Lot D3, point 4 : la page vendeur d'une annonce n'affiche plus de compte arrondi au-dessus de la liste « Acheteurs intéressés » (« Environ 10 besoins… » contredisait les 12 lignes
 * visibles). La liste anonyme des besoins RESTE (c'est le produit) ; « Voir plus » reste ; une phrase dit ce qu'est une ligne.
 */

function needMatch(index: number): StoredMatch {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    candidateId: id,
    candidate: {
      category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: "Occasion", quantity: null, unit: null, location: "Abidjan", deadlineAt: null,
      price: null, budget: { amount: 200000 + index, currency: "XOF" }, availabilityStatus: null,
    },
    compatibilityStatus: "compatible",
    score: 90,
    coverage: 1,
    evaluatedAt: "2031-01-01T10:00:00.000Z",
    indicators: { availability: null, price: null, confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: [] } },
    relevance: 80,
    sponsored: false,
  };
}

const render = (count: number, nextCursor: string | null = null): string =>
  renderToString(<InterestedList loaded={{ items: Array.from({ length: count }, (_, index) => needMatch(index + 1)), processing: false, nextCursor, truncated: false }} moreError={null} loadingMore={false} disabled={false} onMore={() => undefined} />);

describe("« Acheteurs intéressés » sans compte arrondi (lot D3)", () => {
  test("12 besoins : 12 lignes anonymes, la phrase, AUCUN compte (ni « Environ », ni « Moins de », ni « Au moins », ni élément interested-count)", () => {
    const html = render(12);
    assert.equal((html.match(/data-testid="interested-buyer"/g) ?? []).length, 12, "la liste reste entière : c'est le produit");
    assert.match(html, /Chaque ligne est le besoin d&#x27;un acheteur, sans son identité\./);
    assert.equal(NEEDS_NOTE, "Chaque ligne est le besoin d'un acheteur, sans son identité.");
    assert.equal(html.includes('data-testid="interested-count"'), false, "plus de compte au-dessus de la liste");
    for (const forbidden of [/Environ \d+ besoins/i, /Moins de \d+ besoins/i, /Au moins \d+ besoins/i, /Plusieurs besoins d/i, /\d+ besoins d&#x27;acheteurs correspondent/i]) {
      assert.equal(forbidden.test(html), false, String(forbidden));
    }
    // Aucune identité d'acheteur : seulement besoin, budget, compatibilité, confiance.
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-4/.test(html), false, "aucun identifiant affiché");
  });

  test("un seul besoin : toujours la ligne et la phrase, pas de « Moins de 5 »", () => {
    const html = render(1);
    assert.equal((html.match(/data-testid="interested-buyer"/g) ?? []).length, 1);
    assert.equal(/Moins de 5/i.test(html), false);
    assert.match(html, /data-testid="interested-note"/);
  });

  test("« Voir plus » reste quand il reste des pages ; il disparaît à la dernière", () => {
    assert.match(render(12, "curseur"), /Voir plus/);
    assert.equal(/Voir plus/.test(render(12, null)), false);
  });

  test("aucun besoin : le message vide, aucune phrase de ligne, aucun compte", () => {
    const html = render(0);
    assert.match(html, /data-testid="interested-empty"/);
    assert.match(html, /Aucun besoin d&#x27;acheteur ne correspond pour le moment/);
    assert.equal(html.includes('data-testid="interested-note"'), false);
    assert.equal(html.includes('data-testid="interested-count"'), false);
  });

  test("le composant n'importe plus aucun libellé de compte arrondi", () => {
    const source = readFileSync(join(import.meta.dirname, "../../components/vendor/interested-buyers.tsx"), "utf8");
    assert.equal(source.includes("matchingNeedsLabel"), false);
    assert.equal(source.includes("interested-count"), false);
  });
});
