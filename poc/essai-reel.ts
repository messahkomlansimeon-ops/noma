/**
 * Lot 4A — essai réel local contrôlé. Trois recherches RÉELLES (sources
 * réelles + IA OpenRouter), depuis l'interface, séquentiellement, quotas
 * respectés (frontière de minute avant chaque démarrage), UNE tentative
 * chacune. Arrêt immédiat si une réserve devient incertaine (facturation
 * non connue). Aucun contournement de blocage, aucun proxy, aucune relance.
 *
 * Mesures par recherche :
 *  - timing (clic → premier résultat visible → fin), nombre d'offres ;
 *  - flux NDJSON capturé (started/results/completed → statuts par source) ;
 *  - texte intégral des 5 premières offres (titre, prix, zone, source,
 *    statut IA, justification) ;
 *  - liens externes des 5 premières offres : accessibilité HTTP (la page
 *    accessible ≠ produit encore disponible — jamais déduit) ;
 *  - comptabilité SQLite : recherches actives, réserves (résolues /
 *    conservées), ledger.
 *
 * Usage :
 *   NOMA_BASE_URL=http://127.0.0.1:3220 NOMA_ESSAI_DB=/tmp/.../noma-guard.sqlite \
 *     node_modules/.bin/tsx essai-reel.ts
 */
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = process.env.NOMA_BASE_URL ?? "http://127.0.0.1:3220";
const DB_PATH = process.env.NOMA_ESSAI_DB ?? "/tmp/opencode/noma-essai-db/noma-guard.sqlite";
const CACHE_FILE = process.env.NOMA_ESSAI_CACHE ?? "/tmp/opencode/noma-essai/results/cache.json";
const TAP = process.env.NOMA_ESSAI_TAP ?? "";
const OUT = "/tmp/opencode/noma-essai-captures";
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFreshMinute = async (): Promise<void> => {
  const w = 60_000 - (Date.now() % 60_000) + 300;
  if (w < 59_000) {
    console.log(`  (frontière de minute : attente ${Math.ceil(w / 1000)} s — quota 2 démarrages/min)`);
    await sleep(w);
  }
};

const SEARCHES = [
  { nom: "1-iphone-12-pro", texte: "iPhone 12 Pro 128 Go", location: "Cocody", budget: "150 000" },
  { nom: "2-tv-55-pouces", texte: "Téléviseur 55 pouces", location: "Abidjan", budget: "" },
  { nom: "3-chargeur-usbc-20w", texte: "Chargeur USB-C 20 W", location: "Abidjan", budget: "" },
];

interface Metrics {
  nom: string;
  tClick: number;
  tPremierResultat: number | null;
  tFin: number | null;
  etatFinal: string;
  /** Raison de fin attestée par le tap serveur (completed | error |
   *  annulé-sans-publication | null = flux non capturé). */
  finPubliée: string | null;
  nbOffres: number;
  events: { type: string; extra?: string }[];
  sources: { source: string; status: string }[];
  top5: { href: string; texte: string }[];
  lienExterne: string | null;
  liensVerifies: { url: string; http: number | null; note: string }[];
  comptabilite: {
    recherchesActives: number;
    reservations: { searchId: string; resolue: boolean; reserve: number; depense: number | null }[];
    ledgerJour: { day: string; totalMicros: number }[];
  };
  captures: string[];
  erreur?: string;
}

const accounting = () => {
  const db = new DatabaseSync(DB_PATH);
  const tableExists = (t: string): boolean =>
    Number(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(t) as { n: number | bigint } | undefined)?.n ?? 0,
    ) > 0;
  const active = tableExists("active_searches")
    ? Number(
        (db.prepare("SELECT COUNT(*) AS n FROM active_searches").get() as { n: number | bigint } | undefined)?.n ?? 0,
      )
    : 0;
  const reservations = !tableExists("reservations")
    ? []
    : (
        db.prepare("SELECT search_id, resolved_at, amount_micros, spent_micros FROM reservations ORDER BY created_at").all() as {
          search_id: string; resolved_at: string | null; amount_micros: number; spent_micros: number | null;
        }[]
      ).map((r) => ({
        searchId: r.search_id,
        resolue: r.resolved_at !== null,
        reserve: Number(r.amount_micros),
        depense: r.spent_micros === null ? null : Number(r.spent_micros),
      }));
  const ledgerJour = !tableExists("ledger")
    ? []
    : (
        db.prepare("SELECT day, SUM(amount_micros) AS total FROM ledger GROUP BY day").all() as { day: string; total: number }[]
      ).map((r) => ({ day: r.day, totalMicros: Number(r.total) }));
  db.close();
  return { recherchesActives: active, reservations, ledgerJour };
};

