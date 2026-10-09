-- Migration 0028 : recherche active PAYANTE par besoin (lot RA1)
-- Additive : ne modifie ni 0001 à 0021 ni 0025, ni aucune ligne existante. Elle remplace seulement des contraintes CHECK NOMMÉES (comptes, types de transaction, métadonnées du grand livre,
-- genres et forme des notifications : DROP puis ADD, dans un bloc délimité de cette migration), la fonction de garde des comptes du grand livre (CREATE OR REPLACE) et rend `offer_id` NULLABLE dans
-- `notification_deliveries` (un envoi externe peut maintenant porter une annonce d'AUTRE SITE). Monnaie : XOF, entiers BIGINT. Aucun prestataire réel. Jamais appliquée à noma_dev
-- sans sauvegarde ni instruction explicite.
--
-- PRIX PROVISOIRE : 2 000 FCFA pour 30 jours (valeur de départ, en code : lib/server/active-search/config.ts), en attente d'une décision du fondateur. Le prix payé est conservé sur
-- chaque achat : changer le prix de départ ne touche jamais un achat existant.
--
-- La « recherche active » est une option payante PAR BESOIN :
--   * annonces d'AUTRES SITES notifiées (genre `new_external_match`) quand une annonce NOUVELLE compatible apparaît pour le besoin ;
--   * collecte de la surveillance de marché partagée plus fréquente (1 h au lieu de 6 h) tant qu'au moins un besoin actif de la clé l'a ;
--   * suivi des notifications prolongeable jusqu'à 180 jours (au lieu de 90) tant que l'option est active.
-- Elle se paie en crédits PAYÉS uniquement (jamais en crédits promotionnels : le garde ci-dessous et la contrainte du grand livre l'interdisent), sans renouvellement automatique,
-- sans remboursement automatique (un remboursement INTÉGRAL par l'administration reste possible, commande `active-search:refund`).
--
-- active_search_purchases : un achat = une période de l'option pour un besoin, payée par UNE transaction du grand livre (`search_purchase` : acheteur −prix, compte
--   système `active_search_revenue` +prix). `kind` : activation (la période commence maintenant) ou extension (elle commence à la fin de la période en cours : périodes contiguës).
--   Idempotent par (utilisateur, clé d'idempotence). `status` : active, ended (échéance), stopped (besoin ARCHIVÉ, ou remboursée : un besoin « satisfait » SUSPEND l'option sans l'arrêter). Immuable sauf statut, arrêt,
--   remboursement et avis. Deux périodes en vigueur d'un même besoin ne se chevauchent jamais (déclencheur).
-- active_search_state : une ligne par besoin qui a eu l'option : l'annonce déjà présente à l'activation (ou à la dernière modification du besoin) ne notifie jamais.
-- active_search_seen : annonces d'autres sites déjà connues d'un besoin (présentes à l'activation, déjà notifiées, ou doublon vérifié d'une annonce déjà vue) : une annonce n'est notifiée qu'UNE fois par besoin.

-- ───────────── 1. Grand livre ─────────────

-- Les deux types de transaction se nomment `search_purchase` et `search_refund` : le préfixe d'une référence du grand livre (`<type>:<identifiant>`) compte 20 caractères au plus.

ALTER TABLE wallet_accounts DROP CONSTRAINT chk_wallet_accounts_kind;
ALTER TABLE wallet_accounts ADD CONSTRAINT chk_wallet_accounts_kind CHECK (kind IN
    ('user', 'user_promo', 'provider_clearing', 'boost_revenue', 'subscription_revenue', 'promo_issuance', 'promo_consumed', 'promo_expired', 'active_search_revenue'));

INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), 'active_search_revenue', NULL, 0);

ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_kind;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_kind
    CHECK (kind IN ('topup', 'adjustment', 'boost_purchase', 'boost_refund', 'subscription_charge', 'subscription_refund', 'promo_expiry', 'search_purchase', 'search_refund'));

-- Une clé de plus : activeSearchId (UUID). Aucune donnée personnelle possible.
ALTER TABLE wallet_transactions DROP CONSTRAINT chk_wallet_transactions_metadata;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 512
    AND (metadata - ARRAY['paymentIntentId', 'provider', 'reasonCode', 'boostPurchaseId', 'quoteId', 'subscriptionPeriodId', 'promoGrantId', 'activeSearchId']) = '{}'::jsonb
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
    AND (NOT (metadata ? 'activeSearchId') OR (
        jsonb_typeof(metadata -> 'activeSearchId') = 'string'
        AND (metadata ->> 'activeSearchId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);

-- Forme EXACTE des métadonnées des deux nouveaux types ; la référence dérive de l'achat (un seul débit et un seul remboursement par achat : UNIQUE de la référence).
-- Les autres types ne portent pas la clé activeSearchId.
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_transactions_active_search CHECK (
    (kind = 'search_purchase'
        AND (metadata - ARRAY['activeSearchId']) = '{}'::jsonb
        AND metadata ? 'activeSearchId'
        AND reference = 'search_purchase:' || (metadata ->> 'activeSearchId'))
    OR (kind = 'search_refund'
        AND (metadata - ARRAY['activeSearchId', 'reasonCode']) = '{}'::jsonb
        AND metadata ? 'activeSearchId' AND metadata ? 'reasonCode'
        AND reference = 'search_refund:' || (metadata ->> 'activeSearchId'))
    OR (kind NOT IN ('search_purchase', 'search_refund') AND NOT (metadata ? 'activeSearchId'))
);

-- Garde des comptes : celle de l'offre Pro (0021) + le compte de revenus de la recherche active, crédité par un achat et débité par son remboursement. Un compte
-- promotionnel n'admet toujours QUE les types de transaction de son rôle : un achat de recherche active ne peut donc jamais être payé en crédits promotionnels.
CREATE OR REPLACE FUNCTION wallet_guard_account_usage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    account_kind TEXT;
    transaction_kind TEXT;
    allowed BOOLEAN;
BEGIN
    SELECT kind INTO account_kind FROM wallet_accounts WHERE id = NEW.account_id;
    IF account_kind IS NULL OR account_kind NOT IN ('user_promo', 'promo_issuance', 'promo_consumed', 'promo_expired', 'subscription_revenue', 'active_search_revenue') THEN
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
        WHEN 'active_search_revenue' THEN
            (transaction_kind = 'search_purchase' AND NEW.amount > 0) OR (transaction_kind = 'search_refund' AND NEW.amount < 0)
    END;
    IF allowed IS NOT TRUE THEN
        RAISE EXCEPTION 'wallet_account_usage' USING
            ERRCODE = 'restrict_violation',
            DETAIL = 'ce type de transaction ne peut pas écrire sur ce compte, ni dans ce sens';
    END IF;
    RETURN NEW;
END
$$;

-- ───────────── 2. Achats d'options ─────────────

CREATE TABLE active_search_purchases (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
    number INTEGER NOT NULL CHECK (number >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('activation', 'extension')),
    price_xof BIGINT NOT NULL CHECK (price_xof > 0 AND price_xof <= 9007199254740991),
    duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'stopped')),
    stopped_at TIMESTAMPTZ,
    stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('demand_archived', 'refunded')),
    refunded_at TIMESTAMPTZ,
    refund_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
    idempotency_key UUID NOT NULL,
    notice_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_active_search_purchases_idempotency UNIQUE (user_id, idempotency_key),
    CONSTRAINT uq_active_search_purchases_number UNIQUE (demand_id, number),
    CONSTRAINT uq_active_search_purchases_transaction UNIQUE (transaction_id),
    CONSTRAINT chk_active_search_purchases_period CHECK (ends_at > starts_at),
    CONSTRAINT chk_active_search_purchases_stop CHECK ((status = 'stopped') = (stop_reason IS NOT NULL) AND (stop_reason IS NULL) = (stopped_at IS NULL)),
    CONSTRAINT chk_active_search_purchases_refund CHECK ((refunded_at IS NULL) = (refund_transaction_id IS NULL))
);

CREATE INDEX idx_active_search_purchases_demand ON active_search_purchases (demand_id, ends_at DESC);
CREATE INDEX idx_active_search_purchases_user ON active_search_purchases (user_id, created_at DESC);
CREATE INDEX idx_active_search_purchases_live ON active_search_purchases (ends_at) WHERE status = 'active';

-- Deux périodes en vigueur d'un même besoin ne se chevauchent jamais (les extensions sont contiguës).
CREATE FUNCTION active_search_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM active_search_purchases p
         WHERE p.demand_id = NEW.demand_id AND p.status = 'active' AND tstzrange(p.starts_at, p.ends_at) && tstzrange(NEW.starts_at, NEW.ends_at)
    ) THEN
        RAISE EXCEPTION 'active_search_overlap' USING ERRCODE = 'restrict_violation', DETAIL = 'Deux périodes de recherche active d''un même besoin ne se chevauchent pas.';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_active_search_no_overlap
    BEFORE INSERT ON active_search_purchases
    FOR EACH ROW EXECUTE FUNCTION active_search_no_overlap();

