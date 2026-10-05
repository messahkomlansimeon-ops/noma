/**
 * `npm run e2e:core` : parcours de bout en bout contre un VRAI serveur Next (jamais lancé par ce script), en HTTP,
 * comme un navigateur (jar de cookies, en-tête Origin) derrière un reverse proxy de confiance (en-têtes
 * X-Noma-Proxy-Secret et X-Forwarded-For, exigés par POST /api/auth/otp/request). Utilise la couche cliente
 * lib/client/api.ts et les constructeurs de saisie des écrans (lib/client/catalog-view.ts) : ce que les écrans
 * enverraient est exactement ce qui est envoyé ici. NON inclus dans `npm test`.
 *
 * Variables :
 *   NOMA_E2E_BASE_URL        origine du serveur (défaut http://localhost:3211) ; DOIT être NOMA_AUTH_ORIGIN du serveur
 *   NOMA_E2E_SERVER_LOG      fichier où la sortie du serveur est enregistrée (les lignes `[auth:dev]` y sont lues)
 *   NOMA_AUTH_PROXY_SECRET   le même secret que celui du serveur
 *   NOMA_E2E_WORKER_TIMEOUT_MS  attente bornée du worker de matching (défaut 90000)
 *
 * Aucune écriture hors du serveur testé : la base visée est celle du serveur (noma_e2e), jamais choisie ici.
 * Les codes OTP lus dans le journal ne sont jamais affichés.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import {
  ApiError,
  createApiClient,
  describeApiError,
  type ApiClient,
  type DemandRecord,
  type OfferRecord,
} from "../lib/client/api";
import { buildDemandInput, buildOfferInput } from "../lib/client/catalog-view";

const BASE = (process.env.NOMA_E2E_BASE_URL ?? "http://localhost:3211").replace(/\/$/, "");
const SERVER_LOG = process.env.NOMA_E2E_SERVER_LOG ?? "";
const PROXY_SECRET = process.env.NOMA_AUTH_PROXY_SECRET ?? "";
const WORKER_TIMEOUT_MS = Number(process.env.NOMA_E2E_WORKER_TIMEOUT_MS ?? "90000");
const PAGE_TIMEOUT_MS = 120_000;

if (!SERVER_LOG || !PROXY_SECRET) {
  console.error("e2e:core : NOMA_E2E_SERVER_LOG et NOMA_AUTH_PROXY_SECRET sont requis.");
  process.exit(2);
}

let checks = 0;
const startedAt = Date.now();

function ok(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
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

/** Un « navigateur » : jar de cookies + en-têtes du proxy de confiance. */
class BrowserSession {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly label: string,
    private readonly forwardedFor: string,
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute) || /^expires=.*1970/i.test(attribute));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async fetch(path: string, init: RequestInit & { origin?: string | null; noCookies?: boolean } = {}): Promise<Response> {
    const { origin = BASE, noCookies = false, headers: given, ...rest } = init;
    const headers: Record<string, string> = {
      "x-noma-proxy-secret": PROXY_SECRET,
      "x-forwarded-for": this.forwardedFor,
      ...((given as Record<string, string> | undefined) ?? {}),
    };
    if (origin !== null) headers.origin = origin;
    const cookie = this.cookieHeader();
    if (cookie && !noCookies) headers.cookie = cookie;
    const response = await fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    this.absorb(response);
    return response;
  }

  client(): ApiClient {
    return createApiClient({ fetch: (input, init) => this.fetch(String(input), init as RequestInit) });
  }
}

function logSize(): number {
  return statSync(SERVER_LOG).size;
}

/** Attend, après `offset` octets, une ligne `[auth:dev]` et renvoie le code et les deux derniers chiffres affichés. */
async function awaitOtpLine(offset: number): Promise<{ code: string; tail: string }> {
  const pattern = /\[auth:dev\] code OTP pour \+\*+([0-9]{2}) : ([0-9]{6}) \(expire à [0-9]{2}:[0-9]{2}:[0-9]{2} UTC\)/;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = readFileSync(SERVER_LOG).subarray(offset).toString("utf8");
    const match = pattern.exec(text);
    if (match) return { tail: match[1], code: match[2] };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("aucune ligne [auth:dev] dans la sortie du serveur (NODE_ENV=development et NOMA_DEV_OTP_CONSOLE=1 ?)");
}

