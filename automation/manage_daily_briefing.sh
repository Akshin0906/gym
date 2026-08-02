#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${WORKOUT_AUTOMATION_RUNTIME:-$HOME/.workout-tracker-codex-daily}"
OURA_SOURCE="${WORKOUT_OURA_SOURCE:-/Users/Apple/Documents/Codex/2026-06-04/files-mentioned-by-the-user-pasted/outputs/oura-codex-health}"
LABEL="com.workout-tracker.codex-daily-briefing"
AWAKE_LABEL="com.workout-tracker.codex-keep-awake"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_TARGET="$AGENTS_DIR/$LABEL.plist"
AWAKE_PLIST_TARGET="$AGENTS_DIR/$AWAKE_LABEL.plist"
DOMAIN="gui/$(id -u)"

LAUNCHCTL="${WORKOUT_LAUNCHCTL:-launchctl}"
RSYNC="${WORKOUT_RSYNC:-/usr/bin/rsync}"
PLUTIL="${WORKOUT_PLUTIL:-/usr/bin/plutil}"
PYTHON="${WORKOUT_PYTHON:-/usr/bin/python3}"
MV="${WORKOUT_MV:-/bin/mv}"
LOCK_TIMEOUT_SECONDS="${WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS:-60}"
ROLLBACK_FAILURE_EXIT=74

RELEASES_ROOT="$RUNTIME_ROOT/releases"
OURA_RELEASES_ROOT="$RUNTIME_ROOT/oura-releases"
ROLLBACK_BUNDLES_ROOT="$RUNTIME_ROOT/rollback-bundles"
OURA_LIVE="$RUNTIME_ROOT/oura-codex-health"
OURA_MUTABLE="$RUNTIME_ROOT/oura-mutable"
CODEX_HOME_TARGET="$RUNTIME_ROOT/codex-home"
RUNNER_LOCK="$RUNTIME_ROOT/state/runner.lock"

SUCCESS=0
LOCK_HELD=0
SWITCH_STARTED=0
ROLLBACK_FAILED=0
ACTIVE_CHILD_PID=""
LOADED_TRANSACTION_PHASE=""
TXN_DIR=""
RELEASE_ID=""
NEW_RELEASE_FINAL=""
NEW_OURA_FINAL=""
NEW_ROLLBACK_FINAL=""
OLD_CURRENT_KIND="absent"
OLD_CURRENT_TARGET=""
OLD_OURA_KIND="absent"
OLD_OURA_TARGET=""
OLD_OURA_LEGACY=""
OLD_OURA_DIRECTORY_ID=""
OLD_MUTABLE_PRESENT=0
OLD_MUTABLE_ID=""
OLD_CODEX_HOME_PRESENT=0
OLD_CODEX_HOME_ID=""
OLD_CREDENTIAL_PRESENT=0
OLD_DAILY_PLIST_PRESENT=0
OLD_AWAKE_PLIST_PRESENT=0
DAILY_WAS_LOADED=0
AWAKE_WAS_LOADED=0
OLD_DAILY_DISABLED=2
OLD_AWAKE_DISABLED=2

SUPERVISOR_CODE='
import contextlib
import os
import signal
import subprocess
import sys

child = None

def stop(signum, _frame):
    if child is not None and child.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signum)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
pass_fds = ()
with contextlib.suppress(OSError):
    os.fstat(9)
    pass_fds = (9,)
child = subprocess.Popen(sys.argv[1:], start_new_session=True, pass_fds=pass_fds)
try:
    raise SystemExit(child.wait())
except BaseException:
    if child.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    raise
'

run_tracked() {
  local child_status=0
  "$PYTHON" -c "$SUPERVISOR_CODE" "$@" <&0 &
  ACTIVE_CHILD_PID="$!"
  wait "$ACTIVE_CHILD_PID" || child_status="$?"
  ACTIVE_CHILD_PID=""
  return "$child_status"
}

usage() {
  echo "Usage: $0 install|update|doctor|status|run-now|uninstall [runner options]"
}

path_identity() {
  "$PYTHON" - "$1" <<'PY'
import os
import stat
import sys

value = os.lstat(sys.argv[1])
kind = "symlink" if stat.S_ISLNK(value.st_mode) else "directory" if stat.S_ISDIR(value.st_mode) else "other"
print(f"{value.st_dev}:{value.st_ino}:{kind}")
PY
}

run_installed_runner() {
  run_tracked /usr/bin/env \
    HOME="$HOME" \
    WORKOUT_AUTOMATION_ROOT="$RUNTIME_ROOT" \
    WORKOUT_RELEASE_ROOT="$RUNTIME_ROOT/current" \
    WORKOUT_ENV_FILE="$RUNTIME_ROOT/credentials.env" \
    WORKOUT_OURA_ROOT="$OURA_LIVE" \
    WORKOUT_CODEX_HOME="$CODEX_HOME_TARGET" \
    WORKOUT_CODEX_MODEL="${WORKOUT_CODEX_MODEL:-gpt-5.6-sol}" \
    WORKOUT_CODEX_REASONING_EFFORT="${WORKOUT_CODEX_REASONING_EFFORT:-xhigh}" \
    "$RUNTIME_ROOT/current/run_codex_daily_briefing.sh" "$@"
}

agent_loaded() {
  "$LAUNCHCTL" print "$1" >/dev/null 2>&1
}

agent_disabled_state() {
  local label="$1"
  local output
  if ! output="$("$LAUNCHCTL" print-disabled "$DOMAIN" 2>/dev/null)"; then
    echo "Unable to read launchd disabled overrides for $DOMAIN." >&2
    return 1
  fi
  "$PYTHON" - "$label" "$output" <<'PY'
import re
import sys

label, output = sys.argv[1:]
match = re.search(
    rf'["\x27]?{re.escape(label)}["\x27]?\s*=>\s*(true|false)',
    output,
    flags=re.IGNORECASE,
)
if not match:
    print("2")
else:
    print("1" if match.group(1).lower() == "true" else "0")
PY
}

set_agent_disabled_state() {
  local label="$1"
  local disabled="$2"
  case "$disabled" in
    1) run_tracked "$LAUNCHCTL" disable "$DOMAIN/$label" ;;
    0) run_tracked "$LAUNCHCTL" enable "$DOMAIN/$label" ;;
    2) return 0 ;;
    *) return 2 ;;
  esac
}

bootout_if_loaded() {
  local target="$1"
  if agent_loaded "$target"; then
    run_tracked "$LAUNCHCTL" bootout --wait "$target"
  fi
}

