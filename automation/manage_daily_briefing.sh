#!/usr/bin/env bash
set -euo pipefail
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

run_installed_runner() {
  /usr/bin/env \
    HOME="$HOME" \
    WORKOUT_AUTOMATION_ROOT="$RUNTIME_ROOT" \
    WORKOUT_RELEASE_ROOT="$RUNTIME_ROOT/current" \
    WORKOUT_ENV_FILE="$RUNTIME_ROOT/credentials.env" \
    WORKOUT_OURA_ROOT="$RUNTIME_ROOT/oura-codex-health" \
    WORKOUT_CODEX_MODEL="${WORKOUT_CODEX_MODEL:-gpt-5.6-sol}" \
    WORKOUT_CODEX_REASONING_EFFORT="${WORKOUT_CODEX_REASONING_EFFORT:-xhigh}" \
    "$RUNTIME_ROOT/current/run_codex_daily_briefing.sh" "$@"
}

usage() {
  echo "Usage: $0 install|update|doctor|status|run-now|uninstall [runner options]"
}

render_plist() {
  local source="$1"
  local target="$2"
  /usr/bin/python3 - "$source" "$target" "$HOME" "$RUNTIME_ROOT" <<'PY'
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
  /usr/bin/plutil -lint "$target" >/dev/null
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

sync_oura_runtime() {
  local target="$RUNTIME_ROOT/oura-codex-health"
  if [[ ! -d "$OURA_SOURCE" ]]; then
    echo "Missing Oura companion project: $OURA_SOURCE" >&2
    exit 1
  fi
  mkdir -p "$target" "$target/data" "$target/reports"

  # Mutable credentials, the rotating OAuth database, and reports are copied
  # only once. Later updates deploy code without rolling token state backward.
  if [[ ! -f "$target/.env" ]]; then
    install -m 600 "$OURA_SOURCE/.env" "$target/.env"
  fi
  if [[ ! -f "$target/data/oura_health.sqlite3" ]]; then
    install -m 600 "$OURA_SOURCE/data/oura_health.sqlite3" \
      "$target/data/oura_health.sqlite3"
  fi

  rsync -a --delete \
    --exclude '.env' \
    --exclude 'data/' \
    --exclude 'reports/' \
    --exclude '__pycache__/' \
    "$OURA_SOURCE/" "$target/"
  chmod -R go-rwx "$target"
  chmod 700 "$target" "$target/data" "$target/reports"
  chmod 600 "$target/.env" "$target/data/oura_health.sqlite3"
}

deploy_release() {
  mkdir -p "$RUNTIME_ROOT/releases" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"
  chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/state"

  local release="$RUNTIME_ROOT/releases/$(date '+%Y%m%dT%H%M%S')-$$"
  mkdir -p "$release"
  install -m 700 "$SCRIPT_DIR/run_codex_daily_briefing.sh" "$release/"
  install -m 600 "$SCRIPT_DIR/daily_briefing_runner.py" "$release/"
  install -m 600 "$SCRIPT_DIR/codex_daily_briefing_prompt.md" "$release/"
  install -m 600 "$SCRIPT_DIR/codex_daily_briefing_output_schema.json" "$release/"

  /usr/bin/python3 -m py_compile "$release/daily_briefing_runner.py"
  /bin/bash -n "$release/run_codex_daily_briefing.sh"
  /usr/bin/python3 -m json.tool "$release/codex_daily_briefing_output_schema.json" >/dev/null

  local next_link="$RUNTIME_ROOT/.current-next-$$"
  ln -s "$release" "$next_link"
  /usr/bin/python3 - "$next_link" "$RUNTIME_ROOT/current" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

reload_agents() {
  mkdir -p "$AGENTS_DIR"
  render_plist "$SCRIPT_DIR/com.workout-tracker.codex-daily-briefing.plist" "$PLIST_TARGET"
  render_plist "$SCRIPT_DIR/com.workout-tracker.codex-keep-awake.plist" "$AWAKE_PLIST_TARGET"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootout "$DOMAIN/$AWAKE_LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AWAKE_PLIST_TARGET"
  launchctl enable "$DOMAIN/$AWAKE_LABEL"
  launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  launchctl enable "$DOMAIN/$LABEL"
}

install_or_update() {
  write_runtime_credential
  rm -f "$RUNTIME_ROOT/.env"
  sync_oura_runtime
  deploy_release
  chmod -R go-rwx "$RUNTIME_ROOT"
  reload_agents
  run_installed_runner --doctor
  echo "Installed $LABEL"
  echo "The Mac will stay awake on AC power; the display may still sleep."
}

show_status() {
  local status_file="$RUNTIME_ROOT/state/status.json"
  if [[ ! -f "$status_file" ]]; then
    echo "No automation status has been recorded yet."
  else
    /usr/bin/python3 -m json.tool "$status_file"
  fi
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,80p' || true
  launchctl print "$DOMAIN/$AWAKE_LABEL" 2>/dev/null | sed -n '1,60p' || true
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
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootout "$DOMAIN/$AWAKE_LABEL" 2>/dev/null || true
    rm -f "$PLIST_TARGET" "$AWAKE_PLIST_TARGET"
    echo "Uninstalled launch agents. Runtime data remains at $RUNTIME_ROOT."
    ;;
  *)
    usage
    exit 2
    ;;
esac
