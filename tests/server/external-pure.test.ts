import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ANALYZER_VERSION, analyzeContent, confirmsKey, contentHashOf, parseAnalysis, tokenize } from "../../lib/server/external/analysis";
import { breakerStateOf } from "../../lib/server/external/admin-reads";
import {
  ALLOWED_SOURCE_TYPE, BREAKER_FAILURE_THRESHOLD, BREAKER_PAUSE_MS, DUPLICATE_PRICE_TOLERANCE, DUPLICATE_TITLE_SIMILARITY, EXTERNAL_OWNER_ID, GONE_AFTER_MISSED_COLLECTS, LISTED_AT_MIN_MS,
  MAX_LISTINGS_PER_SEARCH, MAX_RAW_ENTRIES_PER_SEARCH, STEP_TIME_BUDGET_MS, WATCH_DEFAULT_DAILY_BUDGET, WATCH_DEFAULT_FREQUENCY_SECONDS,
  BREAKER_TRIAL_LEASE_MS, EXTERNAL_ANALYSIS_LOCK_NAMESPACE, EXTERNAL_GROUP_LOCK_NAMESPACE, EXTERNAL_PAGE_DEFAULT, EXTERNAL_PAGE_MAX, FAKE_CONNECTORS_ENV, MATCH_CANDIDATE_LIMIT, MAX_SOURCE_WAIT_MS,
  RUNS_RETENTION_DAYS, SEARCH_TIMEOUT_MS, SOURCE_LOCK_TIMEOUT_MS, STEP_MAX_WATCHES, USAGE_RETENTION_DAYS, VISIBLE_MAX_AGE_MS, WATCH_CLAIM_LEASE_SECONDS, WATCH_RETRY_SECONDS,
} from "../../lib/server/external/config";
import { PRODUCTION_FORBIDDEN_ENV } from "../../lib/server/config";
import { connectedComponents } from "../../lib/server/external/grouping";
import { isDuplicatePair, pricesWithinTolerance, sameTitleNumbers, titleNumbers, titleSimilarity } from "../../lib/server/external/duplicates";
import { FAKE_SOURCE_A, FAKE_SOURCE_B, createFakeConnector, createFakeConnectors, fakeCatalog, fakeReferencePrice } from "../../lib/server/external/fake-connectors";
import { collapseDuplicates, compareEvaluated, decodeExternalCursor, encodeExternalCursor, externalListingAsOffer } from "../../lib/server/external/matching";
import { normalizeKeyPart, normalizeVariant, productKeyOf, productKeyString } from "../../lib/server/external/product-key";
import { readPseudonymKey } from "../../lib/server/external/secret";
import { nextUtcMidnight, planNextRun } from "../../lib/server/external/collect";
import { SourceNotAllowedError, assertAllowedSourceType, connectorFor, resolveConnectors } from "../../lib/server/external/registry";
import { cleanListedAt, cleanUrl, normalizeCurrency, pseudonymOf, sanitizeBatch, sanitizeDraft } from "../../lib/server/external/sanitize";
import type { ExternalListingDraft, ProductKey, SourceConnector, SourceRow } from "../../lib/server/external/types";
import { looksLikePhoneNumber } from "../../lib/phone-text";
import { phoneHash } from "../../lib/server/sms/sender";

/** Modules purs de la collecte d'annonces externes (lot EXT1) : clé produit, nettoyage, analyse, doublons, connecteurs fictifs, registre, absence de tout appel réseau. */

const NOW = new Date("2026-10-07T10:00:00.000Z");
const KEY = Buffer.from("noma-test-external-id-key-0123456789abcdef", "utf8");
const IPHONE: ProductKey = { category: "telephones", brand: "apple", model: "iphone 12", variant: null, zone: "abidjan" };

const draft = (over: Partial<ExternalListingDraft> = {}): ExternalListingDraft => ({
  externalId: "x-1", title: "iPhone 12 128 Go noir", price: 150_000, currency: "XOF", url: "https://annonces-demo-a.example/annonce/x-1", location: "Cocody", listedAt: NOW, availability: "available", ...over,
});

