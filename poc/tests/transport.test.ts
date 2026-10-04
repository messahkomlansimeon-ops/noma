/**
 * Transport HTTP maîtrisé + serveur local : gzip, pinning, taille décompressée.
 * Serveur sur 127.0.0.1 uniquement — transport appelé directement (sans la
 * couche validation SSRF de safeFetch, qui refuse le loopback par conception).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import {
  httpTransport,
  readBodyLimited,
  DEFAULT_LIMITS,
  SafeFetchError,
  type TransportResponse,
} from "../lib/fetch";
import type { IncomingMessage, ServerResponse } from "node:http";

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const read = async (resp: TransportResponse, limits = DEFAULT_LIMITS): Promise<string> => {
  const r = await readBodyLimited(resp, "https://test.local/x", limits, Date.now() + 5_000);
  return r.text;
};

describe("transport maîtrisé — gzip réel via serveur local", () => {
  test("page gzip : un seul passage de décompression, contenu intact", async () => {
    const payload = Buffer.from("<html><body>Annonce iPhone 12 — 135 000 FCFA</body></html>");
    const gz = gzipSync(payload);
    const srv = await startServer((req, res) => {
      if (req.url === "/gz") {
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Type", "text/html");
        res.end(gz);
      } else if (req.url === "/plain") {
        res.setHeader("Content-Type", "text/html");
        res.end(payload);
      } else {
        res.setHeader("Content-Type", "text/plain");
        res.end("404");
      }
    });
    try {
      const port = Number(srv.base.split(":")[2]);
      const respGz = await httpTransport(`http://127.0.0.1:${port}/gz`, new AbortController().signal, {
        pin: { address: "127.0.0.1", port },
        limits: DEFAULT_LIMITS,
      });
      assert.equal(respGz.status, 200);
      const body = await read(respGz);
      assert.ok(body.includes("Annonce iPhone 12"), body.slice(0, 80));

      const respPlain = await httpTransport(`http://127.0.0.1:${port}/plain`, new AbortController().signal, {
        pin: { address: "127.0.0.1", port },
        limits: DEFAULT_LIMITS,
      });
      const body2 = await read(respPlain);
      assert.ok(body2.includes("135 000 FCFA"));
    } finally {
      await srv.close();
    }
  });

  test("réponse décompressée > plafond → too-large (annulation réelle)", async () => {
    const srv = await startServer((req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("x".repeat(3_000_000)); // 3 Mo > 2 Mo
    });
    try {
      const port = Number(srv.base.split(":")[2]);
      const limits = { ...DEFAULT_LIMITS, maxBytes: 2_000_000 };
      await assert.rejects(
        async () => {
          const resp = await httpTransport(`http://127.0.0.1:${port}/big`, new AbortController().signal, {
            pin: { address: "127.0.0.1", port },
            limits,
          });
          await readBodyLimited(resp, `http://127.0.0.1:${port}/big`, limits, Date.now() + 5_000);
        },
        (e: SafeFetchError) => e.kind === "too-large",
      );
    } finally {
      await srv.close();
    }
  });

  test("lenteur au-delà du délai → timeout", async () => {
    const srv = await startServer((req, res) => {
      // réponse tronquée : jamais end(), le client doit couper au délai
      res.setHeader("Content-Type", "text/plain");
      res.write("debut");
    });
    try {
      const port = Number(srv.base.split(":")[2]);
      await assert.rejects(
        () =>
          httpTransport(`http://127.0.0.1:${port}/lent`, new AbortController().signal, {
            pin: { address: "127.0.0.1", port },
            limits: { ...DEFAULT_LIMITS, totalMs: 300 },
          }),
        (e: SafeFetchError) => e.kind === "timeout",
      );
    } finally {
      await srv.close();
    }
  });
});