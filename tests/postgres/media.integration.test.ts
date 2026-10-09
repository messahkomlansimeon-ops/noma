import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { grantAdmin } from "../../lib/server/admin/grant";
import { readVendorHome } from "../../lib/server/home/reads";
import { createMatchingHttpHandlers, type MatchingHttpHandlers } from "../../lib/server/matching/http";
import { PHOTO_ERROR_MESSAGES } from "../../lib/client/photos-api";
import { PHOTO_MAX_BYTES, PHOTO_MAX_PER_OFFER, PHOTO_UPLOADS_PER_HOUR } from "../../lib/server/media/config";
import { createMediaHttpHandlers, type MediaHttpHandlers } from "../../lib/server/media/http";
import { DiskMediaStore, MEDIA_KEY, type MediaStore } from "../../lib/server/media/store";
import type { PhotoHooks } from "../../lib/server/media/photos";
import { createMetricsHttpHandlers, type MetricsHttpHandlers } from "../../lib/server/metrics/http";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import * as photosRoute from "../../app/api/offers/[id]/photos/route";
import * as photoRoute from "../../app/api/offers/[id]/photos/[photoId]/route";
import * as mediaRoute from "../../app/api/media/[photoId]/route";
import {
  EXIF_MAKE, GPS_LATITUDE_BYTES, GPS_LONGITUDE_BYTES, KITCHEN_FORBIDDEN, XMP_GPS_TEXT, buildExifTiff, buildGrayJpeg, buildKitchenJpeg, buildKitchenPng, buildKitchenWebp, buildPng, buildWebpLossless, concatBytes, containsBytes, jpegExifSegment, jpegXmpSegment,
} from "../../scripts/photo-fixtures";
import { makeDemand, makeMatch, makeOffer } from "./metrics-fixtures";
import { NOT_FOUND, ORIGIN, count, login, makeMarket, openTestSchema, reply, request, resetSocial, sleep, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Photos d'annonces (lot PH1), de bout en bout sur une base jetable et un dossier jetable : envoi réservé au propriétaire (origine vérifiée avant la session), type par les octets seuls, limites
 * (5 Mo, 6 photos, 30 envois par heure), rejeu idempotent, deux envois sur la 6ᵉ place, ordre et suppression (le fichier part APRÈS la validation), lecture réservée à qui peut voir l'annonce avec un
 * 404 indiscernable pour tous les autres, en-têtes du fichier servi, vignettes et galerie dans les réponses des écrans, règles imposées en base.
 */

let env: TestSchema;
let dir: string;
let store: DiskMediaStore;
let handlers: MediaHttpHandlers;
let matching: MatchingHttpHandlers;
let metrics: MetricsHttpHandlers;
let social: SocialHttpHandlers;
let market: Market;
let boss: Login;
const hooks: PhotoHooks = { log: () => {} };

before(async () => {
  env = await openTestSchema();
  dir = await mkdtemp(join(tmpdir(), "noma-media-it-"));
  store = new DiskMediaStore(dir);
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: () => {} };
  handlers = createMediaHttpHandlers({ ...common, store, hooks });
  matching = createMatchingHttpHandlers({ pool: env.pool });
  metrics = createMetricsHttpHandlers({ ...common, schedule: () => {} });
  social = createSocialHttpHandlers(common);
  boss = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetSocial(env.pool);
  await env.pool.query("TRUNCATE offer_photo_uploads, media_orphans");
  await env.pool.query("UPDATE users SET status = 'active' WHERE status <> 'active'");
  hooks.beforeCommit = undefined;
  for (const name of await readdir(dir)) await rm(join(dir, name), { force: true, recursive: true });
  market = await makeMarket(env.pool);
});

// ───────────── aides ─────────────

interface Call { cookie?: string | null; origin?: string | null; body?: BodyInit; headers?: Record<string, string>; query?: string }

