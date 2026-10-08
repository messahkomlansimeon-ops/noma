import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { collectMediaGarbage } from "../../lib/server/media/gc";
import { sanitizeImage } from "../../lib/server/media/image";
import { uploadPhoto } from "../../lib/server/media/photos";
import { DiskMediaStore } from "../../lib/server/media/store";
import { buildPng } from "../../scripts/photo-fixtures";
import { makeOffer, makePerson } from "./metrics-fixtures";
import { runScript } from "./run-script";
import { count, openTestSchema, resetSocial, type TestSchema } from "./social-fixtures";

/**
 * `npm run media:gc` (lot PH1) : supprime les fichiers sans ligne en base et les lignes sans fichier. Simulation par défaut ; l'âge minimal protège un envoi en cours ; seuls les noms que le
 * code crée sont touchés ; un dossier absent ou vide n'efface pas les lignes ; le journal des orphelins est résolu ; refusé en production sans variable explicite.
 */

let env: TestSchema;
let dir: string;
let store: DiskMediaStore;
/** Dossiers jetables créés par les essais, retirés à la fin. */
const created: string[] = [];

before(async () => {
  env = await openTestSchema();
});

after(async () => {
  await env.close();
  for (const directory of created) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetSocial(env.pool);
  await env.pool.query("TRUNCATE offer_photo_uploads, media_orphans");
  dir = await mkdtemp(join(tmpdir(), "noma-media-gc-"));
  created.push(dir);
  store = new DiskMediaStore(dir);
});

let colorSequence = 0;
async function seedPhoto(offerId: string, ownerId: string): Promise<string> {
  colorSequence += 1;
  const sanitized = sanitizeImage(buildPng({ width: 200, height: 200, color: [colorSequence & 255, (colorSequence >> 8) & 255, 9] }));
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) throw new Error("refusé");
  return (await uploadPhoto({ pool: env.pool, store, ownerId, offerId, image: sanitized.image })).photo.id;
}

const ago = async (name: string, seconds: number): Promise<void> => {
  const when = new Date(Date.now() - seconds * 1_000);
  await utimes(join(dir, name), when, when);
};

async function orphanFile(ageSeconds: number, kind: "photo" | "temporary" = "photo"): Promise<string> {
  const name = kind === "photo" ? randomUUID() : `.${randomUUID()}.0123456789abcdef.tmp`;
  await writeFile(join(dir, name), Uint8Array.of(1, 2, 3));
  await ago(name, ageSeconds);
  return name;
}

const names = async (): Promise<string[]> => (await readdir(dir)).sort();
const positions = async (offerId: string): Promise<number[]> => (await env.pool.query<{ position: number }>("SELECT position FROM offer_photos WHERE offer_id = $1 ORDER BY position", [offerId])).rows.map((row) => row.position);

async function world() {
  const seller = await makePerson(env.pool);
  const offer = await makeOffer(env.pool, seller.id);
  const ids = [await seedPhoto(offer.id, seller.id), await seedPhoto(offer.id, seller.id), await seedPhoto(offer.id, seller.id)];
  return { seller, offer, ids };
}

