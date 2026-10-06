-- Migration 0016 : portée visible d'une cotation de boost (lot P2-bis)
-- Additive : ne modifie pas 0001 à 0015 (elle remplace seulement une contrainte CHECK NOMMÉE de 0012 par une version élargie : DROP puis
-- ADD, dans cette migration). Aucun paiement, aucune écriture du grand livre.
--
-- Un boost ne vaut quelque chose que s'il peut faire MONTER l'offre dans la liste d'au moins un acheteur : le quota de places promues
-- d'une liste est floor(part promue × N) (0 sous 7 offres avec 0,15), la pertinence organique de l'offre doit atteindre le seuil, et
-- l'offre ne doit pas déjà être à la place cible. `reachable_buyers` est le nombre d'acheteurs distincts (un besoin actif compatible
-- suffit) pour lesquels, avec la MÊME logique de placement que la lecture des résultats, le boost ferait monter l'offre. Il est NULL pour
-- les cotations d'avant cette migration et pour celles qui ne l'ont pas calculé (indisponibles pour un motif antérieur dans l'ordre :
-- offre déjà boostée, plus de place, plafond vendeur). Le prix n'en dépend pas (le facteur demande reste fondé sur compatible_buyers).
-- Nouveau motif d'indisponibilité : no_visible_effect (des acheteurs compatibles existent, mais aucun ne verrait l'offre monter).

ALTER TABLE boost_quotes ADD COLUMN reachable_buyers INTEGER;

ALTER TABLE boost_quotes DROP CONSTRAINT chk_boost_quotes_reason;
ALTER TABLE boost_quotes ADD CONSTRAINT chk_boost_quotes_reason CHECK (unavailable_reason IS NULL OR unavailable_reason IN (
    'offer_already_boosted', 'no_slot_available', 'seller_boost_limit_reached', 'no_compatible_buyer', 'no_visible_effect'
));

-- Jamais plus d'acheteurs atteignables que d'acheteurs compatibles.
ALTER TABLE boost_quotes ADD CONSTRAINT chk_boost_quotes_reachable_range CHECK (
    reachable_buyers IS NULL OR (reachable_buyers >= 0 AND reachable_buyers <= compatible_buyers)
);

-- Une cotation disponible (créée depuis cette migration) promet au moins un acheteur atteignable ; no_visible_effect en promet zéro.
ALTER TABLE boost_quotes ADD CONSTRAINT chk_boost_quotes_reachable_available CHECK (
    status <> 'available' OR reachable_buyers IS NULL OR reachable_buyers >= 1
);
ALTER TABLE boost_quotes ADD CONSTRAINT chk_boost_quotes_reachable_no_effect CHECK (
    unavailable_reason IS DISTINCT FROM 'no_visible_effect' OR COALESCE(reachable_buyers, -1) = 0
);
