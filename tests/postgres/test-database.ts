import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig, type QueryResultRow } from "pg";

export interface DedicatedTestDatabase {
  connectionString: string;
  databaseName: string;
}

export type TestPoolFactory = (config: PoolConfig) => Pool;

interface EffectiveConnectionRow extends QueryResultRow {
  database_name: string;
  schema_name: string | null;
  schemas: string[];
}

const TEST_DATABASE_SEGMENT = /(^|[_-])test($|[_-])/i;
const TEST_SCHEMA = /^noma_test_[a-z0-9_]+$/;
const defaultPoolFactory: TestPoolFactory = (config) => new Pool(config);

export function requireDedicatedTestDatabase(
  value: string | undefined,
): DedicatedTestDatabase {
  const connectionString = value?.trim();
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL requis : utilisez une base PostgreSQL dédiée dont le nom contient « test ».",
    );
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL n'est pas une URL PostgreSQL valide.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL doit utiliser postgres:// ou postgresql://.");
  }
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "options")) {
    throw new Error(
      "TEST_DATABASE_URL ne doit pas contenir le paramètre « options » : il peut détourner le search_path.",
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("Le nom de base dans TEST_DATABASE_URL est invalide.");
  }
  if (!TEST_DATABASE_SEGMENT.test(databaseName)) {
    throw new Error(
      "Refus de sécurité : le nom de base TEST_DATABASE_URL doit contenir le segment « test ».",
    );
  }
  return { connectionString, databaseName };
}

export function createTemporarySchemaName(): string {
  return `noma_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
}

export function quoteTemporarySchema(schema: string): string {
  if (!TEST_SCHEMA.test(schema)) {
    throw new Error(`Nom de schéma de test refusé : ${schema}`);
  }
  return `"${schema}"`;
}

async function readEffectiveConnection(pool: Pool): Promise<EffectiveConnectionRow> {
  const result = await pool.query<EffectiveConnectionRow>(`
    SELECT current_database() AS database_name,
           current_schema() AS schema_name,
           current_schemas(false)::text[] AS schemas
  `);
  return result.rows[0];
}

export async function assertEffectiveTestConnection(
  pool: Pool,
  target: DedicatedTestDatabase,
  expectedSchema?: string,
): Promise<void> {
  const effective = await readEffectiveConnection(pool);
  if (effective.database_name !== target.databaseName) {
    throw new Error(
      `Base PostgreSQL de test divergente : ${effective.database_name} au lieu de ${target.databaseName}.`,
    );
  }
  if (
    expectedSchema !== undefined &&
    (effective.schema_name !== expectedSchema ||
      effective.schemas.length !== 1 ||
      effective.schemas[0] !== expectedSchema)
  ) {
    throw new Error(
      `Schéma PostgreSQL de test divergent : ${effective.schema_name ?? "aucun"} ` +
        `(${JSON.stringify(effective.schemas)}) au lieu de ${expectedSchema}.`,
    );
  }
}

export async function openVerifiedTestDatabase(
  value: string | undefined,
  poolFactory: TestPoolFactory = defaultPoolFactory,
): Promise<{ target: DedicatedTestDatabase; pool: Pool }> {
  // La validation précède volontairement la construction du Pool.
  const target = requireDedicatedTestDatabase(value);
  const pool = poolFactory({ connectionString: target.connectionString, max: 1 });
  try {
    await assertEffectiveTestConnection(pool, target);
    return { target, pool };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

export async function openVerifiedIsolatedPool(
  target: DedicatedTestDatabase,
  schema: string,
  poolFactory: TestPoolFactory = defaultPoolFactory,
): Promise<Pool> {
  quoteTemporarySchema(schema);
  const pool = poolFactory({
    connectionString: target.connectionString,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  try {
    await assertEffectiveTestConnection(pool, target, schema);
    return pool;
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

/** Un verrou consultatif vu dans `pg_locks` : espace (classid), clé (objid : l'entier de `hashtext` lu comme un OID, donc non signé), accordé ou en attente. */
export interface AdvisoryLockRow {
  namespace: number;
  key: number;
  granted: boolean;
}

/**
 * Verrous consultatifs d'espaces donnés qui appartiennent aux SESSIONS D'UN SEUL FICHIER D'ESSAI. `pg_locks` est global à l'instance : d'autres exécutions (agents,
 * terminaux) tiennent des verrous du même espace sur la même base de test. Le filtre retient donc (1) la base courante, (2) les sessions dont l'`application_name`
 * commence par `applicationPrefix` (chaque fichier nomme ses pools avec un préfixe unique à l'exécution : voir `uniqueApplicationPrefix`).
 */
export async function ownAdvisoryLocks(
  db: { query: Pool["query"] },
  applicationPrefix: string,
  namespaces: readonly number[],
  options: { granted?: boolean } = {},
): Promise<AdvisoryLockRow[]> {
  const result = await db.query<{ namespace: string; key: string; granted: boolean }>(
    `SELECT l.classid::bigint AS namespace, l.objid::bigint AS key, l.granted
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND a.datname = current_database()
        AND left(a.application_name, length($1::text)) = $1::text
        AND l.classid::bigint = ANY($2::bigint[])
        AND ($3::boolean IS NULL OR l.granted = $3::boolean)
      ORDER BY 1, 2, 3`,
    [applicationPrefix, [...namespaces], options.granted ?? null],
  );
  return result.rows.map((row) => ({ namespace: Number(row.namespace), key: Number(row.key), granted: row.granted }));
}

/** Préfixe d'`application_name` unique à cette exécution d'un fichier d'essai (pid + aléa) : `<étiquette>_<pid>_<aléa>`. */
export function uniqueApplicationPrefix(label: string): string {
  return `${label}_${process.pid}_${randomUUID().slice(0, 8)}`;
}
