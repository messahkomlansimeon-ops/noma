import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";
import { COMING_SOON_LABEL, ComingSoon } from "../../components/coming-soon";
import { RoleSwitcher, roleOfPath } from "../../components/role-switcher";

/** Lot D1 : « Bientôt disponible », sélecteur d'espace sans chevauchement, et plus aucune donnée factice affichée nulle part (lecture du code source). */

const ROOT = join(import.meta.dirname, "../..");

function sources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("composant « Bientôt disponible »", () => {
  test("titre, phrase simple, bouton de retour ; aucune donnée d'exemple", () => {
    const html = renderToString(<ComingSoon title="Mes favoris" sentence="Garder des annonces de côté arrive bientôt." backHref="/alertes" backLabel="Mes besoins" />);
    assert.ok(html.includes(COMING_SOON_LABEL));
    assert.equal(COMING_SOON_LABEL, "Bientôt disponible");
    assert.match(html, /Mes favoris/);
    assert.match(html, /Garder des annonces de côté arrive bientôt\./);
    assert.match(html, /href="\/alertes"/);
    assert.match(html, /Mes besoins/);
    assert.match(html, /data-coming-soon/);
  });

  test("toutes les pages qui ne sont pas branchées sur le serveur utilisent ce composant (et rien d'autre)", () => {
    const pages = [
      "app/(buyer)/comparer/page.tsx", "app/(buyer)/partager/page.tsx", "app/(buyer)/propositions/page.tsx", "app/(buyer)/signaler/page.tsx",
      "app/(buyer)/offre/[id]/page.tsx", "app/(buyer)/offre/[id]/inviter/page.tsx", "app/(buyer)/favoris/page.tsx", "app/(buyer)/messages/page.tsx",
      "app/(buyer)/messages/[id]/page.tsx", "app/(buyer)/commandes/page.tsx", "app/(buyer)/commandes/[id]/page.tsx",
      "app/(vendor)/vendeur/demandes/page.tsx", "app/(vendor)/vendeur/demandes/[id]/page.tsx", "app/(vendor)/vendeur/devis/nouveau/page.tsx",
      "app/(vendor)/vendeur/commandes/page.tsx", "app/(vendor)/vendeur/commandes/[id]/page.tsx",
      "app/(admin)/admin/page.tsx", "app/(admin)/admin/dossiers/page.tsx", "app/(admin)/admin/dossiers/[id]/page.tsx", "app/(admin)/admin/vendeurs/page.tsx", "app/(admin)/admin/reglages/page.tsx",
    ];
    for (const page of pages) {
      const source = read(page);
      assert.match(source, /<ComingSoon\b/, page);
      assert.ok(!/useNoma|lib\/data|useState|useEffect/.test(source), `${page} : aucune donnée ni état`);
      assert.ok(source.split("\n").length < 20, `${page} : une page « Bientôt disponible » reste minuscule`);
    }
  });
});

describe("sélecteur d'espace : dans le flot de la page, jamais superposé", () => {
  test("trois liens Acheteur, Vendeur, Admin ; l'espace courant est marqué ; aucune position fixe ou absolue", () => {
    const html = renderToString(<RoleSwitcher />);
    for (const label of ["Acheteur", "Vendeur", "Admin"]) assert.match(html, new RegExp(label));
    assert.match(html, /data-role-switcher/);
    assert.equal(/\b(fixed|absolute|sticky)\b/.test(html), false, "le bouton ne recouvre ni titre ni bouton");
    assert.match(html, /href="\/vendeur"/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /aria-current="page"[^>]*>Acheteur|Acheteur<\/a>/);
  });

  test("l'espace se déduit de l'adresse", () => {
    assert.equal(roleOfPath("/"), "buyer");
    assert.equal(roleOfPath("/alertes"), "buyer");
    assert.equal(roleOfPath("/vendeur"), "vendor");
    assert.equal(roleOfPath("/vendeur/annonces/x"), "vendor");
    assert.equal(roleOfPath("/vendeurs-fantaisie"), "buyer");
    assert.equal(roleOfPath("/admin"), "admin");
    assert.equal(roleOfPath("/admin/dossiers"), "admin");
    assert.equal(roleOfPath(null), "buyer");
  });

  test("il est monté dans les trois espaces (en tête, dans le flot) et plus à la racine (où il flottait sur les pages)", () => {
    for (const layout of ["app/(buyer)/layout.tsx", "app/(vendor)/layout.tsx", "app/(admin)/layout.tsx"]) {
      const source = read(layout);
      assert.match(source, /<RoleSwitcher \/>/, layout);
      assert.ok(source.indexOf("<RoleSwitcher />") < source.indexOf("{children}"), `${layout} : avant le contenu`);
    }
    assert.equal(read("app/layout.tsx").includes("RoleSwitcher"), false);
    assert.equal(/fixed|absolute/.test(read("components/role-switcher.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), false);
  });
});

describe("plus aucune donnée factice affichée (lot D1)", () => {
  test("aucune page ni aucun composant n'importe `@/lib/data` ni ne lit les champs factices du store", () => {
    const fake = /\b(featuredOffers|offersSeed|threadsSeed|ordersSeed|proposalsSeed|casesSeed|vendorOrdersSeed|alertsSeed|quoteSeed)\b/;
    const fakeStore = /useNoma\(\(s\) => s\.(favorites|threads|orders|proposals|cases|vendorOrders|quoteLines|alerts|compare|need)\b/;
    const offenders: string[] = [];
    for (const file of [...sources("app"), ...sources("components")]) {
      const source = read(file);
      if (/from "@\/lib\/data"|lib\/data"/.test(source) || fake.test(source) || fakeStore.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test("l'accueil de l'acheteur et le tableau de bord du vendeur lisent le serveur (api.home) et n'affichent aucun texte d'exemple", () => {
    const buyer = read("app/(buyer)/page.tsx");
    const vendor = read("app/(vendor)/vendeur/page.tsx");
    assert.match(buyer, /api\.home\.buyer/);
    assert.match(vendor, /api\.home\.vendor/);
    for (const [name, source] of [["accueil", buyer], ["tableau de bord", vendor]] as const) {
      assert.ok(!/Marcory Mobile|iPhone 12 · 128 Go|Cocody · 150 000|D-104|NM-024|Produits phares|featuredOffers/.test(source), `${name} : aucun texte d'exemple`);
    }
    assert.match(buyer, /Décrire un besoin|DESCRIBE_NEED_LABEL/);
    assert.match(buyer, /LOGIN_LABEL/);
  });

  test("la recherche sur d'autres sites porte la mention « (démonstration) » et n'offre plus de comparaison ni de fiche factice", () => {
    const search = read("app/(buyer)/recherche/page.tsx");
    assert.match(search, /Recherche sur d&apos;autres sites \(démonstration\)/);
    assert.equal(/\/comparer|toggleCompare|useNoma/.test(search), false);
    assert.equal(/\/offre\//.test(read("components/real-offer-card.tsx")), false);
    assert.match(read("lib/client/home-view.ts"), /Recherche sur d'autres sites \(démonstration\)/);
  });

  test("le compte n'affiche plus d'identité ni de pastilles d'exemple", () => {
    const account = read("app/(buyer)/compte/page.tsx");
    assert.ok(!/Alex O\.|badge=\{2\}|badge=\{3\}|\+225 07 ••/.test(account));
    const profile = read("app/(vendor)/vendeur/profil/page.tsx");
    assert.ok(!/Marcory Mobile|\+225 07 ••|Prototype/.test(profile));
  });
});
