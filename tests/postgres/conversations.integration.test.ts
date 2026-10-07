import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "pg";
import { listNotifications } from "../../lib/server/notifications/inbox";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import { MESSAGES_PER_DAY, MESSAGES_PER_MINUTE, NEW_CONVERSATIONS_PER_DAY } from "../../lib/server/social/config";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { makeMatch, makeOffer } from "./metrics-fixtures";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Messagerie (lot D2) : ouverture par l'acheteur seulement, réponse du vendeur, 404 indiscernable pour un tiers, corps refusés, limites (30 par minute, 300 par jour, 20
 * conversations par jour), non-lus et notification regroupée, NOTIFY sans texte, journal immuable.
 */

let env: TestSchema;
let handlers: SocialHttpHandlers;
let market: Market;
let stranger: Login;

before(async () => {
  env = await openTestSchema();
  handlers = createSocialHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  market = await makeMarket(env.pool);
});

type Json = Record<string, unknown>;
const open = async (m: Market, cookie: string | null = m.buyer.cookie, offerId = m.offer.id, demandId = m.demand.id) =>
  reply(await handlers.conversations.open(request("POST", `/api/demands/${demandId}/offers/${offerId}/conversation`, { cookie }), demandId, offerId));
const send = async (conversationId: string, cookie: string | null, body: unknown) =>
  reply(await handlers.conversations.send(request("POST", `/api/conversations/${conversationId}/messages`, { cookie, body: { body } }), conversationId));
const messages = async (conversationId: string, cookie: string | null, query = "") =>
  reply(await handlers.conversations.messages(request("GET", `/api/conversations/${conversationId}/messages`, { cookie, query }), conversationId));
const list = async (cookie: string | null) => reply(await handlers.conversations.list(request("GET", "/api/conversations", { cookie })));
const detail = async (conversationId: string, cookie: string | null) => reply(await handlers.conversations.detail(request("GET", `/api/conversations/${conversationId}`, { cookie }), conversationId));
const markRead = async (conversationId: string, cookie: string | null, body: unknown = {}) =>
  reply(await handlers.conversations.read(request("POST", `/api/conversations/${conversationId}/read`, { cookie, body }), conversationId));
const unread = async (cookie: string | null) => reply(await handlers.conversations.unread(request("GET", "/api/conversations/unread", { cookie })));
const conversationId = (answer: { json: unknown }): string => ((answer.json as Json).conversation as { id: string }).id;

/** Vieillit des messages : l'immuabilité des messages est levée le temps de l'opération (elle protège le code applicatif, pas l'administrateur de la base). */
async function shiftMessages(senderId: string, interval: string): Promise<void> {
  await env.pool.query("ALTER TABLE messages DISABLE TRIGGER trg_messages_immutable");
  try {
    await env.pool.query(`UPDATE messages SET created_at = created_at - interval '${interval}' WHERE sender_id = $1`, [senderId]);
  } finally {
    await env.pool.query("ALTER TABLE messages ENABLE TRIGGER trg_messages_immutable");
  }
}

async function openAndWrite(m: Market, text = "Bonjour"): Promise<string> {
  const id = conversationId(await open(m));
  assert.equal((await send(id, m.buyer.cookie, text)).status, 201);
  return id;
}

test("l'acheteur qui a la correspondance ouvre la conversation : 201 puis 200 (la même), aucune écriture de message", async () => {
  const first = await open(market);
  assert.equal(first.status, 201);
  assert.equal((first.json as Json).created, true);
  const second = await open(market);
  assert.equal(second.status, 200);
  assert.equal(conversationId(second), conversationId(first));
  assert.equal(await count(env.pool, "conversations"), 1);
  assert.equal(await count(env.pool, "messages"), 0);
  const row = (await env.pool.query("SELECT buyer_id, seller_id, demand_id, offer_id FROM conversations")).rows[0];
  assert.equal(row.buyer_id, market.buyer.userId);
  assert.equal(row.seller_id, market.seller.userId);
});

