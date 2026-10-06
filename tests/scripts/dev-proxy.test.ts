import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import { after, describe, test } from "node:test";
import {
  DEV_PROXY_DEFAULT_PORT,
  DEV_PROXY_DEFAULT_TARGET,
  DEV_PROXY_HOST,
  checkDevelopmentNodeEnv,
  createDevProxy,
  resolveDevProxyConfig,
  type DevProxy,
} from "../../scripts/dev-proxy";

/**
 * Relais de développement (scripts/dev-proxy.ts), testé SANS Next : deux mini-serveurs HTTP (la cible, et le client
 * qui parle au relais). Chaque test démarre son propre relais sur un port choisi par le système.
 */

const SECRET = "secret-de-test-du-relais-0123456789abcdef";
const ATTACKER_SECRET = "secret-forge-par-un-client-hostile-xxxxxxxx";

// Le relais refuse tout NODE_ENV autre qu'absent, vide ou « development » : ces tests ne dépendent pas de l'environnement ambiant.
const ambientNodeEnv = process.env.NODE_ENV;
delete (process.env as Record<string, string | undefined>).NODE_ENV;

/** Exécute `run` avec NODE_ENV = `value` (undefined : variable absente), puis rétablit la valeur d'avant. */
function withNodeEnv<T>(value: string | undefined, run: () => T): T {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previous;
  }
}

