import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SMS_BUDGET_ERROR_CODES,
  budgetErrorCode,
  budgetVerdict,
  isBudgetErrorCode,
  planBudgets,
  type SmsBudgetCounts,
  type SmsBudgetPlan,
} from "../../lib/server/sms/budget";
import { NOTIFY_ROWS_PER_USER } from "../../lib/server/notifications/config";
import { EXTERNAL_MESSAGE_LINK } from "../../lib/server/notifications/content";
import { NOTIFICATION_LINK_PATH, NOTIFICATION_WORST_CASE_COUNT, assertSmsProductionConfig, isMenoActive, menoInactiveReason, readSmsConfig } from "../../lib/server/sms/config";
import { analyzeSms } from "../../lib/server/sms/gsm7";
import { notificationMessage } from "../../lib/server/sms/messages";

const KEY = "fake_meno_key_for_tests_only_0001";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const PRODUCTION = { NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_PUBLIC_URL: "https://noma.example.ci", NOMA_AUTH_SECRET: SECRET };
const zero: SmsBudgetCounts = { total: 0, codes: 0, newNumbers: 0, newNumbersHour: 0, notifications: 0 };

test("B1-a/b/c — plan par défaut pour 1000 par jour : 400 notifications, 600 codes dont 300 réservés aux numéros existants, 300 pour les numéros inconnus, 38 par heure glissante", () => {
  assert.deepEqual(planBudgets(1_000), { total: 1_000, notifications: 400, codes: 600, existingReserve: 300, newNumbers: 300, newNumbersPerHour: 38 });
  // (300 / 24) × 3 = 37,5 → 38 : une rafale ne brûle jamais plus de ~12,5 % de la part inconnue en une heure.
  assert.equal(planBudgets(1_000).newNumbersPerHour, Math.ceil((300 / 24) * 3));
  assert.deepEqual(planBudgets(1_000, 50, 20), { total: 1_000, notifications: 500, codes: 500, existingReserve: 100, newNumbers: 400, newNumbersPerHour: 50 });
});

test("le plan est cohérent pour tous les plafonds : les parts s'additionnent EXACTEMENT, aucune part négative, lissage horaire borné", () => {
  for (const total of [1, 2, 3, 4, 5, 7, 10, 24, 100, 999, 1_000, 1_001, 12_345, 100_000]) {
    for (const share of [1, 10, 40, 50, 90]) {
      for (const reserve of [0, 1, 50, 90]) {
        const plan = planBudgets(total, share, reserve);
        assert.equal(plan.notifications + plan.codes, plan.total, `${total}/${share}/${reserve} : notifications + codes = total`);
        assert.equal(plan.existingReserve + plan.newNumbers, plan.codes, `${total}/${share}/${reserve} : réserve + inconnus = codes`);
        for (const part of [plan.notifications, plan.codes, plan.existingReserve, plan.newNumbers, plan.newNumbersPerHour]) assert.ok(Number.isSafeInteger(part) && part >= 0, `${total}/${share}/${reserve}`);
        assert.ok(plan.newNumbersPerHour <= plan.newNumbers || plan.newNumbers === 0, "le lissage horaire ne dépasse pas la part du jour");
        assert.equal(plan.newNumbersPerHour === 0, plan.newNumbers === 0);
      }
    }
  }
  // Petits plafonds : une part non nulle garde au moins 1 envoi quand le plafond le permet.
  assert.deepEqual(planBudgets(1), { total: 1, notifications: 0, codes: 1, existingReserve: 0, newNumbers: 1, newNumbersPerHour: 1 });
  assert.equal(planBudgets(2).notifications, 1);
  assert.equal(planBudgets(2, 40, 50).codes, 1);
});

test("planBudgets refuse les valeurs hors bornes", () => {
  for (const total of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => planBudgets(total), RangeError, String(total));
  for (const share of [0, 91, -5, 40.5, Number.NaN]) assert.throws(() => planBudgets(1_000, share, 50), RangeError, `part ${share}`);
  for (const reserve of [-1, 91, 100, 10.5, Number.NaN]) assert.throws(() => planBudgets(1_000, 40, reserve), RangeError, `réserve ${reserve}`);
});

