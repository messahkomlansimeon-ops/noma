-- Migration 0027 : missions d'achat en volume (lot MV1)
-- Additive : ne modifie ni 0001 à 0026 ni aucune ligne existante. Elle ajoute la table `missions`, deux colonnes à `orders` (quantité, mission) et une à `notifications` (mission),
-- un troisième genre de notification (`mission_coverage`) et un garde-fou sur le besoin porteur d'une mission. Jamais appliquée à noma_dev sans instruction explicite.
-- Les numéros 0021 à 0026 appartiennent à d'autres lots (offre Pro, photos, historique des prix, SMS, collecte externe, paiement Wave).
--
-- missions : une mission d'achat en volume (« 20 iPhone 12, 170 000 FCFA l'unité au plus, 3 200 000 FCFA au total »). Une mission ACTIVE possède un besoin « porteur »
--   (`demand_id`) : un besoin ordinaire du matching, SANS budget ni quantité (le vendeur d'une annonce qui correspond voit ce besoin comme tous les autres : jamais le budget
--   de la mission). Les budgets restent dans cette table, que seul le propriétaire lit. Les champs de la mission ne changent plus après le brouillon (déclencheur).
--   `covered_quantity` / `evaluated_at` : couverture lue par l'étape « missions » du runner (liste « Mes missions »). `notified_quantity` / `notified_at` : couverture dont
--   l'acheteur a été prévenu (ou base de comparaison posée sans bruit à la première évaluation) ; au plus une notification par jour et par mission (index unique).
-- orders.quantity / orders.mission_id : quantité achetée (1 par défaut) et mission d'origine (seul l'acheteur la voit). Les règles de transition de 0020 sont gardées ;
--   la quantité et la mission ne changent jamais après la déclaration.
-- notifications.mission_id : le genre `mission_coverage` (« la couverture de votre mission a augmenté »).
-- demands : un besoin porteur d'une mission ouverte (active ou en pause) ne change ni de statut, ni de version, ni de suivi par un autre chemin que la mission.
-- missions.carrier_released_at : posé quand le besoin porteur d'une mission close est archivé, 24 h APRÈS sa fin (un vendeur dont la confirmation termine la mission ne doit pas
--   le deviner en le voyant disparaître) ; c'est la seule modification permise sur une mission close. `notified_quantity` est le PLUS HAUT niveau de couverture que l'acheteur a vu ou
--   dont il a été prévenu : il ne baisse jamais.
-- Index ajoutés : `idx_missions_owner_open` (les missions ouvertes d'abord dans « Mes missions »), `idx_missions_carrier_release` (besoins porteurs à archiver) et
--   `idx_matching_eval_demand_awaiting` (évaluations périmées en attente de recalcul d'un besoin : l'étape « missions » ne relit pas la couverture pendant un recalcul, sans lire tout
--   l'historique des évaluations).

CREATE TABLE missions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled', 'expired')),
    category TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT,
    condition_text TEXT NOT NULL,
    quantity_total INTEGER NOT NULL CHECK (quantity_total BETWEEN 2 AND 10000),
    unit TEXT NOT NULL,
    unit_budget_xof BIGINT NOT NULL CHECK (unit_budget_xof BETWEEN 1 AND 100000000),
    total_budget_xof BIGINT NOT NULL CHECK (total_budget_xof BETWEEN 1 AND 1000000000000),
    location_text TEXT,
    deadline_days INTEGER NOT NULL CHECK (deadline_days BETWEEN 1 AND 90),
    -- Posés à l'activation : échéance (activation + deadline_days jours) et besoin porteur.
    deadline_at TIMESTAMPTZ,
    demand_id UUID REFERENCES demands(id),
    activated_at TIMESTAMPTZ,
    -- Posé à la clôture (terminée, annulée, échue).
    closed_at TIMESTAMPTZ,
    -- Suivi par l'étape du runner.
    covered_quantity INTEGER CHECK (covered_quantity IS NULL OR covered_quantity BETWEEN 0 AND 10000),
    evaluated_at TIMESTAMPTZ,
    notified_quantity INTEGER CHECK (notified_quantity IS NULL OR notified_quantity BETWEEN 0 AND 10000),
    notified_at TIMESTAMPTZ,
    -- Posé quand le besoin porteur d'une mission close est archivé (24 h après la fin de la mission).
    carrier_released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_missions_budgets CHECK (total_budget_xof >= unit_budget_xof),
    -- Textes : de 1 à 50 caractères (80 pour le lieu, 20 pour l'unité), jamais de caractère de contrôle, de direction de texte ni invisible.
    CONSTRAINT chk_missions_text_length CHECK (
        char_length(btrim(category)) BETWEEN 1 AND 50 AND char_length(btrim(brand)) BETWEEN 1 AND 50 AND char_length(btrim(model)) BETWEEN 1 AND 50
        AND (variant IS NULL OR char_length(btrim(variant)) BETWEEN 1 AND 50) AND char_length(btrim(condition_text)) BETWEEN 1 AND 50
        AND char_length(btrim(unit)) BETWEEN 1 AND 20 AND (location_text IS NULL OR char_length(btrim(location_text)) BETWEEN 1 AND 80)
    ),
    -- Aucun caractère de contrôle, de direction de texte ni invisible : contrôles C0 et C1, soft hyphen, ignorables par défaut d'Unicode (joint de graphème U+034F, marque de lettre
    -- arabe, remplisseurs Hangul U+115F U+1160 U+3164 U+FFA0, voyelles khmères inhérentes, sélecteurs de variante, formats de largeur nulle et de direction, séparateurs de ligne et de
    -- paragraphe, formats mathématiques invisibles, étiquettes) et le cadratin braille vide U+2800 ; jamais de marque combinante ISOLÉE (en tête de champ ou après un caractère qui
    -- n'est ni lettre ni chiffre).
    CONSTRAINT chk_missions_text_safe CHECK (
        (category || ' ' || brand || ' ' || model || ' ' || COALESCE(variant, '') || ' ' || condition_text || ' ' || unit || ' ' || COALESCE(location_text, ''))
            !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]'
        AND (' ' || category || ' ' || brand || ' ' || model || ' ' || COALESCE(variant, '') || ' ' || condition_text || ' ' || unit || ' ' || COALESCE(location_text, ''))
            !~ '[^[:alnum:]][\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u0610-\u061A\u064B-\u065F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]'
    ),
    -- Chaque champ de texte porte au moins une lettre ou un chiffre (au sens des paramètres régionaux de la base : en locale « C » seules les lettres ASCII comptent ; le contrôle de
    -- l'application, lui, est complet).
    CONSTRAINT chk_missions_text_content CHECK (
        category ~ '[[:alnum:]]' AND brand ~ '[[:alnum:]]' AND model ~ '[[:alnum:]]' AND condition_text ~ '[[:alnum:]]' AND unit ~ '[[:alnum:]]'
        AND (variant IS NULL OR variant ~ '[[:alnum:]]') AND (location_text IS NULL OR location_text ~ '[[:alnum:]]')
    ),
    -- Cycle de vie : un brouillon n'a ni besoin porteur ni échéance ; une mission ouverte a l'un et l'autre ; une mission close a une date de clôture.
    CONSTRAINT chk_missions_lifecycle CHECK (
        (status = 'draft' AND activated_at IS NULL AND demand_id IS NULL AND deadline_at IS NULL AND closed_at IS NULL)
        OR (status IN ('active', 'paused') AND activated_at IS NOT NULL AND demand_id IS NOT NULL AND deadline_at IS NOT NULL AND closed_at IS NULL)
        OR (status IN ('completed', 'expired') AND activated_at IS NOT NULL AND demand_id IS NOT NULL AND deadline_at IS NOT NULL AND closed_at IS NOT NULL)
        OR (status = 'cancelled' AND closed_at IS NOT NULL AND (activated_at IS NULL) = (demand_id IS NULL) AND (activated_at IS NULL) = (deadline_at IS NULL))
    )
);

-- Le besoin porteur n'est libéré (archivé) que pour une mission close, après sa fin.
ALTER TABLE missions ADD CONSTRAINT chk_missions_carrier_release CHECK (
    carrier_released_at IS NULL
    OR (status IN ('completed', 'cancelled', 'expired') AND demand_id IS NOT NULL AND closed_at IS NOT NULL AND carrier_released_at >= closed_at)
);

-- Un besoin porteur n'appartient qu'à une mission.
CREATE UNIQUE INDEX uq_missions_demand ON missions (demand_id) WHERE demand_id IS NOT NULL;
-- « Mes missions » (plus récentes d'abord) et plafond de créations du jour.
CREATE INDEX idx_missions_owner_created ON missions (owner_id, created_at DESC, id DESC);
-- Plafond de missions actives par acheteur.
CREATE INDEX idx_missions_owner_active ON missions (owner_id) WHERE status = 'active';
-- Étape du runner : missions échues, missions à réévaluer.
CREATE INDEX idx_missions_due ON missions (deadline_at) WHERE status IN ('active', 'paused');
CREATE INDEX idx_missions_watch ON missions (id) WHERE status = 'active';
-- « Mes missions » : les missions ouvertes d'abord (brouillons, actives, en pause), les plus récentes d'abord.
CREATE INDEX idx_missions_owner_open ON missions (owner_id, created_at DESC, id DESC) WHERE status IN ('draft', 'active', 'paused');
-- Étape du runner : besoins porteurs de missions closes à archiver (24 h après la fin).
CREATE INDEX idx_missions_carrier_release ON missions (closed_at, id) WHERE carrier_released_at IS NULL AND demand_id IS NOT NULL AND status IN ('completed', 'cancelled', 'expired');
-- Étape du runner : évaluations d'un besoin devenues périmées et qui seront recalculées (annonce ou besoin modifié, annonce indisponible, moteur remplacé, expiration). Index PARTIEL :
-- les évaluations remplacées par une réévaluation (l'essentiel de l'historique) n'y figurent pas.
CREATE INDEX idx_matching_eval_demand_awaiting ON matching_evaluations (demand_id, staled_at)
    WHERE is_stale = TRUE AND is_latest = FALSE AND stale_reason IN ('offer_updated', 'demand_updated', 'offer_unavailable', 'engine_superseded', 'temporal_expiry');

-- Transitions : brouillon → active | annulée ; active ↔ en pause ; active ou en pause → terminée | échue | annulée ; terminée, annulée et échue sont définitives (plus rien ne change).
-- Après le brouillon, le contenu (produit, quantité, unité, budgets, lieu, durée) et le propriétaire ne changent plus.
CREATE FUNCTION missions_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'mission_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status IN ('completed', 'cancelled', 'expired') THEN
        -- Une mission close ne change plus, sauf la libération de son besoin porteur (archivé 24 h après la fin), une seule fois.
        IF OLD.carrier_released_at IS NULL AND NEW.carrier_released_at IS NOT NULL
           AND (to_jsonb(NEW) - 'carrier_released_at' - 'updated_at') = (to_jsonb(OLD) - 'carrier_released_at' - 'updated_at') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'mission_final' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'draft' AND (
        NEW.category IS DISTINCT FROM OLD.category OR NEW.brand IS DISTINCT FROM OLD.brand OR NEW.model IS DISTINCT FROM OLD.model
        OR NEW.variant IS DISTINCT FROM OLD.variant OR NEW.condition_text IS DISTINCT FROM OLD.condition_text
        OR NEW.quantity_total IS DISTINCT FROM OLD.quantity_total OR NEW.unit IS DISTINCT FROM OLD.unit
        OR NEW.unit_budget_xof IS DISTINCT FROM OLD.unit_budget_xof OR NEW.total_budget_xof IS DISTINCT FROM OLD.total_budget_xof
        OR NEW.location_text IS DISTINCT FROM OLD.location_text OR NEW.deadline_days IS DISTINCT FROM OLD.deadline_days
        OR NEW.demand_id IS DISTINCT FROM OLD.demand_id OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    ) THEN
        RAISE EXCEPTION 'mission_content_locked' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
        OR (OLD.status = 'active' AND NEW.status IN ('paused', 'completed', 'cancelled', 'expired'))
        OR (OLD.status = 'paused' AND NEW.status IN ('active', 'completed', 'cancelled', 'expired'))
    ) THEN
        RAISE EXCEPTION 'mission_transition_forbidden' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_missions_transition
    BEFORE UPDATE ON missions
    FOR EACH ROW EXECUTE FUNCTION missions_enforce_transition();

-- orders : quantité (1 par défaut) et mission d'origine.
ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10000);
ALTER TABLE orders ADD COLUMN mission_id UUID REFERENCES missions(id);
CREATE INDEX idx_orders_mission ON orders (mission_id, status) WHERE mission_id IS NOT NULL;

-- Une commande rattachée à une mission est celle de son propriétaire, passée sur le besoin porteur de cette mission.
CREATE FUNCTION orders_check_mission() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.mission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM missions m WHERE m.id = NEW.mission_id AND m.owner_id = NEW.buyer_id AND m.demand_id = NEW.demand_id
    ) THEN
        RAISE EXCEPTION 'order_mission_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_orders_mission
    BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_check_mission();