const cleanups: Array<() => Promise<void>> = [];
/** Processus lancés par les tests : tués à la fin même si une assertion a échoué avant leur arrêt normal. */
const spawned: ChildProcess[] = [];
after(async () => {
  if (ambientNodeEnv !== undefined) (process.env as Record<string, string | undefined>).NODE_ENV = ambientNodeEnv;
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

interface Upstream {
  server: http.Server;
  port: number;
  origin: string;
}

async function startUpstream(handler: http.RequestListener, onUpgrade?: (req: http.IncomingMessage, socket: net.Socket) => void): Promise<Upstream> {
  const server = http.createServer(handler);
  // Les sockets mis à niveau sortent du suivi du serveur HTTP : on les suit nous-mêmes pour la fermeture.
  const upgraded = new Set<net.Socket>();
  if (onUpgrade) {
    server.on("upgrade", (req, socket) => {
      upgraded.add(socket as net.Socket);
      socket.on("close", () => upgraded.delete(socket as net.Socket));
      onUpgrade(req, socket as net.Socket);
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of upgraded) socket.destroy();
      }),
  );
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

async function startProxy(
  target: string,
  log?: (line: string) => void,
  publicOrigin?: string,
): Promise<{ proxy: DevProxy; port: number }> {
  const proxy = createDevProxy({ target, secret: SECRET, port: 0, log, ...(publicOrigin ? { publicOrigin } : {}) });
  const address = await proxy.listen();
  cleanups.push(() => proxy.close());
  return { proxy, port: address.port };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

function request(
  port: number,
  options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const echoHeaders: http.RequestListener = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ headers: req.headers, rawHeaders: req.rawHeaders, url: req.url, method: req.method }));
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} : délai de ${ms} ms dépassé`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("relais de développement : en-têtes de confiance", () => {
  test("le secret et l'adresse du client sont écrits par le relais ; les en-têtes usurpés sont supprimés (toutes casses, doublons)", async () => {
    const upstream = await startUpstream(echoHeaders);
    const { port } = await startProxy(upstream.origin);
    const reply = await request(port, {
      method: "POST",
      path: "/api/auth/otp/request",
      headers: {
        "X-Noma-Proxy-Secret": [ATTACKER_SECRET, "autre-valeur"],
        "x-forwarded-for": "203.0.113.9, 198.51.100.1",
        "X-Forwarded-For": "6.6.6.6",
        origin: "http://localhost:3212",
        cookie: "noma_auth=abc",
        "content-type": "application/json",
      },
      body: JSON.stringify({ phone: "+2250700000042" }),
    });
    assert.equal(reply.status, 200);
    const seen = JSON.parse(reply.body) as { headers: Record<string, string>; rawHeaders: string[]; url: string; method: string };
    assert.equal(seen.headers["x-noma-proxy-secret"], SECRET);
    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
    // Une seule ligne de chaque en-tête de confiance : rien d'hérité du client.
    const names = seen.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    assert.equal(names.filter((name) => name === "x-noma-proxy-secret").length, 1);
    assert.equal(names.filter((name) => name === "x-forwarded-for").length, 1);
    const everything = JSON.stringify(seen);
    for (const forged of [ATTACKER_SECRET, "autre-valeur", "203.0.113.9", "198.51.100.1", "6.6.6.6"]) {
      assert.equal(everything.includes(forged), false, `la valeur usurpée « ${forged} » ne doit pas atteindre la cible`);
    }
    // Le reste est transmis tel quel ; Host est réécrit vers la cible.
    assert.equal(seen.headers.origin, "http://localhost:3212");
    assert.equal(seen.headers.cookie, "noma_auth=abc");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
    assert.equal(seen.url, "/api/auth/otp/request");
    assert.equal(seen.method, "POST");
  });

  test("Forwarded, X-Real-IP, X-Forwarded-Host et X-Forwarded-Proto reçus du client ne sont jamais relayés (et rien ne les remplace)", async () => {
    const upstream = await startUpstream(echoHeaders);
    const { port } = await startProxy(upstream.origin);
    const seen = JSON.parse(
      (
        await request(port, {
          headers: {
            Forwarded: "for=6.6.6.6;host=evil.example;proto=https",
            "X-Real-IP": "6.6.6.6",
            "X-Forwarded-Host": "evil.example",
            "X-Forwarded-Proto": "https",
            "x-ordinaire": "conservé",
          },
        })
      ).body,
    ) as { headers: Record<string, string>; rawHeaders: string[] };
    for (const name of ["forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"]) {
      assert.equal(seen.headers[name], undefined, `${name} ne doit pas atteindre la cible`);
    }
    const names = seen.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    for (const name of ["forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"]) assert.equal(names.includes(name), false, name);
    assert.equal(JSON.stringify(seen).includes("evil.example"), false);
    assert.equal(seen.headers["x-ordinaire"], "conservé");
    assert.equal(seen.headers["x-noma-proxy-secret"], SECRET);
    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
  });

  test("sans aucun en-tête de confiance reçu, le relais les écrit quand même", async () => {
    const upstream = await startUpstream(echoHeaders);
    const { port } = await startProxy(upstream.origin);
    const seen = JSON.parse((await request(port)).body) as { headers: Record<string, string> };
    assert.equal(seen.headers["x-noma-proxy-secret"], SECRET);
    assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
  });

  test("les en-têtes de saut désignés par Connection ne sont pas relayés", async () => {
    const upstream = await startUpstream(echoHeaders);
    const { port } = await startProxy(upstream.origin);
    const seen = JSON.parse(
      (await request(port, { headers: { connection: "close, x-saut-perso", "x-saut-perso": "1", "x-normal": "2" } })).body,
    ) as { headers: Record<string, string> };
    assert.equal(seen.headers["x-saut-perso"], undefined);
    assert.equal(seen.headers["x-normal"], "2");
  });
});

describe("relais de développement : réponses", () => {
  test("Set-Cookie (plusieurs), Location, Content-Type et statut sont transmis ; Location vers la cible revient vers l'origine PUBLIQUE du relais", async () => {
    const upstream = await startUpstream((req, res) => {
      const own = req.socket.localPort as number;
      const locations: Record<string, string> = {
        "/vers-la-cible": `http://127.0.0.1:${own}/ailleurs?x=1`,
        "/alias-localhost": `http://localhost:${own}/ailleurs#ancre`,
        "/origine-nue": `http://127.0.0.1:${own}`,
        "/avec-requete": `http://localhost:${own}?x=1`,
        "/relatif": "/connexion?next=%2F",
        "/hors": "https://exemple.test/hors",
        // Voisins de la cible : même début de chaîne, mais ce n'est PAS la cible (aucune réécriture).
        "/port-voisin": `http://127.0.0.1:${own}9/x`,
        "/port-voisin-localhost": `http://localhost:${own}9/x`,
        "/domaine-voisin": `http://127.0.0.1:${own}.evil.example/x`,
        "/lettre-voisine": `http://localhost:${own}x/y`,
        "/autre-schema": `https://127.0.0.1:${own}/x`,
      };
      res.writeHead(302, [
        ["Set-Cookie", "noma_auth=abc; HttpOnly; Path=/; SameSite=Lax"],
        ["Set-Cookie", "noma_sid=def; Path=/"],
        ["Location", locations[req.url ?? ""] ?? "/inconnu"],
        ["Content-Type", "text/plain; charset=utf-8"],
        ["Connection", "close"],
      ]);
      res.end("redirigé");
    });
    const { port } = await startProxy(upstream.origin);
    const publicOrigin = `http://localhost:${port}`;
    const own = upstream.port;

    // L'en-tête Host fourni par le client n'est JAMAIS utilisé pour fabriquer l'adresse publique.
    const toTarget = await request(port, { path: "/vers-la-cible", headers: { host: "evil.example:80" } });
    assert.equal(toTarget.status, 302);
    assert.equal(toTarget.headers.location, `${publicOrigin}/ailleurs?x=1`, "Location vers la cible est réécrit vers l'origine publique du relais");
    assert.equal(JSON.stringify(toTarget.headers).includes("evil.example"), false);
    assert.deepEqual(toTarget.headers["set-cookie"], [
      "noma_auth=abc; HttpOnly; Path=/; SameSite=Lax",
      "noma_sid=def; Path=/",
    ]);
    assert.equal(toTarget.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(toTarget.body, "redirigé");

    const location = async (path: string) => (await request(port, { path })).headers.location;
    assert.equal(await location("/alias-localhost"), `${publicOrigin}/ailleurs#ancre`, "http://localhost:<port de la cible>/ aussi");
    assert.equal(await location("/origine-nue"), publicOrigin);
    assert.equal(await location("/avec-requete"), `${publicOrigin}?x=1`);
    assert.equal(await location("/relatif"), "/connexion?next=%2F");
    assert.equal(await location("/hors"), "https://exemple.test/hors", "une autre origine n'est jamais réécrite");
    // Voisins : le préfixe doit être l'origine EXACTE de la cible, suivie de « / », « ? », « # » ou de la fin.
    assert.equal(await location("/port-voisin"), `http://127.0.0.1:${own}9/x`);
    assert.equal(await location("/port-voisin-localhost"), `http://localhost:${own}9/x`);
    assert.equal(await location("/domaine-voisin"), `http://127.0.0.1:${own}.evil.example/x`);
    assert.equal(await location("/lettre-voisine"), `http://localhost:${own}x/y`);
    assert.equal(await location("/autre-schema"), `https://127.0.0.1:${own}/x`);
  });

  test("origine publique configurée (option) : c'est elle, et elle seule, qui remplace l'origine de la cible", async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(302, { location: `http://localhost:${req.socket.localPort as number}/suite` });
      res.end();
    });
    const { port } = await startProxy(upstream.origin, undefined, "http://localhost:4999");
    const reply = await request(port, { headers: { host: `localhost:${port}` } });
    assert.equal(reply.headers.location, "http://localhost:4999/suite");
    for (const bad of ["https://localhost:4999", "http://example.com:4999", "http://localhost:4999/chemin", "http://localhost:4999?x=1", "http://u:p@localhost:4999", "pas une adresse"]) {
      assert.throws(() => createDevProxy({ target: upstream.origin, secret: SECRET, publicOrigin: bad }), Error, bad);
    }
  });

  test("corps de requête et de réponse relayés intacts (POST JSON, statut 201)", async () => {
    const upstream = await startUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    const { port } = await startProxy(upstream.origin);
    const payload = JSON.stringify({ rawText: "iPhone 12 · 128 Go — é à ü 🙂" });
    const reply = await request(port, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal(reply.status, 201);
    assert.deepEqual(JSON.parse(reply.body), { received: payload });
  });

  test("cible injoignable : 502 JSON fixe, journal sans secret", async () => {
    const lines: string[] = [];
    // Port libéré : plus personne n'écoute.
    const probe = await startUpstream(echoHeaders);
    const closedOrigin = probe.origin;
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve());
      probe.server.closeAllConnections();
    });
    const { port } = await startProxy(closedOrigin, (line) => lines.push(line));
    const reply = await request(port, { path: "/x", headers: { "x-noma-proxy-secret": ATTACKER_SECRET } });
    assert.equal(reply.status, 502);
    assert.match(reply.headers["content-type"] ?? "", /application\/json/);
    assert.deepEqual(JSON.parse(reply.body), {
      error: { code: "dev_proxy_unreachable", message: "Le serveur de l'application ne répond pas (relais de développement)." },
    });
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      assert.equal(line.includes(SECRET), false);
      assert.equal(line.includes(ATTACKER_SECRET), false);
    }
  });
});

