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

/** Erreur volontairement identique pour tous les refus de vérification. */
export class OtpVerificationError extends Error {
  constructor() {
    super("Vérification OTP refusée.");
    this.name = "OtpVerificationError";
  }
}
