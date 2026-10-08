-- Migration 0025 : collecte d'annonces externes MUTUALISÉE (lot EXT1)
-- Additive : ne modifie ni 0001 à 0020 ni aucune ligne existante. Les numéros 0021 à 0024 sont réservés à d'autres lots.
-- AUCUNE collecte réelle : les sources autorisées n'ont pas été validées par le fondateur (droit, conditions d'utilisation). Seules deux sources FICTIVES existent (type « fake »).
-- Jamais appliquée à noma_dev sans instruction explicite. Voir COLLECTE-EXTERNE.md.
--
-- external_sources : registre des sources. `type` n'admet QUE « fake » : une source réelle ne s'enregistre pas tant qu'un futur lot n'a pas ajouté une liste blanche validée
--   (il modifiera alors cette contrainte, avec la validation juridique). Disjoncteur par source : `consecutive_failures` et `breaker_open_until` (3 échecs de suite, 30 min de pause) ;
--   `breaker_trial_until` est le JETON de l'essai décisif (un seul à la fois, pris sous le verrou de la ligne de la source, expire de lui-même si le processus meurt).
-- market_watches : UNE surveillance par clé produit normalisée (catégorie, marque, modèle, variante facultative, zone), partagée par tous les besoins actifs qui ont cette clé.
--   Mise en pause quand plus aucun besoin actif ne la référence. `next_run_at` sert aussi de bail pendant une collecte (réservation FOR UPDATE SKIP LOCKED) ; `claim_token` est le
--   JETON du bail : seul l'exécuteur qui le détient peut clore la collecte ou rendre la surveillance (un exécuteur retardataire dont le bail a expiré n'écrase rien).
-- external_source_usage / market_watch_usage : requêtes consommées par jour UTC (quota de la source, budget de la surveillance par source), incrémentées de façon atomique AVANT l'appel.
-- external_collect_runs : une ligne par appel à une source (état, durée, nombres, code d'erreur stable ; jamais de message brut).
-- external_analyses : l'analyse d'un CONTENU (titre, prix, devise, lieu normalisés), clé `content_hash` : le même contenu n'est analysé qu'une fois, toutes annonces confondues.
-- duplicate_groups : annonces de sources différentes regroupées (même clé produit, prix à 2 % près, titre proche). Aucune annonce n'est supprimée ni fusionnée.
-- external_listings : annonces externes normalisées. Unique (source, identifiant externe) ET unique (source, URL canonique) en secours : l'URL canonique n'est unique que PAR SOURCE
--   (deux sources qui donnent la même adresse = deux lignes, regroupées ensuite comme doublons). Jamais de numéro de téléphone (retiré avant l'écriture), jamais de description, de vendeur
--   ni de photo. Disponibilité : available, gone (disparue ou signalée indisponible), unknown ; origine et date de la confirmation conservées. `last_seen_at` = dernière collecte qui a VU
--   l'annonce dans la réponse de sa source (c'est elle qui limite l'affichage à 48 h) ; `last_checked_at` = dernière collecte réussie qui l'a examinée, vue OU absente (jamais affichée).
-- source_observations : provenance conservée. Une ligne par (surveillance, annonce) : première et dernière observation, nombre de collectes réussies sans l'annonce.
--   Une annonce passe à « gone » quand TOUTES ses observations ont manqué 3 collectes de suite.

CREATE TABLE external_sources (
    code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    type TEXT NOT NULL CHECK (type = 'fake'),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    daily_quota INTEGER NOT NULL DEFAULT 200 CHECK (daily_quota BETWEEN 0 AND 100000),
    min_interval_ms INTEGER NOT NULL DEFAULT 1000 CHECK (min_interval_ms BETWEEN 0 AND 3600000),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    breaker_open_until TIMESTAMPTZ,
    breaker_trial_until TIMESTAMPTZ,
    last_request_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,60}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Les deux sources fictives, activées : « Annonces Démo A » et « Annonces Démo B ».
INSERT INTO external_sources (code, name, type, enabled, daily_quota, min_interval_ms) VALUES
    ('demo_a', 'Annonces Démo A', 'fake', TRUE, 200, 250),
    ('demo_b', 'Annonces Démo B', 'fake', TRUE, 200, 250);

CREATE TABLE market_watches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_key TEXT NOT NULL CHECK (char_length(product_key) BETWEEN 3 AND 600),
    category TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
    brand TEXT NOT NULL CHECK (char_length(brand) BETWEEN 1 AND 80),
    model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
    variant TEXT CHECK (variant IS NULL OR char_length(variant) BETWEEN 1 AND 80),
    zone TEXT NOT NULL DEFAULT '' CHECK (char_length(zone) <= 80),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    frequency_seconds INTEGER NOT NULL DEFAULT 21600 CHECK (frequency_seconds BETWEEN 60 AND 2592000),
    daily_request_budget INTEGER NOT NULL DEFAULT 4 CHECK (daily_request_budget BETWEEN 0 AND 1000),
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    claim_token UUID,
    paused_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_market_watches_product_key UNIQUE (product_key),
    CONSTRAINT chk_market_watches_pause CHECK ((status = 'paused') = (paused_at IS NOT NULL))
);

-- Prise des surveillances dues.
CREATE INDEX idx_market_watches_due ON market_watches (next_run_at, id) WHERE status = 'active';

CREATE TABLE external_source_usage (
    source_code TEXT NOT NULL REFERENCES external_sources(code) ON DELETE CASCADE,
    day DATE NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
    PRIMARY KEY (source_code, day)
);

CREATE TABLE market_watch_usage (
    watch_id UUID NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
    source_code TEXT NOT NULL REFERENCES external_sources(code) ON DELETE CASCADE,
    day DATE NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
    PRIMARY KEY (watch_id, source_code, day)
);

CREATE INDEX idx_external_source_usage_day ON external_source_usage (day);
CREATE INDEX idx_market_watch_usage_day ON market_watch_usage (day);

CREATE TABLE external_collect_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    watch_id UUID NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
    source_code TEXT NOT NULL REFERENCES external_sources(code) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    listing_count INTEGER NOT NULL DEFAULT 0 CHECK (listing_count >= 0),
    created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
    changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
    gone_count INTEGER NOT NULL DEFAULT 0 CHECK (gone_count >= 0),
    error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,60}$'),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    CONSTRAINT chk_external_collect_runs_error CHECK ((status = 'error') = (error_code IS NOT NULL))
);