describe("collectMediaGarbage", () => {
  test("simulation : compte les fichiers orphelins, temporaires et les lignes sans fichier, et ne supprime RIEN ; application : supprime ce qui est vieux et rien d'autre ; une deuxième application ne trouve plus rien", async () => {
    const { offer, ids } = await world();
    const oldOrphan = await orphanFile(7_200);
    const recentOrphan = await orphanFile(5);
    const oldTemporary = await orphanFile(7_200, "temporary");
    const recentTemporary = await orphanFile(5, "temporary");
    await writeFile(join(dir, "notes.txt"), "personnelles");
    await mkdir(join(dir, "sous-dossier"));
    await rm(join(dir, ids[1])); // fichier perdu : la ligne reste
    for (const id of ids) await ago(id, 90_000).catch(() => {}); // les photos vivantes sont VIEILLES : elles ne sont jamais des orphelines
    const before = await names();

    const simulated = await collectMediaGarbage({ pool: env.pool, store, apply: false });
    assert.deepEqual(simulated, {
      apply: false,
      files: { scanned: 6, orphans: 1, temporaries: 1, foreign: 2, deleted: 0 },
      rows: { scanned: 3, withoutFile: 1, deleted: 0 },
      journal: { open: 0, resolved: 0 },
      storeExists: true,
      refusal: "too_many_missing",
    });
    assert.deepEqual(await names(), before, "la simulation ne supprime rien (et annonce que --apply serait refusé : 1 ligne sur 3 sans fichier)");
    assert.equal(await count(env.pool, "offer_photos"), 3);

    // 1 ligne sur 3 sans fichier (33 %) : l'application est refusée tant que le gestionnaire n'a pas dit combien (voir les essais de la garde plus bas).
    const applied = await collectMediaGarbage({ pool: env.pool, store, apply: true, expectMissing: 1 });
    assert.equal(applied.refusal, null);
    assert.deepEqual(applied.files, { scanned: 6, orphans: 1, temporaries: 1, foreign: 2, deleted: 2 });
    assert.deepEqual(applied.rows, { scanned: 3, withoutFile: 1, deleted: 1 });
    const left = await names();
    assert.ok(!left.includes(oldOrphan) && !left.includes(oldTemporary), "orphelin et temporaire anciens supprimés");
    assert.ok(left.includes(recentOrphan) && left.includes(recentTemporary), "un fichier récent est protégé (un envoi peut être en cours)");
    assert.ok(left.includes("notes.txt") && left.includes("sous-dossier"), "un fichier aux noms étrangers n'est jamais touché");
    assert.ok(left.includes(ids[0]) && left.includes(ids[2]), "les photos vivantes restent, même vieilles");
    assert.deepEqual((await env.pool.query<{ id: string }>("SELECT id FROM offer_photos WHERE offer_id = $1 ORDER BY position", [offer.id])).rows.map((row) => row.id), [ids[0], ids[2]], "la ligne sans fichier est supprimée");
    assert.deepEqual(await positions(offer.id), [0, 1], "les positions sont recompactées");

    const again = await collectMediaGarbage({ pool: env.pool, store, apply: true });
    assert.equal(again.refusal, null, "plus aucune ligne sans fichier : l'application est permise sans rien attendre");
    assert.deepEqual([again.files.deleted, again.rows.deleted, again.files.orphans, again.rows.withoutFile], [0, 0, 0, 0]);
  });

  test("âge minimal : 0 seconde supprime aussi les fichiers récents ; un fichier plus vieux que le seuil, jamais un plus jeune", async () => {
    await world();
    const young = await orphanFile(30);
    const older = await orphanFile(3_000);
    const result = await collectMediaGarbage({ pool: env.pool, store, apply: true, minAgeSeconds: 600 });
    assert.equal(result.files.deleted, 1);
    assert.ok((await names()).includes(young) && !(await names()).includes(older));
    const forced = await collectMediaGarbage({ pool: env.pool, store, apply: true, minAgeSeconds: 0 });
    assert.equal(forced.files.deleted, 1);
    assert.ok(!(await names()).includes(young));
  });

  test("journal des orphelins : une entrée est résolue quand son fichier a disparu ou quand sa photo a une ligne ; jamais supprimée à tort (le fichier d'une photo vivante reste)", async () => {
    const { ids } = await world();
    const stillThere = await orphanFile(7_200);
    const gone = randomUUID();
    const insert = (key: string) => env.pool.query("INSERT INTO media_orphans (storage_key, reason) VALUES ($1, 'delete_failed')", [key]);
    await insert(stillThere);
    await insert(gone);
    await insert(ids[0]); // une photo VIVANTE : sa ligne existe, le fichier ne doit pas être supprimé
    const result = await collectMediaGarbage({ pool: env.pool, store, apply: true });
    assert.deepEqual(result.journal, { open: 3, resolved: 3 });
    assert.equal(await count(env.pool, "media_orphans", "resolved_at IS NULL"), 0);
    assert.ok(!(await names()).includes(stillThere), "le fichier orphelin journalisé est supprimé");
    assert.ok((await names()).includes(ids[0]), "le fichier de la photo vivante reste");
  });

  test("GARDE : plus de 5 % des lignes sans fichier (dossier mal désigné) -> application REFUSÉE EN ENTIER : ni ligne ni fichier supprimé, même les vrais orphelins ; --expect-missing exact la permet, un autre nombre est refusé", async () => {
    const { offer, ids } = await world();
    await rm(join(dir, ids[1]));
    const orphan = await orphanFile(7_200);
    const before = await names();
    const refused = await collectMediaGarbage({ pool: env.pool, store, apply: true });
    assert.equal(refused.refusal, "too_many_missing");
    assert.deepEqual([refused.rows.withoutFile, refused.rows.deleted, refused.files.deleted], [1, 0, 0]);
    assert.deepEqual(await names(), before, "le vieux fichier orphelin n'a pas été supprimé non plus : un dossier mal désigné peut contenir les fichiers d'une autre installation");
    assert.ok((await names()).includes(orphan));
    assert.equal(await count(env.pool, "offer_photos"), 3);
    for (const wrong of [0, 2, 3]) {
      const mismatch = await collectMediaGarbage({ pool: env.pool, store, apply: true, expectMissing: wrong });
      assert.equal(mismatch.refusal, "expect_mismatch", `attendu ${wrong}, constaté 1`);
      assert.equal(await count(env.pool, "offer_photos"), 3);
      assert.deepEqual(await names(), before);
    }
    const accepted = await collectMediaGarbage({ pool: env.pool, store, apply: true, expectMissing: 1 });
    assert.equal(accepted.refusal, null);
    assert.deepEqual([accepted.rows.deleted, accepted.files.deleted], [1, 1]);
    assert.deepEqual(await positions(offer.id), [0, 1]);
  });

  test("le cas de l'auditeur : 56 lignes dont 55 sans fichier (NOMA_MEDIA_DIR mal désigné) : --apply est refusé, rien n'est supprimé ; --expect-missing=55 est le seul moyen", async () => {
    const seller = await makePerson(env.pool);
    const kept = await makeOffer(env.pool, seller.id);
    const keptPhoto = await seedPhoto(kept.id, seller.id);
    // 55 lignes sans fichier, insérées directement (dix annonces, six photos au plus chacune).
    let inserted = 0;
    for (let index = 0; index < 10 && inserted < 55; index += 1) {
      const offer = await makeOffer(env.pool, seller.id);
      const count_ = Math.min(6, 55 - inserted);
      await env.pool.query(
        `INSERT INTO offer_photos (id, offer_id, position, mime, bytes, width, height, sha256)
         SELECT gen_random_uuid(), $1::uuid, n, 'image/png', 1000, 300, 300, md5(random()::text || n::text) || md5(n::text || random()::text) FROM generate_series(0, $2::int - 1) AS n`,
        [offer.id, count_],
      );
      inserted += count_;
    }
    assert.equal(await count(env.pool, "offer_photos"), 56);
    const simulated = await collectMediaGarbage({ pool: env.pool, store, apply: false });
    assert.deepEqual([simulated.rows.scanned, simulated.rows.withoutFile, simulated.refusal], [56, 55, "too_many_missing"]);
    const refused = await collectMediaGarbage({ pool: env.pool, store, apply: true });
    assert.deepEqual([refused.refusal, refused.rows.deleted], ["too_many_missing", 0]);
    assert.equal(await count(env.pool, "offer_photos"), 56, "aucune ligne supprimée");
    assert.deepEqual(await names(), [keptPhoto]);
    assert.equal((await collectMediaGarbage({ pool: env.pool, store, apply: true, expectMissing: 54 })).refusal, "expect_mismatch");
    assert.equal(await count(env.pool, "offer_photos"), 56);
    const forced = await collectMediaGarbage({ pool: env.pool, store, apply: true, expectMissing: 55 });
    assert.deepEqual([forced.refusal, forced.rows.deleted], [null, 55]);
    assert.equal(await count(env.pool, "offer_photos"), 1, "seule la photo qui a son fichier reste");
  });

  test("plus de 20 lignes sans fichier : refusé même sous 5 % (ici 21 sur 500) ; 20 sur 500 : permis ; un dossier absent ou vide est le cas extrême (toutes les lignes manquent)", async () => {
    const seller = await makePerson(env.pool);
    const offers = [];
    for (let index = 0; index < 84; index += 1) offers.push((await makeOffer(env.pool, seller.id)).id);
    // 500 lignes sur 84 annonces (6 au plus chacune) : 83 × 6 = 498 + 2.
    await env.pool.query(
      `INSERT INTO offer_photos (id, offer_id, position, mime, bytes, width, height, sha256)
       SELECT gen_random_uuid(), o.id, n, 'image/png', 1000, 300, 300, md5(o.id::text || n::text) || md5(n::text || o.id::text)
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord) CROSS JOIN generate_series(0, 5) AS n
        WHERE (o.ord - 1) * 6 + n < 500`,
      [offers],
    );
    assert.equal(await count(env.pool, "offer_photos"), 500);
    // Les 479 premières lignes ont un fichier ; 21 n'en ont pas.
    const all = (await env.pool.query<{ id: string }>("SELECT id FROM offer_photos ORDER BY id")).rows.map((row) => row.id);
    for (const id of all.slice(21)) await writeFile(join(dir, id), Uint8Array.of(1));
    const tooMany = await collectMediaGarbage({ pool: env.pool, store, apply: false });
    assert.deepEqual([tooMany.rows.withoutFile, tooMany.refusal], [21, "too_many_missing"], "21 lignes (4,2 %) : plus de 20");
    await writeFile(join(dir, all[20]), Uint8Array.of(1));
    const exactly = await collectMediaGarbage({ pool: env.pool, store, apply: true });
    assert.deepEqual([exactly.rows.withoutFile, exactly.refusal, exactly.rows.deleted], [20, null, 20], "20 lignes (4 %) : permis");
    // Dossier absent ou vide : toutes les lignes manquent.
    const emptyDir = await mkdtemp(join(tmpdir(), "noma-media-empty-"));
    created.push(emptyDir);
    const empty = await collectMediaGarbage({ pool: env.pool, store: new DiskMediaStore(emptyDir), apply: true });
    assert.equal(empty.refusal, "too_many_missing");
    assert.equal(empty.storeExists, true);
    const missing = await collectMediaGarbage({ pool: env.pool, store: new DiskMediaStore(join(emptyDir, "absent")), apply: true });
    assert.deepEqual([missing.refusal, missing.storeExists], ["too_many_missing", false]);
    assert.equal(await count(env.pool, "offer_photos"), 480, "aucune ligne supprimée par les deux refus");
    // Une base sans aucune photo et un dossier vide : rien à garder, aucun refus.
    await env.pool.query("TRUNCATE offer_photos");
    assert.equal((await collectMediaGarbage({ pool: env.pool, store: new DiskMediaStore(emptyDir), apply: true })).refusal, null);
  });
});