acquire_runner_lock() {
  local timeout="${1:-$LOCK_TIMEOUT_SECONDS}"
  local deadline=""
  local lock_status=0
  mkdir -p "$RUNTIME_ROOT/state"
  chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/state"
  exec 9>>"$RUNNER_LOCK"
  chmod 600 "$RUNNER_LOCK"
  if ! deadline="$("$PYTHON" - "$timeout" <<'PY'
import sys
import time

try:
    timeout = float(sys.argv[1])
except (TypeError, ValueError) as exc:
    raise SystemExit("WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS must be a non-negative number") from exc
if timeout < 0:
    raise SystemExit("WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS must be non-negative")
print(time.time() + timeout)
PY
  )"; then
    exec 9>&-
    echo "Unable to calculate the daily briefing lock deadline." >&2
    return 2
  fi

  while true; do
    lock_status=0
    "$PYTHON" - "$deadline" 9 <<'PY' || lock_status="$?"
import fcntl
import sys
import time

deadline = float(sys.argv[1])
fd = int(sys.argv[2])
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    remaining = deadline - time.time()
    if remaining <= 0:
        raise SystemExit(75)
    time.sleep(min(0.1, remaining))
    raise SystemExit(76)
PY
    case "$lock_status" in
      0)
        LOCK_HELD=1
        return 0
        ;;
      76)
        continue
        ;;
      75)
        exec 9>&-
        echo "Daily briefing runner is still active after ${timeout}s; update refused." >&2
        return 75
        ;;
      *)
        exec 9>&-
        echo "Unable to acquire the daily briefing runner lock (status $lock_status)." >&2
        return "$lock_status"
        ;;
    esac
  done
}

release_runner_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    exec 9>&-
    LOCK_HELD=0
  fi
}

