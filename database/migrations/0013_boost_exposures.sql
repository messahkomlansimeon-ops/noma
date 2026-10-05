-- Migration 0013 : journal d'exposition des boosts (lot 2I4)
-- Additive : ne modifie pas 0001 à 0012. Aucun paiement, aucun crédit.
-- Une ligne = une APPARITION SERVIE d'une offre boostée dans une réponse de stored-matches (tri par pertinence, sens demande),
-- agrégée par boost, demande de l'acheteur et jour UTC. Ce n'est PAS une impression visible (aucun écran n'existe encore).
-- viewer_id (propriétaire de la demande) ne doit JAMAIS sortir d'une lecture destinée au vendeur.

CREATE TABLE boost_exposures (
    boost_id UUID NOT NULL REFERENCES offer_boosts(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    served_day DATE NOT NULL,
    first_served_at TIMESTAMPTZ NOT NULL,
    last_served_at TIMESTAMPTZ NOT NULL,
    servings INTEGER NOT NULL,
    sponsored_servings INTEGER NOT NULL,
    best_position INTEGER NOT NULL,
    best_gain INTEGER NOT NULL,
    CONSTRAINT pk_boost_exposures PRIMARY KEY (boost_id, demand_id, served_day),
    CONSTRAINT chk_boost_exposures_served_period CHECK (last_served_at >= first_served_at),
    CONSTRAINT chk_boost_exposures_servings CHECK (servings >= 1),
    CONSTRAINT chk_boost_exposures_sponsored_servings CHECK (sponsored_servings >= 0 AND sponsored_servings <= servings),
    CONSTRAINT chk_boost_exposures_best_position CHECK (best_position >= 0),
    CONSTRAINT chk_boost_exposures_best_gain CHECK (best_gain >= 0)
);

-- Lecture par offre et par jour (statistiques du vendeur).
CREATE INDEX idx_boost_exposures_offer_day
    ON boost_exposures (offer_id, served_day);
