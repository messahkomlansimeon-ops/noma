import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  MISSION_FIELDS,
  checkMissionInput,
  checkMissionPatch,
  checkOrderQuantity,
  cleanMissionText,
  missionPhoneMessage,
  missionProductLabel,
  missionTitle,
  type MissionInput,
} from "../../lib/missions-rules";
import { looksLikePhoneNumberAcross } from "../../lib/phone-text";

/**
 * Règles pures des missions d'achat en volume (lot MV1) : champs obligatoires et facultatifs, bornes des entiers, texte propre (NFKC, rien d'invisible), règle des numéros de
 * téléphone sur chaque champ et sur le titre assemblé.
 */

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: "Téléphones",
  brand: "Apple",
  model: "iPhone 12",
  variant: "128 Go",
  condition: "Occasion",
  quantity: 20,
  unit: "pièce",
  unitBudgetXof: 170_000,
  totalBudgetXof: 3_200_000,
  location: "Abidjan",
  deadlineDays: 30,
  ...overrides,
});

describe("mission complète", () => {
  test("une mission valide est acceptée telle quelle ; variante et lieu facultatifs", () => {
    const checked = checkMissionInput(valid());
    assert.equal(checked.ok, true);
    assert.deepEqual((checked as { value: MissionInput }).value, valid());
    const minimal = checkMissionInput({ ...valid(), variant: null, location: null });
    assert.equal(minimal.ok, true);
    const absent = { ...valid() };
    delete absent.variant;
    delete absent.location;
    const withoutOptional = checkMissionInput(absent);
    assert.equal(withoutOptional.ok, true);
    assert.deepEqual([(withoutOptional as { value: MissionInput }).value.variant, (withoutOptional as { value: MissionInput }).value.location], [null, null]);
  });

  test("chaque champ obligatoire manquant est refusé, avec son nom", () => {
    for (const field of MISSION_FIELDS) {
      if (field === "variant" || field === "location") continue;
      const input = { ...valid() };
      delete input[field];
      const checked = checkMissionInput(input);
      assert.deepEqual(checked, { ok: false, code: "invalid_mission", field }, field);
    }
  });

  test("bornes des entiers : quantité 2 à 10 000, budget par unité 1 à 100 000 000, durée 1 à 90, budget total au moins égal au budget par unité", () => {
    const ok = (overrides: Record<string, unknown>) => checkMissionInput(valid(overrides)).ok;
    assert.equal(ok({ quantity: 2 }), true);
    assert.equal(ok({ quantity: 10_000 }), true);
    for (const quantity of [1, 0, -1, 10_001, 2.5, "20", null, Number.NaN, Number.MAX_SAFE_INTEGER + 1, true]) assert.deepEqual(checkMissionInput(valid({ quantity })), { ok: false, code: "invalid_mission", field: "quantity" }, String(quantity));
    assert.equal(ok({ unitBudgetXof: 1, totalBudgetXof: 1 }), true);
    assert.equal(ok({ unitBudgetXof: 100_000_000, totalBudgetXof: 100_000_000 }), true);
    for (const unitBudgetXof of [0, -5, 100_000_001, 1.5, "170000", null]) assert.deepEqual(checkMissionInput(valid({ unitBudgetXof })), { ok: false, code: "invalid_mission", field: "unitBudgetXof" }, String(unitBudgetXof));
    assert.equal(ok({ totalBudgetXof: 170_000 }), true, "égal au budget par unité");
    assert.deepEqual(checkMissionInput(valid({ totalBudgetXof: 169_999 })), { ok: false, code: "invalid_mission", field: "totalBudgetXof" });
    assert.equal(ok({ totalBudgetXof: 1_000_000_000_000 }), true);
    assert.deepEqual(checkMissionInput(valid({ totalBudgetXof: 1_000_000_000_001 })), { ok: false, code: "invalid_mission", field: "totalBudgetXof" });
    assert.equal(ok({ deadlineDays: 1 }), true);
    assert.equal(ok({ deadlineDays: 90 }), true);
    for (const deadlineDays of [0, 91, -1, 1.5, "30", null]) assert.deepEqual(checkMissionInput(valid({ deadlineDays })), { ok: false, code: "invalid_mission", field: "deadlineDays" }, String(deadlineDays));
  });

  test("forme : un objet simple et ses champs seulement ; tout champ inconnu, tableau, nul, __proto__ est refusé", () => {
    for (const raw of [null, undefined, "x", 3, [], [valid()], new Date(), { ...valid(), extra: 1 }, { ...valid(), activate: true }, JSON.parse('{"__proto__": {"x": 1}}')]) {
      assert.deepEqual(checkMissionInput(raw), { ok: false, code: "invalid_mission", field: null });
    }
    assert.deepEqual(checkMissionInput(Object.assign(Object.create({ inherited: 1 }), valid())), { ok: false, code: "invalid_mission", field: null }, "prototype étranger");
  });
});

