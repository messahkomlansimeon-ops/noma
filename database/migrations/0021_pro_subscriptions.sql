-- Migration 0021 : offre Pro (lot PRO1) : plans versionnés, abonnements payés avec les crédits du portefeuille, crédits promotionnels séparés, import de catalogue
-- Additive : ne modifie pas 0001 à 0021. Elle remplace seulement des contraintes CHECK NOMMÉES (comptes, types de transaction, métadonnées du grand livre : DROP puis ADD,
-- dans cette migration), l'index des comptes système, et les deux fonctions de garde des achats de boost (CREATE OR REPLACE : un achat peut maintenant être payé en partie
-- ou en totalité par des crédits promotionnels). Monnaie : XOF, entiers BIGINT, aucun flottant. Aucun prestataire réel. Jamais appliquée à noma_dev sans sauvegarde ni instruction.
--
-- PRIX PROVISOIRES : les prix, les crédits promotionnels et les limites des deux plans de départ (Gratuit, Pro) sont des valeurs de départ en attente d'une décision
-- du fondateur. Ils ne se modifient pas : une nouvelle VERSION du plan (créée par l'administration) les remplace pour les nouveaux abonnements et les renouvellements.
--
-- Grand livre (partie double, immuable, voir 0014) :
--   * `user_promo` : sous-compte PROMOTIONNEL de chaque utilisateur, distinct de son compte de crédits payés (`user`). Jamais négatif. Aucune recharge, aucun ajustement,
--     aucun remboursement en espèces n'y touche (déclencheur wallet_guard_account_usage) : non remboursable, non retirable.
--   * comptes système `subscription_revenue` (revenus d'abonnement), `promo_issuance` (crédits promotionnels émis : devient négatif à chaque émission),
--     `promo_consumed` (crédits promotionnels dépensés sur des boosts), `promo_expired` (crédits promotionnels expirés ou perdus).
--   * types de transaction : `subscription_charge` (débit des crédits payés ET émission des crédits promotionnels de la période, UNE transaction), `subscription_refund`
--     (remboursement intégral d'une période par l'administration), `promo_expiry` (expiration des crédits promotionnels restants d'une émission : ÉCRITE au grand livre,
--     jamais un effacement). `boost_purchase` et `boost_refund` peuvent maintenant porter des écritures promotionnelles.
--
-- Un achat de boost : les crédits promotionnels sont dépensés EN PREMIER, les crédits payés complètent. Le chemin d'achat (places, plafond vendeur, portée) est le MÊME.

-- ───────────── 1. Comptes du grand livre ─────────────

ALTER TABLE wallet_accounts DROP CONSTRAINT chk_wallet_accounts_kind;
ALTER TABLE wallet_accounts ADD CONSTRAINT chk_wallet_accounts_kind CHECK (kind IN
    ('user', 'user_promo', 'provider_clearing', 'boost_revenue', 'subscription_revenue', 'promo_issuance', 'promo_consumed', 'promo_expired'));
ALTER TABLE wallet_accounts DROP CONSTRAINT chk_wallet_accounts_owner;
ALTER TABLE wallet_accounts ADD CONSTRAINT chk_wallet_accounts_owner CHECK ((kind IN ('user', 'user_promo')) = (owner_id IS NOT NULL));
-- Même nom qu'en 0014 : le code traduit ce refus en `insufficient_balance`. Un solde promotionnel n'est jamais négatif non plus.
ALTER TABLE wallet_accounts DROP CONSTRAINT chk_wallet_accounts_user_balance_non_negative;
ALTER TABLE wallet_accounts ADD CONSTRAINT chk_wallet_accounts_user_balance_non_negative CHECK (kind NOT IN ('user', 'user_promo') OR balance >= 0);

DROP INDEX uq_wallet_accounts_system_kind;
CREATE UNIQUE INDEX uq_wallet_accounts_system_kind ON wallet_accounts (kind) WHERE kind NOT IN ('user', 'user_promo');
CREATE UNIQUE INDEX uq_wallet_accounts_promo_owner ON wallet_accounts (owner_id) WHERE kind = 'user_promo';

INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES
    (gen_random_uuid(), 'subscription_revenue', NULL, 0),
    (gen_random_uuid(), 'promo_issuance', NULL, 0),
    (gen_random_uuid(), 'promo_consumed', NULL, 0),
    (gen_random_uuid(), 'promo_expired', NULL, 0);

-- ───────────── 2. Types de transaction et métadonnées ─────────────

ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_kind;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_kind
    CHECK (kind IN ('topup', 'adjustment', 'boost_purchase', 'boost_refund', 'subscription_charge', 'subscription_refund', 'promo_expiry'));

-- Deux clés de plus : subscriptionPeriodId et promoGrantId (UUID). Aucune donnée personnelle possible.
ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_metadata;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 512
    AND (metadata - ARRAY['paymentIntentId', 'provider', 'reasonCode', 'boostPurchaseId', 'quoteId', 'subscriptionPeriodId', 'promoGrantId']) = '{}'::jsonb
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
    AND (NOT (metadata ? 'subscriptionPeriodId') OR (
        jsonb_typeof(metadata -> 'subscriptionPeriodId') = 'string'
        AND (metadata ->> 'subscriptionPeriodId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    AND (NOT (metadata ? 'promoGrantId') OR (
        jsonb_typeof(metadata -> 'promoGrantId') = 'string'
        AND (metadata ->> 'promoGrantId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);

-- Forme EXACTE des métadonnées des trois nouveaux types ; la référence dérive de la période (un seul débit et un seul remboursement par période : UNIQUE de la référence)
-- ou de l'émission promotionnelle (une seule expiration par émission). Les autres types ne portent aucune de ces clés.
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_pro CHECK (
    (kind = 'subscription_charge'
        AND (metadata - ARRAY['subscriptionPeriodId']) = '{}'::jsonb
        AND metadata ? 'subscriptionPeriodId'
        AND reference = 'subscription_charge:' || (metadata ->> 'subscriptionPeriodId'))
    OR (kind = 'subscription_refund'
        AND (metadata - ARRAY['subscriptionPeriodId', 'reasonCode']) = '{}'::jsonb
        AND metadata ? 'subscriptionPeriodId' AND metadata ? 'reasonCode'
        AND reference = 'subscription_refund:' || (metadata ->> 'subscriptionPeriodId'))
    OR (kind = 'promo_expiry'
        AND (metadata - ARRAY['promoGrantId']) = '{}'::jsonb
        AND metadata ? 'promoGrantId'
        AND reference = 'promo_expiry:' || (metadata ->> 'promoGrantId'))
    OR (kind NOT IN ('subscription_charge', 'subscription_refund', 'promo_expiry') AND NOT (metadata ?| ARRAY['subscriptionPeriodId', 'promoGrantId']))
);

-- Qui peut toucher quel compte, et dans quel sens : un crédit promotionnel ne se recharge pas, ne s'ajuste pas, ne se retire pas, ne se rembourse pas en espèces.
--   user_promo       : crédité par l'émission d'une période (subscription_charge) et par la restitution d'un boost remboursé (boost_refund) ;
--                      débité par un achat de boost, une expiration, le remboursement d'une période (reste inutilisé annulé) ;
--   promo_issuance   : débité par chaque émission ; promo_consumed : crédité par un achat de boost, débité par son remboursement ;
--   promo_expired    : crédité par une expiration, un remboursement de période (reste annulé) ou un remboursement de boost dont l'émission est échue ;
--   subscription_revenue : crédité par un débit de période, débité par son remboursement.
CREATE FUNCTION wallet_guard_account_usage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    account_kind TEXT;
    transaction_kind TEXT;
    allowed BOOLEAN;
BEGIN
    SELECT kind INTO account_kind FROM wallet_accounts WHERE id = NEW.account_id;
    IF account_kind IS NULL OR account_kind NOT IN ('user_promo', 'promo_issuance', 'promo_consumed', 'promo_expired', 'subscription_revenue') THEN
        RETURN NEW;
    END IF;
    SELECT kind INTO transaction_kind FROM wallet_transactions WHERE id = NEW.transaction_id;
    IF transaction_kind IS NULL THEN
        RETURN NEW;
    END IF;
    allowed := CASE account_kind
        WHEN 'user_promo' THEN
            (transaction_kind IN ('subscription_charge', 'boost_refund') AND NEW.amount > 0)
            OR (transaction_kind IN ('boost_purchase', 'promo_expiry', 'subscription_refund') AND NEW.amount < 0)
        WHEN 'promo_issuance' THEN transaction_kind = 'subscription_charge' AND NEW.amount < 0
        WHEN 'promo_consumed' THEN
            (transaction_kind = 'boost_purchase' AND NEW.amount > 0) OR (transaction_kind = 'boost_refund' AND NEW.amount < 0)
        WHEN 'promo_expired' THEN transaction_kind IN ('promo_expiry', 'subscription_refund', 'boost_refund') AND NEW.amount > 0
        WHEN 'subscription_revenue' THEN
            (transaction_kind = 'subscription_charge' AND NEW.amount > 0) OR (transaction_kind = 'subscription_refund' AND NEW.amount < 0)
    END;
    IF allowed IS NOT TRUE THEN
        RAISE EXCEPTION 'wallet_account_usage' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'ce type de transaction ne peut pas écrire sur ce compte, ni dans ce sens';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_wallet_entries_account_usage
    BEFORE INSERT ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_guard_account_usage();

-- ───────────── 3. Plans versionnés ─────────────

CREATE TABLE plans (
    id UUID PRIMARY KEY,
    code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_plans_code UNIQUE (code),
    CONSTRAINT chk_plans_code CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$')
);

-- Entitlements : liste blanche, sans doublon ni élément nul.
CREATE FUNCTION plan_entitlements_valid(p_entitlements TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_entitlements IS NOT NULL
       AND p_entitlements <@ ARRAY['badge_pro', 'catalog_import', 'priority_support_label']::text[]
       AND cardinality(p_entitlements) = (SELECT count(DISTINCT x) FROM unnest(p_entitlements) AS x)
$$;

CREATE TABLE plan_versions (
    id UUID PRIMARY KEY,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    monthly_price_xof BIGINT NOT NULL,
    promo_credits_xof BIGINT NOT NULL,
    max_online_offers INTEGER NOT NULL,
    entitlements TEXT[] NOT NULL DEFAULT '{}',
    -- Administrateur auteur de la version (trace d'audit) : volontairement SANS clé étrangère. Les plans sont une configuration du catalogue,
    -- pas une donnée d'utilisateur : vider les utilisateurs (TRUNCATE users CASCADE d'un environnement d'essai) ne doit jamais effacer les versions de plan.
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_plan_versions_plan_version UNIQUE (plan_id, version),
    CONSTRAINT chk_plan_versions_version CHECK (version >= 1),
    CONSTRAINT chk_plan_versions_name CHECK (btrim(name) <> '' AND char_length(name) <= 60),
    CONSTRAINT chk_plan_versions_price CHECK (monthly_price_xof BETWEEN 0 AND 1000000000),
    CONSTRAINT chk_plan_versions_promo CHECK (promo_credits_xof BETWEEN 0 AND 1000000000),
    CONSTRAINT chk_plan_versions_max_offers CHECK (max_online_offers BETWEEN 1 AND 100000),
    CONSTRAINT chk_plan_versions_entitlements CHECK (plan_entitlements_valid(entitlements))
);

-- Une version PUBLIÉE est immuable : aucune modification, aucune suppression (plans compris). Une nouvelle version s'ajoute ; son numéro suit le précédent sans trou.
CREATE FUNCTION plans_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'plan_immutable' USING
        ERRCODE = 'restrict_violation',
        DETAIL = TG_OP || ' interdit sur ' || TG_TABLE_NAME;
END
$$;

CREATE TRIGGER trg_plans_immutable
    BEFORE UPDATE OR DELETE ON plans
    FOR EACH ROW EXECUTE FUNCTION plans_forbid_mutation();
CREATE TRIGGER trg_plan_versions_immutable
    BEFORE UPDATE OR DELETE ON plan_versions
    FOR EACH ROW EXECUTE FUNCTION plans_forbid_mutation();

CREATE FUNCTION plan_versions_check_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    last_version INTEGER;
BEGIN
    SELECT COALESCE(max(version), 0) INTO last_version FROM plan_versions WHERE plan_id = NEW.plan_id;
    IF NEW.version <> last_version + 1 THEN
        RAISE EXCEPTION 'plan_version_sequence' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_plan_versions_sequence';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_plan_versions_sequence
    BEFORE INSERT ON plan_versions
    FOR EACH ROW EXECUTE FUNCTION plan_versions_check_sequence();

-- Plans de départ : PRIX PROVISOIRES (décision du fondateur en attente).
INSERT INTO plans (id, code) VALUES (gen_random_uuid(), 'free'), (gen_random_uuid(), 'pro');
INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
SELECT gen_random_uuid(), id, 1, 'Gratuit', 0, 0, 10, '{}'::text[] FROM plans WHERE code = 'free';
INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
SELECT gen_random_uuid(), id, 1, 'Pro', 10000, 5000, 100, ARRAY['badge_pro', 'catalog_import']::text[] FROM plans WHERE code = 'pro';

-- ───────────── 4. Abonnements et périodes ─────────────

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    -- Version du plan de la période COURANTE (une nouvelle version ne s'applique qu'au renouvellement) et bornes de cette période.
    plan_version_id UUID NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
    -- Instant où l'utilisateur a désactivé le renouvellement (annulation : effective à la fin de la période) ; NULL tant qu'il est activé.
    canceled_at TIMESTAMPTZ,
    -- Fin du délai de grâce après un renouvellement impayé (fin de la période + 3 jours) ; renseignée ssi `past_due`.
    grace_ends_at TIMESTAMPTZ,
    -- Dernière tentative de renouvellement (réussie ou non) : pendant la grâce, le worker n'en refait pas plus d'une par quart d'heure.
    last_attempt_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    ended_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_subscriptions_status CHECK (status IN ('active', 'past_due', 'ended')),
    CONSTRAINT chk_subscriptions_period CHECK (current_period_end > current_period_start),
    CONSTRAINT chk_subscriptions_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL) AND (status = 'ended') = (ended_reason IS NOT NULL)),
    CONSTRAINT chk_subscriptions_ended_reason CHECK (ended_reason IS NULL OR ended_reason IN ('canceled', 'payment_failed', 'refunded')),
    CONSTRAINT chk_subscriptions_grace CHECK ((status = 'past_due') = (grace_ends_at IS NOT NULL)),
    CONSTRAINT chk_subscriptions_canceled CHECK ((canceled_at IS NOT NULL) = (NOT auto_renew) OR status = 'ended')
);

-- Un seul abonnement VIVANT (actif ou en grâce) par utilisateur.
CREATE UNIQUE INDEX uq_subscriptions_live_user ON subscriptions (user_id) WHERE status IN ('active', 'past_due');
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id, created_at DESC);
-- Échéances à traiter par l'étape « subscriptions » du worker.
CREATE INDEX idx_subscriptions_due ON subscriptions (current_period_end) WHERE status IN ('active', 'past_due');

CREATE TABLE subscription_periods (
    id UUID PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    plan_version_id UUID NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    price_xof BIGINT NOT NULL,
    promo_credits_xof BIGINT NOT NULL,
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    -- Clé d'idempotence de la souscription initiale (un double clic ne donne jamais deux débits) ; NULL pour un renouvellement (idempotent par période : UNIQUE ci-dessous).
    idempotency_key UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    refunded_at TIMESTAMPTZ,
    refund_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_subscription_periods_number UNIQUE (subscription_id, number),
    CONSTRAINT uq_subscription_periods_transaction UNIQUE (transaction_id),
    CONSTRAINT uq_subscription_periods_refund_transaction UNIQUE (refund_transaction_id),
    CONSTRAINT uq_subscription_periods_user_idempotency UNIQUE (user_id, idempotency_key),
    CONSTRAINT chk_subscription_periods_number CHECK (number >= 1),
    CONSTRAINT chk_subscription_periods_kind CHECK ((kind = 'initial') = (number = 1) AND kind IN ('initial', 'renewal')),
    CONSTRAINT chk_subscription_periods_window CHECK (ends_at > starts_at),
    CONSTRAINT chk_subscription_periods_price CHECK (price_xof > 0 AND price_xof <= 9007199254740991),
    CONSTRAINT chk_subscription_periods_promo CHECK (promo_credits_xof >= 0 AND promo_credits_xof <= 9007199254740991),
    CONSTRAINT chk_subscription_periods_idempotency CHECK (kind = 'initial' OR idempotency_key IS NULL),
    CONSTRAINT chk_subscription_periods_refund CHECK ((refunded_at IS NULL) = (refund_transaction_id IS NULL))
);

CREATE INDEX idx_subscription_periods_created ON subscription_periods (created_at);
CREATE INDEX idx_subscription_periods_user ON subscription_periods (user_id, created_at DESC);

-- Écritures d'une période : `subscription_charge` = vendeur −prix, subscription_revenue +prix, et, s'il y a des crédits promotionnels, user_promo +crédits, promo_issuance −crédits (exactement
-- 2 ou 4 écritures) ; `subscription_refund` = l'inverse INTÉGRAL du prix, et le reste promotionnel inutilisé annulé (user_promo −reste, promo_expired +reste) s'il y en a un.
CREATE FUNCTION subscription_period_ledger_matches(
    p_transaction UUID, p_kind TEXT, p_period UUID, p_user UUID, p_price BIGINT, p_promo BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    user_sign INTEGER;
    expected_count INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions t
                    WHERE t.id = p_transaction AND t.kind = p_kind AND t.reference = p_kind || ':' || p_period::text) THEN
        RETURN FALSE;
    END IF;
    user_sign := CASE p_kind WHEN 'subscription_charge' THEN -1 ELSE 1 END;
    expected_count := 2 + CASE WHEN p_promo > 0 THEN 2 ELSE 0 END;
    IF (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = p_transaction) <> expected_count THEN
        RETURN FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                    WHERE e.transaction_id = p_transaction AND a.kind = 'user' AND a.owner_id = p_user AND e.amount = user_sign * p_price)
       OR NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                       WHERE e.transaction_id = p_transaction AND a.kind = 'subscription_revenue' AND e.amount = -user_sign * p_price) THEN
        RETURN FALSE;
    END IF;
    IF p_promo > 0 THEN
        -- Émission : user_promo +crédits, promo_issuance −crédits. Remboursement : user_promo −reste, promo_expired +reste.
        IF NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                        WHERE e.transaction_id = p_transaction AND a.kind = 'user_promo' AND a.owner_id = p_user AND e.amount = -user_sign * p_promo)
           OR NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                           WHERE e.transaction_id = p_transaction
                             AND a.kind = CASE p_kind WHEN 'subscription_charge' THEN 'promo_issuance' ELSE 'promo_expired' END
                             AND e.amount = user_sign * p_promo) THEN
            RETURN FALSE;
        END IF;
    END IF;
    RETURN TRUE;
