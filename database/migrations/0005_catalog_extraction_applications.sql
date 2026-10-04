CREATE TABLE catalog_extraction_applications (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('offer', 'demand')),
  offer_id UUID REFERENCES offers(id) ON DELETE RESTRICT,
  demand_id UUID REFERENCES demands(id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL REFERENCES catalog_extraction_proposals(id) ON DELETE RESTRICT,
  expected_content_version INTEGER NOT NULL CHECK (expected_content_version > 0),
  version_before INTEGER NOT NULL CHECK (version_before > 0),
  version_after INTEGER NOT NULL CHECK (version_after >= version_before),
  selected_fields JSONB NOT NULL CHECK (
    jsonb_typeof(selected_fields) = 'array' OR jsonb_typeof(selected_fields) = 'object'
  ),
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(offer_id, demand_id) = 1),
  CHECK (
    (resource_type = 'offer' AND offer_id IS NOT NULL) OR
    (resource_type = 'demand' AND demand_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX catalog_extraction_applications_owner_idempotency_idx
  ON catalog_extraction_applications (owner_id, idempotency_key);

CREATE INDEX catalog_extraction_applications_offer_idx
  ON catalog_extraction_applications (offer_id, applied_at DESC)
  WHERE offer_id IS NOT NULL;

CREATE INDEX catalog_extraction_applications_demand_idx
  ON catalog_extraction_applications (demand_id, applied_at DESC)
  WHERE demand_id IS NOT NULL;

CREATE INDEX catalog_extraction_applications_proposal_idx
  ON catalog_extraction_applications (proposal_id);
