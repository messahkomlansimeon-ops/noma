import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { extractCoinAfriqueCheerio } from "../sources/coinafrique-parser";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "coinafrique");
const baseUrl = "https://ci.coinafrique.com/search?keyword=test";
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const expected = (name: string) => JSON.parse(read(name)) as {
  listings: unknown[];
  errors: string[];
};

describe("CoinAfrique — extraction Cheerio pure", () => {
  test("téléphone, TV, chargeur, champs absents, carte invalide et doublon", async () => {
    const result = await extractCoinAfriqueCheerio({
      html: read("nominal.html"),
      baseUrl,
    });
    assert.deepEqual(result, expected("nominal.expected.json"));
    assert.equal(result.listings[0]?.id, result.listings[3]?.id, "le parseur ne déduplique pas");
  });

  test("page sans annonces = succès vide, sans donnée inventée", async () => {
    const result = await extractCoinAfriqueCheerio({ html: read("empty.html"), baseUrl });
    assert.deepEqual(result, expected("empty.expected.json"));
  });

  test("le HTML historique « Page non trouvée » reste un cas négatif", async () => {
    const html = readFileSync(join(fixtures, "../../../results/coinafrique-raw.html"), "utf8");
    assert.match(html, /Page non trouvée/i);
    const result = await extractCoinAfriqueCheerio({ html, baseUrl });
    assert.deepEqual(result, expected("empty.expected.json"));
  });

  test("une structure modifiée n'est pas prétendue compatible par Cheerio", async () => {
    const result = await extractCoinAfriqueCheerio({
      html: read("adaptive-changed.html"),
      baseUrl,
    });
    assert.deepEqual(result, expected("empty.expected.json"));
  });

  test("les blancs du titre sont retirés et un titre favori vide replie sur le lien", async () => {
    const result = await extractCoinAfriqueCheerio({
      html: `
        <div class="card ad__card">
          <a class="ad__card-image" href="/annonce/123" title="Titre du lien"></a>
          <div class="card-fav" data-ad-title="  Titre favori&#10;&#10;  "></div>
        </div>
        <div class="card ad__card">
          <a class="ad__card-image" href="/annonce/456" title="  Titre de repli  "></a>
          <div class="card-fav" data-ad-title="   "></div>
        </div>
      `,
      baseUrl,
    });

    assert.deepEqual(
      result.listings.map((listing) => listing.title),
      ["Titre favori", "Titre de repli"],
    );
  });
});
