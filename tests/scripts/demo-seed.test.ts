import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { looksLikePhoneNumber } from "../../lib/phone-text";
import { requireNoPhoneInOfferFields } from "../../lib/server/catalog/validation";
import { MARKET_TREND_MIN_SELLERS } from "../../lib/server/market/config";
import { computeMarketStats, type MarketObservation } from "../../lib/server/market/stats";
import { roundCount } from "../../lib/server/metrics/privacy";
import { NOTIFICATION_CAP_LOCK_NAMESPACE, NOTIFICATION_USER_LOCK_NAMESPACE } from "../../lib/server/notifications/config";
import {
  DEMO_ADMIN_PHONE,
  DEMO_BUYER_DEMANDS,
  DEMO_BUYER_PHONE,
  DEMO_CONTACTERS,
  DEMO_EXTRA_BUYER_COUNT,
  DEMO_HISTORY_SELLER_COUNT,
  DEMO_OFFERS,
  DEMO_OPENERS,
  DEMO_SEED_LOCK_NAMESPACE,
  DEMO_VENDOR_CREDIT_XOF,
  DEMO_VENDOR_PHONE,
  checkDemoSeedEnvironment,
  demandRawText,
  demoAccountId,
  demoExtraBuyerPhone,
  demoHistorySellerPhone,
  demoMarker,
  demoVendorPhone,
  extraBuyerDemand,
  offerRawText,
  vendorPhoneOf,
} from "../../scripts/demo-seed-plan";

import {
  DEMO_MARKET_FICTIVE_SELLERS,
  DEMO_MARKET_HISTORY_DAYS,
  DEMO_MARKET_LISTING_SELLERS,
  DEMO_MARKET_NICHE_SLOTS,
  DEMO_MARKET_POPULAR_SLOTS,
  addDaysToIndex,
  buildDemoMarketHistory,
  dayIndexOf,
  dayOfIndex,
  demoMarketGroups,
  marketSellerId,
  type DemoMarketRow,
} from "../../scripts/demo-market-plan";

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
    // Plage réservée à la collecte externe (lot EXT1) : 981 (analyse par empreinte) et 982 (regroupement entre sources), déclarés une seule fois, dans la configuration du lot.
    assert.deepEqual(declared.get("1314664981"), ["lib/server/external/config.ts:EXTERNAL_ANALYSIS_LOCK_NAMESPACE"]);
    assert.deepEqual(declared.get("1314664982"), ["lib/server/external/config.ts:EXTERNAL_GROUP_LOCK_NAMESPACE"]);
    // La liste de scripts/demo-seed-plan.ts les mentionne (elle est la référence documentaire des espaces utilisés).
    const plan = readFileSync(join(root, "scripts/demo-seed-plan.ts"), "utf8");
    assert.match(plan, /981 et 982 \(collecte externe/);
  });
});

// ═════════════ lot H1 : historique de prix synthétique ═════════════

