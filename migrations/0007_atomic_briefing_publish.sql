-- Add an explicit safety outcome and a server-side compare-and-set guard for
-- publishing memory and the daily briefing as one D1 batch.

CREATE TABLE daily_briefings_v2 (
  briefing_date TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  snapshot_updated_at INTEGER NOT NULL,
  headline TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('push', 'normal', 'light', 'deload', 'rest')),
  sections_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_summary_json TEXT
);

INSERT INTO daily_briefings_v2
  (briefing_date, created_at, source, snapshot_updated_at, headline, mode,
   sections_json, model, input_summary_json)
SELECT briefing_date, created_at, source, snapshot_updated_at, headline, mode,
       sections_json, model, input_summary_json
FROM daily_briefings;

DROP TABLE daily_briefings;
ALTER TABLE daily_briefings_v2 RENAME TO daily_briefings;

CREATE INDEX idx_daily_briefings_created_at
  ON daily_briefings(created_at);

CREATE TABLE codex_publish_revision (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  publish_token TEXT NOT NULL CHECK (length(publish_token) BETWEEN 1 AND 200),
  publish_fingerprint TEXT NOT NULL CHECK (length(publish_fingerprint) BETWEEN 1 AND 200),
  write_token TEXT NOT NULL CHECK (length(write_token) BETWEEN 1 AND 200)
);

INSERT INTO codex_publish_revision
  (id, revision, publish_token, publish_fingerprint, write_token)
VALUES ('primary', 0, 'initial', 'initial', 'initial')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE codex_publish_receipts (
  publish_id TEXT PRIMARY KEY CHECK (length(publish_id) BETWEEN 1 AND 200),
  publish_fingerprint TEXT NOT NULL CHECK (length(publish_fingerprint) BETWEEN 1 AND 200),
  briefing_date TEXT NOT NULL,
  expected_snapshot_updated_at INTEGER NOT NULL CHECK (expected_snapshot_updated_at >= 0),
  base_memory_revision INTEGER NOT NULL CHECK (base_memory_revision >= 0),
  committed_memory_revision INTEGER NOT NULL CHECK (committed_memory_revision > base_memory_revision),
  briefing_created_at INTEGER NOT NULL,
  briefing_source TEXT NOT NULL,
  briefing_snapshot_updated_at INTEGER NOT NULL,
  headline TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('push', 'normal', 'light', 'deload', 'rest')),
  sections_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_summary_json TEXT,
  memory_updated_at INTEGER NOT NULL,
  current_context TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  window_started_at INTEGER NOT NULL,
  four_month_started_at INTEGER NOT NULL,
  memory_snapshot_updated_at INTEGER NOT NULL,
  receipt_created_at INTEGER NOT NULL
);

CREATE INDEX idx_codex_publish_receipts_created_at
  ON codex_publish_receipts(receipt_created_at);
