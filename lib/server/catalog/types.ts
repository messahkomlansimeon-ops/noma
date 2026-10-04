export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Money {
  amount: number;
  /** Code ISO sur trois lettres, par exemple XOF. Aucune conversion implicite. */
  currency: string;
}

export interface CatalogPagination {
  limit: number;
  offset: number;
}

export type UserStatus = "active" | "suspended" | "archived";
export type OfferStatus = "draft" | "published" | "paused" | "archived";
export type DemandStatus = "draft" | "active" | "satisfied" | "archived";
export type AvailabilityStatus = "available" | "reserved" | "unavailable";

export interface UserRecord {
  id: string;
  status: UserStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateUserInput {
  id?: string;
  status?: Exclude<UserStatus, "archived">;
}

export interface UpdateUserInput {
  id: string;
  expectedVersion: number;
  status: Exclude<UserStatus, "archived">;
}

export interface CatalogContent {
  rawText: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: JsonObject | null;
  condition: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  deadlineAt: Date | null;
  extractorVersion: string | null;
  extractionMetadata: JsonObject | null;
  extractedAt: Date | null;
}

export interface CatalogContentInput {
  rawText: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  attributes?: JsonObject | null;
  condition?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  deadlineAt?: Date | null;
  extractorVersion?: string | null;
  extractionMetadata?: JsonObject | null;
  extractedAt?: Date | null;
}

export type CatalogContentChanges = Partial<CatalogContentInput>;

export interface OfferRecord extends CatalogContent {
  id: string;
  ownerId: string;
  status: OfferStatus;
  price: Money | null;
  availabilityStatus: AvailabilityStatus | null;
  availabilityConfirmedAt: Date | null;
  contentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface DemandRecord extends CatalogContent {
  id: string;
  ownerId: string;
  status: DemandStatus;
  budget: Money | null;
  requirements: JsonValue[] | null;
  preferences: JsonValue[] | null;
  contentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateOfferInput extends CatalogContentInput {
  id?: string;
  ownerId: string;
  status?: Exclude<OfferStatus, "archived">;
  price?: Money | null;
  availabilityStatus?: AvailabilityStatus | null;
  availabilityConfirmedAt?: Date | null;
}

export interface UpdateOfferInput {
  id: string;
  ownerId: string;
  expectedContentVersion: number;
  changes: CatalogContentChanges & {
    status?: Exclude<OfferStatus, "archived">;
    price?: Money | null;
    availabilityStatus?: AvailabilityStatus | null;
    availabilityConfirmedAt?: Date | null;
  };
}

export interface CreateDemandInput extends CatalogContentInput {
  id?: string;
  ownerId: string;
  status?: Exclude<DemandStatus, "archived">;
  budget?: Money | null;
  requirements?: JsonValue[] | null;
  preferences?: JsonValue[] | null;
}

export interface UpdateDemandInput {
  id: string;
  ownerId: string;
  expectedContentVersion: number;
  changes: CatalogContentChanges & {
    status?: Exclude<DemandStatus, "archived">;
    budget?: Money | null;
    requirements?: JsonValue[] | null;
    preferences?: JsonValue[] | null;
  };
}
