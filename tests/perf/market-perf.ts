/**
 * Mesure de la lecture « 1 an » des prix demandés (lot H1-bis) : 1 000 annonces observées CHAQUE JOUR pendant un an (365 000 relevés) pour un même produit, lues par
 * `readMarketStats` (30, 90 et 365 jours) ; nombre de lignes que la base renvoie (au plus 1 + 52 par annonce, jamais une par jour observé) et temps de lecture.
 *
 *   TEST_DATABASE_URL=postgresql://…/noma_test npm run perf:market
 *
 * Elle travaille dans un SCHÉMA JETABLE de la base de test (comme les essais : migré, puis supprimé à la fin) ; aucune autre base. Chaque ligne de sortie est un objet JSON
 * (millisecondes). Variables : PERF_LISTINGS (défaut 1000), PERF_DAYS (défaut 365).
 */
import { readListingObservations, readMarketStats } from "../../lib/server/market/reads";
import { openTestSchema } from "../postgres/social-fixtures";

const LISTINGS = Number(process.env.PERF_LISTINGS ?? 1000);
const DAYS = Number(process.env.PERF_DAYS ?? 365);
const out = (record: Record<string, unknown>): void => console.log(JSON.stringify(record));

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: Math.round(performance.now() - start), value };
}

async function main(): Promise<void> {
  const env = await openTestSchema(4);
  try {
    const sellers: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = (await env.pool.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      await env.pool.query("INSERT INTO users (id) VALUES ($1)", [id]);
      sellers.push(id);
    }
    const inserted = await timed(() =>
      env.pool.query(
        `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
         SELECT 'listing', ids.id, current_date - d, 'telephones', 'apple', 'iphone 12', '128 go', 'occasion', 'Apple iPhone 12', 140000 + (ids.n % 40) * 1000 + (d % 3) * 500, ($1::uuid[])[1 + (ids.n % 20)]
           FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, $2::int) AS n) ids CROSS JOIN generate_series(0, $3::int - 1) AS d`,
        [sellers, LISTINGS, DAYS],
      ),
    );
    await env.pool.query("ANALYZE price_observations");
    out({ step: "setup", listings: LISTINGS, days: DAYS, rows: inserted.value.rowCount, ms: inserted.ms });
    const query = { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion" } as const;
    for (const periodDays of [365, 90, 30] as const) {
      const times: number[] = [];
      let median: number | null = null;
      for (let run = 0; run < 5; run += 1) {
        const result = await timed(() => readMarketStats(env.pool, { ...query, periodDays }));
        times.push(result.ms);
        median = result.value.listings.status === "published" ? result.value.listings.median : null;
      }
      const today = (await env.pool.query<{ d: string }>("SELECT to_char(current_date, 'YYYY-MM-DD') AS d")).rows[0].d;
      const from = new Date(Date.parse(`${today}T00:00:00Z`) - (periodDays - 1) * 86_400_000).toISOString().slice(0, 10);
      const read = await readListingObservations(env.pool, { category: "telephones", brand: "apple", model: "iphone 12" }, { from, to: today, days: periodDays });
      out({ step: "read", periodDays, medianXof: median, rowsReturned: read.length, rowsInWindow: LISTINGS * Math.min(DAYS, periodDays), msFirst: times[0], msRuns: times, msMedian: [...times].sort((a, b) => a - b)[2] });
    }
  } finally {
    await env.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
