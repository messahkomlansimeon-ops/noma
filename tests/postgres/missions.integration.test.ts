import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { archiveDemand, getDemandById, satisfyDemand, updateDemand } from "../../lib/server/catalog";
import { createCatalogHttpHandlers } from "../../lib/server/catalog/http";
import { readBuyerHome } from "../../lib/server/home/reads";
import { runMissionsStep } from "../../lib/server/missions/step";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import { MISSION_ACTIVE_LIMIT, MISSION_CREATIONS_PER_DAY } from "../../lib/missions-rules";
import {
  actMissionCall, ageClosedMission, count, createMissionCall, errorCode, listMissionsCall, login, makeDue, makeHandlers, missionBody, missionOf, openTestSchema, readMissionCall, reply, request,
  resetSocial, startMission, updateMissionCall, withoutMissionGuard, type Handlers, type Login, type TestSchema,
} from "./missions-fixtures";
import * as missionsRoute from "../../app/api/missions/route";
import * as missionRoute from "../../app/api/missions/[id]/route";
import * as proposalRoute from "../../app/api/missions/[id]/proposal/route";
import { NOT_FOUND } from "./social-fixtures";

/**
 * Missions d'achat en volume (lot MV1), noyau : création et plafonds, brouillon, cycle de vie (lancer, pause, reprise, annulation), besoin porteur (ordinaire, sans budget ni
 * quantité, caché de « Mes besoins », verrouillé), accès réservé au propriétaire (404 indiscernable), garde-fous de la base.
 */

let env: TestSchema;
let h: Handlers;
let buyer: Login;
let stranger: Login;

before(async () => {
  env = await openTestSchema();
  h = makeHandlers(env.pool);
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  buyer = await login(env.pool);
});

