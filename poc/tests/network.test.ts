/**
 * Tests RÉSEAU — consomment des crédits IA et dépendent des sites réels.
 * Exécution volontaire uniquement : POC_NETWORK=1 npm run test:network
 * (jamais lancés par `npm test`).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import { fetchCoinAfrique } from "../sources/coinafrique";

const enabled = process.env.POC_NETWORK === "1";
const t = (enabled ? test : test.skip) as typeof test;

describe("réseau — connecteurs réels (POC_NETWORK=1)", () => {
  t("CoinAfrique répond avec des annonces iPhone", async () => {
    const need = parseNeed("iPhone 12 128 Go à Abidjan");
    const r = await fetchCoinAfrique(need);
    assert.equal(r.status, "ok");
    assert.ok(r.listings.length > 0, `${r.listings.length} annonces`);
    assert.ok(r.listings.every((l) => l.price === null || l.price > 0));
  });
});