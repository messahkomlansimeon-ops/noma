/**
 * Mesures de coût du boost (lot P3) : devis, achat, verrous, lecture de la page de résultats, requêtes sans rapport pendant des devis simultanés.
 *
 *   createdb noma_perf_p3          (base JETABLE : le nom doit commencer par « noma_perf_ », sinon refus avant toute connexion)
 *   DATABASE_URL=postgresql://…/noma_perf_p3 npm run perf:boost -- setup
 *   DATABASE_URL=postgresql://…/noma_perf_p3 npm run perf:boost -- measure results quote-reachable quote-unreachable purchase purchase-worst concurrent
 *
 * Jeu : 200 offres d'un MÊME périmètre (Smartphones · Apple · iPhone 13, 40 vendeurs), 1 000 besoins actifs (un acheteur chacun) tous
 * compatibles avec les 200 offres (200 000 évaluations confirmées et fraîches : chaque liste d'acheteur compte 200 offres), 3 boosts
 * d'administration déjà actifs. Les identifiants et les scores sont déterministes (aucun hasard) : deux bases peuplées par `setup` sont identiques.
 * Offres repérées : 0 à 11 = vendeur « multi » (12 devis simultanés) ; 12 = offre ATTEIGNABLE (pertinence au-dessus du seuil) ; 13 = offre
 * INATTEIGNABLE (score d'évaluation 5 chez tous les acheteurs : pertinence sous le seuil) ; 14 = offre de l'achat.
 * Chaque ligne de sortie est un objet JSON (chiffres bruts en millisecondes). Aucun appel externe ; aucune autre base que celle de DATABASE_URL.
 */
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { grantOfferBoost } from "../../lib/server/boost/boosts";
import { purchaseOfferBoost } from "../../lib/server/boost/purchase";
import { quoteOfferBoost } from "../../lib/server/boost/quotes";
import { createWalletHttpHandlers } from "../../lib/server/wallet/http";
import { applyProviderEvent, createTopupIntent, type ProviderEvent } from "../../lib/server/wallet/topups";
import { listStoredOfferMatchesForDemand } from "../../lib/server/matching/stored-matches";
import { resolveMatchingFreshnessParams } from "../../lib/server/matching/persistence";
import { closePostgresPool, getPostgresPool } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { EVALUATION_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON, SCORING_SUMMARY_JSON } from "../postgres/boost-fixtures";
import { requirePerfDatabaseUrl } from "./perf-guard";

const OFFERS = Number(process.env.PERF_OFFERS ?? 200);
const DEMANDS = Number(process.env.PERF_DEMANDS ?? 1000);
const SELLERS = 40;
/** UUID déterministe de forme valide (version 4, variante 8) : le MÊME calcul existe en SQL (`perf_uuid`). */
const uuidOf = (label: string): string => {
  const hex = createHash("md5").update(label).digest("hex");
  const text = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
};
const offerId = (index: number): string => uuidOf(`perf-offer-${index}`);
const sellerOf = (index: number): string => uuidOf(`perf-seller-${index < 12 ? 1 : index === 12 ? 2 : index === 13 ? 3 : index === 14 ? 4 : 5 + (index % (SELLERS - 5))}`);
const buyerId = (index: number): string => uuidOf(`perf-buyer-${index}`);
const demandId = (index: number): string => uuidOf(`perf-demand-${index}`);
const MULTI_SELLER = uuidOf("perf-seller-1");
const REACHABLE_OFFER = offerId(12);
const UNREACHABLE_OFFER = offerId(13);
const PURCHASE_OFFER = offerId(14);

const out = (record: Record<string, unknown>): void => console.log(JSON.stringify(record));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const start = performance.now();
  try {
    const value = await run();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ms: Math.round(performance.now() - start), error: `${(error as Error).name}:${typeof code === "string" ? code : (error as Error).message.slice(0, 60)}` };
  }
}

// ───────────── jeu de données ─────────────