END
$$;

-- Garde de subscription_periods.
--  * INSERT : créée non remboursée ; l'abonnement est celui de CET utilisateur ; la version est une version du plan de l'abonnement et le prix et les crédits sont EXACTEMENT les siens ;
--    numéro = précédent + 1 ; fenêtre = UN MOIS civil UTC ; la transaction du grand livre est le débit de CE prix (et l'émission de CES crédits).
--  * UPDATE : seul le passage unique refunded_at NULL → date avec refund_transaction_id est permis ; la transaction est le remboursement INTÉGRAL du prix.
--  * DELETE : interdit.
CREATE FUNCTION subscription_periods_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    sub RECORD;
    version_row RECORD;
    last_number INTEGER;
    refunded_promo BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'subscription_period_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur subscription_periods';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.refunded_at IS NOT NULL OR NEW.refund_transaction_id IS NOT NULL THEN
            RAISE EXCEPTION 'subscription_period_initial_state' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        SELECT user_id, plan_id INTO sub FROM subscriptions WHERE id = NEW.subscription_id;
        IF NOT FOUND OR sub.user_id <> NEW.user_id THEN
            RAISE EXCEPTION 'subscription_period_subscription_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        SELECT plan_id, monthly_price_xof, promo_credits_xof INTO version_row FROM plan_versions WHERE id = NEW.plan_version_id;
        IF NOT FOUND OR version_row.plan_id <> sub.plan_id OR version_row.monthly_price_xof <> NEW.price_xof
           OR version_row.promo_credits_xof <> NEW.promo_credits_xof THEN
            RAISE EXCEPTION 'subscription_period_version_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        SELECT COALESCE(max(number), 0) INTO last_number FROM subscription_periods WHERE subscription_id = NEW.subscription_id;
        IF NEW.number <> last_number + 1 THEN
            RAISE EXCEPTION 'subscription_period_number' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        IF NEW.ends_at <> ((NEW.starts_at AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC') THEN
            RAISE EXCEPTION 'subscription_period_window' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        IF NOT subscription_period_ledger_matches(NEW.transaction_id, 'subscription_charge', NEW.id, NEW.user_id, NEW.price_xof, NEW.promo_credits_xof) THEN
            RAISE EXCEPTION 'subscription_period_ledger_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF NEW.id <> OLD.id OR NEW.subscription_id <> OLD.subscription_id OR NEW.user_id <> OLD.user_id OR NEW.number <> OLD.number OR NEW.kind <> OLD.kind
       OR NEW.plan_version_id <> OLD.plan_version_id OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.price_xof <> OLD.price_xof
       OR NEW.promo_credits_xof <> OLD.promo_credits_xof OR NEW.transaction_id <> OLD.transaction_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'subscription_period_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'champ immuable d''une période d''abonnement';
    END IF;
    IF NOT (OLD.refunded_at IS NULL AND OLD.refund_transaction_id IS NULL AND NEW.refunded_at IS NOT NULL AND NEW.refund_transaction_id IS NOT NULL) THEN
        RAISE EXCEPTION 'subscription_period_refund_transition' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
    END IF;
    -- Le reste promotionnel annulé par ce remboursement est celui de l'émission de la période (expired_xof de la même transaction), ou zéro.
    SELECT COALESCE(max(g.expired_xof), 0) INTO refunded_promo
      FROM promo_grants g WHERE g.period_id = NEW.id AND g.expiry_transaction_id = NEW.refund_transaction_id;
    IF NOT subscription_period_ledger_matches(NEW.refund_transaction_id, 'subscription_refund', NEW.id, NEW.user_id, NEW.price_xof, refunded_promo) THEN
        RAISE EXCEPTION 'subscription_period_refund_ledger_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscription_periods_guard';
    END IF;
    RETURN NEW;
END
$$;

-- Les crédits promotionnels (promo_grants) référencent subscription_periods : la table des périodes est créée d'abord, la fonction de garde ne résout promo_grants qu'à l'exécution.

-- Garde de subscriptions : l'identité ne change jamais ; transitions actif ↔ en grâce, puis fin (définitive) ; aucune suppression.
CREATE FUNCTION subscriptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'subscription_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur subscriptions';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'active' THEN
            RAISE EXCEPTION 'subscription_initial_status' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscriptions_guard';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.plan_id <> OLD.plan_id OR NEW.started_at <> OLD.started_at OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'subscription_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'identité d''un abonnement immuable';
    END IF;
    IF OLD.status = 'ended' THEN
        RAISE EXCEPTION 'subscription_ended' USING ERRCODE = 'restrict_violation', DETAIL = 'un abonnement terminé ne change plus';
    END IF;
    IF NOT ((OLD.status = 'active' AND NEW.status IN ('active', 'past_due', 'ended'))
         OR (OLD.status = 'past_due' AND NEW.status IN ('past_due', 'active', 'ended'))) THEN
        RAISE EXCEPTION 'subscription_transition' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_subscriptions_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_subscriptions_guard
    BEFORE INSERT OR UPDATE OR DELETE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION subscriptions_guard();

-- ───────────── 5. Crédits promotionnels : émissions et mouvements ─────────────

-- Une émission par période payée (période_id UNIQUE). Reste = montant + restitutions − dépenses − expiré. `expired_xof` est écrit UNE fois ; il est égal au reste à cet instant et la
-- transaction du grand livre qui l'a retiré (`promo_expiry`, ou le remboursement de la période) est liée. Une émission sans reste à l'expiration est close sans transaction (0).
CREATE TABLE promo_grants (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    period_id UUID NOT NULL REFERENCES subscription_periods(id) ON DELETE RESTRICT,
    amount_xof BIGINT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    grant_transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    expired_xof BIGINT,
    expired_at TIMESTAMPTZ,
    expiry_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    expiry_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_promo_grants_period UNIQUE (period_id),
    CONSTRAINT uq_promo_grants_grant_transaction UNIQUE (grant_transaction_id),
    CONSTRAINT uq_promo_grants_expiry_transaction UNIQUE (expiry_transaction_id),
    CONSTRAINT chk_promo_grants_amount CHECK (amount_xof > 0 AND amount_xof <= 9007199254740991),
    CONSTRAINT chk_promo_grants_window CHECK (expires_at > granted_at),
    CONSTRAINT chk_promo_grants_expiry CHECK (
        (expired_at IS NULL) = (expired_xof IS NULL) AND (expired_at IS NULL) = (expiry_reason IS NULL)
        AND (expired_xof IS NULL OR (expired_xof >= 0 AND expired_xof <= amount_xof))
        AND (expired_xof IS NULL OR ((expired_xof = 0) = (expiry_transaction_id IS NULL)))
        AND (expired_at IS NOT NULL OR expiry_transaction_id IS NULL)
    ),
    CONSTRAINT chk_promo_grants_reason CHECK (expiry_reason IS NULL OR expiry_reason IN ('period_end', 'refund'))
);

CREATE INDEX idx_promo_grants_due ON promo_grants (expires_at) WHERE expired_at IS NULL;
CREATE INDEX idx_promo_grants_user_open ON promo_grants (user_id, expires_at) WHERE expired_at IS NULL;

CREATE TABLE promo_movements (
    id UUID PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES promo_grants(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    amount_xof BIGINT NOT NULL,
    purchase_id UUID NOT NULL REFERENCES boost_purchases(id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_promo_movements_kind CHECK (kind IN ('spend', 'restore', 'lapse')),
    CONSTRAINT chk_promo_movements_amount CHECK (amount_xof > 0 AND amount_xof <= 9007199254740991),
    -- Un mouvement par (émission, achat, sorte) : un achat dépense une émission une fois ; son remboursement la restitue (ou la laisse échoir) une fois.
    CONSTRAINT uq_promo_movements_grant_purchase_kind UNIQUE (grant_id, purchase_id, kind)
);

CREATE INDEX idx_promo_movements_grant ON promo_movements (grant_id);
CREATE INDEX idx_promo_movements_purchase ON promo_movements (purchase_id);

-- Le reste d'une émission (même formule que le code et que wallet:check).
CREATE FUNCTION promo_grant_remaining(p_grant UUID) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT g.amount_xof
         + COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.grant_id = g.id AND m.kind = 'restore'), 0)
         - COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.grant_id = g.id AND m.kind = 'spend'), 0)
         - COALESCE(g.expired_xof, 0)
      FROM promo_grants g WHERE g.id = p_grant
$$;

-- Garde de promo_grants.
--  * INSERT : non expirée ; la période existe, est à CET utilisateur, porte ces crédits, cette échéance (fin de la période) ; la transaction est celle du débit de la période.
--  * UPDATE : seule l'expiration, UNE fois : NULL → (expired_xof = reste exact, expired_at, motif). `period_end` : jamais avant l'échéance. `refund` : par le remboursement de la période.
--  * DELETE : interdit.
CREATE FUNCTION promo_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    period RECORD;
    remaining BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'promo_grant_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur promo_grants';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.expired_at IS NOT NULL THEN
            RAISE EXCEPTION 'promo_grant_initial_state' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_grants_guard';
        END IF;
        SELECT user_id, promo_credits_xof, starts_at, ends_at, transaction_id INTO period FROM subscription_periods WHERE id = NEW.period_id;
        IF NOT FOUND OR period.user_id <> NEW.user_id OR period.promo_credits_xof <> NEW.amount_xof OR period.ends_at <> NEW.expires_at
           OR period.starts_at <> NEW.granted_at OR period.transaction_id <> NEW.grant_transaction_id THEN
            RAISE EXCEPTION 'promo_grant_period_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_grants_guard';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.period_id <> OLD.period_id OR NEW.amount_xof <> OLD.amount_xof OR NEW.granted_at <> OLD.granted_at
       OR NEW.expires_at <> OLD.expires_at OR NEW.grant_transaction_id <> OLD.grant_transaction_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'promo_grant_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'champ immuable d''une émission de crédits promotionnels';
    END IF;
    IF NOT (OLD.expired_at IS NULL AND NEW.expired_at IS NOT NULL) THEN
        RAISE EXCEPTION 'promo_grant_expiry_transition' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_grants_guard';
    END IF;
    IF NEW.expiry_reason = 'period_end' AND NEW.expired_at < NEW.expires_at THEN
        RAISE EXCEPTION 'promo_grant_expired_early' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_grants_guard';
    END IF;
    remaining := NEW.amount_xof
        + COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.grant_id = NEW.id AND m.kind = 'restore'), 0)
        - COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.grant_id = NEW.id AND m.kind = 'spend'), 0);
    IF NEW.expired_xof <> remaining THEN
        RAISE EXCEPTION 'promo_grant_expiry_amount' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_grants_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_promo_grants_guard
    BEFORE INSERT OR UPDATE OR DELETE ON promo_grants
    FOR EACH ROW EXECUTE FUNCTION promo_grants_guard();

