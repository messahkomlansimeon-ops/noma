import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_INVALID_ID, API_INVALID_RESPONSE, ApiError, createApiClient, describeApiError } from "../../lib/client/api";
import {
  PHOTO_ACCEPTED_TYPES, PHOTO_ERROR_MESSAGES, PHOTO_MAX_BYTES, PHOTO_MAX_PER_OFFER, PHOTO_MIN_SIDE, createPhotosClient, describePhotoError, mediaUrl, parseCoverPhotoId, parsePhotoRefs,
  type UploadTransportInput,
} from "../../lib/client/photos-api";
import { PHOTO_REFS_MAX } from "../../lib/client/photos-refs";
import { createSocialClient } from "../../lib/client/social-api";
import { PHOTO_MAX_BYTES as SERVER_MAX_BYTES, PHOTO_MAX_PER_OFFER as SERVER_MAX_PER_OFFER, PHOTO_MIN_SIDE as SERVER_MIN_SIDE } from "../../lib/server/media/config";

/**
 * Couche cliente des photos (lot PH1) : requêtes exactes, réponses relues champ par champ, identifiants vérifiés avant toute requête, messages d'erreur fixes en mots simples, bornes
 * identiques à celles du serveur, couvertures et galeries relues par les clients des résultats, de la fiche, du tableau de bord et des favoris.
 */

const OFFER = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";
const PHOTO_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const PHOTO_B = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const photo = (id: string, position: number, extra: Record<string, unknown> = {}) => ({ id, position, mime: "image/png", width: 300, height: 200, bytes: 1_234, ...extra });
const listBody = (photos: unknown[]) => ({ contractVersion: "offer-photos/v1", photos });

interface Seen { url: string; method: string; body: unknown; credentials: string | undefined }

function harness(respond: (seen: Seen) => Response, upload?: (input: UploadTransportInput) => Promise<{ status: number; json: unknown }>) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials };
    calls.push(seen);
    return respond(seen);
  }) as unknown as typeof fetch;
  return { client: createPhotosClient({ fetch: fetchStub, ...(upload ? { upload } : {}) }), calls };
}

describe("bornes et adresses", () => {
  test("les bornes du client sont celles du serveur", () => {
    assert.equal(PHOTO_MAX_BYTES, SERVER_MAX_BYTES);
    assert.equal(PHOTO_MAX_PER_OFFER, SERVER_MAX_PER_OFFER);
    assert.equal(PHOTO_REFS_MAX, SERVER_MAX_PER_OFFER);
    assert.equal(PHOTO_MIN_SIDE, SERVER_MIN_SIDE);
    assert.deepEqual([...PHOTO_ACCEPTED_TYPES], ["image/jpeg", "image/png", "image/webp"]);
  });

  test("mediaUrl : seulement pour un UUID (aucune adresse construite à la main) ; les couvertures non UUID sont ignorées", () => {
    assert.equal(mediaUrl(PHOTO_A), `/api/media/${PHOTO_A}`);
    assert.equal(mediaUrl(PHOTO_A.toUpperCase()), `/api/media/${PHOTO_A}`);
    for (const bad of ["", "../../etc/passwd", `${PHOTO_A}/../x`, "javascript:alert(1)", "https://evil.example/x.png", null, undefined, 12]) assert.equal(mediaUrl(bad as string), null, String(bad));
    assert.equal(parseCoverPhotoId(PHOTO_A), PHOTO_A);
    for (const bad of ["x", "", null, undefined, 3, {}, `${PHOTO_A}x`]) assert.equal(parseCoverPhotoId(bad), null);
  });

  test("références de galerie : identifiant et dimensions seulement, entrées invalides ignorées, six au plus", () => {
    const refs = parsePhotoRefs([
      { id: PHOTO_A, width: 300, height: 200, sha256: "secret", offerId: "x" },
      { id: "pas-un-uuid", width: 300, height: 200 }, { id: PHOTO_B, width: 0, height: 200 }, { id: PHOTO_B, width: "300", height: 200 }, null,
      { id: PHOTO_B, width: 640, height: 480 }, 4, [],
    ]);
    assert.deepEqual(refs, [{ id: PHOTO_A, width: 300, height: 200 }, { id: PHOTO_B, width: 640, height: 480 }]);
    assert.deepEqual(parsePhotoRefs("pas une liste"), []);
    const many = Array.from({ length: 9 }, (_, index) => ({ id: `${index}a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e`, width: 300, height: 200 }));
    assert.equal(parsePhotoRefs(many).length, 6, "six au plus : le travail est borné quoi que le serveur envoie");
  });
});

