CREATE TABLE users (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMPTZ,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE offers (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  raw_text TEXT NOT NULL CHECK (btrim(raw_text) <> ''),
  category TEXT,
  brand TEXT,
  model TEXT,
  variant TEXT,
  attributes JSONB CHECK (attributes IS NULL OR jsonb_typeof(attributes) = 'object'),
  condition_text TEXT,
  quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
  unit TEXT,
  location_text TEXT,
  deadline_at TIMESTAMPTZ,
  price_amount BIGINT CHECK (
    price_amount IS NULL OR (price_amount >= 0 AND price_amount <= 9007199254740991)
  ),
  price_currency TEXT CHECK (
    price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'
  ),
  availability_status TEXT CHECK (
    availability_status IS NULL OR availability_status IN ('available', 'reserved', 'unavailable')
  ),
  availability_confirmed_at TIMESTAMPTZ,
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
  extractor_version TEXT,
  extraction_metadata JSONB CHECK (
    extraction_metadata IS NULL OR jsonb_typeof(extraction_metadata) = 'object'
  ),
  extracted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMPTZ,
  CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE demands (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'satisfied', 'archived')),
  raw_text TEXT NOT NULL CHECK (btrim(raw_text) <> ''),
  category TEXT,
  brand TEXT,
  model TEXT,
  variant TEXT,
  attributes JSONB CHECK (attributes IS NULL OR jsonb_typeof(attributes) = 'object'),
  condition_text TEXT,
  quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
  unit TEXT,
  location_text TEXT,
  deadline_at TIMESTAMPTZ,
  budget_amount BIGINT CHECK (
    budget_amount IS NULL OR (budget_amount >= 0 AND budget_amount <= 9007199254740991)
  ),
  budget_currency TEXT CHECK (
    budget_currency IS NULL OR budget_currency ~ '^[A-Z]{3}$'
  ),
  requirements JSONB CHECK (requirements IS NULL OR jsonb_typeof(requirements) = 'array'),
  preferences JSONB CHECK (preferences IS NULL OR jsonb_typeof(preferences) = 'array'),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
  extractor_version TEXT,
  extraction_metadata JSONB CHECK (
    extraction_metadata IS NULL OR jsonb_typeof(extraction_metadata) = 'object'
  ),
  extracted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMPTZ,
  CHECK ((budget_amount IS NULL) = (budget_currency IS NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX offers_owner_status_idx ON offers (owner_id, status);
CREATE INDEX offers_catalog_idx ON offers (category, brand, model, variant);
CREATE INDEX offers_location_idx ON offers (location_text);
CREATE INDEX demands_owner_status_idx ON demands (owner_id, status);
CREATE INDEX demands_catalog_idx ON demands (category, brand, model, variant);
CREATE INDEX demands_location_idx ON demands (location_text);
