import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SessionGate, SessionGateView } from "../../components/session-gate";
import type { GateState } from "../../lib/client/session";

const CHILD = <div id="contenu-protege">DONNEES-PROTEGEES</div>;

function html(state: GateState): string {
  return renderToString(<SessionGateView state={state}>{CHILD}</SessionGateView>);
}

describe("SessionGateView : les enfants n'existent que si la session est confirmée", () => {
  test("vérification en cours : message, pas d'enfants", () => {
    const out = html({ kind: "checking" });
    assert.match(out, /Vérification de votre session/);
    assert.equal(out.includes("DONNEES-PROTEGEES"), false);
  });

  test("redirection en cours : pas d'enfants", () => {
    const out = html({ kind: "redirecting" });
    assert.equal(out.includes("DONNEES-PROTEGEES"), false);
    assert.match(out, /Vérification de votre session/);
  });

  test("service indisponible : message et bouton Réessayer, pas d'enfants", () => {
    const out = html({ kind: "unavailable" });
    assert.match(out, /temporairement indisponible/);
    assert.match(out, /Réessayer/);
    assert.equal(out.includes("DONNEES-PROTEGEES"), false);
  });

  test("session confirmée : les enfants sont rendus", () => {
    const out = html({ kind: "allowed", userId: "u-1" });
    assert.match(out, /DONNEES-PROTEGEES/);
  });
});

describe("SessionGate : premier rendu (avant toute réponse du serveur)", () => {
  test("le premier rendu n'affiche jamais les enfants", () => {
    const router = {
      push() {},
      replace() {},
      back() {},
      forward() {},
      refresh() {},
      prefetch() {},
    };
    const out = renderToString(
      <AppRouterContext.Provider value={router as never}>
        <SessionGate>{CHILD}</SessionGate>
      </AppRouterContext.Provider>,
    );
    assert.equal(out.includes("DONNEES-PROTEGEES"), false);
    assert.match(out, /Vérification de votre session/);
  });
});
