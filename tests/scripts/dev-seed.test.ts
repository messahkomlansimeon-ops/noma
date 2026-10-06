import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  DEFAULT_SEED_BASE_PRICE,
  DEFAULT_SEED_OFFERS,
  FAKE_PHONE_PREFIX,
  MAX_SEED_OFFERS,
  SEED_MARKER,
  SeedUsageError,
  capitalizeFirst,
  checkSeedEnvironment,
  databaseNameOf,
  fakeSellerId,
  fakeSellerPhone,
  isFakeSellerPhone,
  parseSeedArguments,
  planSeedOffers,
  resolveSeedCategory,
} from "../../scripts/dev-seed-plan";

/**
 * `npm run dev:seed` : partie pure (arguments, garde-fous, vendeurs fictifs, plan des annonces) et refus en processus enfant. Aucune base n'est
 * ouverte ici : les refus testés se produisent AVANT toute connexion (l'adresse de base utilisée désigne un port fermé, preuve par la sortie).
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/dev-seed.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../../poc/node_modules/tsx/dist/loader.mjs", import.meta.url));
const GOOD_URL = "postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai";
const PRODUCT = ["--category", "phones", "--brand", "apple", "--model", "iphone 12"];

describe("catégories", () => {
  test("l'alias phones et les libellés de l'interface (casse et accents ignorés) donnent le libellé de l'interface", () => {
    assert.equal(resolveSeedCategory("phones"), "Téléphones");
    assert.equal(resolveSeedCategory(" PHONES "), "Téléphones");
    assert.equal(resolveSeedCategory("telephones"), "Téléphones");
    assert.equal(resolveSeedCategory("Téléphones"), "Téléphones");
    assert.equal(resolveSeedCategory("electronique"), "Électronique");
    assert.equal(resolveSeedCategory("Maison et meubles"), "Maison et meubles");
    assert.equal(resolveSeedCategory("furniture"), "Maison et meubles");
    assert.equal(resolveSeedCategory("vehicles"), "Véhicules");
  });
  test("une catégorie inconnue, vide ou héritée du prototype est refusée", () => {
    for (const value of ["jouets", "", "   ", "toString", "constructor", "__proto__", "phones;"]) assert.equal(resolveSeedCategory(value), null, value);
  });
});

describe("arguments", () => {
  test("valeurs par défaut : 8 annonces, prix de référence 150 000", () => {
    const options = parseSeedArguments(PRODUCT);
    assert.deepEqual(options, { category: "Téléphones", brand: "apple", model: "iphone 12", offers: DEFAULT_SEED_OFFERS, basePrice: DEFAULT_SEED_BASE_PRICE });
    assert.equal(DEFAULT_SEED_OFFERS, 8);
  });
  test("toutes les options, dans n'importe quel ordre", () => {
    const options = parseSeedArguments(["--price", "90000", "--offers", "10", "--model", " iphone 13 ", "--brand", "Apple", "--category", "Électronique"]);
    assert.deepEqual(options, { category: "Électronique", brand: "Apple", model: "iphone 13", offers: 10, basePrice: 90_000 });
  });
  test("bornes de --offers : 1 à 50, entier en chiffres seulement", () => {
    assert.equal(parseSeedArguments([...PRODUCT, "--offers", "1"]).offers, 1);
    assert.equal(parseSeedArguments([...PRODUCT, "--offers", String(MAX_SEED_OFFERS)]).offers, 50);
    for (const bad of ["0", "51", "-1", "abc", "8.5", "1e1", "", " 8", "08x", "1000"]) {
      assert.throws(() => parseSeedArguments([...PRODUCT, "--offers", bad]), SeedUsageError, `--offers ${JSON.stringify(bad)}`);
    }
  });
  test("bornes de --price : 1 000 à 100 000 000", () => {
    assert.equal(parseSeedArguments([...PRODUCT, "--price", "1000"]).basePrice, 1_000);
    assert.equal(parseSeedArguments([...PRODUCT, "--price", "100000000"]).basePrice, 100_000_000);
    for (const bad of ["999", "100000001", "-5000", "abc", "15000.5", "1500000000", ""]) {
      assert.throws(() => parseSeedArguments([...PRODUCT, "--price", bad]), SeedUsageError, `--price ${JSON.stringify(bad)}`);
    }
  });
  test("option manquante, valeur manquante, option inconnue ou répétée, catégorie inconnue, texte invalide : refus avec un message clair", () => {
    assert.throws(() => parseSeedArguments([]), /--category est obligatoire/);
    assert.throws(() => parseSeedArguments(["--category", "phones", "--model", "x"]), /--brand est obligatoire/);
    assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "x"]), /--model est obligatoire/);
    assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "  ", "--model", "x"]), /--brand est obligatoire/);
    assert.throws(() => parseSeedArguments([...PRODUCT, "--offers"]), /valeur manquante/);
    assert.throws(() => parseSeedArguments([...PRODUCT, "--offers", "--price"]), /valeur manquante/);
    assert.throws(() => parseSeedArguments([...PRODUCT, "--colour", "red"]), /option inconnue ou répétée/);
    assert.throws(() => parseSeedArguments([...PRODUCT, "--brand", "samsung"]), /option inconnue ou répétée/);
    assert.throws(() => parseSeedArguments(["--category", "jouets", "--brand", "a", "--model", "b"]), /catégorie inconnue/);
    assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "a\nb", "--model", "x"]), /--brand doit être un texte/);
    assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "a", "--model", "x".repeat(61)]), /--model doit être un texte/);
    assert.throws(() => parseSeedArguments(["phones"]), /valeur manquante/);
  });
  test("lot P3 : --brand et --model refusent les caractères de contrôle et de direction de texte (bidi) ; les accents, espaces et symboles courants restent permis", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
    const control = [0x00, 0x01, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029];
    for (const code of [...bidi, ...control]) {
      const character = String.fromCodePoint(code);
      for (const flag of ["--brand", "--model"] as const) {
        const args = ["--category", "phones", "--brand", "apple", "--model", "iphone 12"];
        args[args.indexOf(flag) + 1] = `abc${character}def`;
        assert.throws(() => parseSeedArguments(args), SeedUsageError, `${flag} U+${code.toString(16)}`);
        const alone = ["--category", "phones", "--brand", "apple", "--model", "iphone 12"];
        alone[alone.indexOf(flag) + 1] = character;
        assert.throws(() => parseSeedArguments(alone), SeedUsageError, `${flag} seul U+${code.toString(16)}`);
      }
    }
    assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", "gpt\u202Efdp.exe"]), /sans caractère de contrôle ni de direction de texte/);
    for (const fine of ["Galaxy S21 Ultra 5G", "iPhone 12 — 128 Go", "Écouteurs Électro", "TV 55\" (4K)", "a", "x".repeat(60), "日本語", "😀 phone"]) {
      assert.equal(parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", fine]).model, fine, fine);
    }
  });
});

describe("lot P3-bis (N6) : caractères invisibles et de format refusés", () => {
  const invisible = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x2061, 0x2064, 0x180e, 0x206a, 0xe0020];
  const base = () => ["--category", "phones", "--brand", "apple", "--model", "iphone 12"];
  test("U+200B à U+200D, U+2060, U+FEFF (et tout format Cf) refusés dans --category, --brand et --model : au milieu, au bord, seul", () => {
    for (const code of invisible) {
      const character = String.fromCodePoint(code);
      for (const flag of ["--category", "--brand", "--model"] as const) {
        for (const value of [`ab${character}cd`, `${character}abc`, `abc${character}`, character]) {
          const args = base();
          args[args.indexOf(flag) + 1] = flag === "--category" ? `phones${value}` : value;
          if (flag === "--category" && value === character) args[args.indexOf(flag) + 1] = character;
          assert.throws(() => parseSeedArguments(args), SeedUsageError, `${flag} U+${code.toString(16)} « ${value.length} »`);
        }
      }
    }
  });
  test("le message cite le champ fautif et ne reprend jamais la valeur saisie (--category compris)", () => {
    const args = base();
    args[1] = "pho\u200Bnes";
    assert.throws(() => parseSeedArguments(args), (error: unknown) => error instanceof SeedUsageError && /^--category doit être un texte de 1 à 60 caractères/.test(error.message) && !error.message.includes("\u200b"));
    const model = base();
    model[5] = "iphone\u200B 12";
    assert.throws(() => parseSeedArguments(model), /--model doit être un texte de 1 à 60 caractères sans caractère de contrôle ni de direction de texte, ni caractère invisible/);
    // Bord de valeur : trim() retire U+FEFF sans le dire ; la valeur BRUTE est contrôlée.
    const edge = base();
    edge[3] = "\uFEFFapple";
    assert.throws(() => parseSeedArguments(edge), /--brand doit être/);
  });
  test("les accents, espaces, symboles et emoji sans jonction restent permis ; espaces de bord toujours rognés", () => {
    for (const fine of ["Galaxy S21 Ultra 5G", "Écouteurs Électro", "日本語", "😀 phone", "iPhone 12 — 128 Go"]) {
      assert.equal(parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", fine]).model, fine, fine);
    }
    assert.equal(parseSeedArguments(["--category", "phones", "--brand", "  apple ", "--model", " iphone 12 "]).brand, "apple");
  });
});

describe("garde-fous de l'environnement", () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_URL: GOOD_URL, ...extra });

  test("acceptée : NODE_ENV absent, vide ou « development », base locale de la liste blanche (noma_essai, noma_e2e, noma_essai_*)", () => {
    assert.deepEqual(checkSeedEnvironment(env()), { ok: true, databaseName: "noma_essai" });
    assert.equal(checkSeedEnvironment(env({ NODE_ENV: "" })).ok, true);
    assert.equal(checkSeedEnvironment(env({ NODE_ENV: "development" })).ok, true);
    assert.equal(checkSeedEnvironment(env({ NODE_ENV: " development " })).ok, true);
    assert.deepEqual(checkSeedEnvironment({ DATABASE_URL: "postgres://u:p@localhost:5432/noma_e2e" }), { ok: true, databaseName: "noma_e2e" });
    assert.deepEqual(checkSeedEnvironment({ DATABASE_URL: "postgres://u:p@[::1]/noma_essai?sslmode=disable" }), { ok: true, databaseName: "noma_essai" });
    // Bases jetables noma_essai_* (minuscules, chiffres, tiret bas) : acceptées.
    for (const name of ["noma_essai_x", "noma_essai_ab12", "noma_essai_20261006_tmp", "noma_essai_" + "a".repeat(40)]) {
      assert.deepEqual(checkSeedEnvironment({ DATABASE_URL: `postgres://u:p@localhost/${name}` }), { ok: true, databaseName: name }, name);
    }
  });
  test("refus : NODE_ENV défini et différent de development (production, test, staging…)", () => {
    for (const value of ["production", "Production", "test", "staging", "prod", "dev"]) {
      const result = checkSeedEnvironment(env({ NODE_ENV: value }));
      assert.equal(result.ok, false, value);
      if (!result.ok) assert.match(result.reason, /NODE_ENV vaut/);
    }
  });
  test("refus : DATABASE_URL absente, vide ou blanche (aucune valeur par défaut)", () => {
    for (const value of [undefined, "", "   "]) {
      const result = checkSeedEnvironment({ DATABASE_URL: value });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /DATABASE_URL est obligatoire/);
    }
  });
  test("refus : base qui n'est pas de CE poste (hôte distant, surcharge host/hostaddr, adresse illisible)", () => {
    for (const url of [
      "postgres://u:p@db.example.com:5432/noma_essai",
      "postgres://u:p@10.0.0.4/noma_essai",
      "postgres://u:p@127.0.0.1/noma_essai?host=db.example.com",
      "postgres://u:p@localhost/noma_essai?hostaddr=8.8.8.8",
      "mysql://u:p@localhost/noma_essai",
      "pas une adresse",
    ]) {
      const result = checkSeedEnvironment({ DATABASE_URL: url });
      assert.equal(result.ok, false, url);
      if (!result.ok) {
        assert.match(result.reason, /base de CE poste/);
        assert.match(result.reason, /dev:seed n'écrit rien/);
        assert.ok(!result.reason.includes("p@") && !result.reason.includes("db.example.com"), "le motif ne contient jamais l'adresse");
      }
    }
  });
  test("refus : tout nom hors de la liste blanche (lot P3) — noma_test, noma_prod, noma_dev (toutes graphies), noma_* quelconque, casse, suffixes", () => {
    const refused = [
      "postgres", "autre", "essai_noma", "NOMA_essai", "noma", "",
      "noma_test", "noma_prod", "noma_production", "noma_staging", "noma_perf_p3", "noma_restore_test_1",
      "noma_dev", "noma_DEV", "noma_Dev", "noma%5Fdev", "noma_dev2", "noma_dev_essai",
      "noma_essai2", "noma_essai-x", "noma_essai_", "noma_essai_X", "noma_Essai", "noma_E2E", "noma_e2e2", "noma_e2e_x", "noma_essai_" + "a".repeat(41),
      "noma_essai_a b", "noma_essai_é",
    ];
    for (const name of refused) {
      const result = checkSeedEnvironment({ DATABASE_URL: `postgres://u:p@127.0.0.1:5432/${name}` });
      assert.equal(result.ok, false, name);
      if (!result.ok) {
        assert.match(result.reason, /dev:seed ne peuple que les bases d'essai noma_essai, noma_e2e et noma_essai_\*/, name);
        assert.ok(!result.reason.includes("u:p@"), "le motif ne contient jamais l'adresse");
      }
    }
  });
  test("databaseNameOf lit le nom comme pg le lit", () => {
    assert.equal(databaseNameOf("postgres://u:p@localhost:5432/noma_essai?sslmode=disable"), "noma_essai");
    assert.equal(databaseNameOf("postgres://u:p@localhost/noma%5Fessai"), "noma_essai");
    assert.equal(databaseNameOf("postgres://u:p@localhost"), "");
    assert.equal(databaseNameOf("pas une adresse"), "");
    assert.equal(databaseNameOf("postgres://u:p@localhost/%E0%A4%A"), "");
  });
});

