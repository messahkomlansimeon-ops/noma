import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isServerOrigin, proxyHeadersFor } from "../../scripts/e2e-proxy-headers";

const BASE = "http://localhost:3211";
const EXTRA = { "x-noma-proxy-secret": "secret-de-test", "x-forwarded-for": "198.51.100.21" };

describe("e2e:ui : en-têtes du proxy de confiance réservés à l'origine du serveur de test", () => {
  test("requête vers l'origine du serveur : les en-têtes sont ajoutés, les autres conservés", () => {
    const headers = proxyHeadersFor(`${BASE}/api/auth/session`, BASE, { accept: "application/json" }, EXTRA);
    assert.deepEqual(headers, { accept: "application/json", ...EXTRA });
    assert.equal(isServerOrigin(`${BASE}/`, `${BASE}/`), true);
  });

  test("tout autre hôte, port, schéma ou astuce d'URL : aucun en-tête du proxy", () => {
    for (const url of [
      "https://evil.example/collect",
      "http://localhost:3212/api/auth/session",
      "https://localhost:3211/api",
      "http://localhost/api",
      "http://localhost.evil.example:3211/api",
      "http://127.0.0.1:3211/api",
      "http://localhost:3211@evil.example/api",
      "https://fonts.googleapis.com/css2",
      "data:text/plain,x",
      "pas une url",
      "",
    ]) {
      const headers = proxyHeadersFor(url, BASE, { accept: "*/*" }, EXTRA);
      assert.deepEqual(headers, { accept: "*/*" }, url);
      assert.equal(isServerOrigin(url, BASE), false, url);
    }
  });

  test("les en-têtes reçus ne sont pas modifiés en place ; un en-tête déjà présent est remplacé sans doublon de casse", () => {
    const incoming = { "X-Noma-Proxy-Secret": "ancien", accept: "*/*" };
    const headers = proxyHeadersFor(`${BASE}/x`, BASE, incoming, EXTRA);
    assert.equal(headers["x-noma-proxy-secret"], "secret-de-test");
    assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === "x-noma-proxy-secret").length, 1);
    assert.equal(incoming["X-Noma-Proxy-Secret"], "ancien");
  });
});
