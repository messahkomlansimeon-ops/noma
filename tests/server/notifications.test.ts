import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EXTERNAL_NOTICE as CLIENT_EXTERNAL_NOTICE, UNREAD_REFRESH_MIN_INTERVAL_MS } from "../../lib/client/notifications-view";
import { purgeEnvironmentRefusal } from "../../lib/server/metrics/purge";
import {
  DELIVERIES_RETENTION_DAYS,
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  DEV_NOTIFY_FLAG,
  EXTERNAL_COLLECTION_WINDOW_MS,
  EXTERNAL_DAILY_CAP_PER_USER,
  EXTERNAL_MIN_INTERVAL_MS,
  EXTERNAL_NOTICE,
  NEW_MATCH_DAILY_CAP_PER_DEMAND,
  NEW_MATCH_DAILY_CAP_PER_USER,
  NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE,
  NOTIFICATIONS_READ_RETENTION_DAYS,
  NOTIFICATIONS_RETENTION_DAYS,
  QUIET_HOURS_END_UTC,
  QUIET_HOURS_START_UTC,
  TRACKING_DEFAULT_DAYS,
  TRACKING_EXTEND_DAYS,
  TRACKING_MAX_DAYS,
} from "../../lib/server/notifications/config";
import {
  EXTERNAL_MESSAGE_LINK,
  TITLE_FALLBACK,
  TITLE_MAX_DIGITS,
  buildDeliveryContent,
  buildNotificationPrice,
  buildNotificationTitle,
  demandLink,
  groupedMessageText,
  offerLink,
  sanitizeTitlePart,
} from "../../lib/server/notifications/content";
import { allowedSendTime, batchKeyOf, isQuietHour, nextQuietEnd, retryDelayMs, utcDayBounds } from "../../lib/server/notifications/deliveries";
import { countDigits, looksLikePhoneNumber } from "../../lib/server/metrics/public-text";
import { decodeNotificationCursor, encodeNotificationCursor } from "../../lib/server/notifications/inbox";
import {
  DEV_NOTIFY_REFUSED_WARNING,
  createDevConsoleTransport,
  createNotificationTransportResolver,
  isDevNotifyConsoleEnabled,
  maskUserId,
} from "../../lib/server/notifications/transport";

const DEMAND = "11111111-2222-4333-8444-555555555555";
const OFFER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

describe("règles chiffrées du lot N1", () => {
  test("les constantes sont celles des décisions : 20 par besoin et 50 par utilisateur et par jour, fenêtre de 15 min, 4 h entre deux messages, 3 messages par jour, 22 h-7 h, 3 tentatives, expiration 48 h, 30 / 90 jours, rétention 90 / 180 jours", () => {
    assert.equal(NEW_MATCH_DAILY_CAP_PER_DEMAND, 20);
    assert.equal(NEW_MATCH_DAILY_CAP_PER_USER, 50);
    assert.equal(EXTERNAL_COLLECTION_WINDOW_MS, 15 * 60_000);
    assert.equal(EXTERNAL_MIN_INTERVAL_MS, 4 * 3_600_000);
    assert.equal(EXTERNAL_DAILY_CAP_PER_USER, 3);
    assert.equal(QUIET_HOURS_START_UTC, 22);
    assert.equal(QUIET_HOURS_END_UTC, 7);
    assert.equal(DELIVERY_MAX_ATTEMPTS, 3);
    assert.deepEqual([...DELIVERY_RETRY_DELAYS_MS], [5 * 60_000, 30 * 60_000]);
    assert.ok(DELIVERY_RETRY_DELAYS_MS[1] > DELIVERY_RETRY_DELAYS_MS[0], "attente croissante");
    assert.equal(DELIVERY_MAX_AGE_MS, 48 * 3_600_000);
    assert.equal(TRACKING_DEFAULT_DAYS, 30);
    assert.equal(TRACKING_EXTEND_DAYS, 30);
    assert.equal(TRACKING_MAX_DAYS, 90);
    assert.equal(NOTIFICATIONS_READ_RETENTION_DAYS, 90);
    assert.equal(NOTIFICATIONS_RETENTION_DAYS, 180);
    assert.equal(DELIVERIES_RETENTION_DAYS, 180);
    assert.equal(DEV_NOTIFY_FLAG, "NOMA_DEV_NOTIFY_CONSOLE");
    assert.equal(EXTERNAL_NOTICE, "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.");
    assert.equal(CLIENT_EXTERNAL_NOTICE, EXTERNAL_NOTICE, "le texte du client est celui du serveur");
    assert.equal(UNREAD_REFRESH_MIN_INTERVAL_MS, 60_000, "la pastille est relue au plus une fois par minute");
  });
});

