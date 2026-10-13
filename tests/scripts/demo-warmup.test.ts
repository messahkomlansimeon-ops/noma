import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WARMUP_API_PATTERNS,
  WARMUP_EXCLUDED_PAGES,
  WARMUP_NOT_FOUND_PATH,
  WARMUP_PAGE_PATTERNS,
  WARMUP_PLACEHOLDER_ID,
  durationText,
  resolveBaseUrl,
  runWarmup,
  warmupTargets,
  warmupUrl,
} from "../../scripts/demo-warmup";

/**
 * `npm run demo:warmup` (lot FIN1) : la liste des adresses préchauffées est VÉRIFIÉE contre les dossiers de l'application (une page ou une route de plus, non ajoutée à la liste,
 * fait échouer ces essais) et contre DEMO.md (toute adresse que le guide fait ouvrir est couverte) ; l'exécution n'envoie que des GET, sans cookie ni corps.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

/** Les pages réelles : les fichiers `page.tsx` sous `app/`, sans les groupes de routes `(buyer)`. */
const filePages = (): string[] =>
  walk(join(ROOT, "app"))
    .map((file) => file.slice(join(ROOT, "app").length).replace(/\\/g, "/"))
    .filter((file) => file.endsWith("/page.tsx"))
    .map((file) => file.replace(/\/page\.tsx$/, "").replace(/\/\([^/]+\)/g, ""))
    .map((route) => (route === "" ? "/" : route))
    .sort();

/** Les routes /api réelles : les fichiers `route.ts` sous `app/api/`. */
const fileApiRoutes = (): string[] =>
  walk(join(ROOT, "app", "api"))
    .map((file) => file.slice(join(ROOT, "app").length).replace(/\\/g, "/"))
    .filter((file) => file.endsWith("/route.ts"))
    .map((file) => file.replace(/\/route\.ts$/, ""))
    .sort();

