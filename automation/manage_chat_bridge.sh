#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${WORKOUT_CHAT_RUNTIME:-$HOME/.workout-tracker-codex-chat}"
LABEL="com.workout-tracker.codex-chat-bridge"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_TARGET="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() {
  echo "Usage: $0 install|update|doctor|status|run-once|uninstall"
}

run_installed_bridge() {
  /usr/bin/env \
    HOME="$HOME" \
    WORKOUT_CHAT_AUTOMATION_ROOT="$RUNTIME_ROOT" \
    WORKOUT_CHAT_RELEASE_ROOT="$RUNTIME_ROOT/current" \
    WORKOUT_CHAT_ENV_FILE="$RUNTIME_ROOT/credentials.env" \
    "$RUNTIME_ROOT/current/run_codex_chat_bridge.sh" "$@"
}

render_plist() {
  /usr/bin/python3 - "$SCRIPT_DIR/com.workout-tracker.codex-chat-bridge.plist" \
    "$PLIST_TARGET" "$HOME" "$RUNTIME_ROOT" <<'PY'
import os
import sys
from pathlib import Path

source, target, home, runtime = map(Path, sys.argv[1:])
text = source.read_text(encoding="utf-8")
text = text.replace("__HOME__", str(home)).replace("__RUNTIME_ROOT__", str(runtime))
target.parent.mkdir(parents=True, exist_ok=True)
temporary = target.with_name(f".{target.name}.tmp-{os.getpid()}")
temporary.write_text(text, encoding="utf-8")
temporary.chmod(0o600)
os.replace(temporary, target)
PY
  /usr/bin/plutil -lint "$PLIST_TARGET" >/dev/null
}

write_runtime_credential() {
  local source_env="$ROOT/.env"
  local target="$RUNTIME_ROOT/credentials.env"
  if [[ ! -f "$source_env" ]]; then
    if [[ -s "$target" ]]; then
      return
    fi
    echo "Missing source credential file: $source_env" >&2
    exit 1
  fi
  /usr/bin/python3 - "$source_env" "$target" <<'PY'
import os
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:])
value = None
for raw in source.read_text(encoding="utf-8").splitlines():
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
    value = candidate
    break
if not value:
    raise SystemExit("CLOUD_AUTOMATION_SECRET is missing from the source .env")
target.parent.mkdir(parents=True, exist_ok=True)
temporary = target.with_name(f".{target.name}.tmp-{os.getpid()}")
temporary.write_text(f"CLOUD_AUTOMATION_SECRET={value}\n", encoding="utf-8")
temporary.chmod(0o600)
os.replace(temporary, target)
PY
}

deploy_release() {
  mkdir -p "$RUNTIME_ROOT/releases" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"
  chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"

  local release="$RUNTIME_ROOT/releases/$(date '+%Y%m%dT%H%M%S')-$$"
  mkdir -p "$release"
  install -m 700 "$SCRIPT_DIR/run_codex_chat_bridge.sh" "$release/"
  install -m 600 "$SCRIPT_DIR/chat_bridge.py" "$release/"
  install -m 600 "$SCRIPT_DIR/codex_chat_prompt.md" "$release/"
  install -m 600 "$SCRIPT_DIR/codex_chat_output_schema.json" "$release/"

  /usr/bin/python3 -m py_compile "$release/chat_bridge.py"
  /bin/bash -n "$release/run_codex_chat_bridge.sh"
  /usr/bin/python3 -m json.tool "$release/codex_chat_output_schema.json" >/dev/null

  local next_link="$RUNTIME_ROOT/.current-next-$$"
  ln -s "$release" "$next_link"
  /usr/bin/python3 - "$next_link" "$RUNTIME_ROOT/current" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

prune_runtime() {
  /usr/bin/python3 - "$RUNTIME_ROOT" <<'PY'
import shutil
import sys
import time
from pathlib import Path

runtime = Path(sys.argv[1]).expanduser().resolve()
releases = runtime / "releases"
current_link = runtime / "current"
active = current_link.resolve() if current_link.exists() else None

if releases.is_dir():
    candidates = sorted(
        (path for path in releases.iterdir() if path.is_dir() and not path.is_symlink()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    keep = set(candidates[:3])
    if active is not None:
        keep.add(active)
    for path in candidates:
        if path not in keep:
            shutil.rmtree(path)

for path in runtime.glob(".current-next-*"):
    if path.is_symlink() or path.is_file():
        path.unlink()

# Root spool JSON files are validated completions awaiting publication and are
# deliberately never pruned. Only rejected diagnostics are age/count bounded.
now = time.time()
for category in ("invalid", "stale"):
    directory = runtime / "state" / "spool" / category
    if not directory.is_dir():
        continue
    files = sorted(
        (path for path in directory.glob("*.json") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for index, path in enumerate(files):
        if index >= 50 or now - path.stat().st_mtime > 30 * 24 * 60 * 60:
            path.unlink()

# Older versions sent launchd's raw streams to these unbounded files. The new
# agent sends those streams to /dev/null and writes bounded bridge.log files.
for name in ("launchd.out.log", "launchd.err.log"):
    path = runtime / "logs" / name
    if path.is_file():
        path.unlink()
PY
}

reload_agent() {
  mkdir -p "$AGENTS_DIR"
  render_plist
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  prune_runtime
  launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  launchctl enable "$DOMAIN/$LABEL"
}

install_or_update() {
  write_runtime_credential
  deploy_release
  chmod -R go-rwx "$RUNTIME_ROOT"
  run_installed_bridge --doctor
  reload_agent
  echo "Installed $LABEL"
  echo "The bridge keeps the Mac awake while connected to AC power."
}

show_status() {
  local status_file="$RUNTIME_ROOT/state/status.json"
  if [[ -f "$status_file" ]]; then
    /usr/bin/python3 -m json.tool "$status_file"
  else
    echo "No chat bridge status has been recorded yet."
  fi
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,100p' || true
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
    if [[ -x "$RUNTIME_ROOT/current/run_codex_chat_bridge.sh" ]]; then
      run_installed_bridge --doctor
    else
      exec "$SCRIPT_DIR/run_codex_chat_bridge.sh" --doctor
    fi
    ;;
  status)
    show_status
    ;;
  run-once)
    run_installed_bridge --once "$@"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_TARGET"
    echo "Uninstalled $LABEL. Runtime state and queued spools remain at $RUNTIME_ROOT."
    ;;
  *)
    usage
    exit 2
    ;;
esac
