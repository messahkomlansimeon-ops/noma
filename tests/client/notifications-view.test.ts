import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DemandTracking, NotificationItem, NotificationPreferences } from "../../lib/client/api";
import {
  EMPTY_NOTIFICATIONS_MESSAGE,
  EXTERNAL_NOTICE,
  MARK_ALL_READ_LABEL,
  PREFERENCES_UNAVAILABLE,
  TRACKING_NOTE,
  UNREAD_BADGE_CAP,
  UNREAD_REFRESH_MIN_INTERVAL_MS,
  createUnreadRefresher,
  markReadLocally,
  newestCreatedAt,
  mergeNotificationPages,
  notificationRow,
  notificationsListState,
  preferencesView,
  summaryTitle,
  trackingActionDone,
  trackingView,
  unreadBadgeAccessibleLabel,
  unreadBadgeLabel,
  unreadInList,
} from "../../lib/client/notifications-view";
import { formatMoney } from "../../lib/client/catalog-view";

const DEMAND = "22222222-2222-4222-8222-222222222222";
const OFFER = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";

const match = (id: string, overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id, kind: "new_match", title: "Apple iPhone 12 128 Go", price: { amount: 150_000, currency: "XOF" }, count: null, demandId: DEMAND, offerId: OFFER,
  link: `/besoins/${DEMAND}/offres/${OFFER}`, createdAt: "2031-01-01T10:00:00.000Z", readAt: null, ...overrides,
});
const digest = (id: string, count: number, overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id, kind: "new_matches_digest", title: null, price: null, count, demandId: DEMAND, offerId: null, link: `/besoins/${DEMAND}`, createdAt: "2031-01-01T11:00:00.000Z", readAt: null, ...overrides,
});

describe("pastille de la navigation", () => {
  test("rien pour zéro ou inconnu, le nombre jusqu'à 99, « 99+ » au-delà", () => {
    assert.equal(unreadBadgeLabel(null), null);
    assert.equal(unreadBadgeLabel(0), null);
    assert.equal(unreadBadgeLabel(-3), null);
    assert.equal(unreadBadgeLabel(1.5), null);
    assert.equal(unreadBadgeLabel(1), "1");
    assert.equal(unreadBadgeLabel(UNREAD_BADGE_CAP), "99");
    assert.equal(unreadBadgeLabel(UNREAD_BADGE_CAP + 1), "99+");
    assert.equal(unreadBadgeLabel(12345), "99+");
  });

  test("texte pour lecteur d'écran", () => {
    assert.equal(unreadBadgeAccessibleLabel(null), "Notifications");
    assert.equal(unreadBadgeAccessibleLabel(0), "Notifications");
    assert.equal(unreadBadgeAccessibleLabel(1), "Notifications : 1 non lue");
    assert.equal(unreadBadgeAccessibleLabel(7), "Notifications : 7 non lues");
    assert.equal(unreadBadgeAccessibleLabel(250), "Notifications : plus de 99 non lues");
  });
});