atomic_symlink() {
  local target="$1"
  local link="$2"
  local next="$link.next-$$"
  rm -f "$next"
  ln -s "$target" "$next"
  run_tracked "$PYTHON" - "$next" "$link" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

atomic_install_file() {
  local source="$1"
  local target="$2"
  local mode="$3"
  run_tracked "$PYTHON" - "$source" "$target" "$mode" <<'PY'
import os
import shutil
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
mode = int(sys.argv[3], 8)
target.parent.mkdir(parents=True, exist_ok=True)
temporary = target.with_name(f".{target.name}.install-{os.getpid()}")
try:
    with source.open("rb") as src, temporary.open("wb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    temporary.chmod(mode)
    os.replace(temporary, target)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
PY
}

render_plist() {
  local source="$1"
  local target="$2"
  run_tracked "$PYTHON" - "$source" "$target" "$HOME" "$RUNTIME_ROOT" <<'PY'
import sys
from pathlib import Path

source, target, home, runtime = map(Path, sys.argv[1:])
text = source.read_text(encoding="utf-8")
text = text.replace("__HOME__", str(home)).replace("__RUNTIME_ROOT__", str(runtime))
if "__HOME__" in text or "__RUNTIME_ROOT__" in text:
    raise SystemExit("Rendered plist still contains an unresolved placeholder")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding="utf-8")
target.chmod(0o600)
PY
  run_tracked "$PLUTIL" -lint "$target" >/dev/null
}

stage_runtime_credential() {
  local target="$1"
  local source_env="$ROOT/.env"
  local existing="$RUNTIME_ROOT/credentials.env"
  run_tracked "$PYTHON" - "$source_env" "$existing" "$target" <<'PY'
import os
import sys
from pathlib import Path

source, existing, target = map(Path, sys.argv[1:])

def read_secret(path: Path):
    if not path.is_file():
        return None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, candidate = line.split("=", 1)
        if key.strip() != "CLOUD_AUTOMATION_SECRET":
            continue
        candidate = candidate.strip()
        if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in {"'", '"'}:
            candidate = candidate[1:-1]
        return candidate or None
    return None

value = read_secret(source) or read_secret(existing)
if not value:
    raise SystemExit("CLOUD_AUTOMATION_SECRET is unavailable in the source or installed credentials")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(f"CLOUD_AUTOMATION_SECRET={value}\n", encoding="utf-8")
target.chmod(0o600)
PY
}

stage_codex_home() {
  local target="$1"
  local configured_source="${WORKOUT_CODEX_AUTH_SOURCE:-}"
  local source=""
  if [[ -n "$configured_source" ]]; then
    source="$configured_source"
  elif [[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]]; then
    source="${CODEX_HOME:-$HOME/.codex}/auth.json"
  elif [[ -f "$CODEX_HOME_TARGET/auth.json" ]]; then
    source="$CODEX_HOME_TARGET/auth.json"
  else
    echo "ChatGPT Codex auth.json is unavailable." >&2
    return 1
  fi
  mkdir -p "$target"
  chmod 700 "$target"
  atomic_install_file "$source" "$target/auth.json" 600
  run_tracked "$PYTHON" - "$target" <<'PY'
import json
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
entries = list(root.iterdir())
if [item.name for item in entries] != ["auth.json"]:
    raise SystemExit("Dedicated Codex home must contain only auth.json")
auth = entries[0]
if auth.is_symlink() or not auth.is_file():
    raise SystemExit("Codex auth.json must be a regular file")
if stat.S_IMODE(root.stat().st_mode) != 0o700:
    raise SystemExit("Dedicated Codex home must use mode 0700")
if stat.S_IMODE(auth.stat().st_mode) != 0o600:
    raise SystemExit("Codex auth.json must use mode 0600")
value = json.loads(auth.read_text(encoding="utf-8"))
if not isinstance(value, dict):
    raise SystemExit("Codex auth.json must contain a JSON object")
PY
}

mutable_source_root() {
  if [[ -d "$OURA_MUTABLE" && -f "$OURA_MUTABLE/.env" ]]; then
    printf '%s\n' "$OURA_MUTABLE"
    return
  fi
  if [[ -e "$OURA_LIVE" || -L "$OURA_LIVE" ]]; then
    local resolved
    resolved="$(cd "$OURA_LIVE" 2>/dev/null && pwd -P)" || true
    if [[ -n "$resolved" && -f "$resolved/.env" ]]; then
      printf '%s\n' "$resolved"
      return
    fi
  fi
  printf '%s\n' "$OURA_SOURCE"
}

stage_oura_mutable() {
  local target="$1"
  local source
  source="$(mutable_source_root)"
  if [[ ! -f "$source/.env" || ! -f "$source/data/oura_health.sqlite3" ]]; then
    echo "Oura credentials or database are missing from $source" >&2
    return 1
  fi
  mkdir -p "$target/data" "$target/reports"
  chmod 700 "$target" "$target/data" "$target/reports"
  atomic_install_file "$source/.env" "$target/.env" 600
  run_tracked "$RSYNC" -a --delete "$source/data/" "$target/data/"
  if [[ -d "$source/reports" ]]; then
    run_tracked "$RSYNC" -a --delete "$source/reports/" "$target/reports/"
  fi
  run_tracked /bin/chmod -R go-rwx "$target"
  chmod 600 "$target/.env" "$target/data/oura_health.sqlite3"
  run_tracked "$PYTHON" - "$target/data/oura_health.sqlite3" <<'PY'
import sqlite3
import sys
from pathlib import Path

path = Path(sys.argv[1])
uri = f"file:{path}?mode=ro"
with sqlite3.connect(uri, uri=True) as database:
    result = database.execute("PRAGMA quick_check").fetchone()
if not result or result[0] != "ok":
    raise SystemExit("Staged Oura database failed PRAGMA quick_check")
PY
}

stage_oura_code() {
  local target="$1"
  if [[ ! -d "$OURA_SOURCE" ]]; then
    echo "Missing Oura companion project: $OURA_SOURCE" >&2
    return 1
  fi
  mkdir -p "$target"
  run_tracked "$RSYNC" -a --delete \
    --exclude '.env' \
    --exclude 'data/' \
    --exclude 'reports/' \
    --exclude '__pycache__/' \
    --exclude '.git/' \
    --exclude '.venv/' \
    "$OURA_SOURCE/" "$target/"
  ln -s "$OURA_MUTABLE/.env" "$target/.env"
  ln -s "$OURA_MUTABLE/data" "$target/data"
  ln -s "$OURA_MUTABLE/reports" "$target/reports"
  run_tracked /bin/chmod -R go-rwx "$target"
  if [[ ! -f "$target/oura_health/__main__.py" ]]; then
    echo "Staged Oura code is missing oura_health/__main__.py" >&2
    return 1
  fi
  run_tracked "$PYTHON" - "$target" <<'PY'
import ast
import sys
from pathlib import Path

root = Path(sys.argv[1])
files = list(root.rglob("*.py"))
if not files:
    raise SystemExit("Staged Oura code contains no Python files")
for path in files:
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
PY
  if [[ -f "$target/run_daily.sh" ]]; then
    run_tracked /bin/bash -n "$target/run_daily.sh"
  fi
}

stage_release() {
  local target="$1"
  mkdir -p "$target"
  install -m 700 "$SCRIPT_DIR/run_codex_daily_briefing.sh" "$target/"
  install -m 600 "$SCRIPT_DIR/daily_briefing_runner.py" "$target/"
  install -m 600 "$SCRIPT_DIR/codex_daily_briefing_prompt.md" "$target/"
  install -m 600 "$SCRIPT_DIR/codex_daily_briefing_output_schema.json" "$target/"
  run_tracked /bin/bash -n "$target/run_codex_daily_briefing.sh"
  run_tracked "$PYTHON" -m py_compile "$target/daily_briefing_runner.py"
  run_tracked "$PYTHON" -m json.tool "$target/codex_daily_briefing_output_schema.json" >/dev/null
  if ! /usr/bin/grep -q 'WORKOUT_CODEX_HOME' "$target/daily_briefing_runner.py"; then
    echo "Daily runner does not implement the required WORKOUT_CODEX_HOME contract." >&2
    return 1
  fi
}

snapshot_live_state() {
  if [[ -L "$RUNTIME_ROOT/current" ]]; then
    OLD_CURRENT_KIND="symlink"
    OLD_CURRENT_TARGET="$(readlink "$RUNTIME_ROOT/current")"
  elif [[ -e "$RUNTIME_ROOT/current" ]]; then
    echo "$RUNTIME_ROOT/current must be a symlink before update." >&2
    return 1
  fi

  if [[ -L "$OURA_LIVE" ]]; then
    OLD_OURA_KIND="symlink"
    OLD_OURA_TARGET="$(readlink "$OURA_LIVE")"
  elif [[ -d "$OURA_LIVE" ]]; then
    OLD_OURA_KIND="directory"
    OLD_OURA_DIRECTORY_ID="$(path_identity "$OURA_LIVE")"
  elif [[ -e "$OURA_LIVE" ]]; then
    echo "$OURA_LIVE must be a directory or symlink." >&2
    return 1
  fi

  if [[ -d "$OURA_MUTABLE" ]]; then
    OLD_MUTABLE_PRESENT=1
    OLD_MUTABLE_ID="$(path_identity "$OURA_MUTABLE")"
  elif [[ -e "$OURA_MUTABLE" || -L "$OURA_MUTABLE" ]]; then
    echo "$OURA_MUTABLE must be a directory before update." >&2
    return 1
  fi
  if [[ -d "$CODEX_HOME_TARGET" ]]; then
    OLD_CODEX_HOME_PRESENT=1
    OLD_CODEX_HOME_ID="$(path_identity "$CODEX_HOME_TARGET")"
  elif [[ -e "$CODEX_HOME_TARGET" || -L "$CODEX_HOME_TARGET" ]]; then
    echo "$CODEX_HOME_TARGET must be a directory before update." >&2
    return 1
  fi
  if [[ -f "$RUNTIME_ROOT/credentials.env" && ! -L "$RUNTIME_ROOT/credentials.env" ]]; then
    OLD_CREDENTIAL_PRESENT=1
  elif [[ -e "$RUNTIME_ROOT/credentials.env" || -L "$RUNTIME_ROOT/credentials.env" ]]; then
    echo "$RUNTIME_ROOT/credentials.env must be a regular file before update." >&2
    return 1
  fi
  if [[ -f "$PLIST_TARGET" && ! -L "$PLIST_TARGET" ]]; then
    OLD_DAILY_PLIST_PRESENT=1
  elif [[ -e "$PLIST_TARGET" || -L "$PLIST_TARGET" ]]; then
    echo "$PLIST_TARGET must be a regular file before update." >&2
    return 1
  fi
  if [[ -f "$AWAKE_PLIST_TARGET" && ! -L "$AWAKE_PLIST_TARGET" ]]; then
    OLD_AWAKE_PLIST_PRESENT=1
  elif [[ -e "$AWAKE_PLIST_TARGET" || -L "$AWAKE_PLIST_TARGET" ]]; then
    echo "$AWAKE_PLIST_TARGET must be a regular file before update." >&2
    return 1
  fi
  OLD_DAILY_DISABLED="$(agent_disabled_state "$LABEL")"
  OLD_AWAKE_DISABLED="$(agent_disabled_state "$AWAKE_LABEL")"
  if agent_loaded "$DOMAIN/$LABEL"; then DAILY_WAS_LOADED=1; fi
  if agent_loaded "$DOMAIN/$AWAKE_LABEL"; then AWAKE_WAS_LOADED=1; fi

  mkdir -p "$TXN_DIR/backup"
  if [[ "$OLD_CREDENTIAL_PRESENT" -eq 1 ]]; then
    cp -p "$RUNTIME_ROOT/credentials.env" "$TXN_DIR/backup/credentials.env"
  fi
  if [[ "$OLD_DAILY_PLIST_PRESENT" -eq 1 ]]; then
    cp -p "$PLIST_TARGET" "$TXN_DIR/backup/daily.plist"
  fi
  if [[ "$OLD_AWAKE_PLIST_PRESENT" -eq 1 ]]; then
    cp -p "$AWAKE_PLIST_TARGET" "$TXN_DIR/backup/awake.plist"
  fi
}

stage_rollback_bundle() {
  local target="$1"
  local release_id="$2"
  mkdir -p "$target"
  chmod 700 "$target"
  if [[ "$OLD_DAILY_PLIST_PRESENT" -eq 1 ]]; then
    atomic_install_file "$TXN_DIR/backup/daily.plist" "$target/daily.plist" 600
  fi
  if [[ "$OLD_AWAKE_PLIST_PRESENT" -eq 1 ]]; then
    atomic_install_file "$TXN_DIR/backup/awake.plist" "$target/awake.plist" 600
  fi
  run_tracked "$PYTHON" - \
    "$target/metadata.json" \
    "$release_id" \
    "$OLD_CURRENT_KIND" \
    "$OLD_CURRENT_TARGET" \
    "$OLD_OURA_KIND" \
    "$OLD_OURA_TARGET" \
    "$OLD_OURA_LEGACY" \
    "$OLD_OURA_DIRECTORY_ID" \
    "$OLD_DAILY_PLIST_PRESENT" \
    "$OLD_AWAKE_PLIST_PRESENT" \
    "$DAILY_WAS_LOADED" \
    "$AWAKE_WAS_LOADED" \
    "$OLD_DAILY_DISABLED" \
    "$OLD_AWAKE_DISABLED" \
    "$NEW_RELEASE_FINAL" \
    "$NEW_OURA_FINAL" <<'PY'
import datetime as dt
import json
import sys
from pathlib import Path

(
    metadata_path,
    release_id,
    current_kind,
    current_target,
    oura_kind,
    oura_target,
    oura_legacy,
    oura_directory_id,
    daily_plist_present,
    awake_plist_present,
    daily_agent_loaded,
    awake_agent_loaded,
    daily_agent_disabled,
    awake_agent_disabled,
    replacement_release,
    replacement_oura_release,
) = sys.argv[1:]
metadata = {
    "bundleVersion": 1,
    "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    "replacement": {
        "id": release_id,
        "release": replacement_release,
        "ouraRelease": replacement_oura_release,
    },
    "previous": {
        "release": {"kind": current_kind, "target": current_target or None},
        "ouraRelease": {
            "kind": oura_kind,
            "target": oura_target or None,
            "legacyPath": oura_legacy or None,
            "directoryIdentity": oura_directory_id or None,
        },
        "plists": {
            "daily": "daily.plist" if int(daily_plist_present) else None,
            "keepAwake": "awake.plist" if int(awake_plist_present) else None,
        },
        "agentsLoaded": {
            "daily": bool(int(daily_agent_loaded)),
            "keepAwake": bool(int(awake_agent_loaded)),
        },
        "agentsDisabled": {
            "daily": {"0": "enabled", "1": "disabled", "2": "default"}[daily_agent_disabled],
            "keepAwake": {"0": "enabled", "1": "disabled", "2": "default"}[awake_agent_disabled],
        },
    },
}
path = Path(metadata_path)
path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
path.chmod(0o600)
PY
}