async function pollUntil<T>(label: string, produce: () => Promise<T | null>, timeoutMs = WORKER_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "aucune réponse";
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== null) return value;
    last = "condition non atteinte";
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} : délai de ${timeoutMs} ms dépassé (${last}) — le worker de matching tourne-t-il sur la même base ?`);
}

async function login(session: BrowserSession, phone: string): Promise<string> {
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

/** Numéro ivoirien canonique à 10 chiffres locaux : « 07 » + 6 chiffres issus de l'horloge + les deux chiffres demandés. */
function uniquePhone(lastTwoDigits: string): string {
  const middle = `${Date.now() % 1_000_000}`.padStart(6, "0");
  return `+22507${middle}${lastTwoDigits}`;
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

async function main(): Promise<void> {
  const sellerPhone = uniquePhone("41");
  const buyerPhone = uniquePhone("42");
  const seller = new BrowserSession("vendeur A", "198.51.100.11");
  const buyer = new BrowserSession("acheteur B", "198.51.100.12");
  const sellerApi = seller.client();
  const buyerApi = buyer.client();

  await step("Serveur joignable, aucune session sans cookie", async () => {
    const response = await seller.fetch("/api/auth/session", { noCookies: true });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    ok("GET /api/auth/session sans cookie : 401");
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

  await step("Matching asynchrone : le worker produit les correspondances enregistrées", async () => {
    const demandSide = await pollUntil("stored-matches du besoin", async () => {
      const response = await buyer.fetch(`/api/demands/${demand.id}/stored-matches`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { items: { candidateId: string }[]; processing: boolean };
      return body.items.some((item) => item.candidateId === offer.id) ? { body, text: JSON.stringify(body) } : null;
    });
    ok(`GET /api/demands/{id}/stored-matches renvoie l'offre de A (${Math.round((Date.now() - startedAt) / 1000)} s depuis le début)`);
    assert.equal(demandSide.text.includes(sellerId), false, "aucun identifiant de propriétaire dans le DTO");
    assert.equal(demandSide.text.includes(sellerPhone), false, "aucun téléphone dans le DTO");
    ok("le DTO ne contient ni identifiant de vendeur ni téléphone");

    const offerSide = await pollUntil("stored-matches de l'offre", async () => {
      const response = await seller.fetch(`/api/offers/${offer.id}/stored-matches`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { items: { candidateId: string }[] };
      return body.items.some((item) => item.candidateId === demand.id) ? { text: JSON.stringify(body) } : null;
    });
    ok("GET /api/offers/{id}/stored-matches renvoie le besoin de B");
    assert.equal(offerSide.text.includes(buyerId), false);
    assert.equal(offerSide.text.includes(buyerPhone), false);
    ok("le DTO ne contient ni identifiant d'acheteur ni téléphone");
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
    expectApiError(await rejects(sellerApi.demands.get(demand.id)), 404, "resource_not_found");
    ok("A GET /api/demands/{id de B} : 404");
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
    const still = await sellerApi.offers.get(offer.id);
    assert.equal(still.status, "published");
    ok("l'offre n'a pas été mise en pause par ces requêtes");
  });

  await step("Erreurs d'authentification réelles (400, 401, 429, 503) et messages fixes de l'écran", async () => {
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
    const withoutTrustedProxy = createApiClient({
      fetch: (input, init) =>
        seller.fetch(String(input), { ...(init as RequestInit), headers: { ...((init as RequestInit).headers as Record<string, string>), "x-noma-proxy-secret": "pas-le-bon-secret" } }),
    });
    const unavailable = await rejects(withoutTrustedProxy.auth.requestOtp(buyerPhone));
    expectApiError(unavailable, 503, "auth_unavailable");
    assert.equal(
      describeApiError(unavailable, "otp-request"),
      "Le service est temporairement indisponible. Réessayez dans un instant.",
    );
    ok("secret de proxy invalide (aucune IP fiable) : 503 auth_unavailable → message fixe « service temporairement indisponible »");
  });

  await step("Pages branchées : HTML 200 avec session, aucune donnée métier sans session", async () => {
    const pages = ["/connexion", "/verification", "/vendeur/annonces", "/vendeur/annonces/nouvelle", "/alertes", "/alerte/nouvelle"];
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
      assert.equal(html.includes(offer.id), false);
    }
    ok(`${pages.length} pages : 200 HTML avec session et sans session (la redirection vers /connexion est faite par la garde cliente : voir e2e:ui)`);
    const anonymousSession = await seller.fetch("/api/auth/session", { noCookies: true });
    assert.equal(anonymousSession.status, 401);
    ok("la garde cliente s'appuie sur GET /api/auth/session : 401 sans cookie");
  });

  await step("Déconnexion : 401 partout, y compris le rejeu de l'ancien cookie", async () => {
    for (const [session, api, label] of [
      [seller, sellerApi, "A"],
      [buyer, buyerApi, "B"],
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
