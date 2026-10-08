import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { PHOTO_MAX_BYTES } from "../../lib/client/photos-api";
import { addPicked, removePicked, uploadPicked, type PickedFile, type PickedPhoto } from "../../lib/client/photos-queue";

/** File d'envoi des photos du formulaire (lot PH1) : contrôle à l'ajout, limite de 6, envoi un à un, progression, erreurs en mots simples, arrêt à la session expirée. */

const pick = (name: string, size = 1_000, type = "image/png"): PickedFile => Object.assign(new Blob([new Uint8Array(Math.min(size, 16))], { type }), { name });
const sized = (name: string, size: number, type = "image/png"): PickedFile => {
  const file = pick(name, 1, type);
  Object.defineProperty(file, "size", { value: size });
  return file;
};
const preview = (file: PickedFile): string | null => `blob:test/${file.name}`;

describe("ajout", () => {
  test("les fichiers valides entrent dans la file avec leur aperçu ; les autres sont refusés avec leur raison, sans bloquer les suivants", () => {
    const { items, rejected } = addPicked([], [pick("a.png"), sized("lourde.png", PHOTO_MAX_BYTES + 1), pick("b.gif", 100, "image/gif"), pick("c.jpg", 100, "image/jpeg")], preview);
    assert.deepEqual(items.map((item) => [item.file.name, item.status, item.previewUrl]), [["a.png", "ready", "blob:test/a.png"], ["c.jpg", "ready", "blob:test/c.jpg"]]);
    assert.deepEqual(rejected, ["Cette photo est trop lourde : 5 Mo au plus.", "Ce format n'est pas accepté : choisissez une photo JPEG, PNG ou WebP."]);
    assert.equal(new Set(items.map((item) => item.key)).size, 2, "clés distinctes");
  });

  test("six photos au plus (avec celles déjà enregistrées) : le reste est refusé, la phrase de la limite n'est dite qu'une fois", () => {
    const many = Array.from({ length: 9 }, (_, index) => pick(`p${index}.png`));
    const fresh = addPicked([], many, preview);
    assert.equal(fresh.items.length, 6);
    assert.deepEqual(fresh.rejected, ["Vous avez déjà 6 photos : supprimez-en une pour en ajouter."]);
    const withExisting = addPicked([], many, preview, 4);
    assert.equal(withExisting.items.length, 2);
    assert.equal(addPicked([], [pick("x.png")], preview, 6).items.length, 0);
    assert.equal(addPicked(fresh.items, [pick("y.png")], preview).items.length, 6, "la file pleine ne grossit pas");
  });

  test("retrait : par clé, sans toucher aux autres", () => {
    const { items } = addPicked([], [pick("a.png"), pick("b.png"), pick("c.png")], preview);
    assert.deepEqual(removePicked(items, items[1].key).map((item) => item.file.name), ["a.png", "c.png"]);
    assert.equal(removePicked(items, "inconnue").length, 3);
  });
});

describe("envoi", () => {
  const queue = (names: string[]): PickedPhoto[] => addPicked([], names.map((name) => pick(name)), preview).items;

  test("un à un, dans l'ordre ; progression et statuts à chaque étape ; résumé exact", async () => {
    const items = queue(["a.png", "b.png", "c.png"]);
    const order: string[] = [];
    const snapshots: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const client = {
      async upload(_offer: string, file: Blob, options: { onProgress?: (fraction: number) => void } = {}) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push((file as PickedFile).name);
        options.onProgress?.(0.5);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        return { created: true, photo: {} as never, photos: [] };
      },
    };
    const summary = await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", items, client, (next) => snapshots.push(next.map((item) => `${item.file.name}:${item.status}:${item.progress}`).join(" ")));
    assert.deepEqual(order, ["a.png", "b.png", "c.png"]);
    assert.equal(maxRunning, 1, "jamais deux envois à la fois");
    assert.deepEqual(summary, { uploaded: 3, failed: 0, unauthorized: false });
    assert.equal(snapshots.at(-1), "a.png:done:1 b.png:done:1 c.png:done:1");
    assert.ok(snapshots.some((line) => line.startsWith("a.png:uploading:0.5 b.png:ready:0")));
  });

  test("une photo refusée n'arrête pas les autres : son erreur est en mots simples ; une relance renvoie seulement celles qui ont échoué", async () => {
    const items = queue(["a.png", "b.png", "c.png"]);
    let final: PickedPhoto[] = [];
    const attempts: string[] = [];
    const client = {
      async upload(_offer: string, file: Blob) {
        const name = (file as PickedFile).name;
        attempts.push(name);
        if (name === "b.png") throw new ApiError(422, "too_small", "TEXTE BRUT");
        return { created: true, photo: {} as never, photos: [] };
      },
    };
    const first = await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", items, client, (next) => { final = next; });
    assert.deepEqual(first, { uploaded: 2, failed: 1, unauthorized: false });
    assert.deepEqual(final.map((item) => item.status), ["done", "failed", "done"]);
    assert.equal(final[1].error, "Cette photo est trop petite : 200 pixels au moins de chaque côté.");
    assert.ok(!JSON.stringify(final).includes("TEXTE BRUT"));
    attempts.length = 0;
    await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", final, client, (next) => { final = next; });
    assert.deepEqual(attempts, ["b.png"], "relance : seulement la photo en échec");
  });

  test("session expirée (401) : arrêt net, signalé ; refus « 6 photos » : arrêt (les suivantes seraient refusées pareil)", async () => {
    const make = (error: ApiError) => ({ async upload(): Promise<never> { throw error; } });
    const expired = await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", queue(["a.png", "b.png"]), make(new ApiError(401, "authentication_required", "x")), () => {});
    assert.deepEqual(expired, { uploaded: 0, failed: 1, unauthorized: true });
    const full = await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", queue(["a.png", "b.png"]), make(new ApiError(409, "photo_limit", "x")), () => {});
    assert.deepEqual(full, { uploaded: 0, failed: 1, unauthorized: false });
  });

  test("abandon : plus aucun envoi après le signal", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const client = {
      async upload(_offer: string, file: Blob) {
        seen.push((file as PickedFile).name);
        controller.abort();
        return { created: true, photo: {} as never, photos: [] };
      },
    };
    await uploadPicked("6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c", queue(["a.png", "b.png", "c.png"]), client, () => {}, controller.signal);
    assert.deepEqual(seen, ["a.png"]);
  });
});
