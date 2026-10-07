import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideAdminSpace, requireAdminSpaceWith as requireAdminSpace, type AdminSpaceDependencies } from "../../lib/server/admin/space-decision";
import type { ResolvedSession } from "../../lib/server/auth/types";

/**
 * Lot D3, point 5 : l'espace d'administration (gabarit `app/(admin)/layout.tsx`) ne s'affiche qu'à un administrateur ; un compte connecté qui ne l'est pas obtient la page 404 standard de Next
 * (`notFound()`), sans titre « Administration ». Un visiteur sans session n'est pas décidé ici : la garde de session de la page le renvoie vers la connexion.
 */

const session = (isAdmin: boolean | undefined): ResolvedSession => ({ userId: "u", expiresAt: new Date(Date.now() + 60_000), ...(isAdmin === undefined ? {} : { isAdmin }) });

class NotFound extends Error {
  readonly digest = "NEXT_HTTP_ERROR_FALLBACK;404";
}

function deps(token: string | null, resolved: ResolvedSession | null, trace: string[] = []): AdminSpaceDependencies {
  return {
    readToken: async () => token,
    resolve: async (value) => {
      trace.push(`resolve:${value}`);
      return resolved;
    },
    notFound: () => {
      trace.push("notFound");
      throw new NotFound();
    },
  };
}

describe("garde de l'espace d'administration", () => {
  test("administrateur : l'espace s'affiche ; compte ordinaire connecté : page 404 standard (notFound), jamais l'affichage", async () => {
    const trace: string[] = [];
    await requireAdminSpace(deps("t", session(true), trace));
    assert.deepEqual(trace, ["resolve:t"], "aucun 404 pour un administrateur");
    await assert.rejects(requireAdminSpace(deps("t", session(false), trace)), (error: unknown) => error instanceof NotFound && error.digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    assert.equal(trace.at(-1), "notFound");
    await assert.rejects(requireAdminSpace(deps("t", session(undefined))), NotFound, "isAdmin absent : traité comme faux");
  });

  test("visiteur sans cookie, session périmée ou compte suspendu : aucune décision ici (la garde de session de la page redirige vers la connexion), aucun 404", async () => {
    const trace: string[] = [];
    await requireAdminSpace(deps(null, null, trace));
    assert.deepEqual(trace, [], "sans cookie, la base n'est même pas interrogée");
    await requireAdminSpace(deps("périmé", null, trace));
    assert.deepEqual(trace, ["resolve:périmé"]);
    assert.equal(await decideAdminSpace(deps("t", null)), "show");
    assert.equal(await decideAdminSpace(deps(null, session(false))), "show", "sans cookie, le résultat de la base n'est jamais lu");
  });

  test("décision : « show » pour un administrateur (booléen vrai seulement), « not_found » sinon ; seule la valeur vraie ouvre l'espace", async () => {
    assert.equal(await decideAdminSpace(deps("t", session(true))), "show");
    assert.equal(await decideAdminSpace(deps("t", session(false))), "not_found");
    assert.equal(await decideAdminSpace(deps("t", session(undefined))), "not_found");
    assert.equal(await decideAdminSpace(deps("t", { ...session(true), isAdmin: "true" as unknown as boolean })), "not_found", "une valeur qui n'est pas le booléen vrai n'ouvre rien");
  });
});

describe("câblage à Next (lecture du code source)", () => {
  const read = (path: string) => readFileSync(join(import.meta.dirname, "../..", path), "utf8");

  test("le gabarit d'administration appelle la garde ; la garde lit UN seul cookie de session, résout la session et appelle le notFound() de Next", () => {
    const guard = read("lib/server/admin/space-guard.ts");
    assert.match(guard, /notFound: \(\) => notFound\(\)/);
    assert.match(guard, /import \{ notFound \} from "next\/navigation"/);
    assert.match(guard, /candidates\.length === 1/);
    assert.match(guard, /resolve: \(token\) => resolveSession\(token\)/);
    assert.match(read("app/(admin)/layout.tsx"), /await requireAdminSpace\(\);/);
  });
});
