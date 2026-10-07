import "server-only";

/**
 * Texte saisi par un vendeur et montré à un acheteur (attributs de la fiche d'annonce M1, titre d'une notification N1, fiche produit des résultats) : UNE seule
 * règle partagée, définie dans `lib/phone-text.ts` (module pur, sans dépendance serveur) et reprise ici pour les lecteurs serveur existants.
 *  - le texte est normalisé en NFKC avant tout contrôle (chiffres pleine chasse, exposants, chiffres cerclés, mathématiques : ramenés à leur forme usuelle) ;
 *  - les chiffres se comptent avec `\p{Nd}` (tous les systèmes d'écriture), jamais avec `\d` (ASCII seulement) ;
 *  - huit chiffres ou plus séparés par au plus trois caractères non-chiffres (n'importe lesquels) ressemblent à un numéro de téléphone : le texte n'est jamais
 *    publié (le numéro ne se révèle que par le contact).
 * Fonctions pures. Voir NOTIFICATIONS.md et MESURES.md.
 */
export {
  UNSAFE_TEXT,
  PHONE_MIN_DIGITS,
  PHONE_MAX_GAP,
  PHONE_IN_OFFER_MESSAGE,
  normalizePublicText,
  countDigits,
  hasUnsafeCharacters,
  looksLikePhoneNumber,
  publicFieldText,
  anyLooksLikePhoneNumber,
} from "../../phone-text";