describe("clé produit", () => {
  test("normalisation : casse, accents, espaces, caractères de contrôle ; au plus 80 caractères", () => {
    assert.equal(normalizeKeyPart("  Téléphones  "), "telephones");
    assert.equal(normalizeKeyPart("iPhone   12\t"), "iphone 12");
    assert.equal(normalizeKeyPart("A\u001fB\u0000C"), "a b c");
    assert.equal(normalizeKeyPart(null), "");
    assert.equal(normalizeKeyPart(undefined), "");
    assert.equal(normalizeKeyPart("x".repeat(200)).length, 80);
  });

  test("catégorie, marque ET modèle sont requis ; variante et zone sont facultatives", () => {
    assert.equal(productKeyOf({ category: "Téléphones", brand: "Apple", model: null }), null);
    assert.equal(productKeyOf({ category: null, brand: "Apple", model: "iPhone 12" }), null);
    assert.equal(productKeyOf({ category: "Téléphones", brand: "  ", model: "iPhone 12" }), null);
    assert.deepEqual(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12" }), { category: "telephones", brand: "apple", model: "iphone 12", variant: null, zone: "" });
    assert.deepEqual(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", location: "Abidjan" }), { category: "telephones", brand: "apple", model: "iphone 12", variant: "128 go", zone: "abidjan" });
  });

  test("la clé textuelle est identique pour des saisies équivalentes, différente pour une variante ou une zone différentes", () => {
    const a = productKeyString(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", location: "Abidjan" }) as ProductKey);
    const b = productKeyString(productKeyOf({ category: " téléphones", brand: "APPLE", model: "iphone  12", location: "ABIDJAN" }) as ProductKey);
    const withVariant = productKeyString(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", location: "Abidjan" }) as ProductKey);
    const otherZone = productKeyString(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", location: "Cocody" }) as ProductKey);
    assert.equal(a, b);
    assert.notEqual(a, withVariant);
    assert.notEqual(a, otherZone);
    assert.equal(new Set([a, withVariant, otherZone]).size, 3);
  });
});

describe("clé produit : variante normalisée comme l'analyseur (lot EXT1-bis)", () => {
  test("« 128 Go », « 128Go », « 128 GB », « 128 go » et « 128-GO » donnent UNE seule clé ; une autre capacité en donne une autre", () => {
    const keyOf = (variant: string | null) => productKeyString(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant, location: "Abidjan" }) as ProductKey);
    const reference = keyOf("128 Go");
    for (const variant of ["128Go", "128 GB", "128 go ", "  128   GO", "128-Go", "128GB", "128 Gb"]) assert.equal(keyOf(variant), reference, variant);
    assert.notEqual(keyOf("256 Go"), reference);
    assert.notEqual(keyOf("128 To"), reference);
    assert.notEqual(keyOf(null), reference);
    assert.equal(normalizeVariant("128Go"), "128 go");
    assert.equal(normalizeVariant("128 GB"), "128 go");
    assert.equal(normalizeVariant("1 TB"), "1 to");
    assert.deepEqual(tokenize("128Go"), tokenize(normalizeVariant("128 GB")), "la même lecture que l'analyseur d'un titre");
    assert.equal(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128GB" })?.variant, "128 go");
  });

  test("variante vide après normalisation = pas de variante ; longueur toujours bornée à 80 caractères (colonne `variant`)", () => {
    for (const variant of ["", "   ", "!!!", "---", null, undefined]) assert.equal(productKeyOf({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant })?.variant, null, String(variant));
    // « a1a1… » : la séparation des lettres et des chiffres allonge le texte ; la clé reste dans la limite de la base.
    const long = normalizeVariant("a1".repeat(60));
    assert.ok(long.length >= 1 && long.length <= 80, `${long.length} caractères`);
    assert.ok(normalizeVariant("é".repeat(500)).length <= 80);
  });
});

describe("nettoyage d'une annonce (numéros de téléphone jamais conservés)", () => {
  test("annonce valide : champs conservés, URL canonique", () => {
    const result = sanitizeDraft(draft({ url: "http://www.annonces-demo-a.example/annonce/x-1?utm_source=a&id=7#haut" }), NOW);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.listing.url, "https://annonces-demo-a.example/annonce/x-1?id=7");
    assert.equal(result.listing.title, "iPhone 12 128 Go noir");
    assert.equal(result.listing.priceAmount, 150_000);
    assert.equal(result.listing.priceCurrency, "XOF");
    assert.deepEqual(result.removedFields, []);
  });

  test("un titre ou un lieu qui ressemble à un numéro est RETIRÉ (le champ, pas l'annonce) ; une quantité ou une dimension n'en est pas un", () => {
    for (const text of ["iPhone 12 appelez 07 08 09 10 11", "contact +225 07 08 09 10 11", "iPhone 12 07-08-09-10-11", "tel : 0708091011", "٠٧ ٠٨ ٠٩ ١٠ ١١"]) {
      const result = sanitizeDraft(draft({ title: text }), NOW);
      assert.ok(result.ok, text);
      if (result.ok) {
        assert.equal(result.listing.title, null, text);
        assert.deepEqual(result.removedFields, ["title"]);
      }
    }
    const place = sanitizeDraft(draft({ location: "Cocody 01 02 03 04 05" }), NOW);
    assert.ok(place.ok && place.listing.location === null && place.removedFields.includes("location"));
    for (const text of ["iPhone 12 128 Go, 2400×1080, 12 500 000 FCFA", "Réf. 9300-1234", "6,1 pouces, 4 Go"]) {
      const kept = sanitizeDraft(draft({ title: text }), NOW);
      assert.ok(kept.ok && kept.listing.title === text, text);
    }
  });

  test("une URL qui porte un numéro (brut ou encodé) rejette l'annonce ; un identifiant qui en porte un est pseudonymisé de façon stable (HMAC à clé serveur)", () => {
    assert.deepEqual(sanitizeDraft(draft({ url: "https://annonces-demo-a.example/annonce/0708091011" }), NOW, { pseudonymKey: KEY }), { ok: false, reason: "url_phone" });
    assert.deepEqual(sanitizeDraft(draft({ url: "https://annonces-demo-a.example/a?tel=%2B2250708091011" }), NOW, { pseudonymKey: KEY }), { ok: false, reason: "url_phone" });
    const first = sanitizeDraft(draft({ externalId: "0708091011" }), NOW, { pseudonymKey: KEY });
    const second = sanitizeDraft(draft({ externalId: "0708091011" }), NOW, { pseudonymKey: KEY });
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      assert.match(first.listing.externalId, /^h:[0-9a-f]{24}$/);
      assert.equal(first.listing.externalId, second.listing.externalId);
      assert.deepEqual(first.removedFields, ["external_id"]);
      assert.ok(!JSON.stringify(first).includes("0708091011"));
    }
  });

  test("pseudonyme : HMAC-SHA256 à clé serveur, jamais un SHA-256 simple (aucune force brute sans la clé) ; sans clé, l'annonce est rejetée", () => {
    const phone = "0708091011";
    const withKey = sanitizeDraft(draft({ externalId: phone }), NOW, { pseudonymKey: KEY });
    assert.ok(withKey.ok);
    const stored = withKey.ok ? withKey.listing.externalId : "";
    assert.equal(stored, `h:${createHmac("sha256", KEY).update(phone).digest("hex").slice(0, 24)}`, "HMAC-SHA256 de l'identifiant avec la clé");
    assert.equal(pseudonymOf(phone, KEY), stored);
    // L'ancien pseudonyme (SHA-256 sans clé) ne correspond plus : l'attaque par parcours des numéros ivoiriens (probe d'audit) ne retrouve rien.
    const plain = `h:${createHash("sha256").update(phone).digest("hex").slice(0, 24)}`;
    assert.notEqual(stored, plain);
    let found: string | null = null;
    for (let n = 0; n < 100_000 && found === null; n++) {
      const candidate = `0708${String(n).padStart(6, "0")}`;
      if (`h:${createHash("sha256").update(candidate).digest("hex").slice(0, 24)}` === stored) found = candidate;
    }
    assert.equal(found, null, "le SHA-256 sans clé de tous les numéros 0708xxxxxx ne reproduit pas l'empreinte stockée");
    // Une autre clé donne une autre empreinte ; la même clé, la même.
    const other = Buffer.from("une-autre-cle-serveur-0123456789abcdef");
    assert.notEqual(pseudonymOf(phone, other), stored);
    assert.equal(pseudonymOf(phone, Buffer.from(KEY)), stored);
    // Sans clé (absente, null, trop courte) : l'annonce est rejetée, aucun identifiant n'est produit.
    for (const options of [{}, { pseudonymKey: null }, { pseudonymKey: undefined }, { pseudonymKey: Buffer.from("court") }] as const) {
      assert.deepEqual(sanitizeDraft(draft({ externalId: phone }), NOW, options), { ok: false, reason: "id_phone" });
    }
    const batch = sanitizeBatch([draft({ externalId: phone }), draft({ externalId: "ok-1", url: "https://annonces-demo-a.example/annonce/ok-1" })], NOW);
    assert.equal(batch.listings.length, 1);
    assert.equal(batch.rejected, 1);
    // Un identifiant ordinaire n'a besoin d'aucune clé.
    assert.ok(sanitizeDraft(draft({ externalId: "annonce-12" }), NOW).ok);
  });

  test("la clé d'empreinte du serveur est DÉRIVÉE de NOMA_AUTH_SECRET (jamais le secret lui-même) ; secret absent ou invalide : aucune clé", () => {
    const secret = randomBytes(32).toString("base64");
    const key = readPseudonymKey({ NOMA_AUTH_SECRET: secret });
    assert.ok(key !== null && key.byteLength === 32);
    assert.notEqual(key?.toString("base64"), secret);
    assert.deepEqual(readPseudonymKey({ NOMA_AUTH_SECRET: secret }), key, "déterministe");
    assert.notDeepEqual(readPseudonymKey({ NOMA_AUTH_SECRET: randomBytes(32).toString("base64") }), key, "un autre secret, une autre clé");
    for (const env of [{}, { NOMA_AUTH_SECRET: "" }, { NOMA_AUTH_SECRET: "court" }, { NOMA_AUTH_SECRET: "pas du base64 !!" }, { NOMA_AUTH_SECRET: Buffer.alloc(8).toString("base64") }]) {
      assert.equal(readPseudonymKey(env), null, JSON.stringify(env));
    }
  });

  test("séparation de domaine du secret (rebase sur SMS1) : la clé d'empreinte externe ne réutilise ni l'empreinte des numéros du journal SMS ni les domaines de l'authentification", () => {
    const secret = randomBytes(32);
    const encoded = secret.toString("base64");
    const key = readPseudonymKey({ NOMA_AUTH_SECRET: encoded });
    assert.deepEqual(key, createHmac("sha256", secret).update("noma:external:listing-id-pseudonym:v1", "utf8").digest(), "domaine propre au lot, dérivé par HMAC du secret");
    assert.notDeepEqual(key, secret, "jamais le secret lui-même");
    for (const other of ["noma:sms:phone:v1\0", "noma:otp:v1\0", "noma:auth:session:v1\0"]) {
      assert.notDeepEqual(key, createHmac("sha256", secret).update(other, "utf8").digest(), `autre domaine : ${JSON.stringify(other)}`);
    }
    // Un même numéro, deux usages du secret : l'empreinte externe n'est jamais l'empreinte du journal SMS (ni son préfixe).
    const phone = "0708091011";
    const external = pseudonymOf(phone, key as Buffer);
    assert.equal(phoneHash(secret, phone).startsWith(external.slice(2)), false);
    assert.notEqual(phoneHash(secret, phone), createHmac("sha256", key as Buffer).update(phone, "utf8").digest("hex"));
  });

  test("rejets : forme, identifiant, schémas autres que http(s), identifiants dans l'URL, caractères de contrôle", () => {
    for (const value of [null, undefined, "x", 5, [], true]) assert.deepEqual(sanitizeDraft(value, NOW), { ok: false, reason: "not_an_object" });
    for (const externalId of ["", "   ", "a".repeat(201), "a\u0000b", undefined, null]) assert.deepEqual(sanitizeDraft(draft({ externalId: externalId as never }), NOW), { ok: false, reason: "invalid_id" });
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example/x", "file:///etc/passwd", "https://user:pw@a.example/x", "//a.example/x", "", "x".repeat(1_100), "https://a.example/\u0007x"]) {
      assert.deepEqual(sanitizeDraft(draft({ url }), NOW), { ok: false, reason: "invalid_url" }, url.slice(0, 40));
    }
    assert.equal(cleanUrl("https://a.example/x"), "https://a.example/x");
  });

  test("prix et devise : FCFA/CFA → XOF, entier, jamais négatif ni sans devise ; date future écartée ; disponibilité inconnue par défaut", () => {
    assert.equal(normalizeCurrency("fcfa"), "XOF");
    assert.equal(normalizeCurrency(" F CFA "), "XOF");
    assert.equal(normalizeCurrency("eur"), "EUR");
    assert.equal(normalizeCurrency("euros"), null);
    assert.equal(normalizeCurrency(5), null);
    const ok = (over: Partial<ExternalListingDraft>) => {
      const result = sanitizeDraft(draft(over), NOW);
      assert.ok(result.ok);
      return result.ok ? result.listing : (null as never);
    };
    assert.equal(ok({ price: 99_999.6, currency: "FCFA" }).priceAmount, 100_000);
    assert.equal(ok({ price: -1 }).priceAmount, null);
    assert.equal(ok({ price: -1 }).priceCurrency, null);
    assert.equal(ok({ price: Number.NaN }).priceAmount, null);
    assert.equal(ok({ price: Infinity }).priceAmount, null);
    assert.equal(ok({ price: 100, currency: null }).priceAmount, null, "montant sans devise : incomparable");
    assert.equal(ok({ price: 100, currency: "???" }).priceCurrency, null);
    assert.equal(ok({ listedAt: new Date(NOW.getTime() + 3 * 86_400_000) }).listedAt, null);
    assert.equal(ok({ listedAt: new Date("invalid") }).listedAt, null);
    assert.ok(ok({ listedAt: new Date(NOW.getTime() - 86_400_000) }).listedAt);
    assert.equal(ok({ availability: "maybe" as never }).availability, "unknown");
    assert.equal(ok({ title: "  Titre‮  avec\u0000 contrôle ", location: "​" }).title, "Titre avec contrôle");
    assert.equal(ok({ location: "​ " }).location, null);
  });

  test("lot : doublons d'identifiant ou d'URL dans la réponse, rebuts comptés, limite par recherche, compte des champs retirés", () => {
    const batch = sanitizeBatch([
      draft({ externalId: "a" }), draft({ externalId: "a", url: "https://annonces-demo-a.example/annonce/other" }), draft({ externalId: "b", url: "https://annonces-demo-a.example/annonce/x-1" }),
      draft({ externalId: "c", url: "https://annonces-demo-a.example/annonce/c", title: "appelez 07 08 09 10 11" }), null, "x", draft({ externalId: "d", url: "javascript:1" }),
    ], NOW);
    assert.equal(batch.listings.length, 2);
    assert.equal(batch.duplicatesInResponse, 2);
    assert.equal(batch.rejected, 3);
    assert.equal(batch.phoneRemoved, 1);
    const many = sanitizeBatch(Array.from({ length: MAX_LISTINGS_PER_SEARCH + 7 }, (_, index) => draft({ externalId: `m-${index}`, url: `https://annonces-demo-a.example/annonce/m-${index}` })), NOW);
    assert.equal(many.listings.length, MAX_LISTINGS_PER_SEARCH);
    assert.equal(many.truncated, 7);
  });
});

describe("bornes du nettoyage : dates, réponse énorme (lot EXT1-bis)", () => {
  test("date de publication : du 1er janvier 2000 à demain, sinon le champ est écarté (l'annonce est gardée) — jamais une date que PostgreSQL refuserait", () => {
    const day = 86_400_000;
    assert.equal(LISTED_AT_MIN_MS, Date.UTC(2000, 0, 1));
    assert.equal(cleanListedAt(new Date(LISTED_AT_MIN_MS - 1), NOW), null, "1999-12-31T23:59:59.999Z");
    assert.equal(cleanListedAt(new Date(LISTED_AT_MIN_MS), NOW)?.toISOString(), "2000-01-01T00:00:00.000Z");
    assert.equal(cleanListedAt(new Date(NOW.getTime() + day), NOW)?.getTime(), NOW.getTime() + day, "demain, à la milliseconde près");
    assert.equal(cleanListedAt(new Date(NOW.getTime() + day + 1), NOW), null);
    assert.equal(cleanListedAt(new Date("-005000-01-01T00:00:00Z"), NOW), null, "an 5001 avant notre ère (le cas de l'audit : erreur 22008 de PostgreSQL)");
    assert.equal(cleanListedAt(new Date(-8.64e15), NOW), null);
    assert.equal(cleanListedAt(new Date(8.64e15), NOW), null);
    assert.equal(cleanListedAt(new Date(Number.NaN), NOW), null);
    for (const notADate of ["2026-10-06T08:00:00Z", NOW.getTime(), null, undefined, {}]) assert.equal(cleanListedAt(notADate, NOW), null, String(notADate));
    const copy = cleanListedAt(NOW, NOW) as Date;
    assert.notEqual(copy, NOW, "une copie : le connecteur ne peut plus la modifier");
    for (const absurd of [new Date("-005000-01-01T00:00:00Z"), new Date(-8.64e15), new Date(8.64e15), new Date("1969-07-20T00:00:00Z"), new Date(NOW.getTime() + 400 * day)]) {
      const result = sanitizeDraft(draft({ listedAt: absurd }), NOW);
      assert.ok(result.ok, `l'annonce est gardée (${absurd.toISOString?.call(absurd) ?? "?"})`);
      if (result.ok) assert.equal(result.listing.listedAt, null);
    }
    const batch = sanitizeBatch([draft({ externalId: "bad", listedAt: new Date("-005000-01-01T00:00:00Z"), url: "https://annonces-demo-a.example/annonce/bad" }), draft({ externalId: "good", url: "https://annonces-demo-a.example/annonce/good" })], NOW);
    assert.equal(batch.listings.length, 2, "aucune annonce rejetée pour sa date");
    assert.equal(batch.rejected, 0);
  });

  test("réponse énorme : tronquée à 4 × 50 entrées AVANT tout nettoyage (les entrées au-delà ne sont même pas lues)", () => {
    assert.equal(MAX_RAW_ENTRIES_PER_SEARCH, 4 * MAX_LISTINGS_PER_SEARCH);
    let touched = 0;
    const hostile = (): unknown => new Proxy({}, { get() { touched += 1; throw new Error("lue alors qu'elle devait être écartée"); }, has() { touched += 1; return false; }, ownKeys() { touched += 1; return []; } });
    const drafts: unknown[] = Array.from({ length: MAX_RAW_ENTRIES_PER_SEARCH }, (_, index) => draft({ externalId: `big-${index}`, url: `https://annonces-demo-a.example/annonce/big-${index}` }));
    for (let index = 0; index < 5_000; index++) drafts.push(hostile());
    const batch = sanitizeBatch(drafts, NOW);
    assert.equal(touched, 0, "aucune entrée au-delà de la 200e n'est lue");
    assert.equal(batch.listings.length, MAX_LISTINGS_PER_SEARCH);
    assert.equal(batch.truncated, 5_000 + (MAX_RAW_ENTRIES_PER_SEARCH - MAX_LISTINGS_PER_SEARCH), "5 000 entrées non lues + les annonces valides au-delà de 50");
    assert.equal(batch.rejected, 0);
    // Une réponse de 400 000 entrées n'occupe pas le processus (l'audit mesurait 13 s avant la correction).
    const gigantic: unknown[] = new Array(400_000).fill(null);
    const started = performance.now();
    const huge = sanitizeBatch(gigantic, NOW);
    assert.ok(performance.now() - started < 250, `réponse énorme traitée en ${Math.round(performance.now() - started)} ms`);
    assert.equal(huge.rejected, MAX_RAW_ENTRIES_PER_SEARCH, "seules les 200 premières entrées ont été regardées");
    assert.equal(huge.truncated, 400_000 - MAX_RAW_ENTRIES_PER_SEARCH);
  });

  test("texte énorme : coupé avant le nettoyage, résultat borné", () => {
    const started = performance.now();
    const result = sanitizeDraft(draft({ title: `${"x".repeat(20_000_000)} iPhone 12`, location: "y ".repeat(5_000_000) }), NOW);
    assert.ok(performance.now() - started < 1_000);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.listing.title?.length, 200);
      assert.ok((result.listing.location?.length ?? 0) <= 120);
    }
  });
});

