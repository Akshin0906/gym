-- Throttle bounded chat retention while lease normalization remains safe to run
-- on every phone poll and worker claim.

CREATE TABLE IF NOT EXISTS codex_chat_maintenance (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  last_retention_at INTEGER NOT NULL
);

INSERT INTO codex_chat_maintenance (id, last_retention_at)
VALUES ('primary', 0)
ON CONFLICT(id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_retention
  ON codex_chat_jobs(conversation_id, status, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_codex_chat_proposals_retention
  ON codex_chat_action_proposals(
    conversation_id,
    status,
    updated_at DESC,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_context
  ON codex_chat_jobs(context_id);

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_assistant_message
  ON codex_chat_jobs(assistant_message_id);
