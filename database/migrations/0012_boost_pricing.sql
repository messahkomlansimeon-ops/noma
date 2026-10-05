-- Migration 0012 : prix dynamique du boost et cotations vendeur (lot 2I2)
-- Additive : ne modifie pas 0001 à 0011. AUCUN paiement, crédit ni achat : une cotation est un prix daté et conservé
-- pendant sa courte validité (brief SCOUTR §18 ; AUDIT-EVOLUTION-SCOUTR.md §6 « Cotation et achat »).

-- Configuration tarifaire VERSIONNÉE. Une modification = une NOUVELLE version (jamais d'UPDATE dans le code) ; la version la
-- plus élevée d'une clé est la version courante. Clé : 'default', ou une catégorie en minuscules (surcharge entière).
CREATE TABLE boost_pricing_settings (
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    currency TEXT NOT NULL,
    base_amount INTEGER NOT NULL,
    grid_amount INTEGER NOT NULL,
    min_amount INTEGER NOT NULL,
    max_amount INTEGER NOT NULL,
    competition_step_milli INTEGER NOT NULL,
    competition_max_milli INTEGER NOT NULL,
    demand_step_milli INTEGER NOT NULL,
    demand_max_milli INTEGER NOT NULL,
    scarcity_max_milli INTEGER NOT NULL,
    duration_24h_milli INTEGER NOT NULL,
    duration_3d_milli INTEGER NOT NULL,
    duration_7d_milli INTEGER NOT NULL,
    quote_validity_seconds INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, version),
    CONSTRAINT chk_boost_pricing_settings_key CHECK (key <> '' AND key = lower(btrim(key))),
    CONSTRAINT chk_boost_pricing_settings_version CHECK (version > 0),
    CONSTRAINT chk_boost_pricing_settings_currency CHECK (currency = 'XOF'),
    CONSTRAINT chk_boost_pricing_settings_base CHECK (base_amount BETWEEN 1 AND 10000000),
    CONSTRAINT chk_boost_pricing_settings_grid CHECK (grid_amount > 0),
    CONSTRAINT chk_boost_pricing_settings_min CHECK (min_amount > 0),
    CONSTRAINT chk_boost_pricing_settings_max CHECK (max_amount >= min_amount),
    -- Min et max sont des multiples de la grille : un montant arrondi sur la grille puis borné reste sur la grille.
    CONSTRAINT chk_boost_pricing_settings_grid_multiples CHECK (min_amount % grid_amount = 0 AND max_amount % grid_amount = 0),
    CONSTRAINT chk_boost_pricing_settings_competition_step CHECK (competition_step_milli BETWEEN 0 AND 1000),
    CONSTRAINT chk_boost_pricing_settings_competition_max CHECK (competition_max_milli BETWEEN 1000 AND 5000),
    CONSTRAINT chk_boost_pricing_settings_demand_step CHECK (demand_step_milli BETWEEN 0 AND 1000),
    CONSTRAINT chk_boost_pricing_settings_demand_max CHECK (demand_max_milli BETWEEN 1000 AND 5000),
    CONSTRAINT chk_boost_pricing_settings_scarcity_max CHECK (scarcity_max_milli BETWEEN 1000 AND 5000),
    CONSTRAINT chk_boost_pricing_settings_duration_24h CHECK (duration_24h_milli BETWEEN 1000 AND 20000),
    CONSTRAINT chk_boost_pricing_settings_duration_3d CHECK (duration_3d_milli BETWEEN 1000 AND 20000),
    CONSTRAINT chk_boost_pricing_settings_duration_7d CHECK (duration_7d_milli BETWEEN 1000 AND 20000),
    CONSTRAINT chk_boost_pricing_settings_duration_order CHECK (duration_24h_milli <= duration_3d_milli AND duration_3d_milli <= duration_7d_milli),
    CONSTRAINT chk_boost_pricing_settings_validity CHECK (quote_validity_seconds BETWEEN 60 AND 3600)
);