describe("analyse du contenu et confirmation du produit", () => {
  test("mots : accents, casse, chiffres et lettres séparés, gb → go, + → plus", () => {
    assert.deepEqual(tokenize("iPhone 12 128Go Noir – Très bon état !"), ["iphone", "12", "128", "go", "noir", "tres", "bon", "etat"]);
    assert.deepEqual(tokenize("Galaxy S21+ 128GB"), ["galaxy", "s", "21", "plus", "128", "go"]);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize("   "), []);
    assert.ok(tokenize("mot ".repeat(100)).length <= 60);
  });

  test("empreinte : stable, insensible à la casse et aux accents, sensible au prix, à la devise, au lieu et au titre ; 64 caractères hexadécimaux", () => {
    const base = { title: "iPhone 12 128 Go Noir", priceAmount: 150_000, priceCurrency: "XOF", location: "Cocody" };
    const hash = contentHashOf(base);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(contentHashOf({ ...base }), hash);
    assert.equal(contentHashOf({ ...base, title: "IPHONE 12 128 GO NOIR", location: "COCODY" }), hash);
    assert.equal(contentHashOf({ ...base, title: "iPhone 12 128 Go Noir", location: "Côcody" }), contentHashOf({ ...base, location: "Cocody" }));
    for (const changed of [{ title: "iPhone 12 64 Go Noir" }, { priceAmount: 149_000 }, { priceCurrency: "EUR" }, { location: "Marcory" }, { title: null }, { priceAmount: null, priceCurrency: null }]) {
      assert.notEqual(contentHashOf({ ...base, ...changed }), hash, JSON.stringify(changed));
    }
    assert.ok(ANALYZER_VERSION.length > 0);
  });

  test("confirmsKey : le modèle en mots consécutifs ; ni accessoire, ni extension (Pro, Max, mini, FE, Ultra, +), ni variante absente", () => {
    const confirms = (title: string, key: Partial<ProductKey> = {}) => confirmsKey(analyzeContent({ title, priceAmount: null, priceCurrency: null, location: null }), { model: "iphone 12", variant: null, ...key });
    assert.equal(confirms("iPhone 12 128 Go noir"), true);
    assert.equal(confirms("Apple iPhone12 noir"), true);
    assert.equal(confirms("iPhone 12"), true);
    assert.equal(confirms("iPhone 12 Pro 128 Go"), false);
    assert.equal(confirms("iPhone 12 Pro Max"), false);
    assert.equal(confirms("iPhone 12 mini"), false);
    assert.equal(confirms("iPhone 13 128 Go"), false);
    assert.equal(confirms("iPhone 128 Go 12 mois de garantie"), false, "mots non consécutifs");
    assert.equal(confirms("Coque silicone pour iPhone 12"), false);
    assert.equal(confirms("Film protection iPhone 12"), false);
    assert.equal(confirms("iPhone 12 pour pièces"), false);
    assert.equal(confirms("Cherche iPhone 12"), false);
    assert.equal(confirms("iPhone 12 Pro", { model: "iphone 12 pro" }), true, "l'extension fait partie de la clé");
    assert.equal(confirms("iPhone 12 Pro Max", { model: "iphone 12 pro" }), false);
    assert.equal(confirms("Samsung Galaxy S21 Ultra", { model: "galaxy s21" }), false);
    assert.equal(confirms("Samsung Galaxy S21 FE", { model: "galaxy s21" }), false);
    assert.equal(confirms("Samsung Galaxy S21+", { model: "galaxy s21" }), false);
    assert.equal(confirms("Samsung Galaxy S21 128Go", { model: "galaxy s21" }), true);
    assert.equal(confirms("iPhone 12 64 Go", { variant: "128 go" }), false);
    assert.equal(confirms("iPhone 12 128Go", { variant: "128 go" }), true);
    assert.equal(confirms("MacBook Air M1 2020", { model: "macbook air m1" }), true);
    assert.equal(confirms("", {}), false);
  });

  test("analyse stockée : relue avec contrôle de forme", () => {
    const analysis = analyzeContent({ title: "iPhone 12", priceAmount: null, priceCurrency: null, location: null });
    assert.deepEqual(parseAnalysis(JSON.parse(JSON.stringify(analysis))), analysis);
    for (const bad of [null, "x", {}, { version: "autre", tokens: [], notTheProduct: false }, { version: ANALYZER_VERSION, tokens: [1], notTheProduct: false }, { version: ANALYZER_VERSION, tokens: [], notTheProduct: "non" }]) {
      assert.equal(parseAnalysis(bad), null);
    }
  });
});

