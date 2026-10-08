import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { readBinaryBodyCapped } from "../../lib/server/media/body";
import {
  MEDIA_DEFAULT_DIRECTORY, MEDIA_DIRECTORY_VARIABLE, MEDIA_GC_DEFAULT_MIN_AGE_SECONDS, MEDIA_GC_MIN_AGE_VARIABLE, MEDIA_GC_PRODUCTION_VARIABLE,
  MEDIA_GC_MISSING_MAX_COUNT, MEDIA_GC_MISSING_MAX_PERCENT, PHOTO_BODY_READ_TIMEOUT_MS, PHOTO_CACHE_CONTROL, PHOTO_MAX_BYTES, PHOTO_SECURITY_HEADERS,
} from "../../lib/server/media/config";
import { MediaError } from "../../lib/server/media/errors";
import { missingRowsGuard, resolveMinAgeSeconds } from "../../lib/server/media/gc";
import { DiskMediaStore, MEDIA_KEY, MEDIA_TEMPORARY_FILE, resolveMediaDirectory } from "../../lib/server/media/store";
import { purgeEnvironmentRefusal } from "../../lib/server/metrics/purge";

/**
 * Stockage des photos (lot PH1) : port MediaStore sur disque, noms de fichiers (uuid seulement), traversée de chemin impossible, liens symboliques jamais suivis, écriture
 * atomique sans écrasement, dossier de l'environnement (obligatoire en production), lecture bornée du corps, garde de `media:gc`.
 */

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "noma-media-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (length: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(length).fill(fill);
const fresh = async (): Promise<{ store: DiskMediaStore; dir: string }> => {
  const dir = await mkdtemp(join(root, "store-"));
  return { store: new DiskMediaStore(dir), dir };
};

describe("clés et noms de fichiers", () => {
  test("seul un UUID v4 en minuscules est une clé de photo ; un nom de fichier temporaire a sa forme propre", () => {
    const key = randomUUID();
    assert.match(key, MEDIA_KEY);
    for (const bad of ["", "../etc/passwd", "..", ".", `${key}/..`, `${key}.png`, key.toUpperCase(), `${key} `, `/${key}`, `${key}\0`, "a".repeat(36), `photo.jpg`, `..%2f${key}`, `${key.slice(0, 35)}`]) {
      assert.equal(MEDIA_KEY.test(bad), false, JSON.stringify(bad));
    }
    assert.match(`.${key}.0123456789abcdef.tmp`, MEDIA_TEMPORARY_FILE);
    assert.equal(MEDIA_TEMPORARY_FILE.test(`.${key}.0123456789abcdef.tmp/../x`), false);
  });

  test("traversée de chemin : AUCUNE clé hors UUID n'atteint le système de fichiers (put, get, delete), et rien n'est écrit hors du dossier", async () => {
    const { store, dir } = await fresh();
    const outside = join(dir, "..", "intrus");
    const attempts = ["../intrus", "../../etc/passwd", "..", `${randomUUID()}/../../intrus`, "/etc/passwd", `${randomUUID()}.png`, "intrus", "\0", ""];
    for (const key of attempts) {
      await assert.rejects(store.put(key, bytes(300)), (error: unknown) => error instanceof MediaError && error.code === "invalid_key", `put ${JSON.stringify(key)}`);
      await assert.rejects(store.get(key), (error: unknown) => error instanceof MediaError && error.code === "invalid_key", `get ${JSON.stringify(key)}`);
      await assert.rejects(store.delete(key), (error: unknown) => error instanceof MediaError && error.code === "invalid_key", `delete ${JSON.stringify(key)}`);
    }
    await assert.rejects(stat(outside));
    assert.deepEqual(await readdir(dir), [], "le dossier de stockage reste vide");
  });

  test("le fichier est écrit sous la clé, dans le dossier (jamais ailleurs), en 0600, sans extension ni nom d'origine", async () => {
    const { store, dir } = await fresh();
    const key = randomUUID();
    await store.put(key, bytes(1_000, 9));
    assert.deepEqual(await readdir(dir), [key]);
    const info = await stat(join(dir, key));
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(new Uint8Array(await readFile(join(dir, key))), bytes(1_000, 9));
    assert.deepEqual(await store.get(key), bytes(1_000, 9));
  });
});

