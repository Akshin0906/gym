-- D1-backed fixed-window counter for cloud pairing attempts. The API updates
-- this row with one UPSERT ... RETURNING statement so concurrent requests
-- cannot bypass the five-attempt policy through a non-atomic KV read/write.
CREATE TABLE IF NOT EXISTS cloud_pair_attempts (
  client_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (client_hash, window_started_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cloud_pair_attempts_expires_at
  ON cloud_pair_attempts(expires_at);

-- Expired fixed-window rows are removed when a later window/client first
-- inserts, avoiding a separate scheduled cleanup dependency.
CREATE TRIGGER IF NOT EXISTS cleanup_cloud_pair_attempts_after_insert
AFTER INSERT ON cloud_pair_attempts
BEGIN
  DELETE FROM cloud_pair_attempts
  WHERE expires_at <= NEW.window_started_at;
END;
