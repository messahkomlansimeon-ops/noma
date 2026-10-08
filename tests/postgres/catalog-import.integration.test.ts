import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { buildOfferInput } from "../../lib/client/catalog-view";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { IMPORT_MAX_ROWS } from "../../lib/server/subscriptions/config";
import { csvFingerprint, importCatalogCsv, normalizeCsvText, parseCatalogCsv, type CatalogImportResult } from "../../lib/server/subscriptions/catalog-import";
import { SubscriptionError } from "../../lib/server/subscriptions/errors";
import { setSubscriptionAutoRenew, subscribeToPlan } from "../../lib/server/subscriptions/lifecycle";
import { assertWalletGreen, countRows, fund, makeOffer, makePro, makeUser, scalar } from "./pro-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool;
let target: DedicatedTestDatabase;
let pool: Pool;
let widePool: Pool;
const RUN_ID = `imp_${process.pid}_${randomBytes(4).toString("hex")}`;
const named = (label: string, max: number) => (config: PoolConfig): Pool => new Pool({ ...config, max, application_name: `${RUN_ID}_${label}` });

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, named("main", 4));
  widePool = await openVerifiedIsolatedPool(target, schema, named("wide", 12));
  await runMigrations(pool);
});

after(async () => {
  for (const each of [pool, widePool]) if (each) await each.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

const HEADER = "titre,description,categorie,marque,modele,variante,etat,localisation,prix,disponible";

async function outcome(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof SubscriptionError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const run = (sellerId: string, csv: string, dryRun: boolean, db: Pool = pool): Promise<CatalogImportResult> => importCatalogCsv({ pool: db, sellerId, csv, dryRun });
const publishedCount = (userId: string): Promise<number> => countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]);

// ═════════════ 1. Lecture du CSV (pur) ═════════════

test("CSV : séparateur de l'en-tête (virgule, point-virgule, tabulation), guillemets, virgule et retour à la ligne entre guillemets, guillemet doublé, BOM, CRLF, lignes vides ignorées, numéros de ligne", () => {
  const comma = parseCatalogCsv(`${HEADER}\nA,"Une, description",Téléphones,Apple,,,,,100,oui\n\nB,,,,,,,,,\n`);
  assert.deepEqual(comma.columns, ["titre", "description", "categorie", "marque", "modele", "variante", "etat", "localisation", "prix", "disponible"]);
  assert.deepEqual(comma.records.map((record) => record.line), [2, 4], "les lignes vides sont ignorées mais comptées dans la numérotation");
  assert.equal(comma.records[0].cells[1], "Une, description");
  const semicolon = parseCatalogCsv("﻿Titre;Prix;Catégorie\r\nA;1 000;Téléphones\r\nB;2000;\r\n");
  assert.deepEqual(semicolon.columns, ["titre", "prix", "categorie"], "en-têtes sans accent ni casse, BOM retiré");
  assert.deepEqual(semicolon.records.map((record) => record.cells), [["A", "1 000", "Téléphones"], ["B", "2000", ""]]);
  const tab = parseCatalogCsv("titre\tprix\nA\t100\n");
  assert.deepEqual(tab.records[0].cells, ["A", "100"]);
  const multi = parseCatalogCsv(`titre,description\n"Ligne 1\nLigne 2","Il a dit ""oui"""\nSuivant,x\n`);
  assert.equal(multi.records[0].cells[0], "Ligne 1\nLigne 2");
  assert.equal(multi.records[0].cells[1], "Il a dit \"oui\"");
  assert.equal(multi.records[1].line, 4, "un enregistrement sur plusieurs lignes décale la numérotation");
  // Dernier enregistrement sans retour à la ligne final ; en-têtes avec espaces ou tirets.
  assert.equal(parseCatalogCsv("titre,Prix\nA,1").records.length, 1);
  assert.deepEqual(parseCatalogCsv("Titre , Modèle \nA,B").columns, ["titre", "modele"]);
});

test("CSV refusé en entier : sans « titre », colonne inconnue ou en double, aucune ligne de données, guillemet non fermé, caractère de contrôle, trop gros, plus de 200 lignes", () => {
  const code = (text: string): string => { try { parseCatalogCsv(text); return "ok"; } catch (error) { return (error as SubscriptionError).code; } };
  assert.equal(code("prix\n100"), "import_invalid_file", "pas de colonne titre");
  assert.equal(code("titre,couleur\nA,rouge"), "import_invalid_file", "colonne inconnue");
  assert.equal(code("titre,titre\nA,B"), "import_invalid_file", "colonne en double");
  assert.equal(code("titre,prix\n"), "import_invalid_file", "aucune ligne de données");
  assert.equal(code(""), "import_invalid_file");
  assert.equal(code("titre\n\"A"), "import_invalid_file", "guillemet non fermé");
  assert.equal(code("titre\nA\u0000B"), "import_invalid_file", "caractère de contrôle");
  assert.equal(code("titre\nA‮B"), "import_invalid_file", "caractère de direction");
  assert.equal(code(`titre\n${"x".repeat(300_000)}`), "import_invalid_file", "plus de 256 Kio");
  const rows = (count: number): string => `titre\n${Array.from({ length: count }, (_, index) => `Annonce ${index}`).join("\n")}`;
  assert.equal(code(rows(200)), "ok", "200 lignes : accepté");
  assert.equal(code(rows(201)), "import_too_many_rows", "201 lignes : refusé en entier");
  assert.equal(IMPORT_MAX_ROWS, 200);
  assert.equal(code(123 as never), "import_invalid_file");
});

test("empreinte du fichier : SHA-256 du texte normalisé (BOM et fins de ligne sans effet), différente dès qu'un caractère change", () => {
  const base = `${HEADER}\nA,B,,,,,,,100,oui\n`;
  assert.match(csvFingerprint(base), /^[0-9a-f]{64}$/);
  assert.equal(csvFingerprint(base), csvFingerprint(`﻿${base.replace(/\n/g, "\r\n")}`));
  assert.equal(normalizeCsvText("﻿a\r\nb\rc"), "a\nb\nc");
  assert.notEqual(csvFingerprint(base), csvFingerprint(base.replace("100", "101")));
});

// ═════════════ 2. Import : droit, aperçu, application, rejeu ═════════════

const FILE = [
  HEADER,
  "iPhone 12 128 Go,Très bon état,Téléphones,Apple,iPhone 12,128 Go,Occasion,Cocody,\"175 000\",oui",   // ligne 2 : valide
  "Galaxy S21,,Téléphones,Samsung,Galaxy S21,,Neuf,Marcory,abc,oui",                                    // ligne 3 : prix illisible
  "Chaise,,maison et MEUBLES,07 08 09 10 11,,,,,5000,oui",                                              // ligne 4 : numéro de téléphone dans la marque
  "Téléviseur,,Inconnue,,,,,,,oui",                                                                      // ligne 5 : catégorie inconnue
  ",sans titre,,,,,,,100,oui",                                                                           // ligne 6 : titre manquant
  "Table,,,,,,,,120k,non",                                                                               // ligne 7 : valide (catégorie vide, état par défaut, indisponible)
  "Lampe,,,,,,Cassé,,100,oui",                                                                          // ligne 8 : état inconnu
  "Vélo,,,,,,,,100,peut-être",                                                                           // ligne 9 : disponibilité inconnue
  "Four,,,,,,,,100,oui,colonne en trop",                                                                 // ligne 10 : plus de cellules que de colonnes
].join("\n");

test("droit absent : un utilisateur Gratuit ne peut ni prévisualiser ni appliquer (`entitlement_required`) ; rien n'est écrit", async () => {
  const free = await makeUser(pool);
  const outboxBefore = await countRows(pool, "matching_outbox_events");
  assert.equal(await outcome(run(free, FILE, true)), "entitlement_required");
  assert.equal(await outcome(run(free, FILE, false)), "entitlement_required");
  assert.equal(await countRows(pool, "offers", "owner_id = $1", [free]), 0);
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1", [free]), 0);
  assert.equal(await countRows(pool, "matching_outbox_events"), outboxBefore);
  // Un abonné à un plan SANS le droit (plan sur mesure) n'a pas non plus accès.
  await pool.query(
    `WITH p AS (INSERT INTO plans (id, code) VALUES (gen_random_uuid(), 'sansimport') RETURNING id)
     INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, 1, 'Sans import', 1000, 0, 50, ARRAY['badge_pro']::text[] FROM p`);
  const badge = await makeUser(pool);
  await fund(pool, badge, 1000);
  await subscribeToPlan({ pool, userId: badge, planCode: "sansimport", idempotencyKey: randomUUID() });
  assert.equal(await outcome(run(badge, FILE, false)), "entitlement_required", "le droit catalog_import manque");
  // Après la fin de la période d'un abonnement annulé, le droit disparaît aussi (même si le worker n'a pas encore tourné).
  const longAgo = new Date(Date.now() - 40 * 24 * 3_600_000);
  const lapsed = await makePro(pool, 10_000, longAgo);
  await setSubscriptionAutoRenew({ pool, userId: lapsed.userId, autoRenew: false, now: longAgo });
  assert.equal(await outcome(run(lapsed.userId, `${HEADER}\nA,,,,,,,,100,oui`, true)), "entitlement_required");
  const active = await makePro(pool, 10_000);
  assert.equal(await outcome(run(active.userId, `${HEADER}\nA,,,,,,,,100,oui`, true)), "ok", "un abonné Pro en vigueur y a droit");
});

test("aperçu à blanc : rapport ligne par ligne, rien d'écrit (ni annonce, ni événement, ni empreinte) ; l'application donne exactement le même rapport ; le rejeu ne recrée rien", async () => {
  const { userId } = await makePro(pool, 10_000);
  const offersBefore = await countRows(pool, "offers");
  const outboxBefore = await countRows(pool, "matching_outbox_events");

  const preview = await run(userId, FILE, true);
  assert.equal(preview.mode, "preview");
  assert.equal(preview.alreadyApplied, false);
  assert.equal(preview.rowCount, 9);
  assert.equal(preview.acceptedCount, 2);
  assert.equal(preview.rejectedCount, 7);
  assert.deepEqual(preview.rows, [
    { line: 2, outcome: "would_create" },
    { line: 3, outcome: "rejected", code: "invalid_field", field: "price" },
    { line: 4, outcome: "rejected", code: "phone_number_in_offer" },
    { line: 5, outcome: "rejected", code: "invalid_field", field: "category" },
    { line: 6, outcome: "rejected", code: "invalid_field", field: "title" },
    { line: 7, outcome: "would_create" },
    { line: 8, outcome: "rejected", code: "invalid_field", field: "condition" },
    { line: 9, outcome: "rejected", code: "invalid_field", field: "available" },
    { line: 10, outcome: "rejected", code: "too_many_columns" },
  ]);
  assert.equal(await countRows(pool, "offers"), offersBefore, "l'aperçu n'a créé aucune annonce");
  assert.equal(await countRows(pool, "matching_outbox_events"), outboxBefore, "ni événement");
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1", [userId]), 0, "ni empreinte");

  // Application : mêmes issues, annonces créées EN LIGNE, empreinte et rapport conservés.
  const applied = await run(userId, FILE, false);
  assert.equal(applied.mode, "apply");
  assert.equal(applied.alreadyApplied, false);
  assert.deepEqual(
    applied.rows.map((row) => ({ line: row.line, outcome: row.outcome === "created" ? "would_create" : row.outcome, ...(row.code ? { code: row.code } : {}), ...(row.field ? { field: row.field } : {}) })),
    preview.rows,
  );
  assert.equal(applied.acceptedCount, 2);
  assert.equal(await publishedCount(userId), 2);
  assert.equal(await countRows(pool, "offers"), offersBefore + 2);
  // Chaque annonce créée émet son événement par le chemin du formulaire, SAUF une annonce indisponible (ligne 7 : « non »), que le matching ignore (aucun événement).
  assert.equal(await countRows(pool, "matching_outbox_events"), outboxBefore + 1, "un événement pour l'annonce disponible, aucun pour l'indisponible");
  const stored = (await pool.query<{ fingerprint: string; row_count: number; created_count: number; rejected_count: number; report: unknown[] }>(
    "SELECT fingerprint, row_count, created_count, rejected_count, report FROM catalog_imports WHERE seller_id = $1", [userId])).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].fingerprint, csvFingerprint(FILE));
  assert.equal(stored[0].row_count, 9);
  assert.equal(stored[0].created_count, 2);
  assert.equal(stored[0].rejected_count, 7);
  // AUCUNE donnée du fichier dans le rapport conservé (ni titre, ni prix, ni marque, ni numéro).
  const storedText = JSON.stringify(stored[0].report);
  for (const secret of ["iPhone", "Galaxy", "175", "07 08 09", "Cocody", "Téléviseur", "sans titre", "Chaise"]) assert.ok(!storedText.includes(secret), `le rapport ne contient pas « ${secret} »`);
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1 AND octet_length(report::text) < 65536", [userId]), 1);

  // Rejeu : même fichier → rapport renvoyé, rien recréé ; l'aperçu du même fichier dit « déjà appliqué ».
  const replay = await run(userId, FILE, false);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.acceptedCount, 2);
  assert.deepEqual(replay.rows, applied.rows, "le rapport est celui de l'application");
  assert.equal(await publishedCount(userId), 2);
  assert.equal((await run(userId, FILE.replace(/\n/g, "\r\n"), false)).alreadyApplied, true, "fins de ligne sans effet sur l'empreinte");
  const previewAfter = await run(userId, FILE, true);
  assert.equal(previewAfter.alreadyApplied, true);
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1", [userId]), 1);
  assert.equal(await publishedCount(userId), 2);
  // Un fichier DIFFÉRENT (même une espace de plus dans un titre) est un autre import.
  const second = await run(userId, `${HEADER}\nAutre annonce,,,,,,,,100,oui`, false);
  assert.equal(second.alreadyApplied, false);
  assert.equal(await publishedCount(userId), 3);
  // Un autre vendeur peut appliquer le MÊME fichier (empreinte par vendeur).
  const other = await makePro(pool, 10_000);
  assert.equal((await run(other.userId, FILE, false)).alreadyApplied, false);
  assert.equal(await publishedCount(other.userId), 2);
  await assertWalletGreen(pool, "après des imports");
});