function binaryRequest(method: "GET" | "POST" | "PUT" | "DELETE", path: string, call: Call = {}): Request {
  const headers: Record<string, string> = { ...(call.headers ?? {}) };
  if (call.cookie) headers.cookie = call.cookie;
  const origin = call.origin === undefined ? ORIGIN : call.origin;
  if (method !== "GET" && origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}${call.query ?? ""}`, { method, headers, ...(call.body !== undefined ? { body: call.body, duplex: "half" } : {}) } as RequestInit);
}

const upload = (offerId: string, bytes: Uint8Array<ArrayBuffer> | null, call: Call = {}): Promise<Response> =>
  handlers.photos.upload(binaryRequest("POST", `/api/offers/${offerId}/photos`, { cookie: market.seller.cookie, ...call, ...(bytes === null ? {} : { body: bytes }) }), offerId);
const list = (offerId: string, cookie: string | null = market.seller.cookie) => handlers.photos.list(binaryRequest("GET", `/api/offers/${offerId}/photos`, { cookie }), offerId);
const reorder = (offerId: string, order: unknown, call: Call = {}) =>
  handlers.photos.reorder(binaryRequest("PUT", `/api/offers/${offerId}/photos`, { cookie: market.seller.cookie, ...call, headers: { "content-type": "application/json" }, body: JSON.stringify({ order }) }), offerId);
const remove = (offerId: string, photoId: string, call: Call = {}) =>
  handlers.photos.remove(binaryRequest("DELETE", `/api/offers/${offerId}/photos/${photoId}`, { cookie: market.seller.cookie, ...call }), offerId, photoId);
const fetchMedia = (photoId: string, cookie: string | null, query = "") => handlers.media.get(binaryRequest("GET", `/api/media/${photoId}`, { cookie, query }), photoId);

type Json = Record<string, unknown>;
interface PhotoJson { id: string; position: number; mime: string; width: number; height: number; bytes: number }
const photosOf = (r: { json: unknown }): PhotoJson[] => (r.json as { photos: PhotoJson[] }).photos;

/** Image PNG toute petite et DISTINCTE (la couleur change l'empreinte). */
let colorSequence = 0;
function distinctPng(width = 200, height = 200): Uint8Array<ArrayBuffer> {
  colorSequence += 1;
  return buildPng({ width, height, color: [colorSequence & 255, (colorSequence >> 8) & 255, (colorSequence >> 16) & 255] });
}

const files = async (): Promise<string[]> => (await readdir(dir)).sort();
const rowsOf = async (offerId: string) => (await env.pool.query<{ id: string; position: number; sha256: string; bytes: number }>("SELECT id, position, sha256, bytes FROM offer_photos WHERE offer_id = $1 ORDER BY position", [offerId])).rows;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function addPhoto(offerId: string, bytes = distinctPng(), cookie = market.seller.cookie): Promise<string> {
  const response = await reply(await upload(offerId, bytes, { cookie }));
  assert.ok(response.status === 201 || response.status === 200, `envoi : ${response.status} ${response.text}`);
  return (response.json as { photo: PhotoJson }).photo.id;
}

// ═════════════ 1. Routes ═════════════

test("routes : envoi, liste et tri sur /photos, suppression sur /photos/{id}, lecture sur /api/media/{id} ; dynamiques, nodejs, aucune autre méthode", () => {
  for (const route of [photosRoute, photoRoute, mediaRoute]) {
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
  }
  assert.deepEqual(["GET", "POST", "PUT"].filter((method) => typeof (photosRoute as Json)[method] === "function"), ["GET", "POST", "PUT"]);
  for (const forbidden of ["PATCH", "DELETE"]) assert.equal((photosRoute as Json)[forbidden], undefined, `photos : ${forbidden}`);
  assert.equal(typeof photoRoute.DELETE, "function");
  for (const forbidden of ["GET", "POST", "PUT", "PATCH"]) assert.equal((photoRoute as Json)[forbidden], undefined, `photo : ${forbidden}`);
  assert.equal(typeof mediaRoute.GET, "function");
  for (const forbidden of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((mediaRoute as Json)[forbidden], undefined, `media : ${forbidden}`);
});

// ═════════════ 2. Envoi : propriétaire, origine, session ═════════════

test("envoi : JPEG, PNG et WebP acceptés (201), fichier nommé d'un UUID dans le dossier, ligne cohérente avec le fichier", async () => {
  const inputs: Array<[string, Uint8Array<ArrayBuffer>, string]> = [
    ["jpeg", buildGrayJpeg({ width: 320, height: 240 }), "image/jpeg"],
    ["png", buildPng({ width: 300, height: 220, pattern: "stripes" }), "image/png"],
    ["webp", buildWebpLossless({ width: 400, height: 300 }), "image/webp"],
  ];
  for (const [index, [label, bytes, mime]] of inputs.entries()) {
    const response = await reply(await upload(market.offer.id, bytes));
    assert.equal(response.status, 201, label);
    const body = response.json as { contractVersion: string; created: boolean; photo: PhotoJson; photos: PhotoJson[] };
    assert.equal(body.contractVersion, "offer-photos/v1");
    assert.equal(body.created, true);
    assert.equal(body.photo.position, index);
    assert.equal(body.photo.mime, mime);
    assert.match(body.photo.id, MEDIA_KEY, "l'identifiant est un UUID tiré par le serveur");
    assert.deepEqual(Object.keys(body.photo).sort(), ["bytes", "height", "id", "mime", "position", "width"], "liste blanche : jamais l'empreinte ni l'annonce");
    const onDisk = new Uint8Array(await readFile(join(dir, body.photo.id)));
    assert.equal(onDisk.byteLength, body.photo.bytes);
    const row = (await rowsOf(market.offer.id))[index];
    assert.deepEqual([row.id, row.position, row.bytes, row.sha256], [body.photo.id, index, onDisk.byteLength, sha(onDisk)], "l'empreinte est celle du fichier STOCKÉ (nettoyé)");
  }
  const names = await files();
  assert.equal(names.length, 3);
  assert.ok(names.every((name) => MEDIA_KEY.test(name)), `aucun fichier hors UUID : ${names.join(",")}`);
});

test("le nom du fichier envoyé n'est JAMAIS utilisé : en-têtes de nom, adresse en `../`, paramètre de requête (refusé) ; seul un UUID tiré par le serveur nomme le fichier", async () => {
  const hostile = { "content-disposition": 'attachment; filename="../../../etc/cron.d/evil.png"', "x-filename": "../../evil.php", "x-file-name": "..\\..\\evil.exe", "content-type": "image/png; name=../../x.png" };
  const response = await reply(await upload(market.offer.id, distinctPng(), { headers: hostile }));
  assert.equal(response.status, 201);
  const names = await files();
  assert.equal(names.length, 1);
  assert.equal(names[0], (response.json as { photo: PhotoJson }).photo.id);
  assert.equal(JSON.stringify(response.json).includes("evil"), false);
  const withQuery = await reply(await upload(market.offer.id, distinctPng(), { query: "?name=../../evil.png" }));
  assert.equal(withQuery.status, 400, "aucun paramètre de requête");
  assert.equal((await files()).length, 1);
});

test("type : les OCTETS décident, jamais le Content-Type annoncé (un PNG « déclaré JPEG » est stocké PNG ; une page HTML « déclarée JPEG » est refusée ; un JPEG « déclaré HTML » est accepté)", async () => {
  const lying = await reply(await upload(market.offer.id, distinctPng(), { headers: { "content-type": "image/jpeg" } }));
  assert.equal(lying.status, 201);
  assert.equal((lying.json as { photo: PhotoJson }).photo.mime, "image/png");
  const html = new TextEncoder().encode("<html><body><script>alert(document.cookie)</script></body></html>") as Uint8Array<ArrayBuffer>;
  const refused = await reply(await upload(market.offer.id, html, { headers: { "content-type": "image/jpeg" } }));
  assert.equal(refused.status, 415);
  assert.deepEqual((refused.json as Json).error, { code: "unsupported_type", message: "Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP." });
  const jpegAsHtml = await reply(await upload(market.offer.id, buildGrayJpeg({ width: 220, height: 220 }), { headers: { "content-type": "text/html" } }));
  assert.equal(jpegAsHtml.status, 201);
  assert.equal((jpegAsHtml.json as { photo: PhotoJson }).photo.mime, "image/jpeg");
  assert.equal((await rowsOf(market.offer.id)).length, 2, "la page HTML n'a rien créé");
});

test("SVG avec un script, GIF, HEIC et texte sont refusés (415) quel que soit le type annoncé ; polyglotte JPEG/HTML : les métadonnées et le HTML du fichier stocké n'existent plus ; fichier tronqué ou vide refusé", async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>') as Uint8Array<ArrayBuffer>;
  for (const bytes of [svg, new TextEncoder().encode("GIF89a\x01\x00\x01\x00") as Uint8Array<ArrayBuffer>, concatBytes(Uint8Array.of(0, 0, 0, 24), new TextEncoder().encode("ftypheic"), new Uint8Array(16))]) {
    for (const type of ["image/svg+xml", "image/jpeg", "image/png", "application/octet-stream"]) {
      const response = await reply(await upload(market.offer.id, bytes, { headers: { "content-type": type } }));
      assert.equal(response.status, 415, type);
    }
  }
  const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  const polyglot = buildGrayJpeg({ width: 240, height: 240, after: [new Uint8Array([0xff, 0xfe, 0, html.length + 2, ...html]), jpegExifSegment({ gps: true }), jpegXmpSegment()], trailing: html });
  const accepted = await reply(await upload(market.offer.id, polyglot));
  assert.equal(accepted.status, 201);
  const stored = new Uint8Array(await readFile(join(dir, (accepted.json as { photo: PhotoJson }).photo.id)));
  for (const needle of ["<script", "<html", "alert(", "Exif", "xpacket", EXIF_MAKE, XMP_GPS_TEXT]) assert.equal(containsBytes(stored, needle), false, `le fichier stocké contient « ${needle} »`);
  for (const needle of [GPS_LATITUDE_BYTES, GPS_LONGITUDE_BYTES]) assert.equal(containsBytes(stored, needle), false, "coordonnées GPS retirées");
  const truncated = buildPng({ width: 200, height: 200 });
  assert.equal((await reply(await upload(market.offer.id, truncated.subarray(0, truncated.length - 30)))).status, 422);
  assert.equal((await reply(await upload(market.offer.id, null))).status, 400, "corps absent");
  assert.equal((await reply(await upload(market.offer.id, new Uint8Array(0)))).status, 400, "corps vide");
  assert.equal((await rowsOf(market.offer.id)).length, 1);
  assert.equal((await files()).length, 1, "seul le polyglotte nettoyé est stocké");
});

test("métadonnées : EXIF avec GPS (JPEG), eXIf et texte (PNG), EXIF et XMP (WebP) envoyés par HTTP : le fichier STOCKÉ et le fichier SERVI n'en contiennent plus un octet", async () => {
  const secrets: Array<[string, Uint8Array<ArrayBuffer>]> = [
    ["jpeg", buildGrayJpeg({ width: 320, height: 240, after: [jpegExifSegment({ gps: true }), jpegXmpSegment()] })],
    ["png", buildPng({ width: 320, height: 240, before: [{ type: "eXIf", data: buildExifTiff({ gps: true }) }, { type: "tEXt", data: new TextEncoder().encode(`GPS Latitude\0${XMP_GPS_TEXT}`) }] })],
    ["webp", buildWebpLossless({ width: 320, height: 240, extended: { exif: buildExifTiff({ gps: true }), xmp: new TextEncoder().encode(XMP_GPS_TEXT) } })],
  ];
  for (const [label, input] of secrets) {
    assert.ok(containsBytes(input, GPS_LATITUDE_BYTES) || containsBytes(input, XMP_GPS_TEXT), `${label} : le fixture porte des coordonnées`);
    const id = await addPhoto(market.offer.id, input);
    const stored = new Uint8Array(await readFile(join(dir, id)));
    const served = new Uint8Array(await (await fetchMedia(id, market.seller.cookie)).arrayBuffer());
    for (const [where, bytes] of [["stocké", stored], ["servi", served]] as const) {
      for (const needle of [GPS_LATITUDE_BYTES, GPS_LONGITUDE_BYTES, EXIF_MAKE, XMP_GPS_TEXT, "GPS Latitude", "xpacket"]) assert.equal(containsBytes(bytes, needle), false, `${label} ${where} contient encore des métadonnées`);
    }
    assert.deepEqual(served, stored);
  }
});

test("fichiers « cuisine » (faux profils ICC, EXIF, XMP, HTML, archive après la fin) envoyés par HTTP : le fichier STOCKÉ et le fichier SERVI ne contiennent AUCUNE chaîne interdite (GPS, Canon, 0708091011, Cocody, Apple Inc., ICC_PROFILE, iCCP, ICCP…)", async () => {
  const kitchens: Array<[string, Uint8Array<ArrayBuffer>, string]> = [["jpeg", buildKitchenJpeg(), "image/jpeg"], ["png", buildKitchenPng(), "image/png"], ["webp", buildKitchenWebp(), "image/webp"]];
  for (const [label, input, mime] of kitchens) {
    assert.ok(containsBytes(input, "Cocody") && containsBytes(input, "0708091011"), `${label} : le fichier de départ porte le secret`);
    const response = await reply(await upload(market.offer.id, input));
    assert.equal(response.status, 201, `${label} : ${response.text}`);
    const photo = (response.json as { photo: PhotoJson }).photo;
    assert.equal(photo.mime, mime);
    const stored = new Uint8Array(await readFile(join(dir, photo.id)));
    const served = new Uint8Array(await (await fetchMedia(photo.id, market.buyer.cookie)).arrayBuffer());
    assert.deepEqual(served, stored);
    for (const [where, bytes] of [["stocké", stored], ["servi", served]] as const) {
      for (const needle of KITCHEN_FORBIDDEN) assert.equal(containsBytes(bytes, needle), false, `${label} ${where} contient encore « ${needle} »`);
    }
    assert.equal(photo.bytes, stored.byteLength);
  }
  assert.equal((await rowsOf(market.offer.id)).length, 3);
});

test("propriétaire seulement : un acheteur, un tiers, un administrateur et une annonce inconnue reçoivent le MÊME 404 ; rien n'est écrit, aucune place d'envoi n'est prise", async () => {
  const stranger = await login(env.pool);
  const unknown = "00000000-0000-4000-8000-000000000000";
  const expected = await reply(await upload(unknown, distinctPng(), { cookie: stranger.cookie }));
  assert.equal(expected.status, 404);
  assert.deepEqual(expected.json, NOT_FOUND);
  for (const cookie of [stranger.cookie, market.buyer.cookie, boss.cookie]) {
    const response = await reply(await upload(market.offer.id, distinctPng(), { cookie }));
    assert.equal(response.status, 404);
    assert.equal(response.text, expected.text, "texte identique");
  }
  assert.equal(await count(env.pool, "offer_photos"), 0);
  assert.equal(await count(env.pool, "offer_photo_uploads"), 0, "un refus de propriété ne consomme aucune place");
  assert.deepEqual(await files(), []);
  // Liste, tri et suppression : même règle.
  assert.equal((await reply(await list(market.offer.id, stranger.cookie))).status, 404);
  assert.equal((await reply(await reorder(market.offer.id, [], { cookie: stranger.cookie }))).status, 404);
  const mine = await addPhoto(market.offer.id);
  const attempt = await reply(await remove(market.offer.id, mine, { cookie: stranger.cookie }));
  assert.equal(attempt.status, 404);
  assert.equal((await rowsOf(market.offer.id)).length, 1, "la photo d'un autre n'est jamais supprimée");
  assert.equal((await files()).length, 1);
});

test("origine vérifiée AVANT la session : sans origine ou d'une autre origine, 403 même avec un cookie invalide ; sans session, 401 ; aucun corps lu", async () => {
  const image = distinctPng();
  for (const origin of [null, "https://evil.example", "https://noma.test.evil.example", "null"]) {
    const response = await reply(await upload(market.offer.id, image, { origin, cookie: "noma_auth=invalide" }));
    assert.equal(response.status, 403, String(origin));
    assert.deepEqual((response.json as Json).error, { code: "invalid_origin", message: "Origine de la requête non autorisée." });
  }
  assert.equal((await reply(await upload(market.offer.id, image, { cookie: null }))).status, 401);
  assert.equal((await reply(await upload(market.offer.id, image, { cookie: "noma_auth=invalide" }))).status, 401);
  for (const attempt of [
    () => reorder(market.offer.id, [], { origin: "https://evil.example" }),
    () => remove(market.offer.id, "00000000-0000-4000-8000-000000000000", { origin: null }),
  ]) assert.equal((await reply(await attempt())).status, 403);
  assert.equal(await count(env.pool, "offer_photos"), 0);
  assert.equal(await count(env.pool, "offer_photo_uploads"), 0);
});

test("annonce archivée : plus d'ajout ni de tri (409), mais le propriétaire peut encore retirer ses photos", async () => {
  const id = await addPhoto(market.offer.id);
  await env.pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [market.offer.id]);
  const refused = await reply(await upload(market.offer.id, distinctPng()));
  assert.equal(refused.status, 409);
  assert.equal((refused.json as { error: { code: string } }).error.code, "resource_archived");
  assert.equal((await reply(await reorder(market.offer.id, [id]))).status, 409);
  const deleted = await reply(await remove(market.offer.id, id));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await files(), []);
});

// ═════════════ 3. Limites : poids, nombre, débit ═════════════

test("poids : 5 Mo exactement acceptés (le PNG est nettoyé), 5 Mo + 1 octet refusés (413) avec Content-Length ou en flux sans Content-Length ; aucune place d'envoi n'est prise par un fichier annoncé trop lourd", async () => {
  const base = buildPng({ width: 200, height: 200, after: [] });
  const pad = (total: number): Uint8Array<ArrayBuffer> => {
    // Un morceau privé (supprimé au nettoyage) complète le fichier jusqu'au poids voulu.
    const overhead = base.length + 12;
    const filler = new Uint8Array(total - overhead);
    const chunk = new Uint8Array(12 + filler.length);
    new DataView(chunk.buffer).setUint32(0, filler.length);
    chunk.set(new TextEncoder().encode("prVt"), 4);
    chunk.set(filler, 8);
    return concatBytes(base.subarray(0, base.length - 12), chunk, base.subarray(base.length - 12));
  };
  // Le CRC du morceau privé n'est pas contrôlé (il est supprimé) : 12 octets d'enveloppe suffisent.
  const exact = pad(PHOTO_MAX_BYTES);
  assert.equal(exact.length, PHOTO_MAX_BYTES);
  const ok = await reply(await upload(market.offer.id, exact));
  assert.equal(ok.status, 201);
  assert.ok((ok.json as { photo: PhotoJson }).photo.bytes < 5_000, "le morceau privé a été retiré");
  const slotsBefore = await count(env.pool, "offer_photo_uploads");
  const tooBig = pad(PHOTO_MAX_BYTES + 1);
  // Une vraie requête HTTP porte son Content-Length (un Request fabriqué ne l'ajoute pas).
  const declared = await reply(await upload(market.offer.id, tooBig, { headers: { "content-length": String(tooBig.length) } }));
  assert.equal(declared.status, 413);
  assert.equal((declared.json as { error: { code: string } }).error.code, "file_too_large");
  assert.equal(await count(env.pool, "offer_photo_uploads"), slotsBefore, "annoncé trop lourd : aucune place prise");
  // Même volume en flux, sans Content-Length.
  let sent = 0;
  const huge = PHOTO_MAX_BYTES * 3;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= huge) return controller.close();
      controller.enqueue(new Uint8Array(65_536));
      sent += 65_536;
    },
  });
  const streamed = await reply(await upload(market.offer.id, null, { body: stream }));
  assert.equal(streamed.status, 413);
  assert.ok(sent < huge, `le flux est coupé avant la fin (${sent} octets lus sur ${huge})`);
  assert.equal((await rowsOf(market.offer.id)).length, 1);
  assert.equal((await files()).length, 1);
});

test("6 photos au plus : la 7ᵉ est refusée (409, mots simples) sans écrire de fichier ; rejouer une photo déjà présente reste permis à 6 ; la base refuse elle aussi une 7ᵉ ligne, une position en double et une empreinte en double", async () => {
  const ids: string[] = [];
  for (let index = 0; index < PHOTO_MAX_PER_OFFER; index += 1) ids.push(await addPhoto(market.offer.id));
  assert.deepEqual((await rowsOf(market.offer.id)).map((row) => row.position), [0, 1, 2, 3, 4, 5]);
  const seventh = await reply(await upload(market.offer.id, distinctPng()));
  assert.equal(seventh.status, 409);
  assert.deepEqual((seventh.json as Json).error, { code: "photo_limit", message: "Cette annonce a déjà 6 photos : supprimez-en une pour en ajouter." });
  assert.equal((await rowsOf(market.offer.id)).length, 6);
  assert.equal((await files()).length, 6, "aucun fichier de plus");
  // Rejeu d'une photo présente (même octets) : 200, pas 409.
  const first = new Uint8Array(await readFile(join(dir, ids[0])));
  const replay = await reply(await upload(market.offer.id, Uint8Array.from(first)));
  assert.equal(replay.status, 200);
  assert.equal((replay.json as { created: boolean }).created, false);
  // La base elle-même.
  const insert = (position: number, hash: string) =>
    env.pool.query("INSERT INTO offer_photos (id, offer_id, position, mime, bytes, width, height, sha256) VALUES (gen_random_uuid(), $1, $2, 'image/png', 100, 300, 300, $3)", [market.offer.id, position, hash]);
  await assert.rejects(insert(6, "a".repeat(64)), /chk_|check/i, "position 6 refusée en base");
  await assert.rejects(insert(5, "b".repeat(64)), /uq_offer_photos_position|unique/i, "position en double refusée");
  const hash0 = (await rowsOf(market.offer.id))[0].sha256;
  await env.pool.query("DELETE FROM offer_photos WHERE id = $1", [ids[5]]);
  await assert.rejects(insert(5, hash0), /uq_offer_photos_sha256|unique/i, "empreinte en double refusée");
  await assert.rejects(env.pool.query("UPDATE offer_photos SET position = 0 WHERE id = $1", [ids[1]]), /uq_offer_photos_position|unique/i, "deux photos en position 0 refusées en fin de transaction");
});

test("règles de la base : dimensions, poids, type et empreinte hors bornes refusés (200 à 4 100 px, 12,5 mégapixels, 5 Mo, JPEG PNG WebP, SHA-256)", async () => {
  const insert = (patch: Partial<Record<"mime" | "bytes" | "width" | "height" | "sha256", string | number>>, position = 0) => {
    const row = { mime: "image/png", bytes: 1_000, width: 300, height: 300, sha256: "d".repeat(63) + String(position), ...patch };
    return env.pool.query("INSERT INTO offer_photos (id, offer_id, position, mime, bytes, width, height, sha256) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)", [market.offer.id, position, row.mime, row.bytes, row.width, row.height, row.sha256]);
  };
  for (const [label, patch] of [
    ["largeur 199", { width: 199 }], ["hauteur 199", { height: 199 }], ["largeur 4101", { width: 4_101 }], ["hauteur 4101", { height: 4_101 }],
    ["12,5 mégapixels + 1", { width: 4_100, height: 3_049 }], ["ancienne borne de 8 000 px", { width: 8_000, height: 200 }], ["poids nul", { bytes: 0 }], ["poids 5 Mo + 1", { bytes: PHOTO_MAX_BYTES + 1 }],
    ["type gif", { mime: "image/gif" }], ["type svg", { mime: "image/svg+xml" }], ["empreinte courte", { sha256: "abc" }], ["empreinte en majuscules", { sha256: "D".repeat(64) }],
  ] as const) await assert.rejects(insert(patch), /check|chk_/i, label);
  await insert({ width: 3_125, height: 4_000, bytes: PHOTO_MAX_BYTES }); // 12,5 Mpx pile et 5 Mo pile passent
  await insert({ width: 4_100, height: 3_048 }, 1);
  await insert({ width: 200, height: 4_100 }, 2);
  assert.equal(await count(env.pool, "offer_photos"), 3);
});

test("limite de débit : 30 envois par heure et par vendeur (le 31ᵉ reçoit 429 avec Retry-After), un autre vendeur n'est pas gêné, supprimer une photo ne rend pas la place, un envoi refusé pour son fichier compte, la fenêtre glisse", async () => {
  const offers = [market.offer];
  for (let index = 0; index < 4; index += 1) offers.push(await makeOffer(env.pool, market.seller.userId));
  for (let index = 0; index < PHOTO_UPLOADS_PER_HOUR - 2; index += 1) await addPhoto(offers[Math.floor(index / 6)].id);
  assert.equal(await count(env.pool, "offer_photo_uploads"), 28);
  // Un envoi refusé pour son fichier compte comme un envoi.
  assert.equal((await reply(await upload(offers[4].id, new TextEncoder().encode("pas une image") as Uint8Array<ArrayBuffer>))).status, 415);
  // Un rejeu compte aussi.
  const [firstRow] = await rowsOf(offers[0].id);
  assert.equal((await reply(await upload(offers[0].id, new Uint8Array(await readFile(join(dir, firstRow.id))) as Uint8Array<ArrayBuffer>))).status, 200);
  assert.equal(await count(env.pool, "offer_photo_uploads"), PHOTO_UPLOADS_PER_HOUR);
  const limited = await reply(await upload(offers[4].id, distinctPng()));
  assert.equal(limited.status, 429);
  assert.equal((limited.json as { error: { code: string } }).error.code, "rate_limited");
  const retry = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 3_600, `Retry-After ${retry}`);
  assert.equal((await rowsOf(offers[4].id)).length, 4, "aucune photo de plus écrite");
  assert.equal((await files()).length, 28);
  // Supprimer une photo ne rend pas la place.
  assert.equal((await reply(await remove(offers[0].id, firstRow.id))).status, 200);
  assert.equal((await reply(await upload(offers[4].id, distinctPng()))).status, 429);
  // Un autre vendeur n'est pas gêné.
  const other = await login(env.pool);
  const otherOffer = await makeOffer(env.pool, other.userId);
  assert.ok(await addPhoto(otherOffer.id, distinctPng(), other.cookie));
  // La fenêtre glisse : les envois de plus d'une heure ne comptent plus ; ceux de plus de 24 h sont supprimés.
  await env.pool.query("UPDATE offer_photo_uploads SET uploaded_at = clock_timestamp() - interval '61 minutes' WHERE seller_id = $1", [market.seller.userId]);
  assert.equal((await reply(await upload(offers[4].id, distinctPng()))).status, 201);
  await env.pool.query("UPDATE offer_photo_uploads SET uploaded_at = clock_timestamp() - interval '25 hours' WHERE seller_id = $1 AND id IN (SELECT id FROM offer_photo_uploads WHERE seller_id = $1 ORDER BY id LIMIT 5)", [market.seller.userId]);
  assert.equal((await reply(await upload(offers[4].id, distinctPng()))).status, 201);
  assert.equal(await count(env.pool, "offer_photo_uploads", `seller_id = '${market.seller.userId}' AND uploaded_at < clock_timestamp() - interval '24 hours'`), 0, "les lignes de plus de 24 h sont purgées au fil de l'eau");
});

test("limite de débit exacte sous concurrence : 40 envois simultanés d'un même vendeur, jamais plus de 30 acceptés", async () => {
  const offers = [market.offer];
  for (let index = 0; index < 6; index += 1) offers.push(await makeOffer(env.pool, market.seller.userId));
  const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => upload(offers[index % 7].id, distinctPng())));
  const statuses = responses.map((response) => response.status);
  const created = statuses.filter((status) => status === 201).length;
  const limited = statuses.filter((status) => status === 429).length;
  assert.equal(await count(env.pool, "offer_photo_uploads"), PHOTO_UPLOADS_PER_HOUR, "exactement 30 places prises");
  assert.deepEqual([created, limited], [PHOTO_UPLOADS_PER_HOUR, 10], `${created} créées, ${limited} limitées : ${statuses.join(",")}`);
  assert.equal((await files()).length, await count(env.pool, "offer_photos"), "autant de fichiers que de lignes");
});

test("corps lent : un octet toutes les 40 ms est coupé au délai total (408) sans fichier ni ligne ; la place d'envoi n'est PAS rendue (elle borne les connexions lentes d'un compte) ; cinq corps lents en parallèle sont tous coupés", async () => {
  const slow = createMediaHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: () => {}, store, hooks, bodyReadTimeoutMs: 80 });
  let pulled = 0;
  // Un octet toutes les 40 ms, au plus 25 octets (le flux finit de lui-même après 1 s : sans délai, l'envoi irait au bout et serait refusé pour son contenu, jamais suspendu).
  const drip = () => {
    let sentBytes = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await sleep(40);
        pulled += 1;
        sentBytes += 1;
        controller.enqueue(Uint8Array.of(1));
        if (sentBytes >= 25) controller.close();
      },
    });
  };
  const send = (body: ReadableStream<Uint8Array>, cookie = market.seller.cookie) =>
    slow.photos.upload(binaryRequest("POST", `/api/offers/${market.offer.id}/photos`, { cookie, body }), market.offer.id);
  const started = performance.now();
  const response = await reply(await send(drip()));
  const elapsed = performance.now() - started;
  assert.equal(response.status, 408);
  assert.deepEqual((response.json as Json).error, { code: "request_timeout", message: PHOTO_ERROR_MESSAGES.request_timeout });
  // Lot T3 : après une 408 le serveur demande la FERMETURE de la connexion (le reste du corps abandonné ne doit pas être lu comme la requête suivante) ; aucun autre refus ne le fait.
  assert.equal(response.headers.get("connection"), "close");
  assert.ok(elapsed >= 70 && elapsed < 2_000, `coupé au délai : ${elapsed.toFixed(0)} ms`);
  assert.ok(pulled < 20, `le flux n'a pas été lu longtemps (${pulled} octets)`);
  assert.equal(await count(env.pool, "offer_photos"), 0);
  assert.deepEqual(await files(), []);
  assert.equal(await count(env.pool, "offer_photo_uploads"), 1, "la place prise AVANT la lecture n'est pas rendue : sans cela, un corps goutte à goutte serait gratuit");
  // Cinq envois lents EN PARALLÈLE : tous coupés au délai, aucun ne retient une connexion plus longtemps.
  const batchStarted = performance.now();
  const batch = await Promise.all(Array.from({ length: 5 }, () => send(drip()).then((r) => r.status)));
  assert.deepEqual(batch, [408, 408, 408, 408, 408]);
  assert.ok(performance.now() - batchStarted < 2_000, "tous coupés ensemble, pas l'un après l'autre");
  assert.equal(await count(env.pool, "offer_photo_uploads"), 6);
  // Après 30 corps lents, le compte est limité (429) même pour un bon fichier : la place ne se récupère pas par un 408.
  for (let index = 0; index < PHOTO_UPLOADS_PER_HOUR - 6; index += 1) assert.equal((await send(drip())).status, 408);
  const limited = await reply(await upload(market.offer.id, distinctPng()));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("connection"), null, "T3 : seule la 408 demande la fermeture de la connexion");
  // Un corps rapide n'est pas touché par le délai ; le défaut (30 s) est vérifié par les essais du lecteur de corps.
  await env.pool.query("TRUNCATE offer_photo_uploads");
  assert.equal((await reply(await slow.photos.upload(binaryRequest("POST", `/api/offers/${market.offer.id}/photos`, { cookie: market.seller.cookie, body: distinctPng() }), market.offer.id))).status, 201);
});

