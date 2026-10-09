import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_INVALID_RESPONSE, ApiError, BUYER_HOME_CONTRACT_VERSION, NOTIFICATIONS_CONTRACT_VERSION, NOTIFICATION_KINDS, createApiClient } from "../../lib/client/api";
import { notificationView } from "../../lib/client/home-view";
import { notificationRow } from "../../lib/client/notifications-view";

/** Écrans des notifications et de l'accueil pour les deux genres de la recherche active (lot RA1) : lecture stricte, lignes, accueil. */

const DEMAND_ID = "22222222-2222-4222-8222-222222222222";
const NOTIF_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const SECOND_ID = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";

function harness(body: unknown, status = 200) {
  const fakeFetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  return createApiClient({ fetch: fakeFetch });
}
const externalDto = (overrides: Record<string, unknown> = {}) => ({
  id: NOTIF_ID, kind: "new_external_match", title: "iPhone 12 128 Go violet", price: { amount: 139_000, currency: "XOF" }, count: null, demandId: DEMAND_ID, offerId: null, link: `/besoins/${DEMAND_ID}`,
  createdAt: "2031-01-01T10:00:00.000Z", readAt: null, sourceName: "Annonces Démo A", ...overrides,
});
const expiringDto = (overrides: Record<string, unknown> = {}) => ({
  id: SECOND_ID, kind: "active_search_expiring", title: null, price: null, count: null, demandId: DEMAND_ID, offerId: null, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T11:00:00.000Z", readAt: null,
  endsAt: "2031-02-01T10:00:00.000Z", ...overrides,
});
const page = (items: unknown[]) => ({ contractVersion: NOTIFICATIONS_CONTRACT_VERSION, unreadCount: items.length, items, nextCursor: null });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  throw new Error("la requête aurait dû être refusée");
}

