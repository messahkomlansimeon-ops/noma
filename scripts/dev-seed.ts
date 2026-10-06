import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createOffer, createUser, getUserById, publishOffer } from "../lib/server/catalog";
import { isMatchingSchemaReady } from "../lib/server/matching/schema-ready";
import { closePostgresPool, getPostgresPool } from "../lib/server/postgres/client";
import {
  SEED_LOCK_NAMESPACE,
  SEED_MARKER,
  SEED_USAGE,
  SeedUsageError,
  capitalizeFirst,
  checkSeedEnvironment,
  fakeSellerId,
  parseSeedArguments,
  planSeedOffers,
  type SeedOptions,
} from "./dev-seed-plan";

/**
 * `npm run dev:seed -- --category phones --brand apple --model "iphone 12" --offers 8` : ajoute à une base d'ESSAI des annonces CONCURRENTES
 * d'exemple, par des vendeurs fictifs (numéros +225 07 99 99 99 01 à 50, un bloc qui n'appartient à personne). Pourquoi : un boost n'a d'effet
 * visible que si la liste d'un acheteur compte au moins 7 offres (quota de places mises en avant = 15 % de la liste, arrondi par défaut) ; avec une
 * seule annonce et un seul besoin, la cotation dit « un boost ne ferait monter votre annonce chez aucun acheteur (listes trop courtes…) » (ESSAYER.md).
 *
 * Les annonces passent par les VRAIS services du catalogue (création puis publication : l'outbox reçoit ses événements, le worker du matching les
 * évalue comme celles de n'importe quel vendeur). Rejouable : une annonce d'exemple déjà présente (même vendeur fictif, même produit) n'est jamais
 * recréée. Refus clair, RIEN d'écrit : `NODE_ENV` défini autre que « development », `DATABASE_URL` absent de l'environnement de lancement ou
 * qui ne désigne pas une base de CE poste, nom de base hors de la liste blanche (`noma_essai`, `noma_e2e`, `noma_essai_*` ; lot P3) (voir dev-seed-plan.ts).
 */

export interface SeedReport {
  sellersCreated: number;
  sellersExisting: number;
  offersCreated: number;
  offersExisting: number;
}

interface IdentityRow {
  user_id: string;
}

interface ExistingOfferRow {
  id: string;
  status: string;
  content_version: number;
}

