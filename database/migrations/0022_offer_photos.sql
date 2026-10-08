-- Migration 0022 : photos des annonces (lot PH1)
-- Additive : ne modifie ni 0001 à 0020 ni aucune ligne existante. Jamais appliquée à noma_dev sans instruction explicite.
--
-- offer_photos : une ligne par photo ; le FICHIER est stocké hors de la base (dossier NOMA_MEDIA_DIR, port MediaStore) sous le nom `id` (un UUID tiré par le serveur, jamais le nom
--   envoyé). Au plus 6 photos par annonce, imposé ICI (position 0 à 5, unique par annonce : la photo de position 0 est la couverture) ET dans le code. L'empreinte (SHA-256 du
--   fichier NETTOYÉ de ses métadonnées) est unique par annonce : le rejeu d'un envoi ne crée pas de doublon. Dimensions et poids bornés comme le code (200 à 4 100 px par côté, 12,5
--   mégapixels, 5 Mo). L'unicité de la position est DIFFÉRÉE (validée à la fin de la transaction) : un réordonnancement échange des positions sans heurt intermédiaire.
-- offer_photo_uploads : journal des envois d'un vendeur (limite de 30 par heure) ; les lignes de plus de 24 heures sont supprimées au fil de l'eau.
-- media_orphans : journal des fichiers qu'on n'a pas pu retirer (suppression ou envoi interrompu) ; `npm run media:gc` les reprend.

CREATE TABLE offer_photos (
    id UUID PRIMARY KEY,
    offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 5),
    mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
    width INTEGER NOT NULL CHECK (width BETWEEN 200 AND 4100),
    height INTEGER NOT NULL CHECK (height BETWEEN 200 AND 4100),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_offer_photos_pixels CHECK (width::bigint * height::bigint <= 12500000),
    CONSTRAINT uq_offer_photos_position UNIQUE (offer_id, position) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uq_offer_photos_sha256 UNIQUE (offer_id, sha256)
);

CREATE TABLE offer_photo_uploads (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_offer_photo_uploads_seller ON offer_photo_uploads (seller_id, uploaded_at);

CREATE TABLE media_orphans (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    reason TEXT NOT NULL CHECK (reason IN ('delete_failed', 'write_failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_media_orphans_open ON media_orphans (created_at) WHERE resolved_at IS NULL;