test("le vendeur n'ouvre JAMAIS une conversation ; un tiers, un besoin inconnu, une annonce hors correspondance : le même 404, rien n'est écrit", async () => {
  const unmatched = await makeOffer(env.pool, market.seller.userId);
  const refused = [
    await open(market, market.seller.cookie),
    await open(market, stranger.cookie),
    await open(market, market.buyer.cookie, unmatched.id),
    await open(market, market.buyer.cookie, market.offer.id, stranger.userId),
  ];
  for (const answer of refused) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.json, NOT_FOUND);
  }
  assert.equal(await count(env.pool, "conversations"), 0);
  assert.equal((await open(market, null)).status, 401);
});

test("annonce retirée de la vente : ouverture refusée (409), la conversation déjà ouverte reste lisible et écrivable par ses participants", async () => {
  const id = await openAndWrite(market);
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  const answer = await open(market);
  assert.equal(answer.status, 409);
  assert.deepEqual(answer.json, { error: { code: "offer_not_available", message: "Cette annonce n'est plus disponible." } });
  assert.equal((await messages(id, market.buyer.cookie)).status, 200);
  assert.equal((await send(id, market.seller.cookie, "Toujours là ?")).status, 201);
  const summary = ((await list(market.buyer.cookie)).json as { items: Array<Json> }).items[0];
  assert.equal(summary.available, false);
});

test("le vendeur ne voit la conversation qu'à partir du premier message, puis répond ; l'autre partie est désignée par son rôle, jamais par son identité", async () => {
  const id = conversationId(await open(market));
  assert.deepEqual(((await list(market.seller.cookie)).json as { items: unknown[] }).items, [], "rien à répondre tant que l'acheteur n'a rien écrit");
  assert.equal((await send(id, market.buyer.cookie, "Bonjour, l'iPhone est-il toujours disponible ?")).status, 201);
  const sellerList = await list(market.seller.cookie);
  const row = (sellerList.json as { items: Array<Json> }).items[0];
  assert.equal(row.role, "seller");
  assert.equal(row.demandId, null, "le vendeur ne connaît pas le besoin de l'acheteur");
  assert.equal(row.unreadCount, 1);
  assert.deepEqual(row.lastMessage, { body: "Bonjour, l'iPhone est-il toujours disponible ?", mine: false, createdAt: (row.lastMessage as Json).createdAt });
  assert.ok(!sellerList.text.includes(market.buyer.userId) && !sellerList.text.includes(market.buyer.phone));
  assert.equal((await send(id, market.seller.cookie, "Oui, il est disponible.")).status, 201);
  const buyerRow = ((await list(market.buyer.cookie)).json as { items: Array<Json> }).items[0];
  assert.equal(buyerRow.role, "buyer");
  assert.equal(buyerRow.demandId, market.demand.id);
  assert.equal(buyerRow.unreadCount, 1);
  const buyerList = await list(market.buyer.cookie);
  assert.ok(!buyerList.text.includes(market.seller.userId) && !buyerList.text.includes(market.seller.phone));
  const thread = ((await messages(id, market.buyer.cookie)).json as { messages: Array<Json> }).messages;
  assert.deepEqual(thread.map((m) => [m.mine, m.body]), [[true, "Bonjour, l'iPhone est-il toujours disponible ?"], [false, "Oui, il est disponible."]]);
  const detailDto = ((await detail(id, market.seller.cookie)).json as { conversation: Json }).conversation;
  assert.equal(detailDto.demandId, null);
  assert.equal(detailDto.role, "seller");
  assert.equal(detailDto.canDeclareOrder, false);
});

test("un tiers reçoit le même 404 que pour une conversation inexistante, sur CHAQUE route (détail, messages, envoi, lecture), et n'écrit rien", async () => {
  const id = await openAndWrite(market, "secret entre nous");
  const missing = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  const attempts: Array<(target: string) => Promise<{ status: number; json: unknown; text: string }>> = [
    (target) => detail(target, stranger.cookie),
    (target) => messages(target, stranger.cookie),
    (target) => messages(target, stranger.cookie, "?after=0"),
    (target) => send(target, stranger.cookie, "intrusion"),
    (target) => markRead(target, stranger.cookie),
  ];
  for (const attempt of attempts) {
    const foreign = await attempt(id);
    const unknown = await attempt(missing);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, NOT_FOUND);
    assert.equal(foreign.text, unknown.text, "indiscernable d'une conversation inexistante");
    assert.ok(!foreign.text.includes("secret"));
  }
  assert.equal(await count(env.pool, "messages"), 1);
  assert.equal(((await list(stranger.cookie)).json as { items: unknown[] }).items.length, 0);
});

