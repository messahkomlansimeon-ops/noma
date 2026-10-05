import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, GENERIC_ERROR_MESSAGE, type OtpChallenge } from "../../lib/client/api";
import { STORAGE_BLOCKED_MESSAGE, changeNumberHref, startOtpFlow, type StartOtpDependencies } from "../../lib/client/otp-start";

const CHALLENGE: OtpChallenge = {
  challengeId: "0b6f3a52-6d6e-4b9f-9a35-6f2f6d9b8c11",
  expiresAt: "2031-01-01T10:05:00.000Z",
  resendAvailableAt: "2031-01-01T10:01:00.000Z",
};

function harness(overrides: Partial<StartOtpDependencies> = {}) {
  const requested: string[] = [];
  const saved: unknown[] = [];
  const dependencies: StartOtpDependencies = {
    canStore: () => true,
    requestOtp: async (phone) => {
      requested.push(phone);
      return CHALLENGE;
    },
    save: (flow) => {
      saved.push(flow);
      return true;
    },
    describeError: () => GENERIC_ERROR_MESSAGE,
    ...overrides,
  };
  return { dependencies, requested, saved };
}

describe("startOtpFlow : demande de code depuis /connexion", () => {
  test("message fixe pour un navigateur sans stockage", () => {
    assert.equal(STORAGE_BLOCKED_MESSAGE, "Votre navigateur bloque le stockage nécessaire à la connexion.");
  });

  test("cas nominal : une demande, le parcours est enregistré avec le numéro, le challenge et la destination", async () => {
    const { dependencies, requested, saved } = harness();
    assert.deepEqual(await startOtpFlow("+2250700000042", "/vendeur/annonces", dependencies), { ok: true });
    assert.deepEqual(requested, ["+2250700000042"]);
    assert.deepEqual(saved, [{ phone: "+2250700000042", ...CHALLENGE, next: "/vendeur/annonces" }]);
  });

  test("stockage indisponible dès le départ : aucun code n'est demandé, message fixe, pas de navigation", async () => {
    const { dependencies, requested, saved } = harness({ canStore: () => false });
    assert.deepEqual(await startOtpFlow("+2250700000042", "/", dependencies), {
      ok: false,
      message: STORAGE_BLOCKED_MESSAGE,
    });
    assert.equal(requested.length, 0);
    assert.equal(saved.length, 0);
  });

  test("écriture refusée après l'envoi : message fixe, pas de navigation, pas de second envoi", async () => {
    const { dependencies, requested } = harness({ save: () => false });
    assert.deepEqual(await startOtpFlow("+2250700000042", "/", dependencies), {
      ok: false,
      message: STORAGE_BLOCKED_MESSAGE,
    });
    assert.equal(requested.length, 1);
  });

  test("échec de la demande : message d'erreur fixe de l'API, rien n'est enregistré", async () => {
    const { dependencies, saved } = harness({
      requestOtp: async () => {
        throw new ApiError(429, "otp_rate_limited", "Trop de demandes.");
      },
      describeError: (error) => (error instanceof ApiError && error.status === 429 ? "Trop de demandes de code." : GENERIC_ERROR_MESSAGE),
    });
    assert.deepEqual(await startOtpFlow("+2250700000042", "/", dependencies), {
      ok: false,
      message: "Trop de demandes de code.",
    });
    assert.equal(saved.length, 0);
  });
});

describe("changeNumberHref : « Modifier le numéro » conserve la destination", () => {
  const flow = (next: string) => ({ phone: "+2250700000042", ...CHALLENGE, next });

  test("la destination interne est reportée dans ?next=", () => {
    assert.equal(changeNumberHref(flow("/vendeur/annonces")), "/connexion?next=%2Fvendeur%2Fannonces");
    assert.equal(changeNumberHref(flow("/alertes?a=1&b=2")), "/connexion?next=%2Falertes%3Fa%3D1%26b%3D2");
  });

  test("accueil, parcours absent ou destination hostile : /connexion sans next (nettoyage par safeNextPath)", () => {
    assert.equal(changeNumberHref(flow("/")), "/connexion");
    assert.equal(changeNumberHref(null), "/connexion");
    for (const hostile of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/connexion", "/verification"]) {
      assert.equal(changeNumberHref(flow(hostile)), "/connexion", hostile);
    }
  });
});
