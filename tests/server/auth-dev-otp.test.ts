import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEV_OTP_FLAG,
  DEV_OTP_REFUSED_WARNING,
  createDevOtpResolver,
  createDevOtpTransport,
  isDevOtpConsoleEnabled,
  maskPhoneForLog,
  resolveDevOtpTransport,
} from "../../lib/server/auth/dev-otp-transport";
import { defaultAuthHttpDependencies } from "../../lib/server/auth/http";

const SEND_INPUT = {
  phone: "+2250707070712",
  code: "123456",
  challengeId: "0b6f3a52-6d6e-4b9f-9a35-6f2f6d9b8c11",
  expiresAt: new Date("2031-01-01T10:05:09.456Z"),
};

describe("masque du téléphone dans le journal du transport de développement", () => {
  test("seuls les deux derniers chiffres restent lisibles", () => {
    assert.equal(maskPhoneForLog("+2250707070712"), "+***********12");
    assert.equal(maskPhoneForLog("+22507123412"), "+*********12");
    assert.equal(maskPhoneForLog("+12025550142"), "+*********42");
  });

  test("aucun autre chiffre du numéro d'origine n'est repris, quelle que soit la longueur", () => {
    for (const phone of ["+12", "+123", "+2250707070712", "+123456789012345"]) {
      const masked = maskPhoneForLog(phone);
      const digits = phone.slice(1);
      assert.match(masked, /^\+\**[0-9]{0,2}$/, phone);
      assert.equal(masked.length, digits.length + 1, phone);
      const visible = masked.replace(/[^0-9]/g, "");
      assert.equal(visible, digits.length > 2 ? digits.slice(-2) : "", phone);
    }
  });

  test("un numéro non canonique n'est jamais restitué tel quel", () => {
    const masked = maskPhoneForLog(" +225 07 07 07 07 12 ; secret");
    assert.match(masked, /^\+\*+12$/);
    assert.equal(masked.includes("secret"), false);
    assert.equal(masked.includes(" "), false);
  });
});