const cacheStats = (): string => {
  try {
    if (!existsSync(CACHE_FILE)) return "aucun cache sur disque";
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Record<string, { source?: string }[]>;
    const parSource: Record<string, number> = {};
    for (const entries of Object.values(raw)) {
      for (const e of entries ?? []) parSource[e.source ?? "?"] = (parSource[e.source ?? "?"] ?? 0) + 1;
    }
    return `entrées cache par source : ${JSON.stringify(parSource)}`;
  } catch {
    return "cache illisible (non interprété)";
  }
};

async function runSearch(browser: Awaited<ReturnType<typeof chromium.launch>>, s: (typeof SEARCHES)[number]): Promise<Metrics> {
  // contexte NEUF par recherche : le sessionStorage d'une recherche
  // précédente ne doit jamais polluer la mesure (restauration = pas le
  // premier résultat de LA recherche courante)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let tapOffset = 0; // position lue dans le tap serveur (recherche courante)
  const m: Metrics = {
    nom: s.nom, tClick: 0, tPremierResultat: null, tFin: null, etatFinal: "inconnu", finPubliée: null,
    nbOffres: 0, events: [], sources: [], top5: [], lienExterne: null, liensVerifies: [],
    comptabilite: accounting(), captures: [],
  };

  // capture du flux NDJSON — fiabilité : le TAP SERVEUR (NOMA_DEBUG_EVENT_LOG)
  // est la source primaire (la lecture navigateur d'un flux long-lived peut
  // être rejetée par l'instrument : lecteurs concurrents) ; res.text() reste
  // un recours best-effort.
  const cap: { body: Promise<string> | null } = { body: null };
  const onResponse = (res: { url(): string; request(): { method(): string }; text(): Promise<string> }): void => {
    if (!cap.body && res.url().endsWith("/api/search") && res.request().method() === "POST") {
      cap.body = res.text();
    }
  };
  page.on("response", onResponse as never);

  await waitFreshMinute();
  console.log(`\n▶ recherche ${s.nom} : « ${s.texte} » (Cocody/Abidjan, budget « ${s.budget || "—"} »)`);
  await page.goto(`${BASE}/`);
  await page.evaluate(() => sessionStorage.clear()); // mesure : recherche courante SEULE
  await page.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
  await page.waitForSelector("text=Que cherchez-vous ?");
  await page.getByPlaceholder(/iPhone 12 en bon état/i).fill(s.texte);
  await page.getByPlaceholder("Valeur du texte").fill(s.location);
  if (s.budget) await page.getByPlaceholder("FCFA").fill(s.budget);
  m.tClick = Date.now();
  await page.screenshot({ path: `${OUT}/${s.nom}-formulaire.png`, fullPage: true });
  m.captures.push(`${s.nom}-formulaire.png`);
  await page.getByRole("button", { name: /Trouver des offres/i }).click();
  await page.waitForURL("**/recherche", { timeout: 30_000 });

  try {
    await page.waitForSelector('a[href^="/offre/"]', { timeout: 200_000 });
    m.tPremierResultat = Date.now() - m.tClick;
    console.log(`  premier résultat visible : ${m.tPremierResultat} ms`);
  } catch {
    /* aucune offre (sources indisponibles ou aucune annonce) : capturé plus bas */
  }
  await page.screenshot({ path: `${OUT}/${s.nom}-resultats.png`, fullPage: true });
  m.captures.push(`${s.nom}-resultats.png`);

  const nb = await page.locator('a[href^="/offre/"]').count();
  m.nbOffres = nb;
  // ATTENTION : count() compte les ÉLÉMENTS <a> — chaque carte en porte 2
  // (vignette + titre) : les cartes = nb / 2 approximatif
  console.log(`  éléments « liens offre » au moment de la capture : ${nb} (≈ ${Math.round(nb / 2)} cartes — instantané progressif, pas la liste finale)`);

  // état final déduit du TAP SERVEUR (fiabilité : écrit à la clôture du flux,
  // lecteurs concurrents impossibles) — res.text() en recours best-effort
  let tapParsed = false;
  if (TAP) {
    const deadline = Date.now() + 200_000;
    for (;;) {
      const chunk = existsSync(TAP) ? readFileSync(TAP, "utf-8").slice(tapOffset) : "";
      if (/\{"type":"(completed|error)"/.test(chunk) || Date.now() > deadline) break;
      await sleep(500);
    }
    if (existsSync(TAP)) {
      const chunk = readFileSync(TAP, "utf-8").slice(tapOffset);
      tapOffset += chunk.length;
      let endReason: string | null = null;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.tap === "end") {
            // marqueur terminal : la fin RÉELLEMENT publiée (jamais une fin
            // non émise — le moteur peut terminer après annulation)
            endReason = String(e.reason);
            continue;
          }
          if (e.type === "started") m.events.push({ type: "started", extra: `aiEnabled=${e.aiEnabled}` });
          else if (e.type === "results") m.events.push({ type: "results", extra: `offers=${(e.offers as unknown[]).length}` });
          else if (e.type === "completed") {
            m.events.push({ type: "completed", extra: `offersCount=${e.offersCount}` });
            m.sources = (e.sources as { source: string; status: string }[]) ?? [];
          } else if (e.type === "error") m.events.push({ type: "error", extra: String(e.code) });
        } catch { /* ligne partielle */ }
      }
      tapParsed = m.events.length > 0 || endReason !== null;
      m.finPubliée = endReason; // null = fin jamais publiée
    }
  }
  if (!tapParsed && cap.body) {
    try {
      const body = await cap.body;
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.type === "started") m.events.push({ type: "started", extra: `aiEnabled=${e.aiEnabled}` });
          else if (e.type === "results") m.events.push({ type: "results" });
          else if (e.type === "completed") {
            m.events.push({ type: "completed", extra: `offersCount=${e.offersCount}` });
            m.sources = (e.sources as { source: string; status: string }[]) ?? [];
          } else if (e.type === "error") m.events.push({ type: "error", extra: String(e.code) });
        } catch { /* ligne partielle */ }
      }
    } catch {
      m.events.push({ type: "erreur-capture-flux" });
    }
  } else if (!tapParsed) {
    m.events.push({ type: "erreur-capture-flux" });
  }
  page.off("response", onResponse as never);
  // la fin du flux est attestée par le MARQUEUR du tap (fin réellement
  // publiée), jamais déduite de HTTP 200 + réconciliation
  m.etatFinal = m.finPubliée === "completed"
    ? `fin normale publiée — ${m.events.find((e) => e.type === "completed")?.extra ?? ""} (liste FINALE)`
    : m.finPubliée === "error"
      ? "erreur publique publiée"
      : `fin NON publiée (${m.finPubliée ?? "flux non capturé"}) — HTTP 200 + réconciliation ne prouvent pas une fin normale du flux`;
  m.tFin = Date.now() - m.tClick;
  console.log(`  état final : ${m.etatFinal} — fin : ${m.tFin} ms`);
  console.log(`  sources : ${m.sources.map((x) => `${x.source}=${x.status}`).join(", ") || "—"}`);

  // texte des 5 premières offres (liens dédupliqués)
  const hrefs: string[] = [];
  const all = await page.locator('a[href^="/offre/"]').all();
  for (const a of all) {
    const h = (await a.getAttribute("href")) ?? "";
    if (!hrefs.includes(h)) hrefs.push(h);
  }
  const uniques = hrefs.slice(0, 5);
  for (const h of uniques) {
    // carte entière (ancêtre arrondi), pas le seul lien vignette (texte vide)
    const card = page
      .locator(`a[href="${h}"]`)
      .first()
      .locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    const texte = (await card.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    m.top5.push({ href: h, texte });
  }

  // détail de la 1re offre + lien externe
  if (uniques.length > 0) {
    await page.goto(`${BASE}${uniques[0]}`);
    await page.waitForSelector("text=Pourquoi cette offre ?", { timeout: 20_000 });
    const ext = await page.locator('a[href^="http"]').first().getAttribute("href").catch(() => null);
    m.lienExterne = ext;
    await page.screenshot({ path: `${OUT}/${s.nom}-detail.png`, fullPage: true });
    m.captures.push(`${s.nom}-detail.png`);

    // comparaison des 2 premières offres (non fatale : l'essai prime sur l'instrument)
    try {
      await page.goto(`${BASE}/recherche`);
      await page.waitForSelector('a[href^="/offre/"]', { timeout: 20_000 });
      const sel = page.getByRole("button", { name: "Sélectionner pour comparer" });
      await sel.nth(0).click();
      await sel.nth(1).click();
      await page.locator("a", { hasText: /Comparer les 2 offres/ }).first().click({ timeout: 10_000 });
      await page.waitForURL("**/comparer", { timeout: 20_000 });
      await page.waitForSelector("text=Voir l'offre", { timeout: 20_000 });
      await page.screenshot({ path: `${OUT}/${s.nom}-comparaison.png`, fullPage: true });
      m.captures.push(`${s.nom}-comparaison.png`);
    } catch (e) {
      m.liensVerifies.push({ url: "(comparaison)", http: null, note: `non exécutée : ${(e as Error).name}` });
      console.log("  comparaison : non exécutée (instrument)");
    }

    // accessibilité HTTP des liens externes (page accessible ≠ disponible)
    for (const h of uniques) {
      try {
        await page.goto(`${BASE}${h}`);
        const ext2 = await page.locator('a[href^="http"]').first().getAttribute("href").catch(() => null);
        if (!ext2) { m.liensVerifies.push({ url: h, http: null, note: "lien externe absent" }); continue; }
        const r = await fetch(ext2, {
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
          headers: { "user-agent": "Mozilla/5.0 (compatible; verification-noma-4A)" },
        });
        await r.body?.cancel();
        m.liensVerifies.push({ url: ext2, http: r.status, note: "statut HTTP (la page répond ≠ produit disponible)" });
      } catch (e) {
        m.liensVerifies.push({ url: h, http: null, note: `échec de vérification : ${(e as Error).name}` });
      }
    }
    console.log(`  liens : ${m.liensVerifies.map((l) => `${l.http ?? "?"}`).join(", ")}`);
  }

  // comptabilité APRÈS la recherche
  m.comptabilite = accounting();
  console.log(`  comptabilité : actives=${m.comptabilite.recherchesActives} réserves=${m.comptabilite.reservations.map((r) => `${r.searchId.slice(0, 10)}…${r.resolue ? `réconciliée(${r.depense})` : "CONSERVÉE"}`).join(",") || "aucune"}`);
  await context.close();
  return m;
}

