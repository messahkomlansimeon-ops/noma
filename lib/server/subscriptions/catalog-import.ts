import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { buildOfferInput, CATEGORY_OPTIONS, CONDITION_OPTIONS, FIELD_LIMITS } from "../../client/catalog-view";
import { CatalogPhoneNumberError, CatalogValidationError, OfferLimitError } from "../catalog/errors";
import { createOffer } from "../catalog/offers";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, SUBSCRIPTION_LOCK_TIMEOUT_MS } from "./config";
import { assertCanPublishOffer, hasEntitlement, lockUserEntitlements, readUserEntitlements } from "./entitlements";
import { SubscriptionError } from "./errors";

/**
 * Import de catalogue par fichier CSV (lot PRO1, droit `catalog_import`). Voir OFFRE-PRO.md.
 *
 *  - Réservé aux abonnés dont la version du plan en vigueur porte le droit `catalog_import` (lu côté serveur, sous le verrou de l'utilisateur) : sinon `entitlement_required`.
 *  - UN fichier de 200 lignes de données au plus (en-tête exclu), 256 Kio au plus : au-delà, REFUSÉ EN ENTIER (`import_too_many_rows`). Aucun fichier n'est stocké.
 *  - APERÇU À BLANC (`dryRun`) puis APPLICATION : un seul et même code ; l'aperçu s'exécute dans la transaction de l'application et l'ANNULE à la fin, donc il rapporte exactement
 *    ce que l'application ferait (lignes refusées pour la limite d'annonces en ligne comprises) sans rien écrire.
 *  - CHAQUE LIGNE passe par la MÊME validation que le formulaire « Nouvelle annonce » (`buildOfferInput`, la fonction du formulaire) puis par la MÊME création que lui (`createOffer` :
 *    mêmes contrôles de contenu, numéro de téléphone refusé dans les champs visibles, limite d'annonces en ligne du plan). Une ligne refusée n'empêche pas les autres.
 *  - IDEMPOTENT par EMPREINTE du fichier (SHA-256 du texte normalisé) : un fichier déjà appliqué par ce vendeur renvoie son rapport sans rien recréer.
 *  - RAPPORT ligne par ligne : numéro de ligne du fichier, issue, code (et champ) ; JAMAIS une donnée du fichier. Le rapport appliqué est conservé avec l'empreinte.
 */

export const IMPORT_COLUMNS = ["titre", "description", "categorie", "marque", "modele", "variante", "etat", "localisation", "prix", "disponible"] as const;
type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type ImportRowOutcome = "created" | "would_create" | "rejected";

export interface ImportRowReport {
  /** Numéro de la ligne du fichier où commence l'enregistrement (l'en-tête est la ligne 1). */
  line: number;
  outcome: ImportRowOutcome;
  /** Refus : `invalid_field` (avec `field`), `too_many_columns`, `phone_number_in_offer`, `offer_limit_reached`, `invalid_row`. */
  code?: string;
  field?: string;
  /** Créée seulement (application) : identifiant de l'annonce du vendeur. */
  offerId?: string;
}

export interface CatalogImportResult {
  mode: "preview" | "apply";
  /** Vrai : ce fichier (même empreinte) a déjà été appliqué par ce vendeur ; le rapport est celui de cette application, rien n'a été recréé. */
  alreadyApplied: boolean;
  fingerprint: string;
  rowCount: number;
  /** Lignes créées (application) ou qui seraient créées (aperçu). */
  acceptedCount: number;
  rejectedCount: number;
  rows: ImportRowReport[];
}

// ───────────── lecture du CSV ─────────────

export interface ParsedCatalogCsv {
  columns: ImportColumn[];
  records: Array<{ line: number; cells: string[] }>;
}

/** Texte normalisé du fichier : sans marque d'ordre des octets, fins de ligne `\n`. C'est ce texte qui est lu ET empreinté. */
export function normalizeCsvText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Empreinte SHA-256 (hexadécimal) du texte normalisé. */
export function csvFingerprint(text: string): string {
  return createHash("sha256").update(normalizeCsvText(text), "utf8").digest("hex");
}