write_transaction_state() {
  local phase="$1"
  run_tracked "$PYTHON" - \
    "$TXN_DIR/transaction.json" \
    "$phase" \
    "$RELEASE_ID" \
    "$NEW_RELEASE_FINAL" \
    "$NEW_OURA_FINAL" \
    "$NEW_ROLLBACK_FINAL" \
    "$OLD_CURRENT_KIND" \
    "$OLD_CURRENT_TARGET" \
    "$OLD_OURA_KIND" \
    "$OLD_OURA_TARGET" \
    "$OLD_OURA_LEGACY" \
    "$OLD_OURA_DIRECTORY_ID" \
    "$OLD_MUTABLE_PRESENT" \
    "$OLD_MUTABLE_ID" \
    "$OLD_CODEX_HOME_PRESENT" \
    "$OLD_CODEX_HOME_ID" \
    "$OLD_CREDENTIAL_PRESENT" \
    "$OLD_DAILY_PLIST_PRESENT" \
    "$OLD_AWAKE_PLIST_PRESENT" \
    "$DAILY_WAS_LOADED" \
    "$AWAKE_WAS_LOADED" \
    "$OLD_DAILY_DISABLED" \
    "$OLD_AWAKE_DISABLED" <<'PY'
import json
import os
import sys
from pathlib import Path

(
    state_path,
    phase,
    release_id,
    new_release,
    new_oura,
    new_rollback,
    old_current_kind,
    old_current_target,
    old_oura_kind,
    old_oura_target,
    old_oura_legacy,
    old_oura_directory_id,
    old_mutable_present,
    old_mutable_id,
    old_codex_home_present,
    old_codex_home_id,
    old_credential_present,
    old_daily_plist_present,
    old_awake_plist_present,
    daily_was_loaded,
    awake_was_loaded,
    old_daily_disabled,
    old_awake_disabled,
) = sys.argv[1:]
state = {
    "transactionVersion": 1,
    "phase": phase,
    "releaseId": release_id,
    "new": {
        "release": new_release,
        "ouraRelease": new_oura,
        "rollbackBundle": new_rollback,
    },
    "old": {
        "current": {"kind": old_current_kind, "target": old_current_target},
        "oura": {
            "kind": old_oura_kind,
            "target": old_oura_target,
            "legacy": old_oura_legacy,
            "directoryIdentity": old_oura_directory_id,
        },
        "mutablePresent": bool(int(old_mutable_present)),
        "mutableIdentity": old_mutable_id,
        "codexHomePresent": bool(int(old_codex_home_present)),
        "codexHomeIdentity": old_codex_home_id,
        "credentialPresent": bool(int(old_credential_present)),
        "dailyPlistPresent": bool(int(old_daily_plist_present)),
        "awakePlistPresent": bool(int(old_awake_plist_present)),
        "dailyLoaded": bool(int(daily_was_loaded)),
        "awakeLoaded": bool(int(awake_was_loaded)),
        "dailyDisabled": int(old_daily_disabled),
        "awakeDisabled": int(old_awake_disabled),
    },
}
path = Path(state_path)
temporary = path.with_name(f".{path.name}.write-{os.getpid()}")
with temporary.open("w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
temporary.chmod(0o600)
os.replace(temporary, path)
PY
}

load_transaction_state() {
  local state_path="$1"
  local fields=()
  while IFS= read -r field; do
    fields[${#fields[@]}]="$field"
  done < <("$PYTHON" - "$state_path" <<'PY'
import json
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if state.get("transactionVersion") != 1:
    raise SystemExit("Unsupported interrupted transaction version")
old = state["old"]
new = state["new"]
values = [
    state["phase"],
    state["releaseId"],
    new["release"],
    new["ouraRelease"],
    new["rollbackBundle"],
    old["current"]["kind"],
    old["current"].get("target") or "",
    old["oura"]["kind"],
    old["oura"].get("target") or "",
    old["oura"].get("legacy") or "",
    old["oura"].get("directoryIdentity") or "",
    int(bool(old["mutablePresent"])),
    old.get("mutableIdentity") or "",
    int(bool(old["codexHomePresent"])),
    old.get("codexHomeIdentity") or "",
    int(bool(old["credentialPresent"])),
    int(bool(old["dailyPlistPresent"])),
    int(bool(old["awakePlistPresent"])),
    int(bool(old["dailyLoaded"])),
    int(bool(old["awakeLoaded"])),
    int(old["dailyDisabled"]),
    int(old["awakeDisabled"]),
]
for value in values:
    print(value)
PY
  ) || return 1
  if [[ "${#fields[@]}" -ne 22 ]]; then
    echo "Interrupted transaction metadata is incomplete: $state_path" >&2
    return 1
  fi
  RELEASE_ID="${fields[1]}"
  NEW_RELEASE_FINAL="${fields[2]}"
  NEW_OURA_FINAL="${fields[3]}"
  NEW_ROLLBACK_FINAL="${fields[4]}"
  OLD_CURRENT_KIND="${fields[5]}"
  OLD_CURRENT_TARGET="${fields[6]}"
  OLD_OURA_KIND="${fields[7]}"
  OLD_OURA_TARGET="${fields[8]}"
  OLD_OURA_LEGACY="${fields[9]}"
  OLD_OURA_DIRECTORY_ID="${fields[10]}"
  OLD_MUTABLE_PRESENT="${fields[11]}"
  OLD_MUTABLE_ID="${fields[12]}"
  OLD_CODEX_HOME_PRESENT="${fields[13]}"
  OLD_CODEX_HOME_ID="${fields[14]}"
  OLD_CREDENTIAL_PRESENT="${fields[15]}"
  OLD_DAILY_PLIST_PRESENT="${fields[16]}"
  OLD_AWAKE_PLIST_PRESENT="${fields[17]}"
  DAILY_WAS_LOADED="${fields[18]}"
  AWAKE_WAS_LOADED="${fields[19]}"
  OLD_DAILY_DISABLED="${fields[20]}"
  OLD_AWAKE_DISABLED="${fields[21]}"
  LOADED_TRANSACTION_PHASE="${fields[0]}"
}

path_present() {
  [[ -e "$1" || -L "$1" ]]
}

symlink_points_to() {
  [[ -L "$1" && "$(readlink "$1")" == "$2" ]]
}

recovery_error() {
  echo "Recovery error: $1" >&2
  ROLLBACK_FAILED=1
}

restore_current_link() {
  local live="$RUNTIME_ROOT/current"
  rm -f "$live.next-$$"
  if [[ "$OLD_CURRENT_KIND" == "symlink" ]]; then
    if symlink_points_to "$live" "$OLD_CURRENT_TARGET"; then
      return
    fi
    if ! path_present "$live" || symlink_points_to "$live" "$NEW_RELEASE_FINAL"; then
      if ! atomic_symlink "$OLD_CURRENT_TARGET" "$live"; then
        recovery_error "could not restore the previous current release link"
      fi
      return
    fi
    recovery_error "current release has an unexpected target; it was not overwritten"
    return
  fi
  if ! path_present "$live"; then
    return
  fi
  if symlink_points_to "$live" "$NEW_RELEASE_FINAL"; then
    rm -f "$live" || recovery_error "could not remove the replacement current link"
  else
    recovery_error "current release is unexpected; it was not removed"
  fi
}

restore_oura_link() {
  local live="$OURA_LIVE"
  local live_id=""
  local legacy_id=""
  rm -f "$live.next-$$"
  case "$OLD_OURA_KIND" in
    symlink)
      if symlink_points_to "$live" "$OLD_OURA_TARGET"; then
        return
      fi
      if ! path_present "$live" || symlink_points_to "$live" "$NEW_OURA_FINAL"; then
        if ! atomic_symlink "$OLD_OURA_TARGET" "$live"; then
          recovery_error "could not restore the previous Oura release link"
        fi
      else
        recovery_error "Oura release has an unexpected target; it was not overwritten"
      fi
      ;;
    directory)
      if [[ -d "$live" && ! -L "$live" ]]; then
        live_id="$(path_identity "$live" 2>/dev/null)"
        if [[ "$live_id" != "$OLD_OURA_DIRECTORY_ID" ]]; then
          recovery_error "the live Oura directory is not the recorded previous directory"
        fi
        return
      fi
      if [[ -n "$OLD_OURA_LEGACY" ]] && path_present "$OLD_OURA_LEGACY"; then
        legacy_id="$(path_identity "$OLD_OURA_LEGACY" 2>/dev/null)"
      fi
      if [[ "$legacy_id" != "$OLD_OURA_DIRECTORY_ID" ]]; then
        recovery_error "the previous Oura directory backup is missing or has changed"
        return
      fi
      if path_present "$live"; then
        if symlink_points_to "$live" "$NEW_OURA_FINAL"; then
          if ! rm -f "$live"; then
            recovery_error "could not remove the replacement Oura link"
            return
          fi
        else
          recovery_error "the live Oura path is unexpected; it was not removed"
          return
        fi
      fi
      if ! run_tracked "$MV" "$OLD_OURA_LEGACY" "$live"; then
        recovery_error "could not move the previous Oura directory back into place"
      fi
      ;;
    absent)
      if ! path_present "$live"; then
        return
      fi
      if symlink_points_to "$live" "$NEW_OURA_FINAL"; then
        rm -f "$live" || recovery_error "could not remove the replacement Oura link"
      else
        recovery_error "an unexpected Oura path exists; it was not removed"
      fi
      ;;
    *)
      recovery_error "the recorded previous Oura path kind is invalid"
      ;;
  esac
}