describe("contenu : liste blanche", () => {
  test("le titre est marque, modèle, variante (nettoyés) ; « Nouvelle annonce » s'il ne reste rien", () => {
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "iPhone 12", variant: "128 Go" }), "Apple iPhone 12 128 Go");
    assert.equal(buildNotificationTitle({ brand: "Apple", model: null, variant: null }), "Apple");
    assert.equal(buildNotificationTitle({ brand: null, model: null, variant: null }), TITLE_FALLBACK);
    assert.equal(buildNotificationTitle({ brand: "  Apple   Inc ", model: "iPhone", variant: "" }), "Apple Inc iPhone");
  });

  test("un morceau qui ressemble à un téléphone (9 chiffres ou plus, séparateurs compris) est écarté", () => {
    assert.equal(sanitizeTitlePart("0707070707"), null);
    assert.equal(sanitizeTitlePart("+225 07 07 07 07 07"), null);
    assert.equal(sanitizeTitlePart("07-07-07-07-07"), null);
    assert.equal(sanitizeTitlePart("iPhone 12"), "iPhone 12");
    assert.equal(sanitizeTitlePart("2026-10-06"), "2026-10-06", "une date à 8 chiffres n'est pas un téléphone");
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "appelez le 0707070707", variant: "128 Go" }), "Apple 128 Go");
    assert.equal(buildNotificationTitle({ brand: "0707070707", model: "+22507070707", variant: "07 07 07 07 07" }), TITLE_FALLBACK);
  });

  test("chiffres NON ASCII : pleine chasse, arabes-indiens, dévanagari, exposants et mélangés sont comptés comme des chiffres (NFKC et \\p{Nd}), jamais publiés", () => {
    const systems: Record<string, string> = {
      "pleine chasse": "０７０８１２３４５６",
      "arabes-indiens": "٠٧٠٨١٢٣٤٥٦",
      "arabes-indiens orientaux": "۰۷۰۸۱۲۳۴۵۶",
      "dévanagari": "०७०८१२३४५६",
      "exposants": "⁰⁷⁰⁸¹²³⁴⁵⁶",
      "mathématiques": "𝟎𝟕𝟎𝟖𝟏𝟐𝟑𝟒𝟓𝟔",
      "mélangés": "0७٠8１2٣4५6",
      "séparateurs pleine chasse": "０７　０８　１２　３４　５６",
      "séparateurs pointés": "٠٧.٠٨.١٢.٣٤.٥٦",
    };
    for (const [name, digits] of Object.entries(systems)) {
      assert.equal(countDigits(digits), 10, `${name} : 10 chiffres comptés`);
      assert.equal(looksLikePhoneNumber(digits), true, `${name} : ressemble à un téléphone`);
      assert.equal(sanitizeTitlePart(digits), null, `${name} : morceau écarté`);
      assert.equal(buildNotificationTitle({ brand: digits, model: digits, variant: digits }), TITLE_FALLBACK, `${name} : plus rien de publiable`);
      assert.equal(buildNotificationTitle({ brand: "Apple", model: `appelez le ${digits}`, variant: "128 Go" }), "Apple 128 Go", `${name} : seul le morceau fautif est retiré`);
    }
    // Les chiffres usuels et les petits nombres, quel que soit le système d'écriture, restent publiables (et sont normalisés en NFKC).
    assert.equal(sanitizeTitlePart("iPhone １２"), "iPhone 12");
    assert.equal(sanitizeTitlePart("٢٥٦ Go"), "٢٥٦ Go", "le chiffre arabe-indien n'est pas converti, il est seulement compté");
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "iPhone 12", variant: "128 Go" }), "Apple iPhone 12 128 Go");
  });

  test("le titre ASSEMBLÉ ne porte jamais plus de 8 chiffres : répartis sur la marque, le modèle et la variante, le morceau qui dépasse est retiré", () => {
    const digitsIn = (title: string) => countDigits(title);
    // 4 + 4 + 4 chiffres : chaque morceau est inoffensif, le titre assemblé en porterait 12.
    assert.equal(buildNotificationTitle({ brand: "0708", model: "1234", variant: "5678" }), "0708 1234", "la variante fait dépasser 8 : elle est retirée");
    assert.equal(buildNotificationTitle({ brand: "07 08 12", model: "34 56", variant: "78 90" }), "07 08 12", "6 chiffres, puis +4 > 8 : modèle et variante retirés");
    assert.equal(buildNotificationTitle({ brand: "A1", model: "12345678", variant: "9" }), "A1 9", "1 + 8 > 8 : le modèle est retiré ; la variante (1 chiffre) tient encore");
    for (const digits of Object.values({ ascii: "12", fullWidth: "１２", arabic: "١٢", devanagari: "१२" })) {
      const title = buildNotificationTitle({ brand: `m${digits}${digits}`, model: `n${digits}${digits}`, variant: `v${digits}${digits}` });
      assert.ok(digitsIn(title) <= TITLE_MAX_DIGITS, `${title} : au plus ${TITLE_MAX_DIGITS} chiffres`);
    }
    // Chiffres séparés par des signes que la règle des 9 chiffres d'affilée ne voit pas.
    const slashes = buildNotificationTitle({ brand: "Apple", model: "07/08/12/34/56", variant: "128 Go" });
    assert.equal(slashes, "Apple 128 Go", "10 chiffres séparés par des barres : jamais publiés");
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "iPhone 12", variant: "128 Go" }), "Apple iPhone 12 128 Go", "un titre ordinaire n'est pas touché");
    assert.equal(TITLE_MAX_DIGITS, 8);
  });

  test("un morceau avec un caractère de contrôle, de direction de texte ou invisible, ou trop long, est écarté", () => {
    assert.equal(sanitizeTitlePart("iPhone‮12"), null);
    assert.equal(sanitizeTitlePart("iPhone​12"), null);
    assert.equal(sanitizeTitlePart("iPhone\u00001"), null);
    assert.equal(sanitizeTitlePart("x".repeat(51)), null);
    assert.equal(sanitizeTitlePart("x".repeat(50)), "x".repeat(50));
    assert.equal(sanitizeTitlePart(null), null);
    assert.equal(sanitizeTitlePart(undefined), null);
    assert.equal(sanitizeTitlePart("   "), null);
    // Le titre total ne dépasse jamais 160 caractères (CHECK de la migration 0019) : 3 × 50 + 2 espaces.
    assert.ok(buildNotificationTitle({ brand: "a".repeat(50), model: "b".repeat(50), variant: "c".repeat(50) }).length <= 160);
  });

  test("le prix est un entier sûr et une devise de trois lettres, sinon absent", () => {
    assert.deepEqual(buildNotificationPrice(250_000, "XOF"), { amount: 250_000, currency: "XOF" });
    assert.equal(buildNotificationPrice(-1, "XOF"), null);
    assert.equal(buildNotificationPrice(1.5, "XOF"), null);
    assert.equal(buildNotificationPrice(Number.MAX_SAFE_INTEGER + 1, "XOF"), null);
    assert.equal(buildNotificationPrice(100, "xof"), null);
    assert.equal(buildNotificationPrice(100, null), null);
    assert.equal(buildNotificationPrice("100", "XOF"), null);
  });

  test("le lien d'une notification mène à la fiche dans le contexte du besoin ; celui d'un message externe, à /notifications seulement", () => {
    assert.equal(offerLink(DEMAND, OFFER), `/besoins/${DEMAND}/offres/${OFFER}`);
    assert.equal(demandLink(DEMAND), `/besoins/${DEMAND}`);
    assert.equal(EXTERNAL_MESSAGE_LINK, "/notifications");
  });

  test("le message regroupé ne dit que le nombre d'annonces", () => {
    assert.equal(groupedMessageText(1), "1 nouvelle annonce pour vos besoins");
    assert.equal(groupedMessageText(3), "3 nouvelles annonces pour vos besoins");
    assert.equal(groupedMessageText(20), "20 nouvelles annonces pour vos besoins");
  });

  test("le contenu figé d'un envoi ne porte que titre, prix et lien", () => {
    const content = buildDeliveryContent({ title: "Apple iPhone 12", price: { amount: 150_000, currency: "XOF" }, demandId: DEMAND, offerId: OFFER });
    assert.deepEqual(Object.keys(content).sort(), ["link", "price", "title"]);
    assert.equal(content.link, offerLink(DEMAND, OFFER));
  });
});