describe("doublons entre sources", () => {
  const candidate = (sourceCode: string, price: number | null, title: string, currency: string | null = "XOF") => ({ sourceCode, priceAmount: price, priceCurrency: currency, tokens: tokenize(title) });

  test("prix à 2 % près du plus bas : borne exacte, devises différentes ou prix inconnu = jamais", () => {
    assert.equal(DUPLICATE_PRICE_TOLERANCE, 0.02);
    const within = (a: number, b: number) => pricesWithinTolerance({ priceAmount: a, priceCurrency: "XOF" }, { priceAmount: b, priceCurrency: "XOF" });
    assert.equal(within(100_000, 102_000), true);
    assert.equal(within(102_000, 100_000), true, "symétrique");
    assert.equal(within(100_000, 102_001), false);
    assert.equal(within(100_000, 100_000), true);
    assert.equal(within(0, 0), true);
    assert.equal(within(0, 1), false);
    assert.equal(pricesWithinTolerance({ priceAmount: 1, priceCurrency: "XOF" }, { priceAmount: 1, priceCurrency: "EUR" }), false);
    assert.equal(pricesWithinTolerance({ priceAmount: null, priceCurrency: null }, { priceAmount: null, priceCurrency: null }), false);
    assert.equal(pricesWithinTolerance({ priceAmount: 1, priceCurrency: "XOF" }, { priceAmount: null, priceCurrency: null }), false);
  });

  test("titre proche : mots significatifs (Jaccard, seuil 0,6)", () => {
    assert.equal(DUPLICATE_TITLE_SIMILARITY, 0.6);
    assert.equal(titleSimilarity(tokenize("iPhone 12 128 Go noir, bon état"), tokenize("Iphone 12 128Go noir (très bon état)")), 1);
    assert.equal(titleSimilarity([], tokenize("iPhone")), 0);
    assert.equal(titleSimilarity(tokenize("bon état"), tokenize("bon état")), 0, "que des mots sans valeur distinctive");
  });

  test("« 64 Go » et « 128 Go » (et toute capacité ou taille d'écran qui diffère) ne sont JAMAIS des doublons, même au même prix : le seuil de Jaccard seul ne suffit pas", () => {
    // Le seuil réel : « iPhone 12 64 Go » / « iPhone 12 128 Go » ont 4 mots communs sur 6, soit EXACTEMENT 0,6 = le seuil ; sans la règle des nombres ils seraient regroupés.
    assert.equal(titleSimilarity(tokenize("iPhone 12 64 Go"), tokenize("iPhone 12 128 Go")), 0.6);
    assert.ok(titleSimilarity(tokenize("iPhone 12 64 Go"), tokenize("iPhone 12 128 Go")) >= DUPLICATE_TITLE_SIMILARITY, "le seuil de ressemblance est atteint : seule la règle des nombres sépare ces deux produits");
    assert.ok(titleSimilarity(tokenize("iPhone 12 64Go noir"), tokenize("iPhone 12 128Go noir")) >= DUPLICATE_TITLE_SIMILARITY);
    assert.ok(titleSimilarity(tokenize("Samsung Galaxy S21 128 Go bleu"), tokenize("Samsung Galaxy S21 256 Go bleu")) >= DUPLICATE_TITLE_SIMILARITY);
    const pair = (x: string, y: string, priceB = 150_000) =>
      isDuplicatePair({ sourceCode: "demo_a", priceAmount: 150_000, priceCurrency: "XOF", tokens: tokenize(x) }, { sourceCode: "demo_b", priceAmount: priceB, priceCurrency: "XOF", tokens: tokenize(y) });
    for (const [x, y] of [
      ["iPhone 12 64 Go", "iPhone 12 128 Go"], ["iPhone 12 64Go noir", "iPhone 12 128Go noir"], ["iPhone 12 64 GB noir", "iPhone 12 128 Go noir"], ["Samsung Galaxy S21 128 Go bleu", "Samsung Galaxy S21 256 Go bleu"],
      ["TV LG 55 pouces", "TV LG 65 pouces"], ["MacBook Air 13 pouces M1", "MacBook Air 15 pouces M1"], ["iPad Air 10.9 pouces 64 Go", "iPad Air 11 pouces 64 Go"], ["iPhone 12 128 Go", "iPhone 12 noir"],
    ]) {
      assert.equal(pair(x, y), false, `${x} / ${y} : produits différents, même prix`);
      assert.equal(pair(y, x), false, `${y} / ${x} (symétrique)`);
      assert.equal(pair(x, y, 151_000), false, `${x} / ${y} : prix voisins`);
    }
    // Les mêmes nombres écrits autrement restent des doublons.
    for (const [x, y] of [["iPhone 12 128 Go noir, bon état", "Iphone 12 128Go noir (très bon état)"], ["iPhone 12 128 GB noir", "iPhone 12 128 Go noir"], ["TV LG 55 pouces", "TV LG 55 pouces"]]) {
      assert.equal(pair(x, y), true, `${x} / ${y} : même produit`);
    }
    assert.deepEqual(titleNumbers(tokenize("iPhone 12 128Go 128 noir 007")), ["12", "128", "7"], "nombres sans doublon, triés");
    assert.equal(sameTitleNumbers(tokenize("iPhone 12 64 Go"), tokenize("iPhone 12 128 Go")), false);
    assert.equal(sameTitleNumbers(tokenize("iPhone douze"), tokenize("iPhone onze")), true, "aucun nombre de part et d'autre");
  });

  test("la même adresse chez deux sources désigne la même annonce (doublon), même si le titre et le prix diffèrent ; jamais dans une même source", () => {
    const a = { sourceCode: "demo_a", priceAmount: 150_000, priceCurrency: "XOF", tokens: tokenize("iPhone 12 noir"), url: "https://agregateur.example/annonce/42" };
    const b = { sourceCode: "demo_b", priceAmount: 95_000, priceCurrency: "XOF", tokens: tokenize("iPhone 12 noir garantie"), url: "https://agregateur.example/annonce/42" };
    assert.equal(isDuplicatePair(a, b), true);
    assert.equal(isDuplicatePair(b, a), true);
    assert.equal(isDuplicatePair(a, { ...b, url: "https://agregateur.example/annonce/43" }), false, "adresse différente : les règles de prix et de titre s'appliquent");
    assert.equal(isDuplicatePair(a, { ...b, sourceCode: "demo_a" }), false, "une même source n'est jamais regroupée");
    assert.equal(isDuplicatePair({ ...a, url: "" }, { ...b, url: "" }), false, "pas d'adresse : pas d'identité");
    assert.equal(isDuplicatePair({ ...a, url: null }, { ...b, url: null }), false);
  });

  test("deux annonces d'une même source ne sont jamais des doublons ; entre sources : prix ET titre", () => {
    const a = candidate("demo_a", 100_000, "iPhone 12 128 Go noir");
    assert.equal(isDuplicatePair(a, candidate("demo_a", 100_000, "iPhone 12 128 Go noir")), false);
    assert.equal(isDuplicatePair(a, candidate("demo_b", 101_000, "iPhone 12 128 Go noir")), true);
    assert.equal(isDuplicatePair(a, candidate("demo_b", 110_000, "iPhone 12 128 Go noir")), false, "prix trop éloigné");
    assert.equal(isDuplicatePair(a, candidate("demo_b", 100_000, "iPhone 12 256 Go blanc")), false, "titre différent");
  });

  test("composantes connexes : union transitive, singletons isolés", () => {
    assert.deepEqual(connectedComponents(5, [[0, 1], [1, 2]]).map((component) => component.sort()), [[0, 1, 2], [3], [4]]);
    assert.deepEqual(connectedComponents(3, []), [[0], [1], [2]]);
    assert.deepEqual(connectedComponents(4, [[3, 0], [1, 2]]).map((component) => component.sort()), [[0, 3], [1, 2]]);
  });
});

