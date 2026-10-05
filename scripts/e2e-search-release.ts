/**
 * `npm run e2e:search-release` : mesure, sous un VRAI serveur Next, le délai de libération de la place de recherche
 * active après une coupure de connexion TCP (réserve du lot T1). NON inclus dans `npm test`.
 *
 * Pour chaque répétition : POST /api/search (source lente tenue par NOMA_FAKE_SLOW_MS côté serveur), lecture du premier
 * événement NDJSON, vérification que la place est bien occupée dans la base SQLite de garde, coupure du socket TCP,
 * puis mesure du temps jusqu'à la disparition de la ligne `active_searches`. Rien n'est corrigé ici : le script rapporte.
 *
 * Variables :
 *   NOMA_E2E_BASE_URL     origine du serveur (défaut http://localhost:3211)
 *   NOMA_DB_PATH          chemin de la base SQLite de garde, le MÊME que celui du serveur (lecture seule ici)
 *   NOMA_PROXY_SECRET     secret du reverse proxy de la recherche (repli : NOMA_AUTH_PROXY_SECRET) ; il permet de varier l'IP
 *                         pseudonymisée par répétition afin de ne pas être limité par les quotas de démarrage
 *   NOMA_E2E_REPEATS      nombre de répétitions (défaut 5)
 *   NOMA_E2E_RELEASE_BUDGET_MS  seuil attendu (défaut 5000)
 *   NOMA_E2E_RELEASE_OBSERVE_MS durée maximale d'observation par répétition (défaut 30000)
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const BASE = new URL(process.env.NOMA_E2E_BASE_URL ?? "http://localhost:3211");
const DB_PATH = process.env.NOMA_DB_PATH ?? "";
const PROXY_SECRET = process.env.NOMA_PROXY_SECRET ?? process.env.NOMA_AUTH_PROXY_SECRET ?? "";
const REPEATS = Number(process.env.NOMA_E2E_REPEATS ?? "5");
const BUDGET_MS = Number(process.env.NOMA_E2E_RELEASE_BUDGET_MS ?? "5000");
const OBSERVE_MS = Number(process.env.NOMA_E2E_RELEASE_OBSERVE_MS ?? "30000");

if (!DB_PATH || !PROXY_SECRET) {
  console.error("e2e:search-release : NOMA_DB_PATH et NOMA_PROXY_SECRET (ou NOMA_AUTH_PROXY_SECRET) sont requis.");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openGuard(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function activeSessions(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT session_id FROM active_searches")
    .all()
    .map((row) => String(row.session_id));
}

interface Measure {
  run: number;
  status: number | null;
  firstEvent: string | null;
  placeTakenBeforeCut: boolean | null;
  releasedAfterMs: number | null;
  note: string;
}

/** Ouvre la recherche, lit le premier événement et renvoie la requête (pour couper) et l'identifiant de session. */
function openSearch(run: number): Promise<{
  status: number;
  sessionId: string | null;
  firstEvent: string | null;
  cut: () => void;
}> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: "iPhone 12 en bon état à Abidjan", mode: "achat" });
    const request = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port,
        path: "/api/search",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          origin: BASE.origin,
          "x-noma-proxy-secret": PROXY_SECRET,
          "x-forwarded-for": `198.51.100.${100 + run}`,
        },
      },
      (response) => {
        const cookie = (response.headers["set-cookie"] ?? []).join(";");
        const sessionId = /noma_sid=([^;]+)/.exec(cookie)?.[1] ?? null;
        const status = response.statusCode ?? 0;
        let buffered = "";
        let settled = false;
        const finish = (firstEvent: string | null) => {
          if (settled) return;
          settled = true;
          resolve({ status, sessionId, firstEvent, cut: () => response.socket.destroy() });
        };
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline >= 0) {
            try {
              const event = JSON.parse(buffered.slice(0, newline)) as { type?: string; code?: string };
              finish(event.type ?? event.code ?? "inconnu");
            } catch {
              finish("illisible");
            }
          }
        });
        response.on("end", () => finish(buffered.trim() ? "fin sans premier événement" : null));
        response.on("error", () => finish(null));
      },
    );
    request.on("error", reject);
    request.setTimeout(60_000, () => request.destroy(new Error("délai de réponse dépassé")));
    request.end(body);
  });
}