-- Écritures d'un achat : `search_purchase` = acheteur −prix, active_search_revenue +prix ; `search_refund` = l'inverse INTÉGRAL. Exactement DEUX écritures, référence dérivée
-- de l'achat. Utilisée par les déclencheurs ci-dessous ET par `wallet:check`.
CREATE FUNCTION active_search_ledger_matches(
    p_transaction UUID, p_kind TEXT, p_purchase UUID, p_user UUID, p_price BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    user_sign INTEGER;
BEGIN
    IF p_transaction IS NULL THEN
        RETURN FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions t
                    WHERE t.id = p_transaction AND t.kind = p_kind AND t.reference = p_kind || ':' || p_purchase::text) THEN
        RETURN FALSE;
    END IF;
    user_sign := CASE p_kind WHEN 'search_purchase' THEN -1 ELSE 1 END;
    IF (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = p_transaction) <> 2 THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                    WHERE e.transaction_id = p_transaction AND a.kind = 'user' AND a.owner_id = p_user AND e.amount = user_sign * p_price)
       AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                    WHERE e.transaction_id = p_transaction AND a.kind = 'active_search_revenue' AND e.amount = -user_sign * p_price);
END
$$;

-- Un achat naît dans son état initial (en vigueur, jamais remboursé, aucun avis) ET payé : sa transaction du grand livre est le débit de CE prix en crédits payés de CET utilisateur ;
-- sa période dure EXACTEMENT `duration_days` jours (calcul en UTC, comme l'application) ; l'acheteur est le PROPRIÉTAIRE du besoin.
CREATE FUNCTION active_search_purchases_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'active' OR NEW.stopped_at IS NOT NULL OR NEW.refunded_at IS NOT NULL OR NEW.notice_sent_at IS NOT NULL THEN
        RAISE EXCEPTION 'active_search_purchase_initial_state' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_purchases_insert_guard';
    END IF;
    IF NEW.ends_at <> ((NEW.starts_at AT TIME ZONE 'UTC') + make_interval(days => NEW.duration_days)) AT TIME ZONE 'UTC' THEN
        RAISE EXCEPTION 'active_search_purchase_period_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_purchases_insert_guard';
    END IF;
    IF NEW.user_id IS DISTINCT FROM (SELECT d.owner_id FROM demands d WHERE d.id = NEW.demand_id) THEN
        RAISE EXCEPTION 'active_search_purchase_owner_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_purchases_insert_guard';
    END IF;
    IF NOT active_search_ledger_matches(NEW.transaction_id, 'search_purchase', NEW.id, NEW.user_id, NEW.price_xof) THEN
        RAISE EXCEPTION 'active_search_purchase_ledger_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_purchases_insert_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_active_search_purchases_insert_guard
    BEFORE INSERT ON active_search_purchases
    FOR EACH ROW EXECUTE FUNCTION active_search_purchases_insert_guard();

-- Un achat est un enregistrement financier : prix, période, propriétaire, besoin, transaction et clé ne changent jamais ; seuls statut, arrêt, remboursement et avis évoluent,
-- dans un seul sens (un état final reste final), et un achat ne se supprime pas.
CREATE FUNCTION active_search_purchases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'active_search_purchase_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.demand_id <> OLD.demand_id OR NEW.number <> OLD.number OR NEW.kind <> OLD.kind
       OR NEW.price_xof <> OLD.price_xof OR NEW.duration_days <> OLD.duration_days OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at
       OR NEW.transaction_id <> OLD.transaction_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'active_search_purchase_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'active' AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'active_search_status_final' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Un état final reste final jusque dans ses dates et sa raison ; un avis envoyé ne change plus (NULL → valeur seulement).
    IF OLD.status <> 'active' AND (NEW.stop_reason IS DISTINCT FROM OLD.stop_reason OR NEW.stopped_at IS DISTINCT FROM OLD.stopped_at) THEN
        RAISE EXCEPTION 'active_search_stop_final' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.notice_sent_at IS NOT NULL AND NEW.notice_sent_at IS DISTINCT FROM OLD.notice_sent_at THEN
        RAISE EXCEPTION 'active_search_notice_final' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.refunded_at IS NOT NULL AND (NEW.refunded_at IS DISTINCT FROM OLD.refunded_at OR NEW.refund_transaction_id IS DISTINCT FROM OLD.refund_transaction_id) THEN
        RAISE EXCEPTION 'active_search_refund_final' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.refunded_at IS NULL AND NEW.refunded_at IS NOT NULL
       AND NOT active_search_ledger_matches(NEW.refund_transaction_id, 'search_refund', NEW.id, NEW.user_id, NEW.price_xof) THEN
        RAISE EXCEPTION 'active_search_refund_ledger_mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_purchases_guard';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_active_search_purchases_guard
    BEFORE UPDATE OR DELETE ON active_search_purchases
    FOR EACH ROW EXECUTE FUNCTION active_search_purchases_guard();

-- Cohérence au COMMIT : un débit ou un remboursement de recherche active n'existe jamais sans son achat (comme les transactions de l'offre Pro).
CREATE FUNCTION active_search_transactions_assert_linked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'search_purchase' THEN
        IF NOT EXISTS (SELECT 1 FROM active_search_purchases p WHERE p.transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'active_search_purchase_unlinked' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_transactions_linked';
        END IF;
    ELSIF NEW.kind = 'search_refund' THEN
        IF NOT EXISTS (SELECT 1 FROM active_search_purchases p WHERE p.refund_transaction_id = NEW.id) THEN
            RAISE EXCEPTION 'active_search_refund_unlinked' USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_active_search_transactions_linked';
        END IF;
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER trg_active_search_transactions_linked
    AFTER INSERT ON wallet_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.kind IN ('search_purchase', 'search_refund')) EXECUTE FUNCTION active_search_transactions_assert_linked();

