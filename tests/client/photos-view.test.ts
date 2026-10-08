import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PHONE_REMINDER, checkLocalPhoto, galleryAlt, moveItem, orderOf, orderWithCoverFirst, photoCountText, progressPercent, remainingSlots,
} from "../../lib/client/photos-view";
import { PHOTO_MAX_BYTES, type OfferPhoto } from "../../lib/client/photos-api";

/** Présentation des photos (lot PH1) : contrôles rapides avant l'envoi, ordre et couverture, textes en mots simples. */

describe("rappel au vendeur", () => {
  test("le texte demandé, mot pour mot", () => {
    assert.equal(PHONE_REMINDER, "N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma.");
  });
});

describe("contrôle rapide d'un fichier choisi", () => {
  const file = (name: string, size: number, type: string) => ({ name, size, type });

  test("JPEG, PNG et WebP passent (type annoncé, ou extension quand le type est vide)", () => {
    for (const [name, type] of [["a.jpg", "image/jpeg"], ["a.png", "image/png"], ["a.webp", "image/webp"], ["A.JPEG", ""], ["photo.PNG", ""], ["x.webp", " IMAGE/WEBP "]] as const) {
      assert.equal(checkLocalPhoto(file(name, 1_000, type)), null, `${name} ${type}`);
    }
  });

  test("vide, trop lourd, format refusé : une phrase simple ; la limite de 5 Mo est exacte", () => {
    assert.equal(checkLocalPhoto(file("a.png", 0, "image/png")), "Ce fichier est vide.");
    assert.equal(checkLocalPhoto(file("a.png", PHOTO_MAX_BYTES, "image/png")), null);
    assert.equal(checkLocalPhoto(file("a.png", PHOTO_MAX_BYTES + 1, "image/png")), "Cette photo est trop lourde : 5 Mo au plus.");
    for (const [name, type] of [["a.gif", "image/gif"], ["a.svg", "image/svg+xml"], ["a.heic", "image/heic"], ["a.pdf", "application/pdf"], ["a", ""], ["a.txt", "text/plain"], ["a.png.exe", ""]] as const) {
      assert.equal(checkLocalPhoto(file(name, 1_000, type)), "Ce format n'est pas accepté : choisissez une photo JPEG, PNG ou WebP.", `${name} ${type}`);
    }
  });
});

describe("ordre, couverture, compteurs", () => {
  test("moveItem et orderWithCoverFirst : déplacements, bornes, identifiant inconnu", () => {
    assert.deepEqual(moveItem(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
    for (const [from, to] of [[-1, 0], [0, 3], [5, 0], [0.5, 1], [Number.NaN, 0]]) assert.deepEqual(moveItem(["a", "b", "c"], from, to), ["a", "b", "c"]);
    const original = ["a", "b", "c"];
    moveItem(original, 2, 0);
    assert.deepEqual(original, ["a", "b", "c"], "la liste d'origine n'est pas modifiée");
    assert.deepEqual(orderWithCoverFirst(["a", "b", "c"], "c"), ["c", "a", "b"]);
    assert.deepEqual(orderWithCoverFirst(["a", "b", "c"], "a"), ["a", "b", "c"]);
    assert.deepEqual(orderWithCoverFirst(["a", "b", "c"], "z"), ["a", "b", "c"]);
  });

  test("orderOf suit les positions, pas l'ordre reçu", () => {
    const photo = (id: string, position: number): OfferPhoto => ({ id, position, mime: "image/png", width: 300, height: 200, bytes: 100 });
    assert.deepEqual(orderOf([photo("c", 2), photo("a", 0), photo("b", 1)]), ["a", "b", "c"]);
  });

  test("« n photos sur 6 », places restantes, texte alternatif, pourcentage borné", () => {
    assert.equal(photoCountText(0), "0 photo sur 6");
    assert.equal(photoCountText(1), "1 photo sur 6");
    assert.equal(photoCountText(2), "2 photos sur 6");
    assert.deepEqual([0, 5, 6, 9].map(remainingSlots), [6, 1, 0, 0]);
    assert.equal(galleryAlt("iPhone 12", 0, 3), "iPhone 12 : photo 1 sur 3");
    assert.equal(galleryAlt("iPhone 12", 0, 1), "iPhone 12 : photo");
    assert.deepEqual([-1, 0, 0.456, 1, 7, Number.NaN].map(progressPercent), [0, 0, 46, 100, 100, 0]);
  });
});