describe("création et validation", () => {
  test("une mission naît BROUILLON : forme en liste blanche, aucun besoin porteur, propriétaire pris dans la session", async () => {
    const answer = await createMissionCall(h, buyer.cookie);
    assert.equal(answer.status, 201, answer.text);
    const mission = missionOf(answer);
    assert.equal(mission.status, "draft");
    assert.equal(mission.demandId, null);
    assert.equal(mission.deadlineAt, null);
    assert.equal(mission.title, "6 × Apple iPhone 13 128 Go");
    assert.deepEqual(Object.keys(mission).sort(), [
      "activatedAt", "brand", "canActivate", "canCancel", "canEdit", "canPause", "canResume", "category", "closedAt", "committedXof", "condition", "coveredQuantity", "createdAt", "deadlineAt",
      "deadlineDays", "demandId", "evaluatedAt", "id", "location", "model", "pendingQuantity", "quantity", "securedQuantity", "status", "title", "totalBudgetXof", "unit", "unitBudgetXof",
      "updatedAt", "variant",
    ]);
    assert.deepEqual([mission.canEdit, mission.canActivate, mission.canPause, mission.canResume, mission.canCancel], [true, true, false, false, true]);
    assert.equal(await count(env.pool, "demands"), 0, "un brouillon n'a pas de besoin porteur");
    const row = await env.pool.query<{ owner_id: string }>("SELECT owner_id FROM missions WHERE id = $1", [mission.id]);
    assert.equal(row.rows[0].owner_id, buyer.userId);
    assert.equal(answer.headers.get("cache-control"), "no-store");
  });

  test("champs refusés : 400 avec le champ nommé, rien n'est écrit ; champ inconnu, type faux, nombre non entier, bornes", async () => {
    const refusals: Array<[Record<string, unknown>, string, string | null]> = [
      [missionBody({ quantity: 1 }), "invalid_mission", "quantity"],
      [missionBody({ quantity: 10_001 }), "invalid_mission", "quantity"],
      [missionBody({ quantity: "6" }), "invalid_mission", "quantity"],
      [missionBody({ quantity: 6.5 }), "invalid_mission", "quantity"],
      [missionBody({ unitBudgetXof: 0 }), "invalid_mission", "unitBudgetXof"],
      [missionBody({ unitBudgetXof: 100_000_001, totalBudgetXof: 200_000_000 }), "invalid_mission", "unitBudgetXof"],
      [missionBody({ unitBudgetXof: 200_000, totalBudgetXof: 199_999 }), "invalid_mission", "totalBudgetXof"],
      [missionBody({ deadlineDays: 0 }), "invalid_mission", "deadlineDays"],
      [missionBody({ deadlineDays: 91 }), "invalid_mission", "deadlineDays"],
      [missionBody({ brand: "" }), "invalid_mission", "brand"],
      [missionBody({ brand: "x".repeat(51) }), "invalid_mission", "brand"],
      [missionBody({ extra: 1 }), "invalid_mission", null],
      [{ ...missionBody(), id: "00000000-0000-4000-8000-000000000000" }, "invalid_mission", null],
      [{ ...missionBody(), ownerId: stranger.userId }, "invalid_mission", null],
      [{ ...missionBody(), status: "active" }, "invalid_mission", null],
    ];
    for (const [body, code, field] of refusals) {
      const answer = await createMissionCall(h, buyer.cookie, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(errorCode(answer), code);
      assert.equal(((answer.json as { error: { field?: string } }).error.field ?? null), field, JSON.stringify(body));
    }
    assert.equal((await createMissionCall(h, buyer.cookie, { ...missionBody(), activate: "yes" })).status, 400);
    assert.equal((await createMissionCall(h, buyer.cookie, [missionBody()])).status, 400);
    assert.equal((await reply(await h.missions.create(request("POST", "/api/missions", { cookie: buyer.cookie, rawBody: "{pas du json" })))).status, 400);
    assert.equal((await reply(await h.missions.create(request("POST", "/api/missions", { cookie: buyer.cookie, rawBody: JSON.stringify(missionBody()), query: "?x=1" })))).status, 400);
    assert.equal(await count(env.pool, "missions"), 0);
  });

  test("le texte libre est filtré par la règle des numéros : refus 400 phone_number_in_mission, champ nommé, y compris un numéro coupé entre marque, modèle et variante", async () => {
    for (const [field, value] of [
      ["brand", "07 08 09 10 11"], ["model", "+225 07 08 09 10 11"], ["variant", "WhatsApp 0708091011"], ["category", "٠٧٠٨٠٩١٠١١"],
      ["condition", "07-08-09-10-11"], ["unit", "0708091011"], ["location", "appelez le 0708091011"],
    ] as const) {
      const answer = await createMissionCall(h, buyer.cookie, missionBody({ [field]: value }));
      assert.equal(answer.status, 400, field);
      assert.equal(errorCode(answer), "phone_number_in_mission");
      assert.equal((answer.json as { error: { field: string } }).error.field, field);
      assert.match((answer.json as { error: { message: string } }).error.message, /Pas de numéro de téléphone dans la mission/);
      assert.ok(!answer.text.includes("0708091011"), "la valeur saisie n'est jamais répétée");
    }
    const split = await createMissionCall(h, buyer.cookie, missionBody({ brand: "07 08", model: "09 10", variant: "11" }));
    assert.equal(split.status, 400);
    assert.equal(errorCode(split), "phone_number_in_mission");
    assert.equal(await count(env.pool, "missions"), 0);
    // Les textes honnêtes passent.
    assert.equal((await createMissionCall(h, buyer.cookie, missionBody({ model: "Galaxy S21", variant: "128 Go", location: "Abidjan, Cocody" }))).status, 201);
  });

  test("session et origine : sans cookie 401, origine étrangère ou absente 403 AVANT la session ; rien n'est écrit", async () => {
    assert.equal((await createMissionCall(h, null)).status, 401);
    assert.equal((await createMissionCall(h, buyer.cookie, missionBody(), "https://evil.example")).status, 403);
    assert.equal((await createMissionCall(h, buyer.cookie, missionBody(), null)).status, 403);
    assert.equal((await createMissionCall(h, null, missionBody(), "https://evil.example")).status, 403, "origine vérifiée avant la session");
    assert.equal((await listMissionsCall(h, null)).status, 401);
    assert.equal(await count(env.pool, "missions"), 0);
  });

  test("plafond de 20 créations par jour : la 21e est refusée (429, Retry-After), même simultanée ; un autre acheteur n'est pas touché", async () => {
    const results = await Promise.all(Array.from({ length: MISSION_CREATIONS_PER_DAY + 5 }, () => createMissionCall(h, buyer.cookie)));
    assert.equal(results.filter((answer) => answer.status === 201).length, MISSION_CREATIONS_PER_DAY);
    const refused = results.filter((answer) => answer.status === 429);
    assert.equal(refused.length, 5);
    assert.equal(errorCode(refused[0]), "mission_daily_limit");
    assert.match(refused[0].headers.get("retry-after") ?? "", /^[0-9]+$/);
    assert.equal(await count(env.pool, "missions", `owner_id = '${buyer.userId}'`), MISSION_CREATIONS_PER_DAY);
    assert.equal((await createMissionCall(h, stranger.cookie)).status, 201);
  });

  test("plafond de 5 missions ACTIVES : la 6e activation est refusée (409), même simultanée ; reprise comprise ; terminer ou annuler libère une place", async () => {
    const drafts: string[] = [];
    for (let index = 0; index < 8; index += 1) drafts.push(missionOf(await createMissionCall(h, buyer.cookie)).id as string);
    const activations = await Promise.all(drafts.map((id) => actMissionCall(h, buyer.cookie, id, "activate")));
    assert.equal(activations.filter((answer) => answer.status === 200).length, MISSION_ACTIVE_LIMIT);
    const blocked = activations.filter((answer) => answer.status === 409);
    assert.equal(blocked.length, 3);
    assert.equal(errorCode(blocked[0]), "mission_active_limit");
    assert.equal(await count(env.pool, "missions", `status = 'active'`), MISSION_ACTIVE_LIMIT);
    assert.equal(await count(env.pool, "demands"), MISSION_ACTIVE_LIMIT, "un besoin porteur par mission lancée seulement");
    // Une mission en pause libère sa place… mais sa reprise la redemande.
    const active = (await env.pool.query<{ id: string }>("SELECT id FROM missions WHERE status = 'active' ORDER BY created_at, id")).rows.map((row) => row.id);
    assert.equal((await actMissionCall(h, buyer.cookie, active[0], "pause")).status, 200);
    const fresh = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    assert.equal((await actMissionCall(h, buyer.cookie, fresh, "activate")).status, 200);
    const blockedResume = await actMissionCall(h, buyer.cookie, active[0], "resume");
    assert.equal(blockedResume.status, 409);
    assert.equal(errorCode(blockedResume), "mission_active_limit");
    assert.equal((await actMissionCall(h, buyer.cookie, active[1], "cancel")).status, 200);
    assert.equal((await actMissionCall(h, buyer.cookie, active[0], "resume")).status, 200);
    // Un autre acheteur a ses propres 5 places.
    const other = missionOf(await createMissionCall(h, stranger.cookie)).id as string;
    assert.equal((await actMissionCall(h, stranger.cookie, other, "activate")).status, 200);
  });

  test("création et lancement d'un coup : si le lancement est refusé (5 actives), la mission n'est pas créée", async () => {
    for (let index = 0; index < MISSION_ACTIVE_LIMIT; index += 1) await startMission(env.pool, h, buyer);
    const before = await count(env.pool, "missions");
    const refused = await createMissionCall(h, buyer.cookie, { ...missionBody(), activate: true });
    assert.equal(refused.status, 409);
    assert.equal(errorCode(refused), "mission_active_limit");
    assert.equal(await count(env.pool, "missions"), before);
  });
});

describe("brouillon", () => {
  test("un brouillon se modifie (PUT) : champs recontrôlés ensemble ; une mission lancée ne se modifie plus (409), ni par SQL (déclencheur)", async () => {
    const created = missionOf(await createMissionCall(h, buyer.cookie));
    const id = created.id as string;
    const changed = await updateMissionCall(h, buyer.cookie, id, { quantity: 12, location: null, totalBudgetXof: 2_000_000 });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(missionOf(changed).quantity, 12);
    assert.equal(missionOf(changed).location, null);
    assert.equal(missionOf(changed).title, "12 × Apple iPhone 13 128 Go");
    // Le budget total ne peut pas passer sous le budget par unité, et un numéro est refusé dans le brouillon aussi.
    assert.equal(errorCode(await updateMissionCall(h, buyer.cookie, id, { totalBudgetXof: 1_000 })), "invalid_mission");
    const phone = await updateMissionCall(h, buyer.cookie, id, { model: "0708091011" });
    assert.equal(phone.status, 400);
    assert.equal(errorCode(phone), "phone_number_in_mission");
    assert.equal(errorCode(await updateMissionCall(h, buyer.cookie, id, {})), "invalid_mission");
    assert.equal(errorCode(await updateMissionCall(h, buyer.cookie, id, { status: "active" })), "invalid_mission");
    assert.equal((await readMissionCall(h, buyer.cookie, id)).status, 200);
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, id)).quantity, 12);
    // Lancée : plus de modification.
    assert.equal((await actMissionCall(h, buyer.cookie, id, "activate")).status, 200);
    const locked = await updateMissionCall(h, buyer.cookie, id, { quantity: 3 });
    assert.equal(locked.status, 409);
    assert.equal(errorCode(locked), "mission_not_draft");
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, id)).quantity, 12);
    await assert.rejects(() => env.pool.query("UPDATE missions SET quantity_total = 3 WHERE id = $1", [id]), /mission_content_locked/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET unit_budget_xof = 1 WHERE id = $1", [id]), /mission_content_locked/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET deadline_days = 5 WHERE id = $1", [id]), /mission_content_locked/);
  });

  test("un brouillon s'annule ; une mission annulée est définitive (rien ne change, en base non plus)", async () => {
    const id = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    assert.equal(missionOf(await actMissionCall(h, buyer.cookie, id, "cancel")).status, "cancelled");
    for (const action of ["activate", "pause", "resume", "cancel"]) {
      const answer = await actMissionCall(h, buyer.cookie, id, action);
      assert.equal(answer.status, 409, action);
      assert.equal(errorCode(answer), "mission_state_conflict");
    }
    assert.equal((await updateMissionCall(h, buyer.cookie, id, { quantity: 3 })).status, 409);
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'draft' WHERE id = $1", [id]), /mission_final/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'active' WHERE id = $1", [id]), /mission_final/);
  });
});