-- Fin de la CHAÎNE contiguë qui commence à un achat (lot RA1-bis) : une extension commence exactement à la fin de la précédente. L'avis d'échéance lit CETTE fin, jamais la fin de sa seule
-- période : une prolongation payée après l'avis ne laisse pas afficher une date dépassée. Un achat remboursé ne prolonge rien.
CREATE FUNCTION active_search_chain_end(p_purchase UUID) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain(id, demand_id, ends_at, depth) AS (
        SELECT p.id, p.demand_id, p.ends_at, 0 FROM active_search_purchases p WHERE p.id = p_purchase
        UNION ALL
        SELECT q.id, q.demand_id, q.ends_at, c.depth + 1
          FROM chain c JOIN active_search_purchases q ON q.demand_id = c.demand_id AND q.starts_at = c.ends_at AND q.refunded_at IS NULL
         WHERE c.depth < 12
    )
    SELECT max(ends_at) FROM chain
$$;

CREATE TABLE active_search_state (
    demand_id UUID PRIMARY KEY REFERENCES demands(id) ON DELETE CASCADE,
    -- Vrai tant que la liste des annonces d'autres sites DÉJÀ PRÉSENTES à l'activation n'a pas été relevée (la surveillance du besoin n'avait encore jamais été collectée) :
    -- la première collecte qui suit relève cette liste sans notifier.
    baseline_pending BOOLEAN NOT NULL,
    baseline_taken_at TIMESTAMPTZ,
    -- Clé produit du besoin au dernier relevé : une modification qui CHANGE la clé (modèle, marque…) est un relevé complet de la nouvelle clé (rien d'existant ne notifie), une qui la garde
    -- laisse nouvelles les annonces vues pour la première fois depuis le dernier examen.
    product_key TEXT,
    -- Instant avant lequel une annonce est « existante » : une annonce d'un autre site dont `first_seen_at` ne dépasse pas cet instant ne notifie JAMAIS, quel que soit le chemin (défense en
    -- profondeur du relevé). À l'activation : l'instant du relevé. Au relevé d'un besoin modifié : le dernier horizon de balayage (les annonces vues pour la première fois depuis restent nouvelles).
    baseline_cutoff_at TIMESTAMPTZ,
    -- Instant (horloge du processus) du dernier examen COMPLET du besoin (relevé ou balayage) ; jamais remis à zéro par une pause.
    scan_horizon_at TIMESTAMPTZ,
    -- Version du contenu du besoin au moment du relevé : un besoin modifié (budget relevé…) relève une nouvelle liste sans notifier (comme N1 : modifier un besoin ne notifie pas l'existant).
    content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
    -- Dernier balayage des annonces d'autres sites pour ce besoin (étape « activeSearch » du worker, APRÈS la collecte) : un besoin n'est réexaminé que si sa surveillance a été collectée
    -- depuis (`market_watches.last_run_at > scanned_at`). NULL : jamais balayé, ou balayage à refaire (suivi en pause ou échu pendant le dernier passage).
    scanned_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_active_search_state_baseline CHECK (baseline_pending = (baseline_taken_at IS NULL) AND baseline_pending = (baseline_cutoff_at IS NULL))
);

