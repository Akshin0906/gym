CREATE TABLE IF NOT EXISTS cloud_auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_auth_sessions_active
  ON cloud_auth_sessions(token_hash, expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS idx_cloud_auth_sessions_last_seen
  ON cloud_auth_sessions(last_seen_at);
