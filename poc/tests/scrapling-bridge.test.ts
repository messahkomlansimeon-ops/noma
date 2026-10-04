import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  extractCoinAfriqueScrapling,
  ScraplingPilotError,
} from "../pilot/scrapling-bridge";
import { extractCoinAfriqueCheerio } from "../sources/coinafrique-parser";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "coinafrique");
const projectRoot = join(here, "../..");
const pilotPython = join(projectRoot, ".venv-scrapling", "bin", "python");
const baseUrl = "https://ci.coinafrique.com/search?keyword=test";
const scratch = mkdtempSync(join(tmpdir(), "noma-scrapling-test-"));
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const expected = (name: string) => JSON.parse(read(name)) as {
  listings: unknown[];
  errors: string[];
};

after(() => rmSync(scratch, { recursive: true, force: true }));

function helperScript(name: string, source: string): string {
  const path = join(scratch, name);
  writeFileSync(path, source, { mode: 0o600 });
  return path;
}

function assertPilotCode(code: ScraplingPilotError["code"]) {
  return (error: unknown) =>
    error instanceof ScraplingPilotError && error.code === code;
}

const validResponse = JSON.stringify({
  version: 1,
  listings: [],
  errors: [],
  metrics: { durationMs: 1, rssBytes: 1, networkAttempts: 0 },
});