test("les messages du serveur sont EXACTEMENT ceux du client (mots simples) : format, poids, photo abîmée, trop petite, trop grande (côté et nombre de pixels), délai, limite ; la bombe de l'auditeur (8 000 × 5 000) est refusée", async () => {
  const seenError = async (response: Response, status: number): Promise<{ code: string; message: string }> => {
    const answered = await reply(response);
    assert.equal(answered.status, status);
    return (answered.json as { error: { code: string; message: string } }).error;
  };
  const expectations: Array<[string, number, Promise<Response>]> = [
    ["unsupported_type", 415, upload(market.offer.id, new TextEncoder().encode("<svg/>") as Uint8Array<ArrayBuffer>)],
    ["truncated", 422, upload(market.offer.id, buildPng({ width: 200, height: 200 }).subarray(0, 100) as Uint8Array<ArrayBuffer>)],
    ["too_small", 422, upload(market.offer.id, buildPng({ width: 100, height: 100 }))],
    ["too_large_dimensions", 422, upload(market.offer.id, buildPng({ width: 200, height: 200, declared: { width: 4_101, height: 200 } }))],
    ["too_large_dimensions", 422, upload(market.offer.id, buildPng({ width: 200, height: 200, declared: { width: 8_000, height: 5_000 } }))],
    ["too_many_pixels", 422, upload(market.offer.id, buildPng({ width: 200, height: 200, declared: { width: 4_100, height: 3_049 } }))],
    ["animated", 422, upload(market.offer.id, buildWebpLossless({ width: 200, height: 200, extended: {} }).map((byte, index) => (index === 20 ? 0x02 : byte)) as Uint8Array<ArrayBuffer>)],
    ["file_too_large", 413, upload(market.offer.id, distinctPng(), { headers: { "content-length": String(PHOTO_MAX_BYTES + 1) } })],
  ];
  for (const [code, status, pending] of expectations) {
    const error = await seenError(await pending, status);
    assert.equal(error.code, code);
    assert.equal(error.message, PHOTO_ERROR_MESSAGES[code], `message de ${code}`);
  }
  // Un téléphone d'entrée de gamme (4 032 × 3 024) passe ; l'en-tête seul compte (les données peuvent être plus petites).
  assert.equal((await reply(await upload(market.offer.id, buildGrayJpeg({ width: 800, height: 600, declared: { width: 4_032, height: 3_024 } })))).status, 201);
  assert.equal((await rowsOf(market.offer.id)).length, 1);
});

