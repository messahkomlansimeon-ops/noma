CREATE TABLE IF NOT EXISTS matching_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key UUID NOT NULL,
    attempt_hash TEXT NOT NULL,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    offer_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    demand_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_content_version INTEGER NOT NULL,
    demand_content_version INTEGER NOT NULL,
    engine_offline_version TEXT NOT NULL DEFAULT 'matching-offline/v1',
    engine_scoring_version TEXT NOT NULL DEFAULT 'matching-scoring/v1',
    scoring_config_hash TEXT NOT NULL,
    scoring_config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scoring_config) = 'object'),
    evaluated_at TIMESTAMPTZ NOT NULL,
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible', 'ineligible')),
    eligibility_reasons TEXT[] NOT NULL DEFAULT '{}',
    compatibility_status TEXT NOT NULL CHECK (compatibility_status IN ('compatible', 'incompatible', 'unknown')),
    is_confirmed_match BOOLEAN GENERATED ALWAYS AS (
        compatibility_status = 'compatible' AND eligibility_status = 'eligible'
    ) STORED,
    score NUMERIC(9, 6) CHECK (score IS NULL OR (score >= 0.000000 AND score <= 100.000000)),
    coverage NUMERIC(9, 6) CHECK (coverage IS NULL OR (coverage >= 0.000000 AND coverage <= 100.000000)),
    evaluation_summary JSONB NOT NULL CHECK (jsonb_typeof(evaluation_summary) = 'object'),
    scoring_summary JSONB NOT NULL CHECK (jsonb_typeof(scoring_summary) = 'object'),
    preferences_summary JSONB NOT NULL CHECK (jsonb_typeof(preferences_summary) = 'object'),
    evaluation_details JSONB NOT NULL CHECK (jsonb_typeof(evaluation_details) = 'object'),
    is_latest BOOLEAN NOT NULL DEFAULT TRUE,
    is_stale BOOLEAN NOT NULL DEFAULT FALSE,
    stale_reason TEXT CHECK (stale_reason IN (
        'offer_updated', 'demand_updated', 'offer_archived', 'demand_archived',
        'offer_unavailable', 'demand_satisfied', 'user_suspended', 'user_archived',
        'engine_superseded', 'temporal_expiry', 'superseded_by_reevaluation'
    )),
    staled_at TIMESTAMPTZ,
    CONSTRAINT chk_matching_eval_different_owners CHECK (offer_owner_id <> demand_owner_id),
    CONSTRAINT chk_matching_eval_versions_positive CHECK (
        offer_content_version > 0 AND demand_content_version > 0
    ),
    CONSTRAINT uq_matching_evaluations_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_matching_eval_demand_confirmed ON matching_evaluations (
    demand_id,
    score DESC NULLS LAST,
    evaluated_at DESC
) WHERE (is_latest = TRUE AND is_stale = FALSE AND is_confirmed_match = TRUE);

CREATE INDEX IF NOT EXISTS idx_matching_eval_offer_confirmed ON matching_evaluations (
    offer_id,
    score DESC NULLS LAST,
    evaluated_at DESC
) WHERE (is_latest = TRUE AND is_stale = FALSE AND is_confirmed_match = TRUE);

CREATE INDEX IF NOT EXISTS idx_matching_eval_expires ON matching_evaluations (
    expires_at
) WHERE (is_latest = TRUE AND is_stale = FALSE AND expires_at IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_matching_evaluations_latest ON matching_evaluations (
    offer_id,
    demand_id
) WHERE (is_latest = TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS uq_matching_evaluations_calc ON matching_evaluations (
    offer_id,
    demand_id,
    offer_content_version,
    demand_content_version,
    engine_offline_version,
    engine_scoring_version,
    scoring_config_hash
) WHERE (is_stale = FALSE);