-- Valeurs PROVISOIRES, à calibrer sur des usages réels (voir BOOST-PRICING.md).
INSERT INTO boost_pricing_settings (
    key, version, currency, base_amount, grid_amount, min_amount, max_amount,
    competition_step_milli, competition_max_milli, demand_step_milli, demand_max_milli, scarcity_max_milli,
    duration_24h_milli, duration_3d_milli, duration_7d_milli, quote_validity_seconds
) VALUES ('default', 1, 'XOF', 500, 100, 500, 50000, 20, 1500, 100, 3000, 2000, 1000, 2500, 5000, 900);

-- Cotations. IMMUABLES : aucune fonction du code ne les modifie ; une nouvelle cotation est une nouvelle ligne.
CREATE TABLE boost_quotes (
    id UUID PRIMARY KEY,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scope_category TEXT NOT NULL,
    scope_brand TEXT NOT NULL,
    scope_model TEXT NOT NULL,
    duration_code TEXT NOT NULL,
    pricing_key TEXT NOT NULL,
    pricing_version INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    unavailable_reason TEXT,
    amount INTEGER,
    raw_amount NUMERIC(30,12),
    competition_milli INTEGER,
    demand_milli INTEGER,
    scarcity_milli INTEGER,
    duration_milli INTEGER,
    competing_sellers INTEGER NOT NULL,
    compatible_buyers INTEGER NOT NULL,
    slots_total INTEGER NOT NULL,
    slots_used INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_boost_quotes_pricing FOREIGN KEY (pricing_key, pricing_version) REFERENCES boost_pricing_settings (key, version),
    CONSTRAINT chk_boost_quotes_scope_normalized CHECK (
        scope_category <> '' AND scope_category = lower(btrim(scope_category))
        AND scope_brand <> '' AND scope_brand = lower(btrim(scope_brand))
        AND scope_model <> '' AND scope_model = lower(btrim(scope_model))
    ),
    CONSTRAINT chk_boost_quotes_duration_code CHECK (duration_code IN ('24h', '3d', '7d')),
    CONSTRAINT chk_boost_quotes_currency CHECK (currency = 'XOF'),
    CONSTRAINT chk_boost_quotes_status CHECK (status IN ('available', 'unavailable')),
    CONSTRAINT chk_boost_quotes_reason CHECK (unavailable_reason IS NULL OR unavailable_reason IN (
        'offer_already_boosted', 'no_slot_available', 'seller_boost_limit_reached', 'no_compatible_buyer'
    )),
    CONSTRAINT chk_boost_quotes_amount CHECK (amount IS NULL OR amount > 0),
    CONSTRAINT chk_boost_quotes_counts CHECK (
        competing_sellers >= 0 AND compatible_buyers >= 0 AND slots_total >= 0 AND slots_used >= 0
    ),
    -- Disponible : prix, prix brut et les quatre facteurs, sans motif. Indisponible : aucun prix, aucun facteur, un motif.
    CONSTRAINT chk_boost_quotes_availability CHECK (
        (status = 'available'
            AND amount IS NOT NULL AND raw_amount IS NOT NULL
            AND competition_milli IS NOT NULL AND demand_milli IS NOT NULL
            AND scarcity_milli IS NOT NULL AND duration_milli IS NOT NULL
            AND unavailable_reason IS NULL)
        OR
        (status = 'unavailable'
            AND amount IS NULL AND raw_amount IS NULL
            AND competition_milli IS NULL AND demand_milli IS NULL
            AND scarcity_milli IS NULL AND duration_milli IS NULL
            AND unavailable_reason IS NOT NULL)
    ),
    CONSTRAINT chk_boost_quotes_validity CHECK (expires_at > computed_at)
);

-- Réutilisation d'une cotation encore valable.
CREATE INDEX idx_boost_quotes_offer_duration
    ON boost_quotes (offer_id, duration_code, expires_at DESC);

-- Historique des prix d'un périmètre (cotations disponibles seulement).
CREATE INDEX idx_boost_quotes_scope_history
    ON boost_quotes (scope_category, scope_brand, scope_model, computed_at DESC)
    WHERE status = 'available';
