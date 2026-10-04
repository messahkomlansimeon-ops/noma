export class CatalogExtractionValidationError extends Error {
  constructor(message = "Proposition d'extraction invalide.") {
    super(message);
    this.name = "CatalogExtractionValidationError";
  }
}

export class CatalogExtractionConfigurationError extends Error {
  constructor(message = "Aucun extracteur IA n'est configuré.") {
    super(message);
    this.name = "CatalogExtractionConfigurationError";
  }
}

export class CatalogExtractionApplicationValidationError extends CatalogExtractionValidationError {
  constructor(message = "Application de proposition d'extraction invalide.") {
    super(message);
    this.name = "CatalogExtractionApplicationValidationError";
  }
}

export class StaleCatalogExtractionProposalError extends Error {
  constructor(message = "La proposition d'extraction est obsolète pour cette ressource.") {
    super(message);
    this.name = "StaleCatalogExtractionProposalError";
  }
}

export class CatalogExtractionApplicationConflictError extends Error {
  constructor(message = "La clé d'idempotence a déjà été utilisée avec des paramètres différents.") {
    super(message);
    this.name = "CatalogExtractionApplicationConflictError";
  }
}

export class CatalogExtractionProposalAttachmentError extends CatalogExtractionValidationError {
  constructor(message = "La proposition d'extraction n'est pas rattachée à cette ressource.") {
    super(message);
    this.name = "CatalogExtractionProposalAttachmentError";
  }
}