function canonicalColumn(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Lecture stricte : séparateur `,`, `;` ou tabulation (celui de l'en-tête), guillemets doubles (`""` pour un guillemet, retours à la ligne permis entre guillemets), lignes vides ignorées.
 * Refus du fichier (`import_invalid_file`) : texte trop gros, caractère de contrôle autre que tabulation et retour à la ligne, guillemet non fermé, en-tête sans « titre », colonne
 * inconnue ou en double. Plus de 200 enregistrements : `import_too_many_rows`.
 */
export function parseCatalogCsv(rawText: string): ParsedCatalogCsv {
  if (typeof rawText !== "string" || Buffer.byteLength(rawText, "utf8") > IMPORT_MAX_BYTES) throw new SubscriptionError("import_invalid_file");
  const text = normalizeCsvText(rawText);
  // Caractères de contrôle (hors tabulation et retour à la ligne) et caractères invisibles de direction : refusés.
  if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/.test(text)) throw new SubscriptionError("import_invalid_file");
  const firstLine = text.split("\n", 1)[0];
  const counts: Array<[string, number]> = [[",", firstLine.split(",").length], [";", firstLine.split(";").length], ["\t", firstLine.split("\t").length]];
  const delimiter = counts.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];

  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = "";
    quoted = false;
  };
  const endRecord = (): void => {
    endCell();
    // Enregistrement vide (une seule cellule vide, sans guillemets) : ignoré.
    if (!(cells.length === 1 && cells[0].trim() === "")) records.push({ line: recordLine, cells });
    cells = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === "\"" && cell.length === 0 && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (char === delimiter) {
      endCell();
    } else if (char === "\n") {
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      cell += char;
    }
  }
  if (inQuotes) throw new SubscriptionError("import_invalid_file");
  if (cell.length > 0 || cells.length > 0 || quoted) endRecord();

  if (records.length === 0) throw new SubscriptionError("import_invalid_file");
  const header = records[0].cells.map(canonicalColumn);
  const columns: ImportColumn[] = [];
  for (const name of header) {
    if (!(IMPORT_COLUMNS as readonly string[]).includes(name) || columns.includes(name as ImportColumn)) throw new SubscriptionError("import_invalid_file");
    columns.push(name as ImportColumn);
  }
  if (!columns.includes("titre")) throw new SubscriptionError("import_invalid_file");
  const data = records.slice(1);
  if (data.length === 0) throw new SubscriptionError("import_invalid_file");
  if (data.length > IMPORT_MAX_ROWS) throw new SubscriptionError("import_too_many_rows");
  return { columns, records: data };
}

// ───────────── une ligne ─────────────

const normalize = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type OfferInput = Extract<ReturnType<typeof buildOfferInput>, { ok: true }>["input"];
type RowBuild = { ok: true; input: OfferInput } | { ok: false; code: string; field?: string };

/** Une ligne du fichier → corps d'une annonce, par la fonction de validation du FORMULAIRE. Aucune donnée de la ligne dans un refus : un code et un champ. */
function buildRow(columns: readonly ImportColumn[], cells: readonly string[]): RowBuild {
  if (cells.length > columns.length) return { ok: false, code: "too_many_columns" };
  const value = (column: ImportColumn): string => {
    const index = columns.indexOf(column);
    return index === -1 || index >= cells.length ? "" : cells[index].trim();
  };
  const category = value("categorie");
  const condition = value("etat");
  const available = value("disponible");
  const matchedCategory = category === "" ? null : CATEGORY_OPTIONS.find((option) => normalize(option.label) === normalize(category))?.label ?? undefined;
  if (matchedCategory === undefined) return { ok: false, code: "invalid_field", field: "category" };
  // Comme le formulaire : « Occasion » par défaut.
  const matchedCondition = condition === "" ? "Occasion" : CONDITION_OPTIONS.find((option) => normalize(option) === normalize(condition));
  if (matchedCondition === undefined) return { ok: false, code: "invalid_field", field: "condition" };
  let isAvailable = true;
  if (available !== "") {
    const flag = normalize(available);
    if (["oui", "o", "1", "vrai", "true"].includes(flag)) isAvailable = true;
    else if (["non", "n", "0", "faux", "false"].includes(flag)) isAvailable = false;
    else return { ok: false, code: "invalid_field", field: "available" };
  }
  for (const [column, limit, field] of [["marque", FIELD_LIMITS.short, "brand"], ["modele", FIELD_LIMITS.short, "model"], ["variante", FIELD_LIMITS.short, "variant"], ["localisation", FIELD_LIMITS.location, "location"]] as const) {
    if (value(column).length > limit) return { ok: false, code: "invalid_field", field };
  }
  const built = buildOfferInput({
    title: value("titre"),
    description: value("description"),
    category: matchedCategory,
    brand: value("marque"),
    model: value("modele"),
    variant: value("variante"),
    condition: matchedCondition,
    location: value("localisation"),
    price: value("prix"),
    available: isAvailable,
  });
  if (!built.ok) return { ok: false, code: "invalid_field", field: Object.keys(built.errors)[0] };
  return { ok: true, input: built.input };
}

class DryRunComplete extends Error {
  constructor(readonly result: CatalogImportResult) {
    super("dry_run_complete");
  }
}

function isIntegrityViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("23");
}

