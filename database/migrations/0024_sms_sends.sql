-- Migration 0024 : journal des envois SMS (lot SMS1, fournisseur Meno). Additive : ne modifie aucune table existante.
-- Chaque SMS ACCEPTÉ par le fournisseur coûte 15 F CFA : toute tentative d'envoi laisse UNE ligne ici, écrite AVANT l'appel (statut `pending`) et mise à jour après.
--
-- Ce qui est conservé : la finalité (`purpose`), la référence métier (identifiant du défi OTP, ou clé du lot figé des notifications), la clé d'idempotence (UNIQUE : elle ne change
--   JAMAIS pour une même action métier, même en cas de reprise), l'identifiant du fournisseur, le statut, le code HTTP, un code d'erreur stable, le nombre de requêtes émises,
--   l'EMPREINTE du numéro (HMAC-SHA-256 signé par NOMA_AUTH_SECRET, 64 caractères hexadécimaux) et ses DEUX derniers chiffres.
-- Ce qui n'est JAMAIS conservé : le texte du message (il contient le code OTP), le numéro en clair, la clé du fournisseur.
--
-- Statuts : `pending` (appel en cours ou interrompu), `accepted` (accepté par l'opérateur : PAS une preuve de livraison), `uncertain` (résultat inconnu : le message est peut-être
--   parti ; JAMAIS renvoyé automatiquement, à rapprocher à la main avec l'identifiant du fournisseur), `rejected` (refus définitif du fournisseur ou conflit de clé),
--   `failed` (rien n'est parti : budget du jour, fournisseur injoignable, cadence dépassée ; la même clé peut être réessayée, APRÈS un nouveau contrôle de budget).
--
-- Budgets du jour (lot SMS1-bis) : le plafond total est découpé en budget « codes de connexion » et budget « notifications » (voir SMS.md) ; `audience` classe un code de connexion
--   (`existing` : le numéro avait déjà un compte, `new` : numéro inconnu ou non établi) pour que les numéros neufs ne puissent consommer que la part non réservée. Un envoi qui reprend
--   après `failed` repart de `created_at` = l'instant de la reprise (le coût et le budget sont ceux du jour de l'envoi).

CREATE TABLE sms_sends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose TEXT NOT NULL CHECK (purpose IN ('otp', 'notification', 'smoke')),
    reference TEXT NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 80),
    idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._-]{8,64}$'),
    provider_id TEXT CHECK (provider_id IS NULL OR provider_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'uncertain', 'rejected', 'failed')),
    http_status INTEGER CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
    error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,60}$'),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 1000),
    phone_hash TEXT NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
    phone_last2 TEXT NOT NULL CHECK (phone_last2 ~ '^[0-9]{2}$'),
    audience TEXT CHECK (audience IS NULL OR audience IN ('existing', 'new')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_sms_sends_idempotency UNIQUE (idempotency_key),
    CONSTRAINT chk_sms_sends_updated_after_creation CHECK (updated_at >= created_at),
    CONSTRAINT chk_sms_sends_accepted_http CHECK (status <> 'accepted' OR (http_status IS NOT NULL AND http_status >= 200 AND http_status <= 299))
);

-- Budgets du jour et de l'heure glissante (comptage des envois créés depuis minuit UTC ou depuis une heure) et lecture par mois (consommation locale).
CREATE INDEX idx_sms_sends_created_at ON sms_sends (created_at);
-- Liste de rapprochement de l'administration : envois incertains ou interrompus, du plus récent au plus ancien.
CREATE INDEX idx_sms_sends_to_reconcile ON sms_sends (created_at DESC) WHERE status IN ('uncertain', 'pending');