describe("cycle de vie et besoin porteur", () => {
  test("lancer : un besoin porteur ORDINAIRE, actif, sans budget ni quantité ni échéance, suivi en pause ; échéance = lancement + durée", async () => {
    const live = await startMission(env.pool, h, buyer, { deadlineDays: 45 });
    const demand = await env.pool.query<{
      owner_id: string; status: string; budget_amount: string | null; quantity: number | null; unit: string | null; deadline_at: Date | null; notify_paused: boolean; category: string; brand: string;
      model: string; variant: string | null; condition_text: string; location_text: string | null; raw_text: string;
    }>("SELECT owner_id, status, budget_amount, quantity, unit, deadline_at, notify_paused, category, brand, model, variant, condition_text, location_text, raw_text FROM demands WHERE id = $1", [live.demandId]);
    const row = demand.rows[0];
    assert.equal(row.owner_id, buyer.userId);
    assert.equal(row.status, "active");
    assert.equal(row.budget_amount, null, "le budget de la mission n'est JAMAIS dans le besoin porteur (un vendeur voit les besoins qui correspondent à ses annonces)");
    assert.equal(row.quantity, null);
    assert.equal(row.unit, null);
    assert.equal(row.deadline_at, null);
    assert.equal(row.notify_paused, true, "pas de notification annonce par annonce : la mission signale la couverture");
    assert.deepEqual([row.category, row.brand, row.model, row.variant, row.condition_text, row.location_text], ["smartphones", "Apple", "iPhone 13", "128 Go", "good", "Cocody"]);
    assert.ok(!row.raw_text.includes(String(173_456)) && !row.raw_text.includes(String(1_234_567)));
    const mission = await env.pool.query<{ activated_at: Date; deadline_at: Date; demand_id: string }>("SELECT activated_at, deadline_at, demand_id FROM missions WHERE id = $1", [live.id]);
    assert.equal(mission.rows[0].demand_id, live.demandId);
    const days = (mission.rows[0].deadline_at.getTime() - mission.rows[0].activated_at.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 45) < 0.001, `échéance à ${days} jours`);
    // Le lancement émet les événements du matching comme tout besoin actif.
    assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.created'`), 1);
  });

  test("pause, reprise : le MÊME besoin porteur est gardé ; annuler garde le besoin porteur 24 h puis l'archive (étape du runner)", async () => {
    const live = await startMission(env.pool, h, buyer);
    assert.equal(missionOf(await actMissionCall(h, buyer.cookie, live.id, "pause")).status, "paused");
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "pause")).status, 409, "déjà en pause");
    assert.equal(missionOf(await actMissionCall(h, buyer.cookie, live.id, "resume")).status, "active");
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, live.id)).demandId, live.demandId, "même besoin porteur");
    assert.equal(await count(env.pool, "demands"), 1);
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "resume")).status, 409, "déjà active");
    const cancelled = await actMissionCall(h, buyer.cookie, live.id, "cancel");
    assert.equal(missionOf(cancelled).status, "cancelled");
    assert.notEqual(missionOf(cancelled).closedAt, null);
    // Le besoin porteur n'est pas archivé à l'instant de l'annulation : 24 h plus tard, par l'étape du runner.
    assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "active");
    await ageClosedMission(env.pool, live.id, 25);
    assert.equal((await runMissionsStep({ pool: env.pool })).released, 1);
    assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "archived");
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "resume")).status, 409);
  });

  test("action inconnue ou corps mal formé : 400 ; une reprise après l'échéance est refusée", async () => {
    const live = await startMission(env.pool, h, buyer);
    for (const action of ["delete", "complete", "expire", "", 3, null]) assert.equal((await actMissionCall(h, buyer.cookie, live.id, action)).status, 400, String(action));
    assert.equal((await reply(await h.missions.act(request("POST", `/api/missions/${live.id}`, { cookie: buyer.cookie, body: { action: "pause", extra: 1 } }), live.id))).status, 400);
    assert.equal((await reply(await h.missions.act(request("POST", `/api/missions/${live.id}`, { cookie: buyer.cookie, body: {} }), live.id))).status, 400);
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "pause")).status, 200);
    await makeDue(env.pool, live.id);
    const late = await actMissionCall(h, buyer.cookie, live.id, "resume");
    assert.equal(late.status, 409, "une mission échue ne reprend pas");
    assert.equal(errorCode(late), "mission_state_conflict");
  });

  test("le besoin porteur n'est pas un besoin de l'acheteur : absent de la liste du catalogue et de l'accueil ; il ne se modifie que par la mission", async () => {
    const live = await startMission(env.pool, h, buyer);
    const ordinary = await env.pool.query<{ id: string }>(
      "INSERT INTO demands (id, owner_id, status, raw_text, category, brand, model) VALUES (gen_random_uuid(), $1, 'active', 'besoin ordinaire', 'smartphones', 'Apple', 'iPhone 12') RETURNING id",
      [buyer.userId],
    );
    const catalog = createCatalogHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" } });
    const list = await reply(await catalog.demands.list(request("GET", "/api/demands", { cookie: buyer.cookie })));
    const ids = ((list.json as { items?: Array<{ id: string }>; demands?: Array<{ id: string }> }).items ?? (list.json as { demands: Array<{ id: string }> }).demands).map((item) => item.id);
    assert.deepEqual(ids, [ordinary.rows[0].id]);
    const home = await readBuyerHome({ pool: env.pool, userId: buyer.userId });
    assert.deepEqual(home.demands.map((demand) => demand.id), [ordinary.rows[0].id]);
    assert.equal(home.activeDemandCount, 1);
    // Modifier, archiver, satisfaire : refusés tant que la mission est ouverte (garde-fou de la base), proprement (409) par la route du catalogue.
    const carrier = await getDemandById(buyer.userId, live.demandId, env.pool);
    assert.ok(carrier);
    await assert.rejects(() => updateDemand({ id: carrier.id, ownerId: buyer.userId, expectedContentVersion: carrier.contentVersion, changes: { brand: "Samsung" } }, env.pool), /mission_carrier_locked/);
    await assert.rejects(() => archiveDemand(buyer.userId, carrier.id, carrier.contentVersion, env.pool), /mission_carrier_locked/);
    await assert.rejects(() => satisfyDemand(buyer.userId, carrier.id, carrier.contentVersion, env.pool), /mission_carrier_locked/);
    await assert.rejects(() => env.pool.query("UPDATE demands SET notify_paused = FALSE WHERE id = $1", [carrier.id]), /mission_carrier_locked/);
    const trackingHandlers = createNotificationsHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
    const resume = await reply(await trackingHandlers.tracking.act(request("POST", `/api/demands/${carrier.id}/tracking`, { cookie: buyer.cookie, body: { action: "resume" } }), carrier.id));
    assert.equal(resume.status, 409, "relancer les notifications du besoin porteur : refusé");
    assert.equal(errorCode(resume), "mission_carrier_locked");
    assert.equal((await env.pool.query<{ notify_paused: boolean }>("SELECT notify_paused FROM demands WHERE id = $1", [carrier.id])).rows[0].notify_paused, true);
    const refusal = await reply(await catalog.demands.archive(request("POST", `/api/demands/${carrier.id}/archive`, { cookie: buyer.cookie, body: { expectedContentVersion: carrier.contentVersion } }), carrier.id));
    assert.equal(refusal.status, 409);
    assert.equal(errorCode(refusal), "mission_carrier_locked");
    assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "active");
    // Mission annulée : le besoin porteur reste actif 24 h (le vendeur ne voit pas la fin), puis la mission l'archive elle-même.
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "cancel")).status, 200);
    assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "active");
    await ageClosedMission(env.pool, live.id, 25);
    await runMissionsStep({ pool: env.pool });
    assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "archived");
  });
});

