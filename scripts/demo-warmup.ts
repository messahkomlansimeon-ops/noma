/**
 * `npm run demo:warmup` (lot FIN1) : PRÉCHAUFFE le serveur de développement avant la démonstration.
 *
 * Pourquoi : `next dev` compile chaque page et chaque route la PREMIÈRE fois qu'on l'ouvre (plusieurs secondes chacune). Devant des investisseurs, le premier clic de chaque écran
 * serait lent. Ce script ouvre à l'avance, par le relais de `dev:try` (http://localhost:3212), TOUTES les pages et toutes les routes /api de l'application : Next les compile, la
 * démonstration est ensuite fluide.
 *
 * SANS EFFET DE BORD : uniquement des requêtes GET, sans cookie ni session (une route protégée répond 401 avant de lire quoi que ce soit), avec des identifiants factices
 * (00000000-0000-4000-8000-000000000000 : aucune ligne de la base ne porte cet identifiant). Une route qui n'accepte pas GET (une écriture : connexion, commande, recharge…) répond 405
 * SANS exécuter son code : Next a pourtant dû la charger, donc la compiler. Aucun POST, aucune écriture, aucune ligne créée, aucun code de connexion demandé.
 *
 * Les listes ci-dessous sont VÉRIFIÉES par un test (tests/scripts/demo-warmup.test.ts) contre les dossiers `app/` : une nouvelle page ou une nouvelle route non ajoutée ici (ou non
 * justifiée dans les exclusions) fait échouer le test.
 *
 * Usage : `npm run demo:warmup` (après avoir lancé `dev:try` dans un autre terminal). Variables : NOMA_DEV_TRY_PORT (relais, défaut 3212) ; NOMA_DEMO_BASE_URL (adresse du relais, seulement
 * http://localhost:<port> ou http://127.0.0.1:<port> : jamais un autre poste). Affiche la durée totale. Code de sortie 1 si le relais ne répond pas ou si une page répond par une erreur 5xx.
 */
import { pathToFileURL } from "node:url";

/** Identifiant factice des segments dynamiques : un UUID valide, qu'aucune ligne ne porte. */
export const WARMUP_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";
/** Une adresse qui n'existe pas : compile la page 404 (DEMO.md la montre pour /admin d'un compte ordinaire). */
export const WARMUP_NOT_FOUND_PATH = "/une-page-qui-n-existe-pas";

/** Pages de l'application (motifs de dossiers `app/`, sans les groupes de routes). Chaque entrée est un motif : `[id]` devient l'identifiant factice. */
export const WARMUP_PAGE_PATTERNS: readonly string[] = Object.freeze([
  // connexion
  "/connexion",
  "/verification",
  // acheteur
  "/",
  "/alertes",
  "/alerte/nouvelle",
  "/notifications",
  "/recherche",
  "/besoins/[id]",
  "/besoins/[id]/offres/[offerId]",
  "/besoins/[id]/comparer",
  "/signaler",
  "/favoris",
  "/messages",
  "/messages/[id]",
  "/commandes",
  "/commandes/[id]",
  "/compte",
  "/compte/porte-monnaie",
  "/missions",
  "/missions/nouvelle",
  "/missions/[id]",
  "/missions/[id]/modifier",
  "/paiement-simule/[id]",
  // vendeur
  "/vendeur",
  "/vendeur/annonces",
  "/vendeur/annonces/[id]",
  "/vendeur/annonces/nouvelle",
  "/vendeur/annonces/import",
  "/vendeur/commandes",
  "/vendeur/commandes/[id]",
  "/vendeur/messages",
  "/vendeur/messages/[id]",
  "/vendeur/offre-pro",
  "/vendeur/porte-monnaie",
  "/vendeur/profil",
  // administration
  "/admin",
  "/admin/vendeurs",
  "/admin/reglages",
  "/admin/marche",
  "/admin/collecte",
  "/admin/recherche-active",
  "/admin/offres",
  "/admin/paiements",
  "/admin/sms",
  "/admin/dossiers",
]);

/** Pages qui existent mais ne servent pas à la démonstration : « Bientôt disponible », anciens écrans, retour de Wave (désactivé par défaut). Le test exige une raison pour chacune. */
export const WARMUP_EXCLUDED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "/partager": "écran « Bientôt disponible »",
  "/propositions": "écran « Bientôt disponible »",
  "/vendeur/demandes": "ancien écran du vendeur, hors parcours",
  "/vendeur/demandes/[id]": "ancien écran du vendeur, hors parcours",
  "/vendeur/devis/nouveau": "écran « Bientôt disponible »",
  "/admin/dossiers/[id]": "dossier de modération : demande un identifiant de dossier réel (la file « /admin/dossiers » est préchauffée)",
  "/paiement-retour/[id]": "retour du paiement Wave : désactivé par défaut, hors démonstration",
});