restore_moved_tree() {
  local old_present="$1"
  local old_identity="$2"
  local backup="$3"
  local live="$4"
  local staged="$5"
  local description="$6"
  local live_id=""
  local backup_id=""

  if [[ "$old_present" -eq 1 ]]; then
    if path_present "$backup"; then
      backup_id="$(path_identity "$backup" 2>/dev/null)"
      if [[ "$backup_id" != "$old_identity" ]]; then
        recovery_error "$description backup identity does not match the previous installation"
        return
      fi
      if path_present "$live"; then
        live_id="$(path_identity "$live" 2>/dev/null)"
        if [[ "$live_id" == "$old_identity" ]]; then
          recovery_error "$description exists in both live and backup locations"
          return
        fi
        if path_present "$staged"; then
          recovery_error "$description replacement was not proven to have moved; live data was preserved"
          return
        fi
        if ! rm -rf "$live"; then
          recovery_error "could not remove the replacement $description"
          return
        fi
      fi
      if ! run_tracked "$MV" "$backup" "$live"; then
        recovery_error "could not restore the previous $description"
      fi
      return
    fi

    if path_present "$live"; then
      live_id="$(path_identity "$live" 2>/dev/null)"
      if [[ "$live_id" == "$old_identity" ]]; then
        return
      fi
    fi
    recovery_error "the previous $description is missing; no live data was deleted"
    return
  fi

  if ! path_present "$live"; then
    return
  fi
  if path_present "$staged"; then
    recovery_error "an unexpected live $description exists while its staged replacement remains"
    return
  fi
  rm -rf "$live" || recovery_error "could not remove the replacement $description"
}

