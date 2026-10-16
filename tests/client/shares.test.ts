import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { createSharesClient, describeShareError } from "../../lib/client/shares-api";
import { PUBLIC_DEAD, SHARE_WHAT_LINES, publicNeedLines, shareUrl, statusText } from "../../lib/client/shares-view";
import { SHARE_TOKEN_PATTERN, publicNeedView, sharePath, type PublicNeedSource } from "../../lib/shares-rules";
import { formatFcfa } from "../../lib/client/wallet-view";

const DEMAND = "11111111-1111-4111-8111-111111111111";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const ROOT = join(import.meta.dirname, "..", "..");

const source = (overrides: Partial<PublicNeedSource> = {}): PublicNeedSource => ({
  category: "Téléphones", brand: "Apple", model: "iPhone 13", variant: "128 Go", condition_text: "Occasion", quantity: 1, unit: "pièce", location_text: "Cocody", budget_amount: 300000, budget_currency: "XOF", ...overrides,
});

describe("vue publique d'un besoin", () => {
  test("champs structurés seulement : produit, état, zone, quantité, budget ; jamais de texte brut, d'identifiant ni de date", () => {
    const view = publicNeedView(source());
    assert.deepEqual(view, { title: "Apple iPhone 13 128 Go", category: "Téléphones", condition: "Occasion", location: "Cocody", quantity: 1, unit: "pièce", budget: { amount: 300000, currency: "XOF" } });
    assert.deepEqual(Object.keys(view).sort(), ["budget", "category", "condition", "location", "quantity", "title", "unit"]);
    assert.equal(publicNeedView(source({ brand: null, model: null, variant: null })).title, "Téléphones");
    assert.equal(publicNeedView(source({ brand: null, model: null, variant: null, category: null })).title, "Un produit");
    assert.deepEqual(publicNeedView(source({ budget_amount: null, budget_currency: null })).budget, null);
    assert.deepEqual(publicNeedView(source({ budget_currency: "EUR" })).budget, null, "une autre devise n'est pas servie");
    assert.equal(publicNeedView(source({ quantity: 0 })).quantity, null);
    assert.equal(publicNeedView(source({ location_text: "x".repeat(81) })).location, null, "texte trop long : omis");
    assert.equal(publicNeedView(source({ location_text: "Co‮cody" })).location, null, "caractère de direction : omis");
  });

  test("un champ qui est un numéro est omis seul ; un numéro réparti sur plusieurs champs fait omettre tous les textes libres", () => {
    const single = publicNeedView(source({ location_text: "07 00 00 00 42" }));
    assert.equal(single.location, null);
    assert.equal(single.condition, "Occasion");
    assert.equal(single.title, "Apple iPhone 13 128 Go");
    const split = publicNeedView(source({ location_text: "07 00 00", condition_text: "00 42 11 22", unit: "55" }));
    assert.deepEqual([split.location, split.condition, split.unit, split.category], [null, null, null, null]);
    assert.equal(split.title, "Un produit", "prudence : on ne sait pas quels champs forment le numéro, tous les textes libres sont omis, produit compris");
    const wholeSplit = publicNeedView(source({ brand: "07 00", model: "00 00", variant: "00 42" }));
    assert.equal(wholeSplit.title, "Un produit");
    assert.equal(JSON.stringify(wholeSplit).includes("07 00"), false);
  });

  test("jeton : 22 caractères base64url ; l'adresse publique n'existe que pour un jeton bien formé", () => {
    assert.match(TOKEN, SHARE_TOKEN_PATTERN);
    for (const bad of ["", "trop-court", `${TOKEN}x`, "AbCdEfGhIjKlMnOpQrSt+/", "AbCdEfGhIjKlMnOpQrSt U"]) assert.equal(SHARE_TOKEN_PATTERN.test(bad), false, bad);
    assert.equal(sharePath(TOKEN), `/besoin/${TOKEN}`);
    assert.equal(sharePath("x"), null);
    assert.equal(shareUrl("https://noma.example.ci/", `/besoin/${TOKEN}`), `https://noma.example.ci/besoin/${TOKEN}`);
    for (const bad of ["/besoin/x", `/autre/${TOKEN}`, `besoin/${TOKEN}`]) assert.equal(shareUrl("https://noma.example.ci", bad), null, bad);
  });
});

describe("présentation", () => {
  test("le résumé public : lignes dans un ordre fixe, un champ absent n'est pas inventé ; l'écran du propriétaire dit ce que le lien montre et ne montre pas", () => {
    const view = publicNeedLines(publicNeedView(source()));
    assert.equal(view.title, "Apple iPhone 13 128 Go");
    assert.deepEqual(view.lines, ["Catégorie : Téléphones", "État souhaité : Occasion", "Zone : Cocody", "Quantité : 1 pièce", `Budget : jusqu'à ${formatFcfa(300000)}`]);
    assert.deepEqual(publicNeedLines(publicNeedView(source({ category: null, condition_text: null, location_text: null, quantity: null, unit: null, budget_amount: null, budget_currency: null }))).lines, []);
    assert.equal(publicNeedLines(publicNeedView(source({ brand: null, model: null, variant: null }))).lines.some((line) => line.startsWith("Catégorie")), false, "la catégorie n'est pas répétée quand elle est le titre");
    assert.ok(SHARE_WHAT_LINES.some((line) => /Jamais votre nom, votre numéro/.test(line)));
    assert.equal(statusText({ active: false, createdAt: null }), "Aucun lien actif pour ce besoin.");
    assert.match(statusText({ active: true, createdAt: "2031-01-01T10:00:00.000Z" }), /^Un lien est actif depuis le /);
    assert.equal(PUBLIC_DEAD, "Ce lien n'est plus valable.");
  });
});

