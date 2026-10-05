-- Migration 0011 : réglages du boost et boosts d'offres (lot 2I1)
-- Additive : ne modifie pas 0001 à 0010. Aucun paiement : les boosts sont attribués par l'administration.
-- Un boost est EFFECTIF si status = 'active' AND starts_at <= now < ends_at (now = clock_timestamp() de la base).

-- Réglages modifiables depuis l'administration : 'default', ou une catégorie en minuscules (surcharge).
CREATE TABLE boost_settings (
    key TEXT PRIMARY KEY,
    slot_ratio NUMERIC(4,3) NOT NULL,
    min_slots INTEGER NOT NULL,
    max_slots INTEGER NOT NULL,
    max_active_per_seller INTEGER NOT NULL,
    max_seller_slot_share NUMERIC(4,3) NOT NULL,
    max_promoted_share NUMERIC(4,3) NOT NULL,
    min_relevance NUMERIC(5,2) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_boost_settings_key CHECK (key <> '' AND key = lower(btrim(key))),
    CONSTRAINT chk_boost_settings_slot_ratio CHECK (slot_ratio > 0 AND slot_ratio <= 0.5),
    CONSTRAINT chk_boost_settings_min_slots CHECK (min_slots >= 0),
    CONSTRAINT chk_boost_settings_max_slots CHECK (max_slots >= min_slots),
    CONSTRAINT chk_boost_settings_max_active_per_seller CHECK (max_active_per_seller >= 1),
    CONSTRAINT chk_boost_settings_max_seller_slot_share CHECK (max_seller_slot_share > 0 AND max_seller_slot_share <= 1),
    CONSTRAINT chk_boost_settings_max_promoted_share CHECK (max_promoted_share > 0 AND max_promoted_share <= 0.2),
    CONSTRAINT chk_boost_settings_min_relevance CHECK (min_relevance >= 0 AND min_relevance <= 100)
);

INSERT INTO boost_settings (
    key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance
) VALUES ('default', 0.150, 1, 50, 2, 0.340, 0.150, 60.00);

-- Boosts d'offres. Le périmètre (produit : catégorie, marque, modèle) est figé à l'attribution, déjà normalisé
-- (lower(btrim(...)), comme le marché de 2H1).
CREATE TABLE offer_boosts (
    id UUID PRIMARY KEY,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scope_category TEXT NOT NULL,
    scope_brand TEXT NOT NULL,
    scope_model TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_code TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT chk_offer_boosts_scope_normalized CHECK (
        scope_category <> '' AND scope_category = lower(btrim(scope_category))
        AND scope_brand <> '' AND scope_brand = lower(btrim(scope_brand))
        AND scope_model <> '' AND scope_model = lower(btrim(scope_model))
    ),
    CONSTRAINT chk_offer_boosts_status CHECK (status IN ('active', 'cancelled', 'expired')),
    CONSTRAINT chk_offer_boosts_duration_code CHECK (duration_code IN ('24h', '3d', '7d')),
    CONSTRAINT chk_offer_boosts_period CHECK (ends_at > starts_at),
    CONSTRAINT chk_offer_boosts_source CHECK (source IN ('admin_grant')),
    CONSTRAINT chk_offer_boosts_cancelled_at CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- Une offre n'a jamais deux boosts actifs.
CREATE UNIQUE INDEX uq_offer_boosts_active_offer
    ON offer_boosts (offer_id)
    WHERE status = 'active';

-- Places occupées d'un périmètre.
CREATE INDEX idx_offer_boosts_active_scope
    ON offer_boosts (scope_category, scope_brand, scope_model)
    WHERE status = 'active';

-- Plafond par vendeur.
CREATE INDEX idx_offer_boosts_active_seller
    ON offer_boosts (seller_id)
    WHERE status = 'active';
