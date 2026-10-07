/**
 * `npm run e2e:sse` (lot D3) : le flux en direct de la messagerie, contre un vrai serveur Next lancé par `npm run dev:try`, À TRAVERS LE RELAIS (sans navigateur : des requêtes
 * HTTP réelles, comme celles d'un navigateur). Reproduit EXACTEMENT le scénario de l'audit D2 : l'acheteur garde 4 flux vivants sur une conversation, puis ouvre et ferme
 * BRUTALEMENT un 5e flux, 20 fois de suite. Avant le lot D3 les places des flux fermés n'étaient pas rendues : le 6e flux évinçait un flux VIVANT, et au bout de 20 tours les 4 flux
 * vivants étaient fermés et ne recevaient plus rien ; la connexion d'écoute PostgreSQL restait ouverte 60 s après le dernier flux.
 * Vérifie :
 *   1. les 4 flux vivants RESTENT ouverts après les 20 ouvertures-fermetures brutales ;
 *   2. ils reçoivent tous le message suivant (événement `message` portant l'id, jamais le texte) en moins de 3 s ;
 *   3. l'autre participant qui ouvre 7 flux ne ferme que ses propres 2 plus anciens flux (le plafond est PAR utilisateur) ; un tiers est refusé (404) sans rien prendre ;
 *   4. avec 5 flux réellement vivants, le 6e évince le PLUS ANCIEN (un seul) et personne d'autre ;
 *   5. après la fermeture du dernier flux, la connexion d'écoute (LISTEN) est fermée au plus 5 s plus tard (mesure : tout de suite, le serveur ne garde aucun délai de grâce).
 * Prépare le marché de démonstration (`demo:seed`) sur la base noma_e2e, puis l'acheteur démo (+225 07 00 00 01 01) ouvre une conversation avec le vendeur démo (+225 07 00 00 02 02).
 *
 * Variables : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL (noma_e2e). Voir scripts/e2e-common.ts. À lancer sous le répartiteur
 * `/var/tmp/noma-orch/e2e-slot.sh` (voir MESSAGERIE.md). NON inclus dans `npm test`.
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import { E2E_SERVER_LOG, RelaySession, demoSeedByAdministration, e2eDatabaseUrl, loginWithOtp, pollUntil } from "./e2e-common";

if (!E2E_SERVER_LOG) {
  console.error("e2e:sse : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}

/** Diagnostic : NOMA_E2E_SSE_DIRECT=1 ouvre les flux directement sur Next (NOMA_E2E_DIRECT_URL), sans le relais. */
const STREAM_BASE = process.env.NOMA_E2E_SSE_DIRECT === "1" ? (process.env.NOMA_E2E_DIRECT_URL ?? "") : "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const step = (title: string) => console.log(`→ ${title}`);
const info = (label: string) => console.log(`    · ${label}`);

interface Stream {
  status: number;
  text: string;
  ended: boolean;
  close: () => void;
}

/** Ouvre un flux et le lit en continu ; `ended` passe à vrai quand le SERVEUR (ou l'abandon) a fermé la connexion. */
async function openStream(session: RelaySession, conversationId: string): Promise<Stream> {
  const controller = new AbortController();
  let caller = session;
  if (STREAM_BASE !== "") {
    caller = new RelaySession(`${session.label}-direct`, STREAM_BASE);
    for (const [name, value] of session.cookies) caller.cookies.set(name, value);
  }
  const response = await caller.fetch(`/api/conversations/${conversationId}/stream`, { signal: controller.signal });
  const stream: Stream = { status: response.status, text: "", ended: false, close: () => controller.abort() };
  if (response.status !== 200 || !response.body) {
    stream.text = await response.text();
    stream.ended = true;
    return stream;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stream.text += decoder.decode(value, { stream: true });
      }
    } catch {
      // abandon (abort) ou coupure
    }
    stream.ended = true;
  })();
  return stream;
}

const isReady = (stream: Stream): boolean => stream.text.includes("event: ready");

