import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_GRANT_PRODUCTION_VARIABLE, adminGrantEnvironmentRefusal } from "../../lib/server/admin/grant";
import { MASKED_PHONE_SQL } from "../../lib/server/admin/reads";

/** Environnement de `admin:grant` (lot D2) : refusée en production sans variable explicite, et pour toute valeur de NODE_ENV inconnue. */

test("NODE_ENV absent, « development » ou « test » : permis ; casse exacte seulement", () => {
  assert.equal(adminGrantEnvironmentRefusal({}), null);
  assert.equal(adminGrantEnvironmentRefusal({ NODE_ENV: "development" }), null);
  assert.equal(adminGrantEnvironmentRefusal({ NODE_ENV: "test" }), null);
  for (const value of ["Development", "TEST", "staging", "prod", "", " production", "Production"]) {
    assert.notEqual(adminGrantEnvironmentRefusal({ NODE_ENV: value }), null, JSON.stringify(value));
  }
  assert.ok(!String(adminGrantEnvironmentRefusal({ NODE_ENV: "valeur-secrète-zz" })).includes("secrète"), "le refus ne répète jamais la valeur reçue");
});

test("production : refusée sans variable explicite, permise avec NOMA_ADMIN_GRANT_PRODUCTION=1 exactement", () => {
  assert.equal(ADMIN_GRANT_PRODUCTION_VARIABLE, "NOMA_ADMIN_GRANT_PRODUCTION");
  const refused = adminGrantEnvironmentRefusal({ NODE_ENV: "production" });
  assert.match(String(refused), /refus en production : définissez NOMA_ADMIN_GRANT_PRODUCTION=1/);
  for (const value of ["0", "true", "yes", " 1", ""]) {
    assert.notEqual(adminGrantEnvironmentRefusal({ NODE_ENV: "production", NOMA_ADMIN_GRANT_PRODUCTION: value }), null, JSON.stringify(value));
  }
  assert.equal(adminGrantEnvironmentRefusal({ NODE_ENV: "production", NOMA_ADMIN_GRANT_PRODUCTION: "1" }), null);
  // La variable ne suffit pas hors production.
  assert.notEqual(adminGrantEnvironmentRefusal({ NODE_ENV: "staging", NOMA_ADMIN_GRANT_PRODUCTION: "1" }), null);
});

test("le masque d'un numéro est calculé dans la requête : seuls les deux derniers chiffres restent", () => {
  const sql = MASKED_PHONE_SQL("p.phone_e164");
  assert.match(sql, /repeat\('•'/);
  assert.match(sql, /right\(p\.phone_e164, 2\)/);
  assert.ok(!/right\(p\.phone_e164, [3-9]\)/.test(sql));
});
