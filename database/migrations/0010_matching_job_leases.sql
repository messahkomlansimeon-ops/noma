-- Migration 0010 : cohérence des baux et du cycle de vie des jobs (lot 2E3B)
-- Additive : ne modifie pas 0001 à 0009.

-- Un job réservé porte toujours son jeton de bail.
ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_running_claim_token
    CHECK (status <> 'running' OR claim_token IS NOT NULL);

-- Hors statut running, aucun champ de bail ne subsiste.
ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_no_lease_unless_running
    CHECK (status = 'running' OR (
        claim_token IS NULL AND locked_by IS NULL
        AND locked_at IS NULL AND lock_expires_at IS NULL
    ));

-- Un job terminal a une date de clôture ; un job non terminal n'en a pas.
ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_completed_at_terminal
    CHECK ((status IN ('completed', 'superseded', 'dead_letter')) = (completed_at IS NOT NULL));

ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_attempts_bounded
    CHECK (attempts <= max_attempts);

ALTER TABLE matching_jobs
    ADD CONSTRAINT chk_matching_jobs_counters_non_negative
    CHECK (processed_candidates_count >= 0 AND created_evaluations_count >= 0);

-- Reprise des baux expirés et maintenance.
CREATE INDEX idx_matching_jobs_running_expiry
    ON matching_jobs (lock_expires_at)
    WHERE status = 'running';