describe("npm run media:gc (script)", () => {
  const run = (args: string[], extra: Record<string, string> = {}) =>
    runScript("scripts/media-gc.ts", args, env.schema, { NOMA_MEDIA_DIR: dir, NOMA_MEDIA_GC_MIN_AGE_SECONDS: "0", ...extra });

  test("sans argument : SIMULATION (rien n'est supprimé) ; --apply supprime ; la sortie ne contient jamais le dossier ni un message brut", async () => {
    await world();
    const orphan = await orphanFile(7_200);
    const simulated = await run([]);
    assert.equal(simulated.code, 0, simulated.output);
    assert.match(simulated.output, /Photos : simulation, .*1 orphelin\(s\)/);
    assert.match(simulated.output, /Rien n'a été supprimé : relancez avec --apply pour supprimer/);
    assert.ok((await names()).includes(orphan), "simulation : le fichier est toujours là");
    const applied = await run(["--apply"]);
    assert.equal(applied.code, 0, applied.output);
    assert.match(applied.output, /1 fichier\(s\) et 0 ligne\(s\) supprimé\(s\)/);
    assert.ok(!(await names()).includes(orphan));
    assert.ok(!applied.output.includes(dir), "le chemin du dossier n'est pas affiché");
  });

  test("arguments : toute option inconnue, répétée ou isolée est refusée (code 1, usage affiché, rien supprimé)", async () => {
    await world();
    const orphan = await orphanFile(7_200);
    for (const args of [["--force"], ["--apply", "--apply"], ["apply"], ["--accept-empty-store"], ["--apply", "--accept-empty-store"], ["--expect-missing=3"], ["--apply", "--expect-missing"], ["--apply", "--expect-missing=abc"], ["--apply", "--expect-missing=-1"], ["--apply", "--expect-missing=1", "--expect-missing=1"], ["--apply", "--expect-missing=1", "--force"], ["--dry-run"]]) {
      const result = await run(args);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.output, /Usage : npm run media:gc/);
    }
    assert.ok((await names()).includes(orphan), "aucun refus n'a supprimé quoi que ce soit");
  });

  test("production : refusée, simulation comprise, sans NOMA_MEDIA_GC_PRODUCTION=1 (la variable de metrics:purge ne suffit pas) ; autorisée avec elle ; NODE_ENV inconnu refusé ; rien n'est lu ni supprimé en cas de refus", async () => {
    await world();
    const orphan = await orphanFile(7_200);
    for (const [label, extra] of [
      ["production", { NODE_ENV: "production" }],
      ["production avec la variable de metrics:purge", { NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" }],
      ["production, variable « true »", { NODE_ENV: "production", NOMA_MEDIA_GC_PRODUCTION: "true" }],
      ["Production", { NODE_ENV: "Production", NOMA_MEDIA_GC_PRODUCTION: "1" }],
      ["staging", { NODE_ENV: "staging" }],
    ] as const) {
      for (const args of [[], ["--apply"]]) {
        const result = await run([...args], extra);
        assert.equal(result.code, 1, `${label} ${args.join(" ")}`);
        assert.match(result.output, /refus/);
      }
    }
    assert.ok((await names()).includes(orphan));
    const allowed = await run(["--apply"], { NODE_ENV: "production", NOMA_MEDIA_GC_PRODUCTION: "1" });
    assert.equal(allowed.code, 0, allowed.output);
    assert.ok(!(await names()).includes(orphan));
    // Production autorisée mais NOMA_MEDIA_DIR absent : aucun dossier par défaut n'est supposé.
    const noDir = await runScript("scripts/media-gc.ts", [], env.schema, { NODE_ENV: "production", NOMA_MEDIA_GC_PRODUCTION: "1", NOMA_MEDIA_DIR: "" });
    assert.equal(noDir.code, 1);
    assert.match(noDir.output, /dossier de stockage inutilisable/);
  });

  test("âge minimal : une valeur douteuse est refusée ; par défaut (600 s) un fichier récent est protégé", async () => {
    await world();
    const recent = await orphanFile(10);
    const bad = await run([], { NOMA_MEDIA_GC_MIN_AGE_SECONDS: "dix" });
    assert.equal(bad.code, 1);
    assert.match(bad.output, /NOMA_MEDIA_GC_MIN_AGE_SECONDS/);
    const protectedRun = await run(["--apply"], { NOMA_MEDIA_GC_MIN_AGE_SECONDS: "" });
    assert.equal(protectedRun.code, 0, protectedRun.output);
    assert.ok((await names()).includes(recent), "protégé par l'âge minimal par défaut");
  });

  test("dossier mal désigné (vide) alors que la base référence des photos : la simulation annonce le refus, --apply sort en erreur et n'efface RIEN (le message explique le risque) ; --expect-missing=<N exact> est le seul moyen", async () => {
    await world();
    const emptyDir = await mkdtemp(join(tmpdir(), "noma-media-empty-"));
    created.push(emptyDir);
    const env_ = { NOMA_MEDIA_DIR: emptyDir, NOMA_MEDIA_GC_MIN_AGE_SECONDS: "0" };
    const simulated = await runScript("scripts/media-gc.ts", [], env.schema, env_);
    assert.equal(simulated.code, 0, simulated.output);
    assert.match(simulated.output, /3 ligne\(s\) sur 3 n'ont pas de fichier/);
    assert.match(simulated.output, /Simulation : --apply serait refusé/);
    const refused = await runScript("scripts/media-gc.ts", ["--apply"], env.schema, env_);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /refus de supprimer : 3 ligne\(s\) sur 3 n'ont pas de fichier/);
    assert.match(refused.output, /NOMA_MEDIA_DIR mal désigné/);
    assert.match(refused.output, /effacerait des photos de vendeurs qui existent encore ailleurs/);
    assert.match(refused.output, /--apply --expect-missing=3/);
    assert.match(refused.output, /Rien n'a été supprimé/);
    assert.ok(!refused.output.includes(emptyDir), "le chemin du dossier n'est pas affiché");
    assert.equal(await count(env.pool, "offer_photos"), 3);
    const wrong = await runScript("scripts/media-gc.ts", ["--apply", "--expect-missing=2"], env.schema, env_);
    assert.equal(wrong.code, 1, wrong.output);
    assert.match(wrong.output, /--expect-missing=2 ne correspond pas au nombre constaté \(3 ligne\(s\) sans fichier sur 3\)/);
    assert.equal(await count(env.pool, "offer_photos"), 3);
    const accepted = await runScript("scripts/media-gc.ts", ["--apply", "--expect-missing=3"], env.schema, env_);
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /0 fichier\(s\) et 3 ligne\(s\) supprimé\(s\)/);
    assert.equal(await count(env.pool, "offer_photos"), 0);
  });
});
