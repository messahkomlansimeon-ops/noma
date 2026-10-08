import assert from "node:assert/strict";
import { test } from "node:test";
import { OTP_TTL_MS } from "../../lib/server/auth/config";
import {
  GSM7_BASIC_TABLE,
  GSM7_EXTENSION_CHARACTERS,
  SMS_GSM7_LIMIT,
  SMS_UCS2_LIMIT,
  analyzeSms,
  gsm7Length,
  isSingleSegmentSms,
} from "../../lib/server/sms/gsm7";
import { notificationMessage, otpMessage, SMOKE_MESSAGE } from "../../lib/server/sms/messages";
import {
  IDEMPOTENCY_KEY_FORMAT,
  SmsLocalValidationError,
  assertSendable,
  isAllowedRecipient,
  isValidIdempotencyKey,
  lastTwoDigits,
  localRefusal,
  maskRecipient,
} from "../../lib/server/sms/validation";

const VALID = { to: "+2250700000012", content: "noma : essai", idempotencyKey: "otp-12345678" };

test("table GSM-7 : 128 positions, échappement exclu, ç minuscule absent, Ç majuscule présent", () => {
  assert.equal(GSM7_BASIC_TABLE.length, 128);
  assert.equal(GSM7_BASIC_TABLE[0x00], "@");
  assert.equal(GSM7_BASIC_TABLE[0x09], "Ç");
  assert.equal(GSM7_BASIC_TABLE[0x0a], "\n");
  assert.equal(GSM7_BASIC_TABLE[0x1b], "\u001b");
  assert.equal(GSM7_BASIC_TABLE[0x7f], "à");
  assert.equal(GSM7_BASIC_TABLE.includes("ç"), false);
  assert.equal(new Set(GSM7_BASIC_TABLE).size, 128, "aucune position en double");
  assert.deepEqual([...GSM7_EXTENSION_CHARACTERS].sort(), ["\f", "\\", "^", "[", "]", "{", "|", "}", "~", "€"].sort());
});

test("segments GSM-7 : 160 septets passent, 161 ne passent pas", () => {
  assert.equal(analyzeSms("a".repeat(160)).singleSegment, true);
  assert.equal(analyzeSms("a".repeat(160)).encoding, "gsm7");
  assert.equal(analyzeSms("a".repeat(161)).singleSegment, false);
  assert.equal(analyzeSms("a".repeat(161)).units, 161);
  assert.equal(isSingleSegmentSms("a".repeat(160)), true);
  assert.equal(isSingleSegmentSms("a".repeat(161)), false);
  assert.equal(SMS_GSM7_LIMIT, 160);
});

test("caractères étendus : chacun compte 2 septets (^ { } \\ [ ] ~ | € et saut de page)", () => {
  for (const character of GSM7_EXTENSION_CHARACTERS) {
    assert.equal(gsm7Length(character), 2, JSON.stringify(character));
    assert.equal(analyzeSms(character.repeat(80)).units, 160);
    assert.equal(analyzeSms(character.repeat(80)).singleSegment, true, `80 × ${JSON.stringify(character)} = 160 septets`);
    assert.equal(analyzeSms(character.repeat(81)).singleSegment, false, `81 × ${JSON.stringify(character)} = 162 septets`);
  }
  assert.equal(analyzeSms("a".repeat(159) + "€").units, 161);
  assert.equal(analyzeSms("a".repeat(159) + "€").singleSegment, false, "159 + un caractère étendu = 161 septets");
  assert.equal(analyzeSms("a".repeat(158) + "€").singleSegment, true, "158 + 2 = 160 septets");
});

test("UCS-2 : 70 unités UTF-16 passent, 71 ne passent pas ; emoji = 2 unités", () => {
  const ucs2 = (length: number) => "â".repeat(length);
  assert.equal(analyzeSms(ucs2(70)).encoding, "ucs2");
  assert.equal(analyzeSms(ucs2(70)).singleSegment, true);
  assert.equal(analyzeSms(ucs2(71)).singleSegment, false);
  assert.equal(analyzeSms(ucs2(71)).units, 71);
  assert.equal(SMS_UCS2_LIMIT, 70);
  assert.equal(analyzeSms("😀").units, 2);
  assert.equal(analyzeSms("😀".repeat(35)).singleSegment, true);
  assert.equal(analyzeSms("😀".repeat(36)).singleSegment, false);
  assert.equal(analyzeSms("a".repeat(100) + "😀").encoding, "ucs2", "un seul emoji fait basculer tout le texte en UCS-2");
  assert.equal(analyzeSms("a".repeat(100) + "😀").singleSegment, false);
});

