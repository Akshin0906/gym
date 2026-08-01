CREATE TABLE IF NOT EXISTS codex_memory_state (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  current_context TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  window_started_at INTEGER NOT NULL,
  four_month_started_at INTEGER NOT NULL,
  source_snapshot_updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS codex_memory_items (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('workout', 'two_week', 'four_month')),
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER NOT NULL,
  source_workout_session_id TEXT,
  bullets_json TEXT NOT NULL,
  source_session_ids_json TEXT NOT NULL,
  source_note_ids_json TEXT NOT NULL,
  source_summary_ids_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  snapshot_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_codex_memory_items_type_period
  ON codex_memory_items(memory_type, period_start_at, period_end_at);

CREATE INDEX IF NOT EXISTS idx_codex_memory_items_workout
  ON codex_memory_items(source_workout_session_id);
