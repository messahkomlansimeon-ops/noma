-- Migration 0029 : places de collecte ACCÉLÉRÉE de la recherche active (lot RA1-ter)
-- Additive : ne modifie ni 0001 à 0028, ni aucune ligne existante. Une seule table nouvelle. Jamais appliquée à noma_dev sans sauvegarde ni instruction explicite.
-- ORDRE : la migration s'applique AVANT le code qui la lit. Le code de ce lot traite une base sans cette table comme une base sans la recherche active (options
-- indisponibles, étape ignorée sans erreur) : l'ordre inverse n'abîme rien mais coupe l'option jusqu'à la migration.
--
-- Le quota journalier de chaque source ne porte qu'un nombre BORNÉ de surveillances accélérées (la moitié du quota, 24 requêtes chacune : 4 produits avec le quota par défaut de 200).
-- Une « place » = le droit d'une clé produit à être surveillée toutes les heures. Cette table est la SEULE source de vérité des clés accélérées : une surveillance n'est accélérée que
-- si sa clé a une place. Les places sont attribuées, transférées, retirées et réattribuées (plus ancien achat d'abord) par UNE seule fonction applicative (places.ts), sous le verrou
-- consultatif global d'admission : le nombre de lignes ne dépasse donc jamais la capacité des sources, et un même utilisateur n'en porte jamais plus de deux. Une option en vigueur
-- SANS place continue de notifier sur la collecte ordinaire (« accélération en attente de place ») et reçoit une place dès qu'il en reste.
--
-- Pas de clé étrangère vers `demands` ni `users` (voulu) : une clé étrangère poserait un verrou de ligne partagé sur le besoin DEPUIS le verrou global d'admission, alors que l'achat
-- tient le verrou de la ligne du besoin AVANT de demander le verrou global (interblocage possible entre un achat et une réattribution). Les places sont revérifiées contre les besoins
-- à chaque passage de la fonction applicative (un besoin qui n'est plus actif, ou qui a changé de clé, perd sa place ou la transfère).

CREATE TABLE active_search_places (
    product_key TEXT PRIMARY KEY CHECK (char_length(product_key) BETWEEN 3 AND 600),
    -- Le besoin dont l'option PORTE la place (et son propriétaire) : le plafond par utilisateur compte les places qu'il porte.
    demand_id UUID NOT NULL,
    user_id UUID NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_active_search_places_user ON active_search_places (user_id);
CREATE INDEX idx_active_search_places_demand ON active_search_places (demand_id);
CREATE INDEX idx_active_search_places_granted ON active_search_places (granted_at, product_key);