describe("connecteurs fictifs", () => {
  test("déterministes : même clé, même source, même jour → mêmes annonces ; autres sources et clés → autres annonces", () => {
    const first = fakeCatalog(FAKE_SOURCE_A, IPHONE, NOW);
    assert.deepEqual(fakeCatalog(FAKE_SOURCE_A, IPHONE, NOW), first);
    assert.notDeepEqual(fakeCatalog(FAKE_SOURCE_B, IPHONE, NOW), first);
    assert.notDeepEqual(fakeCatalog(FAKE_SOURCE_A, { ...IPHONE, model: "galaxy s21", brand: "samsung" }, NOW), first);
    assert.equal(fakeReferencePrice(IPHONE), 150_000);
    assert.equal(fakeReferencePrice({ ...IPHONE, model: "modèle inconnu 7" }), fakeReferencePrice({ ...IPHONE, model: "modèle inconnu 7" }));
  });

  test("catalogue : identifiants et URL uniques, domaine réservé .example en https, aucun numéro dans aucun champ sauf l'annonce piégée de la source B", () => {
    const all = [...fakeCatalog(FAKE_SOURCE_A, IPHONE, NOW), ...fakeCatalog(FAKE_SOURCE_B, IPHONE, NOW)];
    assert.equal(new Set(all.map((item) => item.externalId)).size, all.length);
    assert.equal(new Set(all.map((item) => item.url)).size, all.length);
    for (const item of all) {
      assert.match(item.url, /^https:\/\/annonces-demo-[ab]\.example\/annonce\/demo_[ab]-/);
      assert.equal(looksLikePhoneNumber(item.url), false, item.url);
      assert.equal(looksLikePhoneNumber(item.externalId), false, item.externalId);
    }
    const trapped = all.filter((item) => looksLikePhoneNumber(item.title));
    assert.equal(trapped.length, 1, "une seule annonce piégée");
    assert.equal(trapped[0].externalId.startsWith("demo_b"), true);
    // La source B contient le doublon de la première annonce de la source A (prix à 1 %).
    const [a1] = fakeCatalog(FAKE_SOURCE_A, IPHONE, NOW);
    const [b1] = fakeCatalog(FAKE_SOURCE_B, IPHONE, NOW);
    assert.equal(isDuplicatePair({ sourceCode: "demo_a", priceAmount: a1.price, priceCurrency: "XOF", tokens: tokenize(a1.title) }, { sourceCode: "demo_b", priceAmount: b1.price, priceCurrency: "XOF", tokens: tokenize(b1.title) }), true);
    assert.equal(b1.currency, "FCFA", "la source B écrit FCFA : normalisé en XOF par le nettoyage");
  });

  test("pilotage : panne, lenteur (honore l'annulation), annonces disparues, réponse invalide, dérive de prix, annonces en plus, compteur d'appels", async () => {
    const connector = createFakeConnector(FAKE_SOURCE_A);
    const context = () => ({ signal: new AbortController().signal, now: NOW });
    const base = await connector.search(IPHONE, context());
    assert.equal(connector.controls.calls, 1);
    assert.equal(connector.kind, "fake");
    connector.controls.hidden.add(base[0].externalId);
    assert.equal((await connector.search(IPHONE, context())).length, base.length - 1);
    connector.controls.hidden.clear();
    connector.controls.priceDriftPercent = 10;
    const drifted = await connector.search(IPHONE, context());
    assert.equal(drifted[0].price, Math.round((base[0].price as number) * 1.1));
    connector.controls.priceDriftPercent = 0;
    connector.controls.extra = [draft({ externalId: "plus" })];
    assert.equal((await connector.search(IPHONE, context())).length, base.length + 1);
    connector.controls.extra = [];
    connector.controls.malformed = true;
    assert.equal(Array.isArray(await connector.search(IPHONE, context())), false);
    connector.controls.malformed = false;
    connector.controls.failure = new Error("panne");
    await assert.rejects(() => connector.search(IPHONE, context()), /panne/);
    connector.controls.failure = null;
    connector.controls.latencyMs = 5_000;
    const controller = new AbortController();
    const slow = connector.search(IPHONE, { signal: controller.signal, now: NOW });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => slow, (error: Error) => error.name === "AbortError");
    assert.equal(connector.controls.calls, 7);
  });

  test("deux connecteurs : « Annonces Démo A » et « Annonces Démo B » (codes demo_a et demo_b), tous de type fictif", () => {
    const connectors = createFakeConnectors();
    assert.deepEqual(connectors.map((connector) => connector.code), ["demo_a", "demo_b"]);
    assert.ok(connectors.every((connector) => connector.kind === "fake"));
  });
});