describe("texte", () => {
  test("NFKC, espaces ramenés à un, texte rogné ; 50 caractères au plus (20 pour l'unité, 80 pour le lieu)", () => {
    const checked = checkMissionInput(valid({ brand: "  Ａpple  ", model: "iPhone \n 12" }));
    assert.equal(checked.ok, true);
    assert.equal((checked as { value: MissionInput }).value.brand, "Apple");
    assert.equal((checked as { value: MissionInput }).value.model, "iPhone 12");
    assert.equal(checkMissionInput(valid({ brand: "a".repeat(50) })).ok, true);
    assert.deepEqual(checkMissionInput(valid({ brand: "a".repeat(51) })), { ok: false, code: "invalid_mission", field: "brand" });
    assert.equal(checkMissionInput(valid({ unit: "u".repeat(20) })).ok, true);
    assert.deepEqual(checkMissionInput(valid({ unit: "u".repeat(21) })), { ok: false, code: "invalid_mission", field: "unit" });
    assert.equal(checkMissionInput(valid({ location: "l".repeat(80) })).ok, true);
    assert.deepEqual(checkMissionInput(valid({ location: "l".repeat(81) })), { ok: false, code: "invalid_mission", field: "location" });
  });

  test("vide, espaces seuls, types faux : refusés ; une variante ou un lieu vide est refusé (null s'il n'y en a pas)", () => {
    for (const brand of ["", "   ", null, 12, ["a"], {}]) assert.deepEqual(checkMissionInput(valid({ brand })), { ok: false, code: "invalid_mission", field: "brand" }, JSON.stringify(brand));
    assert.deepEqual(checkMissionInput(valid({ variant: "  " })), { ok: false, code: "invalid_mission", field: "variant" });
    assert.deepEqual(checkMissionInput(valid({ location: "" })), { ok: false, code: "invalid_mission", field: "location" });
  });

  test("caractères de contrôle, de direction de texte et invisibles : refusés, avant comme après normalisation", () => {
    for (const bad of ["Ap\u0000ple", "Ap\u200bple", "Ap\u202eple", "Ap\u2066ple", "Ap\u0085ple", "Ap\u0007ple", "Ap\u2060ple"]) {
      assert.deepEqual(checkMissionInput(valid({ brand: bad })), { ok: false, code: "invalid_mission", field: "brand" }, JSON.stringify(bad));
    }
    assert.equal(cleanMissionText("a\u0007b", 10), null);
    assert.equal(cleanMissionText("ab", 10), "ab");
    // Les espaces de toute sorte (tabulation, saut de ligne, séparateur de ligne) ne sont pas dangereux : ils deviennent UN espace.
    assert.equal(cleanMissionText("a\t\n\u2028 b", 10), "a b");
  });
});