describe("la liste couvre TOUTES les pages et routes de l'application", () => {
  test("pages : chaque page de app/ est préchauffée ou exclue avec une raison ; aucune entrée ne vise une page qui n'existe pas ; aucun doublon", () => {
    const real = new Set(filePages());
    const listed = new Set(WARMUP_PAGE_PATTERNS);
    const excluded = new Set(Object.keys(WARMUP_EXCLUDED_PAGES));
    assert.equal(listed.size, WARMUP_PAGE_PATTERNS.length, "aucun doublon dans la liste");
    for (const route of real) assert.ok(listed.has(route) || excluded.has(route), `page non préchauffée et non justifiée : ${route}`);
    for (const route of listed) assert.ok(real.has(route), `entrée sans page : ${route}`);
    for (const route of excluded) assert.ok(real.has(route), `exclusion sans page : ${route}`);
    for (const route of excluded) assert.equal(listed.has(route), false, `exclue ET préchauffée : ${route}`);
    for (const [route, reason] of Object.entries(WARMUP_EXCLUDED_PAGES)) assert.ok(reason.length >= 10, `raison de l'exclusion de ${route}`);
  });

  test("routes /api : chacune est préchauffée (y compris les routes d'écriture, compilées par un GET qui répond 405 sans exécuter leur code)", () => {
    const real = fileApiRoutes();
    assert.deepEqual([...WARMUP_API_PATTERNS].sort(), real);
    assert.equal(new Set(WARMUP_API_PATTERNS).size, WARMUP_API_PATTERNS.length, "aucun doublon");
  });

  test("le préchauffage a un effet visible : les écrans et routes de la démonstration y sont (connexion, flux de la messagerie, recherche, recharge, administration)", () => {
    const targets = warmupTargets();
    for (const expected of [
      "/", "/connexion", "/verification", "/vendeur", "/vendeur/porte-monnaie", "/compte/porte-monnaie", "/admin", "/admin/marche", WARMUP_NOT_FOUND_PATH,
      `/api/conversations/${WARMUP_PLACEHOLDER_ID}/stream`, "/api/search", "/api/auth/otp/request", "/api/auth/otp/verify", "/api/market", "/api/wallet/topups",
      `/api/dev/fake-payments/${WARMUP_PLACEHOLDER_ID}/confirm`, `/api/missions/${WARMUP_PLACEHOLDER_ID}/proposal`, `/besoins/${WARMUP_PLACEHOLDER_ID}/offres/${WARMUP_PLACEHOLDER_ID}`,
    ]) assert.ok(targets.includes(expected), expected);
    assert.equal(new Set(targets).size, targets.length, "aucune adresse deux fois");
  });

  test("adresses : jamais de crochet, de paramètre ni d'adresse complète ; les segments dynamiques sont factices", () => {
    for (const target of warmupTargets()) {
      assert.ok(target.startsWith("/") && !target.startsWith("//"), target);
      assert.equal(/[\[\]?#:]/.test(target), false, target);
    }
    assert.equal(warmupUrl("/besoins/[id]/offres/[offerId]"), `/besoins/${WARMUP_PLACEHOLDER_ID}/offres/${WARMUP_PLACEHOLDER_ID}`);
    assert.equal(warmupUrl("/api/admin/plans/[code]/versions"), "/api/admin/plans/pro/versions");
    assert.equal(warmupUrl("/api/orders/[id]/[action]"), `/api/orders/${WARMUP_PLACEHOLDER_ID}/confirm`);
    assert.match(WARMUP_PLACEHOLDER_ID, /^0{8}-0{4}-4000-8000-0{12}$/);
  });
});

describe("DEMO.md : toute adresse que le guide fait ouvrir est préchauffée", () => {
  const demo = readFileSync(join(ROOT, "DEMO.md"), "utf8");
  const asRegex = (pattern: string) => new RegExp(`^${pattern.replace(/\[[A-Za-z]+\]/g, "[^/]+").replace(/\//g, "\\/")}$`);
  const covered = (path: string) => [...WARMUP_PAGE_PATTERNS, ...WARMUP_API_PATTERNS].some((pattern) => asRegex(pattern).test(path));

  test("les adresses citées entre accents graves (« /admin », « /admin/collecte », « /vendeur »…) sont couvertes", () => {
    const cited = new Set<string>();
    for (const match of demo.matchAll(/`(\/[a-z][a-z0-9\-/]*)`/g)) cited.add(match[1]);
    const routes = [...cited].filter((path) => /^\/(admin|vendeur|compte|missions|messages|favoris|alertes|notifications|besoins|commandes|connexion|recherche|api)(\/|$)/.test(path));
    assert.ok(routes.length >= 3, `adresses de DEMO.md : ${routes.join(", ")}`);
    for (const route of routes) assert.ok(covered(route), `DEMO.md fait ouvrir ${route} : elle doit être préchauffée`);
  });

  test("DEMO.md et package.json présentent la commande, et l'étape dit de l'exécuter après dev:try", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts["demo:warmup"], /scripts\/demo-warmup\.ts$/);
    assert.match(demo, /npm run demo:warmup/);
    assert.ok(demo.indexOf("npm run demo:warmup") > demo.indexOf("npm run dev:try"), "le préchauffage vient APRÈS le lancement de dev:try");
  });
});