describe("registre : aucune source réelle", () => {
  test("seul le type « fake » est autorisé ; tout autre est refusé par la garde", () => {
    assert.equal(ALLOWED_SOURCE_TYPE, "fake");
    assert.doesNotThrow(() => assertAllowedSourceType("fake"));
    for (const type of ["real", "licensed", "http", "partner", "FAKE", "", null, undefined, 3]) {
      assert.throws(() => assertAllowedSourceType(type), SourceNotAllowedError, String(type));
    }
  });

  test("connecteurs de l'environnement : aucun en production ni sans NOMA_EXTERNAL_FAKE=1, les deux fictifs sinon", () => {
    assert.deepEqual(resolveConnectors({}), []);
    assert.deepEqual(resolveConnectors({ NODE_ENV: "development" }), []);
    assert.deepEqual(resolveConnectors({ NODE_ENV: "development", NOMA_EXTERNAL_FAKE: "0" }), []);
    assert.deepEqual(resolveConnectors({ NODE_ENV: "development", NOMA_EXTERNAL_FAKE: "true" }), []);
    assert.deepEqual(resolveConnectors({ NODE_ENV: "production", NOMA_EXTERNAL_FAKE: "1" }), [], "jamais en production");
    assert.deepEqual(resolveConnectors({ NODE_ENV: "development", NOMA_EXTERNAL_FAKE: "1" }).map((connector) => connector.code), ["demo_a", "demo_b"]);
    assert.deepEqual(resolveConnectors({ NOMA_EXTERNAL_FAKE: "1" }).map((connector) => connector.code), ["demo_a", "demo_b"]);
  });

  test("un connecteur n'est relié qu'à une source fictive de même code, et dont il est lui-même fictif", () => {
    const row = (over: Partial<SourceRow> = {}): SourceRow => ({
      code: "demo_a", name: "A", type: "fake", enabled: true, daily_quota: 1, min_interval_ms: 0, consecutive_failures: 0, breaker_open_until: null, breaker_trial_until: null, last_request_at: null,
      last_success_at: null, last_failure_at: null, last_error_code: null, ...over,
    });
    const connectors = new Map<string, SourceConnector>(createFakeConnectors().map((connector) => [connector.code, connector]));
    assert.equal(connectorFor(row(), connectors)?.code, "demo_a");
    assert.equal(connectorFor(row({ type: "licensed" }), connectors), null);
    assert.equal(connectorFor(row({ code: "demo_z" }), connectors), null);
    const lying = new Map<string, SourceConnector>([["demo_a", { code: "demo_a", kind: "real" as never, search: async () => [] }]]);
    assert.equal(connectorFor(row(), lying), null, "un connecteur qui n'est pas fictif n'est jamais relié");
  });

  test("réglages : 6 h, 4 requêtes par jour et par source, 3 échecs, 30 minutes, 3 absences", () => {
    assert.equal(WATCH_DEFAULT_FREQUENCY_SECONDS, 21_600);
    assert.equal(WATCH_DEFAULT_DAILY_BUDGET, 4);
    assert.equal(BREAKER_FAILURE_THRESHOLD, 3);
    assert.equal(BREAKER_PAUSE_MS, 1_800_000);
    assert.equal(GONE_AFTER_MISSED_COLLECTS, 3);
    assert.match(EXTERNAL_OWNER_ID, /^00000000-0000-4000-8000-000000000000$/);
  });

  test("tous les réglages que COLLECTE-EXTERNE.md annonce (délais, bail, essai décisif, budget de temps, lecture, conservation)", () => {
    assert.equal(SEARCH_TIMEOUT_MS, 8_000, "délai maximal d'une recherche");
    assert.equal(MAX_SOURCE_WAIT_MS, 5_000, "attente maximale du délai minimal d'une source");
    assert.equal(SOURCE_LOCK_TIMEOUT_MS, 2_000, "attente maximale du verrou de la ligne d'une source");
    assert.equal(WATCH_CLAIM_LEASE_SECONDS, 600, "bail de 10 minutes");
    assert.equal(WATCH_RETRY_SECONDS, 600, "reprise dans 10 minutes");
    assert.equal(BREAKER_TRIAL_LEASE_MS, 60_000, "jeton de l'essai décisif");
    assert.equal(STEP_MAX_WATCHES, 3, "surveillances par cycle");
    assert.equal(MAX_LISTINGS_PER_SEARCH, 50);
    assert.equal(MAX_RAW_ENTRIES_PER_SEARCH, 200);
    assert.equal(VISIBLE_MAX_AGE_MS, 48 * 3_600_000);
    assert.equal(MATCH_CANDIDATE_LIMIT, 300);
    assert.equal(EXTERNAL_PAGE_DEFAULT, 6);
    assert.equal(EXTERNAL_PAGE_MAX, 30);
    assert.equal(RUNS_RETENTION_DAYS, 30);
    assert.equal(USAGE_RETENTION_DAYS, 14);
    assert.equal(DUPLICATE_TITLE_SIMILARITY, 0.6);
    assert.equal(DUPLICATE_PRICE_TOLERANCE, 0.02);
    assert.equal(EXTERNAL_ANALYSIS_LOCK_NAMESPACE, 1_314_664_981);
    assert.equal(EXTERNAL_GROUP_LOCK_NAMESPACE, 1_314_664_982);
  });

  test("NOMA_EXTERNAL_FAKE n'est pas dans la liste des variables interdites en production (elle y est simplement ignorée : aucun connecteur)", () => {
    assert.equal(PRODUCTION_FORBIDDEN_ENV.includes(FAKE_CONNECTORS_ENV), false);
    assert.equal(FAKE_CONNECTORS_ENV, "NOMA_EXTERNAL_FAKE");
    assert.deepEqual(resolveConnectors({ NODE_ENV: "production", NOMA_EXTERNAL_FAKE: "1" }), []);
  });
});