describe("écriture, lecture, suppression", () => {
  test("aucun écrasement : une clé déjà prise est refusée et le premier contenu reste", async () => {
    const { store } = await fresh();
    const key = randomUUID();
    await store.put(key, bytes(300, 1));
    await assert.rejects(store.put(key, bytes(300, 2)), (error: unknown) => error instanceof MediaError && error.code === "storage_unavailable");
    assert.deepEqual(await store.get(key), bytes(300, 1));
  });

  test("aucun fichier temporaire ne reste après une écriture réussie ; poids vide ou trop grand refusé", async () => {
    const { store, dir } = await fresh();
    await store.put(randomUUID(), bytes(500));
    assert.equal((await readdir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
    await assert.rejects(store.put(randomUUID(), new Uint8Array(0)), (error: unknown) => error instanceof MediaError && error.code === "file_too_large");
    await assert.rejects(store.put(randomUUID(), bytes(PHOTO_MAX_BYTES + 1)), (error: unknown) => error instanceof MediaError && error.code === "file_too_large");
    await store.put(randomUUID(), bytes(PHOTO_MAX_BYTES));
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(".")), []);
  });

  test("lecture : null pour une clé absente ; un lien symbolique n'est JAMAIS suivi (ni lu, ni listé comme photo)", async () => {
    const { store, dir } = await fresh();
    assert.equal(await store.get(randomUUID()), null);
    const secret = join(root, "secret.txt");
    await writeFile(secret, "contenu confidentiel");
    const key = randomUUID();
    await symlink(secret, join(dir, key));
    assert.equal(await store.get(key), null, "le lien mène hors du dossier : refusé");
    const listing = await store.list();
    assert.deepEqual(listing.objects, []);
    assert.equal(listing.foreign, 1, "le lien est compté comme étranger, jamais comme photo");
    assert.equal(await readFile(secret, "utf8"), "contenu confidentiel");
  });

  test("suppression : true si le fichier existait, false sinon ; un fichier temporaire se supprime par son nom", async () => {
    const { store, dir } = await fresh();
    const key = randomUUID();
    await store.put(key, bytes(300));
    assert.equal(await store.delete(key), true);
    assert.equal(await store.delete(key), false);
    const temporary = `.${randomUUID()}.0123456789abcdef.tmp`;
    await writeFile(join(dir, temporary), "x");
    assert.equal(await store.delete(temporary), true);
  });

  test("liste : photos, temporaires et étrangers distingués ; un dossier absent n'est pas une erreur", async () => {
    const { store, dir } = await fresh();
    const key = randomUUID();
    await store.put(key, bytes(321));
    await writeFile(join(dir, `.${randomUUID()}.0123456789abcdef.tmp`), "x");
    await writeFile(join(dir, "notes.txt"), "personnelles");
    await mkdir(join(dir, "sous-dossier"));
    const listing = await store.list();
    assert.equal(listing.exists, true);
    assert.deepEqual(listing.objects.map((object) => [object.kind, object.kind === "photo" ? object.name : "t", object.size]).sort(), [["photo", key, 321], ["temporary", "t", 1]]);
    assert.equal(listing.foreign, 2, "notes.txt et le sous-dossier : jamais touchés");
    const missing = await new DiskMediaStore(join(dir, "absent")).list();
    assert.deepEqual(missing, { objects: [], foreign: 0, exists: false });
  });

  test("un dossier de stockage inaccessible en écriture donne storage_unavailable (jamais le message système)", async () => {
    const { dir } = await fresh();
    const locked = join(dir, "verrouille");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      if (process.getuid?.() === 0) return; // root passe outre les droits
      await assert.rejects(new DiskMediaStore(join(locked, "sous")).put(randomUUID(), bytes(300)), (error: unknown) => error instanceof MediaError && error.code === "storage_unavailable" && !/EACCES|permission/i.test(error.message));
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("dossier de stockage de l'environnement", () => {
  test("NOMA_MEDIA_DIR choisit le dossier ; sinon data/media hors production ; en production la variable est obligatoire", () => {
    const cwd = "/srv/noma";
    assert.equal(resolveMediaDirectory({ [MEDIA_DIRECTORY_VARIABLE]: "/var/lib/noma/media" }, cwd), "/var/lib/noma/media");
    assert.equal(resolveMediaDirectory({ [MEDIA_DIRECTORY_VARIABLE]: "stock/photos" }, cwd), resolve(cwd, "stock/photos"));
    assert.equal(resolveMediaDirectory({}, cwd), resolve(cwd, MEDIA_DEFAULT_DIRECTORY));
    assert.equal(MEDIA_DEFAULT_DIRECTORY, "data/media");
    assert.equal(resolveMediaDirectory({ NODE_ENV: "development" }, cwd), resolve(cwd, "data/media"));
    assert.equal(resolveMediaDirectory({ NODE_ENV: "test", [MEDIA_DIRECTORY_VARIABLE]: "  " }, cwd), resolve(cwd, "data/media"), "variable vide = absente");
    assert.throws(() => resolveMediaDirectory({ NODE_ENV: "production" }, cwd), (error: unknown) => error instanceof MediaError);
    assert.equal(resolveMediaDirectory({ NODE_ENV: "production", [MEDIA_DIRECTORY_VARIABLE]: "/data/media" }, cwd), "/data/media");
    assert.throws(() => resolveMediaDirectory({ [MEDIA_DIRECTORY_VARIABLE]: "/tmp/x\0y" }, cwd), (error: unknown) => error instanceof MediaError);
  });

  test("le dossier par défaut est hors de public/ et ignoré par git", async () => {
    const cwd = process.cwd();
    const directory = resolveMediaDirectory({}, cwd);
    assert.ok(!directory.startsWith(join(cwd, "public")), "hors de public/");
    const ignore = await readFile(join(cwd, ".gitignore"), "utf8");
    assert.match(ignore, /^\/data\/$/m, "data/ est ignoré par git");
  });
});

describe("lecture bornée du corps d'une requête", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("https://noma.test/api", { method: "POST", body, headers, duplex: "half" } as RequestInit);

  test("corps lu en entier, vide refusé, trop gros refusé (Content-Length annoncé, ou flux qui dépasse sans l'annoncer)", async () => {
    const ok = await readBinaryBodyCapped(post(bytes(1_000, 3)), 2_000);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.bytes, bytes(1_000, 3));
    assert.deepEqual(await readBinaryBodyCapped(post(new Uint8Array(0)), 2_000), { ok: false, reason: "empty" });
    assert.deepEqual(await readBinaryBodyCapped(post(null), 2_000), { ok: false, reason: "empty" });
    assert.deepEqual(await readBinaryBodyCapped(post(bytes(2_001)), 2_000), { ok: false, reason: "too_large" });
    assert.equal((await readBinaryBodyCapped(post(bytes(2_000)), 2_000)).ok, true, "exactement la limite : accepté");
    assert.deepEqual(await readBinaryBodyCapped(post(bytes(10), { "content-length": "999999" }), 2_000), { ok: false, reason: "too_large" });
    assert.deepEqual(await readBinaryBodyCapped(post(bytes(10), { "content-length": "abc" }), 2_000), { ok: false, reason: "invalid" });
    assert.deepEqual(await readBinaryBodyCapped(post(bytes(10), { "content-length": "-5" }), 2_000), { ok: false, reason: "invalid" });
    // Flux sans Content-Length qui dépasse : coupé au premier octet de trop.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 100) return controller.close();
        sent += 1;
        controller.enqueue(bytes(100));
      },
    });
    assert.deepEqual(await readBinaryBodyCapped(post(stream), 2_000), { ok: false, reason: "too_large" });
    assert.ok(sent < 100, `le flux n'a pas été lu jusqu'au bout (${sent} morceaux)`);
  });

  test("corps lent : un octet toutes les 2 s (ici 1 ms pour 50 ms de délai) est coupé au délai TOTAL (timeout), même s'il ne dépasse jamais le plafond ; le flux est annulé", async () => {
    assert.equal(PHOTO_BODY_READ_TIMEOUT_MS, 30_000, "défaut : 30 s");
    let sent = 0;
    let cancelled = false;
    const drip = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        sent += 1;
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    assert.deepEqual(await readBinaryBodyCapped(post(drip), 2_000, 50), { ok: false, reason: "timeout" });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 45 && elapsed < 1_000, `coupé au délai : ${elapsed.toFixed(0)} ms`);
    assert.ok(sent < 2_000, `le plafond d'octets n'a pas été atteint (${sent} octets) : c'est le délai qui coupe`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelled, true, "le flux a été annulé");
    // Un corps qui ne démarre jamais est coupé aussi ; un corps rapide n'est pas touché par le délai.
    const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const settles = <T,>(promise: Promise<T>): Promise<T | "suspendu"> => Promise.race([promise, new Promise<"suspendu">((resolve) => setTimeout(() => resolve("suspendu"), 1_000))]);
    assert.deepEqual(await settles(readBinaryBodyCapped(post(silent), 2_000, 50)), { ok: false, reason: "timeout" }, "un corps qui ne démarre jamais est coupé aussi");
    const fast = await readBinaryBodyCapped(post(bytes(1_000)), 2_000, 50);
    assert.equal(fast.ok, true);
    // Cinq corps lents en parallèle sont tous coupés (aucun ne retient une connexion au-delà du délai).
    const many = await Promise.all(Array.from({ length: 5 }, () => readBinaryBodyCapped(post(new ReadableStream<Uint8Array>({ pull: async (controller) => { await new Promise((r) => setTimeout(r, 2)); controller.enqueue(Uint8Array.of(1)); } })), 2_000, 80)));
    assert.deepEqual(many.map((entry) => (entry.ok ? "ok" : entry.reason)), ["timeout", "timeout", "timeout", "timeout", "timeout"]);
  });

  test("délai PAR DÉFAUT de 30 s (horloge simulée) : un corps qui ne finit pas est coupé à 30 s pile, pas avant", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    let settled: unknown = null;
    const pending = readBinaryBodyCapped(post(silent), PHOTO_MAX_BYTES).then((result) => {
      settled = result;
      return result;
    });
    const flush = async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    };
    context.mock.timers.tick(PHOTO_BODY_READ_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, null, "29,999 s : encore en cours");
    context.mock.timers.tick(1);
    await flush();
    assert.deepEqual(settled, { ok: false, reason: "timeout" }, "30 s : coupé (la lecture ne reste jamais suspendue)");
    await pending;
  });

  test("le Content-Type n'est jamais lu : un corps déclaré text/html ou image/jpeg est lu de la même façon", async () => {
    for (const type of ["text/html", "image/jpeg", "application/json", "multipart/form-data; boundary=x"]) {
      const result = await readBinaryBodyCapped(post(bytes(10), { "content-type": type }), 2_000);
      assert.equal(result.ok, true, type);
    }
  });
});

