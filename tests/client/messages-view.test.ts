import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SAFETY_REMINDER,
  SAFETY_REMINDER_STORAGE_KEY,
  composerState,
  conversationOfferPath,
  conversationPath,
  conversationRow,
  counterpartLabel,
  lastMessageId,
  markSafetyReminderSeen,
  mergeMessages,
  messagesBadgeAccessibleLabel,
  shouldShowSafetyReminder,
  type SimpleStorage,
} from "../../lib/client/messages-view";
import type { ConversationMessage, ConversationSummary } from "../../lib/client/social-api";

/** Présentation de la messagerie (lot D2) : l'autre partie SANS identité, non-lus, fil sans doublon, saisie, rappel de sécurité la première fois. */

const OFFER = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const DEMAND = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const CONVERSATION = "3a3a3a3a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: CONVERSATION, role: "buyer", title: "Apple iPhone 12 128 Go", demandId: DEMAND, offerId: OFFER, available: true, createdAt: "2026-10-06T09:00:00.000Z",
  lastMessage: { body: "Bonjour", mine: false, createdAt: "2026-10-06T10:00:00.000Z" }, unreadCount: 0, ...overrides,
});
const message = (id: number, mine = false, body = `m${id}`): ConversationMessage => ({ id, mine, body, createdAt: "2026-10-06T10:00:00.000Z" });

describe("l'autre partie est désignée SANS identité", () => {
  test("acheteur : « Vendeur de l'annonce … » ; vendeur : « Acheteur intéressé »", () => {
    assert.equal(counterpartLabel("buyer", "iPhone 12"), "Vendeur de l'annonce iPhone 12");
    assert.equal(counterpartLabel("seller", "iPhone 12"), "Acheteur intéressé");
    const buyer = conversationRow(summary());
    assert.equal(buyer.label, "Vendeur de l'annonce Apple iPhone 12 128 Go");
    assert.equal(buyer.subtitle, null);
    const seller = conversationRow(summary({ role: "seller", demandId: null }));
    assert.equal(seller.label, "Acheteur intéressé");
    assert.equal(seller.subtitle, "Annonce : Apple iPhone 12 128 Go");
    assert.ok(!JSON.stringify([buyer, seller]).includes(DEMAND), "aucun identifiant de besoin à l'écran");
  });

  test("non lus en gras, aperçu « Vous : … » pour son propre message, conversation sans message", () => {
    assert.equal(conversationRow(summary({ unreadCount: 2 })).unread, true);
    assert.equal(conversationRow(summary({ unreadCount: 2 })).unreadCount, 2);
    assert.equal(conversationRow(summary()).unread, false);
    assert.equal(conversationRow(summary({ lastMessage: { body: "Merci", mine: true, createdAt: "2026-10-06T10:00:00.000Z" } })).preview, "Vous : Merci");
    assert.equal(conversationRow(summary({ lastMessage: null })).preview, "Aucun message");
    assert.equal(conversationRow(summary({ available: false })).available, false);
  });

  test("liens reconstruits depuis les identifiants, dans l'espace du participant", () => {
    assert.equal(conversationPath("buyer", CONVERSATION), `/messages/${CONVERSATION}`);
    assert.equal(conversationPath("seller", CONVERSATION), `/vendeur/messages/${CONVERSATION}`);
    assert.equal(conversationRow(summary({ role: "seller", demandId: null })).href, `/vendeur/messages/${CONVERSATION}`);
    assert.equal(conversationOfferPath({ role: "buyer", demandId: DEMAND, offerId: OFFER }), `/besoins/${DEMAND}/offres/${OFFER}`);
    assert.equal(conversationOfferPath({ role: "seller", demandId: null, offerId: OFFER }), `/vendeur/annonces/${OFFER}`);
    assert.equal(conversationOfferPath({ role: "buyer", demandId: null, offerId: OFFER }), null);
  });
});

describe("fil de la conversation", () => {
  test("fusion sans doublon, du plus ancien au plus récent ; le dernier id sert au rattrapage", () => {
    const merged = mergeMessages([message(3), message(1)], [message(2), message(3, true, "écho"), message(5)]);
    assert.deepEqual(merged.map((entry) => entry.id), [1, 2, 3, 5]);
    assert.equal(merged.find((entry) => entry.id === 3)?.body, "m3", "la première occurrence est gardée");
    assert.equal(lastMessageId(merged), 5);
    assert.equal(lastMessageId([]), null);
    assert.deepEqual(mergeMessages([], []), []);
  });
});

describe("saisie", () => {
  test("envoi possible de 1 à 1000 caractères sans caractère spécial ; compteur ; motifs", () => {
    assert.equal(composerState("", false).canSend, false);
    assert.equal(composerState("   ", false).problem, null);
    assert.deepEqual(composerState("Bonjour", false), { canSend: true, counter: "7 / 1000", problem: null });
    assert.equal(composerState("Bonjour", true).canSend, false, "pas de double envoi pendant l'envoi");
    assert.equal(composerState("x".repeat(1001), false).canSend, false);
    assert.match(String(composerState("x".repeat(1001), false).problem), /1000 caractères au plus/);
    assert.equal(composerState("a‮b", false).canSend, false);
    assert.match(String(composerState("a‮b", false).problem), /caractère spécial/);
    assert.equal(composerState("x".repeat(1000), false).canSend, true);
  });
});

describe("rappel de sécurité (la première fois)", () => {
  const memory = (): SimpleStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
  };

  test("texte demandé ; affiché tant qu'il n'a pas été vu, puis plus jamais", () => {
    assert.equal(SAFETY_REMINDER, "Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet.");
    const storage = memory();
    assert.equal(shouldShowSafetyReminder(storage), true);
    markSafetyReminderSeen(storage);
    assert.equal(storage.data.get(SAFETY_REMINDER_STORAGE_KEY), "1");
    assert.equal(shouldShowSafetyReminder(storage), false);
  });

  test("un stockage absent ou qui lève ne fait jamais échouer l'écran : le rappel est montré", () => {
    const broken: SimpleStorage = { getItem: () => { throw new Error("bloqué"); }, setItem: () => { throw new Error("bloqué"); } };
    assert.equal(shouldShowSafetyReminder(null), true);
    assert.equal(shouldShowSafetyReminder(broken), true);
    assert.doesNotThrow(() => markSafetyReminderSeen(broken));
    assert.doesNotThrow(() => markSafetyReminderSeen(null));
  });
});

test("libellé de la pastille de messages", () => {
  assert.equal(messagesBadgeAccessibleLabel(null), "Messages");
  assert.equal(messagesBadgeAccessibleLabel(0), "Messages");
  assert.equal(messagesBadgeAccessibleLabel(1), "Messages : 1 conversation non lue");
  assert.equal(messagesBadgeAccessibleLabel(4), "Messages : 4 conversations non lues");
  assert.equal(messagesBadgeAccessibleLabel(250), "Messages : plus de 99 conversations non lues");
});