describe("relais de développement : refus de démarrer et adresse d'écoute", () => {
  const GOOD = { NODE_ENV: "development", NOMA_DEV_PROXY: "1", NOMA_AUTH_PROXY_SECRET: SECRET };

  test("configuration valide : port 3212 et cible http://127.0.0.1:3211 par défaut", () => {
    const config = resolveDevProxyConfig(GOOD);
    assert.deepEqual(config, { ok: true, port: DEV_PROXY_DEFAULT_PORT, target: DEV_PROXY_DEFAULT_TARGET, secret: SECRET, publicOrigin: undefined });
    assert.equal(DEV_PROXY_DEFAULT_PORT, 3212);
    assert.equal(DEV_PROXY_DEFAULT_TARGET, "http://127.0.0.1:3211");
    assert.equal(resolveDevProxyConfig({ ...GOOD, NODE_ENV: undefined }).ok, true, "NODE_ENV absent : accepté");
    const custom = resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY_PORT: "4000", NOMA_DEV_PROXY_TARGET: "http://localhost:4001/" });
    assert.deepEqual(custom, { ok: true, port: 4000, target: "http://localhost:4001", secret: SECRET, publicOrigin: undefined });
    const withPublic = resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY_PUBLIC_ORIGIN: "http://localhost:4000/" });
    assert.deepEqual(withPublic, { ok: true, port: 3212, target: DEV_PROXY_DEFAULT_TARGET, secret: SECRET, publicOrigin: "http://localhost:4000" });
    for (const bad of ["https://localhost:4000", "http://example.com", "http://localhost:4000/x", "n'importe quoi"]) {
      assert.equal(resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY_PUBLIC_ORIGIN: bad }).ok, false, bad);
    }
  });

  test("createDevProxy lui-même refuse tout NODE_ENV hors absent / vide / « development » (défense en profondeur, sans resolveDevProxyConfig)", () => {
    const refused = ["production", " production", "Production", "PRODUCTION", "prod", "test", "staging", "Development"];
    for (const value of refused) {
      assert.throws(
        () => withNodeEnv(value, () => createDevProxy({ target: DEV_PROXY_DEFAULT_TARGET, secret: SECRET, port: 0 })),
        (error: unknown) => error instanceof Error && error.message.includes(value.trim()) && !error.message.includes(SECRET),
        JSON.stringify(value),
      );
    }
    // Absent, vide ou « development » : la création réussit (rien n'écoute tant que listen() n'est pas appelé).
    for (const value of [undefined, "", "  ", "development", " development "]) {
      assert.doesNotThrow(
        () => withNodeEnv(value, () => createDevProxy({ target: DEV_PROXY_DEFAULT_TARGET, secret: SECRET, port: 0 })),
        JSON.stringify(value),
      );
    }
  });

  test("règle NODE_ENV partagée (checkDevelopmentNodeEnv) : absent, vide ou exactement « development » après nettoyage", () => {
    for (const value of [undefined, "", "   ", "development", "\tdevelopment "]) assert.deepEqual(checkDevelopmentNodeEnv(value), { ok: true });
    for (const value of ["production", " production", "Production", "PRODUCTION", "prod", "test", "Development"]) {
      assert.equal(checkDevelopmentNodeEnv(value).ok, false, value);
    }
  });

  test("refus de tout NODE_ENV hors développement, même avec le drapeau et un bon secret (production sous toutes ses graphies, prod, test)", () => {
    for (const value of ["production", " production", "Production", "PRODUCTION", "prod", "test", "staging", "Development"]) {
      const config = resolveDevProxyConfig({ ...GOOD, NODE_ENV: value });
      assert.equal(config.ok, false, `NODE_ENV=${JSON.stringify(value)}`);
      assert.ok((config as { reason: string }).reason.includes(value.trim()));
      assert.equal(JSON.stringify(config).includes(SECRET), false);
    }
    const production = resolveDevProxyConfig({ ...GOOD, NODE_ENV: "production" });
    assert.match((production as { reason: string }).reason, /production/);
    // Absent, vide ou « development » (espaces ignorés) : accepté.
    for (const value of [undefined, "", "   ", "development", " development "]) {
      assert.equal(resolveDevProxyConfig({ ...GOOD, NODE_ENV: value }).ok, true, JSON.stringify(value));
    }
  });

  test("refus sans le drapeau NOMA_DEV_PROXY=1 (absent, vide, « true », « 0 »)", () => {
    for (const flag of [undefined, "", "true", "0", "yes"]) {
      const config = resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY: flag });
      assert.equal(config.ok, false, `drapeau ${String(flag)}`);
      assert.match((config as { reason: string }).reason, /NOMA_DEV_PROXY=1/);
    }
  });

  test("refus d'un secret absent ou de moins de 32 octets (sans jamais l'afficher)", () => {
    for (const secret of [undefined, "", "trop-court", "x".repeat(31)]) {
      const config = resolveDevProxyConfig({ ...GOOD, NOMA_AUTH_PROXY_SECRET: secret });
      assert.equal(config.ok, false);
      if (secret) assert.equal(JSON.stringify(config).includes(secret), false);
    }
    assert.equal(resolveDevProxyConfig({ ...GOOD, NOMA_AUTH_PROXY_SECRET: "x".repeat(32) }).ok, true);
    assert.equal(resolveDevProxyConfig({ ...GOOD, NOMA_AUTH_PROXY_SECRET: undefined, NOMA_PROXY_SECRET: SECRET }).ok, true, "repli NOMA_PROXY_SECRET");
  });

  test("refus d'une cible hors du poste (le secret ne part jamais ailleurs), d'un port invalide", () => {
    for (const target of [
      "http://example.com:3211",
      "http://192.168.1.20:3211",
      "https://127.0.0.1:3211",
      "http://127.0.0.1:3211@evil.example",
      "http://user:pass@127.0.0.1:3211",
      "http://127.0.0.1:3211/api",
      "pas une adresse",
    ]) {
      assert.equal(resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY_TARGET: target }).ok, false, target);
      assert.throws(() => createDevProxy({ target, secret: SECRET }), Error, target);
    }
    for (const port of ["0", "65536", "abc", "-1", "3212.5"]) {
      assert.equal(resolveDevProxyConfig({ ...GOOD, NOMA_DEV_PROXY_PORT: port }).ok, false, port);
    }
    assert.throws(() => createDevProxy({ target: DEV_PROXY_DEFAULT_TARGET, secret: "court" }));
  });

  test("le relais n'écoute que 127.0.0.1 (jamais 0.0.0.0, ni une autre adresse de la boucle locale)", async () => {
    const upstream = await startUpstream(echoHeaders);
    const { proxy, port } = await startProxy(upstream.origin);
    const address = proxy.server.address() as net.AddressInfo;
    assert.equal(DEV_PROXY_HOST, "127.0.0.1");
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.family, "IPv4");
    // 127.0.0.2 est aussi la boucle locale (Linux) : un relais ouvert sur 0.0.0.0 y répondrait.
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: "127.0.0.2", port }, () => {
        socket.destroy();
        resolve("connecté");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "erreur"));
    });
    assert.notEqual(outcome, "connecté", "127.0.0.2 ne doit pas atteindre le relais");
    assert.ok(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH"].includes(outcome), outcome);
  });
});