restore_transaction_file() {
  local old_present="$1"
  local backup="$2"
  local staged="$3"
  local target="$4"
  local description="$5"

  if [[ "$old_present" -eq 1 ]]; then
    if [[ ! -f "$backup" ]]; then
      recovery_error "the previous $description backup is missing"
      return
    fi
    if [[ -f "$target" ]] && /usr/bin/cmp -s "$backup" "$target"; then
      return
    fi
    if ! path_present "$target" || { [[ -f "$target" && -f "$staged" ]] && /usr/bin/cmp -s "$staged" "$target"; }; then
      if ! atomic_install_file "$backup" "$target" 600; then
        recovery_error "could not restore the previous $description"
      fi
      return
    fi
    recovery_error "$description changed unexpectedly; it was not overwritten"
    return
  fi

  if ! path_present "$target"; then
    return
  fi
  if [[ -f "$target" && -f "$staged" ]] && /usr/bin/cmp -s "$staged" "$target"; then
    rm -f "$target" || recovery_error "could not remove the replacement $description"
  else
    recovery_error "an unexpected $description exists; it was not removed"
  fi
}

restore_agent() {
  local label="$1"
  local plist="$2"
  local was_loaded="$3"
  local was_disabled="$4"

  if [[ "$was_disabled" -eq 1 ]]; then
    if ! set_agent_disabled_state "$label" 0; then
      recovery_error "could not temporarily enable $label for restoration"
      return
    fi
  fi
  if [[ "$was_loaded" -eq 1 ]]; then
    if [[ ! -f "$plist" ]] || ! run_tracked "$LAUNCHCTL" bootstrap "$DOMAIN" "$plist"; then
      recovery_error "could not restore loaded agent $label"
      return
    fi
  fi
  if ! set_agent_disabled_state "$label" "$was_disabled"; then
    recovery_error "could not restore the disabled override for $label"
  fi
}

verify_agent() {
  local label="$1"
  local was_loaded="$2"
  local was_disabled="$3"
  local loaded=0
  local disabled=""
  if agent_loaded "$DOMAIN/$label"; then loaded=1; fi
  if [[ "$loaded" -ne "$was_loaded" ]]; then
    recovery_error "loaded state for $label was not restored"
  fi
  if ! disabled="$(agent_disabled_state "$label")"; then
    recovery_error "disabled override for $label could not be verified"
  elif [[ "$disabled" -ne "$was_disabled" ]]; then
    recovery_error "disabled override for $label was not restored"
  fi
}

remove_replacement_artifacts() {
  if symlink_points_to "$RUNTIME_ROOT/current" "$NEW_RELEASE_FINAL" || \
     symlink_points_to "$OURA_LIVE" "$NEW_OURA_FINAL"; then
    recovery_error "replacement releases are still live and were retained"
    return
  fi
  if [[ -n "$NEW_RELEASE_FINAL" ]] && path_present "$NEW_RELEASE_FINAL"; then
    rm -rf "$NEW_RELEASE_FINAL" || recovery_error "could not remove the replacement app release"
  fi
  if [[ -n "$NEW_OURA_FINAL" ]] && path_present "$NEW_OURA_FINAL"; then
    rm -rf "$NEW_OURA_FINAL" || recovery_error "could not remove the replacement Oura release"
  fi
  if [[ -n "$NEW_ROLLBACK_FINAL" ]] && path_present "$NEW_ROLLBACK_FINAL"; then
    rm -rf "$NEW_ROLLBACK_FINAL" || recovery_error "could not remove the failed rollback bundle"
  fi
}

rollback_install() {
  set +e
  ROLLBACK_FAILED=0

  if [[ "$SWITCH_STARTED" -ne 1 ]]; then
    echo "Daily automation update failed before the live installation changed." >&2
    remove_replacement_artifacts
    [[ "$ROLLBACK_FAILED" -eq 0 ]]
    return
  fi

  echo "Daily automation update failed; restoring the previous installation." >&2
  if [[ "$LOCK_HELD" -eq 0 ]] && ! acquire_runner_lock 30; then
    recovery_error "runner.lock could not be acquired; live files were not changed"
    return "$ROLLBACK_FAILURE_EXIT"
  fi

  if ! bootout_if_loaded "$DOMAIN/$LABEL"; then
    recovery_error "daily launch agent could not be stopped"
  fi
  if ! bootout_if_loaded "$DOMAIN/$AWAKE_LABEL"; then
    recovery_error "keep-awake launch agent could not be stopped"
  fi
  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
    return "$ROLLBACK_FAILURE_EXIT"
  fi

  restore_current_link
  restore_oura_link
  restore_moved_tree \
    "$OLD_MUTABLE_PRESENT" "$OLD_MUTABLE_ID" \
    "$TXN_DIR/backup/oura-mutable" "$OURA_MUTABLE" "$TXN_DIR/oura-mutable" \
    "Oura mutable data"
  restore_moved_tree \
    "$OLD_CODEX_HOME_PRESENT" "$OLD_CODEX_HOME_ID" \
    "$TXN_DIR/backup/codex-home" "$CODEX_HOME_TARGET" "$TXN_DIR/codex-home" \
    "Codex home"
  restore_transaction_file \
    "$OLD_CREDENTIAL_PRESENT" "$TXN_DIR/backup/credentials.env" \
    "$TXN_DIR/credentials.env" "$RUNTIME_ROOT/credentials.env" "credential file"
  restore_transaction_file \
    "$OLD_DAILY_PLIST_PRESENT" "$TXN_DIR/backup/daily.plist" \
    "$TXN_DIR/daily.plist" "$PLIST_TARGET" "daily plist"
  restore_transaction_file \
    "$OLD_AWAKE_PLIST_PRESENT" "$TXN_DIR/backup/awake.plist" \
    "$TXN_DIR/awake.plist" "$AWAKE_PLIST_TARGET" "keep-awake plist"

  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
    echo "Recovery was incomplete; launch agents remain stopped and $TXN_DIR was retained." >&2
    return "$ROLLBACK_FAILURE_EXIT"
  fi

  restore_agent "$AWAKE_LABEL" "$AWAKE_PLIST_TARGET" "$AWAKE_WAS_LOADED" "$OLD_AWAKE_DISABLED"
  restore_agent "$LABEL" "$PLIST_TARGET" "$DAILY_WAS_LOADED" "$OLD_DAILY_DISABLED"
  verify_agent "$AWAKE_LABEL" "$AWAKE_WAS_LOADED" "$OLD_AWAKE_DISABLED"
  verify_agent "$LABEL" "$DAILY_WAS_LOADED" "$OLD_DAILY_DISABLED"
  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
    echo "Recovery was incomplete; $TXN_DIR and replacement releases were retained." >&2
    return "$ROLLBACK_FAILURE_EXIT"
  fi

  remove_replacement_artifacts
  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
    return "$ROLLBACK_FAILURE_EXIT"
  fi
  return 0
}

