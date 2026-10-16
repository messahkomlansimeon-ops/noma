-- Lot FIN3-C3 : propositions de vendeur et devis.
--
-- UN seul modèle pour la « proposition » et le « devis » : une offre faite par un vendeur, depuis une de ses annonces EN LIGNE, à un besoin d'acheteur qui y correspond encore. Le devis est
-- une proposition AVEC des lignes (libellé, montant) : son prix est la somme des lignes. L'acheteur l'accepte (une COMMANDE est créée, par le circuit existant, dans la même transaction) ou
-- la refuse ; le vendeur peut la retirer. Aucun contact n'est échangé : la proposition ne porte ni nom ni numéro (contrôlé par l'application).
-- Le prix est celui d'UNE unité (quantité 1 à l'acceptation), figé à l'envoi. L'expiration n'est pas balayée : « expirée » se lit à `valid_until <= maintenant`, et l'acceptation d'une
-- proposition échue est refusée par la base elle-même (déclencheur).

CREATE TABLE seller_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    price_amount BIGINT NOT NULL CHECK (price_amount BETWEEN 1 AND 100000000),
    price_currency TEXT NOT NULL DEFAULT 'XOF' CHECK (price_currency = 'XOF'),
    slot_text TEXT CHECK (slot_text IS NULL OR char_length(slot_text) BETWEEN 1 AND 120),
    warranty_text TEXT CHECK (warranty_text IS NULL OR char_length(warranty_text) BETWEEN 1 AND 120),
    note_text TEXT CHECK (note_text IS NULL OR char_length(note_text) BETWEEN 1 AND 300),
    valid_until TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn', 'expired')),
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    decided_at TIMESTAMPTZ,
    CONSTRAINT chk_seller_proposals_parties CHECK (seller_id <> buyer_id),
    CONSTRAINT chk_seller_proposals_validity CHECK (valid_until > created_at),
    CONSTRAINT chk_seller_proposals_decided CHECK ((status = 'sent') = (decided_at IS NULL)),
    CONSTRAINT chk_seller_proposals_order CHECK ((status = 'accepted') = (order_id IS NOT NULL))
);

CREATE TABLE seller_proposal_lines (
    proposal_id UUID NOT NULL REFERENCES seller_proposals(id) ON DELETE RESTRICT,
    position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 20),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
    amount_xof BIGINT NOT NULL CHECK (amount_xof BETWEEN 0 AND 100000000),
    PRIMARY KEY (proposal_id, position)
);

-- Une seule proposition ENVOYÉE par couple (annonce, besoin) : dernier garde-fou (l'application passe d'abord les échues à « expirée », sous verrou du couple).
CREATE UNIQUE INDEX uq_seller_proposals_sent ON seller_proposals (offer_id, demand_id) WHERE status = 'sent';
-- Après un refus de l'acheteur, la même annonce ne propose plus à ce besoin : dernier garde-fou de la règle anti-harcèlement.
CREATE UNIQUE INDEX uq_seller_proposals_declined ON seller_proposals (offer_id, demand_id) WHERE status = 'declined';
CREATE INDEX idx_seller_proposals_buyer ON seller_proposals (buyer_id, created_at DESC, id DESC);
CREATE INDEX idx_seller_proposals_seller ON seller_proposals (seller_id, created_at DESC, id DESC);
CREATE INDEX idx_seller_proposals_demand_sent ON seller_proposals (demand_id) WHERE status = 'sent';

-- Les deux parties sont le propriétaire du besoin (acheteur) et celui de l'annonce (vendeur) : même règle que les conversations et les commandes (migration 0020).
CREATE TRIGGER trg_seller_proposals_parties
    BEFORE INSERT ON seller_proposals
    FOR EACH ROW EXECUTE FUNCTION social_check_parties();

-- Seul l'état change, une fois, depuis « sent » : les éléments de la proposition (prix, textes, validité, parties) ne se modifient jamais, une proposition décidée ne bouge plus, aucune
-- suppression. « accepted » exige une proposition NON échue ; « expired » exige une proposition échue.
CREATE FUNCTION seller_proposals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'seller_proposals_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Une proposition ne se supprime pas.';
    END IF;
    IF OLD.status <> 'sent' THEN
        RAISE EXCEPTION 'seller_proposals_decided' USING ERRCODE = 'restrict_violation', DETAIL = 'Une proposition décidée ne se modifie plus.';
    END IF;
    IF NEW.id <> OLD.id OR NEW.demand_id <> OLD.demand_id OR NEW.offer_id <> OLD.offer_id OR NEW.seller_id <> OLD.seller_id OR NEW.buyer_id <> OLD.buyer_id
       OR NEW.price_amount <> OLD.price_amount OR NEW.price_currency <> OLD.price_currency OR NEW.slot_text IS DISTINCT FROM OLD.slot_text
       OR NEW.warranty_text IS DISTINCT FROM OLD.warranty_text OR NEW.note_text IS DISTINCT FROM OLD.note_text OR NEW.valid_until <> OLD.valid_until OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'seller_proposals_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Les éléments d''une proposition ne se modifient pas.';
    END IF;
    IF NEW.status = 'accepted' AND OLD.valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'seller_proposals_expired' USING ERRCODE = 'restrict_violation', DETAIL = 'Une proposition échue ne s''accepte pas.';
    END IF;
    IF NEW.status = 'expired' AND OLD.valid_until > clock_timestamp() THEN
        RAISE EXCEPTION 'seller_proposals_not_expired' USING ERRCODE = 'restrict_violation', DETAIL = 'Une proposition encore valable ne passe pas à « expirée ».';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_seller_proposals_guard
    BEFORE UPDATE OR DELETE ON seller_proposals
    FOR EACH ROW EXECUTE FUNCTION seller_proposals_guard();

-- Les lignes d'un devis sont écrites avec la proposition et ne changent plus.
CREATE FUNCTION seller_proposal_lines_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'seller_proposals_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Les lignes d''un devis ne se modifient pas.';
END
$$;

CREATE TRIGGER trg_seller_proposal_lines_immutable
    BEFORE UPDATE OR DELETE ON seller_proposal_lines
    FOR EACH ROW EXECUTE FUNCTION seller_proposal_lines_immutable();