describe("caractères invisibles, marques combinantes isolées, champs sans lettre ni chiffre (MV1-bis)", () => {
  /** Remplisseurs Hangul, braille vide, joint de graphème, sélecteur de variante, soft hyphen, marque de lettre arabe, séparateur mongol, étiquette : jamais dans un champ. */
  const invisible: Array<[string, string]> = [
    ["U+3164", "\u3164"], ["U+FFA0", "\uFFA0"], ["U+115F", "Apple\u115F"], ["U+1160", "Apple\u1160"], ["U+2800", "\u2800"], ["U+2800 dans un mot", "App\u2800le"], ["U+034F", "Ap\u034Fple"],
    ["U+FE0F", "Apple\uFE0F"], ["U+00AD", "App\u00ADle"], ["U+061C", "Apple\u061C"], ["U+180E", "Apple\u180E"], ["U+17B4", "Apple\u17B4"], ["tag U+E0041", "Apple\u{E0041}"],
    ["U+2060", "Apple\u2060"], ["U+200B", "App\u200Ble"], ["U+FEFF", "\uFEFFApple"], ["U+1D173", "Apple\u{1D173}"],
  ];

  test("tout caractère ignorable par défaut d'Unicode, U+2800, U+3164, U+FFA0, U+115F et U+1160 sont refusés dans chacun des champs texte", () => {
    for (const field of ["category", "brand", "model", "variant", "condition", "unit", "location"] as const) {
      for (const [name, value] of invisible) {
        assert.deepEqual(checkMissionInput(valid({ [field]: value })), { ok: false, code: "invalid_mission", field }, `${field} ← ${name}`);
        assert.equal(cleanMissionText(value, 50), null, name);
      }
    }
  });

  test("une marque combinante isolée (au début, après une espace ou un signe) est refusée ; une lettre accentuée, composée ou décomposée, est acceptée", () => {
    for (const bad of ["\u0301", "\u0301a", " \u0301a", "a \u0301", "a-\u0301", "1 \u20D0", "\u0300\u0301e"]) {
      assert.equal(cleanMissionText(bad, 50), null, JSON.stringify(bad));
      assert.deepEqual(checkMissionInput(valid({ model: bad })), { ok: false, code: "invalid_mission", field: "model" }, JSON.stringify(bad));
    }
    assert.equal(cleanMissionText("E\u0301clair", 50), "Éclair", "décomposé : recomposé par NFKC");
    assert.equal(cleanMissionText("Éclair", 50), "Éclair");
    assert.equal(cleanMissionText("Ça va", 50), "Ça va");
    assert.equal(cleanMissionText("हिन्दी", 50), "हिन्दी", "un texte indien dont les voyelles sont des marques combinantes passe : elles s'appuient sur une lettre");
  });

  test("chaque champ porte au moins une lettre ou un chiffre : ponctuation, signes et symboles seuls sont refusés", () => {
    for (const bad of ["-", "---", "...", "!?", "()", "\u2014", "@#%", "©", "😀", "+ -"]) {
      assert.equal(cleanMissionText(bad, 50), null, JSON.stringify(bad));
      for (const field of ["category", "brand", "model", "condition", "unit", "variant", "location"] as const) {
        assert.deepEqual(checkMissionInput(valid({ [field]: bad })), { ok: false, code: "invalid_mission", field }, `${field} ← ${bad}`);
      }
    }
    for (const good of ["A", "7", "iPhone 12", "S21+", "A-1", "Été", "(Neuf) 5G", "Нет", "日本"]) assert.equal(cleanMissionText(good, 50), good, good);
  });
});