finish_transaction() {
  local rc="$?"
  local rollback_status=0
  local remove_transaction=1
  trap - EXIT INT TERM
  if [[ "$SUCCESS" -ne 1 ]]; then
    if [[ "$rc" -eq 0 ]]; then rc=1; fi
    if rollback_install; then
      remove_transaction=1
    else
      rollback_status="$?"
      rc="$ROLLBACK_FAILURE_EXIT"
      remove_transaction=0
      echo "Automatic recovery failed with status $rollback_status; transaction retained at $TXN_DIR." >&2
    fi
  fi
  release_runner_lock
  if [[ "$remove_transaction" -eq 1 && -n "$TXN_DIR" && -d "$TXN_DIR" ]]; then
    rm -rf "$TXN_DIR"
  fi
  exit "$rc"
}

transaction_signal() {
  local status="$1"
  local signal_name="$2"
  trap - INT TERM
  if [[ -n "$ACTIVE_CHILD_PID" ]]; then
    kill -s "$signal_name" "$ACTIVE_CHILD_PID" 2>/dev/null || true
    wait "$ACTIVE_CHILD_PID" 2>/dev/null || true
    ACTIVE_CHILD_PID=""
  fi
  exit "$status"
}

reset_transaction_globals() {
  SUCCESS=0
  SWITCH_STARTED=0
  ROLLBACK_FAILED=0
  LOADED_TRANSACTION_PHASE=""
  TXN_DIR=""
  RELEASE_ID=""
  NEW_RELEASE_FINAL=""
  NEW_OURA_FINAL=""
  NEW_ROLLBACK_FINAL=""
  OLD_CURRENT_KIND="absent"
  OLD_CURRENT_TARGET=""
  OLD_OURA_KIND="absent"
  OLD_OURA_TARGET=""
  OLD_OURA_LEGACY=""
  OLD_OURA_DIRECTORY_ID=""
  OLD_MUTABLE_PRESENT=0
  OLD_MUTABLE_ID=""
  OLD_CODEX_HOME_PRESENT=0
  OLD_CODEX_HOME_ID=""
  OLD_CREDENTIAL_PRESENT=0
  OLD_DAILY_PLIST_PRESENT=0
  OLD_AWAKE_PLIST_PRESENT=0
  DAILY_WAS_LOADED=0
  AWAKE_WAS_LOADED=0
  OLD_DAILY_DISABLED=2
  OLD_AWAKE_DISABLED=2
}

recover_interrupted_transactions() {
  local interrupted=""
  local inferred_id=""
  local inferred_release=""
  local inferred_oura=""
  local inferred_bundle=""
  shopt -s nullglob
  for interrupted in "$RUNTIME_ROOT"/.install-*; do
    [[ -d "$interrupted" ]] || continue
    TXN_DIR="$interrupted"
    if [[ ! -f "$TXN_DIR/transaction.json" ]]; then
      inferred_id="${TXN_DIR##*/.install-}"
      inferred_release="$RELEASES_ROOT/$inferred_id"
      inferred_oura="$OURA_RELEASES_ROOT/$inferred_id"
      inferred_bundle="$ROLLBACK_BUNDLES_ROOT/$inferred_id"
      if symlink_points_to "$RUNTIME_ROOT/current" "$inferred_release" || \
         symlink_points_to "$OURA_LIVE" "$inferred_oura"; then
        echo "Interrupted transaction has no recovery metadata and still appears live: $TXN_DIR" >&2
        return "$ROLLBACK_FAILURE_EXIT"
      fi
      rm -rf "$inferred_release" "$inferred_oura" "$inferred_bundle" "$TXN_DIR" || {
        echo "Could not remove an incomplete pre-switch transaction: $TXN_DIR" >&2
        return "$ROLLBACK_FAILURE_EXIT"
      }
      reset_transaction_globals
      continue
    fi

    if ! load_transaction_state "$TXN_DIR/transaction.json"; then
      echo "Could not read interrupted transaction metadata: $TXN_DIR" >&2
      return "$ROLLBACK_FAILURE_EXIT"
    fi
    if [[ "$LOADED_TRANSACTION_PHASE" == "committed" ]]; then
      if ! symlink_points_to "$RUNTIME_ROOT/current" "$NEW_RELEASE_FINAL" || \
         ! symlink_points_to "$OURA_LIVE" "$NEW_OURA_FINAL"; then
        echo "Committed transaction metadata does not match the live releases: $TXN_DIR" >&2
        return "$ROLLBACK_FAILURE_EXIT"
      fi
      rm -rf "$TXN_DIR" || return "$ROLLBACK_FAILURE_EXIT"
      reset_transaction_globals
      continue
    fi

    echo "Recovering interrupted daily automation transaction: $TXN_DIR" >&2
    if [[ "$LOADED_TRANSACTION_PHASE" == "prepared" ]]; then
      SWITCH_STARTED=0
    else
      SWITCH_STARTED=1
    fi
    if ! rollback_install; then
      echo "Interrupted transaction could not be recovered safely: $TXN_DIR" >&2
      return "$ROLLBACK_FAILURE_EXIT"
    fi
    rm -rf "$TXN_DIR" || return "$ROLLBACK_FAILURE_EXIT"
    reset_transaction_globals
  done
  shopt -u nullglob
  return 0
}

