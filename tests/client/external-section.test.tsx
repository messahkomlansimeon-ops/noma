import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { ExternalCard, ExternalSectionView, type ExternalSectionState } from "../../components/external/external-section";
import type { ExternalListing } from "../../lib/client/external-api";
import { externalMention } from "../../lib/client/external-view";

/**
 * Section « Sur d'autres sites » (lot EXT1), rendue sans navigateur : séparée des résultats noma, mention obligatoire, lien sortant sûr, aucune action de noma (contact, favori,
 * commande, boost), « Voir plus » seulement s'il reste des pages, panne discrète.
 */

const NOW = "2026-10-07T10:00:00.000Z";
const listing = (n: number, over: Partial<ExternalListing> = {}): ExternalListing => ({
  id: `2a2a2a2a-2b2b-4c3c-8d4d-${String(n).padStart(12, "0")}`, title: `iPhone 12 128 Go noir n°${n}`, price: { amount: 150_000 + n, currency: "XOF" }, location: "Cocody", listedAt: NOW,
  source: { code: "demo_a", name: "Annonces Démo A" }, alsoOn: [], url: `https://annonces-demo-a.example/annonce/demo_a-${n}`, score: 100, seenAt: NOW, confirmedAt: NOW, ...over,
});

const view = (state: ExternalSectionState, props: { loadingMore?: boolean; moreError?: boolean } = {}) =>
  renderToStaticMarkup(<ExternalSectionView state={state} loadingMore={props.loadingMore ?? false} moreError={props.moreError ?? false} onMore={() => undefined} />);

describe("section avec des annonces", () => {
  const html = view({ kind: "ready", items: [listing(1), listing(2, { source: { code: "demo_b", name: "Annonces Démo B" }, alsoOn: [{ code: "demo_a", name: "Annonces Démo A" }] })], nextCursor: "curseur" });

  test("titre « Sur d'autres sites », une carte par annonce, séparées de la liste noma", () => {
    assert.match(html, /<section[^>]*data-testid="external-section"/);
    assert.match(html, /<h2[^>]*>Sur d&#x27;autres sites<\/h2>/);
    assert.equal((html.match(/data-testid="external-card"/g) ?? []).length, 2);
    assert.equal(html.includes('data-testid="match-card"'), false, "jamais une carte de résultat noma");
    assert.equal(/Sponsoris/i.test(html), false, "jamais « Sponsorisé »");
  });

  test("chaque carte porte la mention obligatoire de SA source", () => {
    const mentions = [...html.matchAll(/data-testid="external-mention"[^>]*>([^<]*)</g)].map((match) => match[1].replace(/&#x27;/g, "'"));
    assert.deepEqual(mentions, [externalMention("Annonces Démo A"), externalMention("Annonces Démo B")]);
    assert.ok(mentions[0].endsWith("vous serez redirigé vers le site."));
  });

  test("lot FIN1 : une annonce d'une source FICTIVE (adresse en .example) n'ouvre AUCUN lien mort : bouton désactivé « Voir sur le site » et mention « Site de démonstration »", () => {
    assert.equal([...html.matchAll(/<a [^>]*data-testid="external-link"[^>]*>/g)].length, 0, "aucun lien vers un domaine .example");
    assert.equal(/href="https:\/\/annonces-demo/.test(html), false);
    const demo = [...html.matchAll(/<div data-testid="external-link-demo"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]);
    assert.equal(demo.length, 2);
    for (const block of demo) {
      assert.match(block, /<button[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Voir sur le site/);
      assert.match(block, /Site de démonstration : annonce d(?:'|&#x27;)exemple, ce site n(?:'|&#x27;)existe pas\./);
    }
  });

  test("une annonce d'un VRAI site garde son lien sortant : nouvel onglet et rel noopener noreferrer nofollow", () => {
    const real = renderToStaticMarkup(ExternalCard({ item: listing(1, { url: "https://www.exemple-reel.ci/annonce/42" }) }));
    const anchors = [...real.matchAll(/<a [^>]*data-testid="external-link"[^>]*>/g)].map((match) => match[0]);
    assert.equal(anchors.length, 1);
    assert.match(anchors[0], /target="_blank"/);
    assert.match(anchors[0], /rel="noopener noreferrer nofollow"/);
    assert.match(anchors[0], /href="https:\/\/www\.exemple-reel\.ci\/annonce\/42"/);
    assert.equal(/external-link-demo/.test(real), false);
  });

  test("aucune action de noma : ni contact, ni favori, ni commande, ni message, ni téléphone, ni lien interne vers une fiche", () => {
    for (const forbidden of [/Contacter/i, /favori/i, /commande/i, /Écrire/i, /tel:/i, /wa\.me/i, /href="\/offre/, /href="\/besoins/, /data-testid="[^"]*(favorite|contact|order|message|boost)/i, /onclick/i]) assert.equal(forbidden.test(html), false, String(forbidden));
    assert.equal((html.match(/<button/g) ?? []).length, 3, "« Voir plus » et les deux boutons DÉSACTIVÉS des sites de démonstration (aucune action)");
    assert.equal((html.match(/<button(?![^>]*\sdisabled="")/g) ?? []).length, 1, "un seul bouton actif : « Voir plus »");
  });

  test("doublon entre sources : « Aussi trouvée sur … » ; prix et lieu affichés", () => {
    assert.match(html, /data-testid="external-also-on"[^>]*>Aussi trouvée sur Annonces Démo A</);
    assert.match(html.replace(/&nbsp;| | /g, " "), /150 001 FCFA/);
    assert.match(html, />Cocody</);
  });

  test("« Voir plus » : présent s'il reste des pages, absent à la dernière, désactivé pendant le chargement", () => {
    assert.match(html, /data-testid="external-more"[^>]*>Voir plus</);
    assert.equal(view({ kind: "ready", items: [listing(1)], nextCursor: null }).includes("external-more"), false);
    assert.match(view({ kind: "ready", items: [listing(1)], nextCursor: "x" }, { loadingMore: true }), /disabled=""[^>]*>Chargement…|disabled="" data-testid="external-more"|data-testid="external-more"[^>]*disabled/);
    assert.match(view({ kind: "ready", items: [listing(1)], nextCursor: "x" }, { moreError: true }), /role="alert"/);
  });
});

describe("états sans annonce", () => {
  test("rien à montrer : aucune section (pas d'état vide inutile)", () => {
    assert.equal(view({ kind: "ready", items: [], nextCursor: null }), "");
  });

  test("chargement : une note discrète ; panne : une note, jamais d'erreur technique", () => {
    assert.match(view({ kind: "loading" }), /data-testid="external-loading"[^>]*aria-busy="true"|aria-busy="true"[^>]*data-testid="external-loading"/);
    const failure = view({ kind: "error" });
    assert.match(failure, /data-testid="external-unavailable"/);
    assert.match(failure.replace(/&#x27;/g, "'"), /Les annonces d'autres sites sont momentanément indisponibles\. Vos résultats noma ne sont pas concernés\./);
    assert.equal(/[a-z]+_[a-z0-9_]+|undefined|NaN|\[object|Error/.test(failure), false);
  });
});

describe("carte seule", () => {
  test("sans adresse sûre, aucun lien n'est rendu mais la mention reste", () => {
    const html = renderToString(<ul><ExternalCard item={listing(1, { url: "javascript:alert(1)" })} /></ul>);
    assert.equal(html.includes("<a "), false);
    assert.equal(html.includes("javascript:"), false);
    assert.ok(html.includes("noma ne garantit ni le prix ni la disponibilité"));
  });
});
