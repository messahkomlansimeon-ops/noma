-- Migration 0014 : grand livre de crédits et recharge par prestataire fictif (lot P1a)
-- Additive : ne modifie pas 0001 à 0013. Monnaie : francs CFA (XOF), entiers BIGINT, 1 crédit = 1 XOF. Aucun flottant.
-- Aucun achat de boost, aucun remboursement (lot P1b), aucun prestataire réel : seul le prestataire « fake » existe.
--
-- Grand livre en partie double, IMMUABLE :
--   * wallet_accounts      : un compte par utilisateur (créé à la demande) et un compte par type système ;
--   * wallet_transactions  : une opération identifiée par une référence unique (idempotence) ;
--   * wallet_entries       : les écritures d'une opération ; leur somme vaut TOUJOURS zéro (contrainte différée) ;
--   * wallet_accounts.balance est tenu par un déclencheur sur wallet_entries, dans la MÊME transaction que l'écriture : un solde
--     utilisateur négatif fait échouer toute la transaction (CHECK).
-- Convention de signe : une écriture positive CRÉDITE le compte, une écriture négative le DÉBITE. Une recharge débite
-- provider_clearing (qui devient négatif : ce que le prestataire nous doit) et crédite le compte de l'utilisateur.
--
-- Extension en P1b : ajouter 'boost_purchase' et 'refund' en remplaçant chk_wallet_transactions_kind (DROP CONSTRAINT puis ADD
-- CONSTRAINT dans la nouvelle migration), et adapter chk_wallet_transactions_metadata si de nouvelles clés sont nécessaires.
-- TRUNCATE n'est volontairement pas bloqué (les suites de test existantes vident `users` en cascade) : un rôle applicatif ne doit
-- pas avoir le droit TRUNCATE sur ces tables.

-- ───────────── comptes ─────────────

CREATE TABLE wallet_accounts (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL,
    owner_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    balance BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_wallet_accounts_kind CHECK (kind IN ('user', 'provider_clearing', 'boost_revenue')),
    CONSTRAINT chk_wallet_accounts_owner CHECK ((kind = 'user') = (owner_id IS NOT NULL)),
    CONSTRAINT chk_wallet_accounts_balance_range CHECK (balance BETWEEN -9007199254740991 AND 9007199254740991),
    CONSTRAINT chk_wallet_accounts_user_balance_non_negative CHECK (kind <> 'user' OR balance >= 0)
);

-- Un seul compte par utilisateur, un seul compte par type système.
CREATE UNIQUE INDEX uq_wallet_accounts_user_owner ON wallet_accounts (owner_id) WHERE kind = 'user';
CREATE UNIQUE INDEX uq_wallet_accounts_system_kind ON wallet_accounts (kind) WHERE kind <> 'user';

