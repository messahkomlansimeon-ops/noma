import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Lot FIN1 : branchements d'écrans que les essais de fonctions pures ne voient pas (les parcours de bout en bout les vérifient dans un navigateur ; ces essais les gardent à bas coût, sans
 * navigateur, pour qu'un retour en arrière échoue tout de suite). Chaque essai lit le SOURCE de l'écran concerné.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("mission : fiche et besoin porteur", () => {
  test("« Voir l'annonce » d'une ligne de la proposition porte la mission ; la fiche en fait sa flèche retour et son lien d'erreur", () => {
    const proposal = source("components/missions/proposal-section.tsx");
    assert.match(proposal, /href=\{missionListingPath\(mission\.id, demandId, line\.offerId\)\}/);
    assert.match(proposal, /orderedProposalLines\(proposal\.lines\)\.map\(/, "les lignes s'affichent par numéro de vendeur croissant (stable)");
    assert.equal(/href=\{`\/besoins\/\$\{demandId\}\/offres\/\$\{line\.offerId\}`\}/.test(proposal), false, "plus de lien nu vers la fiche (retour vers le besoin porteur)");
    const fiche = source("app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx");
    assert.match(fiche, /missionFromSearch\(search\.get\("mission"\)\)/);
    assert.match(fiche, /const back = missionId !== null \? `\/missions\/\$\{missionId\}`/);
    assert.match(fiche, /<TopBar back=\{back\} title="Annonce" \/>/);
    assert.match(fiche, /<Suspense fallback=\{null\}>/, "useSearchParams exige une frontière Suspense");
  });

  test("le besoin PORTEUR d'une mission n'affiche jamais le suivi (Prolonger, Pause, Reprendre) ni la recherche active : une note renvoie à la mission", () => {
    const page = source("app/(buyer)/besoins/[id]/page.tsx");
    assert.match(page, /missions\.list\(null/);
    assert.match(page, /mission\.demandId === demandId/);
    assert.match(page, /carrier === null && demand\.status === "active" \? <TrackingPanel/);
    assert.equal((page.match(/carrier === null \? activeSearchCard : null/g) ?? []).length, 2, "la carte est écartée du besoin porteur aux deux emplacements");
    assert.match(page, /data-testid="mission-carrier-note"/);
  });
});

describe("page d'un besoin : la carte « Recherche active » vient APRÈS les résultats", () => {
  test("dans la page, la première annonce (liste des résultats) précède la carte ; la carte est rendue deux fois seulement (besoin non actif, puis après les résultats)", () => {
    const page = source("app/(buyer)/besoins/[id]/page.tsx");
    const results = page.indexOf("<BuyerMatchCard");
    const card = page.lastIndexOf("carrier === null ? activeSearchCard : null");
    const external = page.indexOf("<ExternalSection");
    assert.ok(results > 0 && card > results, "la carte est après la liste des résultats");
    assert.ok(card < external, "et avant la section « Sur d'autres sites »");
    assert.equal((page.match(/\{carrier === null \? activeSearchCard : null\}/g) ?? []).length, 2);
    assert.equal(page.indexOf("<ActiveSearchCard"), page.lastIndexOf("<ActiveSearchCard"), "un seul endroit construit la carte");
    const built = page.indexOf("const activeSearchCard");
    assert.ok(built > 0 && built < results, "construite une fois, avant le rendu des résultats : placée ensuite par `{activeSearchCard}`");
  });
});

describe("fiche : « Je l'ai acheté » laisse la place à « Achat confirmé »", () => {
  test("les actions de la fiche lisent les commandes de l'acheteur et ne montrent le bouton que sans commande active", () => {
    const actions = source("components/social/offer-actions.tsx");
    assert.match(actions, /social\.orders\.list\("buyer"/);
    assert.match(actions, /offerOrderBanner\(orders, demandId, offerId\)/);
    assert.match(actions, /\) : \(\s*<DeclareOrder demandId=\{demandId\} offerId=\{offerId\} \/>\s*\)\}/);
    assert.match(actions, /data-testid="offer-order-banner"/);
  });
});

describe("textes et écrans corrigés", () => {
  test("titres dits une seule fois : plus de title= dans la barre du haut des pages qui ont un h1 identique", () => {
    for (const file of ["app/(buyer)/favoris/page.tsx", "components/conversations-list.tsx", "components/missions/missions-list.tsx", "components/missions/mission-form.tsx", "components/orders/orders-list.tsx"]) {
      const text = source(file);
      assert.match(text, /<TopBar back=\{?[^>]*\/>/, file);
      assert.equal(/<TopBar [^>]*title=/.test(text), false, `${file} : titre dit deux fois (barre du haut et h1)`);
      assert.match(text, /<h1 /, file);
    }
  });

  test("formulaire de besoin : zone de texte et champs étiquetés, plus de « Valeur du texte »", () => {
    const form = source("components/need-form.tsx");
    assert.equal(form.includes("Valeur du texte"), false);
    assert.match(form, /<label htmlFor="need-text"/);
    assert.match(form, /<textarea\s+id="need-text"/);
    assert.match(form, /<label htmlFor="need-location"/);
    assert.match(form, /<label htmlFor="need-budget"/);
  });

  test("connexion : plus de « Conditions d'utilisation · Confidentialité » (deux mots qui ressemblaient à des liens sans page)", () => {
    const login = source("app/(auth)/connexion/page.tsx");
    assert.equal(/<span[^>]*>Conditions d'utilisation<\/span>/.test(login), false);
    assert.equal(/<span[^>]*>Confidentialité<\/span>/.test(login), false);
  });

  test("« noma » en minuscules dans les textes de l'interface", () => {
    for (const file of ["app/(buyer)/recherche/page.tsx", "app/(buyer)/compte/page.tsx", "lib/store.ts", "lib/data.ts"]) {
      const text = source(file);
      assert.equal(/[">`]\s*Noma\b|\bNoma a compris|vendeurs Noma|· Noma|sourceName: "Noma"/.test(text), false, file);
    }
  });

  test("porte-monnaie : l'espace vendeur a sa propre page (barre d'onglets du vendeur), les entrées du vendeur y mènent", () => {
    assert.ok(existsSync(join(ROOT, "app/(vendor)/vendeur/porte-monnaie/page.tsx")));
    assert.match(source("app/(vendor)/vendeur/porte-monnaie/page.tsx"), /<WalletPage space="vendor" \/>/);
    assert.match(source("app/(buyer)/compte/porte-monnaie/page.tsx"), /<WalletPage space="buyer" \/>/);
    assert.match(source("components/tab-bar.tsx"), /match: \["\/vendeur\/profil", "\/vendeur\/porte-monnaie"\]/);
    assert.match(source("app/(vendor)/vendeur/profil/page.tsx"), /walletHref\(\{ next: "\/vendeur\/profil" \}\)/);
  });

  test("administration : « Marché » sépare l'historique de démonstration ; vendeurs : référence courte affichée", () => {
    assert.match(source("app/(admin)/admin/marche/page.tsx"), /data-testid="admin-market-historical"/);
    assert.match(source("app/(admin)/admin/vendeurs/page.tsx"), /data-testid="vendor-ref"/);
    assert.match(source("app/(admin)/admin/vendeurs/page.tsx"), /confirmText\(confirming\.action, confirming\.phone, confirming\.ref\)/);
  });

  test("recherche rapide de démonstration : noms de sources lisibles et prix crédibles (plus « demo-rapide », « demo-lente », 900 000 FCFA)", () => {
    const fake = source("lib/server/fake-sources.ts");
    assert.match(fake, /FAKE_FAST_SOURCE_NAME = "Annonces Abidjan \(démo\)"/);
    assert.match(fake, /FAKE_SLOW_SOURCE_NAME = "Marché Cocody \(démo\)"/);
    assert.equal(/name: "demo-/.test(fake), false);
    assert.equal(fake.includes("900_000"), false);
  });
});