test("MÊME validation et MÊME création que le formulaire : l'annonce importée est celle que `buildOfferInput` + `createOffer` donneraient", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = `${HEADER}\niPhone 12,Très bon état,téléphones,Apple,iPhone 12,128 Go,reconditionné,Cocody,"150 000",oui\nTable,,,,,,,,,non`;
  await run(userId, csv, false);
  const offers = (await pool.query<{ raw_text: string; category: string | null; brand: string | null; model: string | null; variant: string | null; condition_text: string | null; location_text: string | null; price_amount: string | null; price_currency: string | null; availability_status: string | null; status: string }>(
    "SELECT raw_text, category, brand, model, variant, condition_text, location_text, price_amount::text, price_currency, availability_status, status FROM offers WHERE owner_id = $1 ORDER BY created_at", [userId])).rows;
  const expectedFirst = buildOfferInput({
    title: "iPhone 12", description: "Très bon état", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Reconditionné", location: "Cocody", price: "150 000", available: true,
  });
  assert.ok(expectedFirst.ok);
  assert.equal(offers[0].raw_text, expectedFirst.input.rawText);
  assert.equal(offers[0].category, "Téléphones", "catégorie reconnue sans casse ni accent, libellé du formulaire");
  assert.equal(offers[0].condition_text, "Reconditionné");
  assert.equal(offers[0].price_amount, "150000");
  assert.equal(offers[0].price_currency, "XOF");
  assert.equal(offers[0].availability_status, "available");
  assert.equal(offers[0].status, "published");
  assert.equal(offers[1].raw_text, "Table");
  assert.equal(offers[1].condition_text, "Occasion", "« Occasion » par défaut, comme le formulaire");
  assert.equal(offers[1].price_amount, null);
  assert.equal(offers[1].availability_status, "unavailable");
});

