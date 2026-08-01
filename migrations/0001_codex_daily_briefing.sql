CREATE TABLE IF NOT EXISTS workout_snapshots (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_device TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_briefings (
  briefing_date TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  snapshot_updated_at INTEGER NOT NULL,
  headline TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('push', 'normal', 'light', 'deload')),
  sections_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_summary_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_briefings_created_at
  ON daily_briefings(created_at);