describe("règle des numéros de téléphone", () => {
  const phones = ["07 08 09 10 11", "0708091011", "+225 07 08 09 10 11", "٠٧٠٨٠٩١٠١١", "０７０８０９１０１１", "WhatsApp 0708091011", "07-08-09-10-11", "O7 O8 O9 1O 11"];

  test("un numéro dans n'importe quel champ texte est refusé, avec le champ nommé", () => {
    for (const field of ["category", "brand", "model", "variant", "condition", "unit", "location"] as const) {
      for (const phone of phones) {
        const checked = checkMissionInput(valid({ [field]: phone }));
        assert.deepEqual(checked, { ok: false, code: "phone_number_in_mission", field }, `${field} : ${phone}`);
      }
    }
    assert.match(missionPhoneMessage("model"), /Pas de numéro de téléphone dans la mission \(champ : modèle\)/);
    assert.match(missionPhoneMessage(null), /Pas de numéro de téléphone dans la mission/);
  });

  test("le titre ASSEMBLÉ est contrôlé : un numéro coupé entre marque, modèle et variante, ou plus de 8 chiffres au total, est refusé", () => {
    assert.deepEqual(checkMissionInput(valid({ brand: "07 08", model: "09 10", variant: "11" })), { ok: false, code: "phone_number_in_mission", field: null });
    assert.deepEqual(checkMissionInput(valid({ brand: "A 1234", model: "B 5678", variant: "C 9012" })), { ok: false, code: "phone_number_in_mission", field: null });
    assert.equal(checkMissionInput(valid({ model: "Galaxy S21", variant: "128 Go" })).ok, true, "5 chiffres au total");
  });

  test("la règle s'applique aussi à la CONCATÉNATION de tous les champs libres : un numéro coupé entre le modèle et le lieu, la catégorie et l'état, l'unité et le lieu est refusé", () => {
    const refused = (overrides: Record<string, unknown>) => assert.deepEqual(checkMissionInput(valid(overrides)), { ok: false, code: "phone_number_in_mission", field: null }, JSON.stringify(overrides));
    // Champs voisins : la concaténation.
    refused({ category: "Tél 07 08", brand: "Apple", model: "iPhone", variant: null, condition: "09 10 11", location: null });
    refused({ condition: "Occasion 07 08", unit: "09 10", location: "11" });
    refused({ unit: "lot 07 08 09", location: "10 11" });
    // Champs séparés par d'autres champs de lettres (cas de l'audit) : le squelette numérique.
    refused({ model: "iPhone 0708", variant: null, location: "Cocody 091011" });
    refused({ model: "iPhone 07 08", variant: null, condition: "09", location: "10 11" });
    refused({ brand: "Apple 07", model: "iPhone 08 09", variant: "10 11", location: null });
    refused({ category: "Téléphones 0708", model: "iPhone", variant: null, location: "Cocody 091011" });
    refused({ model: "Phone 225", variant: null, condition: "Occasion 07080910", location: "Abidjan" });
    // Un nombre autonome de plus entre les morceaux ne masque pas le numéro quand la fenêtre de 10 chiffres reste lisible (« 0708 12 1011 » : 4 + 2 + 4 chiffres).
    refused({ category: "Tél 0708", model: "iPhone 12", variant: null, location: "Cocody 1011" });
    // Chiffres d'un autre alphabet et sosies de chiffres : lus comme les autres.
    refused({ model: "iPhone ٠٧٠٨", variant: null, location: "Cocody ٠٩١٠١١" });
    refused({ model: "iPhone O7O8", variant: null, location: "Cocody 09 10 11" });
    assert.equal(looksLikePhoneNumberAcross(["iPhone 0708", "Cocody 091011"]), true);
    assert.equal(looksLikePhoneNumberAcross(["iPhone 12", "Cocody"]), false);
    assert.equal(looksLikePhoneNumberAcross([null, undefined, "", "Cocody"]), false);
    assert.equal(looksLikePhoneNumberAcross([]), false);
  });

  test("des champs honnêtes dont les chiffres ne forment pas un numéro passent (modèle, capacité, lieu, lot)", () => {
    for (const overrides of [
      { model: "iPhone 12", variant: "128 Go", location: "Cocody 2 Plateaux" },
      { brand: "Samsung", model: "Galaxy S21", variant: "256 Go 5G", location: "Yopougon Siporex" },
      { category: "Électroménager", brand: "LG", model: "GR-B459", variant: "450 L", condition: "Neuf", unit: "carton de 4", location: "Marcory zone 4" },
      { brand: "Dell", model: "Latitude 5520", variant: "16 Go", location: "Plateau" },
      // Les chiffres collés à un nom (S21, 5G, i7) ne sont pas des nombres : « 21 128 5 2023 » n'est pas lu comme un numéro de fixe.
      { brand: "Samsung", model: "Galaxy S21", variant: "128 Go 5G", condition: "Occasion 2023", location: "Cocody 2 Plateaux" },
      { brand: "Apple", model: "iPhone 12", variant: "64 Go", condition: "Comme neuf", unit: "lot de 5", location: "Marcory zone 4 rue 12" },
    ]) {
      assert.equal(checkMissionInput(valid(overrides)).ok, true, JSON.stringify(overrides));
    }
  });

  test("les textes honnêtes passent : références, dimensions, quantités, années", () => {
    for (const model of ["Réf. 9300-1234", "2400×1080", "12 500 000", "S21 Ultra 5G", "iPhone 12 Pro Max"]) {
      const checked = checkMissionInput(valid({ model, variant: null }));
      assert.equal(checked.ok, true, model);
    }
  });
});

