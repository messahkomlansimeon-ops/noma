/**
 * Résultat d'envoi INCONNU (lot SMS1) : le message est peut-être parti (503, statut « unknown » ou « reserved », coupure après l'envoi). L'étape « notify » ne le renvoie JAMAIS :
 * le lot est compté comme envoyé pour le rythme (4 h, 3 par jour) avec le code d'erreur `sms_uncertain`, et reste à rapprocher dans l'administration (/admin/sms).
 * Fichier à part pour que le transport SMS réel puisse le lever sans importer `transport.ts` (qui importe le résolveur du transport SMS).
 */
export class NotificationUncertainError extends Error {
  constructor() {
    super("Le transport n'a pas pu confirmer l'envoi.");
    this.name = "NotificationUncertainError";
  }
}

/**
 * Budget des notifications atteint (lot SMS1-bis) : AUCUN SMS n'est parti et aucune tentative n'est consommée. L'étape « notify » REPORTE le lot (jamais `failed` définitif) au
 * lendemain 7 h UTC (début du prochain jour de budget, hors heures calmes), dans la limite de l'attente maximale de 48 h de N1-bis. Fichier à part, comme `NotificationUncertainError`.
 */
export class NotificationBudgetError extends Error {
  constructor() {
    super("Le budget d'envoi des notifications est atteint.");
    this.name = "NotificationBudgetError";
  }
}
