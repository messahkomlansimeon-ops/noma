import { ATTRIBUTE_KEY_MESSAGE, phoneInOfferMessage, type OfferTextField } from "../../phone-text";

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/**
 * Une annonce porte un numéro de téléphone caché (marque, modèle, variante, attribut…) : refusée avec un message clair qui nomme le champ concerné (lots D1 et D3).
 * `field` est l'un des champs textuels de l'annonce (jamais le texte saisi).
 */
export class CatalogPhoneNumberError extends CatalogValidationError {
  readonly field: OfferTextField | null;

  constructor(field: OfferTextField | null = null) {
    super(phoneInOfferMessage(field));
    this.name = "CatalogPhoneNumberError";
    this.field = field;
  }
}

/** Un nom d'attribut de l'annonce n'est pas écrit en lettres minuscules et tiret bas seulement (lot D3) : refusé, sans jamais répéter le nom saisi. */
export class CatalogAttributeKeyError extends CatalogValidationError {
  constructor() {
    super(ATTRIBUTE_KEY_MESSAGE);
    this.name = "CatalogAttributeKeyError";
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

/**
 * La limite d'annonces EN LIGNE du plan de l'utilisateur est atteinte (lot PRO1) : publier ou remettre en ligne une annonce de plus est refusé, rien n'est écrit. La limite vient
 * de la version du plan en vigueur (Gratuit : 10 ; Pro : 100, valeurs provisoires), lue côté serveur.
 */
export class OfferLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Limite de ${limit} annonces en ligne atteinte.`);
    this.name = "OfferLimitError";
    this.limit = limit;
  }
}