describe("pont Scrapling — protocole et bornes", () => {
  test("réponse JSON validée ; une réponse invalide n'est jamais un vide", async () => {
    const valid = helperScript(
      "valid.mjs",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(validResponse)}));`,
    );
    const invalid = helperScript(
      "invalid.mjs",
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not-json"));',
    );
    const input = { html: "<html></html>", baseUrl };
    const result = await extractCoinAfriqueScrapling(input, {
      pythonPath: process.execPath,
      scriptPath: valid,
    });
    assert.deepEqual(result.listings, []);
    await assert.rejects(
      extractCoinAfriqueScrapling(input, {
        pythonPath: process.execPath,
        scriptPath: invalid,
      }),
      assertPilotCode("protocol"),
    );
  });

  test("entrée et sortie sont limitées à 2 Mo", async () => {
    const overflow = helperScript(
      "overflow.mjs",
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(2_000_001)));',
    );
    await assert.rejects(
      extractCoinAfriqueScrapling(
        { html: "x".repeat(2_000_000), baseUrl },
        { pythonPath: process.execPath, scriptPath: overflow },
      ),
      assertPilotCode("input-too-large"),
    );
    await assert.rejects(
      extractCoinAfriqueScrapling({ html: "<html></html>", baseUrl }, {
        pythonPath: process.execPath,
        scriptPath: overflow,
      }),
      assertPilotCode("output-too-large"),
    );
  });

  test("panne Python remontée, diagnostics bornés à 16 Ko", async () => {
    const failure = helperScript(
      "failure.mjs",
      'process.stderr.write("e".repeat(20_000)); process.exit(7);',
    );
    await assert.rejects(
      extractCoinAfriqueScrapling({ html: "<html></html>", baseUrl }, {
        pythonPath: process.execPath,
        scriptPath: failure,
      }),
      (error: unknown) =>
        error instanceof ScraplingPilotError &&
        error.code === "process" &&
        error.message.length < 16_200,
    );
  });

  test("délai et annulation arrêtent le processus", async () => {
    const slow = helperScript("slow.mjs", "setTimeout(() => {}, 10_000);");
    const input = { html: "<html></html>", baseUrl };
    await assert.rejects(
      extractCoinAfriqueScrapling(input, {
        pythonPath: process.execPath,
        scriptPath: slow,
        timeoutMs: 30,
      }),
      assertPilotCode("timeout"),
    );

    const controller = new AbortController();
    const started = performance.now();
    const pending = extractCoinAfriqueScrapling(input, {
      pythonPath: process.execPath,
      scriptPath: slow,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, assertPilotCode("aborted"));
    assert.ok(performance.now() - started < 1_500, "arrêt forcé borné à une seconde");
  });

  test("un seul sous-processus pilote est exécuté à la fois", async () => {
    const delayed = helperScript(
      "delayed.mjs",
      `process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.stdout.write(${JSON.stringify(validResponse)}), 120));`,
    );
    const options = { pythonPath: process.execPath, scriptPath: delayed };
    const started = performance.now();
    await Promise.all([
      extractCoinAfriqueScrapling({ html: "<html></html>", baseUrl }, options),
      extractCoinAfriqueScrapling({ html: "<html></html>", baseUrl }, options),
    ]);
    assert.ok(performance.now() - started >= 200, "les deux processus ne se chevauchent pas");
  });

  test("l'attente dans la file est annulable immédiatement sans attendre le processus en cours", async () => {
    const slow = helperScript(
      "queue-slow-abort.mjs",
      `process.stdin.resume(); setTimeout(() => { process.stdout.write(${JSON.stringify(validResponse)}); process.exit(0); }, 500);`,
    );
    const options = { pythonPath: process.execPath, scriptPath: slow };
    const input = { html: "<html></html>", baseUrl };

    const first = extractCoinAfriqueScrapling(input, options);
    const controller = new AbortController();
    const queuedStarted = performance.now();
    const queued = extractCoinAfriqueScrapling(input, {
      ...options,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);

    await assert.rejects(queued, assertPilotCode("aborted"));
    const elapsed = performance.now() - queuedStarted;
    assert.ok(elapsed < 200, `annulation dans la file en ${elapsed} ms (doit être < 200 ms)`);
    await first;
  });

  test("le délai d'attente dans la file est borné immédiatement sans attendre le processus en cours", async () => {
    const slow = helperScript(
      "queue-slow-timeout.mjs",
      `process.stdin.resume(); setTimeout(() => { process.stdout.write(${JSON.stringify(validResponse)}); process.exit(0); }, 500);`,
    );
    const options = { pythonPath: process.execPath, scriptPath: slow };
    const input = { html: "<html></html>", baseUrl };

    const first = extractCoinAfriqueScrapling(input, options);
    const queuedStarted = performance.now();
    const queued = extractCoinAfriqueScrapling(input, {
      ...options,
      timeoutMs: 40,
    });

    await assert.rejects(queued, assertPilotCode("timeout"));
    const elapsed = performance.now() - queuedStarted;
    assert.ok(elapsed < 200, `dépassement de délai dans la file en ${elapsed} ms (doit être < 200 ms)`);
    await first;
  });
});

const requireRuntime = process.env.NOMA_REQUIRE_SCRAPLING === "1";
if (requireRuntime && !existsSync(pilotPython)) {
  test("runtime Scrapling requis", () => assert.fail("exécuter le setup du pilote Scrapling"));
}

describe("Scrapling réel — corpus hors ligne", { skip: !existsSync(pilotPython) }, () => {
  test("parité complète sur la fixture nominale, zéro réseau", async () => {
    const result = await extractCoinAfriqueScrapling({ html: read("nominal.html"), baseUrl });
    assert.deepEqual(
      { listings: result.listings, errors: result.errors },
      expected("nominal.expected.json"),
    );
    assert.equal(result.metrics.networkAttempts, 0);
  });

  test("les ressources HTML distantes ne sont jamais téléchargées", async () => {
    const result = await extractCoinAfriqueScrapling({ html: read("empty.html"), baseUrl });
    assert.deepEqual(
      { listings: result.listings, errors: result.errors },
      expected("empty.expected.json"),
    );
    assert.equal(result.metrics.networkAttempts, 0);
  });

  test("adaptatif : apprentissage initial puis structure modifiée sans réapprentissage", async () => {
    const storagePath = join(scratch, "adaptive.sqlite");
    const trained = await extractCoinAfriqueScrapling(
      { html: read("adaptive-base.html"), baseUrl },
      { mode: "adaptive-train", storagePath },
    );
    assert.equal(trained.listings.length, 1);

    const standard = await extractCoinAfriqueScrapling({
      html: read("adaptive-changed.html"),
      baseUrl,
    });
    assert.equal(standard.listings.length, 0);

    const adapted = await extractCoinAfriqueScrapling(
      { html: read("adaptive-changed.html"), baseUrl },
      { mode: "adaptive", storagePath },
    );
    assert.deepEqual(
      { listings: adapted.listings, errors: adapted.errors },
      expected("adaptive.expected.json"),
    );
    assert.equal(adapted.metrics.networkAttempts, 0);
  });

  test("extraction du texte descendant avec balises HTML imbriquées (b, span) conforme à Cheerio", async () => {
    const nestedHtml = `
      <div class="card ad__card">
        <a class="ad__card-image" href="/annonce/123" title="iPhone 12 Pro"></a>
        <div class="card-fav" data-ad-title="  iPhone 12 Pro&#10;&#10;  " data-ad-price="150000" data-ad-category="Téléphones"></div>
        <p class="ad__card-location"><span><b>Cocody</b>, <b>Abidjan</b>, Côte d'Ivoire</span></p>
        <div class="ad__card-timesince"><span><b>Hier</b></span> <span><b>14h</b></span></div>
        <p class="ad__card-description"><b>Superbe</b> état avec <b>accessoires</b></p>
      </div>
    `;
    const cheerioResult = await extractCoinAfriqueCheerio({ html: nestedHtml, baseUrl });
    const scraplingResult = await extractCoinAfriqueScrapling({ html: nestedHtml, baseUrl });

    assert.equal(scraplingResult.listings.length, 1);
    assert.equal(scraplingResult.listings[0].title, "iPhone 12 Pro");
    assert.equal(scraplingResult.listings[0].zone, "Cocody, Abidjan");
    assert.equal(scraplingResult.listings[0].date, "il y a Hier 14h");
    assert.equal(
      scraplingResult.listings[0].description,
      "Téléphones — Superbe état avec accessoires",
    );
    assert.deepEqual(scraplingResult.listings, cheerioResult.listings);
  });
});