CREATE TRIGGER trg_subscription_periods_guard
    BEFORE INSERT OR UPDATE OR DELETE ON subscription_periods
    FOR EACH ROW EXECUTE FUNCTION subscription_periods_guard();

-- Garde de promo_movements : jamais de dépassement ni de dépense d'une émission échue ; un achat ne dépense et ne restitue que ses propres crédits ; immuables.
CREATE FUNCTION promo_movements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    grant_row RECORD;
    remaining BIGINT;
    spent_for_purchase BIGINT;
    returned_for_purchase BIGINT;
    expected_reference TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'promo_movement_immutable' USING ERRCODE = 'restrict_violation', DETAIL = TG_OP || ' interdit sur promo_movements';
    END IF;
    SELECT user_id, expires_at, expired_at INTO grant_row FROM promo_grants WHERE id = NEW.grant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'promo_movement_grant_missing' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM boost_purchases p WHERE p.id = NEW.purchase_id AND p.seller_id = grant_row.user_id) THEN
        RAISE EXCEPTION 'promo_movement_purchase_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
    END IF;
    expected_reference := CASE NEW.kind WHEN 'spend' THEN 'boost_purchase:' ELSE 'boost_refund:' END || NEW.purchase_id::text;
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = NEW.transaction_id AND t.reference = expected_reference) THEN
        RAISE EXCEPTION 'promo_movement_transaction_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
    END IF;
    SELECT COALESCE(sum(m.amount_xof), 0) INTO spent_for_purchase FROM promo_movements m WHERE m.purchase_id = NEW.purchase_id AND m.kind = 'spend';
    IF NEW.kind = 'spend' THEN
        IF grant_row.expired_at IS NOT NULL OR grant_row.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'promo_grant_expired' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
        END IF;
        remaining := promo_grant_remaining(NEW.grant_id);
        IF NEW.amount_xof > remaining THEN
            RAISE EXCEPTION 'promo_overspend' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
        END IF;
    ELSE
        -- restore et lapse : au total, jamais plus que ce que l'achat a dépensé ; une restitution seulement sur une émission encore valable.
        IF NEW.kind = 'restore' AND (grant_row.expired_at IS NOT NULL OR grant_row.expires_at <= clock_timestamp()) THEN
            RAISE EXCEPTION 'promo_grant_expired' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
        END IF;
        SELECT COALESCE(sum(m.amount_xof), 0) INTO returned_for_purchase FROM promo_movements m WHERE m.purchase_id = NEW.purchase_id AND m.kind IN ('restore', 'lapse');
        IF returned_for_purchase + NEW.amount_xof > spent_for_purchase THEN
            RAISE EXCEPTION 'promo_overreturn' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_promo_movements_guard';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_promo_movements_guard
    BEFORE INSERT OR UPDATE OR DELETE ON promo_movements
    FOR EACH ROW EXECUTE FUNCTION promo_movements_guard();