/** Vendeur fictif : retrouvé par son numéro, sinon créé (compte actif + identité téléphonique vérifiée). Renvoie son identifiant. */
async function ensureFakeSeller(pool: Pool, phone: string): Promise<{ userId: string; created: boolean }> {
  const identity = await pool.query<IdentityRow>("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [phone]);
  if (identity.rows[0]) return { userId: identity.rows[0].user_id, created: false };
  const userId = fakeSellerId(phone);
  // Reprise après une exécution interrompue : le compte existe peut-être déjà (identifiant stable), l'identité manque.
  const user = (await getUserById(userId, pool)) ?? (await createUser({ id: userId }, pool));
  await pool.query(
    "INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2::uuid, clock_timestamp()) ON CONFLICT DO NOTHING",
    [phone, user.id],
  );
  return { userId: user.id, created: true };
}

/**
 * Peuple la base d'essai, UN `dev:seed` À LA FOIS : un verrou consultatif de session, tenu sur une connexion dédiée du pool pendant toute l'exécution,
 * sérialise deux commandes lancées en parallèle (sans lui : deux vendeurs fictifs créés en même temps, « erreur inattendue », ou annonces en double).
 * Le pool doit donc offrir au moins DEUX connexions (celui du script en a 20). Attente bornée à 60 s.
 */
export async function seedExampleOffers(pool: Pool, options: SeedOptions): Promise<SeedReport> {
  const lock = await pool.connect();
  let reusable = true;
  try {
    await lock.query("SET lock_timeout = '60s'");
    await lock.query("SELECT pg_advisory_lock($1::int, 1)", [SEED_LOCK_NAMESPACE]);
    return await seedUnderLock(pool, options);
  } finally {
    try {
      await lock.query("SELECT pg_advisory_unlock($1::int, 1)", [SEED_LOCK_NAMESPACE]);
      await lock.query("RESET lock_timeout");
    } catch {
      reusable = false; // connexion douteuse : détruite (son verrou de session tombe avec elle)
    }
    lock.release(!reusable);
  }
}

async function seedUnderLock(pool: Pool, options: SeedOptions): Promise<SeedReport> {
  const report: SeedReport = { sellersCreated: 0, sellersExisting: 0, offersCreated: 0, offersExisting: 0 };
  const brand = capitalizeFirst(options.brand);
  for (const planned of planSeedOffers(options)) {
    const seller = await ensureFakeSeller(pool, planned.phone);
    if (seller.created) report.sellersCreated += 1;
    else report.sellersExisting += 1;

    const existing = await pool.query<ExistingOfferRow>(
      `SELECT id, status, content_version FROM offers
        WHERE owner_id = $1::uuid
          AND lower(btrim(category)) = lower(btrim($2::text)) AND lower(btrim(brand)) = lower(btrim($3::text)) AND lower(btrim(model)) = lower(btrim($4::text))
          AND position($5::text in raw_text) > 0 AND archived_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [seller.userId, options.category, brand, options.model, SEED_MARKER],
    );
    const found = existing.rows[0];
    if (found) {
      // Reprise d'une exécution interrompue entre la création et la publication.
      if (found.status === "draft") await publishOffer(seller.userId, found.id, found.content_version, pool);
      report.offersExisting += 1;
      continue;
    }
    const created = await createOffer(
      {
        ownerId: seller.userId,
        rawText: planned.rawText,
        category: options.category,
        brand,
        model: options.model,
        condition: "Occasion",
        location: "Abidjan",
        price: { amount: planned.price, currency: "XOF" },
        availabilityStatus: "available",
        status: "draft",
      },
      pool,
    );
    await publishOffer(seller.userId, created.id, created.contentVersion, pool);
    report.offersCreated += 1;
  }
  return report;
}

async function main(): Promise<number> {
  const options = parseSeedArguments(process.argv.slice(2));
  // Garde-fous AVANT toute connexion : en cas de refus, aucune requête n'est envoyée.
  const environment = checkSeedEnvironment(process.env);
  if (!environment.ok) {
    console.error(`dev:seed : refus — ${environment.reason}`);
    return 1;
  }
  const pool = getPostgresPool();
  if (!(await isMatchingSchemaReady(pool))) {
    console.error("dev:seed : la base d'essai n'est pas migrée (lancez d'abord `npm run db:migrate` avec cette DATABASE_URL).");
    return 1;
  }
  const report = await seedExampleOffers(pool, options);
  console.log(
    `dev:seed : base « ${environment.databaseName} », produit « ${options.category} · ${options.brand} ${options.model} » : ` +
      `${report.offersCreated} annonce(s) d'exemple publiée(s), ${report.offersExisting} déjà présente(s) ; ` +
      `${report.sellersCreated} vendeur(s) fictif(s) créé(s), ${report.sellersExisting} déjà présent(s) (numéros +225 07 99 99 99 01 à ${String(options.offers).padStart(2, "0")}).`,
  );
  console.log(
    "dev:seed : le worker du matching les compare aux besoins (quelques secondes). Publiez ensuite VOTRE annonce et créez VOTRE besoin pour ce produit : " +
      "la liste de l'acheteur comptera assez d'offres pour qu'un boost fasse monter l'annonce.",
  );
  return 0;
}

// Exécution directe seulement (les tests importent ce module sans rien lancer).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error instanceof SeedUsageError) console.error(`dev:seed : ${error.message}. ${SEED_USAGE}`);
      else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`dev:seed : ${error.message}`);
      else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`dev:seed : erreur ${code}.`);
      else console.error("dev:seed : erreur inattendue.");
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePostgresPool();
    });
}
