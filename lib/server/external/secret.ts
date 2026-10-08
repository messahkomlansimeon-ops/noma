import "server-only";

import { createHmac } from "node:crypto";
import { requireAuthSecret } from "../auth/config";

/**
 * Clé d'empreinte des identifiants externes qui ressemblent à un numéro de téléphone (lot EXT1-bis). DÉRIVÉE du secret du serveur (`NOMA_AUTH_SECRET`, le mécanisme de secret
 * existant : même décodage, mêmes exigences de 32 octets) par un HMAC à séparation de domaine : la clé d'authentification n'est jamais utilisée telle quelle. Secret absent ou
 * invalide : `null`, jamais d'exception ni de valeur par défaut (une annonce dont l'identifiant ressemble à un numéro est alors rejetée par le nettoyage).
 */

const DOMAIN = "noma:external:listing-id-pseudonym:v1";

export function readPseudonymKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  try {
    return createHmac("sha256", requireAuthSecret(undefined, env)).update(DOMAIN, "utf8").digest();
  } catch {
    return null;
  }
}