-- ───────────── 6. Achats de boost payés en partie ou en totalité par des crédits promotionnels ─────────────

ALTER TABLE boost_purchases ADD COLUMN promo_xof BIGINT NOT NULL DEFAULT 0;
ALTER TABLE boost_purchases ADD CONSTRAINT chk_boost_purchases_promo CHECK (promo_xof >= 0 AND promo_xof <= amount_xof);
-- Part payée en crédits payés : calculée, jamais saisie. Sur les achats déjà enregistrés, promo_xof vaut 0 : paid_xof = amount_xof.
ALTER TABLE boost_purchases ADD COLUMN paid_xof BIGINT GENERATED ALWAYS AS (amount_xof - promo_xof) STORED;

-- Écritures d'un achat de boost : vendeur −payé, boost_revenue +payé (s'il y a une part payée), user_promo −promo, promo_consumed +promo (s'il y a une part promotionnelle) ;
-- à l'achat, 2 ou 4 écritures. Remboursement : l'inverse INTÉGRAL ; la part promotionnelle retourne au sous-compte promotionnel (émission encore valable : mouvements
-- `restore`) ou est perdue (émission échue ou close : mouvements `lapse`, promo_expired +part) ; ces mouvements sont inscrits AVANT le passage de l'achat en « remboursé » et
-- décident des écritures attendues. Le prix total (payé + promotionnel) est celui de la cotation.
CREATE FUNCTION boost_purchase_ledger_matches_v2(
    p_transaction UUID, p_kind TEXT, p_purchase UUID, p_seller UUID, p_paid BIGINT, p_promo BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    user_sign INTEGER;
    expected_count INTEGER;
    restored BIGINT := 0;
    lapsed BIGINT := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions t
                    WHERE t.id = p_transaction AND t.kind = p_kind AND t.reference = p_kind || ':' || p_purchase::text) THEN
        RETURN FALSE;
    END IF;
    user_sign := CASE p_kind WHEN 'boost_purchase' THEN -1 ELSE 1 END;
    expected_count := CASE WHEN p_paid > 0 THEN 2 ELSE 0 END;
    IF p_promo > 0 THEN
        IF p_kind = 'boost_purchase' THEN
            expected_count := expected_count + 2;
        ELSE
            SELECT COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind = 'restore'), 0), COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind = 'lapse'), 0)
              INTO restored, lapsed FROM promo_movements m WHERE m.purchase_id = p_purchase;
            IF restored + lapsed <> p_promo THEN
                RETURN FALSE;
            END IF;
            expected_count := expected_count + 1 + CASE WHEN restored > 0 THEN 1 ELSE 0 END + CASE WHEN lapsed > 0 THEN 1 ELSE 0 END;
        END IF;
    END IF;
    IF expected_count = 0 OR (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = p_transaction) <> expected_count THEN
        RETURN FALSE;
    END IF;
    IF p_paid > 0 AND NOT (
        EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                 WHERE e.transaction_id = p_transaction AND a.kind = 'user' AND a.owner_id = p_seller AND e.amount = user_sign * p_paid)
        AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                     WHERE e.transaction_id = p_transaction AND a.kind = 'boost_revenue' AND e.amount = -user_sign * p_paid)) THEN
        RETURN FALSE;
    END IF;
    IF p_promo > 0 THEN
        IF NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                        WHERE e.transaction_id = p_transaction AND a.kind = 'promo_consumed' AND e.amount = -user_sign * p_promo) THEN
            RETURN FALSE;
        END IF;
        IF p_kind = 'boost_purchase' THEN
            IF NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                            WHERE e.transaction_id = p_transaction AND a.kind = 'user_promo' AND a.owner_id = p_seller AND e.amount = -p_promo) THEN
                RETURN FALSE;
            END IF;
        ELSE
            IF restored > 0 AND NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                                             WHERE e.transaction_id = p_transaction AND a.kind = 'user_promo' AND a.owner_id = p_seller AND e.amount = restored) THEN
                RETURN FALSE;
            END IF;
            IF lapsed > 0 AND NOT EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                                           WHERE e.transaction_id = p_transaction AND a.kind = 'promo_expired' AND e.amount = lapsed) THEN
                RETURN FALSE;
            END IF;
        END IF;
    END IF;
    RETURN TRUE;