describe("modification d'un brouillon", () => {
  test("au moins un champ, chacun valide seul ; champ inconnu ou vide refusé", () => {
    assert.deepEqual(checkMissionPatch({ quantity: 12, location: null }), { ok: true, patch: { quantity: 12, location: null } });
    assert.deepEqual(checkMissionPatch({}), { ok: false, code: "invalid_mission", field: null });
    assert.deepEqual(checkMissionPatch({ quantity: 12, extra: 1 }), { ok: false, code: "invalid_mission", field: null });
    assert.deepEqual(checkMissionPatch({ quantity: 1 }), { ok: false, code: "invalid_mission", field: "quantity" });
    assert.deepEqual(checkMissionPatch({ brand: "07 08 09 10 11" }), { ok: false, code: "phone_number_in_mission", field: "brand" });
    assert.deepEqual(checkMissionPatch([]), { ok: false, code: "invalid_mission", field: null });
  });
});

describe("quantité d'une commande et titres", () => {
  test("entier de 1 à 10 000, sinon null", () => {
    assert.equal(checkOrderQuantity(1), 1);
    assert.equal(checkOrderQuantity(10_000), 10_000);
    for (const value of [0, -1, 10_001, 1.5, "3", null, undefined, Number.NaN, true]) assert.equal(checkOrderQuantity(value), null, String(value));
  });

  test("titre : « 20 × Apple iPhone 12 128 Go »", () => {
    assert.equal(missionProductLabel({ brand: "Apple", model: "iPhone 12", variant: "128 Go" }), "Apple iPhone 12 128 Go");
    assert.equal(missionProductLabel({ brand: "Apple", model: "iPhone 12", variant: null }), "Apple iPhone 12");
    assert.equal(missionTitle({ quantity: 20, brand: "Apple", model: "iPhone 12", variant: null }), "20 × Apple iPhone 12");
  });
});

describe("déploiement : la migration d'abord", () => {
  const root = join(import.meta.dirname, "../..");
  const deploiement = readFileSync(join(root, "DEPLOIEMENT.md"), "utf8");

  test("DEPLOIEMENT.md demande d'appliquer les migrations (npm run db:migrate) AVANT de démarrer la nouvelle version, après le build et avant le démarrage de l'instance", () => {
    // La COMMANDE elle-même (pas seulement la mention dans le commentaire) : exécutée par l'utilisateur de service avec le fichier d'environnement de production.
    const command = /^sudo -u noma sh -c '[^'\n]*\. \/opt\/noma\/shared\/\.env\.production[^'\n]*npm run db:migrate'$/m.exec(deploiement);
    assert.ok(command !== null, "la commande « npm run db:migrate » figure dans la séquence d'installation");
    const migrate = command.index;
    const build = deploiement.indexOf("npm run build:production'");
    const start = deploiement.indexOf("# 4. instance unique liée à 127.0.0.1");
    assert.ok(migrate !== -1 && build !== -1 && start !== -1, "les trois étapes sont dans la séquence d'installation");
    assert.ok(build < migrate && migrate < start, "build, puis migrations, puis démarrage de l'instance");
    assert.match(deploiement, /APPLIQUER LES MIGRATIONS DE LA BASE[^\n]*AVANT de démarrer/);
    assert.match(deploiement, /sauvegarde `pg_dump`/i);
    assert.match(deploiement, /0027_missions/);
  });

  test("la migration des missions est celle que le code attend : fichier présent, constante identique", async () => {
    const { MISSIONS_MIGRATION } = await import("../../lib/server/missions/config");
    assert.equal(MISSIONS_MIGRATION, "0027_missions");
    const sql = readFileSync(join(root, "database/migrations", `${MISSIONS_MIGRATION}.sql`), "utf8");
    assert.match(sql, /^-- Migration 0027 : missions d'achat en volume/);
  });
});
