import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEXT_DEV_HOSTNAME, nextDevArgs, nextDevHostname } from "../../scripts/dev-full-args";

/** Lot FIN1 : `next dev` (lancé par dev:full et dev:try) n'écoute plus que sur la boucle locale ; l'option `-H` est celle de la documentation de Next 16 (`next dev --hostname`). */

describe("arguments de next dev", () => {
  test("par défaut : `next dev -H 127.0.0.1` (jamais 0.0.0.0, l'écoute par défaut de Next)", () => {
    assert.equal(NEXT_DEV_HOSTNAME, "127.0.0.1");
    assert.deepEqual(nextDevArgs({}), ["dev", "-H", "127.0.0.1"]);
    assert.deepEqual(nextDevArgs({ NOMA_DEV_NEXT_HOSTNAME: "" }), ["dev", "-H", "127.0.0.1"]);
    assert.equal(nextDevArgs({}).includes("0.0.0.0"), false);
  });

  test("dev:full lancé à la main peut demander un autre nom d'hôte lisible ; une valeur illisible retombe sur 127.0.0.1", () => {
    assert.equal(nextDevHostname({ NOMA_DEV_NEXT_HOSTNAME: "0.0.0.0" }), "0.0.0.0");
    assert.equal(nextDevHostname({ NOMA_DEV_NEXT_HOSTNAME: " localhost " }), "localhost");
    for (const bad of ["a b", "x;rm -rf", "a/b", "$(id)", "x".repeat(300)]) assert.equal(nextDevHostname({ NOMA_DEV_NEXT_HOSTNAME: bad }), "127.0.0.1", bad);
  });

  test("dev-full.ts lance bien Next avec ces arguments (et non plus `next dev` nu)", () => {
    const source = readFileSync(fileURLToPath(new URL("../../scripts/dev-full.ts", import.meta.url)), "utf8");
    assert.match(source, /nextDevArgs\(process\.env\)/);
    assert.equal(/\["dev"\]/.test(source), false, "plus de `next dev` sans option d'écoute");
  });
});

describe("indicateur de développement de Next (next.config.ts)", () => {
  const load = async (proxy: string | undefined) => {
    const previous = process.env.NOMA_DEV_PROXY;
    if (proxy === undefined) delete process.env.NOMA_DEV_PROXY;
    else process.env.NOMA_DEV_PROXY = proxy;
    try {
      const loaded = (await import(`../../next.config.ts?proxy=${proxy ?? "none"}`)) as { default: { devIndicators?: unknown } };
      return loaded.default;
    } finally {
      if (previous === undefined) delete process.env.NOMA_DEV_PROXY;
      else process.env.NOMA_DEV_PROXY = previous;
    }
  };

  test("masqué dans dev:try (NOMA_DEV_PROXY=1) : il interceptait les clics sur la barre du bas ; inchangé ailleurs", async () => {
    assert.equal((await load("1")).devIndicators, false);
    assert.equal((await load(undefined)).devIndicators, undefined);
    assert.equal((await load("0")).devIndicators, undefined);
  });
});