describe("état du disjoncteur, curseur, tri, doublons à la lecture", () => {
  test("état : désactivée, fermée, ouverte pendant la pause, semi-ouverte une fois la pause écoulée", () => {
    const at = (offset: number) => new Date(NOW.getTime() + offset);
    assert.equal(breakerStateOf({ enabled: false, consecutive_failures: 0, breaker_open_until: null }, NOW), "disabled");
    assert.equal(breakerStateOf({ enabled: true, consecutive_failures: 2, breaker_open_until: null }, NOW), "closed");
    assert.equal(breakerStateOf({ enabled: true, consecutive_failures: 3, breaker_open_until: at(1_000) }, NOW), "open");
    assert.equal(breakerStateOf({ enabled: true, consecutive_failures: 3, breaker_open_until: at(-1) }, NOW), "half_open");
    assert.equal(breakerStateOf({ enabled: true, consecutive_failures: 0, breaker_open_until: null }, NOW), "closed");
  });

  test("curseur : aller-retour ; toute autre forme est refusée", () => {
    const payload = { s: 100, p: 150_000, i: "11111111-1111-4111-8111-111111111111" };
    assert.deepEqual(decodeExternalCursor(encodeExternalCursor(payload)), payload);
    assert.deepEqual(decodeExternalCursor(encodeExternalCursor({ ...payload, p: null })), { ...payload, p: null });
    assert.equal(decodeExternalCursor(undefined), null);
    assert.equal(decodeExternalCursor(null), null);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const bad of ["!!", 5, "a".repeat(301), encode({ s: 1 }), encode({ ...payload, extra: 1 }), encode({ ...payload, s: "1" }), encode({ ...payload, i: "x" }), encode({ ...payload, p: -1 }), encode({ ...payload, p: 1.5 }), encode([1]), Buffer.from("pas du json").toString("base64url")]) {
      assert.throws(() => decodeExternalCursor(bad), /Curseur invalide/, String(bad).slice(0, 30));
    }
  });

  test("tri : meilleur score, puis prix croissant (sans prix en dernier), puis identifiant", () => {
    const entry = (score: number, price: number | null, id: string) => ({ score, price, row: { id } });
    const sorted = [entry(100, null, "d"), entry(90, 1, "z"), entry(100, 5, "b"), entry(100, 5, "a"), entry(100, 3, "c")].sort(compareEvaluated);
    assert.deepEqual(sorted.map((item) => item.row.id), ["c", "a", "b", "d", "z"]);
  });

  test("lecture : un groupe n'est montré qu'une fois (le moins cher), un membre qui n'est plus un doublon est montré à part", () => {
    const row = (id: string, source: string, price: number, group: string | null, title = "iPhone 12 128 Go noir") => ({
      id, source_code: source, source_name: `Source ${source}`, canonical_url: `https://${source}.example/${id}`, title, price_amount: String(price), price_currency: "XOF", location_text: "Cocody", listed_at: null,
      availability_confirmed_at: null, last_seen_at: NOW, first_seen_at: NOW, duplicate_group_id: group, analysis: null,
    });
    const entry = (rowValue: ReturnType<typeof row>) => ({ row: rowValue, score: 100, price: Number(rowValue.price_amount), candidate: { sourceCode: rowValue.source_code, priceAmount: Number(rowValue.price_amount), priceCurrency: "XOF", tokens: tokenize(rowValue.title) } });
    const result = collapseDuplicates([entry(row("1", "a", 102_000, "g")), entry(row("2", "b", 100_000, "g")), entry(row("3", "c", 150_000, "g")), entry(row("4", "d", 90_000, null))]);
    const byId = new Map(result.map((item) => [item.entry.row.id, item.alsoOn.map((source) => source.code)]));
    assert.deepEqual([...byId.keys()].sort(), ["2", "3", "4"], "1 est absorbée par 2 (moins chère) ; 3 (50 % plus cher) n'est plus un doublon");
    assert.deepEqual(byId.get("2"), ["a"]);
    assert.deepEqual(byId.get("3"), []);
  });

  test("annonce externe vue comme une offre : sans confirmation du titre, catégorie, marque et modèle restent inconnus", () => {
    const base = { id: "e1", price_amount: "150000", price_currency: "XOF", location_text: "Cocody", availability_confirmed_at: NOW, first_seen_at: NOW, last_seen_at: NOW };
    const confirmed = externalListingAsOffer({ ...base, title: "iPhone 12 noir" }, analyzeContent({ title: "iPhone 12 noir", priceAmount: null, priceCurrency: null, location: null }), IPHONE);
    assert.deepEqual([confirmed.category, confirmed.brand, confirmed.model], ["telephones", "apple", "iphone 12"]);
    assert.equal(confirmed.ownerId, EXTERNAL_OWNER_ID);
    assert.equal(confirmed.status, "published");
    assert.deepEqual(confirmed.price, { amount: 150_000, currency: "XOF" });
    const coque = externalListingAsOffer({ ...base, title: "Coque iPhone 12" }, analyzeContent({ title: "Coque iPhone 12", priceAmount: null, priceCurrency: null, location: null }), IPHONE);
    assert.deepEqual([coque.category, coque.brand, coque.model], [null, null, null]);
  });
});

/** Retire les commentaires (le texte des chaînes est conservé : c'est là que se cachent les noms de modules). */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const NETWORK_MODULES = "(?:node:)?(?:https?|http2|net|tls|dns(?:/promises)?|dgram|child_process|worker_threads|cluster|inspector|repl)";

/**
 * Analyse statique d'un module : tout ce qui peut ouvrir une connexion ou exécuter un programme. Signale `fetch`, `import … from` / `import "…"` / `require("…")` d'un module réseau
 * (avec ou sans `node:`, y compris `dns/promises`), tout `require(` et `createRequire`, tout `import(` dynamique, tout accès calculé à un global (`globalThis["fe" + "tch"]`), `eval`,
 * `Function(`, `process.binding`, et les clients connus (XMLHttpRequest, WebSocket, EventSource, undici, axios, got, node-fetch, sendBeacon, spawn, exec).
 */
