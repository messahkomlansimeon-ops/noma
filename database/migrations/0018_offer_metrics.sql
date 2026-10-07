-- Migration 0018 : mesures d'efficacité (lot M1)
-- Additive : ne modifie pas 0001 à 0017 (la table boost_exposures de 0013 reçoit seulement un index de purge). Aucun paiement, aucun crédit.
-- offer_views    : OUVERTURES de la fiche d'une annonce par l'acheteur, dans le contexte d'un de ses besoins (une ligne par annonce, besoin
--                  et jour UTC ; le compteur monte à chaque lecture réussie de la fiche). « Ouverture » = page SERVIE, pas lecture prouvée.
-- offer_contacts : CONTACTS (révélation du numéro vérifié du vendeur) par annonce et par besoin, première fois et nombre de révélations.
-- boost_id       : boost auquel l'ouverture ou le contact est attribué, seulement si le journal d'exposition (0013) montre que l'annonce a été
--                  servie SPONSORISÉE à ce besoin dans les 7 jours précédents ; NULL = organique.
-- viewer_id (propriétaire du besoin) ne doit JAMAIS sortir d'une lecture destinée au vendeur : seuls des comptages sont renvoyés.

CREATE TABLE offer_views (
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    viewed_day DATE NOT NULL,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    boost_id UUID REFERENCES offer_boosts(id) ON DELETE SET NULL,
    views INTEGER NOT NULL,
    boosted_views INTEGER NOT NULL,
    first_at TIMESTAMPTZ NOT NULL,
    last_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_offer_views PRIMARY KEY (offer_id, demand_id, viewed_day),
    CONSTRAINT chk_offer_views_views CHECK (views >= 1),
    CONSTRAINT chk_offer_views_boosted_views CHECK (boosted_views >= 0 AND boosted_views <= views),
    CONSTRAINT chk_offer_views_period CHECK (last_at >= first_at)
);

CREATE TABLE offer_contacts (
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    boost_id UUID REFERENCES offer_boosts(id) ON DELETE SET NULL,
    reveals INTEGER NOT NULL,
    first_contact_at TIMESTAMPTZ NOT NULL,
    last_contact_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_offer_contacts PRIMARY KEY (offer_id, demand_id),
    CONSTRAINT chk_offer_contacts_reveals CHECK (reveals >= 1),
    CONSTRAINT chk_offer_contacts_period CHECK (last_contact_at >= first_contact_at)
);

-- Lectures du vendeur (par annonce et par jour), attribution par boost, limite quotidienne de contacts de l'acheteur, purge de rétention.
CREATE INDEX idx_offer_views_offer_day ON offer_views (offer_id, viewed_day);
CREATE INDEX idx_offer_views_day ON offer_views (viewed_day);
CREATE INDEX idx_offer_views_boost ON offer_views (boost_id) WHERE boost_id IS NOT NULL;
CREATE INDEX idx_offer_contacts_offer_first ON offer_contacts (offer_id, first_contact_at);
CREATE INDEX idx_offer_contacts_viewer_first ON offer_contacts (viewer_id, first_contact_at);
CREATE INDEX idx_offer_contacts_last ON offer_contacts (last_contact_at);
CREATE INDEX idx_offer_contacts_boost ON offer_contacts (boost_id) WHERE boost_id IS NOT NULL;
CREATE INDEX idx_boost_exposures_served_day ON boost_exposures (served_day);
