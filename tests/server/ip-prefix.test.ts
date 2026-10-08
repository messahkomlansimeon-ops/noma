import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  IP_ADDRESS_LIMIT_15M,
  IP_ADDRESS_LIMIT_DAY,
  IP_PREFIX_V4_LIMIT_15M,
  IP_PREFIX_V4_LIMIT_DAY,
  IP_PREFIX_V6_LIMIT_15M,
  IP_PREFIX_V6_LIMIT_DAY,
  ipAggregation,
} from "../../lib/server/auth/ip-prefix";
import { secretFingerprint } from "../../lib/server/auth/primitives";

test("B1-d — IPv4 : toutes les adresses d'un même /24 partagent la même clé ; un autre /24 en a une autre", () => {
  const key = ipAggregation("203.0.113.7").key;
  assert.equal(key, "v4:203.0.113");
  for (const last of [0, 1, 7, 128, 254, 255]) assert.equal(ipAggregation(`203.0.113.${last}`).key, key, `203.0.113.${last}`);
  for (const other of ["203.0.114.7", "203.1.113.7", "204.0.113.7", "198.51.100.7"]) assert.notEqual(ipAggregation(other).key, key, other);
  assert.deepEqual(
    { family: ipAggregation("203.0.113.7").family, quarter: ipAggregation("203.0.113.7").limitPer15Minutes, day: ipAggregation("203.0.113.7").limitPerDay },
    { family: "ipv4", quarter: IP_PREFIX_V4_LIMIT_15M, day: IP_PREFIX_V4_LIMIT_DAY },
  );
});

test("B1-d — IPv6 : toutes les adresses d'un même /64 partagent la même clé, quelle que soit l'écriture ; un autre /64 en a une autre", () => {
  const key = ipAggregation("2001:db8:abcd:12::1").key;
  assert.equal(key, "v6:2001:0db8:abcd:0012");
  for (const same of [
    "2001:db8:abcd:12::2",
    "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
    "2001:0db8:abcd:0012:0000:0000:0000:0001",
    "2001:DB8:ABCD:12:1:2:3:4",
    "2001:db8:abcd:12:aaaa::",
    "2001:db8:abcd:12::",
    "2001:db8:abcd:12::1%eth0",
  ]) {
    assert.equal(ipAggregation(same).key, key, same);
  }
  for (const other of ["2001:db8:abcd:13::1", "2001:db8:abce:12::1", "2001:db9:abcd:12::1", "2001:db8:abcd::12:1"]) assert.notEqual(ipAggregation(other).key, key, other);
  assert.deepEqual(
    { family: ipAggregation("2001:db8::1").family, quarter: ipAggregation("2001:db8::1").limitPer15Minutes, day: ipAggregation("2001:db8::1").limitPerDay },
    { family: "ipv6", quarter: IP_PREFIX_V6_LIMIT_15M, day: IP_PREFIX_V6_LIMIT_DAY },
  );
  // Écritures compressées différentes d'un même /64 (zéros de tête, « :: » à des endroits différents).
  assert.equal(ipAggregation("2001:db8::5:0:0:1").key, ipAggregation("2001:db8:0:0:5::1").key, "mêmes 4 premiers groupes (2001:db8:0:0)");
  assert.equal(ipAggregation("::1").key, "v6:0000:0000:0000:0000");
});

test("IPv6 qui encapsule une adresse IPv4 : regroupée comme l'IPv4 (/24)", () => {
  const key = ipAggregation("203.0.113.7").key;
  for (const mapped of ["::ffff:203.0.113.200", "::ffff:cb00:71c8", "0:0:0:0:0:ffff:203.0.113.9", "0000:0000:0000:0000:0000:ffff:cb00:7109"]) {
    assert.equal(ipAggregation(mapped).key, key, mapped);
    assert.equal(ipAggregation(mapped).family, "ipv4");
  }
  assert.notEqual(ipAggregation("::ffff:203.0.114.1").key, key);
  // Pas une adresse mappée : un vrai /64 (le groupe 6 vaut autre chose que ffff).
  assert.equal(ipAggregation("::fffe:203.0.113.200").family, "ipv6");
});

