-- Lot FIN3-C2 : signalements d'annonces et de commandes, et dossiers de modération.
--
-- Un signalement est écrit par un compte qui a ACCÈS à la cible (une annonce qu'il a parmi les correspondances confirmées de son besoin, ou une commande dont il est une des deux
-- parties). `reported_user_id` (le vendeur de l'annonce, ou l'autre partie de la commande) est figé à l'écriture : c'est la cible d'une éventuelle suspension. Un administrateur
-- clôt le dossier par UNE décision (`dismissed` : classé sans suite ; `seller_suspended` : le compte signalé est suspendu, par le chemin existant `updateUser` + journal `admin_actions`)
-- ET un motif obligatoire. Un dossier clos ne se modifie plus ; les éléments d'un signalement (auteur, cible, motif, texte) ne changent jamais.
-- Aucun texte libre ne contient de numéro de téléphone (contrôlé par l'application, comme pour les missions).

CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reported_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_type TEXT NOT NULL CHECK (target_type IN ('offer', 'order')),
    offer_id UUID REFERENCES offers(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    -- Besoin dans le contexte duquel l'annonce a été signalée (accès par les correspondances) ; la commande porte déjà le sien.
    demand_id UUID REFERENCES demands(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK (reason IN ('fraud', 'unavailable', 'wrong_info', 'abusive', 'other')),
    detail TEXT CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    decision TEXT CHECK (decision IS NULL OR decision IN ('dismissed', 'seller_suspended')),
    decision_note TEXT CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
    decided_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_reports_target CHECK (
        (target_type = 'offer' AND offer_id IS NOT NULL AND demand_id IS NOT NULL AND order_id IS NULL)
        OR (target_type = 'order' AND order_id IS NOT NULL AND offer_id IS NULL)
    ),
    CONSTRAINT chk_reports_decision CHECK (
        (status = 'open' AND decision IS NULL AND decision_note IS NULL AND decided_by IS NULL AND decided_at IS NULL)
        OR (status = 'closed' AND decision IS NOT NULL AND decision_note IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    ),
    CONSTRAINT chk_reports_not_self CHECK (reporter_id <> reported_user_id)
);

-- Un seul signalement OUVERT par auteur et par cible (pas de répétition) ; un nouveau est possible une fois le précédent clos.
CREATE UNIQUE INDEX uq_reports_open_offer ON reports (reporter_id, offer_id) WHERE status = 'open' AND offer_id IS NOT NULL;
CREATE UNIQUE INDEX uq_reports_open_order ON reports (reporter_id, order_id) WHERE status = 'open' AND order_id IS NOT NULL;
-- File de l'administration : ouverts d'abord, du plus ancien au plus récent ; clos du plus récent au plus ancien.
CREATE INDEX idx_reports_status_created ON reports (status, created_at, id);
CREATE INDEX idx_reports_reporter_created ON reports (reporter_id, created_at DESC, id DESC);
CREATE INDEX idx_reports_reported_user ON reports (reported_user_id);

-- Les éléments d'un signalement ne changent JAMAIS ; seule la clôture (open → closed, une fois) écrit la décision ; un dossier clos ne se modifie ni ne se supprime.
CREATE FUNCTION reports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'reports_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Un signalement ne se supprime pas.';
    END IF;
    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION 'reports_closed' USING ERRCODE = 'restrict_violation', DETAIL = 'Un dossier clos ne se modifie plus.';
    END IF;
    IF NEW.id <> OLD.id OR NEW.reporter_id <> OLD.reporter_id OR NEW.reported_user_id <> OLD.reported_user_id OR NEW.target_type <> OLD.target_type
       OR NEW.offer_id IS DISTINCT FROM OLD.offer_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.demand_id IS DISTINCT FROM OLD.demand_id
       OR NEW.reason <> OLD.reason OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'reports_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Les éléments d''un signalement ne se modifient pas.';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_reports_guard
    BEFORE UPDATE OR DELETE ON reports
    FOR EACH ROW EXECUTE FUNCTION reports_guard();
