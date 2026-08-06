from __future__ import annotations

import fcntl
import json
import os
import plistlib
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


SOURCE_AUTOMATION = Path(__file__).resolve().parents[1]
DAILY_LABEL = "com.workout-tracker.codex-daily-briefing"
AWAKE_LABEL = "com.workout-tracker.codex-keep-awake"


class ManageDailyBriefingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary.cleanup)
        self.base = Path(self._temporary.name)
        self.project = self.base / "project"
        self.automation = self.project / "automation"
        self.home = self.base / "home"
        self.runtime = self.base / "runtime"
        self.oura_source = self.base / "oura-source"
        self.launchctl_state = self.base / "launchctl-state"
        self.launchctl_log = self.base / "launchctl.jsonl"
        self.doctor_log = self.base / "doctor.jsonl"
        self.automation.mkdir(parents=True)
        (self.home / ".codex").mkdir(parents=True)
        self.launchctl_state.mkdir()

        for name in (
            "manage_daily_briefing.sh",
            "com.workout-tracker.codex-daily-briefing.plist",
            "com.workout-tracker.codex-keep-awake.plist",
        ):
            shutil.copy2(SOURCE_AUTOMATION / name, self.automation / name)

        (self.project / ".env").write_text(
            "CLOUD_AUTOMATION_SECRET=fixture-cloud-secret\n", encoding="utf-8"
        )
        (self.home / ".codex" / "auth.json").write_text(
            json.dumps({"auth_mode": "chatgpt", "token": "fixture"}) + "\n",
            encoding="utf-8",
        )
        (self.home / ".codex" / "auth.json").chmod(0o600)
        self._write_release_fixture()
        self._write_oura_source("v1", "source-v1")
        self.fake_launchctl = self._write_fake_launchctl()
        self.fake_mv = self._write_fake_mv()

    def _write_release_fixture(self) -> None:
        (self.automation / "run_codex_daily_briefing.sh").write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
            'exec /usr/bin/python3 "$SCRIPT_DIR/daily_briefing_runner.py" "$@"\n',
            encoding="utf-8",
        )
        (self.automation / "run_codex_daily_briefing.sh").chmod(0o700)
        (self.automation / "daily_briefing_runner.py").write_text(
            textwrap.dedent(
                """\
                from __future__ import annotations

                import json
                import os
                import stat
                import sys
                import time
                from pathlib import Path


                def main() -> int:
                    # Contract marker validated by manage_daily_briefing.sh.
                    codex_home = Path(os.environ["WORKOUT_CODEX_HOME"])
                    if "--doctor" not in sys.argv:
                        return 0
                    release = Path(os.environ["WORKOUT_RELEASE_ROOT"]).resolve()
                    oura = Path(os.environ["WORKOUT_OURA_ROOT"]).resolve()
                    auth = codex_home / "auth.json"
                    evidence = {
                        "release": release.joinpath("release-version.txt").read_text().strip(),
                        "oura": oura.joinpath("code-version.txt").read_text().strip(),
                        "codexEntries": sorted(item.name for item in codex_home.iterdir()),
                        "codexHomeMode": stat.S_IMODE(codex_home.stat().st_mode),
                        "authMode": stat.S_IMODE(auth.stat().st_mode),
                        "mutableEnv": oura.joinpath(".env").read_text().strip(),
                    }
                    log = os.environ.get("FAKE_DOCTOR_LOG")
                    if log:
                        with Path(log).open("a", encoding="utf-8") as handle:
                            handle.write(json.dumps(evidence, sort_keys=True) + "\\n")
                    started = os.environ.get("FAKE_DOCTOR_STARTED")
                    if started:
                        Path(started).write_text(str(os.getpid()), encoding="utf-8")
                    delay = float(os.environ.get("FAKE_DOCTOR_SLEEP_SECONDS", "0"))
                    if delay:
                        time.sleep(delay)
                    valid = (
                        evidence["codexEntries"] == ["auth.json"]
                        and evidence["codexHomeMode"] == 0o700
                        and evidence["authMode"] == 0o600
                    )
                    if not valid or os.environ.get("FAKE_DOCTOR_FAIL") == "1":
                        return 78
                    print(json.dumps({"ok": True, **evidence}, sort_keys=True))
                    return 0


                if __name__ == "__main__":
                    raise SystemExit(main())
                """
            ),
            encoding="utf-8",
        )
        (self.automation / "codex_daily_briefing_prompt.md").write_text(
            "# Fixture prompt\n", encoding="utf-8"
        )
        (self.automation / "codex_daily_briefing_output_schema.json").write_text(
            json.dumps({"type": "object"}) + "\n", encoding="utf-8"
        )
        (self.automation / "release-version.txt").write_text("ignored\n", encoding="utf-8")

    def _set_release_version(self, version: str) -> None:
        wrapper = self.automation / "run_codex_daily_briefing.sh"
        # The manager copies a deliberately small release set, so the doctor
        # reads this marker from the runner's sibling file created by the test.
        original = wrapper.read_text(encoding="utf-8")
        if "release-version.txt" not in original:
            original = original.replace(
                'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n',
                'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
                'printf "%s\\n" "' + version + '" > "$SCRIPT_DIR/release-version.txt"\n',
            )
        else:
            lines = [line for line in original.splitlines() if "release-version.txt" not in line]
            lines.insert(3, 'printf "%s\\n" "' + version + '" > "$SCRIPT_DIR/release-version.txt"')
            original = "\n".join(lines) + "\n"
        wrapper.write_text(original, encoding="utf-8")
        wrapper.chmod(0o700)

    def _write_oura_source(self, code_version: str, mutable_value: str) -> None:
        shutil.rmtree(self.oura_source, ignore_errors=True)
        package = self.oura_source / "oura_health"
        reports = self.oura_source / "reports"
        data = self.oura_source / "data"
        package.mkdir(parents=True)
        reports.mkdir()
        data.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "__main__.py").write_text(
            f"CODE_VERSION = {code_version!r}\n", encoding="utf-8"
        )
        (self.oura_source / "code-version.txt").write_text(
            code_version + "\n", encoding="utf-8"
        )
        (self.oura_source / "run_daily.sh").write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n", encoding="utf-8"
        )
        (self.oura_source / "run_daily.sh").chmod(0o700)
        (self.oura_source / ".env").write_text(
            f"OURA_TOKEN={mutable_value}\n", encoding="utf-8"
        )
        (reports / "source-report.txt").write_text(mutable_value + "\n", encoding="utf-8")
        self._write_database(data / "oura_health.sqlite3", mutable_value)

    def _create_legacy_oura_runtime(self, mutable_value: str) -> Path:
        legacy = self.runtime / "oura-codex-health"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(self.oura_source, legacy)
        (legacy / ".env").write_text(
            f"OURA_TOKEN={mutable_value}\n", encoding="utf-8"
        )
        self._write_database(legacy / "data" / "oura_health.sqlite3", mutable_value)
        (legacy / "reports" / "custom.txt").write_text("keep-me\n", encoding="utf-8")
        return legacy

    @staticmethod
    def _write_database(path: Path, value: str) -> None:
        path.unlink(missing_ok=True)
        with sqlite3.connect(path) as database:
            database.execute("CREATE TABLE marker (value TEXT NOT NULL)")
            database.execute("INSERT INTO marker (value) VALUES (?)", (value,))

    def _write_fake_launchctl(self) -> Path:
        binary = self.base / "fake-launchctl"
        binary.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                from __future__ import annotations

                import json
                import fcntl
                import os
                import plistlib
                import sys
                from pathlib import Path


                state = Path(os.environ["FAKE_LAUNCHCTL_STATE"])
                state.mkdir(parents=True, exist_ok=True)
                log = Path(os.environ["FAKE_LAUNCHCTL_LOG"])
                with log.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(sys.argv[1:]) + "\\n")

                command = sys.argv[1]
                if command == "print":
                    label = sys.argv[2].rsplit("/", 1)[-1]
                    raise SystemExit(0 if state.joinpath("loaded-" + label).exists() else 113)
                if command == "print-disabled":
                    values = []
                    for marker in sorted(state.glob("disabled-*")):
                        values.append(f'    "{marker.name[9:]}" => true')
                    for marker in sorted(state.glob("enabled-override-*")):
                        values.append(f'    "{marker.name[17:]}" => false')
                    print("disabled services = {\\n" + "\\n".join(values) + "\\n}")
                    raise SystemExit(0)
                if command == "bootout":
                    if len(sys.argv) < 4 or sys.argv[2] != "--wait":
                        raise SystemExit(64)
                    label = sys.argv[-1].rsplit("/", 1)[-1]
                    state.joinpath("loaded-" + label).unlink(missing_ok=True)
                    raise SystemExit(0)
                if command == "enable":
                    label = sys.argv[2].rsplit("/", 1)[-1]
                    state.joinpath("disabled-" + label).unlink(missing_ok=True)
                    state.joinpath("enabled-override-" + label).touch()
                    raise SystemExit(0)
                if command == "disable":
                    label = sys.argv[2].rsplit("/", 1)[-1]
                    state.joinpath("enabled-override-" + label).unlink(missing_ok=True)
                    state.joinpath("disabled-" + label).touch()
                    raise SystemExit(0)
                if command == "kickstart":
                    lock = Path(os.environ["FAKE_RUNNER_LOCK"]).open("a+")
                    try:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise SystemExit(67)
                    finally:
                        lock.close()
                    raise SystemExit(0)
                if command == "bootstrap":
                    plist_path = Path(sys.argv[3])
                    with plist_path.open("rb") as handle:
                        label = plistlib.load(handle)["Label"]
                    if (
                        label == "com.workout-tracker.codex-daily-briefing"
                        and os.environ.get("FAKE_ASSERT_DAILY_BOOTSTRAP_LOCKED") == "1"
                    ):
                        lock = Path(os.environ["FAKE_RUNNER_LOCK"]).open("a+")
                        try:
                            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            pass
                        else:
                            raise SystemExit(66)
                        finally:
                            lock.close()
                    if os.environ.get("FAKE_FAIL_BOOTSTRAP_ALWAYS_LABEL") == label:
                        raise SystemExit(6)
                    failure = os.environ.get("FAKE_FAIL_BOOTSTRAP_ONCE_LABEL")
                    marker = state / ("failed-bootstrap-" + label)
                    if failure == label and not marker.exists():
                        marker.touch()
                        raise SystemExit(5)
                    state.joinpath("loaded-" + label).touch()
                    raise SystemExit(0)
                raise SystemExit(64)
                """
            ),
            encoding="utf-8",
        )
        binary.chmod(0o700)
        return binary

    def _write_fake_mv(self) -> Path:
        binary = self.base / "fake-mv"
        binary.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                from __future__ import annotations

                import os
                import sys
                from pathlib import Path


                source = sys.argv[1]
                pattern = os.environ.get("FAKE_MV_FAIL_SOURCE", "")
                marker = Path(os.environ["FAKE_LAUNCHCTL_STATE"]) / "failed-mv-once"
                if pattern and pattern in source and not marker.exists():
                    marker.touch()
                    raise SystemExit(9)
                os.execv("/bin/mv", ["/bin/mv", *sys.argv[1:]])
                """
            ),
            encoding="utf-8",
        )
        binary.chmod(0o700)
        return binary

    def _environment(self, **updates: str) -> dict[str, str]:
        env = os.environ.copy()
        for name in (
            "FAKE_DOCTOR_FAIL",
            "FAKE_DOCTOR_SLEEP_SECONDS",
            "FAKE_DOCTOR_STARTED",
            "FAKE_FAIL_BOOTSTRAP_ONCE_LABEL",
            "FAKE_FAIL_BOOTSTRAP_ALWAYS_LABEL",
            "FAKE_MV_FAIL_SOURCE",
        ):
            env.pop(name, None)
        env.update(
            {
                "HOME": str(self.home),
                "WORKOUT_AUTOMATION_RUNTIME": str(self.runtime),
                "WORKOUT_OURA_SOURCE": str(self.oura_source),
                "WORKOUT_LAUNCHCTL": str(self.fake_launchctl),
                "WORKOUT_MV": str(self.fake_mv),
                "WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS": "1",
                "FAKE_LAUNCHCTL_STATE": str(self.launchctl_state),
                "FAKE_LAUNCHCTL_LOG": str(self.launchctl_log),
                "FAKE_DOCTOR_LOG": str(self.doctor_log),
                "FAKE_ASSERT_DAILY_BOOTSTRAP_LOCKED": "1",
                "FAKE_RUNNER_LOCK": str(self.runtime / "state" / "runner.lock"),
                "LC_ALL": "C",
            }
        )
        env.update(updates)
        return env

    def _run_manager(
        self, command: str = "update", *, env_updates: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/bash", str(self.automation / "manage_daily_briefing.sh"), command],
            cwd=self.project,
            env=self._environment(**(env_updates or {})),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )

    def _install(self, version: str = "v1") -> subprocess.CompletedProcess[str]:
        self._set_release_version(version)
        result = self._run_manager("install")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def _loaded(self, label: str) -> bool:
        return (self.launchctl_state / f"loaded-{label}").exists()

    def _database_value(self) -> str:
        with sqlite3.connect(self.runtime / "oura-mutable" / "data" / "oura_health.sqlite3") as db:
            row = db.execute("SELECT value FROM marker").fetchone()
        assert row
        return str(row[0])

    def _live_fingerprint(self) -> dict[str, object]:
        agents = self.home / "Library" / "LaunchAgents"
        return {
            "current": os.readlink(self.runtime / "current"),
            "oura": os.readlink(self.runtime / "oura-codex-health"),
            "dailyPlist": (agents / f"{DAILY_LABEL}.plist").read_bytes(),
            "awakePlist": (agents / f"{AWAKE_LABEL}.plist").read_bytes(),
            "mutableEnv": (self.runtime / "oura-mutable" / ".env").read_bytes(),
            "database": self._database_value(),
            "reports": {
                str(path.relative_to(self.runtime / "oura-mutable" / "reports")): path.read_bytes()
                for path in (self.runtime / "oura-mutable" / "reports").rglob("*")
                if path.is_file()
            },
            "releases": sorted(path.name for path in (self.runtime / "releases").iterdir()),
            "ouraReleases": sorted(
                path.name for path in (self.runtime / "oura-releases").iterdir()
            ),
            "rollbackBundles": sorted(
                path.name for path in (self.runtime / "rollback-bundles").iterdir()
            ),
        }

    def _assert_agents_loaded(self) -> None:
        self.assertTrue(self._loaded(DAILY_LABEL))
        self.assertTrue(self._loaded(AWAKE_LABEL))

    def _clear_launchctl_log(self) -> None:
        self.launchctl_log.unlink(missing_ok=True)

    def _launchctl_calls(self) -> list[list[str]]:
        if not self.launchctl_log.exists():
            return []
        return [json.loads(line) for line in self.launchctl_log.read_text().splitlines()]

    def test_successful_update_preserves_mutable_oura_and_retains_rollback_bundle(self) -> None:
        self._install("v1")
        old_current = os.readlink(self.runtime / "current")
        old_oura = os.readlink(self.runtime / "oura-codex-health")
        agents = self.home / "Library" / "LaunchAgents"
        old_daily = (agents / f"{DAILY_LABEL}.plist").read_bytes()
        old_awake = (agents / f"{AWAKE_LABEL}.plist").read_bytes()

        (self.runtime / "oura-mutable" / ".env").write_text(
            "OURA_TOKEN=live-custom\n", encoding="utf-8"
        )
        self._write_database(
            self.runtime / "oura-mutable" / "data" / "oura_health.sqlite3", "live-custom"
        )
        (self.runtime / "oura-mutable" / "reports" / "custom.txt").write_text(
            "keep-me\n", encoding="utf-8"
        )
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")
        self._clear_launchctl_log()

        result = self._run_manager()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        new_current = os.readlink(self.runtime / "current")
        new_oura = os.readlink(self.runtime / "oura-codex-health")
        self.assertNotEqual(new_current, old_current)
        self.assertNotEqual(new_oura, old_oura)
        self.assertTrue(Path(old_current).is_dir())
        self.assertTrue(Path(old_oura).is_dir())
        self.assertEqual((Path(new_oura) / "code-version.txt").read_text().strip(), "v2")
        self.assertEqual(
            (self.runtime / "oura-mutable" / ".env").read_text().strip(),
            "OURA_TOKEN=live-custom",
        )
        self.assertEqual(self._database_value(), "live-custom")
        self.assertEqual(
            (self.runtime / "oura-mutable" / "reports" / "custom.txt").read_text(),
            "keep-me\n",
        )
        self.assertEqual(
            (self.runtime / "oura-codex-health" / ".env").read_text().strip(),
            "OURA_TOKEN=live-custom",
        )

        codex_home = self.runtime / "codex-home"
        self.assertEqual([item.name for item in codex_home.iterdir()], ["auth.json"])
        self.assertEqual(stat.S_IMODE(codex_home.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((codex_home / "auth.json").stat().st_mode), 0o600)

        with (agents / f"{DAILY_LABEL}.plist").open("rb") as handle:
            daily_plist = plistlib.load(handle)
        schedule = [
            (entry["Hour"], entry["Minute"])
            for entry in daily_plist["StartCalendarInterval"]
        ]
        self.assertEqual(
            schedule,
            [(10, 30), (11, 0), (12, 0), (15, 0), (16, 0), (18, 0), (21, 0)],
        )
        self.assertEqual(
            daily_plist["EnvironmentVariables"]["WORKOUT_CODEX_HOME"],
            str(codex_home),
        )
        self.assertEqual(
            daily_plist["EnvironmentVariables"]["WORKOUT_CODEX_MODEL"],
            "gpt-5.6-sol",
        )

        release_id = Path(new_current).name
        bundle = self.runtime / "rollback-bundles" / release_id
        metadata = json.loads((bundle / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["previous"]["release"]["target"], old_current)
        self.assertEqual(metadata["previous"]["ouraRelease"]["target"], old_oura)
        self.assertEqual((bundle / "daily.plist").read_bytes(), old_daily)
        self.assertEqual((bundle / "awake.plist").read_bytes(), old_awake)
        self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((bundle / "metadata.json").stat().st_mode), 0o600)
        self.assertEqual(len(list((self.runtime / "releases").iterdir())), 2)
        self.assertEqual(len(list((self.runtime / "oura-releases").iterdir())), 2)
        self.assertEqual(len(list((self.runtime / "rollback-bundles").iterdir())), 2)

        bootouts = [call for call in self._launchctl_calls() if call[0] == "bootout"]
        self.assertEqual(len(bootouts), 2)
        self.assertTrue(all(call[1] == "--wait" for call in bootouts))
        doctor = json.loads(self.doctor_log.read_text().splitlines()[-1])
        self.assertEqual(doctor["release"], "v2")
        self.assertEqual(doctor["oura"], "v2")
        self.assertEqual(doctor["codexEntries"], ["auth.json"])
        self.assertTrue(
            any(call[0] == "kickstart" for call in self._launchctl_calls()),
            "successful install should kickstart once runner.lock is released",
        )
        self._assert_agents_loaded()

    def test_held_runner_lock_times_out_without_touching_live_state(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")
        self._clear_launchctl_log()
        lock_path = self.runtime / "state" / "runner.lock"
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import fcntl, pathlib, sys, time; "
                    "h=pathlib.Path(sys.argv[1]).open('a+'); "
                    "fcntl.flock(h.fileno(), fcntl.LOCK_EX); "
                    "print('ready', flush=True); time.sleep(30)"
                ),
                str(lock_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
        )
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        assert holder.stdout
        self.assertEqual(holder.stdout.readline().strip(), "ready")
        try:
            result = self._run_manager(
                env_updates={"WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS": "0.2"}
            )
        finally:
            holder.terminate()
            holder.wait(timeout=5)
            holder.stdout.close()
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertIn("update refused", result.stderr)
        self.assertEqual(self._live_fingerprint(), before)
        self.assertEqual(self._launchctl_calls(), [])
        self._assert_agents_loaded()

    def test_sigterm_interrupts_initial_lock_waiter_without_stranding_it(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._clear_launchctl_log()
        lock_path = self.runtime / "state" / "runner.lock"
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import fcntl, pathlib, sys, time; "
                    "h=pathlib.Path(sys.argv[1]).open('a+'); "
                    "fcntl.flock(h.fileno(), fcntl.LOCK_EX); "
                    "print('ready', flush=True); time.sleep(30)"
                ),
                str(lock_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
        )
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        assert holder.stdout
        self.assertEqual(holder.stdout.readline().strip(), "ready")
        manager = subprocess.Popen(
            ["/bin/bash", str(self.automation / "manage_daily_briefing.sh"), "update"],
            cwd=self.project,
            env=self._environment(WORKOUT_INSTALL_LOCK_TIMEOUT_SECONDS="30"),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(lambda: manager.poll() is None and manager.kill())
        time.sleep(0.2)
        manager.send_signal(signal.SIGTERM)
        stdout, stderr = manager.communicate(timeout=10)
        self.assertNotEqual(manager.returncode, 0, stdout + stderr)
        holder.terminate()
        holder.wait(timeout=5)
        holder.stdout.close()
        with lock_path.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        self.assertEqual(self._live_fingerprint(), before)
        self.assertEqual(self._launchctl_calls(), [])

    def test_legacy_oura_directory_migrates_without_losing_mutable_data(self) -> None:
        self._create_legacy_oura_runtime("legacy-custom")
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")

        result = self._run_manager("install")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.runtime / "oura-codex-health").is_symlink())
        self.assertEqual(
            (self.runtime / "oura-mutable" / ".env").read_text().strip(),
            "OURA_TOKEN=legacy-custom",
        )
        self.assertEqual(self._database_value(), "legacy-custom")
        self.assertEqual(
            (self.runtime / "oura-mutable" / "reports" / "custom.txt").read_text(),
            "keep-me\n",
        )
        current = Path(os.readlink(self.runtime / "current"))
        bundle = self.runtime / "rollback-bundles" / current.name
        metadata = json.loads((bundle / "metadata.json").read_text(encoding="utf-8"))
        previous_oura = metadata["previous"]["ouraRelease"]
        self.assertEqual(previous_oura["kind"], "directory")
        legacy_path = Path(previous_oura["legacyPath"])
        self.assertTrue(legacy_path.is_dir())
        self.assertEqual((legacy_path / "code-version.txt").read_text().strip(), "v1")
        self.assertEqual((legacy_path / ".env").read_text().strip(), "OURA_TOKEN=legacy-custom")
        self._assert_agents_loaded()

    def test_failed_legacy_oura_migration_restores_original_directory(self) -> None:
        legacy = self._create_legacy_oura_runtime("legacy-custom")
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")

        result = self._run_manager(
            "install", env_updates={"FAKE_DOCTOR_FAIL": "1"}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(legacy.is_dir())
        self.assertFalse(legacy.is_symlink())
        self.assertEqual((legacy / "code-version.txt").read_text().strip(), "v1")
        self.assertEqual((legacy / ".env").read_text().strip(), "OURA_TOKEN=legacy-custom")
        with sqlite3.connect(legacy / "data" / "oura_health.sqlite3") as database:
            row = database.execute("SELECT value FROM marker").fetchone()
        self.assertEqual(row, ("legacy-custom",))
        self.assertFalse((self.runtime / "current").exists())
        self.assertFalse((self.runtime / "oura-mutable").exists())
        self.assertEqual(list((self.runtime / "releases").iterdir()), [])
        self.assertEqual(list((self.runtime / "oura-releases").iterdir()), [])
        self.assertEqual(list((self.runtime / "rollback-bundles").iterdir()), [])
        self.assertFalse(self._loaded(DAILY_LABEL))
        self.assertFalse(self._loaded(AWAKE_LABEL))

    def test_invalid_staged_oura_code_does_not_reload_agents(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        (self.oura_source / "oura_health" / "__main__.py").write_text(
            "def broken(\n", encoding="utf-8"
        )
        self._clear_launchctl_log()

        result = self._run_manager()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("failed before the live installation changed", result.stderr)
        self.assertEqual(self._live_fingerprint(), before)
        self.assertEqual(self._launchctl_calls(), [])
        self._assert_agents_loaded()

    def test_doctor_failure_rolls_back_links_plists_bundles_and_agents(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")
        self._clear_launchctl_log()

        result = self._run_manager(env_updates={"FAKE_DOCTOR_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restoring the previous installation", result.stderr)
        self.assertEqual(self._live_fingerprint(), before)
        self._assert_agents_loaded()
        bootouts = [call for call in self._launchctl_calls() if call[0] == "bootout"]
        self.assertTrue(bootouts)
        self.assertTrue(all(call[1] == "--wait" for call in bootouts))

    def test_daily_bootstrap_failure_rolls_back_while_lock_remains_held(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")
        self._clear_launchctl_log()

        result = self._run_manager(
            env_updates={"FAKE_FAIL_BOOTSTRAP_ONCE_LABEL": DAILY_LABEL}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self._live_fingerprint(), before)
        self._assert_agents_loaded()
        self.assertTrue(
            (self.launchctl_state / f"failed-bootstrap-{DAILY_LABEL}").exists()
        )

    def test_failed_move_of_old_mutable_tree_never_deletes_the_original(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")

        result = self._run_manager(
            env_updates={"FAKE_MV_FAIL_SOURCE": str(self.runtime / "oura-mutable")}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self._live_fingerprint(), before)
        self.assertEqual(list(self.runtime.glob(".install-*")), [])
        self._assert_agents_loaded()

    def test_disabled_overrides_are_restored_after_failed_update(self) -> None:
        self._install()
        (self.launchctl_state / f"disabled-{DAILY_LABEL}").touch()
        (self.launchctl_state / f"disabled-{AWAKE_LABEL}").touch()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")

        result = self._run_manager(env_updates={"FAKE_DOCTOR_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self._live_fingerprint(), before)
        self.assertTrue((self.launchctl_state / f"disabled-{DAILY_LABEL}").exists())
        self.assertTrue((self.launchctl_state / f"disabled-{AWAKE_LABEL}").exists())
        self._assert_agents_loaded()

    def test_recovery_failure_is_distinct_retained_and_retried_next_update(self) -> None:
        self._install()
        old_current = os.readlink(self.runtime / "current")
        old_oura = os.readlink(self.runtime / "oura-codex-health")
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")

        failed = self._run_manager(
            env_updates={
                "FAKE_DOCTOR_FAIL": "1",
                "FAKE_FAIL_BOOTSTRAP_ALWAYS_LABEL": AWAKE_LABEL,
            }
        )
        self.assertEqual(failed.returncode, 74, failed.stdout + failed.stderr)
        self.assertIn("transaction retained", failed.stderr)
        transactions = list(self.runtime.glob(".install-*"))
        self.assertEqual(len(transactions), 1)
        state = json.loads(
            (transactions[0] / "transaction.json").read_text(encoding="utf-8")
        )
        self.assertIn(state["phase"], {"switched", "validated"})
        self.assertEqual(os.readlink(self.runtime / "current"), old_current)
        self.assertEqual(os.readlink(self.runtime / "oura-codex-health"), old_oura)

        recovered = self._run_manager()
        self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
        self.assertIn("Recovering interrupted daily automation transaction", recovered.stderr)
        self.assertEqual(list(self.runtime.glob(".install-*")), [])
        self.assertEqual(
            (self.runtime / "oura-codex-health" / "code-version.txt").read_text().strip(),
            "v2",
        )
        self._assert_agents_loaded()

    def test_sigterm_during_doctor_rolls_back_instead_of_exiting_successfully(self) -> None:
        self._install()
        before = self._live_fingerprint()
        self._write_oura_source("v2", "source-v2")
        self._set_release_version("v2")
        self._clear_launchctl_log()
        started = self.base / "doctor-started"
        process = subprocess.Popen(
            ["/bin/bash", str(self.automation / "manage_daily_briefing.sh"), "update"],
            cwd=self.project,
            env=self._environment(
                FAKE_DOCTOR_STARTED=str(started), FAKE_DOCTOR_SLEEP_SECONDS="30"
            ),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        deadline = time.monotonic() + 5
        while not started.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(started.exists(), "manager never reached the staged doctor")
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=20)

        self.assertNotEqual(process.returncode, 0, stdout + stderr)
        self.assertIn("restoring the previous installation", stderr)
        doctor_pid = int(started.read_text(encoding="utf-8"))
        with self.assertRaises(ProcessLookupError):
            os.kill(doctor_pid, 0)
        self.assertEqual(self._live_fingerprint(), before)
        self._assert_agents_loaded()


if __name__ == "__main__":
    unittest.main()
