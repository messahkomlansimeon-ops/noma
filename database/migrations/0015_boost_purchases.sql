-- Migration 0015 : achat atomique d'un boost avec les crédits du portefeuille (lot P1b)
-- Additive : ne modifie pas 0001 à 0014 (elle remplace seulement trois contraintes CHECK NOMMÉES par des versions élargies : DROP puis
-- ADD, dans cette migration). Monnaie : XOF, entiers BIGINT. Aucun flottant. Aucun prestataire réel.
--
-- Un achat est UNE transaction SQL qui : vérifie la cotation, les places et le plafond vendeur, débite le compte du vendeur
-- (transaction `boost_purchase` du grand livre : utilisateur −montant, boost_revenue +montant), crée le boost (source `purchase`) et
-- la ligne `boost_purchases`. Le remboursement (administration seulement) est une transaction `boost_refund` du MONTANT INTÉGRAL
-- (boost_revenue −montant, utilisateur +montant) ; le prorata n'existe pas.
--
-- Garanties portées par la base (en plus du code, qui les contrôle aussi) :
--   * un devis ne s'achète qu'une fois (quote_id UNIQUE), un boost, une transaction et un remboursement ne servent qu'un achat ;
--   * (vendeur, clé d'idempotence) UNIQUE ;
--   * une ligne boost_purchases n'existe que si la cotation, le boost et les écritures du grand livre lui correspondent
--     (déclencheur de garde à l'insertion) ; elle est ensuite immuable, sauf le passage UNIQUE refunded_at NULL → date, avec la
--     transaction de remboursement correspondante ; jamais de suppression ;
--   * la FENÊTRE d'un boost acheté est exacte : à l'insertion, `ends_at − starts_at` vaut la durée exacte de l'achat (24 h, 3 j, 7 j) et
--     `starts_at` précède l'achat de 60 s au plus (même transaction : l'écart réel est de quelques millisecondes) ; ensuite
--     `trg_offer_boosts_purchase_window` interdit toute modification de starts_at, ends_at, duration_code, offer_id, seller_id et source
--     d'un boost `purchase` (seuls le statut et cancelled_at changent : expiration, annulation, remboursement) ;
--   * cohérence au COMMIT (déclencheurs différés) : un boost `purchase`, une transaction `boost_purchase` ou `boost_refund` n'existent
--     jamais sans leur achat.
-- TRUNCATE n'est pas bloqué (comme pour le grand livre, voir 0014).

-- ───────────── 1. Source d'un boost ─────────────

ALTER TABLE offer_boosts DROP CONSTRAINT chk_offer_boosts_source;
ALTER TABLE offer_boosts ADD CONSTRAINT chk_offer_boosts_source CHECK (source IN ('admin_grant', 'purchase'));

-- ───────────── 2. Types de transaction et métadonnées du grand livre ─────────────

ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_kind;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_kind
    CHECK (kind IN ('topup', 'adjustment', 'boost_purchase', 'boost_refund'));

-- Mêmes règles qu'en 0014, avec deux clés de plus : boostPurchaseId et quoteId (UUID). Aucune donnée personnelle possible.
ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_metadata;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 512
    AND (metadata - ARRAY['paymentIntentId', 'provider', 'reasonCode', 'boostPurchaseId', 'quoteId']) = '{}'::jsonb
    AND (NOT (metadata ? 'paymentIntentId') OR (
        jsonb_typeof(metadata -> 'paymentIntentId') = 'string'
        AND (metadata ->> 'paymentIntentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    AND (NOT (metadata ? 'provider') OR (
        jsonb_typeof(metadata -> 'provider') = 'string' AND (metadata ->> 'provider') ~ '^[a-z_]{1,20}$'))
    AND (NOT (metadata ? 'reasonCode') OR (
        jsonb_typeof(metadata -> 'reasonCode') = 'string' AND (metadata ->> 'reasonCode') ~ '^[a-z_]{1,40}$'))
    AND (NOT (metadata ? 'boostPurchaseId') OR (
        jsonb_typeof(metadata -> 'boostPurchaseId') = 'string'
        AND (metadata ->> 'boostPurchaseId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    AND (NOT (metadata ? 'quoteId') OR (
        jsonb_typeof(metadata -> 'quoteId') = 'string'
        AND (metadata ->> 'quoteId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);

-- Forme exacte des métadonnées d'un achat (boostPurchaseId + quoteId) et d'un remboursement (boostPurchaseId + reasonCode), dont la
-- référence dérive de l'achat : « boost_purchase:<achat> » (une seule écriture d'achat par achat) et « boost_refund:<achat> » (UNIQUE
-- de la référence : un seul remboursement par achat). Les autres types ne portent aucune de ces clés.
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_boost CHECK (
    (kind = 'boost_purchase'
        AND (metadata - ARRAY['boostPurchaseId', 'quoteId']) = '{}'::jsonb
        AND metadata ? 'boostPurchaseId' AND metadata ? 'quoteId'
        AND reference = 'boost_purchase:' || (metadata ->> 'boostPurchaseId'))
    OR (kind = 'boost_refund'
        AND (metadata - ARRAY['boostPurchaseId', 'reasonCode']) = '{}'::jsonb
        AND metadata ? 'boostPurchaseId' AND metadata ? 'reasonCode'
        AND reference = 'boost_refund:' || (metadata ->> 'boostPurchaseId'))
    OR (kind NOT IN ('boost_purchase', 'boost_refund') AND NOT (metadata ?| ARRAY['boostPurchaseId', 'quoteId']))
);

-- ───────────── 3. Achats de boost ─────────────

CREATE TABLE boost_purchases (
    id UUID PRIMARY KEY,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
    quote_id UUID NOT NULL REFERENCES boost_quotes(id) ON DELETE RESTRICT,
    boost_id UUID NOT NULL REFERENCES offer_boosts(id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    amount_xof BIGINT NOT NULL,
    duration_code TEXT NOT NULL,
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    refunded_at TIMESTAMPTZ,
    refund_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_boost_purchases_quote UNIQUE (quote_id),
    CONSTRAINT uq_boost_purchases_boost UNIQUE (boost_id),
    CONSTRAINT uq_boost_purchases_transaction UNIQUE (transaction_id),
    CONSTRAINT uq_boost_purchases_refund_transaction UNIQUE (refund_transaction_id),
    CONSTRAINT uq_boost_purchases_seller_idempotency UNIQUE (seller_id, idempotency_key),
    CONSTRAINT chk_boost_purchases_amount CHECK (amount_xof > 0 AND amount_xof <= 9007199254740991),
    CONSTRAINT chk_boost_purchases_duration_code CHECK (duration_code IN ('24h', '3d', '7d')),
    -- Remboursé ssi la date ET la transaction de remboursement sont renseignées.
    CONSTRAINT chk_boost_purchases_refund CHECK ((refunded_at IS NULL) = (refund_transaction_id IS NULL)),
    CONSTRAINT chk_boost_purchases_refund_order CHECK (refunded_at IS NULL OR refunded_at >= created_at)
);

-- Historique des achats d'une offre (plus récents d'abord).
CREATE INDEX idx_boost_purchases_offer ON boost_purchases (offer_id, created_at DESC);

-- Les écritures d'une transaction d'achat ou de remboursement : exactement deux, le compte de l'acheteur d'un côté, boost_revenue de
-- l'autre. `p_user_sign` vaut −1 pour un achat (le vendeur est débité), +1 pour un remboursement (le vendeur est crédité).
CREATE FUNCTION boost_purchase_ledger_matches(
    p_transaction UUID, p_kind TEXT, p_purchase UUID, p_seller UUID, p_amount BIGINT, p_user_sign INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM wallet_transactions t
                    WHERE t.id = p_transaction AND t.kind = p_kind AND t.reference = p_kind || ':' || p_purchase::text)
       AND (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = p_transaction) = 2
       AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                    WHERE e.transaction_id = p_transaction AND a.kind = 'user' AND a.owner_id = p_seller
                      AND e.amount = p_user_sign * p_amount)
       AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                    WHERE e.transaction_id = p_transaction AND a.kind = 'boost_revenue'
                      AND e.amount = -p_user_sign * p_amount);
END
$$;

-- Garde de boost_purchases.
--  * INSERT : créé non remboursé ; la cotation existe, est disponible et correspond (offre, vendeur, durée, MONTANT) ; le boost
--    existe, vient d'un achat et correspond (offre, vendeur, durée) ; la transaction du grand livre est l'achat de CE montant
--    (deux écritures : vendeur −montant, boost_revenue +montant).
--  * UPDATE : seul le passage unique refunded_at NULL → date avec refund_transaction_id est permis, et la transaction de
--    remboursement doit être celle du montant intégral (boost_revenue −montant, vendeur +montant). Tout autre champ est figé.
--  * DELETE : interdit.
CREATE FUNCTION boost_purchases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    quote_row RECORD;
    boost_row RECORD;
    window_seconds INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'boost_purchase_immutable' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'DELETE interdit sur boost_purchases';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.refunded_at IS NOT NULL OR NEW.refund_transaction_id IS NOT NULL THEN
            RAISE EXCEPTION 'boost_purchase_initial_state' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        SELECT status, amount, duration_code, offer_id, seller_id INTO quote_row FROM boost_quotes WHERE id = NEW.quote_id;
        IF NOT FOUND OR quote_row.status <> 'available' OR quote_row.amount <> NEW.amount_xof
           OR quote_row.duration_code <> NEW.duration_code OR quote_row.offer_id <> NEW.offer_id OR quote_row.seller_id <> NEW.seller_id THEN
            RAISE EXCEPTION 'boost_purchase_quote_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        SELECT source, offer_id, seller_id, duration_code, starts_at, ends_at INTO boost_row FROM offer_boosts WHERE id = NEW.boost_id;
        IF NOT FOUND OR boost_row.source <> 'purchase' OR boost_row.offer_id <> NEW.offer_id
           OR boost_row.seller_id <> NEW.seller_id OR boost_row.duration_code <> NEW.duration_code THEN
            RAISE EXCEPTION 'boost_purchase_boost_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        -- Fenêtre exacte : durée du code, et début à l'instant de l'achat (tolérance de 60 s, comme wallet:check).
        window_seconds := CASE NEW.duration_code WHEN '24h' THEN 86400 WHEN '3d' THEN 259200 WHEN '7d' THEN 604800 END;
        IF extract(epoch FROM boost_row.ends_at - boost_row.starts_at) <> window_seconds
           OR boost_row.starts_at > NEW.created_at OR NEW.created_at - boost_row.starts_at > interval '60 seconds' THEN
            RAISE EXCEPTION 'boost_purchase_window_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        IF NOT boost_purchase_ledger_matches(NEW.transaction_id, 'boost_purchase', NEW.id, NEW.seller_id, NEW.amount_xof, -1) THEN
            RAISE EXCEPTION 'boost_purchase_ledger_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.offer_id <> OLD.offer_id OR NEW.quote_id <> OLD.quote_id
       OR NEW.boost_id <> OLD.boost_id OR NEW.transaction_id <> OLD.transaction_id OR NEW.amount_xof <> OLD.amount_xof
       OR NEW.duration_code <> OLD.duration_code OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'boost_purchase_immutable' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'champ immuable d''un achat de boost';
    END IF;
    IF NOT (OLD.refunded_at IS NULL AND OLD.refund_transaction_id IS NULL
            AND NEW.refunded_at IS NOT NULL AND NEW.refund_transaction_id IS NOT NULL) THEN
        RAISE EXCEPTION 'boost_purchase_refund_transition' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_boost_purchases_guard';
    END IF;
    IF NOT boost_purchase_ledger_matches(NEW.refund_transaction_id, 'boost_refund', NEW.id, NEW.seller_id, NEW.amount_xof, 1) THEN
        RAISE EXCEPTION 'boost_purchase_refund_ledger_mismatch' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_boost_purchases_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_boost_purchases_guard
    BEFORE INSERT OR UPDATE OR DELETE ON boost_purchases
    FOR EACH ROW EXECUTE FUNCTION boost_purchases_guard();

-- Fenêtre d'un boost ACHETÉ : figée. Le paiement a couvert exactement [starts_at, ends_at) pour une durée, une offre et un vendeur : modifier
-- l'un de ces champs (ou la source) rendrait la contrepartie fausse sans que le grand livre le sache. Les passages de statut (expiration par le
-- worker, annulation, remboursement) ne changent aucun de ces champs et restent permis. Se déclenche aussi quand la source DEVIENT `purchase`.
CREATE FUNCTION offer_boosts_guard_purchase_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
       OR NEW.duration_code IS DISTINCT FROM OLD.duration_code OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.source IS DISTINCT FROM OLD.source THEN
        RAISE EXCEPTION 'boost_purchase_boost_immutable' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'fenêtre, durée, offre, vendeur et source d''un boost acheté sont figés';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_offer_boosts_purchase_window
    BEFORE UPDATE ON offer_boosts
    FOR EACH ROW
    WHEN (OLD.source = 'purchase' OR NEW.source = 'purchase')
    EXECUTE FUNCTION offer_boosts_guard_purchase_window();

-- Cohérence au COMMIT : un boost d'achat, une transaction d'achat et une transaction de remboursement n'existent jamais sans leur
-- achat (contraintes différées : l'achat s'insère après le débit et le boost, dans la même transaction SQL).
CREATE FUNCTION boost_purchases_assert_linked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'offer_boosts' THEN
        IF NEW.source = 'purchase' AND NOT EXISTS (SELECT 1 FROM boost_purchases p WHERE p.boost_id = NEW.id) THEN
            RAISE EXCEPTION 'boost_purchase_boost_unlinked' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_linked';
        END IF;
    ELSIF NEW.kind = 'boost_purchase' THEN
        IF NOT EXISTS (SELECT 1 FROM boost_purchases p WHERE p.transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'boost_purchase_transaction_unlinked' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_linked';
        END IF;
    ELSIF NEW.kind = 'boost_refund' THEN
        IF NOT EXISTS (SELECT 1 FROM boost_purchases p WHERE p.refund_transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'boost_refund_transaction_unlinked' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_linked';
        END IF;
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER trg_offer_boosts_purchase_linked
    AFTER INSERT ON offer_boosts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION boost_purchases_assert_linked();
CREATE CONSTRAINT TRIGGER trg_wallet_transactions_boost_linked
    AFTER INSERT ON wallet_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION boost_purchases_assert_linked();
