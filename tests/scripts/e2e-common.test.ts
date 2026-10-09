import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { waitForSettledValue } from "../../scripts/e2e-common";

/**
 * Lot T3 : l'attente d'un ÉTAT STABLE des essais de bout en bout (e2e:core, étape « besoin satisfait ») est testée sans navigateur ni serveur, avec une base simulée qui change pendant
 * l'attente : l'instantané de départ d'une vérification ne doit jamais être pris pendant que le worker écrit encore.
 */
describe("attente d'un état stable (essais de bout en bout)", () => {
  test("rend la seconde de deux lectures identiques, jamais une lecture prise pendant que l'état change", async () => {
    // Le « worker » ajoute un envoi à la 2e lecture, puis plus rien : la première lecture stable est la 4e/5e.
    const snapshots = [[{ status: "pending", n: 1 }], [{ status: "pending", n: 2 }], [{ status: "pending", n: 2 }]];
    let reads = 0;
    const value = await waitForSettledValue({
      label: "essai", read: async () => snapshots[Math.min(reads++, snapshots.length - 1)], quiet: async () => true, timeoutMs: 2_000, gapMs: 5,
    });
    assert.deepEqual(value, [{ status: "pending", n: 2 }], "la lecture d'avant l'écriture du worker (n = 1) n'est jamais rendue");
    assert.ok(reads >= 3);
  });

  test("n'accepte rien tant que le système n'est pas au repos (tâches en cours), même si deux lectures sont identiques", async () => {
    let quietCalls = 0;
    let busyChecks = 0;
    const value = await waitForSettledValue({
      label: "essai", read: async () => "même état", quiet: async () => { quietCalls += 1; if (quietCalls <= 4) busyChecks += 1; return quietCalls > 4; }, timeoutMs: 2_000, gapMs: 5,
    });
    assert.equal(value, "même état");
    assert.equal(busyChecks, 4, "quatre contrôles « en cours » avant le repos");
  });

  test("un repos perdu entre les deux lectures annule l'essai en cours (la tâche arrive pendant l'attente)", async () => {
    const quiet = [true, false, true, true, true];
    let index = 0;
    let reads = 0;
    const value = await waitForSettledValue({
      label: "essai", read: async () => { reads += 1; return "x"; }, quiet: async () => quiet[Math.min(index++, quiet.length - 1)], timeoutMs: 2_000, gapMs: 5,
    });
    assert.equal(value, "x");
    assert.equal(reads, 4, "deux lectures de l'essai annulé (repos perdu juste après), puis deux autres");
  });

  test("délai dépassé : une erreur qui dit l'étiquette, jamais un état instable", async () => {
    await assert.rejects(
      waitForSettledValue({ label: "mon état", read: async () => Math.random(), quiet: async () => true, timeoutMs: 120, gapMs: 10, hint: "le worker tourne-t-il ?" }),
      /mon état : délai de 120 ms dépassé — le worker tourne-t-il \?/,
    );
  });
});
