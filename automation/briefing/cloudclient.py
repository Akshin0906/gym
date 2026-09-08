"""Authenticated HTTP client for the cloud mirror.

Redirects are rejected outright so a redirect can never move the automation
credential to another origin."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

from .errors import (
    ConfigError,
    TransientError,
)
from .constants import RUNNER_VERSION

class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Expose redirects as HTTP errors so authentication is never forwarded."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None

class CloudClient:
    def __init__(self, config: Config, secret: str, logger: logging.Logger):
        self.base = config.app_url
        self.secret = secret
        self.timeout = config.http_timeout_seconds
        self.retries = config.http_retries
        self.retry_delay = config.retry_delay_seconds
        self.logger = logger
        self.opener = urllib.request.build_opener(RejectRedirectHandler())

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        expected: set[int] | None = None,
    ) -> tuple[int, Any]:
        expected = expected or {200}
        payload = None
        headers = {
            "Accept": "application/json",
            "X-Cloud-Automation-Secret": self.secret,
            "User-Agent": f"workout-codex-briefing/{RUNNER_VERSION}",
        }
        if body is not None:
            payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        url = f"{self.base}{path}"
        last_error: BaseException | None = None
        for attempt in range(1, self.retries + 1):
            request = urllib.request.Request(url, data=payload, method=method, headers=headers)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    status = int(response.status)
                    raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise ConfigError(f"Cloud response is too large for {path}")
                parsed = json.loads(raw.decode("utf-8")) if raw else {}
                if status not in expected:
                    raise ConfigError(f"Unexpected HTTP {status} for {path}")
                return status, parsed
            except urllib.error.HTTPError as exc:
                status = int(exc.code)
                raw = exc.read(64 * 1024)
                try:
                    parsed = json.loads(raw.decode("utf-8")) if raw else {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parsed = {}
                if status in expected:
                    return status, parsed
                if status in {401, 403}:
                    raise ConfigError(f"Cloud authentication failed with HTTP {status}") from exc
                if status not in {408, 425, 429} and status < 500:
                    error_name = parsed.get("error") if isinstance(parsed, dict) else None
                    suffix = f" ({error_name})" if isinstance(error_name, str) else ""
                    raise ConfigError(f"Cloud request {path} failed with HTTP {status}{suffix}") from exc
                last_error = exc
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
                last_error = exc
            if attempt < self.retries:
                self.logger.warning(
                    "Cloud request %s attempt %s/%s failed; retrying",
                    path,
                    attempt,
                    self.retries,
                )
                time.sleep(self.retry_delay * (2 ** (attempt - 1)))
        raise TransientError(f"Cloud request {path} failed after retries") from last_error
