-- Migration 0023 : historique des prix et statistiques de marché (lot H1)
-- Additive : ne modifie ni 0001 à 0020 ni aucune ligne existante. Jamais appliquée à noma_dev sans instruction explicite.
--
-- price_observations : un prix OBSERVÉ, jamais une annonce ni une commande.
--   source 'listing' : le prix affiché d'une annonce PUBLIÉE (une observation par jour UTC et par annonce) ;
--   source 'sale'    : le prix convenu d'une vente CONFIRMÉE (observée dans la transaction de la confirmation).
--   Clé produit normalisée (catégorie, marque, modèle, variante, état) : `price_key_part` = minuscules, sans accents français, espaces simples (les mêmes
--   règles que `accentNormalize` du matching) ; une variante ou un état absent vaut le texte vide. Le libellé d'affichage garde la casse du vendeur.
--   reference_id : l'annonce (listing) ou la commande (sale) ; PAS de clé étrangère : un relevé est un fait historique qui survit à la ligne qui l'a produit.
--   seller_id et buyer_id : INTERNES, servent uniquement à compter des acteurs distincts ; jamais exposés (aucune route ne les lit). ON DELETE SET NULL : si un compte
--   disparaît, le prix reste mais le lien avec le compte aussi (un acteur disparu n'est plus compté comme distinct).
-- Unique (source, reference_id, observed_on) : une observation par jour et par annonce ; une vente n'est observée qu'une fois (le jour de sa confirmation).
--
-- Deux déclencheurs, dans la transaction de l'écriture (sans cette migration, rien ne s'exécute et rien ne casse) :
--   offers  : à la publication et à chaque changement de prix (ou de clé produit, de disponibilité) d'une annonce observable, la ligne du JOUR est écrite ou remplacée
--             (le dernier prix du jour l'emporte) ;
--   orders  : une commande qui PASSE à « confirmed » (jamais proposée, refusée ni annulée) écrit sa vente.
-- Le relevé quotidien (étape « market » du worker) écrit la ligne du JOUR COURANT pour les annonces observables (voir lib/server/market/observe.ts) : aucun rattrapage des jours
-- manquants, un trou dans l'historique reste un trou (jamais de « jour fantôme » après une suspension).
--
-- Les ventes (source 'sale') sont ENREGISTRÉES mais jamais publiées sous forme de prix (HISTORIQUE-PRIX.md) : seul le nombre de ventes confirmées, arrondi, est lu par l'administration.

-- Clé de comparaison : minuscules, accents du français retirés (comme accentNormalize), espaces (insécables compris) réduits à un seul, sans espace de tête ni de queue.
CREATE FUNCTION price_key_part(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT btrim(regexp_replace(
        lower(translate(coalesce(value, ''), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ', 'aaaaaaceeeeiiiinooooouuuuyyaaaaaaceeeeiiiinooooouuuuyy')),
        '[\s   -     　﻿]+', ' ', 'g'))
$$;

CREATE TABLE price_observations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('listing', 'sale')),
    reference_id UUID NOT NULL,
    observed_on DATE NOT NULL,
    category_key TEXT NOT NULL CHECK (category_key <> '' AND category_key = price_key_part(category_key)),
    brand_key TEXT NOT NULL CHECK (brand_key <> '' AND brand_key = price_key_part(brand_key)),
    model_key TEXT NOT NULL CHECK (model_key <> '' AND model_key = price_key_part(model_key)),
    variant_key TEXT NOT NULL CHECK (variant_key = price_key_part(variant_key)),
    condition_key TEXT NOT NULL CHECK (condition_key = price_key_part(condition_key)),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    price_xof BIGINT NOT NULL CHECK (price_xof BETWEEN 1 AND 100000000),
    seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    buyer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_price_observations UNIQUE (source, reference_id, observed_on),
    -- Une annonce n'a pas d'acheteur.
    CONSTRAINT chk_price_observations_parties CHECK (source = 'sale' OR buyer_id IS NULL)
);

-- Lecture d'un marché : (catégorie, marque, modèle) puis période. Purge : par jour.
CREATE INDEX idx_price_observations_market ON price_observations (category_key, brand_key, model_key, observed_on);
CREATE INDEX idx_price_observations_day ON price_observations (observed_on);

-- Journal du relevé quotidien : un jour terminé n'est pas recommencé à chaque cycle du worker.
CREATE TABLE price_observation_runs (
    day DATE PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    observed INTEGER NOT NULL CHECK (observed >= 0)
);

-- Libellé d'affichage (casse du vendeur) : « Apple iPhone 12 · 128 Go · Occasion ».
CREATE FUNCTION price_obs_label(o offers) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT left(concat_ws(' · ', nullif(btrim(concat_ws(' ', o.brand, o.model)), ''), nullif(btrim(o.variant), ''), nullif(btrim(o.condition_text), '')), 200)
$$;

-- Une annonce est OBSERVABLE quand elle est publiée, non archivée, disponible (NULL accepté), affichée en XOF de 1 à 100 000 000, avec une catégorie, une marque et un
-- modèle, et que son propriétaire est un compte actif. Définition unique, partagée par le déclencheur et par le relevé quotidien.
CREATE FUNCTION price_obs_offer_ok(o offers) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT o.status = 'published'
       AND o.archived_at IS NULL
       AND o.availability_status IS DISTINCT FROM 'unavailable'
       AND o.price_currency = 'XOF'
       AND o.price_amount BETWEEN 1 AND 100000000
       AND price_key_part(o.category) <> '' AND price_key_part(o.brand) <> '' AND price_key_part(o.model) <> ''
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = o.owner_id AND u.status = 'active' AND u.archived_at IS NULL)
$$;

CREATE FUNCTION offers_observe_price() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Une modification qui ne touche ni le prix, ni l'état de publication, ni la clé produit n'écrit rien.
    IF TG_OP = 'UPDATE'
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.price_amount IS NOT DISTINCT FROM OLD.price_amount
       AND NEW.price_currency IS NOT DISTINCT FROM OLD.price_currency
       AND NEW.availability_status IS NOT DISTINCT FROM OLD.availability_status
       AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
       AND NEW.category IS NOT DISTINCT FROM OLD.category
       AND NEW.brand IS NOT DISTINCT FROM OLD.brand
       AND NEW.model IS NOT DISTINCT FROM OLD.model
       AND NEW.variant IS NOT DISTINCT FROM OLD.variant
       AND NEW.condition_text IS NOT DISTINCT FROM OLD.condition_text THEN
        RETURN NEW;
    END IF;
    IF price_obs_offer_ok(NEW) THEN
        INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
        VALUES ('listing', NEW.id, (clock_timestamp() AT TIME ZONE 'UTC')::date, price_key_part(NEW.category), price_key_part(NEW.brand), price_key_part(NEW.model),
                price_key_part(NEW.variant), price_key_part(NEW.condition_text), price_obs_label(NEW), NEW.price_amount, NEW.owner_id)
        ON CONFLICT (source, reference_id, observed_on) DO UPDATE
           SET category_key = EXCLUDED.category_key, brand_key = EXCLUDED.brand_key, model_key = EXCLUDED.model_key, variant_key = EXCLUDED.variant_key,
               condition_key = EXCLUDED.condition_key, label = EXCLUDED.label, price_xof = EXCLUDED.price_xof, seller_id = EXCLUDED.seller_id;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_offers_observe_price
    AFTER INSERT OR UPDATE ON offers
    FOR EACH ROW EXECUTE FUNCTION offers_observe_price();

CREATE FUNCTION orders_observe_sale() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Une vente n'existe qu'à la CONFIRMATION : « proposée », « refusée » et « annulée » n'écrivent rien.
    IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
        INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id, buyer_id)
        SELECT 'sale', NEW.id, (COALESCE(NEW.decided_at, clock_timestamp()) AT TIME ZONE 'UTC')::date, price_key_part(o.category), price_key_part(o.brand), price_key_part(o.model),
               price_key_part(o.variant), price_key_part(o.condition_text), price_obs_label(o), NEW.price_amount, NEW.seller_id, NEW.buyer_id
          FROM offers o
         WHERE o.id = NEW.offer_id
           AND price_key_part(o.category) <> '' AND price_key_part(o.brand) <> '' AND price_key_part(o.model) <> ''
        ON CONFLICT (source, reference_id, observed_on) DO NOTHING;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_orders_observe_sale
    AFTER INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_observe_sale();
