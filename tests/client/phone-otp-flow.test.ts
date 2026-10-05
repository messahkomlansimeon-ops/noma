import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clearOtpFlow, isOtpFlowStorageAvailable, readOtpFlow, saveOtpFlow, type OtpFlow } from "../../lib/client/otp-flow";
import { isCanonicalPhone, maskPhoneForDisplay, toCanonicalPhone } from "../../lib/client/phone";

describe("toCanonicalPhone : saisie ivoirienne → E.164 canonique", () => {
  test("10 chiffres avec le 0 initial conservé, séparateurs tolérés", () => {
    assert.equal(toCanonicalPhone("07 00 00 00 42"), "+2250700000042");
    assert.equal(toCanonicalPhone("0700000042"), "+2250700000042");
    assert.equal(toCanonicalPhone("07.00.00.00.42"), "+2250700000042");
    assert.equal(toCanonicalPhone("(07) 00-00-00-42"), "+2250700000042");
    assert.equal(toCanonicalPhone("  0102030405 "), "+2250102030405");
  });

  test("ancien format à 8 chiffres", () => {
    assert.equal(toCanonicalPhone("07123412"), "+22507123412");
  });

  test("indicatif saisi : +225, 00225 ou 225 devant un numéro complet", () => {
    assert.equal(toCanonicalPhone("+225 07 00 00 00 42"), "+2250700000042");
    assert.equal(toCanonicalPhone("+2250700000042"), "+2250700000042");
    assert.equal(toCanonicalPhone("00225 0700000042"), "+2250700000042");
    assert.equal(toCanonicalPhone("2250700000042"), "+2250700000042");
    assert.equal(toCanonicalPhone("22507123412"), "+22507123412");
  });

  test("refuse sans correction silencieuse : longueurs, lettres, signes mal placés", () => {
    for (const value of ["", "   ", "0700", "070000004", "07000000421", "abc", "07 00 00 00 4x", "07+0000042", "+33 6 12 34 56 78", "07-00-00-00-42; DROP", "٠٧٠٠٠٠٠٠٤٢"]) {
      assert.equal(toCanonicalPhone(value), null, JSON.stringify(value));
    }
  });

  test("un « + » initial doit être suivi de 225 : tout autre indicatif donne null (jamais de réécriture en +225)", () => {
    for (const value of ["+4930123456", "+3361234567", "+12025550", "+225123", "+0700000042", "+700000042", "+07 00 00 00 42"]) {
      assert.equal(toCanonicalPhone(value), null, value);
    }
  });

  test("saisies valides conservées malgré la règle du « + »", () => {
    assert.equal(toCanonicalPhone("0701020304"), "+2250701020304");
    assert.equal(toCanonicalPhone("+2250701020304"), "+2250701020304");
    assert.equal(toCanonicalPhone("+225 07 01 02 03 04"), "+2250701020304");
    assert.equal(toCanonicalPhone("00225 0701020304"), "+2250701020304");
    assert.equal(toCanonicalPhone("225 0701020304"), "+2250701020304");
    assert.equal(toCanonicalPhone("07123412"), "+22507123412");
    assert.equal(toCanonicalPhone("+22507123412"), "+22507123412");
  });

  test("tout résultat est canonique", () => {
    for (const value of ["0700000042", "07123412", "+225 0700000042"]) {
      assert.equal(isCanonicalPhone(toCanonicalPhone(value)), true);
    }
    assert.equal(isCanonicalPhone("2250700000042"), false);
    assert.equal(isCanonicalPhone("+0123"), false);
    assert.equal(isCanonicalPhone(42), false);
  });
});

describe("maskPhoneForDisplay", () => {
  test("numéro ivoirien : « +225 07 •• •• •• 42 », jamais les chiffres du milieu", () => {
    const masked = maskPhoneForDisplay("+2250712345642");
    assert.equal(masked, "+225 07 •• •• •• 42");
    assert.equal(masked.includes("1234"), false);
  });

  test("autre numéro : seuls les deux derniers chiffres", () => {
    assert.equal(maskPhoneForDisplay("+33612345678"), "+•••••••••78");
    assert.equal(maskPhoneForDisplay("+12"), "••");
  });
});

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const FLOW: OtpFlow = {
  phone: "+2250700000042",
  challengeId: "0b6f3a52-6d6e-4b9f-9a35-6f2f6d9b8c11",
  expiresAt: "2031-01-01T10:05:00.000Z",
  resendAvailableAt: "2031-01-01T10:01:00.000Z",
  next: "/vendeur/annonces",
};

describe("parcours OTP conservé dans sessionStorage", () => {
  test("aller-retour puis effacement", () => {
    const storage = new MemoryStorage();
    saveOtpFlow(FLOW, storage);
    assert.deepEqual(readOtpFlow(storage), FLOW);
    clearOtpFlow(storage);
    assert.equal(readOtpFlow(storage), null);
  });

  test("le code n'est jamais stocké", () => {
    const storage = new MemoryStorage();
    saveOtpFlow({ ...FLOW, code: "123456" } as OtpFlow, storage);
    const raw = [...storage.data.values()].join("");
    assert.equal(raw.includes("123456"), false);
  });

  test("la destination est nettoyée à l'écriture et à la lecture", () => {
    const storage = new MemoryStorage();
    saveOtpFlow({ ...FLOW, next: "https://evil.example" }, storage);
    assert.equal(readOtpFlow(storage)?.next, "/");
    storage.setItem("noma:otp-flow", JSON.stringify({ ...FLOW, next: "//evil.example" }));
    assert.equal(readOtpFlow(storage)?.next, "/");
  });

  test("une valeur altérée ou incomplète est ignorée", () => {
    const storage = new MemoryStorage();
    for (const value of [
      "pas du json",
      "null",
      "42",
      JSON.stringify({ ...FLOW, phone: "0700000042" }),
      JSON.stringify({ ...FLOW, challengeId: "pas-un-uuid" }),
      JSON.stringify({ ...FLOW, expiresAt: "demain" }),
      JSON.stringify({ ...FLOW, resendAvailableAt: 5 }),
      JSON.stringify({ phone: FLOW.phone }),
    ]) {
      storage.setItem("noma:otp-flow", value);
      assert.equal(readOtpFlow(storage), null, value);
    }
  });

  test("saveOtpFlow signale l'échec : true si écrit, false si le stockage est absent ou refuse l'écriture", () => {
    const refusing = {
      getItem: () => null,
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {},
    };
    assert.equal(saveOtpFlow(FLOW, new MemoryStorage()), true);
    assert.equal(saveOtpFlow(FLOW, refusing), false);
    assert.equal(saveOtpFlow(FLOW, null), false);
  });

  test("isOtpFlowStorageAvailable : vrai seulement si une écriture réussit réellement", () => {
    const refusing = {
      getItem: () => null,
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {},
    };
    assert.equal(isOtpFlowStorageAvailable(new MemoryStorage()), true);
    assert.equal(isOtpFlowStorageAvailable(refusing), false);
    assert.equal(isOtpFlowStorageAvailable(null), false);
    const probed = new MemoryStorage();
    isOtpFlowStorageAvailable(probed);
    assert.equal(probed.data.size, 0, "la sonde ne laisse rien dans le stockage");
  });

  test("stockage indisponible : aucune exception", () => {
    const broken = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    };
    assert.doesNotThrow(() => saveOtpFlow(FLOW, broken));
    assert.equal(readOtpFlow(broken), null);
    assert.doesNotThrow(() => clearOtpFlow(broken));
    assert.equal(readOtpFlow(null), null);
  });
});