install_or_update() {
  mkdir -p "$RUNTIME_ROOT" "$RELEASES_ROOT" "$OURA_RELEASES_ROOT" "$ROLLBACK_BUNDLES_ROOT" \
    "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"
  chmod 700 "$RUNTIME_ROOT" "$RELEASES_ROOT" "$OURA_RELEASES_ROOT" "$ROLLBACK_BUNDLES_ROOT" \
    "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"
  trap 'transaction_signal 130 INT' INT
  trap 'transaction_signal 143 TERM' TERM
  acquire_runner_lock
  recover_interrupted_transactions
  reset_transaction_globals

  RELEASE_ID="$(date '+%Y%m%dT%H%M%S')-$$"
  TXN_DIR="$RUNTIME_ROOT/.install-$RELEASE_ID"
  mkdir -p "$TXN_DIR"
  chmod 700 "$TXN_DIR"
  trap finish_transaction EXIT

  stage_runtime_credential "$TXN_DIR/credentials.env"
  stage_codex_home "$TXN_DIR/codex-home"
  stage_oura_mutable "$TXN_DIR/oura-mutable"
  stage_oura_code "$TXN_DIR/oura-release"
  stage_release "$TXN_DIR/release"
  render_plist "$SCRIPT_DIR/com.workout-tracker.codex-daily-briefing.plist" "$TXN_DIR/daily.plist"
  render_plist "$SCRIPT_DIR/com.workout-tracker.codex-keep-awake.plist" "$TXN_DIR/awake.plist"
  snapshot_live_state

  NEW_RELEASE_FINAL="$RELEASES_ROOT/$RELEASE_ID"
  NEW_OURA_FINAL="$OURA_RELEASES_ROOT/$RELEASE_ID"
  NEW_ROLLBACK_FINAL="$ROLLBACK_BUNDLES_ROOT/$RELEASE_ID"
  if [[ "$OLD_OURA_KIND" == "directory" ]]; then
    OLD_OURA_LEGACY="$OURA_RELEASES_ROOT/legacy-$RELEASE_ID"
  fi
  stage_rollback_bundle "$TXN_DIR/rollback-bundle" "$RELEASE_ID"
  run_tracked "$MV" "$TXN_DIR/release" "$NEW_RELEASE_FINAL"
  run_tracked "$MV" "$TXN_DIR/oura-release" "$NEW_OURA_FINAL"
  run_tracked "$MV" "$TXN_DIR/rollback-bundle" "$NEW_ROLLBACK_FINAL"
  write_transaction_state prepared

  SWITCH_STARTED=1
  write_transaction_state stopping_agents
  bootout_if_loaded "$DOMAIN/$LABEL"
  bootout_if_loaded "$DOMAIN/$AWAKE_LABEL"
  write_transaction_state switching

  if [[ "$OLD_MUTABLE_PRESENT" -eq 1 ]]; then
    run_tracked "$MV" "$OURA_MUTABLE" "$TXN_DIR/backup/oura-mutable"
  fi
  run_tracked "$MV" "$TXN_DIR/oura-mutable" "$OURA_MUTABLE"

  if [[ "$OLD_CODEX_HOME_PRESENT" -eq 1 ]]; then
    run_tracked "$MV" "$CODEX_HOME_TARGET" "$TXN_DIR/backup/codex-home"
  fi
  run_tracked "$MV" "$TXN_DIR/codex-home" "$CODEX_HOME_TARGET"

  atomic_install_file "$TXN_DIR/credentials.env" "$RUNTIME_ROOT/credentials.env" 600
  atomic_symlink "$NEW_RELEASE_FINAL" "$RUNTIME_ROOT/current"

  if [[ "$OLD_OURA_KIND" == "directory" ]]; then
    run_tracked "$MV" "$OURA_LIVE" "$OLD_OURA_LEGACY"
  fi
  atomic_symlink "$NEW_OURA_FINAL" "$OURA_LIVE"

  mkdir -p "$AGENTS_DIR"
  atomic_install_file "$TXN_DIR/daily.plist" "$PLIST_TARGET" 600
  atomic_install_file "$TXN_DIR/awake.plist" "$AWAKE_PLIST_TARGET" 600
  run_tracked /bin/chmod -R go-rwx "$RUNTIME_ROOT"
  write_transaction_state switched

  run_installed_runner --doctor
  write_transaction_state validated

  if [[ "$OLD_AWAKE_DISABLED" -eq 1 ]]; then
    run_tracked "$LAUNCHCTL" enable "$DOMAIN/$AWAKE_LABEL"
  fi
  run_tracked "$LAUNCHCTL" bootstrap "$DOMAIN" "$AWAKE_PLIST_TARGET"
  if [[ "$OLD_DAILY_DISABLED" -eq 1 ]]; then
    run_tracked "$LAUNCHCTL" enable "$DOMAIN/$LABEL"
  fi

  # Keep runner.lock through the final bootstrap. Its RunAtLoad attempt may
  # exit as already-running, but no external run can race a failed bootstrap
  # and make rollback unsafe.
  run_tracked "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST_TARGET"
  write_transaction_state committed

  SUCCESS=1
  release_runner_lock
  if ! run_tracked "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL"; then
    echo "Warning: the daily agent was installed but its immediate kickstart failed." >&2
  fi
  rm -f "$RUNTIME_ROOT/.env" || echo "Warning: could not remove legacy runtime .env." >&2
  echo "Installed $LABEL"
  echo "The Mac will stay awake on AC power; the display may still sleep."
}

show_status() {
  local status_file="$RUNTIME_ROOT/state/status.json"
  if [[ ! -f "$status_file" ]]; then
    echo "No automation status has been recorded yet."
  else
    "$PYTHON" -m json.tool "$status_file"
  fi
  "$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,80p' || true
  "$LAUNCHCTL" print "$DOMAIN/$AWAKE_LABEL" 2>/dev/null | sed -n '1,60p' || true
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 2
fi
shift

case "$command" in
  install|update)
    install_or_update
    ;;
  doctor)
    if [[ -x "$RUNTIME_ROOT/current/run_codex_daily_briefing.sh" ]]; then
      run_installed_runner --doctor
      exit $?
    fi
    exec "$SCRIPT_DIR/run_codex_daily_briefing.sh" --doctor
    ;;
  status)
    show_status
    ;;
  run-now)
    run_installed_runner --ignore-schedule "$@"
    ;;
  uninstall)
    bootout_if_loaded "$DOMAIN/$LABEL"
    bootout_if_loaded "$DOMAIN/$AWAKE_LABEL"
    rm -f "$PLIST_TARGET" "$AWAKE_PLIST_TARGET"
    echo "Uninstalled launch agents. Runtime data remains at $RUNTIME_ROOT."
    ;;
  *)
    usage
    exit 2
    ;;
esac