async function main() {
  // sous-ensemble autorisé (ex. NOMA_ESSAI_ONLY=2,3 pour ne PAS refaire une
  // tentative déjà consommée)
  const only = (process.env.NOMA_ESSAI_ONLY ?? "1,2,3")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => n >= 1 && n <= SEARCHES.length);
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable" });

  const resultats: Metrics[] = [];
  for (const [i, s] of SEARCHES.entries()) {
    if (!only.includes(i + 1)) continue;
    const m = await runSearch(browser, s);
    resultats.push(m);
    // règle d'arrêt : facturation incertaine = réserve non réconciliée
    const incertaines = m.comptabilite.reservations.filter((r) => !r.resolue);
    if (incertaines.length > 0) {
      console.log(`⚠ facturation incertaine (${incertaines.length} réserve(s) conservée(s)) — ARRÊT des essais suivants`);
      break;
    }
  }
  await browser.close();

  const bilan = {
    base: BASE,
    basesDeDonnees: DB_PATH,
    cache: cacheStats(),
    recherches: resultats,
  };
  writeFileSync("/tmp/opencode/essai-reel-resultats.json", JSON.stringify(bilan, null, 2));
  console.log(`\n✔ ${resultats.length} recherche(s) — résultats : /tmp/opencode/essai-reel-resultats.json — captures : ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