describe("en-têtes de service et garde de media:gc", () => {
  test("en-têtes de toute photo servie : nosniff, inline, CSP sandbox, cache privé de 5 minutes", () => {
    assert.equal(PHOTO_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.equal(PHOTO_SECURITY_HEADERS["Content-Disposition"], "inline");
    assert.equal(PHOTO_SECURITY_HEADERS["Content-Security-Policy"], "default-src 'none'; sandbox");
    assert.equal(PHOTO_SECURITY_HEADERS["Cache-Control"], "private, max-age=300");
    assert.equal(PHOTO_SECURITY_HEADERS.Vary, "Cookie", "la réponse dépend de la session : jamais rejouée à un autre compte par un cache");
    assert.equal(PHOTO_CACHE_CONTROL, "private, max-age=300");
    assert.equal(Object.isFrozen(PHOTO_SECURITY_HEADERS), true);
  });

  test("media:gc : permis seulement avec NODE_ENV absent, development ou test ; production exige NOMA_MEDIA_GC_PRODUCTION=1 ; toute autre valeur est refusée", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) assert.equal(purgeEnvironmentRefusal(env, MEDIA_GC_PRODUCTION_VARIABLE), null, JSON.stringify(env));
    const refusal = purgeEnvironmentRefusal({ NODE_ENV: "production" }, MEDIA_GC_PRODUCTION_VARIABLE);
    assert.match(refusal ?? "", /NOMA_MEDIA_GC_PRODUCTION=1/);
    assert.equal(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_MEDIA_GC_PRODUCTION: "1" }, MEDIA_GC_PRODUCTION_VARIABLE), null);
    assert.notEqual(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_MEDIA_GC_PRODUCTION: "true" }, MEDIA_GC_PRODUCTION_VARIABLE), null);
    assert.notEqual(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" }, MEDIA_GC_PRODUCTION_VARIABLE), null, "l'autorisation de metrics:purge ne vaut pas pour media:gc");
    for (const value of ["Production", "PRODUCTION", "prod", "staging", ""]) assert.notEqual(purgeEnvironmentRefusal({ NODE_ENV: value }, MEDIA_GC_PRODUCTION_VARIABLE), null, value);
  });

  test("garde des lignes sans fichier : plus de 5 % OU plus de 20 refusé (dossier mal désigné), sauf --expect-missing EXACT ; un nombre attendu faux est toujours refusé", () => {
    assert.equal(MEDIA_GC_MISSING_MAX_PERCENT, 5);
    assert.equal(MEDIA_GC_MISSING_MAX_COUNT, 20);
    const guard = (rows: number, missing: number, expectMissing?: number) => missingRowsGuard({ rows, missing, expectMissing });
    // Sous les deux seuils : permis.
    assert.equal(guard(0, 0), null);
    assert.equal(guard(100, 0), null);
    assert.equal(guard(100, 5), null, "5 % pile : permis");
    assert.equal(guard(1_000, 20), null, "20 lignes pile (2 %) : permis");
    assert.equal(guard(20, 1), null, "1 sur 20 = 5 % pile : permis");
    // Au-dessus d'un seuil : refusé.
    assert.equal(guard(100, 6), "too_many_missing", "plus de 5 %");
    assert.equal(guard(1_000, 21), "too_many_missing", "plus de 20 lignes, même à 2,1 %");
    assert.equal(guard(10, 1), "too_many_missing", "10 % d'une petite base");
    assert.equal(guard(56, 55), "too_many_missing", "le cas de l'auditeur : 55 lignes sur 56 (NOMA_MEDIA_DIR mal désigné)");
    assert.equal(guard(5, 5), "too_many_missing", "dossier vide");
    // --expect-missing=N : le nombre constaté EXACT lève le refus ; tout autre nombre est refusé, même sous les seuils.
    assert.equal(guard(56, 55, 55), null);
    assert.equal(guard(56, 55, 54), "expect_mismatch");
    assert.equal(guard(56, 55, 56), "expect_mismatch");
    assert.equal(guard(56, 55, 0), "expect_mismatch");
    assert.equal(guard(1_000, 21, 21), null);
    assert.equal(guard(1_000, 3, 3), null, "sous les seuils, un nombre exact est accepté");
    assert.equal(guard(1_000, 3, 4), "expect_mismatch", "sous les seuils, un nombre faux est refusé");
    assert.equal(guard(100, 0, 0), null);
    assert.equal(guard(100, 0, 1), "expect_mismatch");
  });

  test("âge minimal d'un fichier orphelin : 600 s par défaut, entier de secondes sinon, jamais une valeur douteuse", () => {
    assert.equal(MEDIA_GC_DEFAULT_MIN_AGE_SECONDS, 600);
    assert.equal(resolveMinAgeSeconds({}), 600);
    assert.equal(resolveMinAgeSeconds({ [MEDIA_GC_MIN_AGE_VARIABLE]: "0" }), 0);
    assert.equal(resolveMinAgeSeconds({ [MEDIA_GC_MIN_AGE_VARIABLE]: " 45 " }), 45);
    for (const bad of ["-1", "1.5", "abc", "1e3", "99999999"]) assert.throws(() => resolveMinAgeSeconds({ [MEDIA_GC_MIN_AGE_VARIABLE]: bad }), RangeError, bad);
  });
});

