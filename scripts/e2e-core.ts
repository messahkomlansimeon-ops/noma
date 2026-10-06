/**
 * `npm run e2e:core` : parcours de bout en bout contre un VRAI serveur Next (jamais lancé par ce script), en HTTP,
 * comme un navigateur (jar de cookies, en-tête Origin) À TRAVERS LE RELAIS DE DÉVELOPPEMENT (scripts/dev-proxy.ts) :
 * ce script n'envoie JAMAIS lui-même X-Noma-Proxy-Secret ni X-Forwarded-For, c'est le relais qui les écrit. Utilise la
 * couche cliente lib/client/api.ts et les constructeurs de saisie des écrans (lib/client/catalog-view.ts) : ce que les
 * écrans enverraient est exactement ce qui est envoyé ici. NON inclus dans `npm test`.
 *
 * Parcours : deux comptes par OTP, offre iPhone 12 publiée, besoin iPhone 12 activé, correspondances dans les deux sens
 * (indicateurs, `sponsored` faux), isolation entre comptes, refus d'origine, usurpation des en-têtes de confiance sans effet,
 * accès direct sans relais refusé (503), pages en 200, puis le scénario « mise en avant » : un vendeur concurrent publie
 * 8 offres du même produit, le vendeur A publie la plus chère, l'acheteur B active son besoin, devis de boost (201 puis 200
 * réutilisé, 409 pour une annonce en pause), attribution d'un boost par la commande d'administration `boost:grant`
 * (aucun paiement), puis l'acheteur voit l'offre « sponsorisée » en tête ; aucune identité de l'autre partie dans aucune réponse.
 *
 * Variables (voir scripts/e2e-common.ts) : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG,
 * NOMA_E2E_DATABASE_URL (noma_e2e, pour boost:grant), NOMA_E2E_DIRECT_URL (Next sans relais, défaut http://127.0.0.1:3211),
 * NOMA_E2E_WORKER_TIMEOUT_MS (attente bornée du worker, défaut 90000), NOMA_E2E_SEARCH_STREAM=1 (ajoute le contrôle du flux
 * NDJSON de /api/search : serveur lancé avec fausses sources, ce que fait `dev:try` sans aucune autre variable).
 * Les codes OTP lus dans le journal ne sont jamais affichés.
 */
import assert from "node:assert/strict";
import {
  ApiError,
  createApiClient,
  describeApiError,
  type DemandRecord,
  type OfferRecord,
  type StoredMatch,
} from "../lib/client/api";
import { buildDemandInput, buildOfferInput } from "../lib/client/catalog-view";
import {
  E2E_BASE,
  E2E_SERVER_LOG,
  RelaySession,
  awaitOtpLine,
  grantBoostByAdministration,
  logSize,
  loginWithOtp,
  pollUntil,
  uniquePhone,
} from "./e2e-common";

const DIRECT = (process.env.NOMA_E2E_DIRECT_URL ?? "http://127.0.0.1:3211").replace(/\/$/, "");
const WORKER_TIMEOUT_MS = Number(process.env.NOMA_E2E_WORKER_TIMEOUT_MS ?? "90000");

if (!E2E_SERVER_LOG) {
  console.error("e2e:core : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}

let checks = 0;
const startedAt = Date.now();

function ok(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function info(label: string): void {
  console.log(`    · ${label}`);
}

async function step<T>(title: string, run: () => Promise<T>): Promise<T> {
  console.log(`→ ${title}`);
  try {
    return await run();
  } catch (error) {
    console.error(`  ✗ ÉCHEC : ${error instanceof Error ? error.message : "erreur inattendue"}`);
    if (error instanceof ApiError) console.error(`    (ApiError status=${error.status} code=${error.code})`);
    process.exit(1);
  }
}

/** Connexion par OTP avec les contrôles du parcours (mauvais code refusé, bon code accepté, session renvoyée). */
async function login(session: RelaySession, phone: string): Promise<string> {
  const api = session.client();
  const offset = logSize();
  const challenge = await api.auth.requestOtp(phone);
  assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/);
  const { code, tail } = await awaitOtpLine(offset);
  assert.equal(tail, phone.slice(-2), "la ligne de code vise bien ce téléphone (deux derniers chiffres)");
  ok(`${session.label} : code OTP lu dans la sortie du serveur (téléphone masqué …${tail})`);
  const wrong = await api.auth.verifyOtp(challenge.challengeId, code === "000000" ? "000001" : "000000").then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(wrong instanceof ApiError && wrong.status === 401, "un mauvais code est refusé (401)");
  ok(`${session.label} : mauvais code refusé (401)`);
  const { userId } = await api.auth.verifyOtp(challenge.challengeId, code);
  assert.ok(session.cookies.has("noma_auth"), "le cookie noma_auth est posé");
  ok(`${session.label} : code correct accepté, cookie noma_auth posé`);
  const current = await api.auth.session();
  assert.equal(current.userId, userId);
  ok(`${session.label} : GET /api/auth/session renvoie le même userId`);
  return userId;
}

function expectApiError(error: unknown, status: number, code?: string): void {
  assert.ok(error instanceof ApiError, `ApiError attendue, reçu ${String(error)}`);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("la requête aurait dû être refusée");
    },
    (error: unknown) => error,
  );
}