describe("historique de prix synthétique (pur, déterministe)", () => {
  const TODAY = "2026-10-07";
  const rows = buildDemoMarketHistory(TODAY);
  const key = (row: DemoMarketRow) => `${row.source}|${row.referenceId}|${row.day}`;

  test("un produit par clé (catégorie, marque, modèle, variante, état) des annonces de démonstration, avec un libellé au format de la base", () => {
    const groups = demoMarketGroups();
    const keys = new Set(DEMO_OFFERS.map((offer) => [offer.category, offer.brand, offer.model, offer.variant ?? "", offer.condition].join("|")));
    assert.equal(groups.length, keys.size);
    assert.deepEqual(groups.map((group) => group.key), [...keys].sort((a, b) => a.localeCompare(b)));
    const iphone = groups.find((group) => group.model === "iPhone 12" && group.variant === "128 Go" && group.condition === "Occasion");
    assert.ok(iphone);
    assert.equal(iphone.label, "Apple iPhone 12 · 128 Go · Occasion");
    assert.equal(iphone.listingSlots, DEMO_MARKET_POPULAR_SLOTS, "une annonce fictive en parallèle par vendeur fictif (24), pour une tendance hebdomadaire (20 vendeurs par semaine au moins)");
    assert.equal(DEMO_MARKET_POPULAR_SLOTS, 24);
    assert.ok(DEMO_MARKET_POPULAR_SLOTS >= MARKET_TREND_MIN_SELLERS + 2, "de la marge au-dessus du minimum d'un point de tendance");
    assert.equal(iphone.salesPerDay, 1);
    for (const group of groups) {
      assert.ok(group.basePriceXof > 0 && group.listingSlots >= 6 && group.salesPerDay > 0 && group.salesPerDay <= 1, group.key);
      assert.equal(looksLikePhoneNumber(group.label), false, group.label);
    }
  });

  test("89 jours AVANT aujourd'hui (aujourd'hui est relevé par les vraies annonces : 90 jours en tout), jamais un jour futur ni d'aujourd'hui", () => {
    const days = [...new Set(rows.map((row) => row.day))].sort();
    assert.equal(days.length, DEMO_MARKET_HISTORY_DAYS - 1);
    assert.equal(days[0], dayOfIndex(dayIndexOf(TODAY) - (DEMO_MARKET_HISTORY_DAYS - 1)));
    assert.equal(days.at(-1), dayOfIndex(dayIndexOf(TODAY) - 1));
    assert.ok(rows.every((row) => row.day < TODAY));
  });

  test("déterministe et idempotent : mêmes entrées, mêmes lignes ; un autre jour de lancement réécrit EXACTEMENT les mêmes lignes pour les jours communs ; aucun doublon (source, identifiant, jour)", () => {
    assert.deepEqual(buildDemoMarketHistory(TODAY), rows);
    const tomorrow = buildDemoMarketHistory(addDaysToIndex(TODAY, 1));
    const common = rows.filter((row) => row.day >= tomorrow[0].day);
    const sameDays = new Map(tomorrow.map((row) => [key(row), row]));
    assert.ok(common.length > 1_000);
    for (const row of common) assert.deepEqual(sameDays.get(key(row)), row, key(row));
    assert.equal(new Set(rows.map(key)).size, rows.length, "aucun doublon");
  });

  test("identifiants fictifs de forme UUID v4, distincts d'un produit à l'autre ; vendeurs 1 à 24 pour les annonces (1 à 7 pour les ventes), acheteurs 1 à 11 (ventes seulement) ; prix entiers, multiples de 500, de 1 à 100 000 000", () => {
    for (const row of rows) {
      assert.match(row.referenceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(row.sellerIndex >= 1 && row.sellerIndex <= (row.source === "sale" ? DEMO_MARKET_FICTIVE_SELLERS : DEMO_MARKET_LISTING_SELLERS), `vendeur ${row.sellerIndex}`);
      if (row.source === "sale") assert.ok(row.buyerIndex !== null && row.buyerIndex >= 1 && row.buyerIndex <= DEMO_EXTRA_BUYER_COUNT);
      else assert.equal(row.buyerIndex, null);
      assert.ok(Number.isSafeInteger(row.priceXof) && row.priceXof >= 500 && row.priceXof <= 100_000_000 && row.priceXof % 500 === 0, String(row.priceXof));
    }
    const references = new Map<string, string>();
    for (const row of rows) {
      const owner = references.get(`${row.source}|${row.referenceId}`);
      assert.ok(owner === undefined || owner === row.group.key, "un identifiant n'appartient qu'à un produit");
      references.set(`${row.source}|${row.referenceId}`, row.group.key);
    }
  });

  test("cohérence : les prix des annonces restent dans ±30 % de la base du produit et les ventes se concluent EN DESSOUS du prix demandé du jour (médiane)", () => {
    for (const group of demoMarketGroups()) {
      const listing = rows.filter((row) => row.group.key === group.key && row.source === "listing").map((row) => row.priceXof);
      const sale = rows.filter((row) => row.group.key === group.key && row.source === "sale").map((row) => row.priceXof);
      assert.ok(listing.length > 100 && sale.length > 20, `${group.key} : ${listing.length} relevés d'annonces, ${sale.length} ventes`);
      for (const price of [...listing, ...sale]) assert.ok(price >= group.basePriceXof * 0.7 && price <= group.basePriceXof * 1.3, `${group.key} : ${price}`);
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      assert.ok(median(sale) <= median(listing), `${group.key} : ventes sous les annonces`);
    }
  });

  test("le prix demandé baisse avec le temps (plus cher il y a 90 jours que la semaine dernière) pour le produit principal", () => {
    const iphone = rows.filter((row) => row.group.model === "iPhone 12" && row.group.variant === "128 Go" && row.group.condition === "Occasion" && row.source === "listing");
    const mean = (list: DemoMarketRow[]) => list.reduce((sum, row) => sum + row.priceXof, 0) / list.length;
    const oldest = iphone.filter((row) => row.day <= dayOfIndex(dayIndexOf(TODAY) - 70));
    const newest = iphone.filter((row) => row.day >= dayOfIndex(dayIndexOf(TODAY) - 14));
    assert.ok(oldest.length > 20 && newest.length > 20);
    assert.ok(mean(oldest) > mean(newest) * 1.02, `${mean(oldest)} contre ${mean(newest)}`);
  });

  test("les seuils de confidentialité sont atteints pour chaque produit sur 90 jours (annonces, clé exacte, fourchette) ; les produits les plus présents ont une courbe de tendance complète ; les ventes ne sont pas une statistique", () => {
    const observations = (group: string): MarketObservation[] =>
      rows.filter((row) => row.group.key === group && row.source === "listing").map((row) => ({
        referenceId: row.referenceId, sellerId: `v${row.sellerIndex}`, day: row.day, priceXof: row.priceXof, variantKey: (row.group.variant ?? "").toLowerCase(), conditionKey: row.group.condition.toLowerCase(),
      }));
    for (const group of demoMarketGroups()) {
      const stats = computeMarketStats(observations(group.key), {
        periodDays: 90, today: TODAY, variantKey: (group.variant ?? "").toLowerCase(), conditionKey: group.condition.toLowerCase(),
        display: { model: group.model, variant: group.variant, condition: group.condition },
      });
      assert.equal(stats.listings.status, "published", `${group.key} : annonces`);
      if (stats.listings.status !== "published") continue;
      assert.equal(stats.listings.comparedTo.scope, "exact", `${group.key} : sans élargissement`);
      // La fourchette exige 10 VENDEURS retenus : les produits très présents (18 vendeurs) l'ont toujours ; les autres (12 vendeurs) l'ont quand au plus deux sont écartés (prix atypiques).
      if (group.listingSlots === DEMO_MARKET_POPULAR_SLOTS) assert.notEqual(stats.listings.range, null, `${group.key} : au moins 10 vendeurs, donc une fourchette`);
    }
    const popular = demoMarketGroups().filter((group) => group.listingSlots === DEMO_MARKET_POPULAR_SLOTS);
    assert.ok(popular.length >= 2, "au moins deux produits très présents");
    for (const group of popular) {
      const stats = computeMarketStats(observations(group.key), { periodDays: 90, today: addDaysToIndex(TODAY, -1), variantKey: (group.variant ?? "").toLowerCase(), conditionKey: group.condition.toLowerCase(), display: { model: group.model, variant: group.variant, condition: group.condition } });
      if (stats.listings.status !== "published") throw new Error("non publié");
      assert.ok(stats.listings.trend.every((point) => point.median !== null), `${group.key} : toutes les semaines publiées`);
      const known = stats.listings.trend.map((point) => point.median as number);
      assert.ok(known[0] > known[known.length - 1], `${group.key} : tendance à la baisse`);
    }
  });

  test("H1-ter : quel que soit le jour de lancement (60 jours consécutifs, plus que le cycle de 36 jours), chaque produit publie sa médiane sur la clé exacte et les produits phares ont leurs 12 points de tendance et leur fourchette", () => {
    for (let offset = 0; offset < 60; offset += 1) {
      const day = addDaysToIndex(TODAY, offset);
      const history = buildDemoMarketHistory(day);
      for (const group of demoMarketGroups()) {
        const observations: MarketObservation[] = history.filter((row) => row.group.key === group.key && row.source === "listing").map((row) => ({
          referenceId: row.referenceId, sellerId: `v${row.sellerIndex}`, day: row.day, priceXof: row.priceXof, variantKey: (row.group.variant ?? "").toLowerCase(), conditionKey: row.group.condition.toLowerCase(),
        }));
        // Le jour de lancement lui-même est relevé par les vraies annonces : la fenêtre de 90 jours finit la veille ici (89 jours synthétiques).
        const stats = computeMarketStats(observations, {
          periodDays: 90, today: addDaysToIndex(day, -1), variantKey: (group.variant ?? "").toLowerCase(), conditionKey: group.condition.toLowerCase(),
          display: { model: group.model, variant: group.variant, condition: group.condition },
        });
        assert.equal(stats.listings.status, "published", `${day} ${group.key}`);
        if (stats.listings.status !== "published") continue;
        assert.equal(stats.listings.comparedTo.scope, "exact", `${day} ${group.key}`);
        if (group.listingSlots === DEMO_MARKET_POPULAR_SLOTS) {
          assert.notEqual(stats.listings.range, null, `${day} ${group.key} : fourchette`);
          assert.ok(stats.listings.trend.every((point) => point.median !== null), `${day} ${group.key} : 12 points de tendance`);
        } else {
          assert.ok(stats.listings.trend.every((point) => point.median === null), `${day} ${group.key} : pas de tendance pour un produit secondaire`);
        }
      }
    }
  });

  test("H1-ter : les produits très présents ont 24 vendeurs fictifs DISTINCTS (au moins 22) dans chaque semaine de 7 jours (au-dessus du minimum de 20 d'un point de tendance) ; les autres 12 vendeurs sur 90 jours (de la marge sous le seuil de 5 vendeurs retenus, jamais publié à 20 par semaine)", () => {
    const popular = demoMarketGroups().filter((group) => group.listingSlots === DEMO_MARKET_POPULAR_SLOTS);
    assert.ok(popular.length >= 2);
    assert.ok(DEMO_MARKET_LISTING_SELLERS >= MARKET_TREND_MIN_SELLERS + 2 && DEMO_MARKET_LISTING_SELLERS === 24);
    for (const group of popular) {
      for (let start = dayIndexOf(TODAY) - (DEMO_MARKET_HISTORY_DAYS - 1); start + 6 < dayIndexOf(TODAY); start += 1) {
        const week = new Set(rows.filter((row) => row.group.key === group.key && row.source === "listing" && row.day >= dayOfIndex(start) && row.day <= dayOfIndex(start + 6)).map((row) => row.sellerIndex));
        assert.ok(week.size >= 22, `${group.key} : ${week.size} vendeurs du ${dayOfIndex(start)}`);
      }
    }
    for (const group of demoMarketGroups().filter((entry) => entry.listingSlots < DEMO_MARKET_POPULAR_SLOTS)) {
      const sellers = new Set(rows.filter((row) => row.group.key === group.key && row.source === "listing").map((row) => row.sellerIndex));
      assert.equal(sellers.size, DEMO_MARKET_NICHE_SLOTS, `${group.key} : ${sellers.size} vendeurs sur 90 jours`);
      for (let start = dayIndexOf(TODAY) - (DEMO_MARKET_HISTORY_DAYS - 1); start + 6 < dayIndexOf(TODAY); start += 1) {
        const week = new Set(rows.filter((row) => row.group.key === group.key && row.source === "listing" && row.day >= dayOfIndex(start) && row.day <= dayOfIndex(start + 6)).map((row) => row.sellerIndex));
        assert.ok(week.size < MARKET_TREND_MIN_SELLERS, `${group.key} : ${week.size} vendeurs la semaine du ${dayOfIndex(start)} (la tendance reste absente)`);
      }
    }
  });

  test("H1-ter : vendeurs fictifs 1 à 7 = les comptes vendeurs, 8 à 18 = les comptes acheteurs fictifs 1 à 11, 19 à 24 = les comptes fictifs de l'historique des prix 1 à 6 ; un numéro inconnu est refusé", () => {
    const world = {
      sellerIds: new Map<number, string>([[0, "demo"], ...Array.from({ length: 7 }, (_, index): [number, string] => [index + 1, `vendeur-${index + 1}`])]),
      extraBuyerIds: Array.from({ length: DEMO_EXTRA_BUYER_COUNT }, (_, index) => `acheteur-${index + 1}`),
      historySellerIds: Array.from({ length: DEMO_HISTORY_SELLER_COUNT }, (_, index) => `historique-${index + 1}`),
    };
    assert.equal(marketSellerId(world, 1), "vendeur-1");
    assert.equal(marketSellerId(world, DEMO_MARKET_FICTIVE_SELLERS), "vendeur-7");
    assert.equal(marketSellerId(world, 8), "acheteur-1");
    assert.equal(marketSellerId(world, 18), "acheteur-11");
    assert.equal(marketSellerId(world, 19), "historique-1");
    assert.equal(marketSellerId(world, 24), "historique-6");
    for (const bad of [0, 25, -1, 1.5, Number.NaN]) assert.throws(() => marketSellerId(world, bad), RangeError, String(bad));
    const ids = Array.from({ length: DEMO_MARKET_LISTING_SELLERS }, (_, index) => marketSellerId(world, index + 1));
    assert.equal(new Set(ids).size, 24, "vingt-quatre comptes distincts");
    assert.ok(!ids.includes("demo"), "le vendeur démo n'est pas un vendeur fictif de l'historique");
  });

  test("H1 (intégration) : six numéros fictifs d'historique, +225 07 55 55 55 01 à 06, distincts de tous les autres comptes de démonstration ; hors de 1 à 6, refusé", () => {
    assert.equal(DEMO_HISTORY_SELLER_COUNT, 6);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(demoHistorySellerPhone), ["+2250755555501", "+2250755555502", "+2250755555503", "+2250755555504", "+2250755555505", "+2250755555506"]);
    for (const bad of [0, 7, -1, 1.5, Number.NaN]) assert.throws(() => demoHistorySellerPhone(bad), RangeError, String(bad));
    const phones = new Set<string>([DEMO_BUYER_PHONE, DEMO_VENDOR_PHONE, DEMO_ADMIN_PHONE]);
    for (let index = 1; index <= 7; index += 1) phones.add(demoVendorPhone(index));
    for (let index = 1; index <= DEMO_EXTRA_BUYER_COUNT; index += 1) phones.add(demoExtraBuyerPhone(index));
    for (let index = 1; index <= DEMO_HISTORY_SELLER_COUNT; index += 1) phones.add(demoHistorySellerPhone(index));
    assert.equal(phones.size, 3 + 7 + DEMO_EXTRA_BUYER_COUNT + DEMO_HISTORY_SELLER_COUNT, "aucun numéro en double");
  });

  test("sept jours de ventes consécutifs du produit principal : 7 vendeurs et 7 acheteurs distincts (rotation)", () => {
    const sales = rows.filter((row) => row.source === "sale" && row.group.model === "iPhone 12" && row.group.variant === "128 Go" && row.group.condition === "Occasion");
    const byDay = new Map(sales.map((row) => [row.day, row]));
    const first = dayIndexOf(sales[0].day);
    for (let start = first; start + 6 < dayIndexOf(TODAY); start += 1) {
      const week = Array.from({ length: 7 }, (_, offset) => byDay.get(dayOfIndex(start + offset))).filter((row): row is DemoMarketRow => row !== undefined);
      assert.equal(week.length, 7, "une vente par jour");
      assert.equal(new Set(week.map((row) => row.sellerIndex)).size, 7);
      assert.equal(new Set(week.map((row) => row.buyerIndex)).size, 7);
    }
  });
});
