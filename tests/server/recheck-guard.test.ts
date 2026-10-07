import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOST_REUSE_RECHECK_CACHE_MS, BOOST_REUSE_RECHECK_LIMIT, BOOST_REUSE_RECHECK_WINDOW_MS,
} from "../../lib/server/boost/boost-config";
import { createReuseRecheckGuard } from "../../lib/server/boost/recheck-guard";

test("constantes du lot M1 (D6) : mémoire de 10 s, 60 revérifications par vendeur et par minute", () => {
  assert.equal(BOOST_REUSE_RECHECK_CACHE_MS, 10_000);
  assert.equal(BOOST_REUSE_RECHECK_LIMIT, 60);
  assert.equal(BOOST_REUSE_RECHECK_WINDOW_MS, 60_000);
});

test("mémoire : « atteignable » vaut strictement moins de 10 s, par devis ; à 10 s pile elle est périmée et oubliée", () => {
  let now = 100;
  const guard = createReuseRecheckGuard({ now: () => now });
  assert.equal(guard.isFresh("a"), false, "rien de retenu au départ");
  guard.remember("a");
  assert.equal(guard.isFresh("a"), true);
  assert.equal(guard.isFresh("b"), false, "un autre devis n'est pas couvert");
  now += 9_999;
  assert.equal(guard.isFresh("a"), true, "9,999 s : encore valable");
  now += 1;
  assert.equal(guard.isFresh("a"), false, "10 s : périmée");
  assert.equal(guard.size().quotes, 0, "la lecture périmée l'a oubliée");
  guard.remember("a");
  now += 5_000;
  guard.remember("a");
  now += 6_000;
  assert.equal(guard.isFresh("a"), true, "retenir de nouveau repart de zéro");
});

test("limite : 60 revérifications par vendeur et par minute, la 61e est refusée sans être comptée ; fenêtre glissante ; vendeurs indépendants", () => {
  let now = 0;
  const guard = createReuseRecheckGuard({ now: () => now });
  for (let index = 0; index < 60; index++) {
    assert.equal(guard.tryAcquire("s1"), true, `n° ${index + 1}`);
    now += 100; // 6 s en tout
  }
  assert.equal(guard.tryAcquire("s1"), false, "61e");
  assert.equal(guard.tryAcquire("s1"), false, "toujours refusée : un refus ne compte pas");
  assert.equal(guard.tryAcquire("s2"), true, "autre vendeur");
  // La première revérification date de t = 0 ; elle sort de la fenêtre à t = 60 000.
  now = 59_999;
  assert.equal(guard.tryAcquire("s1"), false);
  now = 60_000;
  assert.equal(guard.tryAcquire("s1"), true, "la plus ancienne est sortie de la fenêtre");
  assert.equal(guard.tryAcquire("s1"), false, "mais une seule place s'est libérée");
});

test("limite et mémoire configurables (tests) : limite 2, durée 1 s, entrées bornées", () => {
  let now = 0;
  const guard = createReuseRecheckGuard({ now: () => now, limit: 2, windowMs: 1_000, ttlMs: 500, maxEntries: 4 });
  assert.deepEqual([guard.tryAcquire("s"), guard.tryAcquire("s"), guard.tryAcquire("s")], [true, true, false]);
  now = 1_000;
  assert.equal(guard.tryAcquire("s"), true);
  guard.remember("q");
  now += 499;
  assert.equal(guard.isFresh("q"), true);
  now += 1;
  assert.equal(guard.isFresh("q"), false);
  for (let index = 0; index < 50; index++) {
    guard.remember(`q${index}`);
    guard.tryAcquire(`s${index}`);
  }
  assert.ok(guard.size().quotes <= 4 && guard.size().sellers <= 4, JSON.stringify(guard.size()));
});

test("sans mémoire (ttl 0) : jamais « fraîche » ; la limite continue de compter", () => {
  const now = 0;
  const guard = createReuseRecheckGuard({ now: () => now, ttlMs: 0 });
  guard.remember("a");
  assert.equal(guard.isFresh("a"), false);
  assert.equal(guard.tryAcquire("s"), true);
});
