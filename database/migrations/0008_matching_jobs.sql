-- Migration 0008 : File de calcul asynchrone des correspondances (Jobs)
CREATE TABLE IF NOT EXISTS matching_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_identity TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL CHECK (job_type IN (
        'evaluate_offer_candidates',
        'evaluate_demand_candidates',
        'reevaluate_pair_temporal',
        'scoring_config_sweep',
        'user_reactivation_sweep'
    )),
    resource_id UUID NOT NULL,
    resource_version INTEGER NOT NULL CHECK (resource_version > 0),
    target_resource_id UUID,
    scoring_config_hash TEXT,
    cursor_position TEXT,
    chunk_evaluated_at TIMESTAMPTZ,
    chunk_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_event_id UUID REFERENCES matching_outbox_events(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'superseded', 'dead_letter'
    )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    locked_by TEXT,
    locked_at TIMESTAMPTZ,
    lock_expires_at TIMESTAMPTZ,
    claim_token UUID,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    last_error TEXT,
    processed_candidates_count INTEGER NOT NULL DEFAULT 0,
    created_evaluations_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_matching_jobs_lock_coherence CHECK (
        (status = 'running' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL) OR
        (status <> 'running')
    )
);

-- Index critique pour la réservation concurrente SKIP LOCKED sans blocage
CREATE INDEX IF NOT EXISTS idx_matching_jobs_reservation ON matching_jobs (
    scheduled_at ASC,
    id ASC
) WHERE (status IN ('pending', 'failed') AND attempts < max_attempts);

-- Index pour détecter immédiatement l'obsolescence d'une ressource par rapport à sa version courante
CREATE INDEX IF NOT EXISTS idx_matching_jobs_resource_lookup ON matching_jobs (
    resource_id,
    resource_version DESC,
    created_at DESC
);

-- Index pour la supervision des jobs morts (Dead-Letter Queue)
CREATE INDEX IF NOT EXISTS idx_matching_jobs_dead_letter ON matching_jobs (
    updated_at DESC
) WHERE (status = 'dead_letter');