/**
 * Routes /api (motifs de dossiers `app/api/`). Toutes sont ouvertes en GET : celles qui n'acceptent pas GET répondent 405 sans exécuter leur code (voir l'en-tête). Il n'y a aucune
 * exclusion : y compris les routes d'écriture, compilées ainsi sans effet.
 */
export const WARMUP_API_PATTERNS: readonly string[] = Object.freeze([
  "/api/admin/actions",
  "/api/admin/active-search",
  "/api/admin/collection",
  "/api/admin/market",
  "/api/admin/payments",
  "/api/admin/payments/anomalies/[id]/resolve",
  "/api/admin/plans",
  "/api/admin/plans/[code]/versions",
  "/api/admin/reports",
  "/api/admin/reports/[id]",
  "/api/admin/reports/[id]/decision",
  "/api/admin/settings",
  "/api/admin/sms",
  "/api/admin/summary",
  "/api/admin/vendors",
  "/api/admin/vendors/[id]/[action]",
  "/api/auth/logout",
  "/api/auth/otp/request",
  "/api/auth/otp/verify",
  "/api/auth/session",
  "/api/conversations",
  "/api/conversations/unread",
  "/api/conversations/[id]",
  "/api/conversations/[id]/messages",
  "/api/conversations/[id]/read",
  "/api/conversations/[id]/stream",
  "/api/demands",
  "/api/demands/[id]",
  "/api/demands/[id]/activate",
  "/api/demands/[id]/active-search",
  "/api/demands/[id]/archive",
  "/api/demands/[id]/external-listings",
  "/api/demands/[id]/extraction-proposals",
  "/api/demands/[id]/extraction-proposals/[proposalId]/apply",
  "/api/demands/[id]/matches",
  "/api/demands/[id]/offers/[offerId]",
  "/api/demands/[id]/offers/[offerId]/contact",
  "/api/demands/[id]/offers/[offerId]/conversation",
  "/api/demands/[id]/offers/[offerId]/favorite",
  "/api/demands/[id]/offers/[offerId]/orders",
  "/api/demands/[id]/satisfy",
  "/api/demands/[id]/stored-matches",
  "/api/demands/[id]/tracking",
  "/api/dev/fake-payments/[id]/confirm",
  "/api/dev/fake-payments/[id]/fail",
  "/api/favorites",
  "/api/favorites/[offerId]",
  "/api/home/buyer",
  "/api/home/vendor",
  "/api/market",
  "/api/media/[photoId]",
  "/api/missions",
  "/api/missions/[id]",
  "/api/missions/[id]/proposal",
  "/api/notifications",
  "/api/notifications/preferences",
  "/api/notifications/read",
  "/api/offers",
  "/api/offers/import",
  "/api/offers/[id]",
  "/api/offers/[id]/archive",
  "/api/offers/[id]/boost-purchases",
  "/api/offers/[id]/boost-quotes",
  "/api/offers/[id]/extraction-proposals",
  "/api/offers/[id]/extraction-proposals/[proposalId]/apply",
  "/api/offers/[id]/matches",
  "/api/offers/[id]/pause",
  "/api/offers/[id]/photos",
  "/api/offers/[id]/photos/[photoId]",
  "/api/offers/[id]/publish",
  "/api/offers/[id]/sales",
  "/api/offers/[id]/stats",
  "/api/offers/[id]/stored-matches",
  "/api/orders",
  "/api/orders/[id]",
  "/api/orders/[id]/[action]",
  "/api/reports",
  "/api/payments/fake/webhook",
  "/api/search",
  "/api/subscription",
  "/api/subscription/auto-renew",
  "/api/subscription/notices/read",
  "/api/wallet",
  "/api/wallet/topups",
  "/api/wallet/topups/[id]",
  "/api/webhooks/sublymus",
]);

/** Valeurs factices des segments qui ne sont pas des identifiants. */
const SEGMENT_VALUES: Readonly<Record<string, string>> = Object.freeze({ code: "pro", action: "confirm" });

/** Motif de dossier → adresse : `[id]` → identifiant factice, `[code]` → « pro », `[action]` → « confirm » (aucune de ces valeurs n'existe en base). */
export function warmupUrl(pattern: string): string {
  return pattern.replace(/\[([A-Za-z]+)\]/g, (_, name: string) => SEGMENT_VALUES[name] ?? WARMUP_PLACEHOLDER_ID);
}

/** Toutes les adresses à ouvrir : les pages, la page 404, puis les routes /api. Uniquement des chemins (jamais une adresse complète), tous ouverts en GET. */
export function warmupTargets(): string[] {
  return [...WARMUP_PAGE_PATTERNS.map(warmupUrl), WARMUP_NOT_FOUND_PATH, ...WARMUP_API_PATTERNS.map(warmupUrl)];
}

// ───────────── exécution ─────────────

export interface WarmupOutcome {
  path: string;
  /** Code HTTP, ou `null` si le serveur n'a pas répondu. */
  status: number | null;
  durationMs: number;
  /** Faux : serveur injoignable, délai dépassé ou erreur serveur (5xx). */
  ok: boolean;
}

