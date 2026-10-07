import "server-only";

import type { Pool } from "pg";
import { toCanonicalPhone } from "../../client/phone";
import { withPostgresTransaction } from "../postgres/client";
import { AdminError } from "./errors";

/**
 * Attribution du rôle d'administration (lot D2). Le rôle (`users.is_admin`) ne s'attribue QUE par ce chemin : la commande `npm run admin:grant -- <numéro>` (et `demo:seed`,
 * qui l'appelle pour le compte Admin démo). Le déclencheur de la migration 0020 refuse tout autre UPDATE ou INSERT qui ferait passer `is_admin` à TRUE : ce chemin ouvre
 * `SET LOCAL noma.admin_grant = 'on'` dans sa transaction. Chaque attribution est écrite dans le journal d'administration (`admin_actions`, source `command`).
 */

export const ADMIN_GRANT_PRODUCTION_VARIABLE = "NOMA_ADMIN_GRANT_PRODUCTION";

/**
 * Refus de l'environnement : NODE_ENV absent, « development » ou « test » (casse exacte) : permis. « production » : permis seulement avec `NOMA_ADMIN_GRANT_PRODUCTION=1`.
 * Toute autre valeur : refusée. Renvoie le texte du refus (sans répéter la valeur reçue), ou null.
 */
export function adminGrantEnvironmentRefusal(env: Record<string, string | undefined>): string | null {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv === "development" || nodeEnv === "test") return null;
  if (nodeEnv === "production") {
    return env[ADMIN_GRANT_PRODUCTION_VARIABLE] === "1"
      ? null
      : `refus en production : définissez ${ADMIN_GRANT_PRODUCTION_VARIABLE}=1 pour confirmer explicitement (aucun rôle n'a été attribué).`;
  }
  return `refus : NODE_ENV doit être absent, « development » ou « test » (casse exacte ; en production, ${ADMIN_GRANT_PRODUCTION_VARIABLE}=1 avec NODE_ENV=production) ; aucun rôle n'a été attribué.`;
}

export interface AdminGrantResult {
  userId: string;
  /** Faux : le compte était déjà administrateur (rien n'est écrit, rien n'est journalisé). */
  granted: boolean;
}

/** Attribue le rôle au compte DONT LE NUMÉRO VÉRIFIÉ est donné (saisie libre, normalisée en E.164). */
export async function grantAdmin(input: { pool: Pool; phone: string }): Promise<AdminGrantResult> {
  const canonical = toCanonicalPhone(input.phone) ?? (/^\+[1-9][0-9]{7,14}$/.test(input.phone.trim()) ? input.phone.trim() : null);
  if (canonical === null) throw new AdminError("grant_invalid_phone");
  return withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL noma.admin_grant = 'on'");
    const found = await client.query<{ user_id: string; is_admin: boolean }>(
      `SELECT u.id AS user_id, u.is_admin
         FROM phone_identities p JOIN users u ON u.id = p.user_id
        WHERE p.phone_e164 = $1 AND p.verified_at IS NOT NULL AND u.status = 'active'
        FOR UPDATE OF u`,
      [canonical],
    );
    const user = found.rows[0];
    if (!user) throw new AdminError("grant_no_account");
    if (user.is_admin) return { userId: user.user_id, granted: false };
    await client.query("UPDATE users SET is_admin = TRUE, updated_at = clock_timestamp() WHERE id = $1::uuid", [user.user_id]);
    await client.query("INSERT INTO admin_actions (admin_id, source, action, target_user_id) VALUES (NULL, 'command', 'grant_admin', $1::uuid)", [user.user_id]);
    return { userId: user.user_id, granted: true };
  }, input.pool);
}