describe("heures calmes, jour UTC et attentes", () => {
  const at = (hour: number, minute = 0, second = 0, ms = 0) => new Date(Date.UTC(2032, 5, 15, hour, minute, second, ms));

  test("22 h incluse, 7 h exclue (UTC = Afrique/Abidjan)", () => {
    assert.equal(isQuietHour(at(21, 59, 59, 999)), false);
    assert.equal(isQuietHour(at(22)), true);
    assert.equal(isQuietHour(at(23, 30)), true);
    assert.equal(isQuietHour(at(0)), true);
    assert.equal(isQuietHour(at(3)), true);
    assert.equal(isQuietHour(at(6, 59, 59, 999)), true);
    assert.equal(isQuietHour(at(7)), false);
    assert.equal(isQuietHour(at(12)), false);
  });

  test("le report va au prochain 7 h UTC, strictement après l'instant", () => {
    assert.equal(nextQuietEnd(at(23, 30)).toISOString(), "2032-06-16T07:00:00.000Z");
    assert.equal(nextQuietEnd(at(22)).toISOString(), "2032-06-16T07:00:00.000Z");
    assert.equal(nextQuietEnd(at(0)).toISOString(), "2032-06-15T07:00:00.000Z");
    assert.equal(nextQuietEnd(at(6, 59, 59, 999)).toISOString(), "2032-06-15T07:00:00.000Z");
    assert.ok(nextQuietEnd(at(23, 30)).getTime() > at(23, 30).getTime());
    // Fin de mois et d'année.
    assert.equal(nextQuietEnd(new Date(Date.UTC(2032, 11, 31, 23))).toISOString(), "2033-01-01T07:00:00.000Z");
  });

  test("le jour UTC est [00:00, 24:00[", () => {
    const bounds = utcDayBounds(at(23, 59, 59, 999));
    assert.equal(bounds.start.toISOString(), "2032-06-15T00:00:00.000Z");
    assert.equal(bounds.end.toISOString(), "2032-06-16T00:00:00.000Z");
    assert.equal(utcDayBounds(at(0)).start.toISOString(), "2032-06-15T00:00:00.000Z");
  });

  test("attente croissante entre les tentatives : 5 min puis 30 min", () => {
    assert.equal(retryDelayMs(1), 5 * 60_000);
    assert.equal(retryDelayMs(2), 30 * 60_000);
    assert.ok(retryDelayMs(2) > retryDelayMs(1));
  });

  test("l'instant d'envoi permis : tel quel hors des heures calmes, la fin des heures calmes sinon", () => {
    assert.equal(allowedSendTime(at(12)).toISOString(), at(12).toISOString());
    assert.equal(allowedSendTime(at(21, 59, 59, 999)).toISOString(), at(21, 59, 59, 999).toISOString());
    assert.equal(allowedSendTime(at(23, 5)).toISOString(), "2032-06-16T07:00:00.000Z");
    assert.equal(allowedSendTime(at(3)).toISOString(), "2032-06-15T07:00:00.000Z");
    assert.equal(allowedSendTime(at(7)).toISOString(), at(7).toISOString());
  });

  test("la clé du message regroupé est déterministe, indépendante de l'ordre, sur 32 caractères hexadécimaux", () => {
    const a = batchKeyOf(["b", "a", "c"]);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(batchKeyOf(["c", "b", "a"]), a);
    assert.notEqual(batchKeyOf(["a", "b"]), a);
  });
});