END
$$;

-- Garde de boost_purchases (remplace celle de 0015) : mêmes contrôles, avec la part promotionnelle. À l'insertion, la ligne est créée non remboursée, la cotation (disponible,
-- même offre, même vendeur, même durée, même MONTANT TOTAL), le boost, la fenêtre et les écritures du grand livre lui correspondent.
CREATE OR REPLACE FUNCTION boost_purchases_guard() RETURNS trigger
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
        window_seconds := CASE NEW.duration_code WHEN '24h' THEN 86400 WHEN '3d' THEN 259200 WHEN '7d' THEN 604800 END;
        IF extract(epoch FROM boost_row.ends_at - boost_row.starts_at) <> window_seconds
           OR boost_row.starts_at > NEW.created_at OR NEW.created_at - boost_row.starts_at > interval '60 seconds' THEN
            RAISE EXCEPTION 'boost_purchase_window_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        IF NOT boost_purchase_ledger_matches_v2(NEW.transaction_id, 'boost_purchase', NEW.id, NEW.seller_id, NEW.amount_xof - NEW.promo_xof, NEW.promo_xof) THEN
            RAISE EXCEPTION 'boost_purchase_ledger_mismatch' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_boost_purchases_guard';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.offer_id <> OLD.offer_id OR NEW.quote_id <> OLD.quote_id
       OR NEW.boost_id <> OLD.boost_id OR NEW.transaction_id <> OLD.transaction_id OR NEW.amount_xof <> OLD.amount_xof OR NEW.promo_xof <> OLD.promo_xof
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
    IF NOT boost_purchase_ledger_matches_v2(NEW.refund_transaction_id, 'boost_refund', NEW.id, NEW.seller_id, NEW.amount_xof - NEW.promo_xof, NEW.promo_xof) THEN
        RAISE EXCEPTION 'boost_purchase_refund_ledger_mismatch' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_boost_purchases_guard';
    END IF;
    RETURN NEW;