// ═════════════ 4. Rejeu et concurrence ═════════════

test("rejeu idempotent : mêmes octets, ou même image avec d'autres métadonnées, donnent la MÊME photo (200, created: false) ; une ligne, un fichier", async () => {
  const plain = buildGrayJpeg({ width: 320, height: 240, gray: 99 });
  const first = await reply(await upload(market.offer.id, plain));
  assert.equal(first.status, 201);
  const again = await reply(await upload(market.offer.id, plain));
  assert.equal(again.status, 200);
  assert.deepEqual([(again.json as { created: boolean }).created, (again.json as { photo: PhotoJson }).photo.id], [false, (first.json as { photo: PhotoJson }).photo.id]);
  // Même image, mais avec un EXIF GPS : après nettoyage, c'est le même fichier.
  const withGps = buildGrayJpeg({ width: 320, height: 240, gray: 99, after: [jpegExifSegment({ gps: true }), jpegXmpSegment()], trailing: new TextEncoder().encode("fin") });
  const third = await reply(await upload(market.offer.id, withGps));
  assert.equal(third.status, 200);
  assert.equal((third.json as { photo: PhotoJson }).photo.id, (first.json as { photo: PhotoJson }).photo.id);
  assert.equal((await rowsOf(market.offer.id)).length, 1);
  assert.equal((await files()).length, 1);
  // Une autre annonce du même vendeur peut avoir la même photo.
  const second = await makeOffer(env.pool, market.seller.userId);
  assert.equal((await reply(await upload(second.id, plain))).status, 201);
  assert.equal((await files()).length, 2);
});

