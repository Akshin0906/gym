-- Widen the chat reasoning-effort CHECK constraints so `high` (the effort the
-- `gpt-6-astra` bridge runs) can be stored, without rewriting a single existing
-- row. `medium` and `xhigh` remain accepted values because the transcript is
-- history: messages and jobs answered by bridge <= 1.4 on `gpt-5.6-sol` keep
-- their recorded effort rather than being relabelled.
--
-- SQLite cannot alter a CHECK constraint in place, so the three linked chat
-- tables are rebuilt. The rebuild deliberately avoids any PRAGMA: each new
-- table is created under a temporary name whose REFERENCES clauses point at the
-- other temporary names, the old tables are dropped children-first (so no
-- surviving table still references a table being dropped, and no ON DELETE
-- CASCADE ever fires against retained data), and the renames restore the
-- canonical names. ALTER TABLE ... RENAME TO rewrites the REFERENCES clauses of
-- the dependent tables, so the final schema is identical to 0004 apart from the
-- widened constraints.

-- `codex_chat_messages.sequence` is AUTOINCREMENT, so its high-water mark lives
-- in sqlite_sequence and is destroyed with the old table. Retention deletes old
-- transcript rows, so the mark is routinely far above MAX(sequence); losing it
-- would reissue sequence numbers that clients and cursors have already seen.
-- Capture it before the rebuild and restore it after the rename.
CREATE TABLE codex_chat_sequence_watermark_v9 (
  name TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

INSERT INTO codex_chat_sequence_watermark_v9 (name, seq)
SELECT 'codex_chat_messages', seq
FROM sqlite_sequence
WHERE name = 'codex_chat_messages';

CREATE TABLE codex_chat_messages_v2 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  client_message_id TEXT,
  reasoning_effort TEXT CHECK (
    reasoning_effort IS NULL
    OR reasoning_effort IN ('medium', 'high', 'xhigh')
  ),
  model TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id)
    REFERENCES codex_chat_conversations(id) ON DELETE CASCADE
);

INSERT INTO codex_chat_messages_v2
  (sequence, id, conversation_id, role, text, client_message_id,
   reasoning_effort, model, created_at)
SELECT sequence, id, conversation_id, role, text, client_message_id,
       reasoning_effort, model, created_at
FROM codex_chat_messages;

CREATE TABLE codex_chat_jobs_v2 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL UNIQUE,
  assistant_message_id TEXT UNIQUE,
  context_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (
    reasoning_effort IN ('medium', 'high', 'xhigh')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  available_at INTEGER NOT NULL,
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  claimed_at INTEGER,
  completed_at INTEGER,
  last_error TEXT,
  completion_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (attempts <= max_attempts),
  CHECK (
    status != 'leased' OR
    (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (conversation_id)
    REFERENCES codex_chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_message_id)
    REFERENCES codex_chat_messages_v2(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_message_id)
    REFERENCES codex_chat_messages_v2(id) ON DELETE SET NULL,
  FOREIGN KEY (context_id)
    REFERENCES codex_chat_contexts(id) ON DELETE CASCADE
);

INSERT INTO codex_chat_jobs_v2
  (id, conversation_id, user_message_id, assistant_message_id, context_id,
   reasoning_effort, status, attempts, max_attempts, available_at, worker_id,
   lease_token, lease_expires_at, claimed_at, completed_at, last_error,
   completion_hash, created_at, updated_at)
SELECT id, conversation_id, user_message_id, assistant_message_id, context_id,
       reasoning_effort, status, attempts, max_attempts, available_at, worker_id,
       lease_token, lease_expires_at, claimed_at, completed_at, last_error,
       completion_hash, created_at, updated_at
FROM codex_chat_jobs;

CREATE TABLE codex_chat_action_proposals_v2 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  assistant_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'applied', 'failed', 'dismissed')
  ),
  action_plan_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES codex_chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id)
    REFERENCES codex_chat_jobs_v2(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_message_id)
    REFERENCES codex_chat_messages_v2(id) ON DELETE CASCADE
);

INSERT INTO codex_chat_action_proposals_v2
  (id, conversation_id, job_id, assistant_message_id, status,
   action_plan_json, result_json, created_at, updated_at)
SELECT id, conversation_id, job_id, assistant_message_id, status,
       action_plan_json, result_json, created_at, updated_at
FROM codex_chat_action_proposals;

DROP TABLE codex_chat_action_proposals;
DROP TABLE codex_chat_jobs;
DROP TABLE codex_chat_messages;

ALTER TABLE codex_chat_messages_v2 RENAME TO codex_chat_messages;
ALTER TABLE codex_chat_jobs_v2 RENAME TO codex_chat_jobs;
ALTER TABLE codex_chat_action_proposals_v2 RENAME TO codex_chat_action_proposals;

-- Restore the AUTOINCREMENT watermark. The first statement covers a retained
-- transcript that is empty after the copy (no sqlite_sequence row exists for
-- the rebuilt table at all); the second raises an existing mark that the copy
-- rebuilt from MAX(sequence) alone.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'codex_chat_messages', seq
FROM codex_chat_sequence_watermark_v9
WHERE name = 'codex_chat_messages'
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_sequence WHERE name = 'codex_chat_messages'
  );

UPDATE sqlite_sequence
SET seq = max(
  seq,
  (SELECT seq FROM codex_chat_sequence_watermark_v9
   WHERE name = 'codex_chat_messages')
)
WHERE name = 'codex_chat_messages'
  AND EXISTS (
    SELECT 1 FROM codex_chat_sequence_watermark_v9
    WHERE name = 'codex_chat_messages'
  );

DROP TABLE codex_chat_sequence_watermark_v9;

-- Indexes live with their table, so every index defined in 0004 and 0005 for
-- the rebuilt tables is recreated here with the same name and definition.
CREATE INDEX IF NOT EXISTS idx_codex_chat_messages_conversation_sequence
  ON codex_chat_messages(conversation_id, sequence);

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_claim
  ON codex_chat_jobs(status, available_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_conversation
  ON codex_chat_jobs(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_codex_chat_proposals_conversation_status
  ON codex_chat_action_proposals(conversation_id, status, created_at);

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
