-- Durable relay between the paired phone and the subscription-authenticated
-- Codex bridge running on the owner's Mac. The app has one personal thread;
-- keeping a conversation id in the schema leaves room for a future archive UI.

CREATE TABLE IF NOT EXISTS codex_chat_conversations (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  codex_thread_id TEXT
);

CREATE TABLE IF NOT EXISTS codex_chat_contexts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES codex_chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_chat_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  client_message_id TEXT,
  reasoning_effort TEXT CHECK (
    reasoning_effort IS NULL OR reasoning_effort IN ('medium', 'xhigh')
  ),
  model TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id)
    REFERENCES codex_chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_chat_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL UNIQUE,
  assistant_message_id TEXT UNIQUE,
  context_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('medium', 'xhigh')),
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
    REFERENCES codex_chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_message_id)
    REFERENCES codex_chat_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (context_id)
    REFERENCES codex_chat_contexts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_chat_action_proposals (
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
    REFERENCES codex_chat_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_message_id)
    REFERENCES codex_chat_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_chat_bridge_heartbeat (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'error')),
  bridge_version TEXT,
  model TEXT,
  active_job_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_chat_messages_conversation_sequence
  ON codex_chat_messages(conversation_id, sequence);

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_claim
  ON codex_chat_jobs(status, available_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_codex_chat_jobs_conversation
  ON codex_chat_jobs(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_codex_chat_proposals_conversation_status
  ON codex_chat_action_proposals(conversation_id, status, created_at);
