import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { MenoUsageError, createMenoClient, parseUsage, provesNotSent, type MenoClient } from "../../lib/server/sms/meno";
import { createUsageCache } from "../../lib/server/sms/admin";
import { SmsLocalValidationError } from "../../lib/server/sms/validation";
import { startFakeMeno, type FakeMeno } from "./fake-meno";

const API_KEY = "fake_meno_key_for_tests_only_0001";
const TO = "+2250700000012";
const CONTENT = "noma : votre code est 123456. Il expire dans 5 min. Ne le partagez pas.";
const KEY = "otp-3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let fake: FakeMeno;
const waits: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  waits.push(ms);
};

before(async () => {
  fake = await startFakeMeno({ apiKey: API_KEY });
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  waits.length = 0;
});

function client(overrides: Partial<Parameters<typeof createMenoClient>[0]> = {}): MenoClient {
  return createMenoClient({ apiKey: API_KEY, baseUrl: fake.baseUrl, sleep, attemptTimeoutMs: 400, ...overrides });
}

const send = (c: MenoClient, overrides: Partial<{ to: string; content: string; idempotencyKey: string; deadlineMs: number }> = {}) =>
  c.send({ to: TO, content: CONTENT, idempotencyKey: KEY, ...overrides });

describe("client Meno contre le faux serveur", () => {
  test("202 accepted : requête conforme à la documentation (route, en-têtes, corps exact)", async () => {
    const outcome = await send(client());
    assert.deepEqual(outcome, { status: "accepted", httpStatus: 202, errorCode: null, providerId: "msg_000001", attempts: 1, replay: false });
    const [request] = fake.sendRequests();
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/send");
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(request.headers["idempotency-key"], KEY);
    assert.match(String(request.headers["content-type"]), /^application\/json/);
    assert.deepEqual(JSON.parse(request.body), { to: TO, content: CONTENT });
    assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(), ["content", "to"]);
    assert.equal(fake.messages.length, 1);
  });

  test("même clé : rejeu (replay) accepté, un seul message chez le fournisseur", async () => {
    const first = await send(client());
    const second = await send(client());
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    assert.equal(second.replay, true);
    assert.equal(second.providerId, first.providerId);
    assert.equal(fake.messages.length, 1);
    assert.equal(fake.sendRequests().length, 2);
  });

  test("même clé, autre texte ou autre destinataire : 409, échec définitif, jamais repris en boucle", async () => {
    await send(client());
    for (const changed of [{ content: `${CONTENT} bis` }, { to: "+2250700000099" }]) {
      fake.requests.length = 0;
      const outcome = await send(client(), changed);
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.httpStatus, 409);
      assert.equal(outcome.errorCode, "idempotency_conflict");
      assert.equal(outcome.attempts, 1);
      assert.equal(fake.sendRequests().length, 1, "une seule requête : le 409 n'est pas repris");
    }
    assert.deepEqual(waits, [], "aucune attente : aucune reprise");
  });

  test("401, 422, 502 : échecs définitifs, une seule requête, aucune attente", async () => {
    const cases: Array<[number, string]> = [[401, "unauthorized"], [422, "invalid_request"], [502, "provider_refused"]];
    for (const [status, code] of cases) {
      fake.reset();
      fake.queue({ kind: "status", status, body: { error: "x" } });
      const outcome = await send(client());
      assert.equal(outcome.status, "rejected", String(status));
      assert.equal(outcome.httpStatus, status);
      assert.equal(outcome.errorCode, code);
      assert.equal(fake.sendRequests().length, 1, `${status} n'est jamais repris`);
    }
    assert.deepEqual(waits, []);
  });

  test("clé de l'API invalide : 401 du faux serveur, rejected", async () => {
    const outcome = await send(client({ apiKey: "another_fake_key_0000000000" }));
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.httpStatus, 401);
  });

  test("autre refus 4xx ou 3xx : définitif ; autre erreur 5xx : incertain", async () => {
    fake.queue({ kind: "status", status: 400 });
    assert.deepEqual((await send(client())).status, "rejected");
    fake.queue({ kind: "status", status: 302, headers: { location: "https://elsewhere.example/send" } });
    const redirected = await send(client());
    assert.equal(redirected.status, "rejected");
    assert.equal(redirected.errorCode, "http_302");
    fake.queue({ kind: "status", status: 500 });
    const server = await send(client());
    assert.equal(server.status, "uncertain");
    assert.equal(server.errorCode, "http_500");
    assert.equal(fake.sendRequests().length, 3, "aucune reprise");
  });

  test("503 : incertain, AUCUNE reprise automatique, identifiant gardé s'il est fourni", async () => {
    fake.queue({ kind: "status", status: 503, body: { id: "msg_unsure_1", status: "unknown" } });
    const outcome = await send(client());
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.httpStatus, 503);
    assert.equal(outcome.errorCode, "provider_unavailable");
    assert.equal(outcome.providerId, "msg_unsure_1");
    assert.equal(outcome.attempts, 1);
    assert.equal(fake.sendRequests().length, 1);
    assert.deepEqual(waits, []);
  });

  test("statut unknown ou reserved : incertain, identifiant gardé, AUCUNE reprise", async () => {
    for (const reported of ["unknown", "reserved"]) {
      fake.reset();
      fake.queue({ kind: "reply-status", reportedStatus: reported });
      const outcome = await send(client(), { idempotencyKey: `key-${reported}-0001` });
      assert.equal(outcome.status, "uncertain", reported);
      assert.equal(outcome.errorCode, `provider_${reported}`);
      assert.equal(outcome.providerId, "msg_000001");
      assert.equal(outcome.httpStatus, 202);
      assert.equal(fake.sendRequests().length, 1, `${reported} n'est pas repris`);
    }
  });

  test("2xx avec statut inattendu, corps illisible ou trop gros : incertain, jamais accepté par défaut", async () => {
    fake.queue({ kind: "status", status: 202, body: { id: "msg_x", status: "queued" } });
    const odd = await send(client());
    assert.equal(odd.status, "uncertain");
    assert.equal(odd.errorCode, "unexpected_status");
    fake.queue({ kind: "status", status: 202, rawBody: "pas du json" });
    const garbled = await send(client());
    assert.equal(garbled.status, "uncertain");
    assert.equal(garbled.errorCode, "invalid_response");
    fake.queue({ kind: "status", status: 202, rawBody: "x".repeat(100_000) });
    assert.equal((await send(client())).status, "uncertain");
    fake.queue({ kind: "status", status: 200, body: {} });
    assert.equal((await send(client())).status, "uncertain");
    assert.equal(fake.sendRequests().length, 4);
  });

  test("429 : reprise avec la MÊME clé après l'attente indiquée, puis accepté", async () => {
    fake.queue({ kind: "status", status: 429, headers: { "retry-after": "3" }, body: { error: "rate" } });
    const outcome = await send(client());
    assert.equal(outcome.status, "accepted");
    assert.equal(outcome.attempts, 2);
    assert.deepEqual(waits, [3_000]);
    const requests = fake.sendRequests();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"], "même clé à la reprise");
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(fake.messages.length, 1);
  });

  test("429 sans Retry-After : attente par défaut ; plafond de 3 reprises puis échec rate_limited", async () => {
    fake.queue(...Array.from({ length: 10 }, () => ({ kind: "status" as const, status: 429 })));
    const outcome = await send(client());
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "rate_limited");
    assert.equal(outcome.httpStatus, 429);
    assert.equal(outcome.attempts, 4, "1 requête + 3 reprises");
    assert.deepEqual(waits, [2_000, 2_000, 2_000]);
    assert.equal(fake.messages.length, 0);
  });

  test("429 avec une attente trop longue ou au-delà du délai global : abandon sans reprise", async () => {
    fake.queue({ kind: "status", status: 429, headers: { "retry-after": "120" } });
    const tooLong = await send(client());
    assert.equal(tooLong.status, "failed");
    assert.equal(tooLong.attempts, 1);
    fake.queue({ kind: "status", status: 429, headers: { "retry-after": "5" } });
    const pastDeadline = await send(client(), { deadlineMs: 1_000 });
    assert.equal(pastDeadline.status, "failed");
    assert.equal(pastDeadline.attempts, 1);
    assert.deepEqual(waits, []);
  });

  test("coupure réseau AVANT la réponse : reprise avec la même clé, puis accepté sans second message", async () => {
    fake.queue({ kind: "drop" });
    const outcome = await send(client());
    assert.equal(outcome.status, "accepted");
    assert.equal(outcome.attempts, 2);
    assert.deepEqual(waits, [500]);
    const requests = fake.sendRequests();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
    assert.equal(fake.messages.length, 1);
  });

  test("coupures répétées : au plus 3 reprises, attente croissante, même clé, puis incertain", async () => {
    fake.queue({ kind: "drop" }, { kind: "drop" }, { kind: "drop" }, { kind: "drop" }, { kind: "drop" });
    const outcome = await send(client());
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.errorCode, "network_uncertain");
    assert.equal(outcome.attempts, 4, "1 requête + 3 reprises, pas davantage");
    assert.deepEqual(waits, [500, 1_000, 2_000]);
    const keys = new Set(fake.sendRequests().map((request) => request.headers["idempotency-key"]));
    assert.deepEqual([...keys], [KEY], "une seule clé pour toutes les tentatives");
  });

  test("délai réseau dépassé (aucune réponse) : le client rend la main, incertain après les reprises", async () => {
    fake.queue({ kind: "hang" }, { kind: "hang" }, { kind: "hang" }, { kind: "hang" });
    const started = Date.now();
    const outcome = await Promise.race([
      send(client({ attemptTimeoutMs: 120 })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("le client attend sans fin : pas de délai réseau")), 5_000)),
    ]);
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.errorCode, "network_uncertain");
    assert.equal(outcome.attempts, 4);
    assert.ok(Date.now() - started >= 4 * 100, "chaque tentative a attendu son délai");
    assert.ok(Date.now() - started < 4_000);
  });

  test("délai global : plus aucune requête après l'échéance", async () => {
    fake.queue({ kind: "hang" }, { kind: "hang" }, { kind: "hang" }, { kind: "hang" });
    const outcome = await send(client({ attemptTimeoutMs: 10_000, sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }), { deadlineMs: 400 });
    assert.equal(outcome.status, "uncertain");
    assert.ok(outcome.attempts >= 1 && outcome.attempts <= 2, `tentatives : ${outcome.attempts}`);
  });

  test("fournisseur injoignable (connexion refusée) : échec, pas d'incertitude, mêmes reprises", async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const freePort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const outcome = await send(createMenoClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${freePort}`, sleep, attemptTimeoutMs: 400 }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "network_unreachable");
    assert.equal(outcome.attempts, 4);
    assert.deepEqual(waits, [500, 1_000, 2_000]);
  });

  test("une coupure après une tentative possiblement reçue reste incertaine même si la suivante est refusée", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const outcome = await send(
      createMenoClient({
        apiKey: API_KEY,
        baseUrl: fake.baseUrl,
        sleep,
        fetchImpl: (async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
          throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
        }) as typeof fetch,
      }),
    );
    assert.equal(globalThis.fetch, original);
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.attempts, 4);
  });

  test("provesNotSent : seuls les codes qui prouvent que rien n'est parti", () => {
    const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]) assert.equal(provesNotSent(withCode(code)), true, code);
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT"]) assert.equal(provesNotSent(withCode(code)), false, code);
    assert.equal(provesNotSent(new DOMException("timeout", "TimeoutError")), false);
    assert.equal(provesNotSent(new Error("inconnue")), false);
    assert.equal(provesNotSent(Object.assign(new Error("agrégat"), { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] })), true);
    assert.equal(provesNotSent(Object.assign(new Error("agrégat"), { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] })), false);
  });

  test("contrôles locaux AVANT l'appel : pays, un seul segment, format de la clé", async () => {
    const c = client();
    const cases: Array<[Partial<{ to: string; content: string; idempotencyKey: string }>, string]> = [
      [{ to: "+33612345678" }, "invalid_recipient"],
      [{ to: "+2250700" }, "invalid_recipient"],
      [{ content: "a".repeat(161) }, "invalid_content"],
      [{ content: "â".repeat(71) }, "invalid_content"],
      [{ content: "" }, "invalid_content"],
      [{ idempotencyKey: "court" }, "invalid_key"],
      [{ idempotencyKey: "x".repeat(65) }, "invalid_key"],
    ];
    for (const [change, code] of cases) {
      await assert.rejects(send(c, change), (error: unknown) => error instanceof SmsLocalValidationError && error.code === code);
    }
    assert.equal(fake.requests.length, 0, "aucune requête n'est partie");
    assert.equal((await send(c, { content: "a".repeat(160) })).status, "accepted");
    assert.equal((await send(c, { content: "â".repeat(70), idempotencyKey: "ucs2-limit-0001" })).status, "accepted");
  });

  test("C1 — après une tentative qui a pu partir (coupure), toute issue finale non 2xx est `uncertain` (jamais failed ni rejected) ; code et statut HTTP conservés", async () => {
    const rateLimited = () => Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } }));
    const cases: Array<[string, Parameters<FakeMeno["queue"]>, number, string]> = [
      ["429 épuisé", rateLimited(), 429, "rate_limited"],
      ["401", [{ kind: "status", status: 401 }], 401, "unauthorized"],
      ["409", [{ kind: "status", status: 409 }], 409, "idempotency_conflict"],
      ["422", [{ kind: "status", status: 422 }], 422, "invalid_request"],
      ["502", [{ kind: "status", status: 502 }], 502, "provider_refused"],
      ["400", [{ kind: "status", status: 400 }], 400, "http_400"],
      ["404", [{ kind: "status", status: 404 }], 404, "http_404"],
      ["503", [{ kind: "status", status: 503 }], 503, "provider_unavailable"],
      ["500", [{ kind: "status", status: 500 }], 500, "http_500"],
    ];
    for (const [label, queue, httpStatus, code] of cases) {
      fake.reset();
      fake.queue({ kind: "drop" }, ...queue);
      const outcome = await send(client());
      assert.equal(outcome.status, "uncertain", `coupure puis ${label}`);
      assert.equal(outcome.httpStatus, httpStatus, label);
      assert.equal(outcome.errorCode, code, label);
    }
    // Coupures répétées jusqu'à l'épuisement des reprises : incertain (comportement d'avant, conservé).
    fake.reset();
    fake.queue({ kind: "drop" }, { kind: "drop" }, { kind: "drop" }, { kind: "drop" });
    const dropped = await send(client());
    assert.deepEqual({ status: dropped.status, code: dropped.errorCode, http: dropped.httpStatus }, { status: "uncertain", code: "network_uncertain", http: null });
    // Coupure puis réponse explicite « accepted » : accepté (une réponse 2xx explicite reste la seule preuve).
    fake.reset();
    fake.queue({ kind: "drop" });
    assert.equal((await send(client())).status, "accepted");
  });

  test("C1 — SANS tentative qui ait pu partir, les issues sont inchangées : 429 épuisé = failed, 401/409/422/502/400 = rejected, connexion refusée = failed", async () => {
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const limited = await send(client());
    assert.deepEqual({ status: limited.status, code: limited.errorCode }, { status: "failed", code: "rate_limited" });
    for (const status of [401, 409, 422, 502, 400]) {
      fake.reset();
      fake.queue({ kind: "status", status });
      assert.equal((await send(client())).status, "rejected", String(status));
    }
    const unreachable = await createMenoClient({ apiKey: API_KEY, baseUrl: "http://127.0.0.1:1", sleep, attemptTimeoutMs: 400 }).send({ to: TO, content: CONTENT, idempotencyKey: KEY });
    assert.deepEqual({ status: unreachable.status, code: unreachable.errorCode }, { status: "failed", code: "network_unreachable" });
  });

  test("C1 — le délai global dépassé après une coupure donne aussi `uncertain`", async () => {
    fake.queue({ kind: "drop" }, { kind: "status", status: 429, headers: { "retry-after": "5" } });
    let clock = 0;
    const outcome = await createMenoClient({
      apiKey: API_KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: 400, now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }).send({ to: TO, content: CONTENT, idempotencyKey: KEY, deadlineMs: 3_000 });
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.errorCode, "rate_limited");
  });

  test("le résultat et les erreurs ne contiennent ni la clé, ni le texte, ni le numéro", async () => {
    fake.queue({ kind: "status", status: 422, body: { error: `texte ${CONTENT} numéro ${TO} clé ${API_KEY}` } });
    const rejected = await send(client());
    const accepted = await send(client(), { idempotencyKey: "otp-other-0001" });
    for (const outcome of [rejected, accepted]) {
      const text = JSON.stringify(outcome);
      for (const secret of [API_KEY, CONTENT, TO, "123456", "0700000012"]) assert.equal(text.includes(secret), false, secret);
    }
  });
});

describe("consommation (GET /usage)", () => {
  test("lecture en liste blanche, en-tête d'autorisation, aucune autre donnée conservée", async () => {
    fake.setUsage({ accepted: 12, uncertain: 1, rejected: 2, accepted_amount_xof: 180, unit_price_xof: 15, currency: "XOF", secret_field: "x" });
    const usage = await client().usage();
    assert.deepEqual(usage, { accepted: 12, uncertain: 1, rejected: 2, acceptedAmountXof: 180, unitPriceXof: 15, currency: "XOF" });
    const [request] = fake.usageRequests();
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(request.path, "/usage");
  });

  test("corps imbriqué accepté ; champs manquants, négatifs ou devise invalide : refus", () => {
    const body = { accepted: 1, uncertain: 0, rejected: 0, accepted_amount_xof: 15, unit_price_xof: 15, currency: "XOF" };
    assert.ok(parseUsage({ usage: body }));
    assert.ok(parseUsage({ data: body }));
    assert.equal(parseUsage({ ...body, accepted: -1 }), null);
    assert.equal(parseUsage({ ...body, currency: "xof" }), null);
    assert.equal(parseUsage({ ...body, unit_price_xof: "15" }), null);
    assert.equal(parseUsage({ accepted: 1 }), null);
    assert.equal(parseUsage(null), null);
  });

  test("erreurs : 401, statut inattendu, corps illisible, serveur muet → codes stables", async () => {
    fake.setUsage({ kind: "status", status: 500 });
    await assert.rejects(client().usage(), (error: unknown) => error instanceof MenoUsageError && error.code === "usage_http_error");
    fake.setUsage({ kind: "status", status: 200, rawBody: "[]" });
    await assert.rejects(client().usage(), (error: unknown) => error instanceof MenoUsageError && error.code === "usage_invalid_response");
    await assert.rejects(client({ apiKey: "another_fake_key_0000000000" }).usage(), (error: unknown) => error instanceof MenoUsageError && error.code === "usage_unauthorized");
    fake.setUsage({ kind: "hang" });
    await assert.rejects(client({ attemptTimeoutMs: 100 }).usage(), (error: unknown) => error instanceof MenoUsageError && error.code === "usage_unreachable");
  });

  test("cache de 60 s : une seule requête pour plusieurs lectures, nouvelle requête après l'échéance, lectures simultanées partagées", async () => {
    fake.setUsage({ accepted: 5, uncertain: 0, rejected: 0, accepted_amount_xof: 75, unit_price_xof: 15, currency: "XOF" });
    let clock = 1_000_000;
    const real = client();
    const cache = createUsageCache({ fetchUsage: () => real.usage(), now: () => clock });
    const [a, b] = await Promise.all([cache.read(), cache.read()]);
    assert.equal(fake.usageRequests().length, 1, "lectures simultanées : une requête");
    assert.equal(a.usage?.accepted, 5);
    assert.deepEqual(a, b);
    clock += 59_999;
    await cache.read();
    assert.equal(fake.usageRequests().length, 1, "59,999 s : toujours en cache");
    clock += 2;
    await cache.read();
    assert.equal(fake.usageRequests().length, 2, "au-delà de 60 s : nouvelle requête");
  });

  test("échec de lecture : code stable gardé 10 s seulement, jamais de corps du fournisseur", async () => {
    fake.setUsage({ kind: "status", status: 500, body: { secret: API_KEY } });
    let clock = 5_000_000;
    const real = client();
    const cache = createUsageCache({ fetchUsage: () => real.usage(), now: () => clock });
    const first = await cache.read();
    assert.deepEqual(first, { usage: null, usageError: "usage_http_error" });
    assert.equal(JSON.stringify(first).includes(API_KEY), false);
    await cache.read();
    assert.equal(fake.usageRequests().length, 1);
    clock += 10_001;
    await cache.read();
    assert.equal(fake.usageRequests().length, 2);
    assert.deepEqual(await createUsageCache({ fetchUsage: null }).read(), { usage: null, usageError: "provider_inactive" });
  });
});