describe("accès : propriétaire seulement, 404 indiscernable", () => {
  test("un autre acheteur, un visiteur sans compte ou une mission inconnue reçoivent exactement la même réponse 404", async () => {
    const live = await startMission(env.pool, h, buyer);
    const unknown = "00000000-0000-4000-8000-000000000001";
    for (const id of [live.id, unknown]) {
      const others = [
        await readMissionCall(h, stranger.cookie, id),
        await updateMissionCall(h, stranger.cookie, id, { quantity: 3 }),
        await actMissionCall(h, stranger.cookie, id, "cancel"),
        await actMissionCall(h, stranger.cookie, id, "pause"),
        reply(await h.missions.proposal(request("GET", `/api/missions/${id}/proposal`, { cookie: stranger.cookie }), id)).then((value) => value),
      ];
      for (const answer of await Promise.all(others)) {
        assert.equal(answer.status, 404);
        assert.deepEqual(answer.json, NOT_FOUND);
      }
    }
    // L'inconnue et celle d'autrui : octet pour octet identiques.
    const known = await readMissionCall(h, stranger.cookie, live.id);
    const missing = await readMissionCall(h, stranger.cookie, unknown);
    assert.equal(known.text, missing.text);
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, live.id)).status, "active", "rien n'a changé");
    // La liste de l'autre acheteur ne contient pas la mission.
    assert.deepEqual(((await listMissionsCall(h, stranger.cookie)).json as { missions: unknown[] }).missions, []);
    // Identifiant mal formé : 400 (jamais une requête à la base) ; sans session : 401.
    assert.equal((await readMissionCall(h, buyer.cookie, "pas-un-uuid")).status, 400);
    assert.equal((await readMissionCall(h, null, live.id)).status, 401);
  });

  test("« Mes missions » : les plus récentes d'abord, seulement les siennes", async () => {
    const first = missionOf(await createMissionCall(h, buyer.cookie, missionBody({ model: "iPhone 11" }))).id;
    const second = missionOf(await createMissionCall(h, buyer.cookie, missionBody({ model: "iPhone 12" }))).id;
    await createMissionCall(h, stranger.cookie);
    const list = (await listMissionsCall(h, buyer.cookie)).json as { contractVersion: string; missions: Array<{ id: string }> };
    assert.equal(list.contractVersion, "missions/v1");
    assert.deepEqual(list.missions.map((mission) => mission.id), [second, first]);
  });
});