describe("relais de développement : flux en continu et coupure", () => {
  test("la réponse arrive au fil de l'eau (premier morceau reçu pendant que la cible n'a pas fini)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"event":"un"}\n');
      void gate.then(() => {
        res.write('{"event":"deux"}\n');
        res.end();
      });
    });
    const { port } = await startProxy(upstream.origin);
    const firstChunk = new Promise<string>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/search", agent: false }, (res) => {
        const parts: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          parts.push(chunk);
          if (parts.length === 1) resolve(chunk);
        });
        res.on("end", () => resolve(parts.join("")));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
    // La cible n'a PAS terminé (la porte est fermée) : le premier événement doit déjà être arrivé.
    const early = await withTimeout(firstChunk, 3_000, "premier morceau");
    assert.equal(early, '{"event":"un"}\n');
    release();
  });

  test("le corps de la requête est relayé en continu vers la cible", async () => {
    let received: () => void = () => {};
    const firstPart = new Promise<string>((resolve) => {
      received = () => resolve("reçu");
    });
    const upstream = await startUpstream((req, res) => {
      req.once("data", () => received());
      req.on("end", () => res.end("fini"));
      req.resume();
    });
    const { port } = await startProxy(upstream.origin);
    const done = new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/upload", agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.write("premier morceau");
      // Le client n'a pas fini d'envoyer : la cible doit déjà avoir reçu le premier morceau.
      void withTimeout(firstPart, 3_000, "premier morceau de la requête").then(
        () => req.end("suite"),
        (error: unknown) => {
          req.destroy();
          reject(error);
        },
      );
    });
    assert.equal(await withTimeout(done, 5_000, "requête"), "fini");
  });

  test("la coupure du client est propagée à la cible", async () => {
    let upstreamClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const timer = setInterval(() => res.write('{"tick":1}\n'), 40);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    const { port } = await startProxy(upstream.origin);
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/search", agent: false }, (res) => {
        res.once("data", () => {
          // Premier événement reçu : le client coupe la connexion (onglet fermé).
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("aucun événement reçu")), 3_000).unref();
    });
    await withTimeout(closed, 3_000, "coupure vue par la cible");
  });

  test("l'abandon du client n'est PAS journalisé comme « cible injoignable » ; une vraie cible injoignable l'est", async () => {
    const lines: string[] = [];
    let upstreamClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    let slowAborted: () => void = () => {};
    const slowSeen = new Promise<void>((resolve) => {
      slowAborted = resolve;
    });
    const upstream = await startUpstream((req, res) => {
      if (req.url === "/lente") {
        // Réponse attendue longtemps : les en-têtes ne sont PAS encore partis quand le client abandonne.
        const timer = setTimeout(() => res.end("trop tard"), 4_000);
        res.on("close", () => {
          clearTimeout(timer);
          slowAborted();
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const timer = setInterval(() => res.write('{"tick":1}\n'), 30);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    const { port } = await startProxy(upstream.origin, (line) => lines.push(line));
    // Abandon AVANT les en-têtes de réponse (page quittée, requête annulée) : c'est le cas qui produisait « cible injoignable (ECONNRESET) ».
    for (let index = 0; index < 3; index += 1) {
      const early = http.get({ host: "127.0.0.1", port, path: "/lente", agent: false });
      early.on("error", () => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      early.destroy();
    }
    await withTimeout(slowSeen, 3_000, "abandon précoce vu par la cible");
    // Cinq clients abandonnent en pleine réponse (onglets fermés) : la coupure remonte vers la cible (ECONNRESET sur la requête
    // du relais), ce qui n'est pas une panne de la cible.
    for (let index = 0; index < 5; index += 1) {
      await new Promise<void>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/api/search", agent: false }, (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
      });
    }
    await withTimeout(closed, 3_000, "coupure vue par la cible");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(lines, [], "aucune ligne de journal pour un abandon du client");

    // Contrôle positif : une vraie cible injoignable reste journalisée (code système seulement).
    const probe = await startUpstream(echoHeaders);
    const closedOrigin = probe.origin;
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve());
      probe.server.closeAllConnections();
    });
    const other: string[] = [];
    const down = await startProxy(closedOrigin, (line) => other.push(line));
    assert.equal((await request(down.port)).status, 502);
    assert.equal(other.length, 1);
    assert.match(other[0], /cible injoignable \(ECONNREFUSED\)/);
  });

  test("la cible qui coupe en pleine réponse est vue par le client (pas de réponse tronquée présentée comme complète)", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("début");
      setTimeout(() => res.destroy(), 50);
    });
    const { port } = await startProxy(upstream.origin);
    const outcome = await withTimeout(
      new Promise<string>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.complete ? "complet" : "incomplet"));
          res.on("error", () => resolve("erreur"));
          res.on("close", () => resolve(res.complete ? "complet" : "incomplet"));
        });
        req.on("error", () => resolve("erreur"));
      }),
      3_000,
      "réponse",
    );
    assert.notEqual(outcome, "complet");
  });
});