describe("exécution : GET seulement, sans cookie, sans effet", () => {
  const response = (status: number) => ({ status, body: { cancel: async () => {} } }) as unknown as Response;

  test("chaque adresse est ouverte UNE fois, en GET, sans cookie, sans autorisation et sans corps ; le relais est le seul hôte", async () => {
    const calls: Array<{ url: string; method: string | undefined; headers: Record<string, string>; body: unknown }> = [];
    const report = await runWarmup({
      baseUrl: "http://localhost:3212",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
        return response(String(input).includes("/api/") ? 401 : 200);
      }) as typeof fetch,
    });
    const targets = warmupTargets();
    assert.equal(report.total, targets.length);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(calls.map((call) => call.url).sort(), targets.map((path) => `http://localhost:3212${path}`).sort());
    for (const call of calls) {
      assert.equal(call.method, "GET", call.url);
      assert.equal(call.body, undefined, call.url);
      assert.deepEqual(Object.keys(call.headers).map((name) => name.toLowerCase()).filter((name) => ["cookie", "authorization", "x-noma-proxy-secret", "origin", "content-type"].includes(name)), [], call.url);
      assert.ok(call.url.startsWith("http://localhost:3212/"), call.url);
    }
  });

  test("une réponse 401, 404 ou 405 est un succès (la route est compilée) ; une erreur 5xx ou une absence de réponse est un échec ; la durée totale est mesurée", async () => {
    let clock = 0;
    const statuses = new Map<string, number | "throw">([
      ["/connexion", 200], ["/api/market", 401], ["/api/search", 405], [WARMUP_NOT_FOUND_PATH, 404], ["/admin", 500], ["/vendeur", "throw"],
    ]);
    const report = await runWarmup({
      baseUrl: "http://127.0.0.1:3212",
      targets: [...statuses.keys()],
      concurrency: 1,
      now: () => (clock += 250),
      fetchImpl: (async (input: string | URL | Request) => {
        const outcome = statuses.get(new URL(String(input)).pathname);
        if (outcome === "throw") throw new TypeError("fetch failed");
        return response(outcome as number);
      }) as typeof fetch,
    });
    assert.deepEqual(report.outcomes.map((entry) => [entry.path, entry.status, entry.ok]), [
      ["/connexion", 200, true], ["/api/market", 401, true], ["/api/search", 405, true], [WARMUP_NOT_FOUND_PATH, 404, true], ["/admin", 500, false], ["/vendeur", null, false],
    ]);
    assert.deepEqual(report.failed.map((entry) => entry.path), ["/admin", "/vendeur"]);
    assert.ok(report.durationMs > 0);
    assert.equal(durationText(42_400), "42 s");
    assert.equal(durationText(72_000), "1 min 12 s");
  });

  test("au plus 4 requêtes en parallèle ; un délai dépassé est un échec sans exception ; la réponse n'est jamais lue en entier (flux de messagerie)", async () => {
    let running = 0;
    let peak = 0;
    let cancelled = 0;
    const report = await runWarmup({
      baseUrl: "http://localhost:3212",
      targets: Array.from({ length: 12 }, (_, index) => `/p${index}`),
      fetchImpl: (async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { status: 200, body: { cancel: async () => void (cancelled += 1) } } as unknown as Response;
      }) as typeof fetch,
    });
    assert.equal(report.failed.length, 0);
    assert.ok(peak <= 4 && peak >= 2, `parallélisme ${peak}`);
    assert.equal(cancelled, 12);
    const slow = await runWarmup({
      baseUrl: "http://localhost:3212",
      targets: ["/lent"],
      timeoutMs: 20,
      fetchImpl: ((_: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("annulé", "AbortError"))))) as typeof fetch,
    });
    assert.deepEqual(slow.outcomes.map((entry) => [entry.status, entry.ok]), [[null, false]]);
  });
});

describe("adresse du relais", () => {
  test("par défaut http://localhost:3212 (NOMA_DEV_TRY_PORT pour un autre port) ; NOMA_DEMO_BASE_URL seulement vers CE poste ; tout le reste est refusé", () => {
    assert.equal(resolveBaseUrl({}), "http://localhost:3212");
    assert.equal(resolveBaseUrl({ NOMA_DEV_TRY_PORT: "3222" }), "http://localhost:3222");
    assert.equal(resolveBaseUrl({ NOMA_DEMO_BASE_URL: "http://127.0.0.1:3212" }), "http://127.0.0.1:3212");
    assert.equal(resolveBaseUrl({ NOMA_DEMO_BASE_URL: "http://localhost:3212/" }), "http://localhost:3212");
    for (const bad of ["https://localhost:3212", "http://example.com:3212", "http://localhost", "http://localhost:3212/admin", "http://localhost:3212/?x=1", "http://u:p@localhost:3212", "http://192.168.1.5:3212", "pas une adresse", "http://localhost.evil.example:3212"]) {
      assert.equal(resolveBaseUrl({ NOMA_DEMO_BASE_URL: bad }), null, bad);
    }
    for (const bad of ["0", "70000", "abc", "3212; rm"]) assert.equal(resolveBaseUrl({ NOMA_DEV_TRY_PORT: bad }), null, bad);
  });
});
