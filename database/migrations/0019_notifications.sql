-- Migration 0019 : notifications de nouvelles correspondances et suivi des besoins (lot N1)
-- Additive : ne modifie ni 0001 à 0018 ni aucune ligne existante, sauf la colonne ajoutée à `demands` (remplie ci-dessous).
-- Aucun envoi réel : le seul transport existe en développement (console), voir NOTIFICATIONS.md.
--
-- demands.notify_until / notify_paused : SUIVI d'un besoin (« recherche active » interne). Le matching continue pendant une pause ou après l'expiration ; seules les
--   notifications s'arrêtent. Par défaut `created_at + 30 jours` (déclencheur ci-dessous) ; les besoins qui existent déjà reçoivent maintenant + 30 jours.
-- notifications : notifications DANS l'application. Une ligne `new_match` par (utilisateur, besoin, annonce) : écrite dans la MÊME transaction que l'évaluation qui
--   devient une correspondance confirmée et fraîche pour la première fois, pour une ANNONCE NOUVELLE pour ce besoin (ON CONFLICT DO NOTHING : un rejeu ne crée
--   jamais de doublon). Au-delà de 20 par besoin ou de 50 par utilisateur et par jour UTC, une seule ligne `new_matches_digest` (« N nouvelles annonces ») par
--   besoin et par jour UTC ; `item_count` qui augmente remet `read_at` à NULL. Contenu en liste blanche : titre, prix, lien.
-- notification_deliveries : OUTBOX des envois hors de l'application (canal simulé `sms_sim`), une ligne par ANNONCE d'un utilisateur qui a choisi d'être prévenu
--   (y compris celles qui vont dans un résumé : `notification_id` désigne alors le résumé) ; contenu figé ; envoyable après la fenêtre de collecte (15 min) ;
--   regroupée en UN message par utilisateur, dont la composition (`batch_key`) est FIGÉE avant l'envoi : une nouvelle tentative réutilise le même lot et la même clé.
-- notification_preferences : choix de l'utilisateur (envoi externe simulé), désactivé par défaut.

ALTER TABLE demands ADD COLUMN notify_until TIMESTAMPTZ;
ALTER TABLE demands ADD COLUMN notify_paused BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE demands SET notify_until = CURRENT_TIMESTAMP + INTERVAL '30 days' WHERE notify_until IS NULL;

CREATE FUNCTION demands_default_notify_until() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.notify_until IS NULL THEN
        NEW.notify_until := NEW.created_at + INTERVAL '30 days';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_demands_default_notify_until
    BEFORE INSERT ON demands
    FOR EACH ROW EXECUTE FUNCTION demands_default_notify_until();

ALTER TABLE demands ALTER COLUMN notify_until SET NOT NULL;
ALTER TABLE demands ADD CONSTRAINT chk_demands_notify_until_after_creation CHECK (notify_until >= created_at);

CREATE TABLE notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    external_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('new_match', 'new_matches_digest')),
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
    digest_day DATE,
    -- Liste blanche : titre (marque, modèle, variante nettoyés), prix et lien reconstruit à la lecture. Jamais de téléphone, d'identifiant du vendeur ni de texte libre.
    title TEXT,
    price_amount BIGINT CHECK (price_amount IS NULL OR (price_amount >= 0 AND price_amount <= 9007199254740991)),
    price_currency TEXT CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
    item_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    read_at TIMESTAMPTZ,
    CONSTRAINT chk_notifications_shape CHECK (
        (kind = 'new_match' AND offer_id IS NOT NULL AND digest_day IS NULL AND item_count IS NULL
            AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
        OR
        (kind = 'new_matches_digest' AND offer_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
            AND title IS NULL AND price_amount IS NULL AND price_currency IS NULL)
    ),
    CONSTRAINT chk_notifications_price_pair CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
    CONSTRAINT chk_notifications_read_after_creation CHECK (read_at IS NULL OR read_at >= created_at)
);