/** Réponse brute (texte) d'une route GET : sert aux contrôles « aucune identité » que le client typé masquerait. */
async function rawGet(session: RelaySession, path: string): Promise<{ status: number; text: string; json: unknown }> {
  const response = await session.fetch(path);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

/**
 * Texte brut de TOUTES les pages d'une route `stored-matches` (curseurs suivis) : la base de l'essai (noma_e2e) garde les
 * données des essais précédents, donc une offre ou un besoin peut se trouver après la première page.
 */
async function rawAllPages(session: RelaySession, path: string): Promise<string> {
  const texts: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const raw: { status: number; text: string; json: unknown } = await rawGet(
      session,
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    assert.equal(raw.status, 200);
    texts.push(raw.text);
    cursor = (raw.json as { nextCursor: string | null }).nextCursor;
    if (!cursor) break;
  }
  return texts.join("\n");
}

/** Toutes les correspondances d'un besoin (pages de 100 suivies par curseur), tri donné. */
async function allMatches(session: RelaySession, demandId: string, sort: "score" | "relevance"): Promise<StoredMatch[]> {
  const api = session.client();
  const items: StoredMatch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 30; page += 1) {
    const result = await api.demands.storedMatches(demandId, { sort, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/** Tous les besoins qui correspondent à une offre (pages suivies par curseur). */
async function allDemandMatches(session: RelaySession, offerId: string): Promise<StoredMatch[]> {
  const api = session.client();
  const items: StoredMatch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 30; page += 1) {
    const result = await api.offers.storedMatches(offerId, { limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

async function main(): Promise<void> {
  const sellerPhone = uniquePhone("41");
  const buyerPhone = uniquePhone("42");
  const rivalPhone = uniquePhone("43");
  const spoofPhone = uniquePhone("44");
  const seller = new RelaySession("vendeur A");
  const buyer = new RelaySession("acheteur B");
  const rival = new RelaySession("vendeur concurrent C");
  const sellerApi = seller.client();
  const buyerApi = buyer.client();
  const rivalApi = rival.client();

  await step("Relais joignable, aucune session sans cookie", async () => {
    const response = await seller.fetch("/api/auth/session", { noCookies: true });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    ok(`GET ${E2E_BASE}/api/auth/session sans cookie : 401 (le relais joint le serveur)`);
    const noOffers = await rejects(sellerApi.offers.list());
    expectApiError(noOffers, 401, "authentication_required");
    ok("GET /api/offers sans session : 401 authentication_required");
  });

  let sellerId = "";
  await step("Vendeur A : connexion par OTP", async () => {
    sellerId = await login(seller, sellerPhone);
    const cookieLine = seller.cookieHeader();
    assert.match(cookieLine, /^noma_auth=[A-Za-z0-9_-]{43}$/);
    ok("jeton de session opaque de 43 caractères, jamais renvoyé dans un corps JSON");
  });

  let offer: OfferRecord = undefined as unknown as OfferRecord;
  await step("Vendeur A : crée puis publie une offre iPhone 12", async () => {
    const built = buildOfferInput({
      title: "iPhone 12 · 128 Go",
      description: "Écran impeccable, batterie 89 %.",
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      variant: "128 Go",
      condition: "Occasion",
      location: "Abidjan",
      price: "150 000",
      available: true,
    });
    assert.ok(built.ok);
    const created = await sellerApi.offers.create(built.input);
    assert.equal(created.status, "draft");
    assert.equal(created.contentVersion, 1);
    assert.deepEqual(created.price, { amount: 150000, currency: "XOF" });
    ok("POST /api/offers : 201, brouillon, version de contenu 1, prix 150000 XOF");
    offer = await sellerApi.offers.publish(created.id, created.contentVersion);
    assert.equal(offer.status, "published");
    assert.equal(offer.contentVersion, 2);
    ok("POST /api/offers/{id}/publish avec la version attendue : en ligne, version 2");
    const stale = await rejects(sellerApi.offers.publish(created.id, created.contentVersion));
    expectApiError(stale, 409, "content_version_conflict");
    ok("publication avec une version obsolète : 409 content_version_conflict");
    const listed = await sellerApi.offers.listAll();
    assert.ok(listed.items.some((candidate) => candidate.id === offer.id && candidate.status === "published"));
    ok("GET /api/offers : l'offre publiée figure dans la liste du vendeur");
  });

  let buyerId = "";
  await step("Acheteur B : connexion par OTP", async () => {
    buyerId = await login(buyer, buyerPhone);
    assert.notEqual(buyerId, sellerId);
    ok("deux comptes distincts");
  });

  let demand: DemandRecord = undefined as unknown as DemandRecord;
  await step("Acheteur B : crée puis active un besoin iPhone 12", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const built = buildDemandInput(
      {
        text: "Je cherche un iPhone 12 en bon état à Abidjan",
        category: "Téléphones",
        brand: "Apple",
        model: "iPhone 12",
        variant: "",
        condition: "Occasion",
        location: "Abidjan",
        budget: "200 000",
        deadline: "",
      },
      today,
    );
    assert.ok(built.ok);
    const created = await buyerApi.demands.create(built.input);
    assert.equal(created.status, "draft");
    ok("POST /api/demands : 201, brouillon, budget 200000 XOF");
    demand = await buyerApi.demands.activate(created.id, created.contentVersion);
    assert.equal(demand.status, "active");
    ok("POST /api/demands/{id}/activate : actif");
    const listed = await buyerApi.demands.listAll();
    assert.ok(listed.items.some((candidate) => candidate.id === demand.id && candidate.status === "active"));
    ok("GET /api/demands : le besoin actif figure dans la liste de l'acheteur");
  });

  await step("Matching asynchrone : le worker produit les correspondances enregistrées (via le relais)", async () => {
    // Tri par score (curseur sans limite de fenêtre) : la base de l'essai garde les offres iPhone 12 des essais précédents.
    const found = await pollUntil(
      "stored-matches du besoin",
      async () => {
        const items = await allMatches(buyer, demand.id, "score");
        return items.some((item) => item.candidateId === offer.id) ? items : null;
      },
      WORKER_TIMEOUT_MS,
    );
    ok(`GET /api/demands/{id}/stored-matches renvoie l'offre de A (${Math.round((Date.now() - startedAt) / 1000)} s depuis le début, ${found.length} offre(s) iPhone 12 au total dans la base de l'essai)`);
    const demandText = await rawAllPages(buyer, `/api/demands/${demand.id}/stored-matches?sort=score`);
    assert.equal(demandText.includes(sellerId), false, "aucun identifiant de propriétaire dans le DTO");
    assert.equal(demandText.includes(sellerPhone), false, "aucun téléphone dans le DTO");
    assert.equal(demandText.includes(sellerPhone.slice(4)), false, "aucun numéro local dans le DTO");
    ok("le DTO (toutes les pages) ne contient ni identifiant de vendeur ni téléphone");

    const item = found.find((candidate) => candidate.candidateId === offer.id);
    assert.ok(item);
    assert.equal(item.sponsored, false);
    assert.equal(found.some((candidate) => candidate.sponsored), false, "aucune offre sponsorisée sans boost");
    assert.ok(item.score !== null && item.score > 0 && item.score <= 100, `score de compatibilité 0..100 : ${String(item.score)}`);
    assert.ok(item.relevance >= 0 && item.relevance <= 100);
    assert.equal(item.indicators.confidence.accountAgeBand, "lt_7d");
    assert.ok(item.indicators.availability !== null && item.indicators.price !== null);
    assert.equal(item.candidate.price?.amount, 150000);
    ok(
      `offre de A : sponsored=false, compatibilité ${item.score}, pertinence ${item.relevance}, prix « ${item.indicators.price?.position} », ` +
        `disponibilité « ${item.indicators.availability?.level} », confiance « ${item.indicators.confidence.level} »`,
    );

    const offerSide = await pollUntil(
      "stored-matches de l'offre",
      async () => {
        const items = await allDemandMatches(seller, offer.id);
        return items.some((candidate) => candidate.candidateId === demand.id) ? items : null;
      },
      WORKER_TIMEOUT_MS,
    );
    ok("GET /api/offers/{id}/stored-matches renvoie le besoin de B");
    const offerText = await rawAllPages(seller, `/api/offers/${offer.id}/stored-matches`);
    assert.equal(offerText.includes(buyerId), false);
    assert.equal(offerText.includes(buyerPhone), false);
    assert.equal(offerText.includes(buyerPhone.slice(4)), false);
    ok("le DTO (toutes les pages) ne contient ni identifiant d'acheteur ni téléphone");
    const mine = offerSide.find((candidate) => candidate.candidateId === demand.id);
    assert.ok(mine);
    assert.equal(mine.indicators.availability, null);
    assert.equal(mine.indicators.price, null);
    assert.equal(mine.sponsored, false);
    ok("sens offre : indicateurs de prix et de disponibilité absents, confiance de l'acheteur seule, sponsored=false");
  });

  await step("Isolation : B ne peut ni lire ni modifier l'offre de A", async () => {
    expectApiError(await rejects(buyerApi.offers.get(offer.id)), 404, "resource_not_found");
    ok("B GET /api/offers/{id de A} : 404");
    expectApiError(await rejects(buyerApi.offers.update(offer.id, offer.contentVersion, { location: "Pirate" })), 404, "resource_not_found");
    ok("B PATCH /api/offers/{id de A} : 404");
    expectApiError(await rejects(buyerApi.offers.pause(offer.id, offer.contentVersion)), 404, "resource_not_found");
    expectApiError(await rejects(buyerApi.offers.archive(offer.id, offer.contentVersion)), 404, "resource_not_found");
    ok("B pause et archive sur l'offre de A : 404");
    const storedForeign = await buyer.fetch(`/api/offers/${offer.id}/stored-matches`);
    assert.equal(storedForeign.status, 404);
    ok("B GET /api/offers/{id de A}/stored-matches : 404");
    expectApiError(await rejects(buyerApi.boostQuotes.create(offer.id, "3d")), 404, "resource_not_found");
    expectApiError(await rejects(buyerApi.boostQuotes.list(offer.id)), 404, "resource_not_found");
    ok("B demande ou lit un devis de boost sur l'offre de A : 404 (indiscernable d'une offre inexistante)");
    expectApiError(await rejects(sellerApi.demands.get(demand.id)), 404, "resource_not_found");
    ok("A GET /api/demands/{id de B} : 404");
    expectApiError(await rejects(sellerApi.demands.storedMatches(demand.id)), 404, "resource_not_found");
    ok("A GET /api/demands/{id de B}/stored-matches : 404");
    const buyerOffers = await buyerApi.offers.listAll();
    assert.equal(buyerOffers.items.some((candidate) => candidate.id === offer.id), false);
    ok("la liste d'offres de B ne contient pas l'offre de A");
    const unchanged = await sellerApi.offers.get(offer.id);
    assert.equal(unchanged.status, "published");
    assert.equal(unchanged.contentVersion, offer.contentVersion);
    assert.equal(unchanged.location, "Abidjan");
    ok("l'offre de A est inchangée (en ligne, même version, même localisation)");
  });

  await step("Protection de l'origine : une mutation sans Origin ou avec une origine étrangère est refusée", async () => {
    const body = JSON.stringify({ expectedContentVersion: offer.contentVersion });
    const headers = { "content-type": "application/json" };
    const none = await seller.fetch(`/api/offers/${offer.id}/pause`, { method: "POST", headers, body, origin: null });
    assert.equal(none.status, 403);
    const foreign = await seller.fetch(`/api/offers/${offer.id}/pause`, { method: "POST", headers, body, origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    ok("POST sans Origin : 403 ; POST avec Origin http://evil.example : 403");
    const quoteBody = JSON.stringify({ durationCode: "3d" });
    const quoteNone = await seller.fetch(`/api/offers/${offer.id}/boost-quotes`, { method: "POST", headers, body: quoteBody, origin: null });
    const quoteForeign = await seller.fetch(`/api/offers/${offer.id}/boost-quotes`, { method: "POST", headers, body: quoteBody, origin: "http://evil.example" });
    assert.equal(quoteNone.status, 403);
    assert.equal(quoteForeign.status, 403);
    ok("POST boost-quotes sans Origin ou avec une origine étrangère : 403 (origine contrôlée avant la session)");
    const still = await sellerApi.offers.get(offer.id);
    assert.equal(still.status, "published");
    ok("l'offre n'a pas été mise en pause par ces requêtes");
  });

  await step("Erreurs d'authentification réelles (400, 401, 429), usurpation des en-têtes de confiance, accès direct sans relais", async () => {
    const tooEarly = await rejects(sellerApi.auth.requestOtp(sellerPhone));
    expectApiError(tooEarly, 429, "otp_request_limited");
    assert.equal(
      describeApiError(tooEarly, "otp-request"),
      "Trop de demandes de code. Patientez quelques minutes avant de réessayer.",
    );
    ok("nouvelle demande de code avant 60 s : 429 otp_request_limited → message fixe « Trop de demandes de code… »");
    const invalidPhone = await rejects(sellerApi.auth.requestOtp("0700000042"));
    expectApiError(invalidPhone, 400, "invalid_request");
    assert.equal(describeApiError(invalidPhone, "otp-request"), "Numéro de téléphone invalide. Vérifiez-le et réessayez.");
    ok("numéro non canonique (sans « + ») : 400 invalid_request → message fixe « Numéro de téléphone invalide… »");
    const badCode = await rejects(sellerApi.auth.verifyOtp("0b6f3a52-6d6e-4b9f-9a35-6f2f6d9b8c11", "123456"));
    expectApiError(badCode, 401, "authentication_refused");
    assert.equal(
      describeApiError(badCode, "otp-verify"),
      "Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.",
    );
    ok("challenge inconnu : 401 authentication_refused → message fixe « Code incorrect ou expiré… »");

    // Un client hostile envoie de faux en-têtes de confiance : le relais les supprime et écrit les siens, la demande aboutit.
    const forged = createApiClient({
      fetch: (input, init) =>
        rival.fetch(String(input), {
          ...(init as RequestInit),
          headers: {
            ...((init as RequestInit).headers as Record<string, string>),
            "x-noma-proxy-secret": "pas-le-bon-secret-0123456789-0123456789",
            "x-forwarded-for": "6.6.6.6, 7.7.7.7",
          },
        }),
    });
    const challenge = await forged.auth.requestOtp(spoofPhone);
    assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/);
    ok("faux X-Noma-Proxy-Secret et X-Forwarded-For envoyés par le client : supprimés par le relais, demande de code acceptée (202)");

    // Sans le relais (accès direct à Next), aucune IP fiable : 503 avant tout service métier.
    const direct = await fetch(`${DIRECT}/api/auth/otp/request`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: E2E_BASE },
      body: JSON.stringify({ phone: spoofPhone }),
    });
    assert.equal(direct.status, 503);
    const directBody = (await direct.json()) as { error?: { code?: string } };
    assert.equal(directBody.error?.code, "auth_unavailable");
    assert.equal(
      describeApiError(new ApiError(503, "auth_unavailable", "x"), "otp-request"),
      "Le service est temporairement indisponible. Réessayez dans un instant.",
    );
    ok(`accès direct à Next (${DIRECT}) sans le relais : 503 auth_unavailable (le relais est bien ce qui rend la connexion possible)`);
  });

  await step("Pages branchées : HTML 200 avec session, aucune donnée métier sans session", async () => {
    const pages = [
      "/connexion",
      "/verification",
      "/vendeur/annonces",
      "/vendeur/annonces/nouvelle",
      `/vendeur/annonces/${offer.id}`,
      "/alertes",
      "/alerte/nouvelle",
      `/besoins/${demand.id}`,
    ];
    for (const path of pages) {
      const connected = await seller.fetch(path);
      assert.equal(connected.status, 200, `${path} avec session`);
      assert.match(connected.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await connected.text(), /<html/);
      const anonymous = await seller.fetch(path, { noCookies: true });
      assert.equal(anonymous.status, 200, `${path} sans session`);
      const html = await anonymous.text();
      assert.match(html, /<html/);
      assert.equal(html.includes("iPhone 12"), false, `${path} sans session ne contient aucune donnée métier`);
      assert.equal(html.includes("Écran impeccable"), false, `${path} sans session ne contient pas le texte de l'annonce`);
      // L'identifiant figure légitimement dans l'adresse des pages /…/{id} (c'est l'URL demandée, pas une donnée métier).
      if (!path.includes(offer.id) && !path.includes(demand.id)) assert.equal(html.includes(offer.id), false);
    }
    ok(`${pages.length} pages : 200 HTML avec session et sans session (la redirection vers /connexion est faite par la garde cliente : voir e2e:ui)`);
    const anonymousSession = await seller.fetch("/api/auth/session", { noCookies: true });
    assert.equal(anonymousSession.status, 401);
    ok("la garde cliente s'appuie sur GET /api/auth/session : 401 sans cookie");
  });

  // ─── Scénario « mise en avant » : un produit unique, 8 offres concurrentes, l'offre de A est la plus chère ───
  const tag = Date.now().toString(36).slice(-5);
  const product = { category: "Téléphones", brand: "Samsung", model: `Galaxy S21 ${tag}` };
  let rivalId = "";
  const rivalOffers: OfferRecord[] = [];
  let target: OfferRecord = undefined as unknown as OfferRecord;
  let scenarioDemand: DemandRecord = undefined as unknown as DemandRecord;

  await step(`Mise en avant : produit « ${product.brand} ${product.model} », 8 offres d'un vendeur concurrent C, l'offre de A est la plus chère`, async () => {
    rivalId = await loginWithOtp(rival, rivalPhone);
    ok("vendeur concurrent C : connecté (compte distinct de A et de B)");
    for (let index = 0; index < 8; index += 1) {
      const price = 100_000 + index * 5_000;
      const built = buildOfferInput({
        title: `${product.brand} ${product.model} · offre ${index + 1}`,
        description: "",
        category: product.category,
        brand: product.brand,
        model: product.model,
        variant: "",
        condition: "Occasion",
        location: "Abidjan",
        price: String(price),
        available: true,
      });
      assert.ok(built.ok);
      const created = await rivalApi.offers.create(built.input);
      rivalOffers.push(await rivalApi.offers.publish(created.id, created.contentVersion));
    }
    assert.equal(rivalOffers.length, 8);
    ok("C : 8 offres publiées, de 100 000 à 135 000 FCFA");
    const built = buildOfferInput({
      title: `${product.brand} ${product.model} · offre de A`,
      description: "",
      category: product.category,
      brand: product.brand,
      model: product.model,
      variant: "",
      condition: "Occasion",
      location: "Abidjan",
      price: "190 000",
      available: true,
    });
    assert.ok(built.ok);
    const created = await sellerApi.offers.create(built.input);
    target = await sellerApi.offers.publish(created.id, created.contentVersion);
    ok("A : offre publiée à 190 000 FCFA (au-dessus des 8 offres de C : prix « au-dessus du marché »)");
    const scenarioBuilt = buildDemandInput(
      {
        text: `Je cherche un ${product.brand} ${product.model}`,
        category: product.category,
        brand: product.brand,
        model: product.model,
        variant: "",
        condition: "Occasion",
        location: "Abidjan",
        budget: "250 000",
        deadline: "",
      },
      new Date().toISOString().slice(0, 10),
    );
    assert.ok(scenarioBuilt.ok);
    const scenarioCreated = await buyerApi.demands.create(scenarioBuilt.input);
    scenarioDemand = await buyerApi.demands.activate(scenarioCreated.id, scenarioCreated.contentVersion);
    assert.equal(scenarioDemand.status, "active");
    ok("B : besoin actif pour ce produit (budget 250 000 FCFA)");
  });

  let organicOrder: StoredMatch[] = [];
  await step("Résultats de B avant tout boost : les 9 offres, aucune « sponsorisée »", async () => {
    const wanted = [target.id, ...rivalOffers.map((candidate) => candidate.id)];
    organicOrder = await pollUntil(
      "les 9 offres dans les résultats de B",
      async () => {
        const items = await allMatches(buyer, scenarioDemand.id, "relevance");
        return wanted.every((id) => items.some((item) => item.candidateId === id)) ? items : null;
      },
      WORKER_TIMEOUT_MS * 2,
    );
    ok(`${organicOrder.length} offre(s) dans les résultats de B (tri par pertinence)`);
    assert.equal(organicOrder.some((item) => item.sponsored), false);
    ok("aucune offre « sponsorisée » sans boost");
    const byScore = await allMatches(buyer, scenarioDemand.id, "score");
    assert.equal(byScore.some((item) => item.sponsored), false);
    ok("tri par score : jamais de « sponsorisée »");
    const position = organicOrder.findIndex((item) => item.candidateId === target.id);
    assert.ok(position > 0, `l'offre de A (la plus chère) ne doit pas être en tête organique : position ${position}`);
    const targetItem = organicOrder[position];
    info(
      `N = ${organicOrder.length} offres, position organique de l'offre de A = ${position + 1}, pertinence ${targetItem.relevance}, ` +
        `prix « ${targetItem.indicators.price?.position} » (écart ${String(targetItem.indicators.price?.deltaPercent)} %)`,
    );
    info(
      `pertinence des positions 1 à 3 : ${organicOrder.slice(0, 3).map((item) => item.relevance).join(" ; ")} (en tête : ${organicOrder[0].candidate.price?.amount} FCFA)`,
    );
    const rawText = await rawAllPages(buyer, `/api/demands/${scenarioDemand.id}/stored-matches?sort=relevance`);
    for (const secret of [sellerId, rivalId, sellerPhone, rivalPhone, sellerPhone.slice(4), rivalPhone.slice(4)]) {
      assert.equal(rawText.includes(secret), false, "aucune identité de vendeur dans les résultats de B");
    }
    ok("les résultats de B ne contiennent l'identifiant ni le téléphone d'aucun vendeur (A ni C)");
  });

  let firstQuoteId = "";
  await step("Devis de boost du vendeur A : 201 puis 200 réutilisé, annonce en pause refusée", async () => {
    const created = await sellerApi.boostQuotes.create(target.id, "3d");
    assert.equal(created.status, "available");
    assert.equal(created.reused, false);
    assert.ok(created.amount !== null && created.amount >= 500, `montant : ${String(created.amount)}`);
    assert.deepEqual(created.inputs, { competingSellers: 1, compatibleBuyers: 1, slotsTotal: 2, slotsUsed: 0 });
    assert.ok(created.factors);
    firstQuoteId = created.id;
    ok(
      `POST /api/offers/{id}/boost-quotes (3d) : disponible, ${created.amount} FCFA, facteurs (millièmes) ` +
        `concurrence ${created.factors.competitionMilli}, demande ${created.factors.demandMilli}, rareté ${created.factors.scarcityMilli}, durée ${created.factors.durationMilli} ; ` +
        `entrées : 1 vendeur concurrent, 1 acheteur compatible, 0 place utilisée sur 2`,
    );
    const rawCreated = await seller.fetch(`/api/offers/${target.id}/boost-quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationCode: "3d" }),
    });
    assert.equal(rawCreated.status, 200, "même demande tant que le devis est valable : 200 (réutilisé)");
    const rawBody = (await rawCreated.json()) as { quote: { id: string; reused: boolean } };
    assert.equal(rawBody.quote.id, firstQuoteId);
    assert.equal(rawBody.quote.reused, true);
    ok("seconde demande identique : 200, même devis, reused=true");
    const history = await sellerApi.boostQuotes.list(target.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, firstQuoteId);
    assert.equal(history[0].expired, false);
    ok("GET boost-quotes : l'historique contient ce devis (non expiré)");

    // Annonce en pause : l'erreur attendue (409 offer_not_eligible), sans révéler d'autre information.
    const sideBuilt = buildOfferInput({
      title: "Annonce mise en pause", description: "", category: product.category, brand: product.brand, model: product.model,
      variant: "", condition: "Occasion", location: "Abidjan", price: "120 000", available: true,
    });
    assert.ok(sideBuilt.ok);
    const sideCreated = await sellerApi.offers.create(sideBuilt.input);
    const sidePublished = await sellerApi.offers.publish(sideCreated.id, sideCreated.contentVersion);
    const sidePaused = await sellerApi.offers.pause(sidePublished.id, sidePublished.contentVersion);
    assert.equal(sidePaused.status, "paused");
    const pausedError = await rejects(sellerApi.boostQuotes.create(sidePaused.id, "24h"));
    expectApiError(pausedError, 409, "offer_not_eligible");
    assert.equal(
      describeApiError(pausedError, "boost"),
      "Cette annonce ne peut pas être boostée : elle doit être en ligne et disponible.",
    );
    ok("devis pour une annonce en pause : 409 offer_not_eligible → message fixe « … doit être en ligne et disponible. »");
    const draftBuilt = await sellerApi.offers.create({ rawText: "Brouillon sans produit" });
    const draftError = await rejects(sellerApi.boostQuotes.create(draftBuilt.id, "24h"));
    expectApiError(draftError, 409, "offer_not_eligible");
    ok("devis pour un brouillon : 409 offer_not_eligible");
    const unknown = await rejects(sellerApi.boostQuotes.create("0b6f3a52-6d6e-4b9f-9a35-6f2f6d9b8c11", "24h"));
    expectApiError(unknown, 404, "resource_not_found");
    ok("devis pour une annonce inexistante : 404 resource_not_found (même réponse que pour l'annonce d'autrui)");
  });

  await step("Boost d'administration (boost:grant, aucun paiement) puis résultats de B : l'offre de A est « sponsorisée »", async () => {
    const line = await grantBoostByAdministration(target.id, "3d");
    assert.match(line, /^Boost \(administration\) attribué/);
    ok(`boost:grant (base noma_e2e) : ${line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>")}`);

    const after = await allMatches(buyer, scenarioDemand.id, "relevance");
    assert.equal(after.length, organicOrder.length, "aucun élément ajouté, retiré ni dupliqué");
    assert.deepEqual(
      [...after.map((item) => item.candidateId)].sort(),
      [...organicOrder.map((item) => item.candidateId)].sort(),
    );
    const sponsored = after.filter((item) => item.sponsored);
    const organicPosition = organicOrder.findIndex((item) => item.candidateId === target.id);
    const maxPromoted = Math.floor(0.15 * after.length);
    const targetItem = organicOrder[organicPosition];
    if (sponsored.length === 0) {
      throw new Error(
        `aucune offre sponsorisée : conditions de promotion ? N = ${after.length}, quota floor(0,15 × N) = ${maxPromoted}, ` +
          `position organique ${organicPosition + 1}, pertinence ${targetItem.relevance} (minimum 60)`,
      );
    }
    assert.equal(sponsored.length, 1, "au plus floor(0,15 × N) offres promues");
    assert.equal(sponsored[0].candidateId, target.id);
    assert.equal(after[0].candidateId, target.id, "l'offre sponsorisée passe en tête");
    ok(
      `GET stored-matches?sort=relevance : l'offre de A est « sponsorisée » et passe de la position ${organicPosition + 1} à la position 1 ` +
        `(N = ${after.length}, quota floor(0,15 × ${after.length}) = ${maxPromoted}, pertinence organique ${targetItem.relevance} ≥ 60)`,
    );
    // Les autres offres restent triées par pertinence décroissante (leur ordre organique relatif). On compare dans UNE lecture :
    // les égalités de pertinence sont départagées par la date d'évaluation, que le worker peut renouveler entre deux lectures.
    const rest = after.slice(1);
    assert.equal(rest.some((item) => item.sponsored), false);
    for (let index = 1; index < rest.length; index += 1) {
      assert.ok(rest[index - 1].relevance >= rest[index].relevance, "les offres non promues restent triées par pertinence décroissante");
    }
    ok("les 8 autres offres restent triées par pertinence décroissante, aucune n'est « sponsorisée »");
    assert.equal(after[0].relevance, targetItem.relevance, "le boost ne modifie ni la pertinence ni le score");
    assert.equal(after[0].score, targetItem.score);
    ok("le boost ne modifie ni la pertinence ni le score de l'offre");
    const byScore = await allMatches(buyer, scenarioDemand.id, "score");
    assert.equal(byScore.some((item) => item.sponsored), false);
    ok("tri par score : toujours aucune offre « sponsorisée » (le boost ne s'applique qu'au tri par pertinence)");
    const rawText = await rawAllPages(buyer, `/api/demands/${scenarioDemand.id}/stored-matches?sort=relevance`);
    for (const forbidden of ["boost", "Boost", "boostId", "endsAt", "starts_at", sellerId, rivalId, sellerPhone, rivalPhone]) {
      assert.equal(rawText.includes(forbidden), false, `le DTO de B ne contient pas « ${forbidden} »`);
    }
    ok("le DTO de B n'expose ni identifiant de boost, ni date, ni identité de vendeur : seulement le booléen « sponsored »");

    const afterQuote = await sellerApi.boostQuotes.create(target.id, "24h");
    assert.equal(afterQuote.status, "unavailable");
    assert.equal(afterQuote.unavailableReason, "offer_already_boosted");
    assert.equal(afterQuote.amount, null);
    ok("devis après le boost : indisponible, motif offer_already_boosted (201)");
  });

  await step("Acheteurs intéressés vus par A : le besoin de B, sans aucune identité", async () => {
    const items = await pollUntil(
      "stored-matches de l'offre de A",
      async () => {
        const found = await allDemandMatches(seller, target.id);
        return found.some((item) => item.candidateId === scenarioDemand.id) ? found : null;
      },
      WORKER_TIMEOUT_MS,
    );
    const text = await rawAllPages(seller, `/api/offers/${target.id}/stored-matches`);
    for (const secret of [buyerId, buyerPhone, buyerPhone.slice(4), "Awa", "ownerId", "owner_id", '"phone"']) {
      assert.equal(text.includes(secret), false, `la réponse faite à A ne contient pas « ${secret} »`);
    }
    ok("GET /api/offers/{id}/stored-matches (A) : le besoin de B figure dans la liste, sans identifiant ni téléphone d'acheteur");
    const row = items.find((item) => item.candidateId === scenarioDemand.id);
    assert.ok(row);
    assert.equal(row.candidate.budget?.amount, 250000);
    assert.equal(row.sponsored, false, "le sens offre n'a jamais de mise en avant");
    ok("besoin de B vu par A : budget 250 000 FCFA, sponsored=false (sens offre)");
  });

  if (process.env.NOMA_E2E_SEARCH_STREAM === "1") {
    // Serveur lancé avec NOMA_FAKE_SOURCES=1 (c'est le cas de dev:try) : la source lente (1,5 s par défaut) retarde la fin de la recherche.
    await step("Recherche anonyme : le flux NDJSON de POST /api/search arrive au fil de l'eau à travers le relais", async () => {
      const response = await seller.fetch("/api/search", {
        method: "POST",
        noCookies: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "iPhone 12 en bon état à Abidjan", mode: "achat" }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /ndjson|json/);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const startedStream = Date.now();
      const arrivals: { at: number; type: string }[] = [];
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim()) arrivals.push({ at: Date.now() - startedStream, type: (JSON.parse(line) as { type: string }).type });
        }
      }
      assert.ok(arrivals.length >= 3, `événements reçus : ${arrivals.length}`);
      const first = arrivals[0].at;
      const last = arrivals[arrivals.length - 1].at;
      assert.equal(arrivals[arrivals.length - 1].type, "completed");
      // Source lente par défaut : 1,5 s (NOMA_FAKE_SLOW_MS). Un relais qui bufferise livrerait tout d'un coup (écart ≈ 0).
      assert.ok(last - first >= 1_000, `le premier événement (${first} ms) doit arriver bien avant le dernier (${last} ms) : le flux n'est pas bufferisé`);
      ok(`flux progressif : ${arrivals.length} événements, le premier (« ${arrivals[0].type} ») à ${first} ms, le dernier (« completed ») à ${last} ms`);
    });
  }

  await step("Déconnexion : 401 partout, y compris le rejeu de l'ancien cookie", async () => {
    for (const [session, api, label] of [
      [seller, sellerApi, "A"],
      [buyer, buyerApi, "B"],
      [rival, rivalApi, "C"],
    ] as const) {
      const oldCookie = session.cookieHeader();
      assert.ok(oldCookie.startsWith("noma_auth="));
      await api.auth.logout();
      assert.equal(session.cookies.has("noma_auth"), false, "le cookie est supprimé");
      ok(`${label} : POST /api/auth/logout : 204 et cookie supprimé`);
      const after = await session.fetch("/api/auth/session");
      assert.equal(after.status, 401);
      ok(`${label} : GET /api/auth/session après déconnexion : 401`);
      const replay = await session.fetch("/api/offers", { noCookies: true, headers: { cookie: oldCookie } });
      assert.equal(replay.status, 401);
      const replaySession = await session.fetch("/api/auth/session", { noCookies: true, headers: { cookie: oldCookie } });
      assert.equal(replaySession.status, 401);
      ok(`${label} : rejeu de l'ancien jeton : 401 (session révoquée côté serveur)`);
      const again = await api.auth.logout();
      assert.equal(again, undefined);
      ok(`${label} : seconde déconnexion idempotente`);
    }
  });

  console.log(`e2e:core : ${checks} vérifications réussies en ${Math.round((Date.now() - startedAt) / 1000)} s, 0 échec.`);
}

main().catch((error: unknown) => {
  console.error(`e2e:core : erreur inattendue : ${error instanceof Error ? error.message : "inconnue"}`);
  process.exit(1);
});