test("rejeu simultané : 8 envois identiques en même temps donnent UNE photo créée et sept rejeux, une ligne, un fichier", async () => {
  const bytes = distinctPng(260, 260);
  const responses = await Promise.all(Array.from({ length: 8 }, () => upload(market.offer.id, Uint8Array.from(bytes))));
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal((await rowsOf(market.offer.id)).length, 1);
  assert.equal((await files()).length, 1, "aucun fichier en double");
});

test("deux envois simultanés sur la 6ᵉ place : un seul est accepté, l'autre reçoit 409 ; 6 lignes, 6 fichiers, aucun orphelin", async () => {
  for (let index = 0; index < 5; index += 1) await addPhoto(market.offer.id);
  const [a, b] = await Promise.all([upload(market.offer.id, distinctPng()), upload(market.offer.id, distinctPng())]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await rowsOf(market.offer.id)).length, 6);
  assert.deepEqual((await rowsOf(market.offer.id)).map((row) => row.position), [0, 1, 2, 3, 4, 5]);
  assert.equal((await files()).length, 6);
  assert.equal(await count(env.pool, "media_orphans"), 0);
});

test("dix envois distincts simultanés sur une annonce vide : six acceptés, quatre refusés (409), positions 0 à 5 sans trou", async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => upload(market.offer.id, distinctPng())));
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 409, 409, 409, 409]);
  assert.deepEqual((await rowsOf(market.offer.id)).map((row) => row.position), [0, 1, 2, 3, 4, 5]);
  assert.equal((await files()).length, 6);
});

