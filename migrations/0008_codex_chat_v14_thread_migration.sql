-- Record the one-time v1.4 canonical-thread detachment independently of the
-- heartbeat version. Older edge code can continue updating retention state and
-- heartbeats, but cannot accidentally mark this migration complete.

ALTER TABLE codex_chat_maintenance
ADD COLUMN bridge_v14_thread_detached_at INTEGER;

INSERT INTO codex_chat_maintenance
  (id, last_retention_at, bridge_v14_thread_detached_at)
VALUES ('primary', 0, NULL)
ON CONFLICT(id) DO NOTHING;