async function setup(pool: Pool): Promise<void> {
  const migrated = await runMigrations(pool);
  out({ step: "migrations", applied: migrated.applied.length, skipped: migrated.skipped.length });
  const existing = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM offers");
  if (existing.rows[0].n > 0) throw new Error("setup : la base contient déjà des offres (utilisez une base neuve)");
  const fresh = resolveMatchingFreshnessParams();
  const started = performance.now();

  await pool.query(
    `CREATE FUNCTION perf_uuid(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
     $$ SELECT (substr(md5(label), 1, 12) || '4' || substr(md5(label), 14, 3) || '8' || substr(md5(label), 18, 15))::uuid $$`,
  );
  await pool.query("INSERT INTO users (id) SELECT perf_uuid('perf-seller-' || g) FROM generate_series(1, $1::int) g", [SELLERS]);
  await pool.query("INSERT INTO users (id) SELECT perf_uuid('perf-buyer-' || g) FROM generate_series(1, $1::int) g", [DEMANDS]);
  await pool.query(
    `INSERT INTO offers (id, owner_id, status, raw_text, category, brand, model, condition_text, location_text, price_amount, price_currency,
                         availability_status, availability_confirmed_at, content_version, created_at)
     SELECT perf_uuid('perf-offer-' || i),
            perf_uuid('perf-seller-' || CASE WHEN i < 12 THEN 1 WHEN i = 12 THEN 2 WHEN i = 13 THEN 3 WHEN i = 14 THEN 4 ELSE 5 + (i % ($2::int - 5)) END),
            'published', 'perf offer ' || i, 'Smartphones', 'Apple', 'iPhone 13', 'Occasion', 'Abidjan', 100000 + i * 500, 'XOF',
            'available', now() - ((i % 7) || ' hours')::interval, 1, now()
       FROM generate_series(0, $1::int - 1) i`,
    [OFFERS, SELLERS],
  );
  await pool.query(
    `INSERT INTO demands (id, owner_id, status, raw_text, category, brand, model, condition_text, location_text, content_version, created_at)
     SELECT perf_uuid('perf-demand-' || j), perf_uuid('perf-buyer-' || j), 'active', 'perf demand ' || j,
            'Smartphones', 'Apple', 'iPhone 13', 'Occasion', 'Abidjan', 1, now() - (j || ' seconds')::interval
       FROM generate_series(1, $1::int) j`,
    [DEMANDS],
  );
  await pool.query(
    `INSERT INTO matching_evaluations (id, idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
        offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version, scoring_config_hash,
        evaluated_at, expires_at, eligibility_status, compatibility_status, score, coverage,
        evaluation_summary, scoring_summary, preferences_summary, evaluation_details)
     SELECT gen_random_uuid(), gen_random_uuid(), 'perf', o.id, d.id, o.owner_id, d.owner_id,
            1, 1, $1, $2, $3,
            now() - interval '1 minute', NULL, 'eligible', 'compatible',
            (CASE WHEN o.raw_text = 'perf offer 13' THEN 5
                  WHEN o.raw_text = 'perf offer 12' THEN 85
                  ELSE 60 + ((substring(o.raw_text from 12)::int * 37 + substring(d.raw_text from 13)::int * 11) % 40) END)::numeric(9,6),
            100,
            $4::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb
       FROM offers o CROSS JOIN demands d`,
    [fresh.engineOfflineVersion, fresh.engineScoringVersion, fresh.scoringConfigHash, EVALUATION_SUMMARY_JSON, SCORING_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON],
  );
  await pool.query("ANALYZE");
  // Trois boosts d'administration déjà actifs (offres 15 à 17, vendeurs distincts) : la liste d'un acheteur contient des offres boostées.
  for (const index of [15, 16, 17]) {
    await grantOfferBoost({ pool, offerId: offerId(index), ownerId: sellerOf(index), durationCode: "7d", source: "admin_grant" });
  }
  const counts = await pool.query<{ offers: number; demands: number; evaluations: number }>(
    "SELECT (SELECT count(*) FROM offers)::int AS offers, (SELECT count(*) FROM demands)::int AS demands, (SELECT count(*) FROM matching_evaluations)::int AS evaluations",
  );
  out({ step: "setup", ...counts.rows[0], boosts: 3, ms: Math.round(performance.now() - started) });
}

// ───────────── instruments ─────────────

/** Observe les verrous consultatifs d'un espace (échantillonnage toutes les 5 ms) pendant `run` : durée pendant laquelle ils ont été tenus. */
async function holdMs<T>(observer: Pool, namespace: number, run: () => Promise<T>): Promise<{ result: T; heldMs: number }> {
  let first = -1;
  let last = -1;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const found = await observer.query(
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1::oid LIMIT 1", [namespace],
      );
      const now = performance.now();
      if (found.rowCount) {
        if (first < 0) first = now;
        last = now;
      }
      await sleep(5);
    }
  })();
  const result = await run();
  await sleep(20);
  stop = true;
  await sampler;
  return { result, heldMs: first < 0 ? 0 : Math.round(last - first + 5) };
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