// ═════════════ 5. Ordre, couverture, suppression ═════════════

test("ordre et couverture : un nouvel ordre est appliqué en entier (la première photo devient la couverture) ; une liste qui n'est pas EXACTEMENT les photos de l'annonce est refusée sans rien changer", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) ids.push(await addPhoto(market.offer.id));
  const reversed = [...ids].reverse();
  const done = await reply(await reorder(market.offer.id, reversed));
  assert.equal(done.status, 200);
  assert.deepEqual(photosOf(done).map((photo) => photo.id), reversed);
  assert.deepEqual(photosOf(done).map((photo) => photo.position), [0, 1, 2, 3]);
  assert.deepEqual((await rowsOf(market.offer.id)).map((row) => row.id), reversed);
  const listed = await reply(await list(market.offer.id));
  assert.deepEqual(photosOf(listed).map((photo) => photo.id), reversed, "la liste suit l'ordre");
  const elsewhere = await makeOffer(env.pool, market.seller.userId);
  const foreign = await addPhoto(elsewhere.id);
  for (const bad of [reversed.slice(1), [...reversed, ids[0]], [ids[0], ids[0], ids[1], ids[2]], [...reversed.slice(1), foreign], [], "pas une liste", [1, 2, 3, 4], [...reversed.slice(0, 3), "pas-un-uuid"]]) {
    const response = await reply(await reorder(market.offer.id, bad));
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await rowsOf(market.offer.id)).map((row) => row.id), reversed, "l'ordre n'a pas bougé");
  const extra = await reply(await handlers.photos.reorder(binaryRequest("PUT", `/api/offers/${market.offer.id}/photos`, { cookie: market.seller.cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ order: reversed, autre: 1 }) }), market.offer.id));
  assert.equal(extra.status, 400, "aucun champ de plus");
});

test("suppression : la ligne et le fichier disparaissent, les positions se recompactent (la suivante devient couverture), une suppression rejouée répond removed: false", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) ids.push(await addPhoto(market.offer.id));
  const removed = await reply(await remove(market.offer.id, ids[0]));
  assert.equal(removed.status, 200);
  assert.equal((removed.json as { removed: boolean }).removed, true);
  assert.deepEqual(photosOf(removed).map((photo) => [photo.id, photo.position]), [[ids[1], 0], [ids[2], 1], [ids[3], 2]]);
  assert.deepEqual((await files()).sort(), ids.slice(1).sort());
  const again = await reply(await remove(market.offer.id, ids[0]));
  assert.equal(again.status, 200);
  assert.equal((again.json as { removed: boolean }).removed, false);
  assert.equal((await reply(await fetchMedia(ids[0], market.seller.cookie))).status, 404, "la photo supprimée n'est plus servie");
  // Une nouvelle photo prend la première place libre.
  const next = await addPhoto(market.offer.id);
  assert.equal((await rowsOf(market.offer.id)).find((row) => row.id === next)?.position, 3);
});

test("suppression : le fichier part APRÈS la validation de la transaction (transaction qui échoue : la ligne ET le fichier restent) ; un fichier impossible à supprimer est journalisé", async () => {
  const id = await addPhoto(market.offer.id);
  hooks.beforeCommit = async () => { throw new Error("échec simulé avant la validation"); };
  const failed = await reply(await remove(market.offer.id, id));
  assert.equal(failed.status, 503);
  hooks.beforeCommit = undefined;
  assert.equal((await rowsOf(market.offer.id)).length, 1, "la ligne est restée");
  assert.deepEqual(await files(), [id], "le fichier est resté : il n'est supprimé qu'après la validation");
  assert.equal((await fetchMedia(id, market.seller.cookie)).status, 200, "la photo reste servie");
  // Suppression réussie mais fichier impossible à retirer : la ligne part, l'orphelin est journalisé.
  const failing: MediaStore = {
    put: (key, bytes) => store.put(key, bytes),
    get: (key) => store.get(key),
    list: () => store.list(),
    delete: async () => { throw new Error("disque en lecture seule"); },
  };
  const flaky = createMediaHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: () => {}, store: failing, hooks });
  const response = await reply(await flaky.photos.remove(binaryRequest("DELETE", `/api/offers/${market.offer.id}/photos/${id}`, { cookie: market.seller.cookie }), market.offer.id, id));
  assert.equal(response.status, 200);
  assert.equal((response.json as { removed: boolean }).removed, true);
  assert.equal((await rowsOf(market.offer.id)).length, 0);
  assert.deepEqual(await files(), [id], "le fichier est resté sur le disque");
  const journal = await env.pool.query<{ storage_key: string; reason: string; resolved_at: Date | null }>("SELECT storage_key, reason, resolved_at FROM media_orphans");
  assert.deepEqual(journal.rows.map((row) => [row.storage_key, row.reason, row.resolved_at]), [[id, "delete_failed", null]], "orphelin journalisé");
});