-- Les règles de transition de 0020 sont gardées ; la quantité et la mission rejoignent les champs qui ne changent plus après la déclaration.
CREATE OR REPLACE FUNCTION orders_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.demand_id <> OLD.demand_id OR NEW.offer_id <> OLD.offer_id OR NEW.buyer_id <> OLD.buyer_id OR NEW.seller_id <> OLD.seller_id
       OR NEW.price_amount <> OLD.price_amount OR NEW.price_currency <> OLD.price_currency OR NEW.boost_id IS DISTINCT FROM OLD.boost_id
       OR NEW.created_at <> OLD.created_at OR NEW.quantity <> OLD.quantity OR NEW.mission_id IS DISTINCT FROM OLD.mission_id THEN
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

-- notifications : le genre « couverture d'une mission ». Une notification au plus par mission et par jour UTC (`digest_day`), `item_count` = quantité couverte.
ALTER TABLE notifications ADD COLUMN mission_id UUID REFERENCES missions(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT chk_notifications_shape;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('new_match', 'new_matches_digest', 'new_message', 'mission_coverage'));
ALTER TABLE notifications ADD CONSTRAINT chk_notifications_shape CHECK (
    (kind = 'new_match' AND offer_id IS NOT NULL AND conversation_id IS NULL AND mission_id IS NULL AND digest_day IS NULL AND item_count IS NULL
        AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    (kind = 'new_matches_digest' AND offer_id IS NULL AND conversation_id IS NULL AND mission_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
        AND title IS NULL AND price_amount IS NULL AND price_currency IS NULL)
    OR
    (kind = 'new_message' AND offer_id IS NOT NULL AND conversation_id IS NOT NULL AND mission_id IS NULL AND digest_day IS NULL AND item_count IS NULL
        AND price_amount IS NULL AND price_currency IS NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
    OR
    (kind = 'mission_coverage' AND mission_id IS NOT NULL AND offer_id IS NULL AND conversation_id IS NULL AND digest_day IS NOT NULL AND item_count IS NOT NULL AND item_count >= 1
        AND price_amount IS NULL AND price_currency IS NULL AND title IS NOT NULL AND btrim(title) <> '' AND char_length(title) <= 160)
);
CREATE UNIQUE INDEX uq_notifications_mission_coverage ON notifications (mission_id, digest_day) WHERE kind = 'mission_coverage';

-- Le besoin porteur d'une mission OUVERTE (active ou en pause) ne change ni de statut, ni de version de contenu, ni de suivi par un autre chemin que la mission (modifier, archiver,
-- marquer satisfait, relancer les notifications d'un besoin que l'acheteur ne voit pas dans « Mes besoins »). Fin de mission : la mission passe d'abord à son état final, puis le
-- besoin est archivé.
CREATE FUNCTION demands_guard_mission_carrier() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.content_version IS DISTINCT FROM OLD.content_version OR NEW.notify_paused IS DISTINCT FROM OLD.notify_paused)
       AND EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = OLD.id AND m.status IN ('active', 'paused')) THEN
        RAISE EXCEPTION 'mission_carrier_locked' USING ERRCODE = 'restrict_violation', DETAIL = 'Le besoin porteur d''une mission ne se modifie que par la mission.';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_demands_guard_mission_carrier
    BEFORE UPDATE ON demands
    FOR EACH ROW EXECUTE FUNCTION demands_guard_mission_carrier();