describe("client HTTP", () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("création, état, révocation : réponses relues strictement ; le jeton doit avoir la bonne forme et correspondre au chemin", async () => {
    const seen: string[] = [];
    const client = createSharesClient({
      fetch: async (path, init) => {
        seen.push(`${init?.method} ${String(path)}`);
        if (init?.method === "POST") return json(201, { contractVersion: "shares/v1", share: { path: `/besoin/${TOKEN}`, token: TOKEN, createdAt: "2031-01-01T10:00:00.000Z", extra: 1 } });
        if (init?.method === "DELETE") return json(200, { contractVersion: "shares/v1", revoked: true });
        return json(200, { contractVersion: "shares/v1", share: { active: true, createdAt: "2031-01-01T10:00:00.000Z" } });
      },
    });
    const created = await client.create(DEMAND);
    assert.deepEqual(Object.keys(created).sort(), ["createdAt", "path", "token"]);
    assert.deepEqual(await client.status(DEMAND), { active: true, createdAt: "2031-01-01T10:00:00.000Z" });
    assert.equal(await client.revoke(DEMAND), true);
    assert.deepEqual(seen, [`POST /api/demands/${DEMAND}/share`, `GET /api/demands/${DEMAND}/share`, `DELETE /api/demands/${DEMAND}/share`]);
    const mismatch = createSharesClient({ fetch: async () => json(201, { contractVersion: "shares/v1", share: { path: "/besoin/AUTRE_JETON_AUTRE_JET", token: TOKEN, createdAt: "2031-01-01T10:00:00.000Z" } }) });
    await assert.rejects(() => mismatch.create(DEMAND), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    await assert.rejects(() => createSharesClient().status("pas-un-uuid"), (error: unknown) => error instanceof ApiError && error.code === "invalid_id");
  });

  test("lecture publique : un jeton mal formé ne part pas (404 local), la réponse est relue champ par champ, un 404 du serveur reste un 404", async () => {
    let calls = 0;
    const client = createSharesClient({ fetch: async () => { calls += 1; return json(200, { contractVersion: "shares/v1", need: { title: "Apple iPhone 13", category: "Téléphones", condition: null, location: "Cocody", quantity: 1, unit: null, budget: { amount: 300000, currency: "XOF" }, secret: "x" } }); } });
    await assert.rejects(() => client.shared("court"), (error: unknown) => error instanceof ApiError && error.status === 404);
    assert.equal(calls, 0);
    const need = await client.shared(TOKEN);
    assert.equal("secret" in need, false);
    assert.equal(need.location, "Cocody");
    const dead = createSharesClient({ fetch: async () => json(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }) });
    await assert.rejects(() => dead.shared(TOKEN), (error: unknown) => error instanceof ApiError && error.status === 404);
    const bad = createSharesClient({ fetch: async () => json(200, { contractVersion: "shares/v1", need: { title: "", category: null, condition: null, location: null, quantity: null, unit: null, budget: null } }) });
    await assert.rejects(() => bad.shared(TOKEN), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    assert.equal(describeShareError(new ApiError(429, "share_daily_limit", "x")), "Vous avez créé le nombre de liens autorisés aujourd'hui. Réessayez demain.");
    assert.match(describeShareError(new ApiError(404, "resource_not_found", "x")), /n'est plus actif/);
    assert.equal(describeShareError(new Error("fuite")), "Une erreur est survenue. Réessayez dans un instant.");
  });
});

describe("câblage", () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

  test("la page publique est hors des espaces gardés : jamais indexée, sans Referer, sans garde de session ; l'ancienne page « partager » a disparu, l'entrée est sur la page du besoin", () => {
    const layout = read("app/(public)/besoin/[token]/layout.tsx");
    assert.match(layout, /robots: \{ index: false, follow: false/);
    assert.match(layout, /referrer: "no-referrer"/);
    const page = read("app/(public)/besoin/[token]/page.tsx");
    assert.doesNotMatch(page, /SessionGate|useUnauthorizedRedirect/);
    assert.match(page, /shares\.shared\(token/);
    assert.throws(() => read("app/(buyer)/partager/page.tsx"), /ENOENT/);
    assert.match(read("app/(buyer)/besoins/[id]/page.tsx"), /\/partager`/);
    assert.match(read("app/(buyer)/besoins/[id]/partager/page.tsx"), /shares\.create\(demandId\)/);
  });

  test("l'API publique renvoie les en-têtes noindex et no-referrer, le jeton n'est jamais stocké (empreinte seule)", () => {
    const http = read("lib/server/shares/http.ts");
    assert.match(http, /"X-Robots-Tag": "noindex, nofollow"/);
    assert.match(http, /"Referrer-Policy": "no-referrer"/);
    const shareModule = read("lib/server/shares/shares.ts");
    assert.match(shareModule, /hashShareToken\(token\)\]/);
    assert.doesNotMatch(shareModule, /INSERT INTO demand_share_links \(demand_id, owner_id, token\)/);
  });
});