export interface WarmupReport {
  total: number;
  failed: WarmupOutcome[];
  outcomes: WarmupOutcome[];
  durationMs: number;
}

export interface WarmupOptions {
  /** Adresse du relais (http://localhost:3212). */
  baseUrl: string;
  /** Requêtes en parallèle (défaut 4). */
  concurrency?: number;
  /** Délai par requête, en ms (défaut 180 000 : la première compilation d'une grosse page est longue). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onResult?: (outcome: WarmupOutcome, index: number, total: number) => void;
  /** Adresses à ouvrir (défaut : `warmupTargets()`). */
  targets?: readonly string[];
}

/** Ouvre toutes les adresses, en GET, sans cookie ; ne lance jamais d'exception pour une adresse : l'issue est dans le rapport. */
export async function runWarmup(options: WarmupOptions): Promise<WarmupReport> {
  const targets = options.targets ?? warmupTargets();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const timeoutMs = options.timeoutMs ?? 180_000;
  const outcomes: WarmupOutcome[] = new Array(targets.length);
  const started = now();
  let next = 0;

  const one = async (index: number): Promise<void> => {
    const path = targets[index];
    const begin = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    try {
      // GET seulement, jamais de cookie ni de corps : aucune session, donc aucune lecture ni écriture de données de quelqu'un.
      const response = await fetchImpl(`${options.baseUrl}${path}`, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "*/*" } });
      status = response.status;
      // La réponse n'est pas lue en entier : un flux (messagerie en direct) ne bloquerait pas le préchauffage.
      void response.body?.cancel().catch(() => {});
    } catch {
      status = null;
    } finally {
      clearTimeout(timer);
    }
    const outcome: WarmupOutcome = { path, status, durationMs: now() - begin, ok: status !== null && status < 500 };
    outcomes[index] = outcome;
    options.onResult?.(outcome, index, targets.length);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= targets.length) return;
      await one(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return { total: targets.length, failed: outcomes.filter((entry) => !entry.ok), outcomes, durationMs: now() - started };
}

/** Adresse du relais : NOMA_DEMO_BASE_URL (http://localhost:<port> ou http://127.0.0.1:<port> seulement), sinon http://localhost:<NOMA_DEV_TRY_PORT ou 3212>. `null` si elle est refusée. */
export function resolveBaseUrl(env: Record<string, string | undefined>): string | null {
  const given = env.NOMA_DEMO_BASE_URL?.trim();
  if (given) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      return null;
    }
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port !== "" && url.pathname === "/" && url.search === "" && url.hash === "" && !url.username && !url.password;
    return local ? `http://${url.hostname}:${url.port}` : null;
  }
  const port = env.NOMA_DEV_TRY_PORT?.trim() || "3212";
  return /^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535 ? `http://localhost:${port}` : null;
}

/** « 1 min 12 s » / « 42 s ». */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

async function main(): Promise<number> {
  const baseUrl = resolveBaseUrl(process.env);
  if (baseUrl === null) {
    console.error("demo:warmup : refus : NOMA_DEMO_BASE_URL doit être http://localhost:<port> ou http://127.0.0.1:<port> (le relais de dev:try de CE poste), et NOMA_DEV_TRY_PORT un port valide.");
    return 1;
  }
  const targets = warmupTargets();
  console.log(`demo:warmup : préchauffage de ${targets.length} adresses par ${baseUrl} (GET seulement, aucune donnée touchée).`);
  console.log("demo:warmup : la première compilation de chaque page prend quelques secondes ; patientez jusqu'au message final.");
  const report = await runWarmup({
    baseUrl,
    targets,
    onResult: (outcome, index, total) => {
      const label = outcome.status === null ? "injoignable" : String(outcome.status);
      console.log(`  [${String(index + 1).padStart(3, " ")}/${total}] ${outcome.ok ? "ok " : "ERR"} ${label.padEnd(11)} ${durationText(outcome.durationMs).padEnd(7)} ${outcome.path}`);
    },
  });
  if (report.failed.length === report.total) {
    console.error(`demo:warmup : aucune réponse de ${baseUrl}. Lancez d'abord « npm run dev:try » (autre terminal) et attendez « noma est prêt ».`);
    return 1;
  }
  if (report.failed.length > 0) {
    console.error(`demo:warmup : ${report.failed.length} adresse(s) en erreur :`);
    for (const entry of report.failed) console.error(`  ${entry.status ?? "injoignable"} ${entry.path}`);
    console.error(`demo:warmup : préchauffage INCOMPLET après ${durationText(report.durationMs)}.`);
    return 1;
  }
  console.log(`demo:warmup : terminé en ${durationText(report.durationMs)} : ${report.total} adresses préchauffées. La démonstration peut commencer.`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("demo:warmup : erreur inattendue.");
      process.exitCode = 1;
    },
  );
}
