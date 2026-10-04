CREATE TABLE catalog_extraction_proposals (
  id UUID PRIMARY KEY,
  offer_id UUID REFERENCES offers(id) ON DELETE RESTRICT,
  demand_id UUID REFERENCES demands(id) ON DELETE RESTRICT,
  source_content_version INTEGER NOT NULL CHECK (source_content_version > 0),
  source_raw_text TEXT NOT NULL CHECK (btrim(source_raw_text) <> ''),
  source_text_sha256 CHAR(64) NOT NULL
    CHECK (source_text_sha256 ~ '^[0-9a-f]{64}$'),
  contract_version TEXT NOT NULL CHECK (btrim(contract_version) <> ''),
  extractor_version TEXT NOT NULL CHECK (btrim(extractor_version) <> ''),
  provenance TEXT NOT NULL CHECK (provenance IN ('deterministic', 'ai')),
  proposal JSONB NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  ambiguities JSONB NOT NULL CHECK (jsonb_typeof(ambiguities) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(offer_id, demand_id) = 1),
  CHECK (
    (offer_id IS NOT NULL AND proposal ->> 'type' = 'offer') OR
    (demand_id IS NOT NULL AND proposal ->> 'type' = 'demand')
  ),
  CHECK (proposal ->> 'rawText' = source_raw_text),
  CHECK (proposal ->> 'contractVersion' = contract_version),
  CHECK (proposal ->> 'extractorVersion' = extractor_version),
  CHECK (proposal ->> 'provenance' = provenance),
  CHECK (
    proposal ? 'evidence' AND
    jsonb_typeof(proposal -> 'evidence') = 'array' AND
    proposal -> 'evidence' = evidence
  ),
  CHECK (
    proposal ? 'ambiguities' AND
    jsonb_typeof(proposal -> 'ambiguities') = 'array' AND
    proposal -> 'ambiguities' = ambiguities
  )
);

CREATE UNIQUE INDEX catalog_extraction_proposals_offer_version_idx
  ON catalog_extraction_proposals (
    offer_id,
    source_content_version,
    contract_version,
    extractor_version
  )
  WHERE offer_id IS NOT NULL;

CREATE UNIQUE INDEX catalog_extraction_proposals_demand_version_idx
  ON catalog_extraction_proposals (
    demand_id,
    source_content_version,
    contract_version,
    extractor_version
  )
  WHERE demand_id IS NOT NULL;

CREATE INDEX catalog_extraction_proposals_offer_history_idx
  ON catalog_extraction_proposals (offer_id, source_content_version DESC, created_at DESC)
  WHERE offer_id IS NOT NULL;

CREATE INDEX catalog_extraction_proposals_demand_history_idx
  ON catalog_extraction_proposals (demand_id, source_content_version DESC, created_at DESC)
  WHERE demand_id IS NOT NULL;