test("numéros de téléphone : refusés dans les champs visibles, sous toutes leurs formes (séparateurs, lettres, chiffres d'un autre alphabet) ; le reste du fichier passe", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = [
    HEADER,
    "A,,,0708091011,,,,,100,oui",
    "B,,,,07-08-09-10-11,,,,100,oui",
    "C,,,,,WhatsApp 0708091011,,,100,oui",
    "D,,,,,,,07.08.09.10.11,100,oui",
    "E,,,٠٧٠٨٠٩١٠١١,,,,,100,oui",
    "F,,,+225 07 08 09 10 11,,,,,100,oui",
    "Bonne annonce,,,Apple,,,,Cocody,100,oui",
  ].join("\n");
  const result = await run(userId, csv, false);
  assert.deepEqual(result.rows.map((row) => row.code ?? row.outcome), ["phone_number_in_offer", "phone_number_in_offer", "phone_number_in_offer", "phone_number_in_offer", "phone_number_in_offer", "phone_number_in_offer", "created"]);
  assert.equal(await publishedCount(userId), 1);
  const preview = await run(await makePro(pool, 10_000).then((pro) => pro.userId), csv, true);
  assert.equal(preview.rejectedCount, 6, "l'aperçu refuse exactement les mêmes lignes");
});

test("règle des numéros de D3 (partagée avec le formulaire) : « 07 O8 09 10 11 » (lettre O à la place du zéro) est REFUSÉ à l'import, dans l'aperçu comme à l'application", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = [HEADER, "Sosie,,,07 O8 09 10 11,,,,,100,oui", "Autre sosie,,,,07 O8-09 1O 11,,,,100,oui", "Bonne annonce,,,Apple,,,,Cocody,100,oui"].join("\n");
  const preview = await run(userId, csv, true);
  assert.deepEqual(preview.rows.map((row) => row.code ?? row.outcome), ["phone_number_in_offer", "phone_number_in_offer", "would_create"]);
  const applied = await run(userId, csv, false);
  assert.deepEqual(applied.rows.map((row) => row.code ?? row.outcome), ["phone_number_in_offer", "phone_number_in_offer", "created"]);
  assert.equal(await publishedCount(userId), 1, "seule la bonne annonce est en ligne");
});

