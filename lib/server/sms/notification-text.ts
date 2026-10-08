/**
 * Texte de la notification par SMS (lot SMS1, déplacé ici par SMS1-bis). Module PUR (aucun import serveur) : la configuration du démarrage (config.ts) le lit pour vérifier, au démarrage,
 * que la notification au pire cas tient dans UN segment (M2) sans importer de module « server-only ». Le texte ne contient ni titre, ni prix, ni numéro.
 */

/** « noma : 3 nouvelles annonces pour vos besoins. https://exemple.ci/notifications » (accord au singulier pour 1). */
export function notificationMessage(count: number, link: string): string {
  const noun = count === 1 ? "1 nouvelle annonce" : `${count} nouvelles annonces`;
  return `noma : ${noun} pour vos besoins. ${link}`;
}