describe("relais de développement : mise à niveau (rechargement à chaud de Next)", () => {
  test("la mise à niveau passe par la même politique d'en-têtes, puis les données circulent dans les deux sens", async () => {
    let seenHeaders: IncomingHttpHeaders = {};
    const upstream = await startUpstream(echoHeaders, (req, socket) => {
      seenHeaders = req.headers;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk as Buffer])));
    });
    const { port } = await startProxy(upstream.origin);
    const socket = net.connect({ host: "127.0.0.1", port });
    const received: string[] = [];
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      [
        "GET /_next/webpack-hmr HTTP/1.1",
        `Host: localhost:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `X-Noma-Proxy-Secret: ${ATTACKER_SECRET}`,
        "X-Forwarded-For: 6.6.6.6",
        "Origin: http://localhost:3212",
        "",
        "",
      ].join("\r\n"),
    );
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = () => (received.join("").includes("101 Switching Protocols") ? resolve() : setTimeout(check, 20));
        check();
      }),
      3_000,
      "réponse 101",
    );
    socket.write("bonjour");
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = () => (received.join("").includes("echo:bonjour") ? resolve() : setTimeout(check, 20));
        check();
      }),
      3_000,
      "écho",
    );
    socket.destroy();
    assert.equal(seenHeaders["x-noma-proxy-secret"], SECRET);
    assert.equal(seenHeaders["x-forwarded-for"], "127.0.0.1");
    assert.equal(seenHeaders.host, `127.0.0.1:${upstream.port}`);
    assert.equal(seenHeaders.origin, "http://localhost:3212");
    assert.equal(JSON.stringify(seenHeaders).includes(ATTACKER_SECRET), false);
  });
});

describe("relais de développement : aucun secret dans les journaux", () => {
  test("ni le secret du relais, ni un secret usurpé n'apparaissent dans le journal, succès comme échec", async () => {
    const lines: string[] = [];
    const upstream = await startUpstream(echoHeaders);
    const { port } = await startProxy(upstream.origin, (line) => lines.push(line));
    await request(port, { headers: { "x-noma-proxy-secret": ATTACKER_SECRET } });
    await request(port, { path: "/?secret=" + SECRET });
    assert.equal(lines.some((line) => line.includes(SECRET) || line.includes(ATTACKER_SECRET)), false);
  });

  test("lancé comme programme : refus en production et sans drapeau (code 1), et aucun secret dans la sortie", async () => {
    const run = (env: Record<string, string | undefined>, stopAfterMs?: number) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/dev-proxy.ts"], {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        spawned.push(child);
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.on("exit", (code) => resolve({ code, output }));
        if (stopAfterMs) setTimeout(() => child.kill("SIGTERM"), stopAfterMs);
      });
    const production = await withTimeout(
      run({ NODE_ENV: "production", NOMA_DEV_PROXY: "1", NOMA_AUTH_PROXY_SECRET: SECRET }),
      30_000,
      "refus production",
    );
    assert.equal(production.code, 1);
    assert.match(production.output, /production/);
    assert.equal(production.output.includes(SECRET), false);
    // Les autres graphies et valeurs (lancé seul, comme `npm run dev:proxy`) sont refusées de la même façon.
    for (const value of ["Production", "PRODUCTION", "prod", "test"]) {
      const refused = await withTimeout(
        run({ NODE_ENV: value, NOMA_DEV_PROXY: "1", NOMA_AUTH_PROXY_SECRET: SECRET }),
        30_000,
        `refus ${value}`,
      );
      assert.equal(refused.code, 1, value);
      assert.ok(refused.output.includes(value), value);
      assert.equal(refused.output.includes(SECRET), false);
    }
    const noFlag = await withTimeout(run({ NOMA_AUTH_PROXY_SECRET: SECRET }), 30_000, "refus sans drapeau");
    assert.equal(noFlag.code, 1);
    assert.match(noFlag.output, /NOMA_DEV_PROXY=1/);
    assert.equal(noFlag.output.includes(SECRET), false);
  });

  test("lancé comme programme en développement : écoute, relaie avec le secret, s'arrête sur SIGTERM (code 0), sortie sans secret", async () => {
    const upstream = await startUpstream(echoHeaders);
    const freePort = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/dev-proxy.ts"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
        NOMA_DEV_PROXY: "1",
        NOMA_AUTH_PROXY_SECRET: SECRET,
        NOMA_DEV_PROXY_PORT: String(freePort),
        NOMA_DEV_PROXY_TARGET: upstream.origin,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = () => (output.includes("écoute sur") ? resolve() : setTimeout(check, 50));
        check();
      }),
      30_000,
      "démarrage du relais",
    );
    assert.match(output, new RegExp(`écoute sur http://127\\.0\\.0\\.1:${freePort}`));
    const seen = JSON.parse((await request(freePort, { headers: { "x-noma-proxy-secret": ATTACKER_SECRET } })).body) as {
      headers: Record<string, string>;
    };
    assert.equal(seen.headers["x-noma-proxy-secret"], SECRET);
    child.kill("SIGTERM");
    assert.equal(await withTimeout(exited, 10_000, "arrêt"), 0);
    assert.equal(output.includes(SECRET), false);
    assert.equal(output.includes(ATTACKER_SECRET), false);
  });
});
