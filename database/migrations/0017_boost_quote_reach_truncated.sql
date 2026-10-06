-- Migration 0017 : portée d'un devis de boost estimée et bornée, limite de débit des devis (lot P3)
-- Additive : ne modifie ni 0001 à 0016 ni aucune ligne existante.
--
-- La portée visible (0016) est désormais une ESTIMATION bornée : au plus 20 besoins comptés, 50 examinés pour trouver un premier acheteur, dans un
-- budget de temps. `reach_truncated` dit si des besoins compatibles n'ont PAS été examinés : `reachable_buyers` est alors un minimum (l'écran dit
-- « au moins X »). NULL : portée non évaluée (devis d'avant cette migration, ou indisponible pour un motif antérieur) ; renseigné seulement si
-- `reachable_buyers` l'est.
ALTER TABLE boost_quotes ADD COLUMN reach_truncated BOOLEAN;

ALTER TABLE boost_quotes ADD CONSTRAINT chk_boost_quotes_reach_truncated CHECK (
    reach_truncated IS NULL OR reachable_buyers IS NOT NULL
);

-- Limite de débit des devis par vendeur : nombre de devis calculés (écrits) sur la dernière minute.
CREATE INDEX idx_boost_quotes_seller_computed ON boost_quotes (seller_id, computed_at DESC);
