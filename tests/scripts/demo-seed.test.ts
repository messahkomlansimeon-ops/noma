import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { looksLikePhoneNumber } from "../../lib/phone-text";
import { requireNoPhoneInOfferFields } from "../../lib/server/catalog/validation";
import { roundCount } from "../../lib/server/metrics/privacy";
import { NOTIFICATION_CAP_LOCK_NAMESPACE, NOTIFICATION_USER_LOCK_NAMESPACE } from "../../lib/server/notifications/config";
import {
  DEMO_ADMIN_PHONE,
  DEMO_BUYER_DEMANDS,
  DEMO_BUYER_PHONE,
  DEMO_CONTACTERS,
  DEMO_EXTRA_BUYER_COUNT,
  DEMO_OFFERS,
  DEMO_OPENERS,
  DEMO_SEED_LOCK_NAMESPACE,
  DEMO_VENDOR_CREDIT_XOF,
  DEMO_VENDOR_PHONE,
  checkDemoSeedEnvironment,
  demandRawText,
  demoAccountId,
  demoExtraBuyerPhone,
  demoMarker,
  demoVendorPhone,
  extraBuyerDemand,
  offerRawText,
  vendorPhoneOf,
} from "../../scripts/demo-seed-plan";

/**
 * `npm run demo:seed` (lot D1) : partie PURE (marché de démonstration, comptes aux numéros fixes, garde de base) et refus en processus enfant. Aucune base n'est ouverte ici.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/demo-seed.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../../poc/node_modules/tsx/dist/loader.mjs", import.meta.url));
const GOOD_URL = "postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai";
const QUARTIERS = new Set(["Cocody", "Marcory", "Yopougon", "Plateau", "Treichville", "Riviera", "Angré", "Koumassi", "Adjamé"]);

describe("comptes de démonstration : numéros FIXES et documentés", () => {
  test("acheteur +225 07 00 00 01 01, vendeur +225 07 00 00 02 02, admin +225 07 00 00 03 03", () => {
    assert.equal(DEMO_BUYER_PHONE, "+2250700000101");
    assert.equal(DEMO_VENDOR_PHONE, "+2250700000202");
    assert.equal(DEMO_ADMIN_PHONE, "+2250700000303");
  });

  test("identifiants stables, distincts, et numéros des vendeurs et acheteurs fictifs dans des blocs à part", () => {
    assert.equal(demoAccountId(DEMO_BUYER_PHONE), demoAccountId(DEMO_BUYER_PHONE));
    const ids = new Set([DEMO_BUYER_PHONE, DEMO_VENDOR_PHONE, DEMO_ADMIN_PHONE, ...Array.from({ length: 7 }, (_, i) => demoVendorPhone(i + 1)), ...Array.from({ length: DEMO_EXTRA_BUYER_COUNT }, (_, i) => demoExtraBuyerPhone(i + 1))].map(demoAccountId));
    assert.equal(ids.size, 3 + 7 + DEMO_EXTRA_BUYER_COUNT);
    assert.match(demoAccountId(DEMO_BUYER_PHONE), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(demoVendorPhone(1), "+2250788888801");
    assert.equal(demoExtraBuyerPhone(11), "+2250766666611");
    assert.equal(vendorPhoneOf(0), DEMO_VENDOR_PHONE);
    assert.equal(vendorPhoneOf(3), demoVendorPhone(3));
    assert.throws(() => demoVendorPhone(0), RangeError);
    assert.throws(() => demoVendorPhone(8), RangeError);
    assert.throws(() => demoExtraBuyerPhone(DEMO_EXTRA_BUYER_COUNT + 1), RangeError);
    assert.throws(() => extraBuyerDemand(0), RangeError);
  });
});

describe("marché de démonstration", () => {
  test("30 annonces, 8 vendeurs (le vendeur démo en a 4, dont une seule boostée), 4 catégories, clés uniques", () => {
    assert.equal(DEMO_OFFERS.length, 30);
    assert.equal(new Set(DEMO_OFFERS.map((offer) => offer.key)).size, 30);
    assert.equal(new Set(DEMO_OFFERS.map((offer) => offer.vendor)).size, 8);
    assert.deepEqual([...new Set(DEMO_OFFERS.map((offer) => offer.category))].sort(), ["Climatisation", "Maison et meubles", "Téléphones", "Électronique"].sort());
    const demo = DEMO_OFFERS.filter((offer) => offer.vendor === 0);
    assert.equal(demo.length, 4);
    assert.equal(demo.filter((offer) => offer.boosted === true).length, 1);
    assert.equal(DEMO_OFFERS.filter((offer) => offer.boosted === true).length, 1);
    assert.equal(demo.find((offer) => offer.boosted)?.model, "iPhone 12");
    assert.equal(DEMO_OFFERS.filter((offer) => offer.afterDemands === true).length, 3, "trois annonces publiées APRÈS les besoins : trois notifications");
  });

  test("prix réalistes en francs CFA, quartiers d'Abidjan, états usuels, aucun numéro de téléphone dans aucun champ", () => {
    for (const offer of DEMO_OFFERS) {
      assert.ok(offer.priceXof >= 20_000 && offer.priceXof <= 600_000, `${offer.key} : prix ${offer.priceXof}`);
      assert.equal(offer.priceXof % 1_000, 0, `${offer.key} : prix arrondi au millier`);
      assert.ok(QUARTIERS.has(offer.location), `${offer.key} : quartier ${offer.location} connu du moteur (Abidjan)`);
      assert.ok(["Neuf", "Occasion", "Reconditionné"].includes(offer.condition));
      const fields = [offer.title, offer.description, offer.brand, offer.model, offer.variant ?? "", offer.location, JSON.stringify(offer.attributes)];
      for (const field of fields) assert.equal(looksLikePhoneNumber(field), false, `${offer.key} : « ${field} »`);
      // Aucune annonce de démonstration n'est refusée par la règle de publication (variante, marque, modèle, attributs…).
      assert.doesNotThrow(() => requireNoPhoneInOfferFields({ category: offer.category, brand: offer.brand, model: offer.model, variant: offer.variant, condition: offer.condition, location: offer.location, attributes: offer.attributes as never }), offer.key);
      assert.ok(offer.title.length >= 10 && offer.title.length <= 80);
    }
  });

  test("assez d'iPhone 12 AVANT les besoins pour qu'un boost fasse monter l'annonce (7 offres au moins) ; chaque besoin de l'acheteur démo a ses annonces", () => {
    const before = DEMO_OFFERS.filter((offer) => offer.afterDemands !== true);
    const matching = (brand: string, model: string, list = before) => list.filter((offer) => offer.brand === brand && offer.model === model);
    assert.ok(matching("Apple", "iPhone 12").length >= 8);
    assert.equal(DEMO_BUYER_DEMANDS.length, 3);
    for (const demand of DEMO_BUYER_DEMANDS) {
      const offers = matching(demand.brand, demand.model);
      assert.ok(offers.length >= 3, `${demand.key} : ${offers.length} annonce(s)`);
      assert.ok(offers.every((offer) => offer.category === demand.category && offer.priceXof <= demand.budgetXof), `${demand.key} : budget et catégorie compatibles`);
      // Une annonce publiée après les besoins existe pour chaque besoin : une notification chacun.
      assert.equal(DEMO_OFFERS.filter((offer) => offer.afterDemands === true && offer.brand === demand.brand && offer.model === demand.model).length, 1, demand.key);
    }
  });

  test("ouvertures et contacts fictifs : « environ 10 » ouvreurs, « environ 5 » contacts (jamais un compte exact)", () => {
    assert.ok(DEMO_OPENERS + DEMO_CONTACTERS >= 10);
    assert.deepEqual(roundCount(DEMO_OPENERS), { kind: "approx", value: 10 });
    assert.deepEqual(roundCount(DEMO_CONTACTERS), { kind: "approx", value: 5 });
    assert.ok(DEMO_OPENERS <= DEMO_EXTRA_BUYER_COUNT);
    assert.deepEqual(roundCount(DEMO_EXTRA_BUYER_COUNT + 1), { kind: "approx", value: 10 }, "avec l'acheteur démo : « environ 10 » besoins correspondants pour l'annonce du vendeur démo");
    for (let index = 1; index <= DEMO_EXTRA_BUYER_COUNT; index += 1) {
      const demand = extraBuyerDemand(index);
      const boosted = DEMO_OFFERS.find((offer) => offer.boosted === true);
      assert.ok(boosted && demand.budgetXof >= boosted.priceXof, `acheteur fictif ${index} : son budget couvre l'annonce du vendeur démo`);
      assert.equal(demand.model, boosted.model);
    }
    assert.ok(DEMO_VENDOR_CREDIT_XOF >= 10_000);
  });

  test("repères d'idempotence : un par annonce et par besoin, présents dans le texte brut, jamais dans le titre", () => {
    const markers = new Set<string>();
    for (const offer of DEMO_OFFERS) {
      const marker = demoMarker(offer.key);
      assert.ok(offerRawText(offer).includes(marker));
      assert.equal(offerRawText(offer).split("\n")[0], offer.title);
      markers.add(marker);
    }
    for (const demand of [...DEMO_BUYER_DEMANDS, ...Array.from({ length: DEMO_EXTRA_BUYER_COUNT }, (_, i) => extraBuyerDemand(i + 1))]) {
      assert.ok(demandRawText(demand).includes(demoMarker(demand.key)));
      assert.equal(demandRawText(demand).split("\n")[0], demand.title);
      markers.add(demoMarker(demand.key));
    }
    assert.equal(markers.size, 30 + 3 + DEMO_EXTRA_BUYER_COUNT);
  });
});

describe("garde de base : les mêmes que dev:seed (base d'essai de CE poste seulement)", () => {
  test("acceptées : noma_essai, noma_e2e, noma_essai_*", () => {
    for (const name of ["noma_essai", "noma_e2e", "noma_essai_d1"]) {
      const result = checkDemoSeedEnvironment({ DATABASE_URL: GOOD_URL.replace("noma_essai", name), NODE_ENV: "development" });
      assert.deepEqual(result, { ok: true, databaseName: name });
    }
    assert.equal(checkDemoSeedEnvironment({ DATABASE_URL: GOOD_URL }).ok, true, "NODE_ENV absent");
  });

  test("refusées, avec un motif qui parle de demo:seed et jamais de l'adresse : noma_dev, noma_test, noma_prod, base distante, NODE_ENV, DATABASE_URL absente", () => {
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ["noma_dev", { DATABASE_URL: GOOD_URL.replace("noma_essai", "noma_dev") }],
      ["noma_test", { DATABASE_URL: GOOD_URL.replace("noma_essai", "noma_test") }],
      ["noma_prod", { DATABASE_URL: GOOD_URL.replace("noma_essai", "noma_prod") }],
      ["noma_essai_MAJ", { DATABASE_URL: GOOD_URL.replace("noma_essai", "noma_essai_MAJ") }],
      ["base distante", { DATABASE_URL: "postgresql://u:secret@db.example.com:5432/noma_essai" }],
      ["NODE_ENV production", { DATABASE_URL: GOOD_URL, NODE_ENV: "production" }],
      ["NODE_ENV test", { DATABASE_URL: GOOD_URL, NODE_ENV: "test" }],
      ["DATABASE_URL absente", {}],
      ["DATABASE_URL vide", { DATABASE_URL: "  " }],
    ];
    for (const [name, env] of cases) {
      const result = checkDemoSeedEnvironment(env);
      assert.equal(result.ok, false, name);
      if (!result.ok) {
        assert.ok(!/dev:seed/.test(result.reason), `${name} : le motif parle de demo:seed (${result.reason})`);
        assert.ok(!result.reason.includes("secret") && !result.reason.includes("db.example.com"), `${name} : jamais l'adresse`);
      }
    }
  });
});

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "--conditions=react-server", ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("refus en processus enfant : avant toute connexion", () => {
  const DEAD = "postgresql://noma_local:x@127.0.0.1:1/noma_essai";
  test("NODE_ENV=production, base noma_dev, base distante et option inconnue : code 1, motif lisible, aucune connexion tentée", async () => {
    const production = await run([], { NODE_ENV: "production", DATABASE_URL: DEAD });
    assert.equal(production.code, 1);
    assert.match(production.output, /demo:seed : refus — NODE_ENV vaut « production »/);
    const dev = await run([], { NODE_ENV: "development", DATABASE_URL: DEAD.replace("noma_essai", "noma_dev") });
    assert.equal(dev.code, 1);
    assert.match(dev.output, /demo:seed : refus — demo:seed ne peuple que les bases d'essai noma_essai, noma_e2e et noma_essai_\*/);
    const remote = await run([], { NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@db.example.com:5432/noma_essai" });
    assert.equal(remote.code, 1);
    assert.match(remote.output, /demo:seed : refus/);
    const option = await run(["--force"], { NODE_ENV: "development", DATABASE_URL: DEAD });
    assert.equal(option.code, 1);
    assert.match(option.output, /aucune option n'existe/);
    for (const result of [production, dev, remote, option]) assert.ok(!/ECONNREFUSED|erreur inattendue/.test(result.output), `aucune connexion tentée : ${result.output}`);
  });
});