CREATE TABLE active_search_seen (
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES external_listings(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('baseline', 'notified', 'duplicate')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (demand_id, listing_id)
);

CREATE INDEX idx_active_search_seen_listing ON active_search_seen (listing_id);

-- ───────────── 3. Notifications ─────────────

ALTER TABLE notifications ADD COLUMN external_listing_id UUID REFERENCES external_listings(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN source_name TEXT CHECK (source_name IS NULL OR char_length(btrim(source_name)) BETWEEN 1 AND 80);
ALTER TABLE notifications ADD COLUMN active_search_id UUID REFERENCES active_search_purchases(id) ON DELETE CASCADE;

-- ═══════════════ DÉBUT DU BLOC « CONTRAINTES DE LA TABLE notifications » ═══════════════
-- Ce bloc SUPPRIME puis RECRÉE les deux contraintes qui décrivent les genres de notification et leur forme. Il est délimité exprès : le lot des missions (migration 0027) a ajouté
-- avant lui un genre (`mission_coverage`) et une colonne (`mission_id`) à ces deux contraintes ; ce bloc les REPREND (union des genres, `mission_id IS NULL` dans chaque autre branche)
-- et c'est le SEUL endroit où les genres des deux lots sont réunis :
--   * genres : la liste de `notifications_kind_check` = 'new_match', 'new_matches_digest', 'new_message' (lots N1, D2), 'mission_coverage' (lot MV1, migration 0027),
--     'new_external_match', 'active_search_expiring' (ce lot) ;
--   * forme : chaque branche de `chk_notifications_shape` exige NULL pour les colonnes qui ne lui appartiennent pas (`external_listing_id`, `source_name`, `active_search_id` ici ;
--     `mission_id` pour les missions), de sorte qu'ajouter une colonne à un genre ajoute `IS NULL` aux branches des autres genres.
-- La forme attendue de chaque genre est décrite dans RECHERCHE-ACTIVE.md (section « Contraintes de notifications à fusionner »).
ALTER TABLE notifications DROP CONSTRAINT chk_notifications_shape;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('new_match', 'new_matches_digest', 'new_message', 'mission_coverage', 'new_external_match', 'active_search_expiring'));
ALTER TABLE notifications ADD CONSTRAINT chk_notifications_shape CHECK (
    (kind = 'new_match' AND offer_id IS NOT NULL AND conversation_id IS NULL AND digest_day IS NULL AND item_count IS NULL
        AND mission_id IS NULL AND external_listing_id IS NULL AND source_name IS NULL AND active_search_id IS NULL
        AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    (kind = 'new_matches_digest' AND offer_id IS NULL AND conversation_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
        AND mission_id IS NULL AND external_listing_id IS NULL AND source_name IS NULL AND active_search_id IS NULL
        AND title IS NULL AND price_amount IS NULL AND price_currency IS NULL)
    OR
    (kind = 'new_message' AND offer_id IS NOT NULL AND conversation_id IS NOT NULL AND digest_day IS NULL AND item_count IS NULL
        AND mission_id IS NULL AND external_listing_id IS NULL AND source_name IS NULL AND active_search_id IS NULL
        AND price_amount IS NULL AND price_currency IS NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    -- Couverture d'une mission (lot MV1, migration 0027) : une par mission et par jour UTC (`digest_day`), `item_count` = quantité couverte ; aucune colonne des lots N1 / EXT1 / RA1.
    (kind = 'mission_coverage' AND mission_id IS NOT NULL AND offer_id IS NULL AND conversation_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
        AND external_listing_id IS NULL AND source_name IS NULL AND active_search_id IS NULL
        AND price_amount IS NULL AND price_currency IS NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    -- Annonce d'un AUTRE SITE (recherche active) : titre nettoyé, prix, nom de la source ; jamais l'URL externe (le lien est reconstruit : la page du besoin).
    (kind = 'new_external_match' AND offer_id IS NULL AND conversation_id IS NULL AND mission_id IS NULL AND active_search_id IS NULL AND digest_day IS NULL AND item_count IS NULL
        AND source_name IS NOT NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    -- Avis d'échéance (3 jours avant la fin de la dernière période) : aucune donnée d'annonce.
    (kind = 'active_search_expiring' AND active_search_id IS NOT NULL AND offer_id IS NULL AND conversation_id IS NULL AND mission_id IS NULL AND external_listing_id IS NULL AND source_name IS NULL
        AND digest_day IS NULL AND item_count IS NULL AND title IS NULL AND price_amount IS NULL AND price_currency IS NULL)
);
-- ═══════════════ FIN DU BLOC « CONTRAINTES DE LA TABLE notifications » ═══════════════

-- Une notification par (utilisateur, besoin, annonce d'autre site) ; un seul avis d'échéance par achat.
CREATE UNIQUE INDEX uq_notifications_new_external_match ON notifications (user_id, kind, demand_id, external_listing_id) WHERE kind = 'new_external_match';
CREATE UNIQUE INDEX uq_notifications_active_search_expiring ON notifications (active_search_id) WHERE kind = 'active_search_expiring';

-- Envois externes simulés : une ligne peut maintenant porter une annonce d'un autre site (`external_listing_id`) au lieu d'une annonce interne (`offer_id`) ; exactement l'une des deux.
ALTER TABLE notification_deliveries ADD COLUMN external_listing_id UUID REFERENCES external_listings(id) ON DELETE CASCADE;
ALTER TABLE notification_deliveries ALTER COLUMN offer_id DROP NOT NULL;
ALTER TABLE notification_deliveries ADD CONSTRAINT chk_notification_deliveries_target CHECK ((offer_id IS NULL) <> (external_listing_id IS NULL));

-- ───────────── 4. Collecte accélérée ─────────────

-- Une surveillance accélérée par la recherche active garde ce qu'elle avait AVANT (fréquence et budget de base) : l'accélération ne ralentit jamais une surveillance déjà plus rapide
-- (plus petit intervalle, plus grand budget) et la décélération rétablit exactement les valeurs de base.
ALTER TABLE market_watches ADD COLUMN accelerated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE market_watches ADD COLUMN base_frequency_seconds INTEGER CHECK (base_frequency_seconds IS NULL OR base_frequency_seconds BETWEEN 60 AND 2592000);
ALTER TABLE market_watches ADD COLUMN base_daily_request_budget INTEGER CHECK (base_daily_request_budget IS NULL OR base_daily_request_budget BETWEEN 0 AND 1000);
ALTER TABLE market_watches ADD CONSTRAINT chk_market_watches_accelerated
    CHECK (accelerated = (base_frequency_seconds IS NOT NULL) AND accelerated = (base_daily_request_budget IS NOT NULL));

-- Part du quota journalier d'une source consommée par les surveillances ACCÉLÉRÉES (au plus la moitié du quota : la part ordinaire est réservée, voir RECHERCHE-ACTIVE.md).
ALTER TABLE external_source_usage ADD COLUMN accelerated_requests INTEGER NOT NULL DEFAULT 0 CHECK (accelerated_requests >= 0);
ALTER TABLE external_source_usage ADD CONSTRAINT chk_external_source_usage_accelerated CHECK (accelerated_requests <= requests);