test("corps refusés : vide, espaces, trop long, caractère de contrôle, de direction ou invisible, non-texte ; 1000 caractères passent ; les sauts de ligne deviennent un espace", async () => {
  const id = conversationId(await open(market));
  const refused = ["", "   \n\t ", "x".repeat(1001), "bonjour\u0007", "texte‮inversé", "zéro​largeur", " ", 42, null, { a: 1 }];
  for (const body of refused) {
    const answer = await send(id, market.buyer.cookie, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(answer.json, { error: { code: body === 42 || body === null || typeof body === "object" ? "invalid_request" : "invalid_message", message: body === 42 || body === null || typeof body === "object" ? "Requête invalide." : "Ce message n'est pas valide." } });
  }
  assert.equal(await count(env.pool, "messages"), 0, "aucun refus n'écrit");
  assert.equal((await send(id, market.buyer.cookie, "é".repeat(1000))).status, 201);
  const multi = await send(id, market.buyer.cookie, "  première ligne\r\nseconde\n\n  fin  ");
  assert.equal(multi.status, 201);
  assert.equal(((multi.json as Json).message as Json).body, "première ligne seconde fin");
  // Corps JSON invalide, champ en trop, objet absent.
  assert.equal((await reply(await handlers.conversations.send(request("POST", `/api/conversations/${id}/messages`, { cookie: market.buyer.cookie, rawBody: "{pas du json" }), id))).status, 400);
  assert.equal((await reply(await handlers.conversations.send(request("POST", `/api/conversations/${id}/messages`, { cookie: market.buyer.cookie, body: { body: "a", extra: 1 } }), id))).status, 400);
});

test("le texte HTML n'est jamais interprété : il est stocké et servi tel quel (texte), un numéro de téléphone n'est PAS bloqué", async () => {
  const id = conversationId(await open(market));
  const html = `<img src=x onerror="alert(1)"><script>alert('x')</script>`;
  const answer = await send(id, market.buyer.cookie, html);
  assert.equal(answer.status, 201);
  assert.equal(((answer.json as Json).message as Json).body, html);
  assert.equal((await env.pool.query("SELECT body FROM messages")).rows[0].body, html);
  const phone = await send(id, market.seller.cookie, "Appelez-moi au 07 08 09 10 11 ou +225 05 44 33 22 11");
  assert.equal(phone.status, 201, "le contact direct est voulu");
  assert.equal(((phone.json as Json).message as Json).body, "Appelez-moi au 07 08 09 10 11 ou +225 05 44 33 22 11");
});

test(`limite de ${MESSAGES_PER_MINUTE} messages par minute et par utilisateur : le suivant reçoit 429 avec Retry-After ; l'autre participant n'est pas touché`, async () => {
  const id = conversationId(await open(market));
  for (let index = 1; index <= MESSAGES_PER_MINUTE; index += 1) assert.equal((await send(id, market.buyer.cookie, `message ${index}`)).status, 201, `message ${index}`);
  const refused = await send(id, market.buyer.cookie, "trop");
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.json, { error: { code: "rate_limited", message: "Trop de demandes : réessayez plus tard." } });
  const retry = Number(refused.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${retry}`);
  assert.equal(await count(env.pool, "messages"), MESSAGES_PER_MINUTE, "le refus n'écrit rien");
  assert.equal((await send(id, market.seller.cookie, "réponse du vendeur")).status, 201, "la limite est PAR utilisateur");
  // Une minute plus tard : permis de nouveau.
  await shiftMessages(market.buyer.userId, "61 seconds");
  assert.equal((await send(id, market.buyer.cookie, "de nouveau")).status, 201);
});

test(`limite de ${MESSAGES_PER_DAY} messages par jour UTC et par utilisateur : 429 avec un Retry-After vers minuit UTC`, async () => {
  const id = conversationId(await open(market));
  // 300 messages du jour, écrits à minuit pile (hors de la fenêtre d'une minute).
  await env.pool.query(
    `INSERT INTO messages (conversation_id, sender_id, body, created_at)
     SELECT $1::uuid, $2::uuid, 'ancien ' || g, date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' FROM generate_series(1, $3::int) g`,
    [id, market.buyer.userId, MESSAGES_PER_DAY],
  );
  const refused = await send(id, market.buyer.cookie, "le 301e");
  assert.equal(refused.status, 429);
  const retry = Number(refused.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 86_400, `Retry-After ${retry}`);
  assert.equal(await count(env.pool, "messages"), MESSAGES_PER_DAY);
  assert.equal((await send(id, market.seller.cookie, "le vendeur écrit")).status, 201);
  // La veille ne compte pas.
  await shiftMessages(market.buyer.userId, "1 day");
  assert.equal((await send(id, market.buyer.cookie, "nouveau jour")).status, 201);
});