test("envoi : transaction qui échoue après l'écriture du fichier : le fichier est retiré (jamais d'orphelin), aucune ligne ; si le retrait échoue aussi, l'orphelin est journalisé", async () => {
  hooks.beforeCommit = async () => { throw new Error("échec simulé avant la validation"); };
  const failed = await reply(await upload(market.offer.id, distinctPng()));
  assert.equal(failed.status, 503);
  assert.equal(await count(env.pool, "offer_photos"), 0);
  assert.deepEqual(await files(), [], "le fichier écrit a été retiré");
  const stuck: MediaStore = { put: (key, bytes) => store.put(key, bytes), get: (key) => store.get(key), list: () => store.list(), delete: async () => { throw new Error("verrouillé"); } };
  const flaky = createMediaHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: () => {}, store: stuck, hooks });
  const second = await reply(await flaky.photos.upload(binaryRequest("POST", `/api/offers/${market.offer.id}/photos`, { cookie: market.seller.cookie, body: distinctPng() }), market.offer.id));
  assert.equal(second.status, 503);
  assert.equal(await count(env.pool, "offer_photos"), 0);
  assert.equal((await files()).length, 1, "un fichier reste sur le disque…");
  const journal = await env.pool.query<{ storage_key: string; reason: string }>("SELECT storage_key, reason FROM media_orphans");
  assert.deepEqual(journal.rows.map((row) => [row.storage_key, row.reason]), [[(await files())[0], "write_failed"]], "…et il est journalisé");
  assert.equal((await reply(await upload(market.offer.id, distinctPng()))).status, 503, "le crochet d'essai est toujours actif");
  hooks.beforeCommit = undefined;
});

// ═════════════ 6. Lecture : qui voit un fichier ═════════════

async function servedHeaders(response: Response): Promise<Record<string, string | null>> {
  await response.arrayBuffer();
  return Object.fromEntries(["content-type", "x-content-type-options", "content-disposition", "content-security-policy", "cache-control", "vary", "cross-origin-resource-policy"].map((name) => [name, response.headers.get(name)]));
}

test("lecture : propriétaire, administrateur et acheteur d'une correspondance confirmée reçoivent le fichier (octets identiques) avec les en-têtes de sécurité", async () => {
  const bytes = buildGrayJpeg({ width: 320, height: 240, gray: 60 });
  const id = await addPhoto(market.offer.id, bytes);
  const stored = new Uint8Array(await readFile(join(dir, id)));
  for (const [label, cookie] of [["propriétaire", market.seller.cookie], ["administrateur", boss.cookie], ["acheteur", market.buyer.cookie]] as const) {
    const response = await fetchMedia(id, cookie);
    assert.equal(response.status, 200, label);
    assert.deepEqual(await servedHeaders(response.clone()), {
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=300",
      vary: "Cookie",
      "cross-origin-resource-policy": "same-origin",
    }, label);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), stored, label);
    assert.equal(response.headers.get("content-length"), String(stored.length));
    assert.ok(!(response.headers.get("content-disposition") ?? "").includes("filename"), "aucun nom de fichier");
  }
  // Le type servi est celui de la base : un PNG est servi image/png.
  const png = await addPhoto(market.offer.id, buildPng({ width: 300, height: 200 }));
  assert.equal((await fetchMedia(png, market.buyer.cookie)).headers.get("content-type"), "image/png");
  const webp = await addPhoto(market.offer.id, buildWebpLossless({ width: 300, height: 200 }));
  assert.equal((await fetchMedia(webp, market.buyer.cookie)).headers.get("content-type"), "image/webp");
});

test("lecture : 404 INDISCERNABLE pour un autre acheteur, une annonce hors correspondance, un besoin clos, un visiteur, un identifiant inconnu ou mal formé, un paramètre de requête ; la même réponse partout", async () => {
  const id = await addPhoto(market.offer.id);
  const stranger = await login(env.pool);
  await makeDemand(env.pool, stranger.userId); // un besoin actif… sans cette annonce parmi ses correspondances
  const unmatched = await makeOffer(env.pool, market.seller.userId); // annonce du même vendeur, SANS correspondance avec le besoin de l'acheteur
  const unmatchedPhoto = await addPhoto(unmatched.id);
  const seen = async (promise: Promise<Response>): Promise<{ status: number; text: string; cache: string | null; type: string | null; nosniff: string | null }> => {
    const response = await promise;
    return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control"), type: response.headers.get("content-type"), nosniff: response.headers.get("x-content-type-options") };
  };
  const reference = await seen(fetchMedia("00000000-0000-4000-8000-000000000000", market.buyer.cookie));
  assert.equal(reference.status, 404);
  assert.deepEqual(JSON.parse(reference.text), NOT_FOUND);
  assert.equal(reference.cache, "no-store");
  const denied: Array<[string, Promise<Response>]> = [
    ["autre acheteur", fetchMedia(id, stranger.cookie)],
    ["annonce hors correspondance", fetchMedia(unmatchedPhoto, market.buyer.cookie)],
    ["visiteur sans session", fetchMedia(id, null)],
    ["session invalide", fetchMedia(id, "noma_auth=invalide")],
    ["identifiant mal formé", fetchMedia("../../etc/passwd", market.buyer.cookie)],
    ["identifiant vide", fetchMedia("", market.buyer.cookie)],
    ["paramètre de requête", fetchMedia(id, market.buyer.cookie, "?download=1")],
  ];
  for (const [label, promise] of denied) assert.deepEqual(await seen(promise), reference, label);
  // Le vendeur d'une AUTRE annonce, lui, ne voit pas non plus les photos des autres.
  const otherSeller = await login(env.pool);
  assert.deepEqual(await seen(fetchMedia(id, otherSeller.cookie)), reference, "un autre vendeur");
  // Un besoin clos (satisfait) ne donne plus accès.
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [market.demand.id]);
  assert.deepEqual(await seen(fetchMedia(id, market.buyer.cookie)), reference, "besoin clos");
  await env.pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [market.demand.id]);
  assert.equal((await fetchMedia(id, market.buyer.cookie)).status, 200, "besoin rouvert");
});

test("lecture : une annonce dépubliée (en pause, archivée, brouillon, indisponible) n'est plus servie à l'acheteur mais reste lisible par son propriétaire ; elle l'est de nouveau une fois remise en ligne", async () => {
  const id = await addPhoto(market.offer.id);
  const buyerStatus = async () => (await fetchMedia(id, market.buyer.cookie)).status;
  assert.equal(await buyerStatus(), 200);
  for (const status of ["paused", "draft", "archived"] as const) {
    await env.pool.query("UPDATE offers SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN clock_timestamp() END WHERE id = $1", [market.offer.id, status]);
    assert.equal(await buyerStatus(), 404, `acheteur, annonce ${status}`);
    assert.equal((await fetchMedia(id, market.seller.cookie)).status, 200, `propriétaire, annonce ${status}`);
    assert.equal((await fetchMedia(id, boss.cookie)).status, 200, `administrateur, annonce ${status}`);
  }
  await env.pool.query("UPDATE offers SET status = 'published', archived_at = NULL WHERE id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 200, "remise en ligne");
  await env.pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 404, "vendue (indisponible)");
  await env.pool.query("UPDATE offers SET availability_status = 'available' WHERE id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 200);
  // Correspondance périmée ou non confirmée : plus d'accès.
  await env.pool.query("UPDATE matching_evaluations SET is_stale = TRUE WHERE offer_id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 404, "évaluation périmée");
  await env.pool.query("UPDATE matching_evaluations SET is_stale = FALSE WHERE offer_id = $1", [market.offer.id]);
  await env.pool.query("UPDATE matching_evaluations SET compatibility_status = 'incompatible' WHERE offer_id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 404, "correspondance non confirmée");
  await env.pool.query("UPDATE matching_evaluations SET compatibility_status = 'compatible' WHERE offer_id = $1", [market.offer.id]);
  assert.equal(await buyerStatus(), 200);
  // Vendeur suspendu : l'acheteur ne voit plus ses photos.
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [market.seller.userId]);
  assert.equal(await buyerStatus(), 404, "vendeur suspendu");
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [market.seller.userId]);
  assert.equal(await buyerStatus(), 200);
});

test("lecture : un administrateur suspendu n'a plus accès ; une ligne dont le fichier manque ou a changé de taille répond 404 (jamais 500, jamais d'octets douteux)", async () => {
  const id = await addPhoto(market.offer.id);
  assert.equal((await fetchMedia(id, boss.cookie)).status, 200);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [boss.userId]);
  assert.equal((await fetchMedia(id, boss.cookie)).status, 404, "administrateur suspendu : session refusée");
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [boss.userId]);
  await writeFile(join(dir, id), Uint8Array.of(1, 2, 3));
  assert.equal((await fetchMedia(id, market.seller.cookie)).status, 404, "taille différente de celle de la base");
  await rm(join(dir, id));
  assert.equal((await fetchMedia(id, market.seller.cookie)).status, 404, "fichier absent");
  assert.equal((await fetchMedia(id, market.buyer.cookie)).status, 404);
});