CREATE INDEX idx_external_collect_runs_started ON external_collect_runs (started_at DESC, id DESC);
CREATE INDEX idx_external_collect_runs_errors ON external_collect_runs (started_at DESC, id DESC) WHERE status = 'error';

CREATE TABLE external_analyses (
    content_hash TEXT PRIMARY KEY CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    analysis JSONB NOT NULL CHECK (jsonb_typeof(analysis) = 'object'),
    analyzer_version TEXT NOT NULL CHECK (char_length(analyzer_version) BETWEEN 1 AND 40),
    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE duplicate_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE external_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_code TEXT NOT NULL REFERENCES external_sources(code) ON DELETE RESTRICT,
    external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
    canonical_url TEXT NOT NULL CHECK (char_length(canonical_url) BETWEEN 8 AND 1000 AND canonical_url ~ '^https?://'),
    title TEXT CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 200),
    price_amount BIGINT CHECK (price_amount IS NULL OR (price_amount >= 0 AND price_amount <= 9007199254740991)),
    price_currency TEXT CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
    location_text TEXT CHECK (location_text IS NULL OR char_length(btrim(location_text)) BETWEEN 1 AND 120),
    listed_at TIMESTAMPTZ,
    availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'gone', 'unknown')),
    availability_confirmed_at TIMESTAMPTZ,
    availability_origin TEXT CHECK (availability_origin IS NULL OR availability_origin IN ('source', 'absence')),
    content_hash TEXT NOT NULL REFERENCES external_analyses(content_hash) ON DELETE RESTRICT,
    duplicate_group_id UUID REFERENCES duplicate_groups(id) ON DELETE SET NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    last_checked_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_external_listings_source_external UNIQUE (source_code, external_id),
    CONSTRAINT uq_external_listings_canonical_url UNIQUE (source_code, canonical_url),
    CONSTRAINT chk_external_listings_price_pair CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
    CONSTRAINT chk_external_listings_confirmation CHECK ((availability_confirmed_at IS NULL) = (availability_origin IS NULL)),
    CONSTRAINT chk_external_listings_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX idx_external_listings_group ON external_listings (duplicate_group_id) WHERE duplicate_group_id IS NOT NULL;
CREATE INDEX idx_external_listings_available ON external_listings (last_seen_at) WHERE availability_status = 'available';
CREATE INDEX idx_external_listings_hash ON external_listings (content_hash);

CREATE TABLE source_observations (
    watch_id UUID NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES external_listings(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    missed_collects INTEGER NOT NULL DEFAULT 0 CHECK (missed_collects >= 0),
    PRIMARY KEY (watch_id, listing_id)
);

CREATE INDEX idx_source_observations_listing ON source_observations (listing_id);