async function main(): Promise<void> {
  // La base de garde n'existe qu'après la première recherche (le serveur la crée à la demande) : ouverture paresseuse.
  const opened: { db: DatabaseSync | null } = { db: null };
  const guard = () => (opened.db ??= openGuard());
  const measures: Measure[] = [];

  // Contrôle négatif : sans coupure, la place reste prise (la source lente tient la recherche) ; sinon la mesure ne prouverait rien.
  {
    const control = await openSearch(0);
    const held = control.status === 200 && control.sessionId !== null;
    await sleep(3_000);
    const stillTaken = held && activeSessions(guard()).includes(control.sessionId as string);
    console.log(`contrôle : place toujours prise 3000 ms après le premier événement, sans coupure : ${stillTaken}`);
    control.cut();
    for (let waited = 0; held && waited < OBSERVE_MS && activeSessions(guard()).includes(control.sessionId as string); waited += 50) {
      await sleep(50);
    }
    if (!stillTaken) {
      console.log("e2e:search-release : contrôle négatif non satisfait, la mesure serait sans valeur.");
      process.exit(1);
    }
  }

  for (let run = 1; run <= REPEATS; run += 1) {
    const before = opened.db ? activeSessions(opened.db).length : 0;
    const measure: Measure = {
      run,
      status: null,
      firstEvent: null,
      placeTakenBeforeCut: null,
      releasedAfterMs: null,
      note: before > 0 ? `${before} place(s) déjà active(s) avant le départ` : "",
    };
    measures.push(measure);

    let search: Awaited<ReturnType<typeof openSearch>>;
    try {
      search = await openSearch(run);
    } catch {
      measure.note = `${measure.note} ouverture impossible`.trim();
      continue;
    }
    measure.status = search.status;
    measure.firstEvent = search.firstEvent;
    if (search.status !== 200 || !search.sessionId) {
      measure.note = `${measure.note} recherche refusée (statut ${search.status})`.trim();
      search.cut();
      continue;
    }

    measure.placeTakenBeforeCut = activeSessions(guard()).includes(search.sessionId);
    search.cut();
    const cutAt = performance.now();
    const deadline = cutAt + OBSERVE_MS;
    let released = false;
    while (performance.now() < deadline) {
      if (!activeSessions(guard()).includes(search.sessionId)) {
        measure.releasedAfterMs = Math.round(performance.now() - cutAt);
        released = true;
        break;
      }
      await sleep(5);
    }
    if (!released) measure.note = `${measure.note} place NON libérée après ${OBSERVE_MS} ms`.trim();
    await sleep(500);
  }
  opened.db?.close();

  console.log("run  statut  premier événement  place prise  libérée après");
  for (const m of measures) {
    console.log(
      `${String(m.run).padEnd(4)} ${String(m.status ?? "-").padEnd(7)} ${String(m.firstEvent ?? "-").padEnd(18)} ` +
        `${String(m.placeTakenBeforeCut ?? "-").padEnd(12)} ${m.releasedAfterMs === null ? "jamais" : `${m.releasedAfterMs} ms`}` +
        (m.note ? `  [${m.note}]` : ""),
    );
  }
  const good = measures.filter((m) => m.placeTakenBeforeCut === true && m.releasedAfterMs !== null && m.releasedAfterMs < BUDGET_MS);
  console.log(`e2e:search-release : ${good.length}/${measures.length} répétitions libérées en moins de ${BUDGET_MS} ms.`);
  process.exitCode = good.length === measures.length ? 0 : 1;
}

main().catch(() => {
  console.error("e2e:search-release : erreur inattendue.");
  process.exit(1);
});
