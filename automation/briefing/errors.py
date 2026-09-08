"""Error taxonomy and process exit codes shared by every supervisor module."""

from __future__ import annotations



EXIT_OK = 0

EXIT_TRANSIENT = 75

EXIT_CONFIG = 78

EXIT_SOFTWARE = 70

class RunnerError(RuntimeError):
    exit_code = EXIT_SOFTWARE
    kind = "fatal"

class ConfigError(RunnerError):
    exit_code = EXIT_CONFIG
    kind = "configuration"

class TransientError(RunnerError):
    exit_code = EXIT_TRANSIENT
    kind = "transient"

class WaitingError(RunnerError):
    exit_code = EXIT_OK
    kind = "waiting"

class AlreadyRunning(RunnerError):
    exit_code = EXIT_OK
    kind = "already_running"

class StalePublishError(TransientError):
    kind = "stale_publish"

class TerminationRequested(RunnerError):
    kind = "terminated"

    def __init__(self, signum: int):
        super().__init__(f"Received signal {signum}; child processes were stopped")
        self.exit_code = 128 + signum