async function fund(pool: Pool, ownerId: string, amount: number): Promise<void> {
  const { intent } = await createTopupIntent({ pool, ownerId, amountXof: BigInt(amount), idempotencyKey: randomUUID() });
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const event: ProviderEvent = {
    provider: "fake", eventId, type: "payment.succeeded", providerReference: intent.providerReference, amountXof: intent.amountXof,
    payloadSha256: sha(`corps:${eventId}`),
  };
  const applied = await applyProviderEvent({ pool, event });
  if (applied.outcome !== "applied") throw new Error("recharge non appliquée");
}

const percentile = (values: number[], share: number): number => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

// ───────────── scénarios ─────────────

async function resultsPage(pool: Pool): Promise<void> {
  const samples: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    const result = await timed(() => listStoredOfferMatchesForDemand(buyerId(1 + run), demandId(1 + run), { sort: "relevance", limit: 20 }, pool));
    samples.push(result.ms);
    if (result.error) out({ scenario: "results", error: result.error });
  }
  out({ scenario: "results", note: "page de résultats d'un acheteur (200 offres, limit 20, sort relevance)", samplesMs: samples, medianMs: percentile(samples, 0.5), minMs: Math.min(...samples) });
}

async function quoteScenario(pool: Pool, observer: Pool, label: string, offer: string, owner: string, durations: Array<"24h" | "3d" | "7d">): Promise<void> {
  for (const durationCode of durations) {
    const run = await holdMs(observer, 1_314_664_949, () => timed(() => quoteOfferBoost({ pool, ownerId: owner, offerId: offer, durationCode })));
    const quote = run.result.value;
    out({
      scenario: label, durationCode, ms: run.result.ms, offerLockHeldMs: run.heldMs, error: run.result.error,
      status: quote?.status, reason: quote?.unavailableReason, compatibleBuyers: quote?.inputs.compatibleBuyers, reachableBuyers: quote?.inputs.reachableBuyers,
      reachTruncated: (quote?.inputs as { reachTruncated?: boolean } | undefined)?.reachTruncated,
    });
  }
}

async function purchaseScenario(pool: Pool, observer: Pool): Promise<void> {
  const owner = sellerOf(14);
  await fund(pool, owner, 100_000);
  const quote = await timed(() => quoteOfferBoost({ pool, ownerId: owner, offerId: PURCHASE_OFFER, durationCode: "24h" }));
  out({ scenario: "purchase-quote", ms: quote.ms, status: quote.value?.status, reason: quote.value?.unavailableReason, error: quote.error });
  if (!quote.value || quote.value.status !== "available") return;
  const run = await holdMs(observer, 1_314_664_948, () => timed(() => purchaseOfferBoost({
    pool, sellerId: owner, offerId: PURCHASE_OFFER, quoteId: quote.value!.id, idempotencyKey: randomUUID(),
  })));
  out({ scenario: "purchase", ms: run.result.ms, scopeLockHeldMs: run.heldMs, error: run.result.error, amountXof: run.result.value ? Number(run.result.value.purchase.amount) : null });
}

/**
 * PIRE CAS de l'achat : l'offre INATTEIGNABLE (13) a un devis « disponible » (inséré à la main : le calcul réel le refuserait). Avant le lot P3 l'achat RÉUSSIT
 * (boost payé sans aucun effet visible) ; depuis, la portée est revérifiée sous le verrou du périmètre (au plus 50 besoins examinés, budget de 1,5 s) :
 * no_visible_effect, rien d'écrit. Mesure la durée de l'achat et du verrou du périmètre dans ce cas.
 */
async function purchaseWorstScenario(pool: Pool, observer: Pool): Promise<void> {
  const owner = sellerOf(13);
  await fund(pool, owner, 100_000);
  const quoteId = randomUUID();
  await pool.query(
    `INSERT INTO boost_quotes (id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', '7d', 'default', 1, 'XOF', 'available', NULL, 2300, '2300', 1000, 1000, 1000, 1000, 0, 1000, 30, 3,
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '15 minutes')`,
    [quoteId, UNREACHABLE_OFFER, owner],
  );
  const run = await holdMs(observer, 1_314_664_948, () => timed(() => purchaseOfferBoost({
    pool, sellerId: owner, offerId: UNREACHABLE_OFFER, quoteId, idempotencyKey: randomUUID(),
  })));
  out({
    scenario: "purchase-worst", note: "offre inatteignable, devis disponible inséré à la main", ms: run.result.ms, scopeLockHeldMs: run.heldMs,
    outcome: run.result.error ?? "achat réussi (boost payé sans effet visible)",
  });
}