test("budgetVerdict : plafond total, budget des notifications, budget des codes, part des numéros inconnus, lissage horaire — chaque refus a son motif", () => {
  const plan: SmsBudgetPlan = { total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 30, newNumbersPerHour: 4 };
  // Total : refuse tout, essai du fondateur compris.
  for (const purpose of ["otp", "notification", "smoke"] as const) assert.equal(budgetVerdict(plan, { ...zero, total: 100 }, purpose, "existing"), "total", purpose);
  // Essai du fondateur : seulement le total.
  assert.equal(budgetVerdict(plan, { ...zero, total: 99, codes: 60, notifications: 40, newNumbers: 30, newNumbersHour: 4 }, "smoke", null), null);
  // Notifications : budget propre, indépendant des codes.
  assert.equal(budgetVerdict(plan, { ...zero, total: 60, codes: 60, newNumbers: 30, newNumbersHour: 4 }, "notification", null), null, "codes épuisés : les notifications partent");
  assert.equal(budgetVerdict(plan, { ...zero, total: 40, notifications: 40 }, "notification", null), "notifications");
  assert.equal(budgetVerdict(plan, { ...zero, total: 39, notifications: 39 }, "notification", null), null);
  // Codes : indépendants des notifications.
  assert.equal(budgetVerdict(plan, { ...zero, total: 40, notifications: 40 }, "otp", "existing"), null, "notifications épuisées : les codes partent");
  assert.equal(budgetVerdict(plan, { ...zero, total: 60, codes: 60 }, "otp", "existing"), "codes");
  assert.equal(budgetVerdict(plan, { ...zero, total: 60, codes: 60 }, "otp", "new"), "codes");
  // Numéros existants : accès à TOUT le budget codes, y compris la part inconnue, et jamais limités par la part inconnue ni par l'heure.
  assert.equal(budgetVerdict(plan, { ...zero, total: 59, codes: 59, newNumbers: 30, newNumbersHour: 4 }, "otp", "existing"), null);
  // Numéros inconnus (ou non établis) : la part non réservée seulement, puis le lissage horaire.
  assert.equal(budgetVerdict(plan, { ...zero, total: 30, codes: 30, newNumbers: 30 }, "otp", "new"), "new_numbers");
  assert.equal(budgetVerdict(plan, { ...zero, total: 30, codes: 30, newNumbers: 30 }, "otp", null), "new_numbers", "non établi = inconnu");
  assert.equal(budgetVerdict(plan, { ...zero, total: 29, codes: 29, newNumbers: 29 }, "otp", "new"), null);
  assert.equal(budgetVerdict(plan, { ...zero, total: 4, codes: 4, newNumbers: 4, newNumbersHour: 4 }, "otp", "new"), "new_numbers_hour");
  assert.equal(budgetVerdict(plan, { ...zero, total: 3, codes: 3, newNumbers: 3, newNumbersHour: 3 }, "otp", "new"), null);
});

test("B1-e — codes d'erreur de budget : stables, préfixés, reconnus par isBudgetErrorCode seulement", () => {
  assert.deepEqual([...SMS_BUDGET_ERROR_CODES], ["budget_total", "budget_codes", "budget_new_numbers", "budget_new_numbers_hour", "budget_notifications"]);
  for (const scope of ["total", "codes", "new_numbers", "new_numbers_hour", "notifications"] as const) {
    assert.equal(budgetErrorCode(scope), `budget_${scope}`);
    assert.match(budgetErrorCode(scope), /^[a-z0-9_]{1,60}$/, "compatible avec la contrainte de la colonne error_code");
    assert.equal(isBudgetErrorCode(budgetErrorCode(scope)), true);
  }
  for (const other of ["daily_cap", "rate_limited", "journal_unavailable", "provider_unavailable", "", null, undefined, "budget_", "budget_other"]) assert.equal(isBudgetErrorCode(other), false, String(other));
});

