import { PHONE_IN_OFFER_MESSAGE } from "../../phone-text";

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/** Une annonce porte un numéro de téléphone caché (marque, modèle, variante, attribut…) : refusée avec un message clair (lot D1). */
export class CatalogPhoneNumberError extends CatalogValidationError {
  constructor() {
    super(PHONE_IN_OFFER_MESSAGE);
    this.name = "CatalogPhoneNumberError";
  }
}

export class CatalogNotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} introuvable.`);
    this.name = "CatalogNotFoundError";
  }
}

export class CatalogOwnershipError extends Error {
  constructor(entity: string) {
    super(`Accès propriétaire refusé pour ${entity}.`);
    this.name = "CatalogOwnershipError";
  }
}

export class StaleContentVersionError extends Error {
  constructor(entity: string, expected: number, actual: number) {
    super(`Version obsolète pour ${entity} : attendue ${expected}, actuelle ${actual}.`);
    this.name = "StaleContentVersionError";
  }
}

export class ArchivedCatalogResourceError extends Error {
  constructor(entity: string) {
    super(`${entity} archivée et non modifiable.`);
    this.name = "ArchivedCatalogResourceError";
  }
}

export class CatalogStatusTransitionError extends Error {
  readonly currentStatus: string;
  readonly targetStatus: string;

  constructor(entity: string, currentStatus: string, targetStatus: string) {
    super(`Transition de statut impossible pour ${entity} : ${currentStatus} -> ${targetStatus}.`);
    this.name = "CatalogStatusTransitionError";
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}
