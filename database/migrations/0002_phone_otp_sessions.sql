CREATE TABLE phone_identities (
  phone_e164 TEXT PRIMARY KEY CHECK (phone_e164 ~ '^[+][1-9][0-9]{1,14}$'),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE otp_challenges (
  id UUID PRIMARY KEY,
  phone_e164 TEXT NOT NULL CHECK (phone_e164 ~ '^[+][1-9][0-9]{1,14}$'),
  otp_hmac CHAR(64) NOT NULL CHECK (otp_hmac ~ '^[0-9a-f]{64}$'),
  request_ip_fingerprint CHAR(64) NOT NULL
    CHECK (request_ip_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_send', 'sent', 'send_failed', 'superseded',
      'consumed', 'expired', 'locked'
    )
  ),
  failed_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (failed_attempts >= 0 AND failed_attempts <= 5),
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND consumed_at IS NULL)),
  CHECK (status <> 'consumed' OR (sent_at IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE UNIQUE INDEX otp_challenges_one_active_phone_idx
  ON otp_challenges (phone_e164)
  WHERE status IN ('pending_send', 'sent');
CREATE INDEX otp_challenges_phone_created_idx
  ON otp_challenges (phone_e164, created_at DESC);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_sha256 CHAR(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE otp_rate_limit_counters (
  dimension TEXT NOT NULL CHECK (dimension IN ('phone', 'ip')),
  subject_fingerprint CHAR(64) NOT NULL
    CHECK (subject_fingerprint ~ '^[0-9a-f]{64}$'),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('15m', 'day')),
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (dimension, subject_fingerprint, window_kind, window_start)
);
