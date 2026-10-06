import "server-only";

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

let sharedPool: Pool | null = null;

export function requireDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL est requis pour utiliser la base métier PostgreSQL.",
    );
  }
  return value;
}

/**
 * Taille MAXIMALE explicite du pool applicatif (par processus) et délai d'ATTENTE d'une connexion (lot P3). Sans délai, `pg` fait attendre sans fin
 * quand toutes les connexions sont prises (constaté : 12 devis simultanés, un GET /api/wallet d'un autre utilisateur attendait 63,9 s) ; avec lui,
 * l'appel échoue en `timeout exceeded when trying to connect` et les routes répondent un 503 propre. Le calcul de la portée d'un boost est
 * en outre limité à 4 simultanés par processus (`BOOST_REACH_MAX_CONCURRENCY`), ce qui laisse des connexions aux autres requêtes.
 */
export const POSTGRES_POOL_MAX = 20;
export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;

/** Configuration du pool applicatif (testable sans connexion). */
export function postgresPoolConfig(env: Record<string, string | undefined> = process.env): PoolConfig {
  return {
    connectionString: requireDatabaseUrl(env),
    max: POSTGRES_POOL_MAX,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
  };
}

/** Pool créé uniquement au premier appel. Importer ce module ne contacte jamais PostgreSQL. */
export function getPostgresPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool(postgresPoolConfig());
  }
  return sharedPool;
}

export async function closePostgresPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  if (pool) await pool.end();
}

export interface NomaTransactionalClient extends PoolClient {
  __inNomaTransaction?: boolean;
}

/** BEGIN/COMMIT/ROLLBACK utilisent toujours le même client réservé. */
export async function withPostgresTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  pool: Pool = getPostgresPool(),
): Promise<T> {
  const client = (await pool.connect()) as NomaTransactionalClient;
  try {
    await client.query("BEGIN");
    client.__inNomaTransaction = true;
    const result = await operation(client);
    await client.query("COMMIT");
    client.__inNomaTransaction = false;
    return result;
  } catch (error) {
    client.__inNomaTransaction = false;
    try {
      await client.query("ROLLBACK");
    } catch {
      // L'erreur initiale reste la cause utile.
    }
    throw error;
  } finally {
    client.__inNomaTransaction = false;
    client.release();
  }
}
