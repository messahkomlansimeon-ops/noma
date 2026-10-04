import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  safeFetch,
  validateTarget,
  SafeFetchError,
  DEFAULT_LIMITS,
  type TransportResponse,
  type TransportDeps,
} from "../lib/fetch";

const ok = (body = "ok"): TransportResponse => ({
  status: 200,
  headers: {},
  body,
});

describe("validateTarget — URL non fiable", () => {
  test("HTTP/HTTPS acceptés", () => {
    assert.equal(validateTarget("https://ci.coinafrique.com/search").protocol, "https:");
    assert.equal(validateTarget("http://example.com/a").protocol, "http:");
  });

  test("autres protocoles refusés", () => {
    for (const u of ["ftp://example.com/a", "file:///etc/passwd", "data:text/html,x"]) {
      assert.throws(() => validateTarget(u), SafeFetchError);
    }
  });

  test("identifiants intégrés refusés", () => {
    assert.throws(
      () => validateTarget("https://user:pass@example.com/"),
      (e: SafeFetchError) => e.kind === "blocked",
    );
  });

  test("ports non nécessaires refusés", () => {
    assert.throws(() => validateTarget("https://example.com:8080/"), SafeFetchError);
    assert.doesNotThrow(() => validateTarget("https://example.com:443/"));
  });

  test("URL non parsable", () => {
    assert.throws(() => validateTarget("http://"), SafeFetchError);
  });
});

describe("safeFetch — transport simulé", () => {
  const deps = (ips: string[], resp?: TransportResponse): TransportDeps => ({
    resolve: async () => ips,
    load: async () => resp ?? ok(),
  });

  test("destination publique → OK", async () => {
    const r = await safeFetch("https://example.com/annonce", {
      deps: deps(["93.184.216.34"]),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
  });

  test("localhost refusé", async () => {
    await assert.rejects(
      () => safeFetch("http://localhost/secret", { deps: deps(["127.0.0.1"]) }),
      (e: SafeFetchError) => e.kind === "blocked",
    );
  });

  test("IPv6 locale refusée (::1, fe80, fc00)", async () => {
    for (const ip of ["::1", "fe80::1", "fc00::1"]) {
      await assert.rejects(
        () => safeFetch("http://example.com/", { deps: deps([ip]) }),
        (e: SafeFetchError) => e.kind === "blocked",
      );
    }
  });

  test("métadonnées cloud refusées (169.254.169.254)", async () => {
    await assert.rejects(
      () => safeFetch("http://example.com/latest/meta-data", { deps: deps(["169.254.169.254"]) }),
      (e: SafeFetchError) => e.kind === "blocked",
    );
  });

  test("IPv4-mapped IPv6 refusée (::ffff:10.0.0.5)", async () => {
    await assert.rejects(
      () => safeFetch("http://example.com/", { deps: deps(["::ffff:10.0.0.5"]) }),
      (e: SafeFetchError) => e.kind === "blocked",
    );
  });

  test("redirection vers une adresse privée refusée (DNS-rebind)", async () => {
    const calls: string[] = [];
    const d: TransportDeps = {
      resolve: async (host) =>
        host === "first.example.com" ? ["93.184.216.34"] : ["192.168.1.5"],
      load: async (url) => {
        calls.push(url);
        if (url.includes("first.example.com")) {
          return {
            status: 302,
            headers: { location: "http://second.example.com/x" },
            body: "",
          };
        }
        return ok();
      },
    };
    await assert.rejects(
      () => safeFetch("http://first.example.com/", { deps: d }),
      (e: SafeFetchError) => e.kind === "blocked",
    );
    assert.equal(calls.length, 1, "le chargement privé n'a jamais eu lieu");
  });

  test("plus de 3 redirections → too-many-redirects", async () => {
    let n = 0;
    const d: TransportDeps = {
      resolve: async () => ["93.184.216.34"],
      load: async () => {
        n++;
        return { status: 302, headers: { location: `http://example.com/hop${n}` }, body: "" };
      },
    };
    await assert.rejects(
      () => safeFetch("http://example.com/", { deps: d }),
      (e: SafeFetchError) => e.kind === "too-many-redirects",
    );
    assert.ok(n >= DEFAULT_LIMITS.maxRedirects + 1);
  });

  test("réponse trop volumineuse → too-large (annulée)", async () => {
    const chunk = new Uint8Array(1_000_000); // 1 Mo
    const d: TransportDeps = {
      resolve: async () => ["93.184.216.34"],
      load: async () => ({
        status: 200,
        headers: {},
        body: [chunk, chunk, chunk], // 3 Mo décompressés > 2 Mo
      }),
    };
    await assert.rejects(
      () => safeFetch("https://example.com/gross", { deps: d }),
      (e: SafeFetchError) => e.kind === "too-large",
    );
  });

  test("corps gzip décompressé et compté après décompression", async () => {
    const { gzipSync } = await import("node:zlib");
    const payload = gzipSync(Buffer.alloc(2_500_000, "a")); // 2,5 Mo décompressés
    const d: TransportDeps = {
      resolve: async () => ["93.184.216.34"],
      load: async () => ({
        status: 200,
        headers: { "content-encoding": "gzip" },
        body: [new Uint8Array(payload)],
      }),
    };
    await assert.rejects(
      () => safeFetch("https://example.com/gz", { deps: d }),
      (e: SafeFetchError) => e.kind === "too-large",
      "2,5 Mo décompressés dépassent le plafond de 2 Mo",
    );
  });

  test("réponse lente → timeout", async () => {
    const d: TransportDeps = {
      resolve: async () => ["93.184.216.34"],
      load: async (url, signal) => ({
        status: 200,
        headers: {},
        body: () =>
          (async function* () {
            yield new Uint8Array([104, 105]);
            await new Promise((_, rej) =>
              signal.addEventListener("abort", () =>
                rej(new DOMException("aborted", "AbortError")),
              ),
            );
            yield new Uint8Array([33]);
          })(),
      }),
    };
    await assert.rejects(
      () =>
        safeFetch("https://example.com/lent", {
          deps: d,
          limits: { totalMs: 120 },
        }),
      (e: SafeFetchError) => e.kind === "timeout",
    );
  });

  test("HTTP 500 → erreur réseau avec statut", async () => {
    await assert.rejects(
      () =>
        safeFetch("https://example.com/ko", {
          deps: deps(["93.184.216.34"], { status: 500, headers: {}, body: "boom" }),
        }),
      (e: SafeFetchError) => e.kind === "network" && e.message.includes("500"),
    );
  });
});