-- Une seule notification par couple (utilisateur, besoin, annonce) : base de l'absence de doublon (rejeu, panne, réévaluation).
CREATE UNIQUE INDEX uq_notifications_new_match ON notifications (user_id, kind, demand_id, offer_id) WHERE kind = 'new_match';
-- Un seul résumé par besoin et par jour UTC.
CREATE UNIQUE INDEX uq_notifications_digest ON notifications (demand_id, digest_day) WHERE kind = 'new_matches_digest';
-- Lecture de l'utilisateur (plus récentes d'abord, curseur) et compteur de non-lues.
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX idx_notifications_user_unread ON notifications (user_id) WHERE read_at IS NULL;
-- Plafond par besoin et par jour.
CREATE INDEX idx_notifications_demand_created ON notifications (demand_id, created_at) WHERE kind = 'new_match';
-- Purge de rétention.
CREATE INDEX idx_notifications_read_at ON notifications (read_at) WHERE read_at IS NOT NULL;
CREATE INDEX idx_notifications_created_at ON notifications (created_at);

CREATE TABLE notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('sms_sim')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    -- Contenu figé à la création (liste blanche : titre, prix, lien). Le message regroupé n'en reprend que le nombre d'annonces et un lien vers /notifications.
    content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    -- Codes stables seulement (jamais un message brut).
    last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,60}$'),
    reason TEXT CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,60}$'),
    batch_key TEXT CHECK (batch_key IS NULL OR batch_key ~ '^[0-9a-f]{32}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    sent_at TIMESTAMPTZ,
    CONSTRAINT uq_notification_deliveries_idempotency UNIQUE (idempotency_key),
    CONSTRAINT chk_notification_deliveries_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    -- `batch_key` (clé d'idempotence du message) est posée quand le lot est figé, AVANT l'envoi ; un envoi marqué envoyé en porte toujours une.
    CONSTRAINT chk_notification_deliveries_sent_batch CHECK (status <> 'sent' OR batch_key IS NOT NULL),
    CONSTRAINT chk_notification_deliveries_sent_attempts CHECK (status <> 'sent' OR attempts >= 1),
    CONSTRAINT chk_notification_deliveries_failed CHECK (status <> 'failed' OR attempts = 3),
    CONSTRAINT chk_notification_deliveries_pending CHECK (status <> 'pending' OR attempts < 3),
    CONSTRAINT chk_notification_deliveries_reason CHECK (status NOT IN ('skipped', 'cancelled') OR reason IS NOT NULL)
);

-- Prise des envois : les échéances en attente, dans l'ordre.
CREATE INDEX idx_notification_deliveries_due ON notification_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_notification_deliveries_user_pending ON notification_deliveries (user_id, next_attempt_at) WHERE status = 'pending';
-- Lot figé en attente d'un nouvel essai (un seul à la fois par utilisateur).
CREATE INDEX idx_notification_deliveries_user_frozen ON notification_deliveries (user_id) WHERE status = 'pending' AND batch_key IS NOT NULL;
-- Annulation d'un besoin satisfait ou archivé.
CREATE INDEX idx_notification_deliveries_demand_pending ON notification_deliveries (demand_id) WHERE status = 'pending';
-- Plafond d'envois par utilisateur et par jour UTC.
CREATE INDEX idx_notification_deliveries_user_sent ON notification_deliveries (user_id, sent_at) WHERE status = 'sent';
-- Purge de rétention.
CREATE INDEX idx_notification_deliveries_created_at ON notification_deliveries (created_at);

-- notification_silent_evaluations : évaluations confirmées écrites SANS pouvoir notifier parce que l'annonce n'était pas NOUVELLE pour le besoin (job côté besoin :
--   création, activation, modification d'un besoin ; annonce antérieure à l'activation du besoin). Elles ne comptent PAS comme « ce couple était déjà une correspondance »
--   (l'acheteur n'a jamais été prévenu) : une annonce ancienne modifiée après l'activation notifie une fois, un job du besoin qui passe avant celui de l'annonce ne la prive
--   pas de sa notification. Écrites dans la même transaction que l'évaluation.
CREATE TABLE notification_silent_evaluations (
    evaluation_id UUID PRIMARY KEY REFERENCES matching_evaluations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('demand_side', 'not_new_for_demand')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- « Ce couple était-il déjà une correspondance confirmée ? » : lu avant de notifier (historique de la paire, évaluations périmées comprises).
CREATE INDEX idx_matching_eval_pair_confirmed ON matching_evaluations (offer_id, demand_id) WHERE is_confirmed_match = TRUE;
