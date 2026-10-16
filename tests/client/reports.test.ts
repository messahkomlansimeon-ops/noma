import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { createReportsClient, describeReportError } from "../../lib/client/reports-api";
import type { AdminReportDetail, AdminReportRow } from "../../lib/client/reports-api";
import {
  decisionConfirmText,
  decisionOutcomeText,
  dossierFacts,
  dossierRow,
  myReportRow,
  openCountText,
  parseReportTarget,
  reportOfferPath,
  reportOrderPath,
} from "../../lib/client/reports-view";
import { formatFcfa } from "../../lib/client/wallet-view";
import { checkDecisionInput, checkReportInput, REPORT_DETAIL_MAX } from "../../lib/reports-rules";

const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const ROOT = join(import.meta.dirname, "..", "..");
const params = (query: string) => new URLSearchParams(query);

const row = (overrides: Partial<AdminReportRow> = {}): AdminReportRow => ({
  id: A, status: "open", targetType: "offer", reason: "fraud", targetTitle: "Apple iPhone 12", reporterMaskedPhone: "+•••••••••42", reportedMaskedPhone: "+•••••••••07",
  reportedOpenCount: 1, decision: null, createdAt: "2031-01-01T10:00:00.000Z", ...overrides,
});

describe("règles partagées des signalements", () => {
  test("un signalement : cible connue, motif connu, annonce AVEC son besoin, commande SANS besoin, aucune clé inconnue, texte sans numéro ni caractère invisible", () => {
    const ok = checkReportInput({ targetType: "offer", targetId: A, demandId: B, reason: "fraud", detail: "  Prix trompeur  " });
    assert.deepEqual(ok, { ok: true, value: { targetType: "offer", targetId: A, demandId: B, reason: "fraud", detail: "Prix trompeur" } });
    assert.deepEqual(checkReportInput({ targetType: "order", targetId: A, reason: "abusive" }), { ok: true, value: { targetType: "order", targetId: A, demandId: null, reason: "abusive", detail: null } });
    for (const bad of [
      null, [], "x", { targetType: "offer", targetId: A, reason: "fraud" }, { targetType: "order", targetId: A, demandId: B, reason: "fraud" }, { targetType: "user", targetId: A, reason: "fraud" },
      { targetType: "order", targetId: "x", reason: "fraud" }, { targetType: "order", targetId: A, reason: "autre" }, { targetType: "order", targetId: A, reason: "fraud", extra: 1 },
      { targetType: "order", targetId: A, reason: "fraud", detail: "x".repeat(REPORT_DETAIL_MAX + 1) }, { targetType: "order", targetId: A, reason: "fraud", detail: 5 }, { targetType: "order", targetId: A, reason: "fraud", detail: "a‮b" },
    ]) assert.equal(checkReportInput(bad).ok, false, JSON.stringify(bad));
    for (const detail of ["appelez le 07 00 00 00 42", "+225 07 11 22 33 44", "0700000042", "zéro sept zéro zéro 00 00 00 42"]) {
      const refused = checkReportInput({ targetType: "order", targetId: A, reason: "fraud", detail });
      if (!refused.ok) assert.equal(refused.reason, "phone", detail);
    }
    assert.deepEqual(checkReportInput({ targetType: "order", targetId: A, reason: "fraud", detail: "0700000042" }), { ok: false, reason: "phone" });
  });

  test("une décision : connue, avec un motif OBLIGATOIRE, sans numéro, sans clé inconnue", () => {
    assert.deepEqual(checkDecisionInput({ decision: "dismissed", note: " Sans suite " }), { ok: true, value: { decision: "dismissed", note: "Sans suite" } });
    for (const bad of [{}, { decision: "dismissed" }, { decision: "dismissed", note: "  " }, { decision: "bannir", note: "x" }, { decision: "dismissed", note: "x", extra: 1 }, { decision: "dismissed", note: "x".repeat(501) }, "x", null]) {
      assert.equal(checkDecisionInput(bad).ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(checkDecisionInput({ decision: "dismissed", note: "appelez 0700000042" }), { ok: false, reason: "phone" });
  });
});

describe("présentation", () => {
  test("adresses : le formulaire n'accepte que des UUID ; la cible lue dans l'adresse est une annonce ET son besoin, ou une commande, jamais un mélange", () => {
    assert.equal(reportOfferPath(B, A), `/signaler?besoin=${B}&annonce=${A}`);
    assert.equal(reportOfferPath("x", A), null);
    assert.equal(reportOrderPath(A), `/signaler?commande=${A}`);
    assert.equal(reportOrderPath("x"), null);
    assert.deepEqual(parseReportTarget(params(`besoin=${B}&annonce=${A}`)), { type: "offer", offerId: A, demandId: B });
    assert.deepEqual(parseReportTarget(params(`commande=${A}`)), { type: "order", orderId: A });
    for (const query of ["", `annonce=${A}`, `besoin=${B}`, `commande=${A}&annonce=${B}`, `commande=${A}&besoin=${B}`, "commande=x", `annonce=x&besoin=${B}`]) assert.equal(parseReportTarget(params(query)), null, query);
  });

  test("« Mes signalements » : ouvert ou clos, motif et date ; jamais de décision", () => {
    const open = myReportRow({ id: A, targetType: "offer", reason: "wrong_info", status: "open", targetTitle: "Apple iPhone 12", createdAt: "2031-01-01T10:00:00.000Z" });
    assert.equal(open.title, "Annonce : Apple iPhone 12");
    assert.equal(open.reasonText, "Informations fausses ou trompeuses");
    assert.equal(open.statusText, "En cours d'examen");
    assert.equal(open.open, true);
    assert.equal(myReportRow({ id: A, targetType: "order", reason: "other", status: "closed", targetTitle: "Commande", createdAt: "2031-01-01T10:00:00.000Z" }).statusText, "Traité");
  });

  test("dossiers : numéros masqués seulement, alerte quand un compte est visé plusieurs fois, décision en clair, faits sans interprétation", () => {
    assert.equal(openCountText(1), null);
    assert.equal(openCountText(3), "3 dossiers ouverts visent ce compte");
    const open = dossierRow(row({ reportedOpenCount: 2 }));
    assert.equal(open.reportedText, "Compte signalé : +•••••••••07");
    assert.equal(open.alertText, "2 dossiers ouverts visent ce compte");
    assert.equal(open.decisionText, null);
    const closed = dossierRow(row({ status: "closed", decision: "seller_suspended", reportedOpenCount: 5 }));
    assert.equal(closed.decisionText, "Compte signalé suspendu");
    assert.equal(closed.alertText, null, "plus d'alerte sur un dossier clos");
    assert.equal(dossierRow(row({ reportedMaskedPhone: null })).reportedText, "Compte signalé : numéro non vérifié");
    const detail: AdminReportDetail = {
      ...row(), reportedTotalCount: 3, reportedStatus: "active", detail: "Prix trompeur", decisionNote: null, decidedAt: null, decidedByMaskedPhone: null,
      offer: { status: "published", availability: "available", priceAmount: 250000, priceCurrency: "XOF" }, order: null,
    };
    const facts = dossierFacts(detail);
    assert.deepEqual(facts, [`Annonce en ligne, disponible · ${formatFcfa(250000)}`, "Compte signalé : actif", "Dossiers visant ce compte : 1 ouvert sur 3 au total"]);
    assert.equal(dossierFacts({ ...detail, offer: null, order: { status: "confirmed", priceAmount: 90000 } })[0], `Commande confirmée · ${formatFcfa(90000)}`);
    assert.equal(decisionOutcomeText("seller_suspended", true), "Dossier clos : compte suspendu.");
    assert.equal(decisionOutcomeText("dismissed", false), "Dossier clos sans suite.");
    assert.match(decisionConfirmText("seller_suspended", "+•••••••••07"), /sera suspendu.*journal d'administration/);
    assert.match(decisionConfirmText("dismissed", null), /sans suite/);
    assert.equal(/\+225|\b07\d{8}\b/.test(JSON.stringify([open, closed, facts])), false);
  });
});

describe("client HTTP", () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("création : contrôlée AVANT l'envoi (un texte refusé ne part pas), corps nettoyé, réponse relue champ par champ", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = createReportsClient({ fetch: async (path, init) => { calls.push({ path: String(path), init: init ?? {} }); return json(201, { contractVersion: "reports/v1", report: { id: A, status: "open", createdAt: "2031-01-01T10:00:00.000Z", extra: "ignoré" } }); } });
    await assert.rejects(() => client.create({ targetType: "order", targetId: A, demandId: null, reason: "fraud", detail: "0700000042" }), (error: unknown) => error instanceof ApiError && error.code === "phone_number_in_report");
    assert.equal(calls.length, 0);
    const created = await client.create({ targetType: "order", targetId: A, demandId: null, reason: "fraud", detail: "  Colis jamais reçu  " });
    assert.deepEqual(created, { id: A, status: "open", createdAt: "2031-01-01T10:00:00.000Z" });
    assert.equal(calls[0].path, "/api/reports");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(JSON.parse(String(calls[0].init.body)).detail, "Colis jamais reçu");
  });

  test("erreurs : le code et le statut viennent du serveur, jamais son texte ; une réponse inattendue devient une erreur fixe ; un identifiant invalide ne part pas", async () => {
    const refused = createReportsClient({ fetch: async () => json(409, { error: { code: "already_reported", message: "texte du serveur" } }) });
    await assert.rejects(() => refused.create({ targetType: "order", targetId: A, demandId: null, reason: "fraud", detail: null }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(describeReportError(error, "send"), "Vous avez déjà signalé cet élément : le signalement est en cours de traitement.");
      return error.status === 409 && error.code === "already_reported";
    });
    const wrong = createReportsClient({ fetch: async () => json(200, { contractVersion: "autre/v9", reports: [] }) });
    await assert.rejects(() => wrong.mine(), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    const never = createReportsClient({ fetch: async () => { throw new Error("ne doit pas partir"); } });
    await assert.rejects(() => never.admin.get("pas-un-uuid"), (error: unknown) => error instanceof ApiError && error.code === "invalid_id");
    await assert.rejects(() => never.admin.decide(A, { decision: "dismissed", note: "" }), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    assert.equal(describeReportError(new ApiError(429, "reports_daily_limit", "x"), "send"), "Vous avez atteint le nombre de signalements autorisés aujourd'hui. Réessayez demain.");
    assert.equal(describeReportError(new ApiError(404, "resource_not_found", "x"), "send"), "Cet élément n'est plus signalable : il a peut-être été retiré.");
    assert.equal(describeReportError(new ApiError(409, "target_protected", "x"), "admin"), "Un compte administrateur ne peut pas être suspendu : classez le dossier sans suite.");
    assert.equal(describeReportError(new Error("fuite"), "send"), "Une erreur est survenue. Réessayez dans un instant.");
  });

  test("administration : file, détail et décision passent par les routes d'administration avec la liste blanche des champs", async () => {
    const seen: string[] = [];
    const detailBody = { ...row(), reportedTotalCount: 1, reportedStatus: "active", detail: null, decisionNote: null, decidedAt: null, decidedByMaskedPhone: null, offer: { status: "published", availability: null, priceAmount: null, priceCurrency: null }, order: null, secret: "x" };
    const client = createReportsClient({
      fetch: async (path, init) => {
        seen.push(`${init?.method} ${String(path)}`);
        if (String(path).startsWith("/api/admin/reports?")) return json(200, { contractVersion: "reports/v1", total: 1, limit: 20, offset: 0, reports: [row()] });
        if (String(path).endsWith("/decision")) return json(200, { contractVersion: "reports/v1", status: "closed", decision: "dismissed", suspended: false });
        return json(200, { contractVersion: "reports/v1", report: detailBody });
      },
    });
    assert.equal((await client.admin.list({ status: "open", limit: 20, offset: 0 })).reports.length, 1);
    const detail = await client.admin.get(A);
    assert.equal("secret" in detail, false, "un champ ajouté un jour par le serveur n'atteint jamais l'écran");
    assert.deepEqual(await client.admin.decide(A, { decision: "dismissed", note: "Sans suite." }), { status: "closed", decision: "dismissed", suspended: false });
    assert.deepEqual(seen, ["GET /api/admin/reports?status=open&limit=20&offset=0", `GET /api/admin/reports/${A}`, `POST /api/admin/reports/${A}/decision`]);
  });
});

describe("câblage", () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

  test("les pages sont branchées sur le serveur (plus « Bientôt disponible »), l'annonce et la commande mènent au formulaire, le compte mène à « Mes signalements »", () => {
    for (const page of ["app/(buyer)/signaler/page.tsx", "app/(admin)/admin/dossiers/page.tsx", "app/(admin)/admin/dossiers/[id]/page.tsx"]) {
      assert.doesNotMatch(read(page), /ComingSoon/, page);
      assert.match(read(page), /reports\./, page);
    }
    assert.match(read("app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx"), /reportOfferPath\(demandId, offerId\)/);
    assert.match(read("components/orders/order-detail.tsx"), /reportOrderPath\(orderId\)/);
    assert.match(read("app/(buyer)/compte/page.tsx"), /href="\/signaler"/);
  });

  test("la file et le dossier sont dans l'espace d'administration (gabarit gardé : 404 pour un compte ordinaire), sans garde propre", () => {
    for (const page of ["app/(admin)/admin/dossiers/page.tsx", "app/(admin)/admin/dossiers/[id]/page.tsx"]) {
      assert.doesNotMatch(read(page), /requireAdminSpace/, page);
    }
  });
});