describe("rafraîchissement du compteur : au plus une fois par minute, jamais de sondage serré", () => {
  function setup(responses: Array<number | Error> = [3]) {
    let now = 1_000_000;
    let fetches = 0;
    let release: (() => void) | null = null;
    const refresher = createUnreadRefresher({
      now: () => now,
      fetchCount: async () => {
        const index = fetches++;
        const value = responses[Math.min(index, responses.length - 1)];
        if (release === null) {
          if (value instanceof Error) throw value;
          return value;
        }
        await new Promise<void>((resolve) => { release = resolve; });
        if (value instanceof Error) throw value;
        return value;
      },
    });
    return {
      refresher,
      fetches: () => fetches,
      advance: (ms: number) => { now += ms; },
      hold: () => { release = () => {}; },
      releaseHeld: () => release?.(),
    };
  }

  test("la constante vaut une minute", () => {
    assert.equal(UNREAD_REFRESH_MIN_INTERVAL_MS, 60_000);
  });

  test("première lecture, puis aucune autre pendant une minute (arrivées sur une page, retours au premier plan), puis une", async () => {
    const t = setup([3, 5, 8]);
    assert.equal(t.refresher.get(), null);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), 3);
    for (let index = 0; index < 20; index += 1) {
      t.advance(2_000);
      await t.refresher.refresh();
    }
    assert.equal(t.fetches(), 1, "20 arrivées en 40 secondes : une seule requête");
    t.advance(60_000 - 40_000 - 1);
    await t.refresher.refresh();
    assert.equal(t.fetches(), 1, "à 59,999 s : toujours rien");
    t.advance(1);
    await t.refresher.refresh();
    assert.equal(t.fetches(), 2, "à 60 s : une lecture");
    assert.equal(t.refresher.get(), 5);
    t.advance(60_000);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), 8);
    assert.equal(t.fetches(), 3);
  });

  test("des demandes simultanées partagent UNE requête", async () => {
    const t = setup([4]);
    t.hold();
    const first = t.refresher.refresh();
    const second = t.refresher.refresh();
    const third = t.refresher.refresh({ force: true });
    assert.equal(t.fetches(), 1);
    t.releaseHeld();
    await Promise.all([first, second, third]);
    assert.equal(t.fetches(), 1);
    assert.equal(t.refresher.get(), 4);
  });

  test("une panne garde le dernier compte et n'autorise pas de nouvelle tentative avant une minute", async () => {
    const t = setup([6, new Error("réseau"), 9]);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), 6);
    t.advance(60_000);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), 6, "dernier compte connu conservé");
    assert.equal(t.fetches(), 2);
    for (let index = 0; index < 10; index += 1) {
      t.advance(1_000);
      await t.refresher.refresh();
    }
    assert.equal(t.fetches(), 2, "pas de rafale après une panne");
    t.advance(60_000);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), 9);
  });

  test("une première panne laisse le compteur inconnu (aucune pastille)", async () => {
    const t = setup([new Error("401")]);
    await t.refresher.refresh();
    assert.equal(t.refresher.get(), null);
  });

  test("« force » relit tout de suite ; set() met à jour sans requête ; une valeur illisible est ignorée ; les abonnés sont prévenus des seuls changements", async () => {
    const t = setup([2, 7]);
    let notified = 0;
    const unsubscribe = t.refresher.subscribe(() => { notified += 1; });
    await t.refresher.refresh();
    assert.equal(notified, 1);
    await t.refresher.refresh({ force: true });
    assert.equal(t.fetches(), 2);
    assert.equal(t.refresher.get(), 7);
    assert.equal(notified, 2);
    t.refresher.set(0);
    assert.equal(t.refresher.get(), 0);
    assert.equal(t.fetches(), 2, "aucune requête");
    t.refresher.set(0);
    assert.equal(notified, 3, "même valeur : personne n'est prévenu");
    t.refresher.set(-1);
    t.refresher.set(Number.NaN);
    t.refresher.set(1.5);
    assert.equal(t.refresher.get(), 0);
    unsubscribe();
    t.refresher.set(4);
    assert.equal(notified, 3, "désabonné");
  });

  test("une horloge qui recule ne bloque pas les lectures", async () => {
    const t = setup([1, 2]);
    await t.refresher.refresh();
    t.advance(-5_000_000);
    await t.refresher.refresh();
    assert.equal(t.fetches(), 2);
  });
});