describe("garde-fous de la base", () => {
  test("transitions : brouillon → active | annulée seulement ; active ↔ pause ; clôtures définitives ; états et dates cohérents", async () => {
    const draft = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'paused' WHERE id = $1", [draft]), /chk_missions_lifecycle|mission_transition_forbidden/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'completed', closed_at = now() WHERE id = $1", [draft]), /mission_transition_forbidden|chk_missions_lifecycle/);
    const live = await startMission(env.pool, h, buyer);
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'draft' WHERE id = $1", [live.id]), /mission_transition_forbidden|chk_missions_lifecycle/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET owner_id = $2 WHERE id = $1", [live.id, stranger.userId]), /mission_immutable/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET status = 'completed' WHERE id = $1", [live.id]), /chk_missions_lifecycle/);
    await assert.rejects(() => env.pool.query("INSERT INTO missions (owner_id, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days, status) VALUES ($1, 'a', 'b', 'c', 'd', 2, 'u', 10, 100, 5, 'active')", [buyer.userId]), /chk_missions_lifecycle/);
    await assert.rejects(() => env.pool.query("INSERT INTO missions (owner_id, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days) VALUES ($1, 'a', 'b', 'c', 'd', 1, 'u', 10, 100, 5)", [buyer.userId]), /quantity_total/);
    await assert.rejects(() => env.pool.query("INSERT INTO missions (owner_id, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days) VALUES ($1, 'a', 'b', 'c', 'd', 2, 'u', 100, 10, 5)", [buyer.userId]), /chk_missions_budgets/);
    await assert.rejects(() => env.pool.query("INSERT INTO missions (owner_id, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days) VALUES ($1, 'a', 'b', E'c\\u202Ed', 'd', 2, 'u', 10, 100, 5)", [buyer.userId]), /chk_missions_text_safe/);
    await withoutMissionGuard(env.pool, async () => undefined);
  });
});

