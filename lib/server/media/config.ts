/**
 * Configuration de code des photos d'annonces (lot PH1). Aucune dépendance : ce module est PUR (importé aussi par les essais et par `demo:seed`). Voir PHOTOS.md.
 */

/** Photos par annonce : imposé en base (position 0 à 5, unique par annonce) ET dans le code. */
export const PHOTO_MAX_PER_OFFER = 6;

/** Poids maximal d'un fichier reçu (octets). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Dimensions lues dans l'EN-TÊTE du fichier (jamais en décodant les pixels) : bornes par côté et en nombre de pixels (bombe de décompression). Plafond de 12,5 mégapixels et de 4 100 px
 * par côté : un téléphone d'entrée de gamme produit au plus 4 032 × 3 024 (12,2 Mpx) ; une image de 40 Mpx se décode en 160 Mo dans le navigateur de chaque acheteur. Un en-tête peut
 * mentir sur les dimensions de ses données : le plafond borne ce que le navigateur a à décoder.
 */
export const PHOTO_MIN_SIDE = 200;
export const PHOTO_MAX_SIDE = 4_100;
export const PHOTO_MAX_PIXELS = 12_500_000;

/** Délai TOTAL de lecture du corps d'un envoi (secondes plus tard : 408) : un corps goutte à goutte ne retient pas une connexion plus longtemps. */
export const PHOTO_BODY_READ_TIMEOUT_MS = 30_000;

/** Envois (acceptés ou refusés pour le fichier) par vendeur et par heure glissante. */
export const PHOTO_UPLOADS_PER_HOUR = 30;
/** Les lignes du journal des envois plus vieilles que cela sont supprimées au fil de l'eau. */
export const PHOTO_UPLOAD_LOG_RETENTION_HOURS = 24;

/** Espaces des verrous consultatifs (voir la liste de scripts/demo-seed-plan.ts) : écriture des photos d'UNE annonce ; débit des envois d'UN vendeur. */
export const MEDIA_OFFER_LOCK_NAMESPACE = 1_314_664_970;
export const MEDIA_UPLOAD_LOCK_NAMESPACE = 1_314_664_971;

/** Plafond de durée des transactions de photos. */
export const MEDIA_TRANSACTION_TIMEOUT = "10s";

/** Cache du navigateur pour une photo servie (privé : jamais un cache partagé). */
export const PHOTO_CACHE_CONTROL = "private, max-age=300";

/** En-têtes de TOUTE photo servie (le type vient en plus, de la base : celui que les octets ont prouvé). */
export const PHOTO_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "inline",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": PHOTO_CACHE_CONTROL,
  // La réponse dépend de la session : un cache ne la rejoue jamais à un autre compte (et le cache privé du navigateur reste borné à 5 minutes après la perte d'accès).
  Vary: "Cookie",
});

/** Dossier des fichiers (hors de public/) ; par défaut `data/media` hors production, OBLIGATOIRE en production. */
export const MEDIA_DIRECTORY_VARIABLE = "NOMA_MEDIA_DIR";
export const MEDIA_DEFAULT_DIRECTORY = "data/media";

/** Variables de `media:gc` : autorisation explicite en production ; âge minimal (secondes) d'un fichier orphelin avant suppression (défaut 600). */
export const MEDIA_GC_PRODUCTION_VARIABLE = "NOMA_MEDIA_GC_PRODUCTION";
export const MEDIA_GC_MIN_AGE_VARIABLE = "NOMA_MEDIA_GC_MIN_AGE_SECONDS";
export const MEDIA_GC_DEFAULT_MIN_AGE_SECONDS = 600;

/**
 * Garde de `media:gc --apply` contre un dossier mal désigné : si plus de 5 % des lignes, ou plus de 20 lignes, n'ont pas de fichier, la suppression est refusée, sauf
 * `--expect-missing=<N>` avec N EXACTEMENT égal au nombre constaté.
 */
export const MEDIA_GC_MISSING_MAX_PERCENT = 5;
export const MEDIA_GC_MISSING_MAX_COUNT = 20;