describe("client des photos du propriétaire", () => {
  test("liste : GET exact, même origine, photos relues champ par champ (jamais un champ de plus)", async () => {
    const { client, calls } = harness(() => json(200, listBody([photo(PHOTO_A, 0, { sha256: "secret", offerId: OFFER })])));
    const photos = await client.list(OFFER);
    assert.deepEqual(photos, [{ id: PHOTO_A, position: 0, mime: "image/png", width: 300, height: 200, bytes: 1_234 }]);
    assert.deepEqual(calls.map((call) => [call.method, call.url, call.credentials]), [["GET", `/api/offers/${OFFER}/photos`, "same-origin"]]);
  });

  test("réponses invalides refusées (invalid_response) : mauvaise version, type inconnu, position 6, dimensions ou poids absurdes, plus de six photos, liste absente", async () => {
    const bads: unknown[] = [
      { contractVersion: "autre/v9", photos: [] }, listBody([photo(PHOTO_A, 0, { mime: "image/gif" })]), listBody([photo(PHOTO_A, 6)]), listBody([photo(PHOTO_A, -1)]),
      listBody([photo(PHOTO_A, 0, { width: 0 })]), listBody([photo(PHOTO_A, 0, { bytes: PHOTO_MAX_BYTES + 1 })]), listBody([photo("pas-un-uuid", 0)]),
      listBody(Array.from({ length: 7 }, (_, index) => photo(`${index}a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e`, index % 6))), { contractVersion: "offer-photos/v1" }, "texte", null,
    ];
    for (const body of bads) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.list(OFFER), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, JSON.stringify(body)?.slice(0, 60));
    }
  });

  test("identifiants vérifiés AVANT toute requête (invalid_id) ; aucune adresse n'est construite à la main", async () => {
    const { client, calls } = harness(() => json(200, listBody([])));
    for (const attempt of [() => client.list("../x"), () => client.reorder(OFFER, ["pas-un-uuid"]), () => client.remove(OFFER, "../../etc"), () => client.remove("x", PHOTO_A), () => client.upload("x", new Blob([new Uint8Array(3)]))]) {
      await assert.rejects(attempt(), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    }
    assert.equal(calls.length, 0);
  });

  test("tri : PUT { order } ; suppression : DELETE ; les deux relisent la liste", async () => {
    const { client, calls } = harness((seen) => (seen.method === "DELETE" ? json(200, { ...listBody([photo(PHOTO_B, 0)]), removed: true }) : json(200, listBody([photo(PHOTO_B, 0), photo(PHOTO_A, 1)]))));
    assert.deepEqual((await client.reorder(OFFER, [PHOTO_B, PHOTO_A])).map((entry) => entry.id), [PHOTO_B, PHOTO_A]);
    const removed = await client.remove(OFFER, PHOTO_A);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.photos.map((entry) => entry.id), [PHOTO_B]);
    assert.deepEqual(calls.map((call) => [call.method, call.url, call.body]), [
      ["PUT", `/api/offers/${OFFER}/photos`, { order: [PHOTO_B, PHOTO_A] }],
      ["DELETE", `/api/offers/${OFFER}/photos/${PHOTO_A}`, undefined],
    ]);
    const bad = harness(() => json(200, listBody([])));
    await assert.rejects(bad.client.remove(OFFER, PHOTO_A), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, "removed absent");
  });

  test("envoi : le fichier part tel quel (aucune enveloppe, aucun nom) ; progression transmise ; réponse relue ; un rejeu est created: false", async () => {
    const seen: UploadTransportInput[] = [];
    const { client } = harness(() => json(200, {}), async (input) => {
      seen.push(input);
      input.onProgress?.(0.5);
      input.onProgress?.(1);
      return { status: 201, json: { contractVersion: "offer-photos/v1", created: true, photo: photo(PHOTO_A, 0), photos: [photo(PHOTO_A, 0)] } };
    });
    const progress: number[] = [];
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const result = await client.upload(OFFER, file, { onProgress: (fraction) => progress.push(fraction) });
    assert.deepEqual([result.created, result.photo.id, result.photos.length], [true, PHOTO_A, 1]);
    assert.deepEqual(progress, [0.5, 1]);
    assert.equal(seen[0].url, `/api/offers/${OFFER}/photos`);
    assert.equal(seen[0].body, file, "le corps est le fichier lui-même");
    const replay = harness(() => json(200, {}), async () => ({ status: 200, json: { contractVersion: "offer-photos/v1", created: false, photo: photo(PHOTO_A, 0), photos: [photo(PHOTO_A, 0)] } }));
    assert.equal((await replay.client.upload(OFFER, file)).created, false);
  });

  test("envoi refusé : l'erreur vient du corps du serveur (code), jamais du texte d'une exception ; réponse sans corps ou illisible : invalid_response", async () => {
    const refusal = harness(() => json(200, {}), async () => ({ status: 415, json: { error: { code: "unsupported_type", message: "texte du serveur" } } }));
    await assert.rejects(refusal.client.upload(OFFER, new Blob([new Uint8Array(1)])), (error: unknown) => error instanceof ApiError && error.status === 415 && error.code === "unsupported_type");
    const broken = harness(() => json(200, {}), async () => ({ status: 500, json: undefined }));
    await assert.rejects(broken.client.upload(OFFER, new Blob([new Uint8Array(1)])), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    const wrong = harness(() => json(200, {}), async () => ({ status: 201, json: { contractVersion: "offer-photos/v1", created: "oui", photo: photo(PHOTO_A, 0), photos: [] } }));
    await assert.rejects(wrong.client.upload(OFFER, new Blob([new Uint8Array(1)])), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
  });
});

