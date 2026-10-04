ALTER TABLE catalog_extraction_proposals
  DROP CONSTRAINT IF EXISTS catalog_extraction_proposals_check1,
  DROP CONSTRAINT IF EXISTS catalog_extraction_proposals_check2,
  DROP CONSTRAINT IF EXISTS catalog_extraction_proposals_check3,
  DROP CONSTRAINT IF EXISTS catalog_extraction_proposals_check4,
  DROP CONSTRAINT IF EXISTS catalog_extraction_proposals_check5;

ALTER TABLE catalog_extraction_proposals
  ADD CONSTRAINT catalog_extraction_proposals_proposal_type_check
    CHECK (
      (
        proposal ? 'type' AND
        jsonb_typeof(proposal -> 'type') = 'string' AND
        (
          (offer_id IS NOT NULL AND proposal ->> 'type' = 'offer') OR
          (demand_id IS NOT NULL AND proposal ->> 'type' = 'demand')
        )
      ) IS TRUE
    ),
  ADD CONSTRAINT catalog_extraction_proposals_proposal_raw_text_check
    CHECK (
      (
        proposal ? 'rawText' AND
        jsonb_typeof(proposal -> 'rawText') = 'string' AND
        proposal ->> 'rawText' = source_raw_text
      ) IS TRUE
    ),
  ADD CONSTRAINT catalog_extraction_proposals_proposal_contract_version_check
    CHECK (
      (
        proposal ? 'contractVersion' AND
        jsonb_typeof(proposal -> 'contractVersion') = 'string' AND
        proposal ->> 'contractVersion' = contract_version
      ) IS TRUE
    ),
  ADD CONSTRAINT catalog_extraction_proposals_proposal_extractor_version_check
    CHECK (
      (
        proposal ? 'extractorVersion' AND
        jsonb_typeof(proposal -> 'extractorVersion') = 'string' AND
        proposal ->> 'extractorVersion' = extractor_version
      ) IS TRUE
    ),
  ADD CONSTRAINT catalog_extraction_proposals_proposal_provenance_check
    CHECK (
      (
        proposal ? 'provenance' AND
        jsonb_typeof(proposal -> 'provenance') = 'string' AND
        proposal ->> 'provenance' = provenance
      ) IS TRUE
    ),
  ADD CONSTRAINT catalog_extraction_proposals_proposal_fields_check
    CHECK (
      (
        proposal ? 'fields' AND
        jsonb_typeof(proposal -> 'fields') = 'object'
      ) IS TRUE
    );
