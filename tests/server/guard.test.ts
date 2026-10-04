/**
 * Protections publiques (Lot 4) — budget prévisionnel, réservations,
 * quotas session/IP, concurrence, redémarrage. Tests hors ligne : SQLite
 * temporaire, horloge injectée, vérificateur Turnstile simulé.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openGuardDb, dayKey } from "../../lib/server/db";
import {
  MICRO_USD,
  loadConfig,
} from "../../lib/server/config";
import {
  reserveForSearch,
  reconcileReservation,
  availableMicros,
  unresolvedReservations,
} from "../../lib/server/budget";
import { admitSearch, releaseActive, activeSearches, secondsUntilNextDay } from "../../lib/server/quotas";
import { admitPublicSearch, completePublicSearch } from "../../lib/server/admission";
import { clientIpFromRequest, pseudonymizeIp } from "../../lib/server/ip";
import { verifyTurnstile, type TurnstileVerifier } from "../../lib/server/turnstile";

const cfgFor = (over: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "test",
    NOMA_DB_PATH: join(mkdtempSync(join(tmpdir(), "noma-guard-")), "guard.sqlite"),
    NOMA_DAILY_BUDGET_USD: "1",
    NOMA_SEARCH_RESERVE_USD: "0.05",
    NOMA_TURNSTILE_DISABLED: "1",
    ...over,
  });

const T0 = new Date("2026-10-02T10:00:00Z"); // vendredis 2 oct., jour Abidjan

describe("budget prévisionnel — réservations et réconciliation", () => {
  test("réserve 0,05 $ ; le reliquat est libéré au coût connu", () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    const a = reserveForSearch(db, "s1", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    assert.equal(a.reserved, true);
    assert.equal(a.amountMicros, 50_000);
    // coût connu 0,004 $ → réserve soldée, dépense réelle au ledger
    const rec = reconcileReservation(db, "s1", true, 4_000, T0);
    assert.equal(rec.status, "settled");
    assert.equal(rec.spentMicros, 4_000);
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, dayKey(T0)), 1_000_000 - 4_000);
    close();
  });

  test("dépassement réel : la dépense est comptabilisée ENTIÈREMENT, jamais tronquée à la réserve", () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    reserveForSearch(db, "s1", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    // coût réel 0,08 $ pour une réserve prévisionnelle de 0,05 $
    const rec = reconcileReservation(db, "s1", true, 80_000, T0);
    assert.equal(rec.status, "settled");
    assert.equal(rec.spentMicros, 80_000, "dépassement intégralement enregistré");
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, dayKey(T0)), 1_000_000 - 80_000);
    close();
  });

  test("réserve incertaine non réconciliée : reportée sur le solde du LENDEMAIN", () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    reserveForSearch(db, "s-crash", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    // jamais réconciliée → le lendemain, le solde reste réduit de la réserve
    const nextDay = dayKey(new Date("2026-10-03T00:00:01Z"));
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, nextDay), 950_000);
    close();
  });

  test("facturation incertaine : la réserve est conservée, rien n'est compté", () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    reserveForSearch(db, "s1", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    const rec = reconcileReservation(db, "s1", false, 0, T0);
    assert.equal(rec.status, "reserve-kept");
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, dayKey(T0)), 950_000);
    assert.equal(unresolvedReservations(db).length, 1);
    close();
  });

  test("réserve incertaine : décompte au changement de jour ET après redémarrage, dépense au jour D'ORIGINE", () => {
    const path = join(mkdtempSync(join(tmpdir(), "noma-day-")), "guard.sqlite");
    const cfg = cfgFor();
    const first = openGuardDb(path);
    reserveForSearch(first.db, "s-jour", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    reconcileReservation(first.db, "s-jour", false, 0, T0); // facturation incertaine
    first.close(); // redémarrage

    const second = openGuardDb(path);
    const nextDay = new Date("2026-10-03T08:00:00Z"); // jour Abidjan suivant
    // la réserve incertaine reste décomptée du solde du lendemain
    assert.equal(availableMicros(second.db, cfg.dailyBudgetMicros, dayKey(nextDay)), 950_000);
    // réconciliation le lendemain : la dépense est comptée au jour D'ORIGINE
    const rec = reconcileReservation(second.db, "s-jour", true, 4_000, nextDay);
    assert.equal(rec.status, "settled");
    const ledger = second.db.prepare("SELECT day, amount_micros FROM ledger").all() as { day: string; amount_micros: number }[];
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].day, "2026-10-02");
    assert.equal(Number(ledger[0].amount_micros), 4_000);
    // après réconciliation : réserve libérée du jour suivant, dépense au jour d'origine
    assert.equal(availableMicros(second.db, cfg.dailyBudgetMicros, dayKey(nextDay)), 1_000_000);
    assert.equal(availableMicros(second.db, cfg.dailyBudgetMicros, "2026-10-02"), 996_000);
    second.close();
  });

  test("solde insuffisant → pas de réserve (recherche sans IA)", () => {
    const { db, close } = openGuardDb(":memory:");
    const daily = 100_000; // 0,10 $ : deux réserves pleines, la 3e refuse
    assert.equal(reserveForSearch(db, "s1", 50_000, daily, T0).reserved, true);
    assert.equal(reserveForSearch(db, "s2", 50_000, daily, T0).reserved, true);
    const third = reserveForSearch(db, "s3", 50_000, daily, T0);
    assert.deepEqual(third, { reserved: false, availableMicros: 0 });
    close();
  });

  test("redémarrage : les réserves non résolues survivent (SQLite persistant)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "noma-restart-")), "guard.sqlite");
    const cfg = cfgFor();
    const first = openGuardDb(path);
    reserveForSearch(first.db, "s-crash", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    first.close(); // « crash » sans réconciliation
    const second = openGuardDb(path);
    assert.equal(availableMicros(second.db, cfg.dailyBudgetMicros, dayKey(T0)), 950_000);
    assert.deepEqual(
      unresolvedReservations(second.db).map((r) => r.searchId),
      ["s-crash"],
    );
    second.close();
  });

  test("réservations concurrentes : la somme réservée ne dépasse jamais le budget", () => {
    const { db, close } = openGuardDb(":memory:");
    const daily = 200_000; // 0,20 $ → au plus 4 réserves de 0,05 $
    const results = Array.from({ length: 10 }, (_, i) =>
      // DatabaseSync est synchrone : les appels s'intercalent sur les awaits
      reserveForSearch(db, `s${i}`, 50_000, daily, T0),
    );
    const ok = results.filter((r) => r.reserved);
    const refused = results.filter((r) => !r.reserved);
    assert.equal(ok.length, 4);
    assert.equal(refused.length, 6);
    assert.equal(availableMicros(db, daily, dayKey(T0)), 0);
    close();
  });

  test("microdollars entiers : les coûts fractionnaires sont arrondis", () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    reserveForSearch(db, "s1", cfg.reserveMicros, cfg.dailyBudgetMicros, T0);
    reconcileReservation(db, "s1", true, 3_333.6, T0);
    assert.equal(spentIsInteger(db), true);
    close();
    function spentIsInteger(d: ReturnType<typeof openGuardDb>["db"]) {
      const row = d.prepare("SELECT amount_micros FROM ledger").get() as { amount_micros: number | bigint };
      return Number.isInteger(Number(row.amount_micros));
    }
  });

  test("jour du budget : fenêtre Africa/Abidjan (UTC, pas de DST)", () => {
    assert.equal(dayKey(new Date("2026-10-02T23:59:59Z")), "2026-10-02");
    assert.equal(dayKey(new Date("2026-10-03T00:00:01Z")), "2026-10-03");
  });
});

describe("quotas — session, IP, concurrence globale", () => {
  const quotaCfg = {
    sessionId: "sess-A",
    ipHash: "ip-x",
    now: T0,
    activeSearchTtlMs: 10 * 60 * 1000,
    startsPerMinute: 2,
    startsPerDay: 10,
    maxConcurrentSearches: 2,
  };

  test("2 démarrages/minute : le 3e est refusé avec Retry-After", () => {
    const { db, close } = openGuardDb(":memory:");
    for (const [i, dt] of [0, 5_000].entries()) {
      const res = admitSearch(db, { ...quotaCfg, now: new Date(T0.getTime() + dt) });
      assert.equal(res.allowed, true, `démarrage ${i + 1}`);
      releaseActive(db, quotaCfg.sessionId, res.searchId!);
    }
    const third = admitSearch(db, { ...quotaCfg, now: new Date(T0.getTime() + 10_000) });
    assert.equal(third.allowed, false);
    assert.equal(third.rejection, "rate-minute");
    assert.ok(third.retryAfterSeconds! > 0 && third.retryAfterSeconds! <= 60);
    close();
  });

  test("10/jour : au-delà, refus jusqu'au lendemain (fuseau Abidjan)", () => {
    const { db, close } = openGuardDb(":memory:");
    for (let i = 0; i < 10; i++) {
      const t = new Date(T0.getTime() + i * 70_000); // 10 fenêtres-minute libres
      const res = admitSearch(db, { ...quotaCfg, now: t });
      assert.equal(res.allowed, true, `démarrage ${i + 1}`);
      releaseActive(db, quotaCfg.sessionId, res.searchId!);
    }
    const blocked = admitSearch(db, { ...quotaCfg, now: new Date(T0.getTime() + 11 * 70_000) });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.rejection, "rate-day");
    assert.ok(blocked.retryAfterSeconds! > 0);
    // le lendemain (jour Abidjan différent) : à nouveau admis
    const freed = openGuardDb(":memory:");
    assert.equal(
      admitSearch(freed.db, { ...quotaCfg, now: new Date(Date.parse("2026-10-03T00:00:01Z")) }).allowed,
      true,
    );
    freed.close();
    close();
  });

  test("Retry-After quotidien : calcul direct, rapide et exact à la frontière du jour", () => {
    const t0 = Date.now();
    const seconds = secondsUntilNextDay(T0, "Africa/Abidjan");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `calcul trop lent : ${elapsed} ms (boucle interdite)`);
    assert.ok(seconds > 0 && seconds <= 24 * 3600);
    // exactitude : le jour bascule pile à `seconds`, pas avant
    assert.equal(dayKey(new Date(T0.getTime() + seconds * 1000)), "2026-10-03");
    assert.equal(dayKey(new Date(T0.getTime() + (seconds - 1) * 1000)), "2026-10-02");
  });

  test("contournement par nouveau cookie : l'empreinte IP est aussi limitée", () => {
    const { db, close } = openGuardDb(":memory:");
    for (let i = 0; i < 2; i++) {
      const res = admitSearch(db, { ...quotaCfg, sessionId: `sess-${i}` });
      assert.equal(res.allowed, true);
      releaseActive(db, `sess-${i}`, res.searchId!);
    }
    const freshCookie = admitSearch(db, { ...quotaCfg, sessionId: "sess-nouveau" });
    assert.equal(freshCookie.allowed, false, "la limite IP bloque un nouveau cookie");
    assert.equal(freshCookie.rejection, "rate-minute");
    close();
  });

  test("une seule recherche active par session ; 2 globales ; libération", () => {
    const { db, close } = openGuardDb(":memory:");
    // fenêtres-minute distinctes pour isoler la saturation globale des quotas
    const t = (s: number) => new Date(T0.getTime() + s * 61_000);
    assert.equal(admitSearch(db, { ...quotaCfg, sessionId: "s1", now: t(0) }).allowed, true);
    assert.equal(admitSearch(db, { ...quotaCfg, sessionId: "s2", now: t(1) }).allowed, true);
    const third = admitSearch(db, { ...quotaCfg, sessionId: "s3", now: t(2) });
    assert.equal(third.allowed, false);
    assert.equal(third.rejection, "global-saturated");
    // même session : pas de 2e recherche simultanée
    assert.equal(admitSearch(db, { ...quotaCfg, sessionId: "s1", now: t(3) }).rejection, "already-active");
    releaseActive(db, "s1", activeSearches(db)[0].searchId);
    assert.equal(activeSearches(db).length, 1);
    assert.equal(admitSearch(db, { ...quotaCfg, sessionId: "s3", now: t(4) }).allowed, true);
    close();
  });

  test("recherche active morte (crash) : nettoyée après le TTL de grâce", () => {
    const { db, close } = openGuardDb(":memory:");
    assert.equal(admitSearch(db, { ...quotaCfg, sessionId: "s1" }).allowed, true);
    const after = admitSearch(db, { ...quotaCfg, sessionId: "s2", now: new Date(T0.getTime() + 11 * 60_000) });
    assert.equal(after.allowed, true, "la ligne morte (> TTL) est purgeée");
    close();
  });
});

describe("admission complète — interrupteurs, Turnstile, budget", () => {
  const okVerifier: TurnstileVerifier = async () => ({ success: true, hostname: "noma.example", action: "search" });

  test("flux nominal : admission + réserve + searchId", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess-1", ipHash: "ip-1", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.aiEnabled, true);
      assert.equal(res.reservationMicros, 50_000);
    }
    close();
  });

  test("continuation signée : saute seulement Turnstile, conserve quotas et budget", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    let verifyCalls = 0;
    const res = await admitPublicSearch({
      cfg,
      db,
      verify: async () => {
        verifyCalls++;
        throw new Error("ne doit pas être appelé");
      },
    }, {
      sessionId: "sess-suite", ipHash: "ip-suite", remoteip: null,
      turnstileVerified: true, now: T0,
    });
    assert.equal(verifyCalls, 0);
    assert.equal(res.allowed, true);
    if (res.allowed) assert.equal(res.reservationMicros, 50_000, "budget toujours réservé");
    close();
  });

  test("interrupteur « recherches désactivées » → 503", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor({ NOMA_SEARCH_DISABLED: "1" });
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess", ipHash: "ip", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.deepEqual(res, { allowed: false, status: 503, code: "searches_disabled", message: res.allowed === false ? res.message : "" });
    close();
  });

  test("interrupteur « IA désactivée » → admis SANS réserve et sans IA", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor({ NOMA_AI_DISABLED: "1" });
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess", ipHash: "ip", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.ok(res.allowed);
    if (res.allowed) {
      assert.equal(res.aiEnabled, false);
      assert.equal(res.reservationMicros, 0);
    }
    close();
  });

  test("budget épuisé → admission SANS IA (le secours web reste possible)", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor({ NOMA_DAILY_BUDGET_USD: "0.04" }); // < réserve 0,05 $
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess", ipHash: "ip", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.ok(res.allowed, "la recherche est admise même sans budget IA");
    if (res.allowed) assert.equal(res.aiEnabled, false);
    close();
  });

  test("fin de recherche : place libérée + réserve réconciliée (finally garanti)", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    const deps = { cfg, db };
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess", ipHash: "ip", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.ok(res.allowed && res.allowed && res.searchId);
    completePublicSearch(deps, "sess", res.searchId!, { totalCostKnown: true, costMicros: 6_000 }, T0);
    assert.equal(activeSearches(db).length, 0);
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, dayKey(T0)), 1_000_000 - 6_000);
    close();
  });

  test("fin de recherche à coût INCONNU : place libérée, réserve conservée", async () => {
    const { db, close } = openGuardDb(":memory:");
    const cfg = cfgFor();
    const deps = { cfg, db };
    const res = await admitPublicSearch({ cfg, db, verify: okVerifier }, {
      sessionId: "sess", ipHash: "ip", remoteip: null, turnstileToken: "tok", now: T0,
    });
    assert.ok(res.allowed && res.searchId);
    completePublicSearch(deps, "sess", res.searchId!, { totalCostKnown: false, costMicros: 0 }, T0);
    assert.equal(activeSearches(db).length, 0, "place libérée même sans coût connu");
    assert.equal(unresolvedReservations(db).length, 1, "réserve conservée jusqu'à réconciliation");
    assert.equal(availableMicros(db, cfg.dailyBudgetMicros, dayKey(T0)), 950_000);
    close();
  });
});

describe("IP — en-têtes de confiance et pseudonymisation", () => {
  const headers = (xff: string | null) => ({ get: (n: string) => (n === "x-forwarded-for" ? xff : null) });

  test("X-Forwarded-For cru uniquement depuis le proxy configuré", () => {
    const trusted = ["10.0.0.2"];
    assert.equal(clientIpFromRequest(headers("203.0.113.9"), "10.0.0.2", trusted), "203.0.113.9");
    // connexion DIRECTE (pas le proxy) : les en-têtes sont ignorés
    assert.equal(clientIpFromRequest(headers("203.0.113.9"), "192.168.1.5", trusted), "192.168.1.5");
    // aucun proxy configuré : jamais de confiance
    assert.equal(clientIpFromRequest(headers("203.0.113.9"), "192.168.1.5", []), "192.168.1.5");
    assert.equal(clientIpFromRequest(headers(null), "10.0.0.2", trusted), "10.0.0.2");
  });

  test("secret du reverse proxy : X-Forwarded-For cru seulement avec le bon secret", () => {
    const secretHeaders = (xff: string | null, secret: string | null) => ({
      get: (n: string) => (n === "x-forwarded-for" ? xff : n === "x-noma-proxy-secret" ? secret : null),
    });
    assert.equal(
      clientIpFromRequest(secretHeaders("203.0.113.9", "bon-secret"), "172.17.0.5", [], "bon-secret"),
      "203.0.113.9",
    );
    // mauvais secret (imposteur) : en-têtes ignorés
    assert.equal(
      clientIpFromRequest(secretHeaders("203.0.113.9", "mauvais"), "172.17.0.5", [], "bon-secret"),
      "172.17.0.5",
    );
    // pas de secret configuré : jamais cru
    assert.equal(
      clientIpFromRequest(secretHeaders("203.0.113.9", "bon-secret"), "172.17.0.5", [], undefined),
      "172.17.0.5",
    );
  });

  test("empreinte IP : déterministe, jamais l'IP en clair", () => {
    const h1 = pseudonymizeIp("203.0.113.9", "secret");
    const h2 = pseudonymizeIp("203.0.113.9", "secret");
    const h3 = pseudonymizeIp("203.0.113.10", "secret");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.ok(!h1.includes("203.0.113"));
    assert.equal(pseudonymizeIp(null, "secret"), "inconnu");
  });
});

describe("Turnstile — validation serveur stricte", () => {
  const base = {
    secret: "sk-test",
    expectedAction: "search",
    expectedHostnames: ["noma.example"],
    disabledForTests: false,
    production: false,
  };

  test("jeton valide avec hostname et action attendus", async () => {
    const res = await verifyTurnstile(async () => ({ success: true, hostname: "noma.example", action: "search" }), base, "tok", null);
    assert.equal(res.ok, true);
  });

  test("« success » sans hostname ou sans action → refus (jamais accepté)", async () => {
    const noHostname = await verifyTurnstile(async () => ({ success: true, action: "search" }), base, "tok", null);
    assert.equal(noHostname.ok, false);
    const noAction = await verifyTurnstile(async () => ({ success: true, hostname: "noma.example" }), base, "tok", null);
    assert.equal(noAction.ok, false);
  });

  test("action ou hostname inattendus → refus", async () => {
    const wrongAction = await verifyTurnstile(async () => ({ success: true, hostname: "noma.example", action: "signup" }), base, "tok", null);
    assert.equal(wrongAction.ok, false);
    const wrongHost = await verifyTurnstile(async () => ({ success: true, hostname: "evil.example", action: "search" }), base, "tok", null);
    assert.equal(wrongHost.ok, false);
  });

  test("jeton manquant, échec siteverify ou indisponibilité → refus (fail closed)", async () => {
    assert.equal((await verifyTurnstile(async () => ({ success: true }), base, undefined, null)).ok, false);
    assert.equal((await verifyTurnstile(async () => ({ success: false }), base, "tok", null)).ok, false);
    assert.equal(
      (await verifyTurnstile(async () => { throw new Error("réseau indisponible"); }, base, "tok", null)).ok, false,
    );
  });

  test("production : configuration absente → refus « config » ; dérivation tests interdite", async () => {
    const prod = { ...base, secret: "", production: true };
    assert.deepEqual(
      await verifyTurnstile(async () => ({ success: true }), prod, "tok", null),
      { ok: false, reason: "config" },
    );
    const prodBypass = { ...base, secret: "", production: true, disabledForTests: true };
    assert.equal((await verifyTurnstile(async () => ({ success: true }), prodBypass, "tok", null)).ok, false);
  });

  test("hors production sans secret : dérivation dev explicite uniquement", async () => {
    const dev = { ...base, secret: "", production: false, disabledForTests: false };
    assert.equal((await verifyTurnstile(async () => ({ success: true }), dev, "tok", null)).ok, true);
  });
});

describe("config — montants et interrupteurs", () => {
  test("valeurs par défaut prévisionnelles : 1 $/jour, 0,05 $/recherche", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });
    assert.equal(cfg.dailyBudgetMicros, MICRO_USD);
    assert.equal(cfg.reserveMicros, 50_000);
    assert.equal(cfg.startsPerMinute, 2);
    assert.equal(cfg.startsPerDay, 10);
    assert.equal(cfg.maxConcurrentSearches, 2);
  });

  test("interrupteurs serveur lus depuis l'environnement", () => {
    assert.equal(loadConfig({ NODE_ENV: "test", NOMA_SEARCH_DISABLED: "1" }).searchDisabled, true);
    assert.equal(loadConfig({ NODE_ENV: "test", NOMA_AI_DISABLED: "1" }).aiDisabled, true);
    assert.equal(loadConfig({ NODE_ENV: "test" }).searchDisabled, false);
  });
});