describe("routes Next", () => {
  test("méthodes exportées, exécution Node, jamais mises en cache, et refus sans session (les gestionnaires par défaut)", async () => {
    for (const route of [missionsRoute, missionRoute, proposalRoute]) {
      assert.equal(route.runtime, "nodejs");
      assert.equal(route.dynamic, "force-dynamic");
    }
    assert.deepEqual(Object.keys(missionsRoute).filter((name) => /^[A-Z]+$/.test(name)).sort(), ["GET", "POST"]);
    assert.deepEqual(Object.keys(missionRoute).filter((name) => /^[A-Z]+$/.test(name)).sort(), ["GET", "POST", "PUT"]);
    assert.deepEqual(Object.keys(proposalRoute).filter((name) => /^[A-Z]+$/.test(name)).sort(), ["GET"]);
    const id = "00000000-0000-4000-8000-000000000001";
    const context = { params: Promise.resolve({ id }) };
    const anonymous = (method: string, path: string) => new Request(`https://noma.test${path}`, { method });
    assert.equal((await missionsRoute.GET(anonymous("GET", "/api/missions"))).status, 401);
    assert.equal((await missionRoute.GET(anonymous("GET", `/api/missions/${id}`), context)).status, 401);
    assert.equal((await proposalRoute.GET(anonymous("GET", `/api/missions/${id}/proposal`), context)).status, 401);
    // Une écriture sans origine configurée ni cookie n'atteint jamais la base (503 : origine non configurée, ou 403).
    for (const response of [await missionsRoute.POST(anonymous("POST", "/api/missions")), await missionRoute.PUT(anonymous("PUT", `/api/missions/${id}`), context), await missionRoute.POST(anonymous("POST", `/api/missions/${id}`), context)]) {
      assert.ok([403, 503].includes(response.status), String(response.status));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });
});

// ═════════════ MV1-bis : texte libre (règle des numéros sur tous les champs, invisibles, base alignée), « Mes missions » paginée ═════════════

describe("texte libre : numéros coupés entre champs, caractères invisibles, champ sans lettre ni chiffre", () => {
  const create = async (overrides: Record<string, unknown>) => createMissionCall(h, buyer.cookie, missionBody(overrides));

  test("un numéro coupé entre le modèle et le lieu, ou entre la catégorie et l'état, est refusé (concaténation de TOUS les champs libres), sans que la réponse répète la valeur", async () => {
    for (const overrides of [
      { model: "iPhone 0708", variant: null, location: "Cocody 091011" },
      { category: "Tél 07 08", brand: "Apple", model: "iPhone", variant: null, condition: "09 10 11", location: null },
      { brand: "Apple 07", model: "iPhone 08 09", variant: "10 11", location: null },
      { unit: "pièce 07 08 09", location: "10 11" },
      { condition: "Occasion 0708", unit: "lot 091011" },
    ]) {
      const refused = await create(overrides);
      assert.equal(refused.status, 400, `${JSON.stringify(overrides)} : ${refused.text}`);
      assert.equal(errorCode(refused), "phone_number_in_mission");
      for (const fragment of ["0708", "091011", "Cocody"]) assert.ok(!refused.text.includes(fragment), "la réponse ne répète jamais la valeur saisie");
    }
    assert.equal(await count(env.pool, "missions"), 0);
  });

  test("des textes honnêtes avec des chiffres passent : modèle, capacité, lieu, quantité par lot", async () => {
    for (const overrides of [
      { model: "iPhone 12", variant: "128 Go", location: "Cocody 2 Plateaux" },
      { brand: "Samsung", model: "Galaxy S21", variant: "256 Go 5G", location: "Yopougon Siporex" },
      { category: "Électroménager", brand: "LG", model: "GR-B459", variant: "450 L", condition: "Neuf", unit: "carton de 4" },
    ]) {
      const created = await create(overrides);
      assert.equal(created.status, 201, `${JSON.stringify(overrides)} : ${created.text}`);
    }
  });

  test("caractères invisibles refusés champ par champ (remplisseurs Hangul, braille vide, joint de graphème, sélecteur de variante, soft hyphen, ignorables) : aucune mission créée", async () => {
    const invisible: Array<[string, string]> = [
      ["U+3164 seul", "\u3164"], ["Apple + U+115F", "Apple\u115F"], ["Apple + U+1160", "Apple\u1160"], ["U+034F", "Ap\u034Fple"], ["U+FE0F", "Apple\uFE0F"], ["U+2800 braille vide", "\u2800"],
      ["U+FFA0", "\uFFA0"], ["U+2060", "Apple\u2060"], ["U+00AD", "App\u00ADle"], ["U+061C", "Apple\u061C"], ["U+180E", "Apple\u180E"], ["tag U+E0041", "Apple\u{E0041}"],
      ["U+200B", "App\u200Ble"], ["U+202E", "App\u202Ele"],
    ];
    for (const field of ["brand", "model", "category", "condition", "unit", "variant", "location"]) {
      for (const [name, value] of invisible) {
        const refused = await create({ [field]: value });
        assert.equal(refused.status, 400, `${field} ← ${name} : ${refused.text}`);
        assert.equal(errorCode(refused), "invalid_mission");
      }
    }
    assert.equal(await count(env.pool, "missions"), 0);
  });

  test("marque combinante isolée, champ sans lettre ni chiffre : refusés ; une lettre accentuée normale, composée ou décomposée, passe", async () => {
    for (const value of ["\u0301", " \u0301a", "a \u0301", "---", "...", "!?", "()", "\u2014"]) {
      const refused = await create({ brand: value });
      assert.equal(refused.status, 400, `« ${value} » : ${refused.text}`);
    }
    for (const value of ["Éclair", "E\u0301clair", "Ça va", "Çà"]) {
      const created = await create({ brand: value });
      assert.equal(created.status, 201, `« ${value} » : ${created.text}`);
    }
  });

  test("la base refuse les mêmes textes (écriture directe) : plages invisibles complètes, marques combinantes isolées, champ sans lettre ni chiffre ; elle accepte les accents", async () => {
    const insert = (brand: string, extra: { model?: string; variant?: string | null } = {}) =>
      env.pool.query(
        `INSERT INTO missions (owner_id, category, brand, model, variant, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days)
         VALUES ($1, 'smartphones', $2, $3, $4, 'good', 2, 'pièce', 1, 1, 30)`,
        [buyer.userId, brand, extra.model ?? "iPhone", extra.variant ?? null],
      );
    const refusedByBase: Array<[string, string]> = [
      ["U+2060", "Apple\u2060"], ["U+00AD", "App\u00ADle"], ["U+061C", "Apple\u061C"], ["U+180E", "Apple\u180E"], ["tag U+E0041", "Apple\u{E0041}"], ["U+034F", "Ap\u034Fple"],
      ["U+FE0F", "Apple\uFE0F"], ["U+115F", "Apple\u115F"], ["U+1160", "Apple\u1160"], ["U+3164", "Apple\u3164"], ["U+FFA0", "Apple\uFFA0"], ["U+2800", "Apple\u2800"],
      ["U+17B4", "Apple\u17B4"], ["U+1D173", "Apple\u{1D173}"], ["U+200B", "App\u200Ble"], ["U+2028", "App\u2028le"], ["U+0001", "App\u0001le"], ["U+009F", "App\u009Fle"],
    ];
    for (const [name, value] of refusedByBase) await assert.rejects(() => insert(value), /chk_missions_text_safe/, `la base accepte ${name}`);
    await assert.rejects(() => insert("\u0301"), /chk_missions_text_content|chk_missions_text_safe/, "marque combinante seule (aucune lettre ni chiffre non plus)");
    await assert.rejects(() => insert("Apple", { model: " \u0301a" }), /chk_missions_text_safe/, "marque combinante après une espace");
    await assert.rejects(() => insert("---"), /chk_missions_text_content/, "aucune lettre ni chiffre");
    await assert.rejects(() => insert("Apple", { model: "..." }), /chk_missions_text_content/);
    await assert.rejects(() => insert("Apple", { variant: "!!" }), /chk_missions_text_content/);
    await assert.rejects(() => insert("   "), /chk_missions_text_length|chk_missions_text_content/);
    await insert("Éclair");
    await insert("E\u0301clair");
    await insert("Çà", { model: "Galaxy S21", variant: "5G 128 Go" });
    assert.equal(await count(env.pool, "missions"), 3);
  });
});

describe("« Mes missions » : les ouvertes toujours en premier, puis les closes par pages avec un curseur", () => {
  /** `count` missions closes (annulées) plus récentes que tout le reste, écrites directement (le plafond de 20 créations par jour est celui de l'API). */
  async function insertMissions(owner: Login, count: number, status: "cancelled" | "draft" | "paused" | "active", startMinutes: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const closed = status === "cancelled";
      const inserted = await env.pool.query<{ id: string }>(
        `INSERT INTO missions (owner_id, status, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, deadline_days, closed_at, created_at)
         VALUES ($1, $2, 'smartphones', 'Apple', $3, 'good', 2, 'pièce', 1, 1, 30, ${closed ? "clock_timestamp()" : "NULL"}, clock_timestamp() + ($4::int * interval '1 minute')) RETURNING id`,
        [owner.userId, status, `iPhone ${status}-${index}`, startMinutes + index],
      );
      ids.push(inserted.rows[0].id);
    }
    return ids;
  }
  const page = async (cursor?: string | null) => {
    const answer = await reply(await h.missions.list(request("GET", "/api/missions", { cookie: buyer.cookie, ...(cursor ? { query: `?cursor=${cursor}` } : {}) })));
    assert.equal(answer.status, 200, answer.text);
    const body = answer.json as { missions: Array<{ id: string; status: string }>; nextCursor: string | null };
    return body;
  };

  test("une mission active plus ancienne que 120 missions closes plus récentes est TOUJOURS dans la première réponse, avec les autres ouvertes ; les closes suivent, 50 par page, sans doublon ni oubli", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 3 });
    const draft = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    const closed = await insertMissions(buyer, 120, "cancelled", 10);
    const first = await page();
    assert.equal(first.missions.length, 52, "2 ouvertes + une page de 50 closes");
    assert.deepEqual(first.missions.slice(0, 2).map((mission) => mission.status).sort(), ["active", "draft"]);
    assert.deepEqual(new Set(first.missions.slice(0, 2).map((mission) => mission.id)), new Set([live.id, draft]));
    assert.ok(first.missions.slice(2).every((mission) => mission.status === "cancelled"));
    assert.ok(first.nextCursor !== null);
    const seen = [...first.missions.map((mission) => mission.id)];
    let cursor: string | null = first.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const next = await page(cursor);
      assert.ok(next.missions.length >= 1 && next.missions.length <= 50);
      assert.ok(next.missions.every((mission) => mission.status === "cancelled"), "après les ouvertes, seulement des closes");
      seen.push(...next.missions.map((mission) => mission.id));
      cursor = next.nextCursor;
      pages += 1;
      assert.ok(pages <= 4, "pagination sans fin");
    }
    assert.equal(pages, 3, "122 missions : 52 + 50 + 20");
    assert.equal(seen.length, 122);
    assert.equal(new Set(seen).size, 122, "aucun doublon");
    assert.deepEqual(new Set(seen), new Set([live.id, draft, ...closed]), "aucune mission oubliée");
    // Les closes sont servies de la plus récente à la plus ancienne.
    assert.deepEqual(seen.slice(2), [...closed].reverse());
  });

  test("cas de l'audit (A7) : une mission active plus ancienne que 60 brouillons plus récents est dans la première réponse", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 3 });
    const drafts = await insertMissions(buyer, 60, "draft", 1);
    const closed = await insertMissions(buyer, 3, "cancelled", 500);
    const first = await page();
    assert.equal(first.missions.length, 64, "61 ouvertes puis les 3 closes : une seule réponse");
    assert.equal(first.nextCursor, null);
    assert.ok(first.missions.some((mission) => mission.id === live.id), "la mission active est listée");
    assert.ok(first.missions.slice(0, 61).every((mission) => mission.status === "draft" || mission.status === "active"));
    assert.deepEqual(new Set(first.missions.map((mission) => mission.id)), new Set([live.id, ...drafts, ...closed]));
  });

  test("plus de 200 missions ouvertes : elles viennent toutes avant la moindre mission close, par pages de 200 avec le curseur", async () => {
    const drafts = await insertMissions(buyer, 210, "draft", 1);
    const closed = await insertMissions(buyer, 5, "cancelled", 500);
    const first = await page();
    assert.equal(first.missions.length, 200);
    assert.ok(first.missions.every((mission) => mission.status === "draft"));
    assert.ok(first.nextCursor !== null);
    const second = await page(first.nextCursor);
    assert.deepEqual(second.missions.map((mission) => mission.status), [...Array(10).fill("draft"), ...Array(5).fill("cancelled")]);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(new Set([...first.missions, ...second.missions].map((mission) => mission.id)), new Set([...drafts, ...closed]));
  });

  test("exactement 200 ouvertes puis des closes : une réponse ; 120 closes sans ouverte : 50 par page ; une liste courte n'a pas de curseur", async () => {
    await insertMissions(buyer, 200, "draft", 1);
    await insertMissions(buyer, 3, "cancelled", 300);
    const only = await page();
    assert.equal(only.missions.length, 203);
    assert.equal(only.nextCursor, null);
    await resetSocial(env.pool);
    buyer = await login(env.pool);
    await insertMissions(buyer, 120, "cancelled", 1);
    const sizes: number[] = [];
    let cursor: string | null | undefined;
    do {
      const current = await page(cursor);
      sizes.push(current.missions.length);
      cursor = current.nextCursor;
      assert.ok(sizes.length <= 5, `pagination sans fin : ${sizes.join(", ")}`);
    } while (cursor);
    assert.deepEqual(sizes, [50, 50, 20]);
    await resetSocial(env.pool);
    buyer = await login(env.pool);
    await insertMissions(buyer, 3, "cancelled", 1);
    const small = await page();
    assert.equal(small.missions.length, 3);
    assert.equal(small.nextCursor, null);
  });

  test("curseur invalide ou autre paramètre : 400 ; le curseur d'un autre acheteur ne montre jamais ses missions", async () => {
    await insertMissions(buyer, 60, "cancelled", 1);
    const first = await page();
    for (const query of ["?cursor=%%%", "?cursor=", "?cursor=abc", `?cursor=${"A".repeat(200)}`, "?limit=5", "?cursor=" + (first.nextCursor ?? "") + "&x=1", "?cursor=" + (first.nextCursor ?? "") + "&cursor=" + (first.nextCursor ?? "")]) {
      const answer = await reply(await h.missions.list(request("GET", "/api/missions", { cookie: buyer.cookie, query })));
      assert.equal(answer.status, 400, `${query} : ${answer.text}`);
    }
    // Un curseur ne désigne qu'une position : lu par un autre acheteur, il ne sert que SES missions.
    const other = await login(env.pool);
    await insertMissions(other, 2, "cancelled", 1);
    const answer = await reply(await h.missions.list(request("GET", "/api/missions", { cookie: other.cookie, query: `?cursor=${first.nextCursor}` })));
    assert.equal(answer.status, 200);
    const ids = new Set(((answer.json as { missions: Array<{ id: string }> }).missions).map((mission) => mission.id));
    const mine = new Set((await env.pool.query<{ id: string }>("SELECT id FROM missions WHERE owner_id = $1", [buyer.userId])).rows.map((row) => row.id));
    for (const id of ids) assert.ok(!mine.has(id));
  });
});

describe("échéance : pause et reprise refusées, mission terminée à l'échéance", () => {
  test("une mission dont l'échéance est passée ne se met plus en pause ni ne reprend (409), avant même que l'étape ne l'ait marquée échue", async () => {
    const live = await startMission(env.pool, h, buyer);
    await makeDue(env.pool, live.id);
    const pause = await actMissionCall(h, buyer.cookie, live.id, "pause");
    assert.equal(pause.status, 409);
    assert.equal(errorCode(pause), "mission_state_conflict");
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, live.id)).status, "active");
    const cancel = await actMissionCall(h, buyer.cookie, live.id, "cancel");
    assert.equal(cancel.status, 200, "annuler reste possible");
  });
});