describe("activation : combinaison exacte NODE_ENV=development et NOMA_DEV_OTP_CONSOLE=1", () => {
  test("le nom du drapeau est NOMA_DEV_OTP_CONSOLE", () => {
    assert.equal(DEV_OTP_FLAG, "NOMA_DEV_OTP_CONSOLE");
  });

  test("seule la combinaison exacte active le transport", () => {
    assert.equal(isDevOtpConsoleEnabled({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" }), true);
  });

  test("jamais hors développement, même avec le drapeau", () => {
    for (const nodeEnv of ["production", "test", "Development", "DEVELOPMENT", "dev", "staging", "", " development", undefined]) {
      assert.equal(
        isDevOtpConsoleEnabled({ NODE_ENV: nodeEnv, NOMA_DEV_OTP_CONSOLE: "1" }),
        false,
        `NODE_ENV=${String(nodeEnv)}`,
      );
    }
  });

  test("jamais sans le drapeau exact « 1 »", () => {
    for (const flag of [undefined, "", "0", "true", "yes", "01", " 1", "1 ", "11", "on"]) {
      assert.equal(
        isDevOtpConsoleEnabled({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: flag }),
        false,
        `NOMA_DEV_OTP_CONSOLE=${String(flag)}`,
      );
    }
  });

  test("le résolveur du runtime est celui des dépendances par défaut, sans transport injecté", () => {
    assert.equal(defaultAuthHttpDependencies.resolveSendOtp, resolveDevOtpTransport);
    assert.equal(defaultAuthHttpDependencies.sendOtp, undefined);
  });

  test("les dépendances par défaut sont gelées : aucune mutation possible (ni transport injecté, ni résolveur remplacé)", () => {
    const record = defaultAuthHttpDependencies as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(defaultAuthHttpDependencies), true);
    assert.throws(() => {
      record.sendOtp = async () => {};
    }, TypeError);
    assert.throws(() => {
      record.resolveSendOtp = () => undefined;
    }, TypeError);
    assert.throws(() => {
      record.pool = {};
    }, TypeError);
    assert.throws(() => {
      delete record.resolveSendOtp;
    }, TypeError);
    assert.equal(defaultAuthHttpDependencies.sendOtp, undefined);
    assert.equal(defaultAuthHttpDependencies.resolveSendOtp, resolveDevOtpTransport);
    assert.equal("pool" in defaultAuthHttpDependencies, false);
  });
});

describe("transport de développement : une ligne fixe, rien d'autre", () => {
  test("la ligne a exactement le format attendu", async () => {
    const lines: string[] = [];
    await createDevOtpTransport((line) => lines.push(line))(SEND_INPUT);
    assert.deepEqual(lines, [
      "[auth:dev] code OTP pour +***********12 : 123456 (expire à 10:05:09 UTC)",
    ]);
  });

  test("aucune autre donnée n'est écrite : ni numéro complet, ni challenge, ni millisecondes", async () => {
    const lines: string[] = [];
    await createDevOtpTransport((line) => lines.push(line))(SEND_INPUT);
    const written = lines.join("\n");
    assert.equal(lines.length, 1);
    assert.equal(written.includes("2250707070712"), false);
    assert.equal(written.includes("07070707"), false);
    assert.equal(written.includes(SEND_INPUT.challengeId), false);
    assert.equal(written.includes("456Z"), false);
    assert.match(
      written,
      /^\[auth:dev\] code OTP pour \+\*+[0-9]{2} : [0-9]{6} \(expire à [0-9]{2}:[0-9]{2}:[0-9]{2} UTC\)$/,
    );
  });
});

describe("résolveur du transport de développement", () => {
  function recording() {
    const written: string[] = [];
    const warnings: string[] = [];
    const resolve = createDevOtpResolver({
      write: (line) => written.push(line),
      warn: (line) => warnings.push(line),
    });
    return { resolve, written, warnings };
  }

  test("développement + drapeau : un transport qui écrit la ligne, sans avertissement", async () => {
    const { resolve, written, warnings } = recording();
    const transport = resolve({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" });
    assert.equal(typeof transport, "function");
    await transport!(SEND_INPUT);
    assert.equal(written.length, 1);
    assert.equal(warnings.length, 0);
  });

  test("production + drapeau : jamais de transport, un seul avertissement fixe sur plusieurs demandes", async () => {
    const { resolve, written, warnings } = recording();
    const env = { NODE_ENV: "production", NOMA_DEV_OTP_CONSOLE: "1" };
    for (let index = 0; index < 4; index += 1) assert.equal(resolve(env), undefined);
    assert.deepEqual(warnings, [DEV_OTP_REFUSED_WARNING]);
    assert.equal(written.length, 0);
    assert.equal(DEV_OTP_REFUSED_WARNING.includes("NOMA_DEV_OTP_CONSOLE=1"), true);
  });

  test("toute valeur de NODE_ENV autre que development est refusée avec le même avertissement unique", () => {
    for (const nodeEnv of ["test", "staging", "", undefined]) {
      const { resolve, warnings } = recording();
      assert.equal(resolve({ NODE_ENV: nodeEnv, NOMA_DEV_OTP_CONSOLE: "1" }), undefined);
      assert.equal(resolve({ NODE_ENV: nodeEnv, NOMA_DEV_OTP_CONSOLE: "1" }), undefined);
      assert.deepEqual(warnings, [DEV_OTP_REFUSED_WARNING], `NODE_ENV=${String(nodeEnv)}`);
    }
  });

  test("sans le drapeau : jamais de transport ni de message, développement compris", () => {
    for (const env of [
      { NODE_ENV: "development" },
      { NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "0" },
      { NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "true" },
      { NODE_ENV: "production" },
      { NODE_ENV: "production", NOMA_DEV_OTP_CONSOLE: "true" },
      {},
    ]) {
      const { resolve, written, warnings } = recording();
      assert.equal(resolve(env), undefined, JSON.stringify(env));
      assert.equal(written.length + warnings.length, 0, JSON.stringify(env));
    }
  });

  test("l'environnement est relu à chaque appel : le résolveur ne mémorise pas une décision", () => {
    const { resolve } = recording();
    assert.equal(typeof resolve({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" }), "function");
    assert.equal(resolve({ NODE_ENV: "development" }), undefined);
    assert.equal(resolve({ NODE_ENV: "production", NOMA_DEV_OTP_CONSOLE: "1" }), undefined);
    assert.equal(typeof resolve({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" }), "function");
  });
});