test("valeur qui n'est pas une adresse : pas d'agrégation, limites d'une adresse unique", () => {
  for (const odd of ["ip-test-1", "unknown", "999.1.1.1", "1.2.3", "2001:db8::g", "2001:db8:::1", ""]) {
    const aggregation = ipAggregation(odd);
    assert.equal(aggregation.family, "other", odd);
    assert.equal(aggregation.key, `raw:${odd}`);
    assert.equal(aggregation.limitPer15Minutes, 60, "SMS1-ter : 60 par 15 minutes pour une adresse");
    assert.equal(aggregation.limitPerDay, 300, "SMS1-ter : 300 par jour pour une adresse");
  }
  assert.notEqual(ipAggregation("ip-test-1").key, ipAggregation("ip-test-2").key);
});

test("SMS1-ter — limites relevées : une adresse 60 par 15 min et 300 par jour, un /24 300 et 1500, un /64 60 et 300 (jamais plus bas qu'une adresse)", () => {
  assert.deepEqual([IP_ADDRESS_LIMIT_15M, IP_ADDRESS_LIMIT_DAY], [60, 300]);
  assert.deepEqual([IP_PREFIX_V4_LIMIT_15M, IP_PREFIX_V4_LIMIT_DAY], [300, 1500]);
  assert.deepEqual([IP_PREFIX_V6_LIMIT_15M, IP_PREFIX_V6_LIMIT_DAY], [60, 300]);
  for (const sample of ["203.0.113.7", "2001:db8::1", "::ffff:203.0.113.7", "texte"]) {
    const aggregation = ipAggregation(sample);
    assert.ok(aggregation.limitPer15Minutes >= IP_ADDRESS_LIMIT_15M, sample);
    assert.ok(aggregation.limitPerDay >= IP_ADDRESS_LIMIT_DAY, sample);
  }
  assert.ok(IP_PREFIX_V4_LIMIT_15M > IP_ADDRESS_LIMIT_15M && IP_PREFIX_V4_LIMIT_DAY > IP_ADDRESS_LIMIT_DAY, "un /24 abrite plusieurs abonnés");
});

test("l'empreinte du préfixe est distincte de celle de l'adresse et dépend du secret (jamais l'adresse ni le préfixe en clair)", () => {
  const secret = randomBytes(32);
  const exact = secretFingerprint(secret, "ip", "203.0.113.7");
  const prefixKey = ipAggregation("203.0.113.7").key;
  const prefix = secretFingerprint(secret, "ip-prefix", prefixKey);
  assert.match(prefix, /^[0-9a-f]{64}$/);
  assert.notEqual(prefix, exact);
  assert.equal(secretFingerprint(secret, "ip-prefix", ipAggregation("203.0.113.200").key), prefix, "même /24, même empreinte");
  assert.notEqual(secretFingerprint(randomBytes(32), "ip-prefix", prefixKey), prefix);
  // Déterministe (SMS1-ter) : un condensé hexadécimal aléatoire contient « 203 » une fois sur ~65 ; seul le préfixe EN CLAIR est donc interdit. Il contient « : » et « . », jamais présents dans un condensé hexadécimal.
  assert.equal(prefixKey, "v4:203.0.113");
  assert.equal(prefix.includes(prefixKey), false, "le préfixe en clair n'apparaît pas dans l'empreinte");
  assert.equal(/[:.]/.test(prefix), false, "l'empreinte ne contient que des chiffres hexadécimaux");
  // Valeur attendue recalculée indépendamment de secretFingerprint (HMAC-SHA-256 du préfixe sous le domaine « ip-prefix »).
  const expected = createHmac("sha256", secret).update("noma:auth:ip-prefix:v1\0", "utf8").update(prefixKey, "utf8").digest("hex");
  assert.equal(prefix, expected);
});