describe("verrou consultatif de demo:seed (lot D3)", () => {
  test("espace dédié : jamais celui des notifications, et aucun espace de verrou du dépôt n'est déclaré deux fois", () => {
    assert.equal(DEMO_SEED_LOCK_NAMESPACE, 1_314_664_960);
    assert.notEqual(DEMO_SEED_LOCK_NAMESPACE, NOTIFICATION_CAP_LOCK_NAMESPACE);
    assert.notEqual(DEMO_SEED_LOCK_NAMESPACE, NOTIFICATION_USER_LOCK_NAMESPACE);
    const root = join(import.meta.dirname, "../..");
    const declared = new Map<string, string[]>();
    const walk = (directory: string): void => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(join(root, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
          for (const match of text.matchAll(/\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*(1_?314_?664_?\d{3})\b/g)) {
            const value = match[2].replace(/_/g, "");
            declared.set(value, [...(declared.get(value) ?? []), `${path}:${match[1]}`]);
          }
        }
      }
    };
    for (const directory of ["lib", "scripts"]) walk(directory);
    assert.ok(declared.size >= 15, `${declared.size} espaces recensés`);
    const duplicates = [...declared].filter(([, owners]) => owners.length > 1);
    assert.deepEqual(duplicates, [], "aucun espace de verrou n'est partagé");
    assert.deepEqual(declared.get("1314664960"), ["scripts/demo-seed-plan.ts:DEMO_SEED_LOCK_NAMESPACE"]);
  });
});
