export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export class OtpRequestError extends Error {
  constructor(message = "Demande OTP refusée.") {
    super(message);
    this.name = "OtpRequestError";
  }
}

export class OtpRateLimitError extends OtpRequestError {
  constructor() {
    super("Limite de demandes OTP atteinte.");
    this.name = "OtpRateLimitError";
  }
}

export class OtpResendDelayError extends OtpRequestError {
  constructor() {
    super("Un nouveau code ne peut pas encore être demandé.");
    this.name = "OtpResendDelayError";
  }
}

export class OtpDeliveryError extends OtpRequestError {
  constructor() {
    super("Le transport OTP n'a pas confirmé l'envoi.");
    this.name = "OtpDeliveryError";
  }
}

/**
 * Résultat d'envoi du code INCONNU (lot SMS1) : le fournisseur n'a pas pu dire si le SMS est parti (503, statut « unknown » ou « reserved », coupure après l'envoi). Levée par le
 * transport, jamais par `requestOtp` : le défi RESTE valable (le code est peut-être arrivé) et aucun code n'est renvoyé automatiquement ; une nouvelle demande reste possible
 * dans les limites habituelles (60 s, 3 par 15 min).
 */
export class OtpDeliveryUncertainError extends Error {
  constructor() {
    super("Le transport OTP n'a pas pu confirmer l'envoi.");
    this.name = "OtpDeliveryUncertainError";
  }
}

/**
 * Budget d'envoi des codes atteint (lot SMS1-bis) : la capacité d'envoi du jour ou de l'heure est épuisée pour ce type de demande (numéro inconnu : part non réservée ou lissage
 * horaire ; tous numéros : budget des codes). AUCUN SMS n'est parti. Levée par le transport ; `requestOtp` la relaie telle quelle (le défi passe à `send_failed`), et la route
 * répond par un code DISTINCT du « envoi impossible » générique.
 */
export class OtpCapacityError extends OtpRequestError {
  constructor() {
    super("La capacité d'envoi des codes est atteinte pour le moment.");
    this.name = "OtpCapacityError";
  }
}

/** Erreur volontairement identique pour tous les refus de vérification. */
export class OtpVerificationError extends Error {
  constructor() {
    super("Vérification OTP refusée.");
    this.name = "OtpVerificationError";
  }
}