test(`limite de ${NEW_CONVERSATIONS_PER_DAY} nouvelles conversations par jour et par acheteur : 429 ; une conversation déjà ouverte se retrouve toujours`, async () => {
  const existing = conversationId(await open(market));
  // 19 conversations de plus du jour (annonces brutes du même vendeur), insérées directement.
  await env.pool.query(
    `INSERT INTO offers (id, owner_id, status, raw_text) SELECT gen_random_uuid(), $1::uuid, 'published', 'filler ' || g FROM generate_series(1, $2::int) g`,
    [market.seller.userId, NEW_CONVERSATIONS_PER_DAY - 1],
  );
  await env.pool.query(
    `INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id)
     SELECT $1::uuid, o.id, $2::uuid, $3::uuid FROM offers o WHERE o.raw_text LIKE 'filler %'`,
    [market.demand.id, market.buyer.userId, market.seller.userId],
  );
  assert.equal(await count(env.pool, "conversations", `buyer_id = '${market.buyer.userId}'`), NEW_CONVERSATIONS_PER_DAY);
  const second = await makeOffer(env.pool, market.seller.userId);
  await makeMatch(env.pool, second, market.demand);
  const refused = await open(market, market.buyer.cookie, second.id);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  assert.equal(await count(env.pool, "conversations"), NEW_CONVERSATIONS_PER_DAY, "le refus n'écrit rien");
  const again = await open(market);
  assert.equal(again.status, 200);
  assert.equal(conversationId(again), existing);
  // Le lendemain : permis.
  await env.pool.query("UPDATE conversations SET created_at = created_at - interval '1 day'");
  assert.equal((await open(market, market.buyer.cookie, second.id)).status, 201);
});

test("non-lus : compteur par conversation, « marquer comme lu » ne recule jamais, la pastille compte les conversations non lues", async () => {
  const id = await openAndWrite(market, "un");
  await send(id, market.buyer.cookie, "deux");
  assert.equal(((await unread(market.seller.cookie)).json as Json).unreadCount, 1, "une conversation non lue, quel que soit le nombre de messages");
  assert.equal(((await unread(market.buyer.cookie)).json as Json).unreadCount, 0, "l'expéditeur a lu ses propres messages");
  const page = ((await messages(id, market.seller.cookie)).json as { messages: Array<{ id: number }> }).messages;
  assert.equal(((await list(market.seller.cookie)).json as { items: Array<Json> }).items[0].unreadCount, 2);
  const firstId = page[0].id;
  assert.equal(((await markRead(id, market.seller.cookie, { upToId: firstId })).json as Json).unreadCount, 1, "lu jusqu'au premier : il en reste un");
  assert.equal(((await list(market.seller.cookie)).json as { items: Array<Json> }).items[0].unreadCount, 1);
  assert.equal(((await markRead(id, market.seller.cookie, { upToId: 0 })).json as Json).unreadCount, 1, "ne recule jamais");
  assert.equal(((await markRead(id, market.seller.cookie, { upToId: 10 ** 9 })).json as Json).unreadCount, 0, "borné au dernier message");
  assert.equal(((await list(market.seller.cookie)).json as { items: Array<Json> }).items[0].unreadCount, 0);
  assert.equal(((await markRead(id, market.seller.cookie, { upToId: -1 })).status), 400);
  assert.equal(((await markRead(id, market.seller.cookie, { nope: 1 })).status), 400);
  // Un message de l'autre côté redevient non lu pour l'acheteur seulement.
  await send(id, market.seller.cookie, "réponse");
  assert.equal(((await unread(market.buyer.cookie)).json as Json).unreadCount, 1);
  assert.equal(((await unread(market.seller.cookie)).json as Json).unreadCount, 0);
});