test("configuration : parts par défaut, valeurs lues, bornes, et le plan suit NOMA_SMS_DAILY_CAP", () => {
  const defaults = readSmsConfig({});
  assert.equal(defaults.notificationSharePercent, 40);
  assert.equal(defaults.existingReservePercent, 50);
  assert.equal(defaults.budgetSharesValid, true);
  assert.deepEqual(defaults.budget, planBudgets(1_000));
  const custom = readSmsConfig({ NOMA_SMS_DAILY_CAP: "200", NOMA_SMS_NOTIFICATION_SHARE_PERCENT: " 25 ", NOMA_SMS_EXISTING_RESERVE_PERCENT: "0" });
  assert.deepEqual(custom.budget, planBudgets(200, 25, 0));
  assert.equal(custom.budgetSharesValid, true);
  for (const bad of ["0", "91", "abc", "40.5", "-1", "4e1", "１０"]) {
    assert.equal(readSmsConfig({ NOMA_SMS_NOTIFICATION_SHARE_PERCENT: bad }).budgetSharesValid, false, `part ${bad}`);
  }
  for (const bad of ["91", "100", "abc", "-1", "1.5"]) {
    assert.equal(readSmsConfig({ NOMA_SMS_EXISTING_RESERVE_PERCENT: bad }).budgetSharesValid, false, `réserve ${bad}`);
  }
  // Une valeur invalide rend le branchement inactif (jamais un découpage par défaut silencieux).
  assert.equal(isMenoActive(readSmsConfig({ ...PRODUCTION, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "abc" })), false);
  assert.match(menoInactiveReason(readSmsConfig({ ...PRODUCTION, NOMA_SMS_EXISTING_RESERVE_PERCENT: "99" })) ?? "", /NOMA_SMS_EXISTING_RESERVE_PERCENT/);
});

test("production : refus de démarrer avec une part invalide (message nommant la variable, jamais la valeur)", () => {
  assert.doesNotThrow(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "40", NOMA_SMS_EXISTING_RESERVE_PERCENT: "50" }));
  assert.throws(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "0" }), /^Error: NOMA_SMS_NOTIFICATION_SHARE_PERCENT invalide \(entier de 1 à 90\)$/);
  assert.throws(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "secret-valeur" }), (error: unknown) => error instanceof Error && !error.message.includes("secret-valeur"));
  assert.throws(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_SMS_EXISTING_RESERVE_PERCENT: "95" }), /^Error: NOMA_SMS_EXISTING_RESERVE_PERCENT invalide \(entier de 0 à 90\)$/);
});

test("M2 — NOMA_PUBLIC_URL trop longue : refus au démarrage si la notification au pire cas ne tient pas en un segment (limite exacte)", () => {
  // Constantes alignées sur le code réel des notifications.
  assert.equal(NOTIFICATION_LINK_PATH, EXTERNAL_MESSAGE_LINK);
  assert.ok(NOTIFICATION_WORST_CASE_COUNT >= NOTIFY_ROWS_PER_USER, "le pire cas couvre le plus grand message possible");
  assert.ok(String(NOTIFICATION_WORST_CASE_COUNT).length >= String(NOTIFY_ROWS_PER_USER).length);
  const fits = (publicUrl: string) => analyzeSms(notificationMessage(NOTIFICATION_WORST_CASE_COUNT, `${publicUrl}${EXTERNAL_MESSAGE_LINK}`)).singleSegment;
  // Trouve la plus longue origine https qui tient (domaine de 63 caractères au plus par étiquette : on empile des étiquettes).
  const origin = (length: number) => `https://${"a".repeat(Math.max(length - "https://".length - ".ci".length, 1))}.ci`;
  let longest = 0;
  for (let length = 20; length < 200; length += 1) if (fits(origin(length))) longest = length;
  assert.ok(longest > 60 && longest < 160, `limite trouvée : ${longest}`);
  const accepted = origin(longest);
  const refused = origin(longest + 1);
  assert.equal(fits(refused), false);
  assert.doesNotThrow(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_PUBLIC_URL: accepted }), "la plus longue origine qui tient est acceptée");
  assert.throws(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_PUBLIC_URL: refused }), /^Error: NOMA_PUBLIC_URL trop longue/);
  // Le message ne contient pas l'adresse elle-même.
  try {
    assertSmsProductionConfig({ ...PRODUCTION, NOMA_PUBLIC_URL: refused });
  } catch (error) {
    assert.equal((error as Error).message.includes("aaaa"), false);
  }
  // Une adresse internationalisée est convertie en « xn--… » (ASCII) par l'analyse de l'URL : sa longueur réelle est celle du message envoyé.
  assert.throws(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_PUBLIC_URL: `https://${"é".repeat(150)}.ci` }), /^Error: NOMA_PUBLIC_URL trop longue/);
  assert.doesNotThrow(() => assertSmsProductionConfig({ ...PRODUCTION, NOMA_PUBLIC_URL: "https://noma-café.ci" }));
  // Hors production : aucune vérification.
  assert.doesNotThrow(() => assertSmsProductionConfig({ ...PRODUCTION, NODE_ENV: "development", NOMA_PUBLIC_URL: refused }));
});