END
$$;

DROP FUNCTION boost_purchase_ledger_matches(UUID, TEXT, UUID, UUID, BIGINT, INTEGER);

-- Cohérence au COMMIT : la part promotionnelle d'un achat est EXACTEMENT couverte par ses mouvements (dépenses ; au remboursement, restitutions + pertes). Déclenchée par un achat
-- qui a une part promotionnelle et par tout mouvement (un mouvement sur un achat sans part promotionnelle est refusé au COMMIT). Un achat payé seulement en crédits ne crée aucun
-- événement différé sur boost_purchases.
CREATE FUNCTION boost_purchases_assert_promo_movements() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_purchase UUID;
    purchase_promo BIGINT;
    purchase_refunded BOOLEAN;
    spent BIGINT;
    returned BIGINT;
    expected_returned BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'promo_movements' THEN
        target_purchase := NEW.purchase_id;
    ELSE
        target_purchase := NEW.id;
    END IF;
    SELECT p.promo_xof, (p.refunded_at IS NOT NULL) INTO purchase_promo, purchase_refunded FROM boost_purchases p WHERE p.id = target_purchase;
    SELECT COALESCE(sum(amount_xof) FILTER (WHERE kind = 'spend'), 0), COALESCE(sum(amount_xof) FILTER (WHERE kind IN ('restore', 'lapse')), 0)
      INTO spent, returned FROM promo_movements WHERE promo_movements.purchase_id = target_purchase;
    expected_returned := 0;
    IF purchase_refunded THEN
        expected_returned := purchase_promo;
    END IF;
    IF spent <> purchase_promo OR returned <> expected_returned THEN
        RAISE EXCEPTION 'boost_purchase_promo_movements' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_boost_purchases_promo_movements';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER trg_boost_purchases_promo_movements
    AFTER INSERT OR UPDATE ON boost_purchases
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.promo_xof > 0) EXECUTE FUNCTION boost_purchases_assert_promo_movements();
CREATE CONSTRAINT TRIGGER trg_promo_movements_covered
    AFTER INSERT ON promo_movements
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION boost_purchases_assert_promo_movements();

