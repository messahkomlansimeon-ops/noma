/**
 * Route POST /api/search (bêta privée) — limites de corps en OCTETS
 * (Unicode multi-octets inclus, Content-Length absent ou déclaré),
 * parcours nominal avec sources simulées (aucune dépense, aucune IA),
 * validation des champs structurés, concurrence, déconnexion client :
 * place libérée et comptabilité cohérente dans SQLite.
 *
 * Processus dédié : le runtime guard lit l'environnement au premier appel
 * (source simulées, Turnstile dérivé tests, IA désactivée — jamais de
 * dépense ni de source réelle ici).
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  NOMA_DB_PATH: `${process.env.TMPDIR ?? "/tmp"}/noma-route-${process.pid}/guard.sqlite`,
  NOMA_TURNSTILE_DISABLED: "1",
  NOMA_FAKE_SOURCES: "1",
  NOMA_AI_DISABLED: "1",
  NOMA_PROXY_SECRET: "secret-tests",
  NOMA_IP_SECRET: "ip-secret-tests",
});

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/search/route";
import { parseSearchEvent, SEARCH_BODY_MAX_BYTES, type SearchEvent } from "@/lib/contracts";
import { openGuardDb } from "../../lib/server/db";
import { createContinuationToken } from "../../lib/server/continuation";
import { pseudonymizeIp } from "../../lib/server/ip";

const DB_PATH = process.env.NOMA_DB_PATH!;
before(() => mkdirSync(DB_PATH.replace("/guard.sqlite", ""), { recursive: true }));

let db: ReturnType<typeof openGuardDb>["db"];
before(() => {
  db = openGuardDb(DB_PATH).db;
});

/** Headers d'un client « derrière le proxy de confiance » : IP distincte
 *  par test (buckets de quota indépendants). */
const headersFor = (ip: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "x-noma-proxy-secret": "secret-tests",
  "x-forwarded-for": ip,
  ...extra,
});

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

const nextRequestInit = (init: {
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
}): NextRequestInit =>
  ({
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body, duplex: "half" } : {}),
  }) as unknown as NextRequestInit;

const post = (body: BodyInit | undefined, headers: Record<string, string>): Promise<Response> =>
  POST(
    new NextRequest(
      "http://localhost:3000/api/search",
      nextRequestInit({ method: "POST", headers: { "content-type": "application/json", ...headers }, body }),
    ),
  );

const collectEvents = async (res: Response): Promise<SearchEvent[]> => {
  const events: SearchEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSearchEvent(line);
      if (event) events.push(event);
    }
  }
  return events;
};

/** Flux dont on observe la consommation : chaque pull sert un morceau ;
 *  `cancelled` passe à true si le lecteur interrompt la lecture. */
const trackedStream = (chunks: Uint8Array[]) => {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
};

const waitUntil = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition non atteinte avant l'échéance");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Serveur HTTP local isolé — vrai socket TCP, coupure client réelle ────────

type SearchServer = { url: string; close: () => Promise<void> };

/** Serveur qui rejoue le câblage du runtime Next : la requête entrante est
 *  convertie en NextRequest, la réponse NDJSON est pompée vers le socket, et
 *  une coupure client (socket fermé) ABORTE le signal de la requête —
 *  exactement ce que fait Next entre request.signal et la connexion. */
