-- Migration 0009 : contraintes de projection outbox -> jobs (lot 2E3A)
-- Additive : ne modifie pas 0001 à 0008. Aucune contrainte de bail ni de claim_token (lot 2E3B).

-- Un événement en attente n'a pas de date d'acquittement ; un événement acquitté en a une.
ALTER TABLE matching_outbox_events
    ADD CONSTRAINT chk_outbox_dispatch_coherence
    CHECK ((dispatch_status = 'pending') = (dispatched_at IS NULL));

-- Un message d'erreur n'existe que pour un événement invalide acquitté comme ignoré.
ALTER TABLE matching_outbox_events
    ADD CONSTRAINT chk_outbox_error_message_ignored
    CHECK (error_message IS NULL OR dispatch_status = 'ignored');

-- Un événement de compte porte toujours la version (génération) du compte.
ALTER TABLE matching_outbox_events
    ADD CONSTRAINT chk_outbox_user_version
    CHECK (aggregate_type <> 'user' OR aggregate_version IS NOT NULL);

-- Un seul événement par version d'agrégat versionné.
CREATE UNIQUE INDEX uq_matching_outbox_aggregate_version
    ON matching_outbox_events (aggregate_type, aggregate_id, aggregate_version)
    WHERE aggregate_type IN ('offer', 'demand', 'user');

-- L'identité d'un job est une empreinte SHA-256 hexadécimale minuscule.
ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_identity_format
    CHECK (job_identity ~ '^[0-9a-f]{64}$');

-- Recherche des jobs issus d'un événement.
CREATE INDEX idx_matching_jobs_source_event
    ON matching_jobs (source_event_id);
