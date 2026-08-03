"""Focused SQLite smoke tests for chat lease and retention SQL.

Run with:
  python3 -m unittest functions/api/chat/backend_sql_smoke.py
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CONVERSATION_ID = "primary"
RETAIN_TERMINAL_JOBS = 500
RETAIN_RESOLVED_PROPOSALS = 500
RETAIN_TRANSCRIPT_MESSAGES = 120
TRANSCRIPT_LIMIT = 60


class ChatBackendSqlSmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        for migration in (
            "0004_codex_chat.sql",
            "0005_codex_chat_maintenance.sql",
        ):
            self.db.executescript((ROOT / "migrations" / migration).read_text())
        self.db.execute(
            "INSERT INTO codex_chat_conversations VALUES (?, 1, 1, NULL)",
            (CONVERSATION_ID,),
        )

    def tearDown(self) -> None:
        self.db.close()

    def _insert_job(
        self,
        index: int,
        *,
        status: str,
        proposal_status: str | None = None,
        attempts: int = 1,
        lease_expires_at: int | None = None,
    ) -> str:
        context_id = f"context-{index}"
        user_id = f"user-{index}"
        assistant_id = f"assistant-{index}"
        job_id = f"job-{index}"
        self.db.execute(
            "INSERT INTO codex_chat_contexts VALUES (?, ?, ?, '{}', ?)",
            (context_id, CONVERSATION_ID, "a" * 64, index),
        )
        self.db.execute(
            """INSERT INTO codex_chat_messages
               (id, conversation_id, role, text, client_message_id,
                reasoning_effort, model, created_at)
               VALUES (?, ?, 'user', 'user', ?, 'medium', NULL, ?)""",
            (user_id, CONVERSATION_ID, f"client-{index}", index),
        )
        assistant_message_id = None
        if status == "completed" or proposal_status is not None:
            self.db.execute(
                """INSERT INTO codex_chat_messages
                   (id, conversation_id, role, text, client_message_id,
                    reasoning_effort, model, created_at)
                   VALUES (?, ?, 'assistant', 'assistant', NULL,
                           'medium', 'gpt-5.6-sol', ?)""",
                (assistant_id, CONVERSATION_ID, index),
            )
            assistant_message_id = assistant_id
        leased = status == "leased"
        self.db.execute(
            """INSERT INTO codex_chat_jobs
               (id, conversation_id, user_message_id, assistant_message_id,
                context_id, reasoning_effort, status, attempts, max_attempts,
                available_at, worker_id, lease_token, lease_expires_at,
                claimed_at, completed_at, last_error, completion_hash,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, 3, ?, ?, ?, ?, ?, ?,
                       NULL, NULL, ?, ?)""",
            (
                job_id,
                CONVERSATION_ID,
                user_id,
                assistant_message_id,
                context_id,
                status,
                attempts,
                index,
                "worker" if leased else None,
                f"lease-{index}" if leased else None,
                lease_expires_at,
                index if leased else None,
                index if status in {"completed", "failed", "cancelled"} else None,
                index,
                index,
            ),
        )
        if proposal_status is not None:
            self.db.execute(
                """INSERT INTO codex_chat_action_proposals
                   (id, conversation_id, job_id, assistant_message_id, status,
                    action_plan_json, result_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)""",
                (
                    f"proposal-{index}",
                    CONVERSATION_ID,
                    job_id,
                    assistant_id,
                    proposal_status,
                    index,
                    index,
                ),
            )
        return job_id

    def test_expired_leases_requeue_or_fail_and_clear_lease_fields(self) -> None:
        retry_id = self._insert_job(
            1,
            status="leased",
            attempts=1,
            lease_expires_at=10,
        )
        fail_id = self._insert_job(
            2,
            status="leased",
            attempts=3,
            lease_expires_at=10,
        )
        self.db.execute(
            """INSERT INTO codex_chat_bridge_heartbeat
               (id, last_seen_at, status, bridge_version, model, active_job_id)
               VALUES (?, 1, 'working', NULL, NULL, ?)""",
            (CONVERSATION_ID, retry_id),
        )
        now = 20
        self.db.execute(
            """UPDATE codex_chat_jobs
               SET status = 'failed', worker_id = NULL, lease_token = NULL,
                   lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
                   updated_at = ?,
                   last_error = COALESCE(last_error, 'max_attempts_exhausted')
               WHERE attempts >= max_attempts
                 AND (status = 'queued' OR
                      (status = 'leased' AND lease_expires_at <= ?))""",
            (now, now, now),
        )
        self.db.execute(
            """UPDATE codex_chat_jobs
               SET status = 'queued', available_at = ?, worker_id = NULL,
                   lease_token = NULL, lease_expires_at = NULL,
                   claimed_at = NULL, updated_at = ?,
                   last_error = 'lease_expired'
               WHERE status = 'leased' AND lease_expires_at <= ?
                 AND attempts < max_attempts""",
            (now, now, now),
        )
        self.db.execute(
            """UPDATE codex_chat_bridge_heartbeat
               SET status = CASE
                     WHEN status = 'working' THEN 'idle' ELSE status
                   END,
                   active_job_id = NULL
               WHERE id = ? AND active_job_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_jobs j
                   WHERE j.id = codex_chat_bridge_heartbeat.active_job_id
                     AND j.status = 'leased' AND j.lease_expires_at > ?
                 )""",
            (CONVERSATION_ID, now),
        )
        rows = self.db.execute(
            """SELECT id, status, worker_id, lease_token, lease_expires_at,
                      claimed_at
               FROM codex_chat_jobs WHERE id IN (?, ?) ORDER BY id""",
            (retry_id, fail_id),
        ).fetchall()
        self.assertEqual(
            rows,
            [
                (retry_id, "queued", None, None, None, None),
                (fail_id, "failed", None, None, None, None),
            ],
        )
        self.assertEqual(
            self.db.execute(
                """SELECT status, active_job_id
                   FROM codex_chat_bridge_heartbeat WHERE id = ?""",
                (CONVERSATION_ID,),
            ).fetchone(),
            ("idle", None),
        )

    def test_expired_lease_marker_preserves_schema_check_until_requeue(self) -> None:
        job_id = self._insert_job(
            3,
            status="leased",
            attempts=1,
            lease_expires_at=10,
        )
        self.db.execute(
            "UPDATE codex_chat_conversations SET codex_thread_id = ? WHERE id = ?",
            ("thread-old", CONVERSATION_ID),
        )
        now = 20
        marker = "expired:test-transition"

        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """UPDATE codex_chat_jobs
                   SET worker_id = ?, lease_token = NULL
                   WHERE id = ? AND status = 'leased'""",
                (marker, job_id),
            )

        self.db.execute(
            """UPDATE codex_chat_jobs
               SET worker_id = ?, lease_token = ?
               WHERE conversation_id = ? AND status = 'leased'
                 AND lease_expires_at <= ?""",
            (marker, marker, CONVERSATION_ID, now),
        )
        self.db.execute(
            """UPDATE codex_chat_conversations
               SET codex_thread_id = NULL
               WHERE id = ? AND codex_thread_id IS ?
                 AND EXISTS (
                   SELECT 1 FROM codex_chat_jobs
                   WHERE conversation_id = ? AND status = 'leased'
                     AND worker_id = ? AND lease_token = ?
                 )""",
            (
                CONVERSATION_ID,
                "thread-old",
                CONVERSATION_ID,
                marker,
                marker,
            ),
        )
        self.db.execute(
            """UPDATE codex_chat_jobs
               SET status = 'queued', available_at = ?, worker_id = NULL,
                   lease_token = NULL, lease_expires_at = NULL,
                   claimed_at = NULL, updated_at = ?,
                   last_error = 'lease_expired'
               WHERE conversation_id = ? AND status = 'leased'
                 AND worker_id = ? AND lease_token = ?
                 AND attempts < max_attempts""",
            (now, now, CONVERSATION_ID, marker, marker),
        )

        self.assertEqual(
            self.db.execute(
                """SELECT status, worker_id, lease_token, lease_expires_at,
                          claimed_at, last_error
                   FROM codex_chat_jobs WHERE id = ?""",
                (job_id,),
            ).fetchone(),
            ("queued", None, None, None, None, "lease_expired"),
        )
        self.assertIsNone(
            self.db.execute(
                "SELECT codex_thread_id FROM codex_chat_conversations WHERE id = ?",
                (CONVERSATION_ID,),
            ).fetchone()[0],
        )

    def test_retention_is_bounded_and_preserves_live_references(self) -> None:
        for index in range(510):
            self._insert_job(
                index,
                status="completed",
                proposal_status="applied",
            )
        self._insert_job(10_000, status="completed", proposal_status="proposed")
        for index in range(80):
            self.db.execute(
                """INSERT INTO codex_chat_messages
                   (id, conversation_id, role, text, client_message_id,
                    reasoning_effort, model, created_at)
                   VALUES (?, ?, 'assistant', 'history', NULL,
                           'medium', 'gpt-5.6-sol', ?)""",
                (f"history-{index}", CONVERSATION_ID, 15_000 + index),
            )
        self._insert_job(10_001, status="queued")
        for index in range(130):
            self.db.execute(
                """INSERT INTO codex_chat_messages
                   (id, conversation_id, role, text, client_message_id,
                    reasoning_effort, model, created_at)
                   VALUES (?, ?, 'assistant', 'orphan', NULL,
                           'medium', 'gpt-5.6-sol', ?)""",
                (f"orphan-{index}", CONVERSATION_ID, 20_000 + index),
            )

        self.db.execute(
            """DELETE FROM codex_chat_action_proposals
               WHERE conversation_id = ?
                 AND status IN ('applied', 'failed', 'dismissed')
                 AND id NOT IN (
                   SELECT id FROM codex_chat_action_proposals
                   WHERE conversation_id = ?
                     AND status IN ('applied', 'failed', 'dismissed')
                   ORDER BY updated_at DESC, created_at DESC LIMIT ?
                 )""",
            (
                CONVERSATION_ID,
                CONVERSATION_ID,
                RETAIN_RESOLVED_PROPOSALS,
            ),
        )
        self.db.execute(
            """DELETE FROM codex_chat_jobs
               WHERE conversation_id = ?
                 AND status IN ('completed', 'failed', 'cancelled')
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_action_proposals p
                   WHERE p.job_id = codex_chat_jobs.id
                     AND p.status = 'proposed'
                 )
                 AND id NOT IN (
                   SELECT j.id FROM codex_chat_jobs j
                   WHERE j.conversation_id = ?
                     AND j.status IN ('completed', 'failed', 'cancelled')
                     AND NOT EXISTS (
                       SELECT 1 FROM codex_chat_action_proposals p2
                       WHERE p2.job_id = j.id AND p2.status = 'proposed'
                     )
                   ORDER BY j.updated_at DESC, j.created_at DESC LIMIT ?
                 )""",
            (CONVERSATION_ID, CONVERSATION_ID, RETAIN_TERMINAL_JOBS),
        )
        self.db.execute(
            """DELETE FROM codex_chat_contexts
               WHERE conversation_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_jobs j
                   WHERE j.context_id = codex_chat_contexts.id
                 )""",
            (CONVERSATION_ID,),
        )
        self.db.execute(
            """DELETE FROM codex_chat_messages
               WHERE conversation_id = ?
                 AND sequence NOT IN (
                   SELECT sequence FROM codex_chat_messages
                   WHERE conversation_id = ?
                   ORDER BY sequence DESC LIMIT ?
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_jobs j
                   WHERE j.user_message_id = codex_chat_messages.id
                      OR j.assistant_message_id = codex_chat_messages.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_action_proposals p
                   WHERE p.assistant_message_id = codex_chat_messages.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM codex_chat_jobs pending
                   JOIN codex_chat_messages anchor
                     ON anchor.id = pending.user_message_id
                   WHERE pending.conversation_id = ?
                     AND pending.status IN ('queued', 'leased')
                     AND codex_chat_messages.sequence IN (
                       SELECT tail.sequence FROM codex_chat_messages tail
                       WHERE tail.conversation_id = pending.conversation_id
                         AND tail.sequence <= anchor.sequence
                       ORDER BY tail.sequence DESC LIMIT ?
                     )
                 )""",
            (
                CONVERSATION_ID,
                CONVERSATION_ID,
                RETAIN_TRANSCRIPT_MESSAGES,
                CONVERSATION_ID,
                TRANSCRIPT_LIMIT,
            ),
        )

        status_counts = dict(
            self.db.execute(
                "SELECT status, COUNT(*) FROM codex_chat_jobs GROUP BY status"
            ).fetchall()
        )
        proposal_counts = dict(
            self.db.execute(
                """SELECT status, COUNT(*)
                   FROM codex_chat_action_proposals GROUP BY status"""
            ).fetchall()
        )
        orphan_count = self.db.execute(
            "SELECT COUNT(*) FROM codex_chat_messages WHERE id LIKE 'orphan-%'"
        ).fetchone()[0]
        history_count = self.db.execute(
            "SELECT COUNT(*) FROM codex_chat_messages WHERE id LIKE 'history-%'"
        ).fetchone()[0]
        self.assertEqual(status_counts, {"completed": 501, "queued": 1})
        self.assertEqual(proposal_counts, {"applied": 500, "proposed": 1})
        self.assertEqual(orphan_count, RETAIN_TRANSCRIPT_MESSAGES)
        self.assertEqual(history_count, TRANSCRIPT_LIMIT - 1)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_proposal_revision_tracks_status_only_updates(self) -> None:
        self._insert_job(1, status="completed", proposal_status="proposed")
        initial = self.db.execute(
            """SELECT COALESCE(MAX(updated_at), 0)
               FROM codex_chat_action_proposals
               WHERE conversation_id = ?""",
            (CONVERSATION_ID,),
        ).fetchone()[0]
        self.db.execute(
            """UPDATE codex_chat_action_proposals
               SET status = 'dismissed', updated_at = ?
               WHERE conversation_id = ?""",
            (initial + 1, CONVERSATION_ID),
        )
        revised = self.db.execute(
            """SELECT COALESCE(MAX(updated_at), 0)
               FROM codex_chat_action_proposals
               WHERE conversation_id = ?""",
            (CONVERSATION_ID,),
        ).fetchone()[0]
        self.assertGreater(revised, initial)


if __name__ == "__main__":
    unittest.main()