describe("curseur des notifications", () => {
  const AT = "2032-06-15T10:00:00.123456Z";
  const ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

  test("aller-retour exact", () => {
    assert.deepEqual(decodeNotificationCursor(encodeNotificationCursor(AT, ID)), { createdAt: AT, id: ID });
  });

  test("toute autre forme est refusée", () => {
    for (const bad of ["", "x", "!!!", Buffer.from("a|b").toString("base64url"), Buffer.from(`${AT}|nope`).toString("base64url"), Buffer.from(`2032-06-15|${ID}`).toString("base64url"), 42, null, undefined, "A".repeat(200)]) {
      assert.throws(() => decodeNotificationCursor(bad), /cursor invalide/, String(bad));
    }
    assert.throws(() => decodeNotificationCursor(Buffer.from(`${AT}|${ID}|extra`).toString("base64url")), /cursor invalide/);
    assert.throws(() => decodeNotificationCursor(`${encodeNotificationCursor(AT, ID)}=`), /cursor invalide/);
  });
});

describe("transport de notification de développement : verrou de production", () => {
  test("la combinaison exacte NODE_ENV=development et NOMA_DEV_NOTIFY_CONSOLE=1 est la seule qui l'active", () => {
    assert.equal(isDevNotifyConsoleEnabled({ NODE_ENV: "development", NOMA_DEV_NOTIFY_CONSOLE: "1" }), true);
    for (const nodeEnv of ["production", "test", "Production", "PRODUCTION", "prod", "staging", "", undefined]) {
      assert.equal(isDevNotifyConsoleEnabled({ NODE_ENV: nodeEnv, NOMA_DEV_NOTIFY_CONSOLE: "1" }), false, `NODE_ENV=${String(nodeEnv)}`);
    }
    for (const flag of ["0", "true", "yes", " 1", "1 ", "", undefined]) {
      assert.equal(isDevNotifyConsoleEnabled({ NODE_ENV: "development", NOMA_DEV_NOTIFY_CONSOLE: flag }), false, `drapeau=${String(flag)}`);
    }
  });

  test("le résolveur : développement + drapeau → transport ; production + drapeau → REFUS, aucun transport, un seul avertissement ; sans drapeau → rien", () => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const resolve = createNotificationTransportResolver({ write: (line) => lines.push(line), warn: (line) => warnings.push(line) });
    assert.equal(resolve({ NODE_ENV: "development" }), undefined);
    assert.equal(resolve({ NODE_ENV: "production" }), undefined);
    assert.deepEqual(warnings, [], "sans drapeau : aucun message, production comprise");
    assert.equal(resolve({ NODE_ENV: "production", NOMA_DEV_NOTIFY_CONSOLE: "1" }), undefined);
    assert.equal(resolve({ NODE_ENV: "production", NOMA_DEV_NOTIFY_CONSOLE: "1" }), undefined);
    assert.equal(resolve({ NODE_ENV: "test", NOMA_DEV_NOTIFY_CONSOLE: "1" }), undefined);
    assert.equal(resolve({ NOMA_DEV_NOTIFY_CONSOLE: "1" }), undefined);
    assert.deepEqual(warnings, [DEV_NOTIFY_REFUSED_WARNING], "un seul avertissement fixe par résolveur");
    assert.match(DEV_NOTIFY_REFUSED_WARNING, /NODE_ENV=development/);
    const transport = resolve({ NODE_ENV: "development", NOMA_DEV_NOTIFY_CONSOLE: "1" });
    assert.ok(transport);
    assert.equal(transport.channel, "sms_sim");
    assert.equal(resolve({ NODE_ENV: "development", NOMA_DEV_NOTIFY_CONSOLE: "1" }), transport, "même instance");
    // L'environnement est relu à chaque appel : la décision n'est jamais mémorisée.
    assert.equal(resolve({ NODE_ENV: "production", NOMA_DEV_NOTIFY_CONSOLE: "1" }), undefined);
    assert.deepEqual(lines, []);
  });

  test("le transport écrit UNE ligne : identifiant tronqué, nombre d'annonces et lien ; ni identifiant complet, ni clé, ni titre, ni prix", async () => {
    const lines: string[] = [];
    const transport = createDevConsoleTransport((line) => lines.push(line));
    await transport.send({ userId: USER, count: 3, link: "/notifications", idempotencyKey: "0123456789abcdef0123456789abcdef" });
    await transport.send({ userId: USER, count: 1, link: "/notifications", idempotencyKey: "fedcba9876543210fedcba9876543210" });
    assert.deepEqual(lines, [
      "[notify:dev] envoi simulé à 0f1e2d3c… : 3 annonces, lien /notifications",
      "[notify:dev] envoi simulé à 0f1e2d3c… : 1 annonce, lien /notifications",
    ]);
    for (const line of lines) {
      assert.equal(line.includes(USER), false);
      assert.equal(line.includes("0123456789abcdef"), false);
      assert.equal(/\d{9,}/.test(line), false);
    }
  });

  test("l'identifiant est tronqué à 8 caractères hexadécimaux", () => {
    assert.equal(maskUserId(USER), "0f1e2d3c…");
    assert.equal(maskUserId("zz-not-hex"), "e…", "jamais plus que des caractères hexadécimaux");
    assert.ok(maskUserId(USER).length <= 9);
  });
});