test("accents français : é è à ù ì ò et Ç sont GSM-7 ; ç minuscule, â ê î ô û œ ne le sont pas", () => {
  for (const character of ["é", "è", "à", "ù", "ì", "ò", "É", "Ç", "ä", "ö", "ñ", "ü"]) assert.equal(analyzeSms(character).encoding, "gsm7", character);
  for (const character of ["ç", "â", "ê", "î", "ô", "û", "œ", "À", "È", "Ê"]) assert.equal(analyzeSms(character).encoding, "ucs2", character);
  // Conséquence : un texte de 100 caractères avec « ç » dépasse la limite UCS-2.
  assert.equal(analyzeSms("a".repeat(99) + "ç").singleSegment, false);
});

test("texte vide, caractère nul ou non-chaîne : jamais un segment valide", () => {
  assert.equal(analyzeSms("").singleSegment, false);
  assert.equal(isSingleSegmentSms(""), false);
  assert.equal(isSingleSegmentSms("a\u0000b"), false);
  assert.equal(isSingleSegmentSms(undefined), false);
  assert.equal(isSingleSegmentSms(12), false);
});

test("pays : seul +225 suivi de 10 chiffres est accepté", () => {
  assert.equal(isAllowedRecipient("+2250700000012"), true);
  for (const bad of ["+33612345678", "+2250700000", "+22507000000123", "2250700000012", "+225 07 00 00 00 12", "+225070000001a", "0700000012", "+1234567890123", "", "+225", 225, null, undefined]) {
    assert.equal(isAllowedRecipient(bad), false, String(bad));
  }
  assert.equal(localRefusal({ ...VALID, to: "+33612345678" }), "invalid_recipient");
});

test("clé d'idempotence : 8 à 64 caractères parmi A-Za-z0-9._-", () => {
  for (const good of ["12345678", "otp-3f2504e0-4f89-41d3-9a0c-0305e82c3301", "notif-0123456789abcdef0123456789abcdef", "a.b_c-D9", "x".repeat(64)]) assert.equal(isValidIdempotencyKey(good), true, good);
  for (const bad of ["1234567", "x".repeat(65), "avec espace", "a/b/c/d/e/f", "é".repeat(10), "", "otp:12345678", 12345678, undefined]) assert.equal(isValidIdempotencyKey(bad), false, String(bad));
  assert.equal(IDEMPOTENCY_KEY_FORMAT.test("12345678"), true);
  assert.equal(localRefusal({ ...VALID, idempotencyKey: "court" }), "invalid_key");
});

test("refus local : ordre destinataire, texte, clé ; assertSendable lève un code stable sans la valeur", () => {
  assert.equal(localRefusal(VALID), null);
  assert.equal(localRefusal({ ...VALID, content: "a".repeat(161) }), "invalid_content");
  assert.equal(localRefusal({ to: "+33600000000", content: "a".repeat(161), idempotencyKey: "x" }), "invalid_recipient");
  assert.doesNotThrow(() => assertSendable(VALID));
  assert.throws(() => assertSendable({ ...VALID, to: "+33612345678" }), (error: unknown) => {
    assert.ok(error instanceof SmsLocalValidationError);
    assert.equal(error.code, "invalid_recipient");
    assert.equal(error.message.includes("33612345678"), false);
    return true;
  });
});

test("numéro masqué : seuls les deux derniers chiffres", () => {
  assert.equal(lastTwoDigits("+2250700000012"), "12");
  assert.equal(maskRecipient("+2250700000012"), "+***********12");
  assert.equal(maskRecipient("+2250700000012").includes("0700"), false);
});

test("textes : un seul segment GSM-7, avec la durée réelle du code", () => {
  const otp = otpMessage("123456");
  assert.equal(otp, "noma : votre code est 123456. Il expire dans 5 min. Ne le partagez pas.");
  assert.equal(OTP_TTL_MS, 5 * 60_000, "le texte annonce la durée de OTP_TTL_MS");
  assert.equal(analyzeSms(otp).encoding, "gsm7");
  assert.equal(analyzeSms(otp).singleSegment, true);
  assert.equal(otpMessage("123456", 10 * 60_000).includes("10 min"), true);
  const link = "https://noma.example.ci/notifications";
  assert.equal(notificationMessage(3, link), "noma : 3 nouvelles annonces pour vos besoins. https://noma.example.ci/notifications");
  assert.equal(notificationMessage(1, link), "noma : 1 nouvelle annonce pour vos besoins. https://noma.example.ci/notifications");
  for (const count of [1, 2, 99, 5_000]) {
    const message = notificationMessage(count, link);
    assert.equal(isSingleSegmentSms(message), true, message);
    assert.equal(analyzeSms(message).encoding, "gsm7");
  }
  assert.equal(isSingleSegmentSms(SMOKE_MESSAGE), true);
  assert.equal(analyzeSms(SMOKE_MESSAGE).encoding, "gsm7");
});
