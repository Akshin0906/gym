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

reload_agent() {
  mkdir -p "$AGENTS_DIR"
  render_plist
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
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