test("messages après l'id X (rattrapage), page et hasMore", async () => {
  const id = conversationId(await open(market));
  for (let index = 1; index <= 7; index += 1) await send(id, index % 2 ? market.buyer.cookie : market.seller.cookie, `m${index}`);
  const all = (await messages(id, market.buyer.cookie)).json as { messages: Array<{ id: number; body: string }>; hasMore: boolean };
  assert.deepEqual(all.messages.map((m) => m.body), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(all.hasMore, false);
  const after3 = (await messages(id, market.buyer.cookie, `?after=${all.messages[2].id}`)).json as { messages: Array<{ body: string }>; hasMore: boolean };
  assert.deepEqual(after3.messages.map((m) => m.body), ["m4", "m5", "m6", "m7"]);
  const small = (await messages(id, market.buyer.cookie, `?after=${all.messages[0].id}&limit=2`)).json as { messages: Array<{ body: string }>; hasMore: boolean };
  assert.deepEqual(small.messages.map((m) => m.body), ["m2", "m3"]);
  assert.equal(small.hasMore, true);
  const last = (await messages(id, market.buyer.cookie, "?limit=3")).json as { messages: Array<{ body: string }>; hasMore: boolean };
  assert.deepEqual(last.messages.map((m) => m.body), ["m5", "m6", "m7"]);
  assert.equal(last.hasMore, true);
  const none = (await messages(id, market.buyer.cookie, `?after=${all.messages[6].id}`)).json as { messages: unknown[] };
  assert.deepEqual(none.messages, []);
  for (const query of ["?after=-1", "?after=abc", "?limit=0", "?limit=101", "?after=1&after=2", "?zzz=1"]) {
    assert.equal((await messages(id, market.buyer.cookie, query)).status, 400, query);
  }
});

test("notification « nouveau message » : une seule par conversation tant qu'elle n'est pas lue, jamais le texte, lue avec la conversation, nouvelle ensuite", async () => {
  const id = await openAndWrite(market, "texte confidentiel du message");
  await send(id, market.buyer.cookie, "encore un message");
  await send(id, market.buyer.cookie, "et un troisième");
  const sellerNotifications = await listNotifications({ pool: env.pool, userId: market.seller.userId });
  const items = sellerNotifications.items.filter((item) => item.kind === "new_message");
  assert.equal(items.length, 1, "une par conversation tant qu'elle n'est pas lue");
  assert.equal(items[0].title, "Apple iPhone 13 128 Go");
  assert.equal(items[0].link, `/messages/${id}`);
  assert.equal(items[0].offerId, null);
  assert.equal(items[0].price, null);
  assert.equal(items[0].readAt, null);
  assert.equal(sellerNotifications.unreadCount, 1);
  assert.ok(!JSON.stringify(sellerNotifications).includes("confidentiel"));
  assert.equal((await listNotifications({ pool: env.pool, userId: market.buyer.userId })).items.length, 0, "l'expéditeur n'est pas notifié");
  await markRead(id, market.seller.cookie);
  assert.notEqual((await listNotifications({ pool: env.pool, userId: market.seller.userId })).items[0].readAt, null, "lue avec la conversation");
  await send(id, market.buyer.cookie, "après lecture");
  const after = await listNotifications({ pool: env.pool, userId: market.seller.userId });
  assert.equal(after.items.filter((item) => item.kind === "new_message").length, 2, "une nouvelle notification après la lecture");
  assert.equal(after.unreadCount, 1);
  // Réponse du vendeur : l'acheteur est notifié à son tour.
  await send(id, market.seller.cookie, "réponse");
  assert.equal((await listNotifications({ pool: env.pool, userId: market.buyer.userId })).items.filter((item) => item.kind === "new_message").length, 1);
  // Passage par l'API HTTP des notifications : forme exacte, jamais un envoi externe.
  const http = createNotificationsHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  const response = await reply(await http.notifications.list(request("GET", "/api/notifications", { cookie: market.seller.cookie })));
  const dto = (response.json as { items: Array<Json> }).items.find((item) => item.kind === "new_message");
  assert.ok(dto);
  assert.equal(dto.link, `/messages/${id}`);
  assert.equal(await count(env.pool, "notification_deliveries"), 0, "aucun envoi externe pour un message");
});

test("NOTIFY : la charge ne contient que la conversation et l'id du message, jamais le texte", async () => {
  const listener = new Client({ connectionString: env.target.connectionString, options: `-c search_path=${env.schema}` });
  await listener.connect();
  const payloads: string[] = [];
  listener.on("notification", (message) => { if (message.channel === "noma_messages" && message.payload) payloads.push(message.payload); });
  try {
    await listener.query("LISTEN noma_messages");
    const id = conversationId(await open(market));
    await send(id, market.buyer.cookie, "TEXTE-SECRET-À-NE-PAS-DIFFUSER");
    const deadline = Date.now() + 3_000;
    while (payloads.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(payloads.length, 1);
    const parsed = JSON.parse(payloads[0]) as Json;
    assert.deepEqual(Object.keys(parsed).sort(), ["c", "m"]);
    assert.equal(parsed.c, id);
    assert.equal(typeof parsed.m, "number");
    assert.ok(!payloads[0].includes("SECRET"));
    // Un message refusé (transaction annulée) n'émet rien.
    await send(id, market.buyer.cookie, "x".repeat(1001));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(payloads.length, 1);
  } finally {
    await listener.end();
  }
});

test("garde-fous de la base : un message ne se modifie pas, un corps dangereux est refusé en base, les parties doivent être celles du besoin et de l'annonce, une conversation par couple", async () => {
  const id = await openAndWrite(market, "intact");
  await assert.rejects(() => env.pool.query("UPDATE messages SET body = 'modifié'"), (error: { code?: string; message?: string }) => error.code === "23001" && /messages_immutable/.test(String(error.message)));
  for (const body of ["a\u0007b", "a‮b", "a​b", "", "x".repeat(1001)]) {
    await assert.rejects(() => env.pool.query("INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3)", [id, market.buyer.userId, body]), (error: { code?: string }) => error.code === "23514", JSON.stringify(body).slice(0, 20));
  }
  await assert.rejects(
    () => env.pool.query("INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id) VALUES ($1, $2, $3, $4)", [market.demand.id, market.offer.id, stranger.userId, market.seller.userId]),
    (error: { code?: string; message?: string }) => error.code === "23514" && /social_parties_mismatch/.test(String(error.message)),
  );
  const other = await makeOffer(env.pool, market.seller.userId);
  await assert.rejects(() => env.pool.query("INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id) VALUES ($1, $2, $3, $4)", [market.demand.id, other.id, market.seller.userId, market.buyer.userId]), (error: { code?: string; message?: string }) => error.code === "23514");
  await assert.rejects(() => env.pool.query("INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id) VALUES ($1, $2, $3, $4)", [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId]), (error: { code?: string }) => error.code === "23505");
  assert.equal(await count(env.pool, "messages"), 1);
});

test("origine vérifiée AVANT la session sur toute écriture ; session exigée ; identifiants invalides refusés", async () => {
  const id = conversationId(await open(market));
  for (const origin of [null, "https://evil.example"]) {
    assert.equal((await reply(await handlers.conversations.send(request("POST", `/api/conversations/${id}/messages`, { cookie: market.buyer.cookie, origin, body: { body: "x" } }), id))).status, 403);
    assert.equal((await reply(await handlers.conversations.read(request("POST", `/api/conversations/${id}/read`, { cookie: market.buyer.cookie, origin, body: {} }), id))).status, 403);
    assert.equal((await reply(await handlers.conversations.open(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/conversation`, { cookie: market.buyer.cookie, origin }), market.demand.id, market.offer.id))).status, 403);
  }
  assert.equal((await send(id, null, "x")).status, 401);
  assert.equal((await list(null)).status, 401);
  assert.equal((await messages("pas-un-uuid", market.buyer.cookie)).status, 400);
  assert.equal((await detail("pas-un-uuid", market.buyer.cookie)).status, 400);
  assert.equal(await count(env.pool, "messages"), 0);
});