describe("vendeurs fictifs et plan des annonces", () => {
  test("numéros du bloc +225 07 99 99 99 01 à 50, un par annonce, hors bloc refusés", () => {
    assert.equal(FAKE_PHONE_PREFIX, "+2250799999");
    assert.equal(fakeSellerPhone(1), "+225079999901");
    assert.equal(fakeSellerPhone(8), "+225079999908");
    assert.equal(fakeSellerPhone(50), "+225079999950");
    for (const bad of [0, 51, -1, 1.5, Number.NaN]) assert.throws(() => fakeSellerPhone(bad), RangeError, String(bad));
    for (let index = 1; index <= 50; index += 1) assert.equal(isFakeSellerPhone(fakeSellerPhone(index)), true);
    for (const other of ["+225079999900", "+225079999951", "+22507999999", "+2250799999011", "+225070000001", "+22507999999AB", ""]) assert.equal(isFakeSellerPhone(other), false, other);
  });
  test("identifiant de vendeur fictif : UUID v4 de forme, stable, distinct par numéro", () => {
    const ids = new Set<string>();
    for (let index = 1; index <= 50; index += 1) {
      const id = fakeSellerId(fakeSellerPhone(index));
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(fakeSellerId(fakeSellerPhone(index)), id, "stable d'un appel à l'autre");
      ids.add(id);
    }
    assert.equal(ids.size, 50);
  });
  test("plan : une annonce par vendeur, prix du moins cher au plus cher entre 70 % et 105 % du prix de référence, arrondis à 1 000 FCFA", () => {
    const plan = planSeedOffers({ category: "Téléphones", brand: "apple", model: "iphone 12", offers: 8, basePrice: 150_000 });
    assert.equal(plan.length, 8);
    assert.deepEqual(plan.map((entry) => entry.index), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(plan.map((entry) => entry.phone)).size, 8);
    assert.equal(plan[0].price, 105_000);
    assert.equal(plan[7].price, 158_000);
    for (const entry of plan) assert.equal(entry.price % 1_000, 0);
    for (let index = 1; index < plan.length; index += 1) assert.ok(plan[index].price >= plan[index - 1].price, "prix croissants");
    assert.equal(plan[0].title, "Apple iphone 12 · offre d'exemple n° 1");
    for (const entry of plan) {
      assert.ok(entry.rawText.startsWith(entry.title));
      assert.ok(entry.rawText.includes(SEED_MARKER), "le repère d'idempotence est présent");
    }
  });
  test("plan : une seule annonce au prix de référence ; prix minimum 1 000 ; le plan ne dépend que des options (rejouable à l'identique)", () => {
    assert.equal(planSeedOffers({ category: "Téléphones", brand: "a", model: "b", offers: 1, basePrice: 120_000 })[0].price, 120_000);
    assert.equal(planSeedOffers({ category: "Téléphones", brand: "a", model: "b", offers: 5, basePrice: 1_000 })[0].price, 1_000);
    const options = { category: "Téléphones", brand: "apple", model: "iphone 12", offers: 12, basePrice: 150_000 };
    assert.deepEqual(planSeedOffers(options), planSeedOffers({ ...options }));
    // --offers 10 après --offers 8 : les 8 premières ne bougent pas seulement si les prix ne dépendaient pas du total ; ici ils en dépendent
    // (étalement), c'est pourquoi l'idempotence repose sur le repère et le vendeur, pas sur le prix : voir le test d'intégration.
    assert.equal(capitalizeFirst("apple"), "Apple");
    assert.equal(capitalizeFirst(""), "");
  });
});