test("règle des numéros de D3 (partagée avec le formulaire) : « Écran 2400×1080 » (dimensions) et un prix à milliers sont ACCEPTÉS à l'import", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = [HEADER, "Écran 2400×1080,,,Samsung,Écran 2400×1080,,,Cocody,\"175 000\",oui", "Tablette 1920x1200,,,Lenovo,Tab 1920×1200,,,,100,oui"].join("\n");
  const preview = await run(userId, csv, true);
  assert.deepEqual(preview.rows.map((row) => row.code ?? row.outcome), ["would_create", "would_create"]);
  const applied = await run(userId, csv, false);
  assert.deepEqual(applied.rows.map((row) => row.code ?? row.outcome), ["created", "created"]);
  assert.equal(await publishedCount(userId), 2);
});

test("201 lignes : le fichier est refusé EN ENTIER (aucune annonce, aucune empreinte) ; 200 lignes passent, dans la limite d'annonces en ligne du plan (Pro : 100)", async () => {
  const { userId } = await makePro(pool, 10_000);
  const rows = (count: number, prefix: string): string => `titre,prix\n${Array.from({ length: count }, (_, index) => `${prefix} ${index},100`).join("\n")}`;
  assert.equal(await outcome(run(userId, rows(201, "Trop"), false)), "import_too_many_rows");
  assert.equal(await outcome(run(userId, rows(201, "Trop"), true)), "import_too_many_rows");
  assert.equal(await countRows(pool, "offers", "owner_id = $1", [userId]), 0);
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1", [userId]), 0);
  // 200 lignes : les 100 premières entrent dans la limite du plan Pro, les 100 suivantes sont refusées (`offer_limit_reached`) — l'aperçu le dit AVANT l'application.
  const preview = await run(userId, rows(200, "Bon"), true);
  assert.equal(preview.rowCount, 200);
  assert.equal(preview.acceptedCount, 100);
  assert.equal(preview.rejectedCount, 100);
  const applied = await run(userId, rows(200, "Bon"), false);
  assert.equal(applied.acceptedCount, 100);
  assert.equal(applied.rows.slice(0, 100).every((row) => row.outcome === "created"), true);
  assert.equal(applied.rows.slice(100).every((row) => row.outcome === "rejected" && row.code === "offer_limit_reached"), true);
  assert.equal(await publishedCount(userId), 100, "jamais plus de 100 annonces en ligne");
});

