-- Migration 0020 : favoris, messagerie en direct, commandes (ventes déclarées) et administration (lot D2)
-- Additive : ne modifie ni 0001 à 0019 ni aucune ligne existante, sauf la colonne `users.is_admin` (FALSE partout) et les deux contraintes de `notifications`
-- (un troisième genre de notification, `new_message`, est ajouté). Jamais appliquée à noma_dev sans instruction explicite.
--
-- users.is_admin : rôle d'administration. Il ne s'attribue QUE par la commande `npm run admin:grant` (qui ouvre `SET LOCAL noma.admin_grant = 'on'` dans sa transaction) :
--   un UPDATE ou un INSERT qui fait passer is_admin à TRUE sans ce réglage est refusé par le déclencheur.
-- admin_actions : journal d'administration (qui, quoi, quand), non modifiable.
-- favorites : une annonce gardée de côté (unique par utilisateur et annonce), avec le besoin d'origine (lien vers la fiche).
-- conversations / messages : une conversation par couple (besoin, annonce) entre l'acheteur et le vendeur ; `messages.id` croît dans l'ordre de validation (la conversation
--   est verrouillée par l'écriture), ce qui permet le rattrapage « messages après l'id X ». L'insertion d'un message émet NOTIFY `noma_messages` (conversation et id du
--   message, JAMAIS le texte) ; l'état de lecture est tenu par participant.
-- orders : ventes déclarées. Une seule commande ACTIVE (proposée ou confirmée) par (besoin, annonce) ; les transitions sont contrôlées par un déclencheur.
-- notifications : genre `new_message` (une par conversation tant qu'elle n'est pas lue).

ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE FUNCTION users_guard_admin_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_admin AND (TG_OP = 'INSERT' OR NOT OLD.is_admin)
       AND current_setting('noma.admin_grant', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'admin_grant_forbidden' USING ERRCODE = 'restrict_violation',
            DETAIL = 'Le rôle admin ne s''attribue que par la commande admin:grant.';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_users_guard_admin_grant
    BEFORE INSERT OR UPDATE OF is_admin ON users
    FOR EACH ROW EXECUTE FUNCTION users_guard_admin_grant();

CREATE TABLE admin_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (source IN ('admin_ui', 'command')),
    action TEXT NOT NULL CHECK (action IN ('suspend_user', 'reactivate_user', 'grant_admin')),
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_admin_actions_actor CHECK (source <> 'admin_ui' OR admin_id IS NOT NULL)
);

CREATE INDEX idx_admin_actions_created ON admin_actions (created_at DESC, id DESC);

CREATE FUNCTION admin_actions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'admin_actions_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Le journal d''administration ne se modifie pas.';
END
$$;

CREATE TRIGGER trg_admin_actions_immutable
    BEFORE UPDATE OR DELETE ON admin_actions
    FOR EACH ROW EXECUTE FUNCTION admin_actions_immutable();

-- Les deux parties d'une conversation ou d'une commande sont le propriétaire du besoin (acheteur) et celui de l'annonce (vendeur).
CREATE FUNCTION social_check_parties() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM demands d JOIN offers o ON o.id = NEW.offer_id
         WHERE d.id = NEW.demand_id AND d.owner_id = NEW.buyer_id AND o.owner_id = NEW.seller_id
    ) THEN
        RAISE EXCEPTION 'social_parties_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TABLE favorites (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, offer_id)
);

CREATE INDEX idx_favorites_user_created ON favorites (user_id, created_at DESC, offer_id);

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_message_at TIMESTAMPTZ,
    buyer_last_read_id BIGINT NOT NULL DEFAULT 0 CHECK (buyer_last_read_id >= 0),
    seller_last_read_id BIGINT NOT NULL DEFAULT 0 CHECK (seller_last_read_id >= 0),
    CONSTRAINT uq_conversations_demand_offer UNIQUE (demand_id, offer_id),
    CONSTRAINT chk_conversations_parties CHECK (buyer_id <> seller_id)
);

CREATE TRIGGER trg_conversations_parties
    BEFORE INSERT ON conversations
    FOR EACH ROW EXECUTE FUNCTION social_check_parties();

CREATE INDEX idx_conversations_buyer ON conversations (buyer_id, last_message_at DESC NULLS LAST, id);
CREATE INDEX idx_conversations_seller ON conversations (seller_id, last_message_at DESC NULLS LAST, id);
CREATE INDEX idx_conversations_buyer_created ON conversations (buyer_id, created_at);

