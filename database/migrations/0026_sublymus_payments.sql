-- Migration 0026 : vrai prestataire de paiement, Wave via Sublymus (lot PAY1). Voir PAIEMENT-WAVE.md.
--
-- Le prestataire fictif reste le défaut en développement ; ce lot AJOUTE un second prestataire, « sublymus », sans toucher au grand livre : le crédit d'une recharge passe par la MÊME
-- écriture (transaction `topup`, partie double, référence unique `topup:<intention>`). Cette migration ne contient AUCUNE donnée de configuration (ni clé, ni secret, ni identifiant de
-- gestionnaire) : tout cela vient de l'environnement du serveur.
--
--  1. le prestataire « sublymus » est admis sur les intentions et le journal des événements ; une intention Sublymus ÉCHOUÉE peut devenir réussie (paiement réussi arrivé après un
--     échec : l'argent a été pris, la recharge est créditée et une anomalie est journalisée) ; le prestataire fictif garde « échoué = terminal » ;
--  2. une intention Sublymus a TOUJOURS pour référence `noma-topup-<identifiant de l'intention>` (référence unique, stable : elle ne sert jamais pour un autre montant) ;
--  3. `sublymus_checkouts` : une ligne par intention Sublymus (créée avec l'intention, dans la même transaction) : session de paiement Wave (lien, identifiant chez Sublymus),
--     état du rattrapage (tentatives, prochaine tentative, issue) ;
--  4. `sublymus_webhook_deliveries` : une ligne par livraison de webhook AUTHENTIFIÉE (clé composite (X-Webhook-Id, empreinte du corps) : une livraison rejouée n'est jamais
--     retraitée, et une livraison qui crédite a TOUJOURS sa ligne, même si le même X-Webhook-Id a déjà servi pour un autre corps) ;
--  5. `sublymus_anomalies` : table de rapprochement : tout ce qui ne se rapproche pas (montant, devise, statut, référence inconnue…) est journalisé, rien n'est crédité.
--
-- Les données personnelles n'entrent dans aucune de ces tables : jamais de numéro de téléphone, jamais de payerId complet (une empreinte masquée seulement).

-- ───────────── 1. Prestataires admis ─────────────

ALTER TABLE payment_intents DROP CONSTRAINT chk_payment_intents_provider;
ALTER TABLE payment_intents ADD CONSTRAINT chk_payment_intents_provider CHECK (provider IN ('fake', 'sublymus'));
ALTER TABLE payment_events DROP CONSTRAINT chk_payment_events_provider;
ALTER TABLE payment_events ADD CONSTRAINT chk_payment_events_provider CHECK (provider IN ('fake', 'sublymus'));

-- Garde des intentions (même fonction qu'en 0014) : seule différence, la transition failed → succeeded est admise pour une intention SUBLYMUS.
CREATE OR REPLACE FUNCTION wallet_guard_payment_intent() RETURNS trigger
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
        OR (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD.provider = 'sublymus')
    ) THEN
        RAISE EXCEPTION 'payment_intent_transition' USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_payment_intents_guard';
    END IF;
    RETURN NEW;
END
$$;

-- ───────────── 2. Référence d'une intention Sublymus ─────────────

-- external_reference = 'noma-topup-' || identifiant de l'intention : unique par construction (l'identifiant l'est), stable, jamais réutilisée avec un autre montant (le montant d'une
-- intention est immuable : wallet_guard_payment_intent). La référence tient dans la forme déjà imposée aux références (8 à 64 caractères).
ALTER TABLE payment_intents ADD CONSTRAINT chk_payment_intents_sublymus_reference
    CHECK (provider <> 'sublymus' OR provider_reference = 'noma-topup-' || id::text);

-- ───────────── 3. Sessions de paiement et rattrapage ─────────────

CREATE TABLE sublymus_checkouts (
    intent_id UUID PRIMARY KEY REFERENCES payment_intents(id) ON DELETE RESTRICT,
    external_reference TEXT NOT NULL,
    -- Identifiant de l'intention chez Sublymus (réponse à la création, ou premier événement authentifié) et lien de paiement Wave : NULL tant que la session n'est pas créée.
    sublymus_intent_id TEXT,
    checkout_url TEXT,
    checkout_created_at TIMESTAMPTZ,
    -- Dernier statut lu chez Sublymus (WAVE_CREATED, COMPLETED, FAILED).
    provider_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Rattrapage : prochaine tentative (NULL quand il est terminé), nombre de tentatives, dernière tentative et son issue.
    next_catchup_at TIMESTAMPTZ,
    catchup_attempts INTEGER NOT NULL DEFAULT 0,
    last_catchup_at TIMESTAMPTZ,
    last_catchup_outcome TEXT,
    catchup_done_at TIMESTAMPTZ,
    CONSTRAINT uq_sublymus_checkouts_reference UNIQUE (external_reference),
    CONSTRAINT uq_sublymus_checkouts_sublymus_intent UNIQUE (sublymus_intent_id),
    CONSTRAINT chk_sublymus_checkouts_reference CHECK (external_reference ~ '^noma-topup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- Lot PAY1-ter (N7) : MÊME expression que SUBLYMUS_IDENTIFIER (lib/server/wallet/sublymus/config.ts), `.` et `:` compris (un test compare les deux). Commande équivalente pour une base
    -- où 0026 aurait déjà été appliquée (aucune ne l'est à ce jour) : ALTER TABLE sublymus_checkouts DROP CONSTRAINT chk_sublymus_checkouts_sublymus_intent,
    -- ADD CONSTRAINT chk_sublymus_checkouts_sublymus_intent CHECK (sublymus_intent_id IS NULL OR sublymus_intent_id ~ '^[A-Za-z0-9._:-]{1,100}$');
    CONSTRAINT chk_sublymus_checkouts_sublymus_intent CHECK (sublymus_intent_id IS NULL OR sublymus_intent_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
    CONSTRAINT chk_sublymus_checkouts_url CHECK (checkout_url IS NULL OR (checkout_url ~ '^https://[^[:space:]]+$' AND char_length(checkout_url) <= 2000 AND checkout_url !~ '^https://[^/]*@')),
    CONSTRAINT chk_sublymus_checkouts_created CHECK ((checkout_url IS NULL) = (checkout_created_at IS NULL)),
    CONSTRAINT chk_sublymus_checkouts_status CHECK (provider_status IS NULL OR provider_status ~ '^[A-Z_]{1,32}$'),
    CONSTRAINT chk_sublymus_checkouts_attempts CHECK (catchup_attempts >= 0 AND catchup_attempts <= 1000),
    CONSTRAINT chk_sublymus_checkouts_outcome CHECK (
        last_catchup_outcome IS NULL OR last_catchup_outcome IN ('waiting', 'not_found', 'completed', 'failed', 'anomaly', 'error', 'window_closed')),
    CONSTRAINT chk_sublymus_checkouts_done CHECK ((catchup_done_at IS NULL) OR next_catchup_at IS NULL)
);

-- Rattrapage : les sessions dont la prochaine tentative est échue.
CREATE INDEX idx_sublymus_checkouts_due ON sublymus_checkouts (next_catchup_at) WHERE next_catchup_at IS NOT NULL;

-- Garde : la ligne appartient à une intention SUBLYMUS et porte SA référence ; une fois posés, l'identifiant chez Sublymus et le lien ne changent plus ; rien ne se supprime.
CREATE FUNCTION sublymus_guard_checkout() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    intent_provider TEXT;
    intent_reference TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur sublymus_checkouts';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT provider, provider_reference INTO intent_provider, intent_reference FROM payment_intents WHERE id = NEW.intent_id;
        IF intent_provider IS DISTINCT FROM 'sublymus' OR intent_reference IS DISTINCT FROM NEW.external_reference THEN
            RAISE EXCEPTION 'sublymus_checkout_intent' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_sublymus_checkouts_guard';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.intent_id <> OLD.intent_id OR NEW.external_reference <> OLD.external_reference OR NEW.created_at <> OLD.created_at
       OR (OLD.sublymus_intent_id IS NOT NULL AND NEW.sublymus_intent_id IS DISTINCT FROM OLD.sublymus_intent_id)
       OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url)
       OR (OLD.checkout_created_at IS NOT NULL AND NEW.checkout_created_at IS DISTINCT FROM OLD.checkout_created_at) THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'champ immuable d''une session de paiement';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_sublymus_checkouts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON sublymus_checkouts
    FOR EACH ROW EXECUTE FUNCTION sublymus_guard_checkout();

-- ───────────── 4. Livraisons de webhook ─────────────

-- Une ligne par livraison AUTHENTIFIÉE (signature et gestionnaire vérifiés) et bien formée. La clé est COMPOSITE (`webhook_id`, `payload_sha256`) : `webhook_id` est l'en-tête
-- X-Webhook-Id (ou, s'il manque, l'empreinte du corps) ; la même livraison (même identifiant, même corps) reçue plusieurs fois n'est traitée qu'une fois, et un même identifiant
-- réutilisé avec un AUTRE corps ne masque jamais la livraison qui crédite : chaque corps a sa ligne. La ligne s'écrit dans la MÊME transaction que le crédit : si le traitement
-- échoue, la livraison n'est pas marquée reçue et Sublymus peut la rejouer.
CREATE TABLE sublymus_webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT,
    external_reference TEXT NOT NULL,
    sublymus_intent_id TEXT,
    payload_sha256 TEXT NOT NULL,
    outcome TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_sublymus_deliveries_webhook UNIQUE (webhook_id, payload_sha256),
    CONSTRAINT chk_sublymus_deliveries_webhook CHECK (webhook_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT chk_sublymus_deliveries_event CHECK (event IN ('payment.completed', 'payment.failed')),
    CONSTRAINT chk_sublymus_deliveries_reference CHECK (char_length(external_reference) BETWEEN 1 AND 100),
    CONSTRAINT chk_sublymus_deliveries_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_sublymus_deliveries_outcome CHECK (
        outcome IN ('applied', 'duplicate', 'rejected_amount', 'rejected_state', 'rejected_unknown_intent', 'anomaly'))
);

CREATE INDEX idx_sublymus_deliveries_intent ON sublymus_webhook_deliveries (intent_id) WHERE intent_id IS NOT NULL;

CREATE TRIGGER trg_sublymus_deliveries_immutable
    BEFORE UPDATE OR DELETE ON sublymus_webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION wallet_forbid_mutation();

-- ───────────── 5. Table de rapprochement (anomalies) ─────────────

-- Tout événement ou rattrapage authentifié qui ne se rapproche PAS de notre intention : rien n'est crédité, la ligne dit pourquoi. On répond tout de même 2xx au webhook :
-- Sublymus le rejouerait en boucle sans que rien ne change (le montant ne se corrigera pas) ; la table, elle, est la liste à traiter à la main (page /admin/paiements).
-- `dedupe_key` (identifiant de livraison, ou clé de rattrapage) rend l'écriture idempotente. Aucune donnée personnelle : `payer_hint` est un identifiant MASQUÉ.
CREATE TABLE sublymus_anomalies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT,
    external_reference TEXT NOT NULL,
    webhook_id TEXT,
    sublymus_intent_id TEXT,
    expected_amount_xof BIGINT,
    received_amount_xof BIGINT,
    received_currency TEXT,
    received_status TEXT,
    payer_hint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_sublymus_anomalies_dedupe UNIQUE (origin, dedupe_key, kind),
    CONSTRAINT chk_sublymus_anomalies_kind CHECK (kind IN (
        'amount_mismatch', 'currency_mismatch', 'status_mismatch', 'unknown_reference', 'payer_mismatch', 'source_mismatch',
        'intent_id_mismatch', 'event_mismatch', 'state_conflict', 'invalid_amount', 'duplicate_provider_intents', 'unreadable_event', 'unknown_event')),
    CONSTRAINT chk_sublymus_anomalies_origin CHECK (origin IN ('webhook', 'catchup')),
    CONSTRAINT chk_sublymus_anomalies_dedupe CHECK (char_length(dedupe_key) BETWEEN 1 AND 160),
    CONSTRAINT chk_sublymus_anomalies_reference CHECK (char_length(external_reference) BETWEEN 1 AND 100),
    CONSTRAINT chk_sublymus_anomalies_amounts CHECK (
        (expected_amount_xof IS NULL OR expected_amount_xof >= 1) AND (received_amount_xof IS NULL OR (received_amount_xof >= 0 AND received_amount_xof <= 9007199254740991))),
    CONSTRAINT chk_sublymus_anomalies_text CHECK (
        (received_currency IS NULL OR char_length(received_currency) <= 8) AND (received_status IS NULL OR char_length(received_status) <= 32)
        AND (payer_hint IS NULL OR char_length(payer_hint) <= 16)),
    CONSTRAINT chk_sublymus_anomalies_resolved CHECK ((resolved_by IS NULL) OR resolved_at IS NOT NULL)
);

CREATE INDEX idx_sublymus_anomalies_open ON sublymus_anomalies (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_sublymus_anomalies_intent ON sublymus_anomalies (intent_id) WHERE intent_id IS NOT NULL;

-- Une anomalie n'est jamais modifiée ni supprimée, sauf pour être MARQUÉE traitée (resolved_at et resolved_by, une seule fois).
CREATE FUNCTION sublymus_guard_anomaly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'DELETE interdit sur sublymus_anomalies';
    END IF;
    IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.origin <> OLD.origin OR NEW.dedupe_key <> OLD.dedupe_key
       OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.external_reference <> OLD.external_reference OR NEW.webhook_id IS DISTINCT FROM OLD.webhook_id
       OR NEW.sublymus_intent_id IS DISTINCT FROM OLD.sublymus_intent_id OR NEW.expected_amount_xof IS DISTINCT FROM OLD.expected_amount_xof
       OR NEW.received_amount_xof IS DISTINCT FROM OLD.received_amount_xof OR NEW.received_currency IS DISTINCT FROM OLD.received_currency
       OR NEW.received_status IS DISTINCT FROM OLD.received_status OR NEW.payer_hint IS DISTINCT FROM OLD.payer_hint OR NEW.created_at <> OLD.created_at
       OR OLD.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'wallet_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'champ immuable d''une anomalie de rapprochement';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_sublymus_anomalies_guard
    BEFORE UPDATE OR DELETE ON sublymus_anomalies
    FOR EACH ROW EXECUTE FUNCTION sublymus_guard_anomaly();