test("limite d'annonces en ligne pendant l'import : un plan à 3 annonces crée 3 lignes sur 5 et refuse les 2 autres ; les annonces déjà en ligne comptent", async () => {
  await pool.query(
    `WITH p AS (INSERT INTO plans (id, code) VALUES (gen_random_uuid(), 'troisimport') RETURNING id)
     INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, 1, 'Trois', 1000, 0, 3, ARRAY['catalog_import']::text[] FROM p`);
  const userId = await makeUser(pool);
  await fund(pool, userId, 1000);
  await subscribeToPlan({ pool, userId, planCode: "troisimport", idempotencyKey: randomUUID() });
  await makeOffer(pool, userId);                     // une annonce déjà en ligne : il reste 2 places
  const csv = "titre\nA\nB\nC\nD";
  const preview = await run(userId, csv, true);
  assert.deepEqual(preview.rows.map((row) => row.code ?? row.outcome), ["would_create", "would_create", "offer_limit_reached", "offer_limit_reached"]);
  const applied = await run(userId, csv, false);
  assert.deepEqual(applied.rows.map((row) => row.code ?? row.outcome), ["created", "created", "offer_limit_reached", "offer_limit_reached"]);
  assert.equal(await publishedCount(userId), 3);
});

test("rejeux simultanés : six applications du MÊME fichier en même temps → les annonces ne sont créées qu'une fois, une seule empreinte", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = `${HEADER}\nA,,,,,,,,100,oui\nB,,,,,,,,200,oui\nC,,,,,,,,300,oui`;
  const results = await Promise.all(Array.from({ length: 6 }, () => run(userId, csv, false, widePool)));
  assert.equal(results.filter((result) => !result.alreadyApplied).length, 1, "une seule application réelle");
  assert.equal(results.filter((result) => result.alreadyApplied).length, 5);
  assert.equal(await publishedCount(userId), 3);
  assert.equal(await countRows(pool, "catalog_imports", "seller_id = $1", [userId]), 1);
  assert.equal(await scalar(pool, "SELECT count(DISTINCT raw_text)::int AS n FROM offers WHERE owner_id = $1", [userId]), 3);
});

test("une panne en cours d'application n'enregistre rien : le même fichier peut être réappliqué (l'empreinte n'existe qu'avec l'application complète)", async () => {
  const { userId } = await makePro(pool, 10_000);
  const csv = `${HEADER}\nA,,,,,,,,100,oui\nB,,,,,,,,200,oui`;
  const original = pool.connect.bind(pool);
  // Simule une panne : l'empreinte ne peut pas s'écrire (nom de table détourné) → toute la transaction est annulée.
  await pool.query("ALTER TABLE catalog_imports RENAME TO catalog_imports_off");
  try {
    assert.notEqual(await outcome(run(userId, csv, false)), "ok");
  } finally {
    await pool.query("ALTER TABLE catalog_imports_off RENAME TO catalog_imports");
  }
  assert.equal(await countRows(pool, "offers", "owner_id = $1", [userId]), 0, "aucune annonce : la transaction entière est annulée");
  assert.equal((await run(userId, csv, false)).acceptedCount, 2, "le fichier s'applique ensuite normalement");
  void original;
});