describe("messages d'erreur en mots simples", () => {
  const error = (status: number, code: string) => new ApiError(status, code, "TEXTE BRUT DU SERVEUR : ne doit jamais être montré");

  test("un message fixe par refus du serveur ; le texte du serveur n'est jamais repris", () => {
    for (const [status, code] of [[413, "file_too_large"], [415, "unsupported_type"], [422, "corrupt"], [422, "truncated"], [422, "too_small"], [422, "too_large_dimensions"], [422, "too_many_pixels"], [422, "animated"], [408, "request_timeout"], [409, "photo_limit"], [429, "rate_limited"], [409, "resource_archived"], [404, "resource_not_found"], [400, "invalid_request"]] as const) {
      const message = describePhotoError(error(status, code));
      assert.equal(message, PHOTO_ERROR_MESSAGES[code], code);
      assert.ok(!message.includes("TEXTE BRUT"), code);
      assert.ok(!/[a-z]+_[a-z_]+/.test(message), `jamais le code brut : ${message}`);
    }
    assert.match(PHOTO_ERROR_MESSAGES.unsupported_type, /JPEG, PNG ou WebP/);
    assert.match(PHOTO_ERROR_MESSAGES.file_too_large, /5 Mo/);
    assert.match(PHOTO_ERROR_MESSAGES.too_small, /200 pixels/);
    assert.match(PHOTO_ERROR_MESSAGES.too_large_dimensions, /4 100 pixels au plus de chaque côté\. Choisissez une photo plus petite ou réduisez-la\./);
    assert.match(PHOTO_ERROR_MESSAGES.too_many_pixels, /12,5 millions de pixels au plus \(par exemple 4 000 × 3 000\)\. Choisissez une photo plus petite ou réduisez-la\./);
    assert.doesNotMatch(Object.values(PHOTO_ERROR_MESSAGES).join(" "), /8 000|40 mégapixels/, "plus de trace des anciennes bornes");
    assert.match(PHOTO_ERROR_MESSAGES.request_timeout, /a pris trop de temps : vérifiez votre connexion/);
    assert.match(PHOTO_ERROR_MESSAGES.photo_limit, /6 photos/);
  });

  test("code inconnu, panne réseau, session expirée et exception quelconque : messages généraux fixes", () => {
    assert.equal(describePhotoError(error(500, "boom")), describeApiError(error(500, "boom"), "catalog"));
    assert.equal(describePhotoError(error(401, "authentication_required")), "Votre session a expiré. Reconnectez-vous pour continuer.");
    assert.equal(describePhotoError(new ApiError(0, "network_error", "x")), "Connexion impossible. Vérifiez votre réseau et réessayez.");
    assert.equal(describePhotoError(new Error("TypeError: fetch failed http://10.0.0.1:3000")), "Une erreur est survenue. Réessayez dans un instant.");
    assert.equal(describePhotoError(error(200, "photo_limit")), describeApiError(error(200, "photo_limit"), "catalog"), "un statut incohérent avec le code n'ouvre pas le message précis");
  });
});