test("lecture : la réponse 404 et la réponse 200 ne dépendent que des droits ; un acheteur qui a le droit par UN de ses besoins actifs voit la photo même si un autre de ses besoins est clos", async () => {
  const id = await addPhoto(market.offer.id);
  const second = await makeDemand(env.pool, market.buyer.userId);
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [second.id]);
  assert.equal((await fetchMedia(id, market.buyer.cookie)).status, 200);
  await makeDemand(env.pool, market.buyer.userId);
  assert.equal((await fetchMedia(id, market.buyer.cookie)).status, 200);
});

// ═════════════ 7. Dossier de stockage de l'environnement ═════════════

test("NOMA_MEDIA_DIR : sans store injecté, les fichiers vont dans le dossier désigné (et nulle part ailleurs) ; en production sans variable : 503, rien n'est écrit", async () => {
  const custom = await mkdtemp(join(tmpdir(), "noma-media-env-"));
  try {
    const configured = createMediaHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, NOMA_MEDIA_DIR: custom }, log: () => {} });
    const response = await reply(await configured.photos.upload(binaryRequest("POST", `/api/offers/${market.offer.id}/photos`, { cookie: market.seller.cookie, body: distinctPng() }), market.offer.id));
    assert.equal(response.status, 201);
    const id = (response.json as { photo: PhotoJson }).photo.id;
    assert.deepEqual(await readdir(custom), [id]);
    assert.deepEqual(await files(), [], "rien dans le dossier de l'autre magasin");
    assert.equal((await stat(join(custom, id))).isFile(), true);
    const served = await configured.media.get(binaryRequest("GET", `/api/media/${id}`, { cookie: market.seller.cookie }), id);
    assert.equal(served.status, 200);
    await served.arrayBuffer();
    const production = createMediaHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, NODE_ENV: "production" }, log: () => {} });
    const refused = await reply(await production.photos.upload(binaryRequest("POST", `/api/offers/${market.offer.id}/photos`, { cookie: market.seller.cookie, body: distinctPng() }), market.offer.id));
    assert.equal(refused.status, 503);
    assert.deepEqual(await readdir(custom), [id], "aucun fichier écrit");
    assert.equal(await count(env.pool, "offer_photos"), 1);
    assert.ok(!JSON.stringify(refused.json).includes(custom), "le chemin du dossier n'est jamais révélé");
  } finally {
    await rm(custom, { recursive: true, force: true });
  }
});

// ═════════════ 8. Vignettes et galerie dans les écrans ═════════════

test("écrans : la liste des résultats de l'acheteur porte la couverture, la fiche porte la galerie dans l'ordre, le tableau de bord du vendeur et les favoris portent la couverture ; sans photo, AUCUNE clé n'est ajoutée", async () => {
  const withNothing = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${market.demand.id}/stored-matches`, { cookie: market.buyer.cookie }), market.demand.id));
  assert.equal(withNothing.status, 200);
  const itemsBefore = (withNothing.json as { items: Json[] }).items;
  assert.equal(itemsBefore.length, 1);
  assert.ok(!("coverPhotoId" in itemsBefore[0]), "sans photo : pas de clé");
  const detailBefore = await reply(await metrics.demandOffers.get(request("GET", `/api/demands/${market.demand.id}/offers/${market.offer.id}`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id));
  assert.deepEqual(Object.keys((detailBefore.json as { details: Json }).details).sort(), ["attributes", "createdAt"]);
  assert.ok(!("coverPhotoId" in ((await readVendorHome({ pool: env.pool, userId: market.seller.userId })).offers[0] as unknown as Json)));

  const first = await addPhoto(market.offer.id, buildPng({ width: 300, height: 200, pattern: "stripes" }));
  const second = await addPhoto(market.offer.id, buildPng({ width: 320, height: 240, pattern: "checker" }));
  const results = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${market.demand.id}/stored-matches`, { cookie: market.buyer.cookie }), market.demand.id));
  assert.equal((results.json as { items: Array<{ coverPhotoId?: string }> }).items[0].coverPhotoId, first);
  const detail = await reply(await metrics.demandOffers.get(request("GET", `/api/demands/${market.demand.id}/offers/${market.offer.id}`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id));
  assert.deepEqual((detail.json as { details: { photos: unknown[] } }).details.photos, [{ id: first, width: 300, height: 200 }, { id: second, width: 320, height: 240 }], "galerie : identifiant et dimensions, dans l'ordre");
  assert.ok(!JSON.stringify(detail.json).includes(sha(new Uint8Array(await readFile(join(dir, first))))), "jamais l'empreinte");
  // La couverture suit l'ordre.
  assert.equal((await reply(await reorder(market.offer.id, [second, first]))).status, 200);
  const reordered = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${market.demand.id}/stored-matches`, { cookie: market.buyer.cookie }), market.demand.id));
  assert.equal((reordered.json as { items: Array<{ coverPhotoId?: string }> }).items[0].coverPhotoId, second);
  const home = await readVendorHome({ pool: env.pool, userId: market.seller.userId });
  assert.equal(home.offers[0].coverPhotoId, second);
  // Favoris : couverture pour une annonce ouvrable.
  const added = await reply(await social.favorites.add(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/favorite`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id));
  assert.ok(added.status === 201 || added.status === 200);
  const favorites = await reply(await social.favorites.list(request("GET", "/api/favorites", { cookie: market.buyer.cookie })));
  assert.equal((favorites.json as { items: Array<{ coverPhotoId?: string }> }).items[0].coverPhotoId, second);
  // Annonce dépubliée : plus de couverture dans les favoris (elle ne serait plus servie), plus de galerie (la fiche répond 404).
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  const gone = await reply(await social.favorites.list(request("GET", "/api/favorites", { cookie: market.buyer.cookie })));
  assert.ok(!("coverPhotoId" in (gone.json as { items: Json[] }).items[0]));
  assert.equal((await reply(await metrics.demandOffers.get(request("GET", `/api/demands/${market.demand.id}/offers/${market.offer.id}`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id))).status, 404);
});

test("écrans : un acheteur ne reçoit des identifiants de photos que pour SES correspondances (la liste d'un autre besoin ne montre pas les photos d'une annonce hors correspondance)", async () => {
  const hidden = await makeOffer(env.pool, market.seller.userId);
  const hiddenPhoto = await addPhoto(hidden.id);
  const visible = await addPhoto(market.offer.id);
  const results = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${market.demand.id}/stored-matches`, { cookie: market.buyer.cookie }), market.demand.id));
  assert.ok(!results.text.includes(hiddenPhoto), "l'identifiant de la photo d'une annonce hors correspondance n'apparaît pas");
  assert.ok(results.text.includes(visible));
  const stranger = await login(env.pool);
  const demand = await makeDemand(env.pool, stranger.userId);
  const empty = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${demand.id}/stored-matches`, { cookie: stranger.cookie }), demand.id));
  assert.ok(!empty.text.includes(visible) && !empty.text.includes(hiddenPhoto));
  await makeMatch(env.pool, hidden, demand);
  const other = await reply(await matching.demands.storedMatches(request("GET", `/api/demands/${demand.id}/stored-matches`, { cookie: stranger.cookie }), demand.id));
  assert.ok(other.text.includes(hiddenPhoto) && !other.text.includes(visible), "chacun voit les photos de SES correspondances seulement");
});