interface ChildResult {
  code: number | null;
  output: string;
}

/** Lance le vrai script sans NODE_ENV ni DATABASE_URL hérités ; `env` ajoute exactement ce que le cas veut. */
function runSeed(args: string[], env: Record<string, string>): Promise<ChildResult> {
  const base = { ...process.env };
  for (const key of ["NODE_ENV", "DATABASE_URL", "TEST_DATABASE_URL", "PGOPTIONS", "PGDATABASE", "PGHOST"]) delete base[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, SCRIPT, ...args], {
      cwd: process.cwd(),
      env: { ...base, NODE_OPTIONS: "--conditions=react-server", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("script trop long")); }, 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** Adresse locale dont le port est fermé : si le script tentait de se connecter, la sortie contiendrait une erreur de connexion. */
const CLOSED_PORT_URL = (name: string) => `postgresql://u:p@127.0.0.1:1/${name}`;

describe("refus en processus enfant (rien n'est écrit, aucune connexion)", () => {
  test("arguments invalides : code 1 et usage affiché", async () => {
    const result = await runSeed([], { DATABASE_URL: CLOSED_PORT_URL("noma_essai") });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /dev:seed : --category est obligatoire\. Usage : npm run dev:seed -- --category phones --brand apple --model "iphone 12"/);
    const offers = await runSeed([...PRODUCT, "--offers", "51"], { DATABASE_URL: CLOSED_PORT_URL("noma_essai") });
    assert.equal(offers.code, 1, offers.output);
    assert.match(offers.output, /--offers doit être un entier de 1 à 50/);
  });
  test("NODE_ENV=production et NODE_ENV=test : refus avant toute connexion", async () => {
    for (const nodeEnv of ["production", "test"]) {
      const result = await runSeed(PRODUCT, { NODE_ENV: nodeEnv, DATABASE_URL: CLOSED_PORT_URL("noma_essai") });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, new RegExp(`refus — NODE_ENV vaut « ${nodeEnv} »`));
      assert.ok(!/ECONNREFUSED|connect/i.test(result.output), `aucune connexion tentée : ${result.output}`);
    }
  });
  test("DATABASE_URL absente, distante, noma_dev ou hors noma_ : refus avant toute connexion", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /DATABASE_URL est obligatoire/],
      [{ DATABASE_URL: "postgresql://u:p@db.example.com:5432/noma_essai" }, /base de CE poste/],
      [{ DATABASE_URL: CLOSED_PORT_URL("noma_dev") }, /ne peuple que les bases d'essai noma_essai, noma_e2e et noma_essai_\*/],
      [{ DATABASE_URL: CLOSED_PORT_URL("noma_test") }, /ne peuple que les bases d'essai/],
      [{ DATABASE_URL: CLOSED_PORT_URL("noma_prod") }, /ne peuple que les bases d'essai/],
      [{ DATABASE_URL: CLOSED_PORT_URL("autre") }, /ne peuple que les bases d'essai/],
    ];
    for (const [env, pattern] of cases) {
      const result = await runSeed(PRODUCT, { NODE_ENV: "development", ...env });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, pattern);
      assert.ok(!/ECONNREFUSED|ENOTFOUND/i.test(result.output), `aucune connexion tentée : ${result.output}`);
      assert.ok(!result.output.includes("u:p@"), "l'adresse n'est jamais affichée");
    }
  });
  test("base d'essai valide mais injoignable : erreur courte sans l'adresse, code 1 (preuve que la garde laisse passer une base noma_essai locale)", async () => {
    const result = await runSeed(PRODUCT, { DATABASE_URL: CLOSED_PORT_URL("noma_essai") });
    assert.equal(result.code, 1, result.output);
    assert.ok(!result.output.includes("u:p@"), result.output);
    assert.ok(!/refus/.test(result.output), "ce n'est pas un refus de garde-fou");
  });
});