async function waitReady(stream: Stream, label: string): Promise<void> {
  await pollUntil(`${label} prêt`, async () => (isReady(stream) || stream.ended ? true : null), 20_000, "le flux ne s'ouvre pas");
  assert.equal(stream.ended, false, `${label} : fermé avant d'être prêt`);
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  const listenCount = async (): Promise<number> =>
    Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%'")).rows[0].n);
  try {
    step("préparation : demo:seed, comptes de démonstration, conversation acheteur démo ↔ vendeur démo (iPhone 12)");
    await demoSeedByAdministration();
    const buyer = new RelaySession("acheteur");
    const vendor = new RelaySession("vendeur");
    const stranger = new RelaySession("tiers");
    await loginWithOtp(buyer, "+2250700000101");
    await loginWithOtp(vendor, "+2250700000202");
    await loginWithOtp(stranger, "+2250799000403");
    const home = await buyer.client().home.buyer();
    const demand = home.demands.find((candidate) => /iPhone 12/.test(candidate.title));
    assert.ok(demand, "le besoin « iPhone 12 » de l'acheteur démo");
    const vendorHome = await vendor.client().home.vendor();
    const offer = vendorHome.offers.find((candidate) => candidate.model === "iPhone 12");
    assert.ok(offer, "l'annonce « iPhone 12 » du vendeur démo");
    const opened = await buyer.fetch(`/api/demands/${demand.id}/offers/${offer.id}/conversation`, post({}));
    assert.equal(opened.status < 300, true, `ouverture de la conversation : ${opened.status}`);
    const conversationId = ((await opened.json()) as { conversation: { id: string } }).conversation.id;
    const first = await buyer.fetch(`/api/conversations/${conversationId}/messages`, post({ body: "Bonjour, l'annonce est toujours disponible ?" }));
    assert.equal(first.status, 201);
    ok("conversation ouverte (l'acheteur a écrit le premier message : le vendeur peut répondre)");
    assert.equal(await listenCount(), 0, "aucune connexion d'écoute avant le premier flux");

    step("4 flux vivants de l'acheteur, puis 20 ouvertures-fermetures brutales d'un 5e flux (scénario de l'audit)");
    const live: Stream[] = [];
    for (let index = 0; index < 4; index += 1) {
      const stream = await openStream(buyer, conversationId);
      assert.equal(stream.status, 200, `flux vivant ${index + 1}`);
      live.push(stream);
      await sleep(200);
    }
    for (const [index, stream] of live.entries()) await waitReady(stream, `flux vivant ${index + 1}`);
    ok("4 flux vivants ouverts et prêts");
    assert.equal(await listenCount(), 1, "UNE seule connexion d'écoute pour tous les flux");

    for (let round = 0; round < 20; round += 1) {
      const fifth = await openStream(buyer, conversationId);
      assert.equal(fifth.status, 200, `5e flux, tour ${round + 1}`);
      await sleep(round % 2 === 0 ? 150 : 1_000);
      fifth.close();
    }
    await sleep(1_500);
    const closedByServer = live.filter((stream) => stream.ended).length;
    info(`après 20 fermetures brutales : flux vivants fermés par le serveur ${closedByServer}/4`);
    assert.equal(closedByServer, 0, "les 4 flux vivants sont restés ouverts");
    ok("les 4 flux vivants sont restés ouverts après 20 ouvertures-fermetures brutales d'un 5e flux");

    const reply = await vendor.fetch(`/api/conversations/${conversationId}/messages`, post({ body: "Oui, toujours disponible, vous pouvez passer." }));
    assert.equal(reply.status, 201);
    const messageId = ((await reply.json()) as { message: { id: number } }).message.id;
    const startedWaiting = Date.now();
    while (!live.every((stream) => stream.text.includes(`"id":${messageId}`))) {
      assert.ok(Date.now() - startedWaiting < 3_000, `le message ${messageId} n'est pas arrivé sur les 4 flux vivants en 3 s`);
      await sleep(20);
    }
    info(`message ${messageId} reçu par les 4 flux en ${Date.now() - startedWaiting} ms (mesure à 20 ms près)`);
    for (const stream of live) {
      assert.equal(stream.text.includes("Oui, toujours disponible"), false, "le texte du message ne passe jamais par le flux");
    }
    ok("les 4 flux vivants reçoivent le message suivant (l'id seulement, jamais le texte) en moins de 3 s");

    step("l'autre participant ouvre 7 flux : seuls SES 2 plus anciens sont fermés (plafond PAR utilisateur) ; un tiers est refusé sans rien prendre");
    const vendorStreams: Stream[] = [];
    for (let index = 0; index < 7; index += 1) {
      const stream = await openStream(vendor, conversationId);
      assert.equal(stream.status, 200, `flux du vendeur ${index + 1}`);
      vendorStreams.push(stream);
      await sleep(150);
    }
    await pollUntil("les 2 plus anciens flux du vendeur sont fermés", async () => (vendorStreams[0].ended && vendorStreams[1].ended ? true : null), 5_000, "l'éviction du vendeur n'a pas eu lieu");
    await sleep(500);
    assert.equal(vendorStreams.slice(2).filter((stream) => stream.ended).length, 0, "les 5 derniers flux du vendeur restent ouverts");
    assert.equal(live.filter((stream) => stream.ended).length, 0, "aucun flux de l'acheteur n'est touché");
    for (const stream of vendorStreams) stream.close();
    const refused = await Promise.all(Array.from({ length: 10 }, () => openStream(stranger, conversationId)));
    assert.equal(refused.every((stream) => stream.status === 404), true, "un tiers reçoit le même 404 qu'une conversation inconnue");
    assert.equal(live.filter((stream) => stream.ended).length, 0);
    ok("le vendeur n'évince que ses propres flux ; un tiers ne prend aucune place et ne ferme aucun flux de l'acheteur");

    step("5 flux réellement vivants : le 6e évince le PLUS ANCIEN seulement");
    const fifthLive = await openStream(buyer, conversationId);
    await waitReady(fifthLive, "5e flux vivant");
    assert.equal(live.filter((stream) => stream.ended).length, 0, "5 flux vivants : personne n'est évincé");
    const sixth = await openStream(buyer, conversationId);
    await waitReady(sixth, "6e flux");
    await pollUntil("le plus ancien est fermé par le serveur", async () => (live[0].ended ? true : null), 5_000, "l'éviction n'a pas eu lieu");
    await sleep(500);
    const survivors = [live[1], live[2], live[3], fifthLive, sixth];
    assert.equal(survivors.filter((stream) => stream.ended).length, 0, "les 4 autres flux et le nouveau restent ouverts");
    ok("5 flux vivants : le 6e évince uniquement le plus ancien (les autres restent ouverts)");

    step("fermeture du dernier flux : la connexion d'écoute se ferme (au plus 5 s)");
    for (const stream of survivors) stream.close();
    const closing = Date.now();
    await pollUntil("connexion d'écoute fermée", async () => ((await listenCount()) === 0 ? true : null), 20_000, "la connexion LISTEN reste ouverte");
    const elapsed = (Date.now() - closing) / 1000;
    info(`connexion d'écoute fermée ${elapsed.toFixed(1)} s après la fermeture du dernier flux`);
    assert.ok(elapsed <= 5, `connexion d'écoute fermée en ${elapsed.toFixed(1)} s (au plus 5 s après le dernier abonné)`);
    ok(`connexion d'écoute fermée ${elapsed.toFixed(1)} s après le dernier flux (exigé : au plus 5 s)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
  console.log(`\ne2e:sse : ${checks} vérifications réussies.`);
}

main().catch((error) => {
  console.error("e2e:sse ÉCHEC :", error instanceof Error ? `${error.name} : ${error.message}` : error);
  process.exit(1);
});