async function createRow(client: PoolClient, sellerId: string, input: Parameters<typeof createOffer>[0]): Promise<{ offerId: string } | { code: string }> {
  await client.query("SAVEPOINT catalog_import_row");
  try {
    // La création EN LIGNE d'une annonce compte dans la limite du plan, comme sa publication par le formulaire (`publishOffer`) : contrôle explicite, sous le verrou de l'utilisateur.
    await assertCanPublishOffer(client, sellerId);
    const offer = await createOffer({ ...input, ownerId: sellerId, status: "published" }, client);
    await client.query("RELEASE SAVEPOINT catalog_import_row");
    return { offerId: offer.id };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT catalog_import_row");
    if (error instanceof CatalogPhoneNumberError) return { code: "phone_number_in_offer" };
    if (error instanceof OfferLimitError) return { code: "offer_limit_reached" };
    if (error instanceof CatalogValidationError || isIntegrityViolation(error)) return { code: "invalid_row" };
    throw error;
  }
}

/**
 * Aperçu (`dryRun: true`) ou application (`dryRun: false`) d'un fichier CSV pour le vendeur. Une transaction, sous le verrou de l'utilisateur : droit `catalog_import`, relecture de
 * l'empreinte (déjà appliqué : rapport renvoyé, rien recréé), puis chaque ligne dans un point de sauvegarde (une ligne refusée n'annule pas les autres) ; l'application inscrit le
 * rapport avec l'empreinte, l'aperçu annule tout. Les annonces sont créées EN LIGNE (comme le formulaire : création puis publication) : elles comptent dans la limite du plan,
 * et les lignes au-delà de la limite sont refusées (`offer_limit_reached`).
 */
export async function importCatalogCsv(input: { pool: Pool; sellerId: string; csv: string; dryRun: boolean }): Promise<CatalogImportResult> {
  const pool = requireTransactionPool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  if (typeof input.dryRun !== "boolean") throw new CatalogValidationError("dryRun doit être un booléen.");
  const dryRun = input.dryRun;
  // Lecture AVANT tout SQL : un fichier refusé n'ouvre aucune transaction.
  const parsed = parseCatalogCsv(input.csv);
  const fingerprint = csvFingerprint(input.csv);
  const mode = dryRun ? "preview" : "apply";

  try {
    return await withPostgresTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
      await lockUserEntitlements(client, sellerId);
      if (!hasEntitlement(await readUserEntitlements(client, sellerId), "catalog_import")) throw new SubscriptionError("entitlement_required");

      const previous = await client.query<{ row_count: number; created_count: number; rejected_count: number; report: ImportRowReport[] }>(
        "SELECT row_count, created_count, rejected_count, report FROM catalog_imports WHERE seller_id = $1::uuid AND fingerprint = $2",
        [sellerId, fingerprint],
      );
      if (previous.rows[0]) {
        return {
          mode, alreadyApplied: true, fingerprint, rowCount: previous.rows[0].row_count, acceptedCount: previous.rows[0].created_count,
          rejectedCount: previous.rows[0].rejected_count, rows: previous.rows[0].report,
        } satisfies CatalogImportResult;
      }

      const rows: ImportRowReport[] = [];
      for (const record of parsed.records) {
        const built = buildRow(parsed.columns, record.cells);
        if (!built.ok) {
          rows.push({ line: record.line, outcome: "rejected", code: built.code, ...(built.field ? { field: built.field } : {}) });
          continue;
        }
        const created = await createRow(client, sellerId, built.input as Parameters<typeof createOffer>[0]);
        if ("code" in created) rows.push({ line: record.line, outcome: "rejected", code: created.code });
        else rows.push({ line: record.line, outcome: dryRun ? "would_create" : "created", offerId: created.offerId });
      }
      const accepted = rows.filter((row) => row.outcome !== "rejected").length;
      const result: CatalogImportResult = {
        mode, alreadyApplied: false, fingerprint, rowCount: rows.length, acceptedCount: accepted, rejectedCount: rows.length - accepted, rows,
      };
      if (dryRun) throw new DryRunComplete(result);
      // L'aperçu n'a pas d'identifiant d'annonce (rien n'est créé) ; le rapport conservé ne contient que des numéros de ligne, des issues, des codes et des identifiants d'annonces créées.
      await client.query(
        `INSERT INTO catalog_imports (id, seller_id, fingerprint, row_count, created_count, rejected_count, report)
         VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::int, $6::int, $7::jsonb)`,
        [randomUUID(), sellerId, fingerprint, result.rowCount, result.acceptedCount, result.rejectedCount, JSON.stringify(rows)],
      );
      return result;
    }, pool);
  } catch (error) {
    if (error instanceof DryRunComplete) {
      // Aperçu : les identifiants des annonces fictives n'existent plus (transaction annulée) : ils ne sont pas rendus.
      return {
        ...error.result,
        rows: error.result.rows.map((row) => ({ line: row.line, outcome: row.outcome, ...(row.code ? { code: row.code } : {}), ...(row.field ? { field: row.field } : {}) })),
      };
    }
    throw error;
  }
}
