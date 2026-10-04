import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDownloadLimiter,
  compareListings,
  compareErrors,
  detectPythonVersion,
  evaluateTrial,
  type TrialCaseResult,
} from "../pilot/trial-coinafrique";
import type { RawListing } from "../lib/normalize";

const sampleListing1: RawListing = {
  id: "coin-100",
  source: "coinafrique",
  title: "iPhone 12 Pro 128 Go",
  price: 150000,
  currency: "FCFA",
  zone: "Cocody, Abidjan",
  vendor: null,
  url: "https://ci.coinafrique.com/annonce/100",
  photo: "https://ci.coinafrique.com/photo/100.jpg",
  date: "il y a 2 heures",
  description: "Téléphones — En très bon état",
};

const sampleListing2: RawListing = {
  id: "coin-200",
  source: "coinafrique",
  title: "Climatiseur Split 12000 BTU",
  price: 180000,
  currency: "FCFA",
  zone: "Yopougon, Abidjan",
  vendor: null,
  url: "https://ci.coinafrique.com/annonce/200",
  photo: null,
  date: "il y a Hier",
  description: "Électroménager — Neuf sous emballage",
};

describe("Harnais d'essai CoinAfrique — logique et gardes", () => {
  test("la métadonnée Python ne masque jamais le verdict du pilote", () => {
    const restricted = Object.assign(new Error("spawnSync EPERM"), {
      stdout: "Python 3.14.7\n",
    });
    assert.equal(
      detectPythonVersion(() => {
        throw restricted;
      }),
      "Python 3.14.7",
    );
    assert.equal(
      detectPythonVersion(() => {
        throw new Error("runtime indisponible");
      }),
      "indisponible",
    );
  });

  test("createDownloadLimiter empêche strictement tout dépassement du quota de téléchargement", async () => {
    const limiter = createDownloadLimiter(3);
    assert.equal(limiter.getCount(), 0);

    const r1 = await limiter.fetch(async () => "call-1");
    const r2 = await limiter.fetch(async () => "call-2");
    const r3 = await limiter.fetch(async () => "call-3");

    assert.equal(r1, "call-1");
    assert.equal(r2, "call-2");
    assert.equal(r3, "call-3");
    assert.equal(limiter.getCount(), 3);

    await assert.rejects(
      limiter.fetch(async () => "call-4"),
      /Plafond strict de téléchargements atteint \(3\)/,
    );
    assert.equal(limiter.getCount(), 3);
  });

  test("compareListings détecte l'identité exacte", () => {
    const res = compareListings([sampleListing1, sampleListing2], [
      { ...sampleListing1 },
      { ...sampleListing2 },
    ]);
    assert.equal(res.isIdentical, true);
    assert.equal(res.differences.length, 0);
  });

  test("compareListings détecte les différences champ par champ", () => {
    const modified = {
      ...sampleListing1,
      zone: "Plateau, Abidjan",
      price: 140000,
    };
    const res = compareListings([sampleListing1], [modified]);
    assert.equal(res.isIdentical, false);
    assert.equal(res.differences.length, 2);

    const priceDiff = res.differences.find((d) => d.field === "price");
    assert.ok(priceDiff);
    assert.equal(priceDiff.cheerioValue, 150000);
    assert.equal(priceDiff.scraplingValue, 140000);

    const zoneDiff = res.differences.find((d) => d.field === "zone");
    assert.ok(zoneDiff);
    assert.equal(zoneDiff.cheerioValue, "Cocody, Abidjan");
    assert.equal(zoneDiff.scraplingValue, "Plateau, Abidjan");
  });

  test("compareListings détecte les annonces manquantes ou supplémentaires", () => {
    const resMissing = compareListings([sampleListing1, sampleListing2], [sampleListing1]);
    assert.equal(resMissing.isIdentical, false);
    assert.equal(resMissing.differences[0].field, "missing");
    assert.equal(resMissing.differences[0].listingId, "coin-200");

    const resExtra = compareListings([sampleListing1], [sampleListing1, sampleListing2]);
    assert.equal(resExtra.isIdentical, false);
    assert.equal(resExtra.differences[0].field, "extra");
    assert.equal(resExtra.differences[0].listingId, "coin-200");
  });

  test("compareErrors vérifie la parité des erreurs de parsing", () => {
    const ok = compareErrors(["1 carte ignorée"], ["1 carte ignorée"]);
    assert.equal(ok.isIdentical, true);
    assert.equal(ok.differences.length, 0);

    const mismatch = compareErrors(["1 carte ignorée"], []);
    assert.equal(mismatch.isIdentical, false);
    assert.ok(mismatch.differences.length > 0);
  });

  test("evaluateTrial valide les critères GO_LIMITE quand tout est nominal", () => {
    const dummyCase: TrialCaseResult = {
      id: "test",
      label: "Test",
      url: "https://ci.coinafrique.com/test",
      httpStatus: 200,
      bytes: 50_000,
      cheerioDurationMs: 10,
      scraplingDurationMs: 120,
      scraplingWallMs: 110,
      scraplingRssBytes: 40 * 1024 * 1024,
      scraplingNetworkAttempts: 0,
      overheadMs: 110,
      comparison: {
        isIdentical: true,
        differences: [],
        cheerioCount: 1,
        scraplingCount: 1,
        errorsIdentical: true,
        cheerioErrors: [],
        scraplingErrors: [],
      },
    };

    const report = evaluateTrial([dummyCase], 1);
    assert.equal(report.verdict, "GO_LIMITE");
    assert.equal(report.checks.exactParity, true);
    assert.equal(report.checks.zeroNetworkAttempts, true);
    assert.equal(report.checks.latencyBudget, true);
    assert.equal(report.checks.memoryBudget, true);
  });

  test("evaluateTrial déclenche NO_GO en cas de réseau Python ou différence de données", () => {
    const badNetworkCase: TrialCaseResult = {
      id: "test",
      label: "Test",
      url: "https://ci.coinafrique.com/test",
      httpStatus: 200,
      bytes: 50_000,
      cheerioDurationMs: 10,
      scraplingDurationMs: 120,
      scraplingWallMs: 110,
      scraplingRssBytes: 40 * 1024 * 1024,
      scraplingNetworkAttempts: 1, // violation!
      overheadMs: 110,
      comparison: {
        isIdentical: true,
        differences: [],
        cheerioCount: 1,
        scraplingCount: 1,
        errorsIdentical: true,
        cheerioErrors: [],
        scraplingErrors: [],
      },
    };

    const report = evaluateTrial([badNetworkCase], 1);
    assert.equal(report.verdict, "NO_GO");
    assert.equal(report.checks.zeroNetworkAttempts, false);
  });

  test("evaluateTrial déclenche ARRET_BLOCAGE sur code 403 / 429", () => {
    const report = evaluateTrial([], 1, { code: "403", message: "Forbidden" });
    assert.equal(report.verdict, "ARRET_BLOCAGE");
  });
});