describe("lecture stricte des deux nouveaux genres", () => {
  test("les genres sont connus du client", () => {
    assert.deepEqual([...NOTIFICATION_KINDS].sort(), ["active_search_expiring", "mission_coverage", "new_external_match", "new_match", "new_matches_digest", "new_message"]);
  });

  test("annonce d'un autre site : titre, prix, nom de la source, lien du BESOIN ; avis d'échéance : la fin de l'option, rien d'autre", async () => {
    const result = await harness(page([externalDto(), expiringDto()])).notifications.list({});
    const [external, expiring] = result.items;
    assert.deepEqual([external.kind, external.title, external.sourceName, external.offerId, external.link, external.price], ["new_external_match", "iPhone 12 128 Go violet", "Annonces Démo A", null, `/besoins/${DEMAND_ID}`, { amount: 139_000, currency: "XOF" }]);
    assert.deepEqual([expiring.kind, expiring.title, expiring.price, expiring.endsAt, expiring.link], ["active_search_expiring", null, null, "2031-02-01T10:00:00.000Z", `/besoins/${DEMAND_ID}`]);
    assert.equal("sourceName" in expiring, false);
    assert.equal("endsAt" in external, false);
  });

  test("refusées : lien externe ou autre que la page du besoin, nom de source absent ou piégé, titre piégé, annonce interne liée, avis sans date ou avec un titre", async () => {
    const bad: Array<[string, Record<string, unknown>[]]> = [
      ["lien externe", [externalDto({ link: "https://annonces-demo-a.example/annonce/1" })]],
      ["lien d'un autre besoin", [externalDto({ link: "/besoins/33333333-3333-4333-8333-333333333333" })]],
      ["lien de fiche", [externalDto({ link: `/besoins/${DEMAND_ID}/offres/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c` })]],
      ["sans nom de source", [externalDto({ sourceName: undefined })]],
      ["nom de source vide", [externalDto({ sourceName: "" })]],
      ["nom de source avec contrôle", [externalDto({ sourceName: "Source‮" })]],
      ["titre vide", [externalDto({ title: "" })]],
      ["titre avec direction", [externalDto({ title: "iPhone‮" })]],
      ["titre trop long", [externalDto({ title: "x".repeat(161) })]],
      ["annonce interne liée", [externalDto({ offerId: "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c" })]],
      ["compte de résumé", [externalDto({ count: 3 })]],
      ["avis sans fin", [expiringDto({ endsAt: undefined })]],
      ["avis avec fin illisible", [expiringDto({ endsAt: "bientôt" })]],
      ["avis avec titre", [expiringDto({ title: "iPhone 12" })]],
      ["avis avec prix", [expiringDto({ price: { amount: 1, currency: "XOF" } })]],
      ["avis avec lien externe", [expiringDto({ link: "https://evil.example" })]],
    ];
    for (const [label, items] of bad) {
      const error = await rejection(harness(page(items)).notifications.list({}));
      assert.equal(error.code, API_INVALID_RESPONSE, label);
    }
  });

  test("l'accueil accepte les deux genres (lien interne du besoin) et refuse un genre inconnu", async () => {
    const home = (notifications: unknown[]) => ({
      contractVersion: BUYER_HOME_CONTRACT_VERSION, activeDemandCount: 0, demands: [], unreadNotifications: notifications.length, notifications, readAt: "2031-01-01T11:00:00.000Z",
    });
    const entry = (id: string, kind: string, title: string | null, price: unknown) => ({ id, kind, title, price, count: null, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T10:00:00.000Z", unread: true });
    const loaded = await harness(home([entry(NOTIF_ID, "new_external_match", "iPhone 12", { amount: 139_000, currency: "XOF" }), entry(SECOND_ID, "active_search_expiring", null, null)])).home.buyer();
    assert.deepEqual(loaded.notifications.map((item) => item.kind), ["new_external_match", "active_search_expiring"]);
    const unknown = await rejection(harness(home([entry(NOTIF_ID, "autre_genre", "x", null)])).home.buyer());
    assert.equal(unknown.code, API_INVALID_RESPONSE);
  });
});

describe("lignes de la page « Notifications »", () => {
  const item = (dto: Record<string, unknown>) => harness(page([dto])).notifications.list({}).then((result) => result.items[0]);

  test("annonce d'un autre site : titre, « prix · source, autre site », pastille « Autre site », lien « Voir mon besoin » vers la page du besoin", async () => {
    const row = notificationRow(await item(externalDto()));
    assert.equal(row.title, "iPhone 12 128 Go violet");
    assert.equal(row.subtitle?.replace(/[  ]/g, " "), "139 000 FCFA · Annonces Démo A, autre site");
    assert.deepEqual([row.badge, row.linkLabel, row.href, row.unread, row.kind], ["Autre site", "Voir mon besoin", `/besoins/${DEMAND_ID}`, true, "new_external_match"]);
  });

  test("avis d'échéance : « se termine le … », conseil de prolonger, pastille « Recherche active », lien vers le besoin", async () => {
    const row = notificationRow(await item(expiringDto({ readAt: "2031-01-02T00:00:00.000Z" })));
    assert.equal(row.title, "Votre recherche active se termine le 01/02/2031");
    assert.equal(row.subtitle, "Prolongez-la pour continuer à être prévenu des annonces d'autres sites.");
    assert.deepEqual([row.badge, row.href, row.unread], ["Recherche active", `/besoins/${DEMAND_ID}`, false]);
  });

  test("jamais l'adresse d'une annonce externe : le lien est reconstruit depuis l'identifiant du besoin ; identifiant illisible → aucun lien", async () => {
    const tampered = { ...(await item(externalDto())), link: "https://annonces-demo-a.example/annonce/1" };
    assert.equal(notificationRow(tampered).href, `/besoins/${DEMAND_ID}`);
    assert.equal(notificationRow({ ...tampered, demandId: "pas-un-uuid" }).href, null);
  });

  test("les genres existants ne changent pas : aucune pastille", async () => {
    const match = await item({
      id: NOTIF_ID, kind: "new_match", title: "Apple iPhone 12", price: { amount: 150_000, currency: "XOF" }, count: null, demandId: DEMAND_ID, offerId: "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
      link: `/besoins/${DEMAND_ID}/offres/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c`, createdAt: "2031-01-01T10:00:00.000Z", readAt: null,
    });
    assert.equal("badge" in notificationRow(match), false);
  });
});

describe("accueil de l'acheteur", () => {
  test("annonce d'un autre site : « Autre site : titre » et le prix ; avis d'échéance : « Votre recherche active se termine bientôt », sans prix", () => {
    const external = notificationView({ id: NOTIF_ID, kind: "new_external_match", title: "iPhone 12 128 Go violet", price: { amount: 139_000, currency: "XOF" }, count: null, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T10:00:00.000Z", unread: true });
    assert.equal(external.title, "Autre site : iPhone 12 128 Go violet");
    assert.equal(external.subtitle?.replace(/[  ]/g, " "), "139 000 FCFA");
    assert.equal(external.href, `/besoins/${DEMAND_ID}`);
    const expiring = notificationView({ id: SECOND_ID, kind: "active_search_expiring", title: null, price: null, count: null, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T10:00:00.000Z", unread: false });
    assert.deepEqual([expiring.title, expiring.subtitle, expiring.unread], ["Votre recherche active se termine bientôt", null, false]);
    const untitled = notificationView({ id: NOTIF_ID, kind: "new_external_match", title: null, price: null, count: null, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T10:00:00.000Z", unread: true });
    assert.equal(untitled.title, "Autre site : nouvelle annonce");
  });
});

// ═════════════ Intégration avec les missions (lot MV1) : les trois nouveaux genres ensemble ═════════════

describe("missions et recherche active ensemble (intégration des lots MV1 et RA1)", () => {
  const MISSION_ID = "33333333-3333-4333-8333-333333333333";
  const THIRD_ID = "2b2b2b2b-3c3c-4d4d-8e5e-6f6f6f6f6f6f";
  const coverageDto = (overrides: Record<string, unknown> = {}) => ({
    id: THIRD_ID, kind: "mission_coverage", title: "Apple iPhone 12 : 7 sur 20", price: null, count: 7, demandId: DEMAND_ID, offerId: null, link: `/missions/${MISSION_ID}`,
    createdAt: "2031-01-01T12:00:00.000Z", readAt: null, ...overrides,
  });

  test("une même page porte la couverture d'une mission, une annonce d'un autre site et un avis d'échéance : chaque genre garde sa forme et son lien", async () => {
    const result = await harness(page([coverageDto(), externalDto(), expiringDto()])).notifications.list({});
    assert.deepEqual(result.items.map((item) => [item.kind, item.link]), [
      ["mission_coverage", `/missions/${MISSION_ID}`],
      ["new_external_match", `/besoins/${DEMAND_ID}`],
      ["active_search_expiring", `/besoins/${DEMAND_ID}`],
    ]);
    assert.deepEqual([result.items[0].count, result.items[0].sourceName, result.items[0].endsAt], [7, undefined, undefined]);
    const rows = result.items.map(notificationRow);
    assert.deepEqual(rows.map((row) => [row.kind, row.badge ?? null, row.href]), [
      ["mission_coverage", null, `/missions/${MISSION_ID}`],
      ["new_external_match", "Autre site", `/besoins/${DEMAND_ID}`],
      ["active_search_expiring", "Recherche active", `/besoins/${DEMAND_ID}`],
    ]);
    assert.equal(rows[0].title, "Mission : Apple iPhone 12 : 7 sur 20");
  });

  test("les liens ne se croisent pas : la couverture d'une mission ne mène jamais à un besoin, les genres de la recherche active ne mènent jamais à une mission", async () => {
    for (const bad of [coverageDto({ link: `/besoins/${DEMAND_ID}` }), coverageDto({ link: "https://annonces-demo-a.example/annonce/x" }), coverageDto({ count: null })]) {
      assert.equal((await rejection(harness(page([bad])).notifications.list({}))).code, API_INVALID_RESPONSE, JSON.stringify(bad).slice(0, 80));
    }
    for (const bad of [externalDto({ link: `/missions/${MISSION_ID}` }), expiringDto({ link: `/missions/${MISSION_ID}` })]) {
      assert.equal((await rejection(harness(page([bad])).notifications.list({}))).code, API_INVALID_RESPONSE, JSON.stringify(bad).slice(0, 80));
    }
  });

  test("l'accueil accepte les trois genres (liens internes) et en affiche chacun à sa façon", async () => {
    const home = (notifications: unknown[]) => ({
      contractVersion: BUYER_HOME_CONTRACT_VERSION, activeDemandCount: 0, demands: [], unreadNotifications: notifications.length, notifications, readAt: "2031-01-01T13:00:00.000Z",
    });
    const entry = (id: string, kind: string, title: string | null, count: number | null, link: string) => ({ id, kind, title, price: null, count, link, createdAt: "2031-01-01T10:00:00.000Z", unread: true });
    const loaded = await harness(home([
      entry(THIRD_ID, "mission_coverage", "Apple iPhone 12 : 7 sur 20", 7, `/missions/${MISSION_ID}`),
      entry(NOTIF_ID, "new_external_match", "iPhone 12", null, `/besoins/${DEMAND_ID}`),
      entry(SECOND_ID, "active_search_expiring", null, null, `/besoins/${DEMAND_ID}`),
    ])).home.buyer();
    assert.deepEqual(loaded.notifications.map((item) => item.kind), ["mission_coverage", "new_external_match", "active_search_expiring"]);
    assert.deepEqual(loaded.notifications.map((item) => notificationView(item).title), ["Mission : Apple iPhone 12 : 7 sur 20", "Autre site : iPhone 12", "Votre recherche active se termine bientôt"]);
    assert.deepEqual(loaded.notifications.map((item) => notificationView(item).href), [`/missions/${MISSION_ID}`, `/besoins/${DEMAND_ID}`, `/besoins/${DEMAND_ID}`]);
    assert.equal((await rejection(harness(home([entry(NOTIF_ID, "autre_genre", "x", null, `/besoins/${DEMAND_ID}`)])).home.buyer())).code, API_INVALID_RESPONSE);
  });
});