CREATE TABLE messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Texte seul : 1 à 1000 caractères, aucun caractère de contrôle, de direction de texte ni invisible.
    CONSTRAINT chk_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 1000 AND btrim(body) <> ''),
    CONSTRAINT chk_messages_body_safe CHECK (body !~ '[\u0001-\u001F\u007F-\u009F​-‏ -‮⁦-⁩﻿]')
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, id);
CREATE INDEX idx_messages_sender_created ON messages (sender_id, created_at);

-- Un message n'est jamais modifié (la suppression en cascade d'une conversation reste possible).
CREATE FUNCTION messages_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'messages_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Un message ne se modifie pas.';
END
$$;

CREATE TRIGGER trg_messages_immutable
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_immutable();

-- NOTIFY transactionnel : livré à la validation de la transaction qui écrit le message. La charge ne contient QUE la conversation et l'id du message.
CREATE FUNCTION messages_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('noma_messages', json_build_object('c', NEW.conversation_id, 'm', NEW.id)::text);
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_messages_notify
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_notify();

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    price_amount BIGINT NOT NULL CHECK (price_amount BETWEEN 1 AND 100000000),
    price_currency TEXT NOT NULL DEFAULT 'XOF' CHECK (price_currency = 'XOF'),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'declined', 'cancelled')),
    -- Attribution au boost, figée à la déclaration (même règle que les contacts : annonce servie sponsorisée à ce besoin dans les 7 jours précédents).
    boost_id UUID REFERENCES offer_boosts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    decided_at TIMESTAMPTZ,
    CONSTRAINT chk_orders_parties CHECK (buyer_id <> seller_id),
    CONSTRAINT chk_orders_decided CHECK ((status = 'proposed') = (decided_at IS NULL))
);

-- Une seule commande ACTIVE (proposée ou confirmée) par couple (besoin, annonce).
CREATE UNIQUE INDEX uq_orders_active ON orders (demand_id, offer_id) WHERE status IN ('proposed', 'confirmed');
CREATE INDEX idx_orders_buyer ON orders (buyer_id, created_at DESC, id);
CREATE INDEX idx_orders_seller ON orders (seller_id, created_at DESC, id);
CREATE INDEX idx_orders_offer_confirmed ON orders (offer_id) WHERE status = 'confirmed';

CREATE TRIGGER trg_orders_parties
    BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION social_check_parties();

-- Transitions : seule « proposée » évolue (vers confirmée, refusée ou annulée) ; les trois autres états sont définitifs ; rien d'autre que statut, décision et date ne change.
CREATE FUNCTION orders_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.demand_id <> OLD.demand_id OR NEW.offer_id <> OLD.offer_id OR NEW.buyer_id <> OLD.buyer_id OR NEW.seller_id <> OLD.seller_id
       OR NEW.price_amount <> OLD.price_amount OR NEW.price_currency <> OLD.price_currency OR NEW.boost_id IS DISTINCT FROM OLD.boost_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'order_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'proposed' THEN
        RAISE EXCEPTION 'order_final' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status NOT IN ('proposed', 'confirmed', 'declined', 'cancelled') THEN
        RAISE EXCEPTION 'order_transition_forbidden' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_orders_transition
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_enforce_transition();

-- Notification « nouveau message » : une par conversation et par destinataire tant qu'elle n'est pas lue.
ALTER TABLE notifications ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT chk_notifications_shape;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('new_match', 'new_matches_digest', 'new_message'));
ALTER TABLE notifications ADD CONSTRAINT chk_notifications_shape CHECK (
    (kind = 'new_match' AND offer_id IS NOT NULL AND conversation_id IS NULL AND digest_day IS NULL AND item_count IS NULL
        AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    (kind = 'new_matches_digest' AND offer_id IS NULL AND conversation_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
        AND title IS NULL AND price_amount IS NULL AND price_currency IS NULL)
    OR
    (kind = 'new_message' AND offer_id IS NOT NULL AND conversation_id IS NOT NULL AND digest_day IS NULL AND item_count IS NULL
        AND price_amount IS NULL AND price_currency IS NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
);
CREATE UNIQUE INDEX uq_notifications_new_message_unread ON notifications (user_id, conversation_id) WHERE kind = 'new_message' AND read_at IS NULL;