describe("liste des notifications", () => {
  test("une annonce : titre, prix en FCFA, date, non lue, lien reconstruit depuis les identifiants", () => {
    const row = notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"));
    assert.equal(row.title, "Apple iPhone 12 128 Go");
    assert.equal(row.subtitle, formatMoney({ amount: 150_000, currency: "XOF" }));
    assert.match(row.subtitle ?? "", /^150\s000 FCFA$/);
    assert.equal(row.unread, true);
    assert.equal(row.href, `/besoins/${DEMAND}/offres/${OFFER}`);
    assert.equal(row.linkLabel, "Voir l'annonce");
    assert.match(row.dateText, /^\d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/);
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { readAt: "2031-01-02T00:00:00.000Z" })).unread, false);
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { price: null })).subtitle, null);
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { price: { amount: 100, currency: "EUR" } })).subtitle, "100 EUR");
    // Aucun identifiant ni numéro n'apparaît dans les textes affichés.
    for (const shown of [row.title, row.subtitle ?? "", row.dateText, row.linkLabel]) {
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(shown), false, shown);
      assert.equal(/\d{9,}/.test(shown.replace(/\s/g, "")), false, shown);
    }
  });

  test("le lien ne vient jamais du champ « link » du serveur : un identifiant illisible n'a aucun lien", () => {
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { link: "https://evil.example", offerId: "x" })).href, null);
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { link: "https://evil.example", demandId: "x" })).href, null);
    assert.equal(notificationRow(digest("1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", 4, { link: "https://evil.example", demandId: "x" })).href, null);
    assert.equal(notificationRow(match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { link: "https://evil.example" })).href, `/besoins/${DEMAND}/offres/${OFFER}`);
  });

  test("un résumé : « N nouvelles annonces pour ce besoin », lien vers le besoin", () => {
    assert.equal(summaryTitle(1), "1 nouvelle annonce pour ce besoin");
    assert.equal(summaryTitle(8), "8 nouvelles annonces pour ce besoin");
    const row = notificationRow(digest("1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", 8));
    assert.equal(row.title, "8 nouvelles annonces pour ce besoin");
    assert.equal(row.href, `/besoins/${DEMAND}`);
    assert.equal(row.linkLabel, "Voir mon besoin");
    assert.equal(row.kind, "new_matches_digest");
  });

  test("fusion des pages sans doublon (la première occurrence est gardée)", () => {
    const a = match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const b = match("1f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const c = match("2f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const merged = mergeNotificationPages([a, b], [{ ...b, title: "autre" }, c]);
    assert.deepEqual(merged.map((item) => item.id), [a.id, b.id, c.id]);
    assert.equal(merged[1].title, "Apple iPhone 12 128 Go");
    assert.deepEqual(mergeNotificationPages([], []), []);
  });

  test("marquer comme lu localement : tout, ou une liste ; une notification déjà lue garde sa date", () => {
    const a = match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const b = match("1f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { readAt: "2031-01-01T12:00:00.000Z" });
    const c = match("2f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const NOW = "2031-01-05T00:00:00.000Z";
    assert.equal(unreadInList([a, b, c]), 2);
    const some = markReadLocally([a, b, c], [a.id, b.id], NOW);
    assert.deepEqual(some.map((item) => item.readAt), [NOW, "2031-01-01T12:00:00.000Z", null]);
    const all = markReadLocally([a, b, c], { upTo: newestCreatedAt([a, b, c]) as string }, NOW);
    assert.deepEqual(all.map((item) => item.readAt), [NOW, "2031-01-01T12:00:00.000Z", NOW]);
    assert.equal(unreadInList(all), 0);
    assert.equal(a.readAt, null, "l'entrée n'est pas modifiée");
  });

  test("« tout marquer comme lu » : la date envoyée est celle de la plus récente notification affichée ; le marquage local ne touche que ce qui est créé avant ou à cette date", () => {
    const older = match("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { createdAt: "2031-01-01T10:00:00.000Z" });
    const newest = match("1f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { createdAt: "2031-01-01T10:05:00.500Z" });
    const arrived = match("2f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", { createdAt: "2031-01-01T10:06:00.000Z" });
    assert.equal(newestCreatedAt([older, newest]), "2031-01-01T10:05:00.500Z");
    assert.equal(newestCreatedAt([newest, older]), "2031-01-01T10:05:00.500Z", "indépendant de l'ordre");
    assert.equal(newestCreatedAt([]), null, "rien d'affiché : rien à envoyer");
    const NOW = "2031-01-05T00:00:00.000Z";
    const marked = markReadLocally([older, newest, arrived], { upTo: "2031-01-01T10:05:00.500Z" }, NOW);
    assert.deepEqual(marked.map((item) => item.readAt), [NOW, NOW, null], "la notification arrivée après reste non lue");
  });

  test("états de la liste et libellés fixes", () => {
    assert.equal(notificationsListState({ loaded: false, itemCount: 0 }), "loading");
    assert.equal(notificationsListState({ loaded: true, itemCount: 0 }), "empty");
    assert.equal(notificationsListState({ loaded: true, itemCount: 3 }), "list");
    assert.equal(MARK_ALL_READ_LABEL, "Tout marquer comme lu");
    assert.equal(EMPTY_NOTIFICATIONS_MESSAGE, "Aucune notification pour le moment.");
  });
});

describe("suivi d'un besoin", () => {
  const tracking = (overrides: Partial<DemandTracking> = {}): DemandTracking => ({
    demandId: DEMAND, demandStatus: "active", until: "2031-02-01T10:00:00.000Z", paused: false, active: true, maxUntil: "2031-04-01T10:00:00.000Z", readAt: "2031-01-02T10:00:00.000Z", ...overrides,
  });

  test("actif : « Suivi actif jusqu'au 01/02/2031 », pause et prolongation possibles", () => {
    const view = trackingView(tracking());
    assert.equal(view.headline, "Suivi actif jusqu'au 01/02/2031");
    assert.equal(view.tone, "active");
    assert.deepEqual({ canPause: view.canPause, canResume: view.canResume, canExtend: view.canExtend, atMaximum: view.atMaximum, applicable: view.applicable }, { canPause: true, canResume: false, canExtend: true, atMaximum: false, applicable: true });
  });

  test("en pause : reprise possible, les résultats restent à jour (seules les notifications s'arrêtent)", () => {
    const view = trackingView(tracking({ paused: true, active: false }));
    assert.equal(view.headline, "Suivi en pause");
    assert.equal(view.tone, "paused");
    assert.equal(view.canResume, true);
    assert.equal(view.canPause, false);
    assert.match(view.detail, /résultats restent à jour/);
  });

  test("terminé : prolongation possible, plus de pause ni de reprise", () => {
    const view = trackingView(tracking({ until: "2031-01-01T10:00:00.000Z", active: false }));
    assert.equal(view.headline, "Suivi terminé le 01/01/2031");
    assert.equal(view.tone, "ended");
    assert.deepEqual({ canPause: view.canPause, canResume: view.canResume, canExtend: view.canExtend }, { canPause: false, canResume: false, canExtend: true });
    assert.match(view.detail, /résultats restent à jour/);
  });

  test("au maximum (90 jours) : plus de prolongation, avec l'explication", () => {
    const view = trackingView(tracking({ until: "2031-04-01T10:00:00.000Z" }));
    assert.equal(view.atMaximum, true);
    assert.equal(view.canExtend, false);
    assert.equal(trackingView(tracking({ until: "2031-04-01T09:59:30.000Z" })).canExtend, false, "à la minute près");
    assert.equal(trackingView(tracking({ until: "2031-03-31T10:00:00.000Z" })).canExtend, true);
    assert.equal(trackingView(tracking({ paused: true, active: false, until: "2031-04-01T10:00:00.000Z" })).canExtend, false);
  });

  test("besoin non actif : aucune action", () => {
    for (const demandStatus of ["draft", "satisfied", "archived"] as const) {
      const view = trackingView(tracking({ demandStatus, active: false }));
      assert.equal(view.applicable, false);
      assert.equal(view.tone, "closed");
      assert.deepEqual({ p: view.canPause, r: view.canResume, e: view.canExtend }, { p: false, r: false, e: false });
    }
  });

  test("messages d'action et note fixe", () => {
    assert.equal(trackingActionDone("extend"), "Suivi prolongé");
    assert.equal(trackingActionDone("pause"), "Suivi mis en pause");
    assert.equal(trackingActionDone("resume"), "Suivi repris");
    assert.match(TRACKING_NOTE, /résultats restent à jour : seules les notifications s'arrêtent/);
  });
});

describe("préférences d'envoi", () => {
  test("le texte fixe est celui de la décision (l'égalité avec le texte du serveur est vérifiée par tests/server/notifications.test.ts)", () => {
    assert.equal(EXTERNAL_NOTICE, "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.");
  });

  test("vue : l'état, le texte du serveur, et une précision quand aucun transport n'existe", () => {
    const prefs = (overrides: Partial<NotificationPreferences> = {}): NotificationPreferences => ({ externalEnabled: false, externalAvailable: true, notice: EXTERNAL_NOTICE, ...overrides });
    assert.deepEqual(preferencesView(prefs()), { enabled: false, notice: EXTERNAL_NOTICE, extra: null });
    assert.deepEqual(preferencesView(prefs({ externalEnabled: true, externalAvailable: false })), { enabled: true, notice: EXTERNAL_NOTICE, extra: PREFERENCES_UNAVAILABLE });
  });
});