-- Comptes système (les comptes utilisateur sont créés à la demande par l'application).
INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES
    (gen_random_uuid(), 'provider_clearing', NULL, 0),
    (gen_random_uuid(), 'boost_revenue', NULL, 0);

-- ───────────── transactions et écritures ─────────────

CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL,
    reference TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Identifiant de la transaction SQL de PREMIER NIVEAU qui a créé la ligne (pg_current_xact_id() ignore les SAVEPOINT) :
    -- seules les écritures insérées par cette même transaction SQL peuvent s'y rattacher (voir wallet_guard_entry_insert).
    created_xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
    CONSTRAINT uq_wallet_transactions_reference UNIQUE (reference),
    CONSTRAINT chk_wallet_transactions_kind CHECK (kind IN ('topup', 'adjustment')),
    -- « <type>:<identifiant> » : la référence commence par le type de la transaction.
    CONSTRAINT chk_wallet_transactions_reference CHECK (
        reference ~ '^[a-z_]{1,20}:[A-Za-z0-9_.-]{1,100}$' AND starts_with(reference, kind || ':')
    ),
    -- Objet petit, clés autorisées seulement, valeurs textuelles de forme contrôlée : aucune donnée personnelle possible.
    CONSTRAINT chk_wallet_transactions_metadata CHECK (
        jsonb_typeof(metadata) = 'object'
        AND octet_length(metadata::text) <= 512
        AND (metadata - ARRAY['paymentIntentId', 'provider', 'reasonCode']) = '{}'::jsonb
        AND (NOT (metadata ? 'paymentIntentId') OR (
            jsonb_typeof(metadata -> 'paymentIntentId') = 'string'
            AND (metadata ->> 'paymentIntentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
        AND (NOT (metadata ? 'provider') OR (
            jsonb_typeof(metadata -> 'provider') = 'string' AND (metadata ->> 'provider') ~ '^[a-z_]{1,20}$'))
        AND (NOT (metadata ? 'reasonCode') OR (
            jsonb_typeof(metadata -> 'reasonCode') = 'string' AND (metadata ->> 'reasonCode') ~ '^[a-z_]{1,40}$'))
    ),
    -- Une recharge porte l'intention de paiement dont elle découle, et sa référence en dérive.
    CONSTRAINT chk_wallet_transactions_topup CHECK (
        kind <> 'topup' OR (metadata ? 'paymentIntentId' AND reference = 'topup:' || (metadata ->> 'paymentIntentId'))
    )
);

CREATE TABLE wallet_entries (
    id UUID PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES wallet_accounts(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_wallet_entries_amount_non_zero CHECK (amount <> 0),
    CONSTRAINT chk_wallet_entries_amount_range CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991),
    CONSTRAINT uq_wallet_entries_transaction_account UNIQUE (transaction_id, account_id)
);

CREATE INDEX idx_wallet_entries_account ON wallet_entries (account_id);

-- ───────────── intentions de paiement et événements du prestataire ─────────────

CREATE TABLE payment_intents (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount_xof BIGINT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    idempotency_key UUID NOT NULL,
    provider_reference TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    -- Bornes larges : les bornes métier (500 à 500 000, multiple de 100) sont des constantes réglables du code.
    CONSTRAINT chk_payment_intents_amount CHECK (amount_xof >= 1 AND amount_xof <= 9007199254740991),
    CONSTRAINT chk_payment_intents_provider CHECK (provider IN ('fake')),
    CONSTRAINT chk_payment_intents_status CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
    CONSTRAINT chk_payment_intents_provider_reference CHECK (provider_reference ~ '^[A-Za-z0-9_-]{8,64}$'),
    CONSTRAINT chk_payment_intents_expiry CHECK (expires_at > created_at),
    -- Cohérence : seule une intention en attente n'a pas de date de fin ; une date de fin n'est jamais antérieure à la création.
    CONSTRAINT chk_payment_intents_completed CHECK ((status = 'pending') = (completed_at IS NULL)),
    CONSTRAINT chk_payment_intents_completed_order CHECK (completed_at IS NULL OR completed_at >= created_at),
    CONSTRAINT uq_payment_intents_owner_idempotency UNIQUE (owner_id, idempotency_key),
    CONSTRAINT uq_payment_intents_provider_reference UNIQUE (provider, provider_reference)
);

-- Intentions en attente d'un utilisateur (limite) et intentions échues (balayage d'expiration).
CREATE INDEX idx_payment_intents_owner_pending ON payment_intents (owner_id) WHERE status = 'pending';
CREATE INDEX idx_payment_intents_due ON payment_intents (expires_at) WHERE status = 'pending';

-- Journal de TOUT événement du prestataire dont la signature était valide et la forme correcte. Un événement à signature
-- invalide n'est jamais stocké. Un même (provider, provider_event_id) n'est enregistré qu'une fois : la relecture d'un
-- événement déjà reçu n'ajoute aucune ligne. `duplicate` désigne un événement DISTINCT portant sur une intention déjà traitée.
CREATE TABLE payment_events (
    id UUID PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT,
    type TEXT NOT NULL,
    amount_xof BIGINT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    outcome TEXT NOT NULL,
    CONSTRAINT chk_payment_events_provider CHECK (provider IN ('fake')),
    CONSTRAINT chk_payment_events_event_id CHECK (provider_event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
    CONSTRAINT chk_payment_events_type CHECK (type IN ('payment.succeeded', 'payment.failed')),
    CONSTRAINT chk_payment_events_amount CHECK (amount_xof >= 1 AND amount_xof <= 9007199254740991),
    CONSTRAINT chk_payment_events_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_payment_events_outcome CHECK (
        outcome IN ('applied', 'duplicate', 'rejected_amount', 'rejected_state', 'rejected_unknown_intent')
    ),
    -- Une intention est rattachée à l'événement, sauf quand elle est inconnue.
    CONSTRAINT chk_payment_events_intent CHECK ((intent_id IS NULL) = (outcome = 'rejected_unknown_intent')),
    CONSTRAINT uq_payment_events_provider_event UNIQUE (provider, provider_event_id)
);

CREATE INDEX idx_payment_events_intent ON payment_events (intent_id) WHERE intent_id IS NOT NULL;

-- ───────────── déclencheurs ─────────────

-- Immuabilité : aucune ligne de ces tables n'est jamais modifiée ni supprimée.
CREATE FUNCTION wallet_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'wallet_immutable' USING
        ERRCODE = 'restrict_violation',
        DETAIL = TG_OP || ' interdit sur ' || TG_TABLE_NAME;
END
$$;

CREATE TRIGGER trg_wallet_transactions_immutable
    BEFORE UPDATE OR DELETE ON wallet_transactions
    FOR EACH ROW EXECUTE FUNCTION wallet_forbid_mutation();
CREATE TRIGGER trg_wallet_entries_immutable
    BEFORE UPDATE OR DELETE ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_forbid_mutation();
CREATE TRIGGER trg_payment_events_immutable
    BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION wallet_forbid_mutation();

-- Écritures d'une transaction validée : une transaction du grand livre est complète à son COMMIT. Une écriture ne peut se rattacher
-- qu'à une transaction créée par la MÊME transaction SQL de premier niveau (un parent inexistant est laissé à la clé étrangère).
CREATE FUNCTION wallet_guard_entry_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_xid XID8;
BEGIN
    SELECT created_xid INTO parent_xid FROM wallet_transactions WHERE id = NEW.transaction_id;
    IF FOUND AND parent_xid <> pg_current_xact_id() THEN
        RAISE EXCEPTION 'wallet_immutable' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'écriture ajoutée à une transaction déjà validée';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_wallet_entries_same_transaction
    BEFORE INSERT ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_guard_entry_insert();

-- Équilibre : la somme des écritures d'une transaction vaut zéro et il y en a au moins deux. Contrainte DIFFÉRÉE (vérifiée au
-- COMMIT), car les écritures s'insèrent une à une. Déclenchée aussi sur wallet_transactions : une transaction sans écriture est refusée.
CREATE FUNCTION wallet_assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_id UUID;
    entry_count INTEGER;
    entry_sum NUMERIC;
BEGIN
    IF TG_TABLE_NAME = 'wallet_transactions' THEN
        target_id := NEW.id;
    ELSE
        target_id := NEW.transaction_id;
    END IF;
    SELECT count(*), COALESCE(sum(amount), 0) INTO entry_count, entry_sum
      FROM wallet_entries WHERE transaction_id = target_id;
    IF entry_count < 2 OR entry_sum <> 0 THEN
        RAISE EXCEPTION 'wallet_transaction_unbalanced' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_wallet_transaction_balanced';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER trg_wallet_transactions_balanced
    AFTER INSERT ON wallet_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wallet_assert_transaction_balanced();
CREATE CONSTRAINT TRIGGER trg_wallet_entries_balanced
    AFTER INSERT ON wallet_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wallet_assert_transaction_balanced();

-- Solde : chaque écriture met à jour le solde de son compte dans la même transaction. Le CHECK du compte refuse tout solde
-- utilisateur négatif et fait donc échouer l'écriture, donc toute la transaction.
CREATE FUNCTION wallet_apply_entry_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE wallet_accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_wallet_entries_balance
    AFTER INSERT ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_apply_entry_to_balance();

-- Un compte naît à solde NUL ; il ne change ni de type, ni de propriétaire ; son solde ne change QUE par le déclencheur
-- ci-dessus (profondeur 2) ; il n'est jamais supprimé.
CREATE FUNCTION wallet_guard_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.balance <> 0 THEN
            RAISE EXCEPTION 'wallet_immutable' USING
                ERRCODE = 'restrict_violation',
                DETAIL = 'un compte naît à solde nul';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur wallet_accounts';
    END IF;
    IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'identité d''un compte immuable';
    END IF;
    IF NEW.balance <> OLD.balance AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'wallet_immutable' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'le solde ne change que par une écriture';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_wallet_accounts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON wallet_accounts
    FOR EACH ROW EXECUTE FUNCTION wallet_guard_account();

-- Intentions de paiement : créées en attente ; seuls le statut et la date de fin changent, dans les transitions
-- pending → succeeded | failed | expired, et expired → succeeded (paiement tardif : l'argent a été pris chez le prestataire).
-- succeeded et failed sont terminaux. Aucune suppression.
CREATE FUNCTION wallet_guard_payment_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'payment_intent_initial_status' USING
                ERRCODE = 'check_violation',
                CONSTRAINT = 'trg_payment_intents_guard';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur payment_intents';
    END IF;
    IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.amount_xof <> OLD.amount_xof OR NEW.provider <> OLD.provider
       OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.provider_reference <> OLD.provider_reference
       OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'champ immuable d''une intention de paiement';
    END IF;
    IF NOT (
        (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired'))
        OR (OLD.status = 'expired' AND NEW.status = 'succeeded')
    ) THEN
        RAISE EXCEPTION 'payment_intent_transition' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_payment_intents_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_payment_intents_guard
    BEFORE INSERT OR UPDATE OR DELETE ON payment_intents
    FOR EACH ROW EXECUTE FUNCTION wallet_guard_payment_intent();