describe("relecture des couvertures et galeries par les autres clients", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    candidateId: OFFER, candidateContentVersion: 2,
    candidate: { id: OFFER, contentVersion: 2, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: null, unit: null, location: "Abidjan", deadlineAt: null, price: { amount: 150000, currency: "XOF" }, availabilityStatus: "available" },
    compatibilityStatus: "compatible", score: 92.4, coverage: 1,
    evaluation: { status: "compatible", summary: { matchedCount: 3, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 3 } },
    scoring: { score: 92.4, coverage: 1, summary: {}, preferences: {} }, evaluatedAt: "2031-01-01T10:00:00.000Z",
    indicators: { availability: null, price: null, confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: [] } },
    relevance: 88.5, sponsored: false, ...extra,
  });
  const api = (body: unknown) => createApiClient({ fetch: (async () => json(200, body)) as unknown as typeof fetch });
  const detail = (item_: unknown, details: Record<string, unknown> = {}) => ({ contractVersion: "demand-offer/v1", item: item_, details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [], ...details }, readAt: "2031-01-01T10:00:05.000Z" });

  test("fiche : galerie relue (identifiant et dimensions), absente sans photo ; couverture de l'élément seulement si UUID", async () => {
    const without = await api(detail(item())).demands.offer("22222222-2222-4222-8222-222222222222", OFFER);
    assert.ok(!("photos" in without.details), "sans photo : pas de clé");
    assert.ok(!("coverPhotoId" in without.item));
    const withPhotos = await api(detail(item({ coverPhotoId: PHOTO_A }), { photos: [{ id: PHOTO_A, width: 300, height: 200, sha256: "x" }, { id: "n'importe quoi", width: 1, height: 1 }, { id: PHOTO_B, width: 640, height: 480 }] })).demands.offer("22222222-2222-4222-8222-222222222222", OFFER);
    assert.deepEqual(withPhotos.details.photos, [{ id: PHOTO_A, width: 300, height: 200 }, { id: PHOTO_B, width: 640, height: 480 }]);
    assert.equal(withPhotos.item.coverPhotoId, PHOTO_A);
    const hostile = await api(detail(item({ coverPhotoId: "../../etc/passwd" }), { photos: "x" })).demands.offer("22222222-2222-4222-8222-222222222222", OFFER);
    assert.ok(!("coverPhotoId" in hostile.item), "une couverture qui n'est pas un UUID est ignorée");
    assert.ok(!("photos" in hostile.details));
  });

  test("tableau de bord du vendeur : couverture relue (UUID seulement), absente sinon", async () => {
    const offer = (extra: Record<string, unknown> = {}) => ({ id: OFFER, title: "iPhone 12", status: "published", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, price: { amount: 150000, currency: "XOF" }, needs: { kind: "below", bound: 5 }, boostEndsAt: null, ...extra });
    const home = (offers: unknown[]) => ({ contractVersion: "home-vendor/v1", counts: { published: 1, paused: 0, draft: 0 }, needs: { kind: "below", bound: 5 }, balance: 0, currency: "XOF", activeBoosts: [], offers, readAt: "2031-01-01T10:00:00.000Z" });
    const loaded = await api(home([offer({ coverPhotoId: PHOTO_A }), offer(), offer({ coverPhotoId: "pas-un-uuid" })])).home.vendor();
    assert.equal(loaded.offers[0].coverPhotoId, PHOTO_A);
    assert.ok(!("coverPhotoId" in loaded.offers[1]));
    assert.ok(!("coverPhotoId" in loaded.offers[2]));
  });

  test("favoris : couverture relue (UUID seulement), absente sinon", async () => {
    const favorite = (extra: Record<string, unknown> = {}) => ({ offerId: OFFER, demandId: PHOTO_B, title: "Apple iPhone 12", price: null, available: true, openable: true, createdAt: "2031-01-01T10:00:00.000Z", ...extra });
    const social = createSocialClient({ fetch: (async () => json(200, { contractVersion: "favorites/v1", items: [favorite({ coverPhotoId: PHOTO_A }), favorite(), favorite({ coverPhotoId: 12 })] })) as unknown as typeof fetch });
    const items = await social.favorites.list();
    assert.equal(items[0].coverPhotoId, PHOTO_A);
    assert.ok(!("coverPhotoId" in items[1]) && !("coverPhotoId" in items[2]));
  });
});
