-- Lot FIN3-C4 : lien de partage d'un besoin (« Partager mon besoin » et « Inviter un vendeur » sont UN seul mécanisme).
--
-- Le propriétaire d'un besoin ACTIF crée un lien public ; quiconque l'ouvre voit un résumé du besoin SANS identité (produit, état, zone, budget) et peut publier une annonce (connexion exigée).
-- Le jeton (128 bits aléatoires, base64url) n'est JAMAIS stocké : seule son empreinte SHA-256 l'est ; il n'est montré qu'à la création. Un seul lien actif par besoin (en créer un révoque le
-- précédent). Le lien meurt tout seul quand le besoin n'est plus actif ou que le compte n'est plus actif (contrôlé à la lecture).

CREATE TABLE demand_share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT uq_demand_share_links_token UNIQUE (token_hash),
    CONSTRAINT chk_demand_share_links_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX uq_demand_share_links_active ON demand_share_links (demand_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_demand_share_links_owner ON demand_share_links (owner_id, created_at DESC);

-- Le lien appartient au propriétaire du besoin ; seule la révocation (une fois) change une ligne ; aucune suppression.
CREATE FUNCTION demand_share_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM demands d WHERE d.id = NEW.demand_id AND d.owner_id = NEW.owner_id) THEN
            RAISE EXCEPTION 'share_link_owner_mismatch' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'share_link_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Un lien de partage ne se supprime pas.';
    END IF;
    IF OLD.revoked_at IS NOT NULL
       OR NEW.id <> OLD.id OR NEW.demand_id <> OLD.demand_id OR NEW.owner_id <> OLD.owner_id OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'share_link_immutable' USING ERRCODE = 'restrict_violation', DETAIL = 'Seule la révocation d''un lien actif est permise.';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_demand_share_links_guard
    BEFORE INSERT OR UPDATE OR DELETE ON demand_share_links
    FOR EACH ROW EXECUTE FUNCTION demand_share_links_guard();
