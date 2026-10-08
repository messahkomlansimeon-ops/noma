import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AdminCollection, AdminCollectionSource, ExternalListing } from "../../lib/client/external-api";
import {
  ADMIN_COLLECTION_NOTE, ADMIN_COLLECTION_TITLE, BREAKER_LABELS, EXTERNAL_LINK_REL, EXTERNAL_LINK_TARGET, EXTERNAL_MORE_LABEL, EXTERNAL_SECTION_TITLE, UNKNOWN_ERROR_LABEL,
  adminErrorRows, adminSourceRow, adminWatchSummary, errorLabel, externalCardRow, externalLinkProps, externalMention, mergeExternalItems,
} from "../../lib/client/external-view";

/** Présentation de la section « Sur d'autres sites » et de la page /admin/collecte (lot EXT1) : fonctions pures. */

const NOW = "2026-10-07T10:00:00.000Z";
const listing = (over: Partial<ExternalListing> = {}): ExternalListing => ({
  id: "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", title: "iPhone 12 128 Go noir", price: { amount: 150_000, currency: "XOF" }, location: "Cocody", listedAt: NOW,
  source: { code: "demo_a", name: "Annonces Démo A" }, alsoOn: [], url: "https://annonces-demo-a.example/annonce/demo_a-1", score: 100, seenAt: NOW, confirmedAt: NOW, ...over,
});

describe("section « Sur d'autres sites »", () => {
  test("la mention obligatoire, mot pour mot", () => {
    assert.equal(EXTERNAL_SECTION_TITLE, "Sur d'autres sites");
    assert.equal(externalMention("Annonces Démo A"), "Annonce trouvée sur Annonces Démo A : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site.");
    assert.equal(externalCardRow(listing()).mention, externalMention("Annonces Démo A"));
    assert.equal(EXTERNAL_MORE_LABEL, "Voir plus");
  });

  test("lien sortant : nouvel onglet, rel noopener noreferrer nofollow ; aucune adresse non http(s)", () => {
    assert.equal(EXTERNAL_LINK_TARGET, "_blank");
    assert.equal(EXTERNAL_LINK_REL, "noopener noreferrer nofollow");
    assert.deepEqual(externalLinkProps("https://a.example/x"), { href: "https://a.example/x", target: "_blank", rel: "noopener noreferrer nofollow" });
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example", "https://u:p@a.example/", "", "relatif/chemin"]) assert.equal(externalLinkProps(url), null, url);
    assert.equal(externalCardRow(listing({ url: "javascript:alert(1)" })).link, null);
  });

  test("ligne d'une annonce : prix en FCFA, lieu, compatibilité, doublons entre sources, date de vue", () => {
    const row = externalCardRow(listing({ alsoOn: [{ code: "demo_b", name: "Annonces Démo B" }] }));
    assert.equal(row.title, "iPhone 12 128 Go noir");
    assert.equal(row.priceText.replace(/\s/g, " "), "150 000 FCFA");
    assert.equal(row.locationText, "Cocody");
    assert.equal(row.compatibilityText, "Compatibilité 100 %");
    assert.equal(row.alsoOnText, "Aussi trouvée sur Annonces Démo B");
    assert.match(row.seenText, /^Vue le \d{2}\/\d{2}\/\d{4}$/);
    // La date affichée est la date de VUE (`seenAt`), jamais celle d'un examen où l'annonce était absente.
    assert.equal(externalCardRow(listing({ seenAt: "2026-09-01T10:00:00.000Z" })).seenText, "Vue le 01/09/2026");
    assert.equal(externalCardRow(listing({ price: null })).priceText, "Prix non indiqué");
    assert.equal(externalCardRow(listing({ alsoOn: [{ code: "b", name: "B" }, { code: "c", name: "C" }, { code: "d", name: "D" }] })).alsoOnText, "Aussi trouvée sur B, C et D");
    assert.equal(externalCardRow(listing({ score: 250 })).compatibilityText, "Compatibilité 100 %");
    assert.equal(externalCardRow(listing({ score: 99.6 })).compatibilityText, "Compatibilité 100 %");
  });

  test("fusion d'une page suivante : sans doublon, ordre conservé", () => {
    const a = listing({ id: "11111111-1111-4111-8111-111111111111" });
    const b = listing({ id: "22222222-2222-4222-8222-222222222222" });
    const c = listing({ id: "33333333-3333-4333-8333-333333333333" });
    assert.deepEqual(mergeExternalItems([a, b], [b, c]).map((item) => item.id), [a.id, b.id, c.id]);
    assert.deepEqual(mergeExternalItems([], [a]).length, 1);
  });
});

