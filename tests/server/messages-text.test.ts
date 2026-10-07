import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_MAX_LENGTH, SAFETY_REMINDER, checkMessageBody, countCharacters, normalizeMessageBody } from "../../lib/messages-text";

/** Texte d'un message (lot D2) : normalisé, 1 à 1000 caractères, aucun caractère de contrôle ni de direction ; le téléphone n'est pas bloqué ; aucun HTML interprété. */

test("normalisation : NFKC, espaces et sauts de ligne ramenés à un espace, texte rogné", () => {
  assert.equal(normalizeMessageBody("  a \t b\r\n\r\nc  "), "a b c");
  assert.equal(normalizeMessageBody("ＡＢＣ １２３"), "ABC 123", "NFKC : pleine chasse ramenée à la forme usuelle");
  assert.equal(normalizeMessageBody(" texte "), "texte", "l'espace insécable est rogné");
});

test("longueur : 1 à 1000 caractères APRÈS normalisation (points de code, pas unités UTF-16)", () => {
  assert.deepEqual(checkMessageBody(""), { ok: false, reason: "empty" });
  assert.deepEqual(checkMessageBody(" \n\t "), { ok: false, reason: "empty" });
  assert.deepEqual(checkMessageBody("a"), { ok: true, body: "a" });
  assert.deepEqual(checkMessageBody("a".repeat(MESSAGE_MAX_LENGTH)), { ok: true, body: "a".repeat(MESSAGE_MAX_LENGTH) });
  assert.deepEqual(checkMessageBody("a".repeat(MESSAGE_MAX_LENGTH + 1)), { ok: false, reason: "too_long" });
  // 1000 émojis (2 unités UTF-16 chacun) passent ; 1001 non.
  assert.equal(checkMessageBody("😀".repeat(1000)).ok, true);
  assert.deepEqual(checkMessageBody("😀".repeat(1001)), { ok: false, reason: "too_long" });
  // La normalisation compte : 1000 caractères + des espaces qui s'effondrent passent.
  assert.equal(checkMessageBody(`${"b".repeat(1000)}      `).ok, true);
  assert.equal(countCharacters("é😀a"), 3);
});

test("refusés : caractères de contrôle, de direction de texte et invisibles, avant comme après normalisation ; non-texte", () => {
  for (const value of ["a\u0007b", "a\u0000b", "a\u007fb", "a‮b", "a⁦b", "a​b", "a‏b", "a﻿b", " ", "a\u0085b", "a­b"]) {
    assert.deepEqual(checkMessageBody(value), { ok: false, reason: "unsafe" }, JSON.stringify(value));
  }
  for (const value of [42, null, undefined, {}, [], true]) assert.deepEqual(checkMessageBody(value), { ok: false, reason: "not_text" });
});

test("aucun HTML n'est interprété ni retiré : le texte est conservé tel quel ; un numéro de téléphone n'est PAS bloqué", () => {
  const html = `<img src=x onerror="alert(1)"> <b>gras</b> &amp;`;
  assert.deepEqual(checkMessageBody(html), { ok: true, body: html });
  const phone = "Mon numéro : 07 08 09 10 11, ou +225 05 44 33 22 11";
  assert.deepEqual(checkMessageBody(phone), { ok: true, body: phone });
});

test("le rappel de sécurité est le texte demandé", () => {
  assert.equal(SAFETY_REMINDER, "Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet.");
});