const startSearchServer = (): Promise<SearchServer> =>
  new Promise((resolve) => {
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      // coupure client → signal requête (comme le runtime Next)
      const disconnect = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) disconnect.abort();
      });
      const request = new NextRequest(`http://127.0.0.1${req.url ?? "/api/search"}`, {
        method: req.method,
        headers: req.headers as unknown as HeadersInit,
        body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
        duplex: "half",
        signal: disconnect.signal,
      } as unknown as ConstructorParameters<typeof NextRequest>[1]);
      const response = await POST(request);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.writeHead(response.status);
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || res.destroyed) break;
          if (!res.write(value)) {
            await new Promise<void>((r) => res.once("drain", () => r()));
          }
        }
      } catch {
        /* socket rompu par le client */
      }
      res.end();
    };

    const server: Server = createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/api/search`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });

describe("corps limité à 8 Ko — décision en OCTETS", () => {
  test("Content-Length déclaré > 8 Ko → 413 avant toute lecture", async () => {
    const res = await post(undefined, headersFor("203.0.113.1", { "content-length": String(SEARCH_BODY_MAX_BYTES + 1) }));
    assert.equal(res.status, 413);
    const payload = (await res.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "payload_too_large");
  });

  test("sans Content-Length, > 8 Ko (Unicode multi-octets) → 413, lecture INTERROMPUE", async () => {
    // 10 morceaux de 3 000 octets de « é » (2 octets/char) : 30 000 octets,
    // mais seulement 15 000 caractères — un comptage en caractères laisserait passer
    const chunk = new TextEncoder().encode("é".repeat(1_500));
    assert.equal(chunk.byteLength, 3_000);
    const { stream, state } = trackedStream(Array.from({ length: 10 }, () => chunk.slice()));
    const res = await post(stream, headersFor("203.0.113.2"));
    assert.equal(res.status, 413);
    const payload = (await res.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "payload_too_large");
    // lecture interrompue : jamais les 10 morceaux, et le flux est annulé
    assert.ok(state.pulls < 10, `lecture interrompue attendue, ${state.pulls} pulls`);
    assert.equal(state.cancelled, true, "le lecteur a annulé le corps après la limite");
  });

  test("exactement 8 Ko (Unicode inclus, JSON valide) → accepté, flux NDJSON", async () => {
    const small = JSON.stringify({ text: "iPhone 12 à Abidjan", mode: "achat" });
    const padded = small + " ".repeat(SEARCH_BODY_MAX_BYTES - Buffer.byteLength(small));
    assert.equal(Buffer.byteLength(padded), SEARCH_BODY_MAX_BYTES);
    const res = await post(padded, headersFor("203.0.113.3"));
    assert.equal(res.status, 200);
    const events = await collectEvents(res);
    assert.equal(events[0]?.type, "started");
    assert.ok(events.some((e) => e.type === "completed"));
  });

  test("un octet de plus → 413", async () => {
    const small = JSON.stringify({ text: "iPhone 12 à Abidjan", mode: "achat" });
    const padded = small + " ".repeat(SEARCH_BODY_MAX_BYTES - Buffer.byteLength(small) + 1);
    const res = await post(padded, headersFor("203.0.113.4"));
    assert.equal(res.status, 413);
  });
});

describe("champs structurés — validation avant admission", () => {
  const base = { text: "iPhone 12", mode: "achat" };
  const postJson = (body: unknown, ip = "203.0.113.5") =>
    post(JSON.stringify(body), headersFor(ip));

  test("budget négatif → 400", async () => {
    const res = await postJson({ ...base, budgetFcfa: -1 });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_request");
  });

  test("mode inconnu → 400", async () => {
    const res = await postJson({ ...base, mode: "location" });
    assert.equal(res.status, 400);
  });

  test("texte > 1 000 caractères → 400", async () => {
    const res = await postJson({ ...base, text: "a".repeat(1_001) });
    assert.equal(res.status, 400);
  });

  test("localisation > 120 caractères → 400", async () => {
    const res = await postJson({ ...base, location: "a".repeat(121) });
    assert.equal(res.status, 400);
  });

  test("continuation signée valide acceptée ; réponse hors options refusée", async () => {
    const ip = "203.0.113.55";
    const sessionId = "session-continuation";
    const text = "Je cherche une console";
    const token = createContinuationToken({
      sessionId,
      ipHash: pseudonymizeIp(ip, "ip-secret-tests"),
      text,
      clarificationId: "product-intent",
      options: ["Console de jeux", "Meuble console"],
      secret: "ip-secret-tests",
    });
    const headers = headersFor(ip, { cookie: `noma_sid=${sessionId}` });
    const invalid = await post(JSON.stringify({
      text, mode: "achat", continuationToken: token,
      clarification: { id: "product-intent", answer: "Téléphone" },
    }), headers);
    assert.equal(invalid.status, 403);
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "invalid_continuation");

    const valid = await post(JSON.stringify({
      text, mode: "achat", continuationToken: token,
      clarification: { id: "product-intent", answer: "Console de jeux" },
    }), headers);
    assert.equal(valid.status, 200);
    assert.ok((await collectEvents(valid)).some((event) => event.type === "completed"));
  });

  test("budget non numérique → 400", async () => {
    const res = await postJson({ ...base, budgetFcfa: "150000" });
    assert.equal(res.status, 400);
  });
});

describe("parcours nominal — sources simulées, IA désactivée (aucune dépense)", () => {
  test("flux NDJSON complet, cookie de session posé, comptabilité propre", async () => {
    const body = JSON.stringify({
      text: "iPhone 12 à Abidjan",
      mode: "achat",
      budgetFcfa: 150_000,
      location: "Cocody",
    });
    const res = await post(body, headersFor("203.0.113.6"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.ok(cookie.includes("noma_sid="), "cookie de session créé si absent");
    assert.ok(cookie.includes("HttpOnly"));

    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "started");
    const started = events[0] as Extract<SearchEvent, { type: "started" }>;
    assert.equal(started.aiEnabled, false, "IA désactivée par interrupteur : aucune dépense possible");
    assert.ok(types.includes("results"));
    const results = events.find((e): e is Extract<SearchEvent, { type: "results" }> => e.type === "results")!;
    assert.ok(results.offers.length > 0, "les sources simulées produisent des offres");
    const completed = events.at(-1) as Extract<SearchEvent, { type: "completed" }>;
    assert.equal(completed.type, "completed");
    assert.deepEqual(
      completed.sources.map((s) => s.status).sort(),
      ["ok", "ok"],
    );

    // comptabilité : IA désactivée → ni réserve ni dépense ; place libérée
    await waitUntil(() => activeSearchesCount() === 0);
    assert.equal(countRows("reservations"), 0);
    assert.equal(countRows("ledger"), 0);
  });

  test("cookie de session fourni : aucun nouveau Set-Cookie", async () => {
    const res = await post(
      JSON.stringify({ text: "chargeur USB-C", mode: "achat" }),
      headersFor("203.0.113.7", { cookie: "noma_sid=sess-existant" }),
    );
    assert.equal(res.status, 200);
    await collectEvents(res);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

describe("concurrence et déconnexion client (HTTP réel)", () => {
  test("1 recherche active par session : 2e POST → 429 search_in_progress", async () => {
    const first = await post(
      JSON.stringify({ text: "canapé 3 places", mode: "achat" }),
      headersFor("203.0.113.8", { cookie: "noma_sid=sess-concurrence" }),
    );
    assert.equal(first.status, 200);
    // la source lente (1,5 s) maintient la recherche active : lecture partielle
    const reader = first.body!.getReader();
    const firstChunk = await reader.read();
    assert.equal(parseSearchEvent(new TextDecoder().decode(firstChunk.value!))?.type, "started");
    // déterminisme : attendre l'occupation RÉELLE de la place (SQLite) avant
    // le 2e POST — la lecture du 1er événement ne prouve pas l'admission
    await waitUntil(() => activeSearchesCount() === 1, 5_000);

    const second = await post(
      JSON.stringify({ text: "second besoin", mode: "achat" }),
      headersFor("203.0.113.9", { cookie: "noma_sid=sess-concurrence" }),
    );
    assert.equal(second.status, 429);
    const payload = (await second.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "search_in_progress");

    // fin de la première recherche : la place est libérée
    // (reader.cancel() — le flux est verrouillé par ce lecteur ; une erreur
    // ici doit faire échouer le test, jamais être masquée)
    await reader.cancel();
    await waitUntil(() => activeSearchesCount() === 0);

    // même session, même minute : le compteur anti-marteau compte AUSSI les
    // refus (3 essais en 1 minute) → 429 rate_limited + Retry-After
    const retrySameSession = await post(
      JSON.stringify({ text: "troisième besoin", mode: "achat" }),
      headersFor("203.0.113.9", { cookie: "noma_sid=sess-concurrence" }),
    );
    assert.equal(retrySameSession.status, 429);
    assert.equal(((await retrySameSession.json()) as { error: { code: string } }).error.code, "rate_limited");
    assert.ok(retrySameSession.headers.get("retry-after"), "Retry-After présent");

    // une AUTRE session est admise : la place globale est bien libérée
    const other = await post(
      JSON.stringify({ text: "autre acheteur", mode: "achat" }),
      headersFor("203.0.113.10", { cookie: "noma_sid=sess-autre" }),
    );
    assert.equal(other.status, 200);
    await collectEvents(other);
  });

  test("VRAIE coupure client (socket TCP) : annulation jusqu'à la source, place libérée AVANT la fin normale, aucune publication tardive", async () => {
    const server = await startSearchServer();
    try {
      const t0 = Date.now();
      const clientAbort = new AbortController();
      const res = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "noma_sid=sess-deconnexion-http",
        },
        body: JSON.stringify({ text: "télévision 55 pouces", mode: "achat" }),
        signal: clientAbort.signal,
      });
      assert.equal(res.status, 200);
      // la place est réellement occupée avant la coupure (preuve d'occupation)
      assert.equal(activeSearchesCount(), 1, "la recherche est active côté serveur");

      // lecture NDJSON réelle ; coupure du socket dès le premier événement —
      // bien avant la fin naturelle de la source lente (1,5 s)
      const received: SearchEvent[] = [];
      let endedByAbort = false;
      try {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseSearchEvent(line);
            if (event) received.push(event);
          }
          if (received.length > 0) clientAbort.abort();
        }
      } catch (e) {
        endedByAbort = (e as Error).name === "AbortError";
      }

      // la coupure est bien passée par le socket (pas une fin de flux normale)
      assert.equal(endedByAbort, true, "la lecture doit s'achever sur la coupure client, pas sur une fin normale");
      assert.ok(received.length > 0, "au moins un événement reçu avant la coupure");
      // aucune publication tardive : ni completed, ni results après coupure
      assert.ok(!received.some((e) => e.type === "completed"), "completed jamais reçu après coupure");

      // l'annulation a atteint le moteur : la place est libérée AVANT la fin
      // normale (~1,5 s de source lente) ; sinon ce délai serait dépassé
      const deadline = t0 + 10_000;
      while (activeSearchesCount() > 0) {
        if (Date.now() > deadline) throw new Error("place jamais libérée après déconnexion");
        await sleep(50);
      }
      const freedIn = Date.now() - t0;
      assert.ok(
        freedIn < 1_300,
        `place libérée en ${freedIn} ms — au-delà de 1,3 s l'annulation n'aurait pas atteint la source lente (1,5 s)`,
      );
      // IA désactivée dans ce test : aucune réserve, aucune dépense comptée
      assert.equal(countRows("reservations"), 0);
      assert.equal(countRows("ledger"), 0);
    } finally {
      await server.close();
    }
  });
});

function activeSearchesCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM active_searches").get() as { n: number | bigint };
  return Number(row.n);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}