export function networkFindings(source: string): string[] {
  const text = stripComments(source);
  const checks: Array<[string, RegExp]> = [
    ["fetch", /\bfetch\b/],
    ["import … from d'un module réseau", new RegExp(`\\bfrom\\s*["'\`]${NETWORK_MODULES}["'\`]`)],
    ['import "module réseau"', new RegExp(`\\bimport\\s*["'\`]${NETWORK_MODULES}["'\`]`)],
    ["require d'un module réseau", new RegExp(`\\brequire\\s*\\(\\s*["'\`]${NETWORK_MODULES}["'\`]\\s*\\)`)],
    ["require(", /\brequire\s*\(/],
    ["createRequire", /\bcreateRequire\b/],
    ["import() dynamique", /\bimport\s*\(/],
    ["globalThis (accès calculé à fetch, require…)", /\bglobalThis\b/],
    ["accès calculé à un global", /\b(?:global|window|self)\s*(?:as\s+[\w<>, ]+)?\)?\s*\[/],
    ["eval / Function(", /\b(?:eval|Function)\s*\(/],
    ["process.binding", /\bprocess\s*\.\s*(?:binding|dlopen)\b/],
    ["module node: réseau", new RegExp(`["'\`]node:(?:http|https|http2|net|tls|dns|dgram|child_process|worker_threads|cluster)\\b`)],
    ["client réseau connu", /\b(?:XMLHttpRequest|WebSocket|EventSource|undici|axios|node-fetch|sendBeacon)\b|\bgot\s*\(|\bspawn\s*\(|\bexec(?:Sync|File)?\s*\(/],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

describe("aucun appel réseau dans la collecte (analyse statique) et aucun connecteur réel", () => {
  const root = join(import.meta.dirname, "../../lib/server/external");
  const files = readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => ({ name, text: readFileSync(join(root, name), "utf8") }));

  test("le dossier existe et contient les modules attendus", () => {
    assert.ok(files.length >= 12, `${files.length} fichiers`);
    for (const expected of ["collect.ts", "fake-connectors.ts", "registry.ts", "sanitize.ts", "store.ts", "matching.ts", "http.ts"]) assert.ok(files.some((file) => file.name === expected), expected);
  });

  test("l'analyse statique reconnaît require(), import() dynamique, dns/promises, les accès calculés à un global et les clients connus (elle est elle-même testée)", () => {
    const flagged = (code: string): boolean => networkFindings(code).length > 0;
    for (const sample of [
      'const https = require("https"); https.get("https://site-reel.ci/annonces");',
      "const net = require('net');",
      'const http = require("node:http");',
      'const dns = require("dns");',
      'const dgram = require("dgram");',
      'const tls = require(`tls`);',
      'const { request } = await import("https"); request("https://site-reel.ci/");',
      'const m = await import("node:" + "http");',
      'const f = globalThis["fe" + "tch"]; await f("https://site-reel.ci/");',
      'const f = (globalThis as any)["fet" + "ch"];',
      'import { Socket } from "net"; new Socket().connect(443, "site-reel.ci");',
      'import * as dns from "dns/promises"; await dns.lookup("site-reel.ci");',
      'import { lookup } from "node:dns/promises";',
      'import "dgram";',
      'import * as tls from "tls";',
      'import { createRequire } from "node:module"; const r = createRequire(import.meta.url);',
      'const run = new Function("return fetch")();',
      "eval('1')",
      'const cp = process.binding("tcp_wrap");',
      'import { spawn } from "child_process";',
      "await fetch(url)",
      "new WebSocket(url)",
    ]) assert.equal(flagged(sample), true, sample);
    for (const clean of [
      'import { Pool } from "pg";',
      'import { createHmac } from "node:crypto";',
      'import { accentNormalize } from "../../../poc/lib/need";',
      "const required = requireUuid(id, 'x');",
      "// fetch(url) en commentaire\nconst value = 1; /* require('http') */",
      "const url = `https://annonces-demo-a.example/annonce/${id}`;",
      "const prefetched = 1; const got_it = 2;",
    ]) assert.deepEqual(networkFindings(clean), [], clean);
  });

  test("aucun fetch, aucun module réseau (import, require, import() dynamique, dns/promises), aucun accès calculé à un global, aucun processus enfant, aucun client HTTP", () => {
    for (const file of files) assert.deepEqual(networkFindings(file.text), [], file.name);
  });

  test("le seul type de connecteur et de source est « fake »", () => {
    for (const file of files) {
      for (const match of stripComments(file.text).matchAll(/\bkind:\s*["']([a-z_]+)["']/g)) assert.equal(match[1], "fake", `${file.name} : kind ${match[1]}`);
    }
    const types = readFileSync(join(root, "types.ts"), "utf8");
    assert.match(types, /readonly kind: "fake";/);
    const migration = readFileSync(join(import.meta.dirname, "../../database/migrations/0025_external_collection.sql"), "utf8");
    assert.match(migration, /type TEXT NOT NULL CHECK \(type = 'fake'\)/);
    assert.deepEqual([...migration.matchAll(/INSERT INTO external_sources[^;]*;/g)].map((match) => (match[0].match(/'fake'/g) ?? []).length), [2]);
  });
});

describe("prochaine échéance d'une surveillance (lot EXT1-bis)", () => {
  test("minuit UTC suivant : strictement après l'instant donné", () => {
    assert.equal(nextUtcMidnight(new Date("2026-10-07T10:00:00.000Z")).toISOString(), "2026-10-08T00:00:00.000Z");
    assert.equal(nextUtcMidnight(new Date("2026-10-07T23:59:59.999Z")).toISOString(), "2026-10-08T00:00:00.000Z");
    assert.equal(nextUtcMidnight(new Date("2026-10-08T00:00:00.000Z")).toISOString(), "2026-10-09T00:00:00.000Z", "à minuit pile : le jour suivant");
    assert.equal(nextUtcMidnight(new Date("2026-12-31T12:00:00.000Z")).toISOString(), "2027-01-01T00:00:00.000Z");
    assert.equal(nextUtcMidnight(new Date("2028-02-28T12:00:00.000Z")).toISOString(), "2028-02-29T00:00:00.000Z");
  });

  test("fréquence si une source a répondu ; 10 minutes si rien n'a pu partir ou si une source a été refusée pour son délai ; minuit UTC si SEUL le quota ou le budget du jour bloque", () => {
    const frequency = 6 * 3_600;
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1_000).toISOString();
    const plan = (verdict: { queried: number; active: number; dayLimited: number; transient: number }) => planNextRun(NOW, frequency, verdict).toISOString();
    assert.equal(plan({ queried: 2, active: 2, dayLimited: 0, transient: 0 }), at(frequency));
    assert.equal(plan({ queried: 1, active: 2, dayLimited: 1, transient: 0 }), at(frequency), "une source a répondu, l'autre est au quota : fréquence normale");
    assert.equal(plan({ queried: 1, active: 2, dayLimited: 0, transient: 0 }), at(frequency), "l'autre est en pause (disjoncteur) : fréquence normale");
    assert.equal(plan({ queried: 1, active: 2, dayLimited: 0, transient: 1 }), at(600), "une source refusée pour son délai minimal : à reprendre bientôt");
    assert.equal(plan({ queried: 0, active: 2, dayLimited: 0, transient: 2 }), at(600));
    assert.equal(plan({ queried: 0, active: 2, dayLimited: 1, transient: 0 }), at(600), "une source en pause et l'autre au quota : 10 minutes");
    assert.equal(plan({ queried: 0, active: 0, dayLimited: 0, transient: 0 }), at(600), "aucune source active");
    assert.equal(plan({ queried: 0, active: 2, dayLimited: 2, transient: 0 }), "2026-10-08T00:00:00.000Z", "quota et budget du jour épuisés partout : minuit UTC, pas toutes les 10 minutes");
    assert.equal(plan({ queried: 0, active: 1, dayLimited: 1, transient: 0 }), "2026-10-08T00:00:00.000Z");
  });

  test("réglages EXT1-bis : budget de temps de l'étape 10 s", () => {
    assert.equal(STEP_TIME_BUDGET_MS, 10_000);
  });
});