describe("garde de purge des notifications", () => {
  test("même garde d'environnement que metrics:purge, avec sa propre variable de production", () => {
    for (const nodeEnv of [undefined, "development", "test"]) assert.equal(purgeEnvironmentRefusal({ NODE_ENV: nodeEnv }, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE), null);
    for (const nodeEnv of ["Production", "PRODUCTION", "prod", "staging", ""]) {
      assert.match(purgeEnvironmentRefusal({ NODE_ENV: nodeEnv, [NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE]: "1" }, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE) ?? "", /^refus/);
    }
    const refused = purgeEnvironmentRefusal({ NODE_ENV: "production" }, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE);
    assert.match(refused ?? "", /NOMA_NOTIFICATIONS_PURGE_PRODUCTION=1/);
    assert.equal(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_NOTIFICATIONS_PURGE_PRODUCTION: "1" }, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE), null);
    // La variable de la purge des mesures n'autorise PAS la purge des notifications.
    assert.match(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" }, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE) ?? "", /^refus/);
    // Sans second paramètre, la garde de metrics:purge est inchangée.
    assert.equal(purgeEnvironmentRefusal({ NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" }), null);
    assert.match(purgeEnvironmentRefusal({ NODE_ENV: "production" }) ?? "", /NOMA_METRICS_PURGE_PRODUCTION=1/);
  });
});