describe("page /admin/collecte", () => {
  const source = (over: Partial<AdminCollectionSource> = {}): AdminCollectionSource => ({
    code: "demo_a", name: "Annonces Démo A", type: "fake", enabled: true, state: "closed", consecutiveFailures: 0, breakerOpenUntil: null, usedToday: 3, dailyQuota: 200, minIntervalMs: 250,
    lastSuccessAt: NOW, lastFailureAt: null, lastErrorCode: null, ...over,
  });

  test("source : état, quota consommé, échecs, pause, dernière erreur en mots simples", () => {
    const closed = adminSourceRow(source());
    assert.equal(closed.stateText, BREAKER_LABELS.closed);
    assert.equal(closed.quotaText, "3 / 200 requêtes aujourd'hui");
    assert.equal(closed.failuresText, "Aucun échec de suite");
    assert.equal(closed.pauseText, null);
    assert.equal(closed.typeText, "Fictive");
    const open = adminSourceRow(source({ state: "open", consecutiveFailures: 3, breakerOpenUntil: "2026-10-07T10:30:00.000Z", lastErrorCode: "timeout" }));
    assert.equal(open.stateText, "En pause (disjoncteur ouvert)");
    assert.equal(open.failuresText, "3 échec(s) de suite");
    assert.match(open.pauseText ?? "", /^En pause jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/);
    assert.equal(open.lastErrorText, "Délai dépassé");
    assert.equal(adminSourceRow(source({ enabled: false, state: "disabled" })).stateText, "Désactivée");
    assert.equal(adminSourceRow(source({ type: "autre" })).typeText, "Autre");
  });

  test("codes d'erreur : libellés fixes, jamais un code inconnu tel quel", () => {
    assert.equal(errorLabel("timeout"), "Délai dépassé");
    assert.equal(errorLabel("connector_error"), "Panne de la source");
    assert.equal(errorLabel("invalid_response"), "Réponse invalide");
    assert.equal(errorLabel("store_conflict"), "Conflit d'écriture");
    for (const unknown of ["toString", "__proto__", "inconnu", "constructor"]) assert.equal(errorLabel(unknown), UNKNOWN_ERROR_LABEL);
  });

  test("résumé des surveillances et dernières erreurs", () => {
    const collection: Pick<AdminCollection, "watches" | "listings"> = { watches: { total: 3, active: 2, paused: 1, due: 1 }, listings: { available: 8, gone: 2, unknown: 1, groups: 1 } };
    assert.deepEqual(adminWatchSummary(collection).lines, [
      "3 surveillance(s) : 2 active(s), 1 en pause, 1 due(s) maintenant",
      "8 annonce(s) disponible(s), 2 disparue(s), 1 non confirmée(s), 1 groupe(s) de doublons",
    ]);
    const rows = adminErrorRows([{ at: NOW, sourceCode: "demo_a", sourceName: "Annonces Démo A", code: "connector_error" }]);
    assert.equal(rows[0].text, "Annonces Démo A · Panne de la source");
    assert.match(rows[0].dateText, /^\d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/);
  });

  test("lecture seule : la page dit qu'aucune activation n'existe et que seules des sources fictives existent", () => {
    assert.equal(ADMIN_COLLECTION_TITLE, "Collecte externe");
    assert.match(ADMIN_COLLECTION_NOTE, /Lecture seule/);
    assert.match(ADMIN_COLLECTION_NOTE, /FICTIVES/);
    assert.match(ADMIN_COLLECTION_NOTE, /robots\.txt/);
  });
});