-- Cohérence au COMMIT des transactions de l'offre Pro : un débit de période, un remboursement de période et une expiration n'existent jamais sans leur objet.
CREATE FUNCTION pro_transactions_assert_linked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'subscription_charge' THEN
        IF NOT EXISTS (SELECT 1 FROM subscription_periods p WHERE p.transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'subscription_charge_unlinked' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_pro_transactions_linked';
        END IF;
    ELSIF NEW.kind = 'subscription_refund' THEN
        IF NOT EXISTS (SELECT 1 FROM subscription_periods p WHERE p.refund_transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'subscription_refund_unlinked' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_pro_transactions_linked';
        END IF;
    ELSIF NEW.kind = 'promo_expiry' THEN
        IF NOT EXISTS (SELECT 1 FROM promo_grants g WHERE g.expiry_transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'promo_expiry_unlinked' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_pro_transactions_linked';
        END IF;
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER trg_pro_transactions_linked
    AFTER INSERT ON wallet_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.kind IN ('subscription_charge', 'subscription_refund', 'promo_expiry')) EXECUTE FUNCTION pro_transactions_assert_linked();

-- ───────────── 7. Droits en vigueur ─────────────

-- La version de plan EN VIGUEUR d'un utilisateur, ou NULL (plan Gratuit). Règle unique, partagée par le badge, la limite d'annonces et l'import :
--   * abonnement `active` : en vigueur jusqu'à la fin de la période ; au-delà, seulement s'il se renouvelle automatiquement (le worker décide : renouvellement, ou délai de grâce) ;
--     une annulation (renouvellement désactivé) perd ses droits à la seconde où la période se termine, même si le worker est en retard ;
--   * abonnement `past_due` (délai de grâce) : en vigueur jusqu'à la fin de la grâce ;
--   * abonnement `ended` : jamais.
CREATE FUNCTION subscription_effective_version(p_user UUID) RETURNS UUID
LANGUAGE sql AS $$
    SELECT s.plan_version_id
      FROM subscriptions s
     WHERE s.user_id = p_user
       AND ((s.status = 'active' AND (s.current_period_end > clock_timestamp() OR s.auto_renew))
         OR (s.status = 'past_due' AND s.grace_ends_at > clock_timestamp()))
     LIMIT 1
$$;

-- ───────────── 8. Avis à l'utilisateur, import de catalogue ─────────────

-- Avis DANS l'application sur son abonnement : renouvellement refusé (délai de grâce), abonnement terminé, annonces mises en pause, annonces remises en ligne. Texte fixe construit à la lecture (aucun texte libre).
CREATE TABLE subscription_notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    listing_count INTEGER,
    dedupe_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    read_at TIMESTAMPTZ,
    CONSTRAINT chk_subscription_notices_code CHECK (code IN ('renewal_failed', 'subscription_ended', 'listings_paused', 'listings_restored')),
    CONSTRAINT chk_subscription_notices_count CHECK ((code IN ('listings_paused', 'listings_restored')) = (listing_count IS NOT NULL) AND (listing_count IS NULL OR listing_count >= 1)),
    CONSTRAINT chk_subscription_notices_read CHECK (read_at IS NULL OR read_at >= created_at),
    CONSTRAINT uq_subscription_notices_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_subscription_notices_user ON subscription_notices (user_id, created_at DESC);
CREATE INDEX idx_subscription_notices_unread ON subscription_notices (user_id) WHERE read_at IS NULL;

-- Import de catalogue : UNE ligne par fichier appliqué (empreinte SHA-256 du contenu normalisé : le même fichier n'est appliqué qu'une fois par vendeur), avec le rapport ligne
-- par ligne (numéro de ligne, issue, code : AUCUNE donnée du fichier). Aucun fichier n'est stocké.
CREATE TABLE catalog_imports (
    id UUID PRIMARY KEY,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    fingerprint TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    created_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL,
    report JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_catalog_imports_seller_fingerprint UNIQUE (seller_id, fingerprint),
    CONSTRAINT chk_catalog_imports_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_catalog_imports_counts CHECK (
        row_count BETWEEN 1 AND 200 AND created_count >= 0 AND rejected_count >= 0 AND created_count + rejected_count = row_count),
    CONSTRAINT chk_catalog_imports_report CHECK (jsonb_typeof(report) = 'array' AND jsonb_array_length(report) = row_count AND octet_length(report::text) <= 65536)
);

CREATE INDEX idx_catalog_imports_seller ON catalog_imports (seller_id, created_at DESC);

-- ───────────── 9. Raison de la mise en pause d'une annonce ─────────────

-- Une annonce mise en pause PAR LE SYSTÈME parce que l'abonnement a pris fin (annonces au-delà de la limite du plan Gratuit) porte `paused_reason = 'plan_limit'` : à la
-- (re)souscription Pro, ces annonces-là, et elles seules, sont remises en ligne (dans la limite du nouveau plan, les plus récentes d'abord). Une annonce mise en pause par le
-- vendeur lui-même n'a AUCUNE raison (NULL) et n'est jamais remise en ligne automatiquement. La raison n'a de sens que pendant la pause : elle est effacée dès que le statut change
-- (publication, archivage, pause par le vendeur), quel que soit le chemin qui l'écrit.
ALTER TABLE offers ADD COLUMN paused_reason TEXT;
ALTER TABLE offers ADD CONSTRAINT chk_offers_paused_reason CHECK (paused_reason IS NULL OR (paused_reason = 'plan_limit' AND status = 'paused'));

CREATE FUNCTION offers_clear_paused_reason() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'paused' THEN
        NEW.paused_reason := NULL;
    ELSIF OLD.status IS DISTINCT FROM 'paused' AND NEW.paused_reason IS NOT DISTINCT FROM OLD.paused_reason THEN
        -- Entrée en pause sans raison explicite dans la même instruction : pause du vendeur.
        NEW.paused_reason := NULL;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_offers_clear_paused_reason
    BEFORE UPDATE ON offers
    FOR EACH ROW EXECUTE FUNCTION offers_clear_paused_reason();

CREATE INDEX idx_offers_plan_limit_paused ON offers (owner_id, created_at DESC) WHERE paused_reason = 'plan_limit';
