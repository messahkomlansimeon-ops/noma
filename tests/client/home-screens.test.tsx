import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";
import { COMING_SOON_LABEL, ComingSoon } from "../../components/coming-soon";
import NotFound from "../../app/not-found";
import { AdminNotFound } from "../../components/admin/admin-page";
import { APP_TITLE } from "../../lib/site";
import { RoleSwitcher, roleOfPath, roleTabs } from "../../components/role-switcher";
import { createCoalescedRead } from "../../lib/client/session";

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
    // Lot D2 : favoris, messages, commandes (acheteur et vendeur), administration (tableau de bord, vendeurs, réglages) sont branchés sur le serveur ; il reste « Bientôt disponible » ici.
    const pages = [
      "app/(buyer)/comparer/page.tsx", "app/(buyer)/partager/page.tsx", "app/(buyer)/propositions/page.tsx", "app/(buyer)/signaler/page.tsx",
      "app/(buyer)/offre/[id]/page.tsx", "app/(buyer)/offre/[id]/inviter/page.tsx",
      "app/(vendor)/vendeur/demandes/page.tsx", "app/(vendor)/vendeur/demandes/[id]/page.tsx", "app/(vendor)/vendeur/devis/nouveau/page.tsx",
      "app/(admin)/admin/dossiers/page.tsx", "app/(admin)/admin/dossiers/[id]/page.tsx",
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
  test("liens Acheteur et Vendeur ; l'espace courant est marqué ; aucune position fixe ou absolue ; AUCUN onglet Admin tant que la session n'a pas dit « administrateur » (lot D3)", () => {
    const html = renderToString(<RoleSwitcher />);
    for (const label of ["Acheteur", "Vendeur"]) assert.match(html, new RegExp(label));
    assert.equal(/Admin/.test(html), false, "le rendu initial (et celui d'un visiteur ou d'un compte ordinaire) ne porte pas l'onglet Admin");
    assert.equal(html.includes('href="/admin"'), false);
    assert.match(html, /data-role-switcher/);
    assert.equal(/\b(fixed|absolute|sticky)\b/.test(html), false, "le bouton ne recouvre ni titre ni bouton");
    assert.match(html, /href="\/vendeur"/);
    assert.match(html, /aria-current="page"[^>]*>Acheteur|Acheteur<\/a>/);
  });

  test("onglets : Admin seulement pour un administrateur ; l'ordre est Acheteur, Vendeur, Admin", () => {
    assert.deepEqual(roleTabs(false).map((tab) => tab.role), ["buyer", "vendor"]);
    assert.deepEqual(roleTabs(true).map((tab) => [tab.role, tab.href]), [["buyer", "/"], ["vendor", "/vendeur"], ["admin", "/admin"]]);
    assert.equal(roleTabs(false).some((tab) => tab.label === "Admin" || tab.href === "/admin"), false);
  });

  test("le sélecteur lit la session partagée (isAdmin) ; il n'affiche jamais l'onglet sur la foi d'un autre signal", () => {
    const source = read("components/role-switcher.tsx");
    assert.match(source, /readSharedSession\(\)/);
    assert.match(source, /outcome\.kind === "authenticated" && outcome\.isAdmin === true/);
    assert.equal(/localStorage|sessionStorage|document\.cookie/.test(source), false, "aucun drapeau stocké dans le navigateur");
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

describe("administration : page 404 standard pour un non-administrateur (lot D3)", () => {
  test("AdminNotFound lève le notFound() de Next (jamais un titre « Administration » ni « Page introuvable. » écrit à la main)", () => {
    assert.throws(() => renderToString(<AdminNotFound />), (error: unknown) => (error as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    const page = read("components/admin/admin-page.tsx");
    assert.match(page, /state\.kind === "not-found" \? \(\s*<AdminNotFound \/>/);
    assert.equal(page.includes("ADMIN_NOT_FOUND"), false, "plus de texte « Page introuvable. » dans le composant");
    assert.equal(page.includes('data-testid="admin-not-found"'), false);
  });

  test("lot D3-bis : UNE seule page 404 (app/not-found.tsx) pour une adresse inconnue et un espace refusé ; son titre est celui de l'application", () => {
    const html = renderToString(<NotFound />);
    assert.match(html, /404/);
    assert.match(html, /This page could not be found\./);
    assert.ok(html.includes(`<title>${APP_TITLE}</title>`), "le titre de la page 404 est celui de l'application");
    assert.equal(APP_TITLE, "noma · Votre recherche, simplifiée");
    assert.equal(/Administration|Page introuvable/.test(html), false);
    assert.match(read("app/layout.tsx"), /default: APP_TITLE/, "le gabarit racine utilise la même constante");
    assert.equal(read("app/not-found.tsx").includes("RoleSwitcher"), false);
  });

  test("le gabarit de l'espace d'administration appelle la garde AVANT d'afficher quoi que ce soit", () => {
    const layout = read("app/(admin)/layout.tsx");
    assert.match(layout, /await requireAdminSpace\(\)/);
    assert.ok(layout.indexOf("await requireAdminSpace()") < layout.indexOf("<RoleSwitcher />"), "la garde précède le sélecteur et les pages");
    assert.match(read("lib/server/admin/space-guard.ts"), /notFound: \(\) => notFound\(\)/);
    assert.match(read("lib/server/admin/space-decision.ts"), /session\.isAdmin === true \? "show" : "not_found"/);
  });
});

describe("lecture de session partagée (lot D3)", () => {
  test("des lectures simultanées partagent UNE requête ; la lecture suivante repart de zéro (aucune session périmée)", async () => {
    let calls = 0;
    let release: (value: number) => void = () => undefined;
    const read = createCoalescedRead(() => new Promise<number>((resolve) => { calls += 1; release = resolve; }));
    const first = read();
    const second = read();
    assert.equal(first, second, "la même promesse");
    assert.equal(calls, 1);
    release(7);
    assert.deepEqual(await Promise.all([first, second]), [7, 7]);
    const third = read();
    assert.equal(calls, 2, "après la réponse, une nouvelle lecture refait la requête");
    release(8);
    assert.equal(await third, 8);
  });

  test("un échec ne reste pas en mémoire : la lecture suivante réessaie", async () => {
    let calls = 0;
    const read = createCoalescedRead(async () => {
      calls += 1;
      if (calls === 1) throw new Error("panne");
      return "ok";
    });
    await assert.rejects(read(), /panne/);
    assert.equal(await read(), "ok");
    assert.equal(calls, 2);
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
