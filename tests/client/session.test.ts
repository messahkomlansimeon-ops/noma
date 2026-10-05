import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionOutcome } from "../../lib/client/api";
import {
  INITIAL_GATE_STATE,
  decideGate,
  loginHref,
  runSessionGate,
  safeNextPath,
} from "../../lib/client/session";

describe("safeNextPath : chemin interne uniquement", () => {
  test("accepte les chemins internes (avec requête et ancre)", () => {
    assert.equal(safeNextPath("/vendeur/annonces"), "/vendeur/annonces");
    assert.equal(safeNextPath("/vendeur/annonces?filtre=en-ligne#haut"), "/vendeur/annonces?filtre=en-ligne#haut");
    assert.equal(safeNextPath("/alertes"), "/alertes");
    assert.equal(safeNextPath("/"), "/");
    assert.equal(safeNextPath("/offre/o-1?x=https://exemple.com"), "/offre/o-1?x=https://exemple.com");
  });

  test("refuse toute URL absolue ou protocole-relative", () => {
    for (const value of [
      "https://evil.example/x",
      "http://evil.example",
      "HTTPS://evil.example",
      "//evil.example",
      "//evil.example/vendeur",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "\\/evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:a@b.c",
      "evil.example",
      "vendeur/annonces",
    ]) {
      assert.equal(safeNextPath(value), "/", value);
    }
  });

  test("refuse les astuces de normalisation qui rapprochent d'une URL protocole-relative", () => {
    for (const value of ["/..//evil.example", "/.//evil.example", "/%2e%2e//evil.example", "/a/../..//evil.example"]) {
      assert.equal(safeNextPath(value), "/", value);
    }
  });

  test("refuse les caractères de contrôle, espaces initiaux, valeurs vides, non textuelles ou trop longues", () => {
    for (const value of ["/\tevil", "/\nevil", "/a\rb", "/a\u0000b", " /vendeur", "", "x".repeat(10), `/${"a".repeat(600)}`]) {
      assert.equal(safeNextPath(value), "/", JSON.stringify(value));
    }
    for (const value of [null, undefined, 42, {}, ["/vendeur"], true]) {
      assert.equal(safeNextPath(value), "/");
    }
  });

  test("refuse les pages de connexion (boucle de redirection)", () => {
    for (const value of ["/connexion", "/connexion?next=/vendeur", "/verification", "/verification/x", "/connexion#a"]) {
      assert.equal(safeNextPath(value), "/", value);
    }
    assert.equal(safeNextPath("/connexion-autre"), "/connexion-autre");
  });

  test("le repli est configurable", () => {
    assert.equal(safeNextPath("//evil.example", "/vendeur"), "/vendeur");
  });
});

describe("loginHref", () => {
  test("encode le chemin de retour nettoyé", () => {
    assert.equal(loginHref("/vendeur/annonces"), "/connexion?next=%2Fvendeur%2Fannonces");
    assert.equal(loginHref("/alertes?a=1&b=2"), "/connexion?next=%2Falertes%3Fa%3D1%26b%3D2");
  });

  test("destination invalide ou accueil : /connexion sans retour", () => {
    assert.equal(loginHref("https://evil.example"), "/connexion");
    assert.equal(loginHref("//evil.example"), "/connexion");
    assert.equal(loginHref(null), "/connexion");
    assert.equal(loginHref("/"), "/connexion");
  });
});

describe("garde de session", () => {
  const authenticated: SessionOutcome = { kind: "authenticated", userId: "u-1" };
  const anonymous: SessionOutcome = { kind: "anonymous" };
  const unavailable: SessionOutcome = { kind: "unavailable" };

  test("l'état initial n'affiche rien : vérification en cours", () => {
    assert.deepEqual(INITIAL_GATE_STATE, { kind: "checking" });
  });

  test("decideGate : session valide → afficher ; aucune session → connexion avec retour ; panne → indisponible", () => {
    assert.deepEqual(decideGate(authenticated, "/vendeur/annonces"), { kind: "allow", userId: "u-1" });
    assert.deepEqual(decideGate(anonymous, "/vendeur/annonces"), {
      kind: "redirect",
      to: "/connexion?next=%2Fvendeur%2Fannonces",
    });
    assert.deepEqual(decideGate(unavailable, "/vendeur/annonces"), { kind: "unavailable" });
  });

  test("decideGate : une destination hostile ne devient jamais une redirection externe", () => {
    assert.deepEqual(decideGate(anonymous, "//evil.example/x"), { kind: "redirect", to: "/connexion" });
    assert.deepEqual(decideGate(anonymous, "https://evil.example"), { kind: "redirect", to: "/connexion" });
  });

  async function run(outcome: SessionOutcome, currentPath = "/vendeur/annonces") {
    const navigations: string[] = [];
    const state = await runSessionGate({
      sessionOutcome: async () => outcome,
      currentPath,
      navigate: (to) => navigations.push(to),
    });
    return { state, navigations };
  }

  test("runSessionGate : sans session, redirige UNE fois vers /connexion?next=… et n'autorise rien", async () => {
    const { state, navigations } = await run(anonymous);
    assert.deepEqual(state, { kind: "redirecting" });
    assert.deepEqual(navigations, ["/connexion?next=%2Fvendeur%2Fannonces"]);
  });

  test("runSessionGate : avec session, autorise sans naviguer", async () => {
    const { state, navigations } = await run(authenticated);
    assert.deepEqual(state, { kind: "allowed", userId: "u-1" });
    assert.deepEqual(navigations, []);
  });

  test("runSessionGate : service indisponible, n'autorise pas et ne redirige pas", async () => {
    const { state, navigations } = await run(unavailable);
    assert.deepEqual(state, { kind: "unavailable" });
    assert.deepEqual(navigations, []);
  });

  test("runSessionGate : une erreur imprévue de lecture de session est propagée, jamais transformée en autorisation", async () => {
    await assert.rejects(
      runSessionGate({
        sessionOutcome: async () => {
          throw new Error("interrompu");
        },
        currentPath: "/vendeur",
        navigate: () => assert.fail("pas de navigation"),
      }),
    );
  });
});