async function concurrentScenario(pool: Pool, observer: Pool): Promise<void> {
  const walletUser = buyerId(500);
  const handlers = createWalletHttpHandlers({
    pool,
    resolveSession: async () => ({ userId: walletUser, expiresAt: new Date(Date.now() + 3_600_000) }),
  });
  const walletGet = async (): Promise<{ status: number; ms: number }> => {
    const start = performance.now();
    const response = await handlers.wallet.get(new Request("http://localhost/api/wallet", { headers: { cookie: "noma_auth=x" } }));
    await response.text();
    return { status: response.status, ms: Math.round(performance.now() - start) };
  };
  const idle = await walletGet();
  out({ scenario: "concurrent-baseline", walletGetMs: idle.ms, status: idle.status });
  // Douze devis simultanés (douze offres du même vendeur), puis, pendant leur calcul, des GET /api/wallet d'un AUTRE utilisateur et la mise en pause d'une des offres.
  // L'offre mise en pause est la 3e des douze : son devis est parmi les premiers servis (jamais en attente d'une connexion du pool).
  const PAUSED_INDEX = 2;
  const offers = Array.from({ length: 12 }, (_, index) => offerId(index));
  const startedAt = performance.now();
  const quotes = offers.map((offer) => timed(() => quoteOfferBoost({ pool, ownerId: MULTI_SELLER, offerId: offer, durationCode: "24h" })));
  await sleep(300);
  const walletSamples: Array<{ status: number; ms: number; atMs: number }> = [];
  let pause: { ms: number; error?: string } | null = null;
  const pausePromise = (async () => {
    await sleep(200);
    const start = performance.now();
    try {
      await observer.query("UPDATE offers SET status = 'paused' WHERE id = $1::uuid AND status = 'published'", [offers[PAUSED_INDEX]]);
      pause = { ms: Math.round(performance.now() - start) };
    } catch (error) {
      pause = { ms: Math.round(performance.now() - start), error: String((error as Error).message).slice(0, 60) };
    }
  })();
  const settled = Promise.all(quotes).then(() => true);
  let done = false;
  void settled.then(() => { done = true; });
  while (!done && walletSamples.length < 40) {
    const at = Math.round(performance.now() - startedAt);
    walletSamples.push({ ...(await walletGet()), atMs: at });
    await sleep(150);
  }
  const results = await Promise.all(quotes);
  await pausePromise;
  await observer.query("UPDATE offers SET status = 'published' WHERE id = $1::uuid", [offers[PAUSED_INDEX]]);
  const walletMs = walletSamples.map((sample) => sample.ms);
  out({
    scenario: "concurrent",
    quotes: results.map((result) => ({ ms: result.ms, status: result.value?.status, reason: result.value?.unavailableReason, error: result.error })),
    quotesTotalMs: Math.round(performance.now() - startedAt),
    walletGetCount: walletSamples.length, walletGetMaxMs: Math.max(...walletMs), walletGetP50Ms: percentile(walletMs, 0.5), walletStatuses: [...new Set(walletSamples.map((s) => s.status))],
    pauseMs: (pause as { ms: number } | null)?.ms, pauseError: (pause as { error?: string } | null)?.error,
  });
}

// ───────────── point d'entrée ─────────────

async function main(): Promise<void> {
  const url = requirePerfDatabaseUrl(process.env.DATABASE_URL);
  const [command, ...scenarios] = process.argv.slice(2);
  const pool = getPostgresPool();
  const observer = new Pool({ connectionString: url, max: 2 });
  try {
    out({ step: "start", command, scenarios, poolMax: (pool as unknown as { options: { max?: number } }).options.max, connectionTimeoutMillis: (pool as unknown as { options: { connectionTimeoutMillis?: number } }).options.connectionTimeoutMillis });
    if (command === "setup") await setup(pool);
    else if (command === "measure") {
      for (const scenario of scenarios) {
        if (scenario === "results") await resultsPage(pool);
        else if (scenario === "quote-reachable") await quoteScenario(pool, observer, "quote-reachable", REACHABLE_OFFER, sellerOf(12), ["24h", "3d"]);
        else if (scenario === "quote-unreachable") await quoteScenario(pool, observer, "quote-unreachable", UNREACHABLE_OFFER, sellerOf(13), ["24h", "3d"]);
        else if (scenario === "purchase") await purchaseScenario(pool, observer);
        else if (scenario === "purchase-worst") await purchaseWorstScenario(pool, observer);
        else if (scenario === "concurrent") await concurrentScenario(pool, observer);
        else throw new Error(`scénario inconnu : ${scenario}`);
      }
    } else throw new Error("usage : setup | measure <results|quote-reachable|quote-unreachable|purchase|purchase-worst|concurrent>…");
  } finally {
    await observer.end();
    await closePostgresPool();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
