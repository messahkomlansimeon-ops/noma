-- Migration 0007 : Journal d'événements transactionnels pour le matching (Outbox)
CREATE TABLE IF NOT EXISTS matching_outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('offer', 'demand', 'user', 'temporal', 'system')),
    aggregate_id UUID NOT NULL,
    aggregate_version INTEGER CHECK (aggregate_version IS NULL OR aggregate_version > 0),
    target_aggregate_id UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    dispatched_at TIMESTAMPTZ,
    dispatch_status TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_status IN ('pending', 'projected', 'ignored')),
    error_message TEXT,
    CONSTRAINT chk_outbox_aggregate_version CHECK (
        (aggregate_type IN ('offer', 'demand') AND aggregate_version IS NOT NULL) OR
        (aggregate_type IN ('user', 'temporal', 'system'))
    )
);

-- Index pour la lecture séquentielle rapide des événements non encore projetés
CREATE INDEX IF NOT EXISTS idx_matching_outbox_pending ON matching_outbox_events (
    occurred_at ASC,
    id ASC
) WHERE (dispatch_status = 'pending');

-- Index de traçabilité pour audit par agrégat
CREATE INDEX IF NOT EXISTS idx_matching_outbox_aggregate ON matching_outbox_events (
    aggregate_type,
    aggregate_id,
    aggregate_version
);
