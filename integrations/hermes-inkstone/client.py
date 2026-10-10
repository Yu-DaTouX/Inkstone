"""Small synchronous client for Inkstone's existing remote/v1 protocol."""
import json
import os
import re
import socket
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE = 4 * 1024 * 1024
READ_ACTIONS = ("info", "status", "sessions", "history", "models", "questions")
CONTROL_ACTIONS = ("new", "select", "send", "model", "rename", "abort", "answer")


class ConfigurationError(ValueError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a device token to a different endpoint, including 307/308.
        return None


def connection_file():
    override = os.environ.get("INKSTONE_CONNECTION_FILE")
    return Path(override).expanduser() if override else Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "inkstone-connection.json"


def normalize_url(value):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        raise ConfigurationError("INKSTONE_URL must be an HTTP(S) address without whitespace.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ConfigurationError("INKSTONE_URL has an invalid host or port.") from None
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigurationError("INKSTONE_URL must be an HTTP(S) address without credentials, query or fragment.")
    if parsed.path.rstrip("/") not in ("", "/remote/v1") or port == 0:
        raise ConfigurationError("INKSTONE_URL must point to the desktop root or /remote/v1.")
    return urlunsplit((parsed.scheme, parsed.netloc, "/remote/v1", "", ""))


def load_connection():
    path = connection_file()
    data = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError()
        except (OSError, ValueError):
            raise ConfigurationError("Cannot read the Inkstone connection file; run connect.py again.") from None
    url = normalize_url(os.environ.get("INKSTONE_URL") or data.get("url") or "http://127.0.0.1:37892")
    token = os.environ.get("INKSTONE_TOKEN") or data.get("token")
    if not isinstance(token, str) or not token or len(token) > 4096 or any(c.isspace() for c in token):
        raise ConfigurationError("Inkstone is not paired. Run this plugin's connect.py, or set INKSTONE_URL and INKSTONE_TOKEN.")
    return url, token


def text_arg(params, name, maximum=200):
    value = params.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must contain 1-{maximum} characters.")
    return value


def segment(params, name):
    value = text_arg(params, name)
    if value in (".", "..") or any(c in value for c in "/\\\r\n\x00"):
        raise ValueError(f"{name} must be a stable ID, not a path.")
    return quote(value, safe="")


class Client:
    def __init__(self, url, token, timeout=15):
        self.url = normalize_url(url)
        self.token = token
        self.timeout = timeout
        # A desktop/private-network connection must not inherit public proxy settings.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None, request_id=None):
        headers = {"accept": "application/json"}
        if self.token:
            headers["authorization"] = "Bearer " + self.token
        if request_id:
            headers["idempotency-key"] = request_id
        raw = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        if raw is not None:
            headers["content-type"] = "application/json"
        req = Request(self.url + path, data=raw, headers=headers, method=method)
        try:
            try:
                response = self.opener.open(req, timeout=self.timeout)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                payload = response.read(MAX_RESPONSE + 1)
            if len(payload) > MAX_RESPONSE:
                return {"ok": False, "error": "Desktop response too large; request fewer history messages.", "httpStatus": status}
            try:
                result = json.loads(payload)
                if not isinstance(result, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                return {"ok": False, "error": "Desktop returned a non-JSON response or redirect.", "httpStatus": status}
            if not 200 <= status < 300:
                result["ok"] = False
                result["httpStatus"] = status
            if status == 401:
                result["hint"] = "Device token expired or revoked. Pair again on the desktop."
            if result.get("code") == "agent_scope":
                result["hint"] = "This is a Hub-only Reef token. Pair this plugin as a separate remote client; do not reuse that token."
            return result
        except (URLError, TimeoutError, socket.timeout, OSError):
            return {"ok": False, "code": "connection_failed", "outcomeUnknown": method == "POST",
                    "error": "Cannot reach Inkstone. Check desktop remote access, address and network. A submitted operation may already have executed; do not blindly resend."}

    def read(self, params):
        action = params.get("action")
        if action in ("info", "status", "sessions", "questions"):
            return self.request("GET", "/" + action)
        if action == "models":
            return self.request("GET", "/sessions/" + segment(params, "session_id") + "/models")
        if action == "history":
            limit = params.get("limit", 40)
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
                raise ValueError("limit must be an integer from 1 to 100.")
            query = {"limit": limit}
            if params.get("before") is not None:
                query["before"] = text_arg(params, "before", 2000)
            return self.request("GET", "/sessions/" + segment(params, "session_id") + "?" + urlencode(query))
        raise ValueError("Unknown read action.")

    def control(self, params):
        action = params.get("action")
        if action not in CONTROL_ACTIONS:
            raise ValueError("Unknown control action.")
        request_id = params.get("request_id") or str(uuid.uuid4())
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
            raise ValueError("request_id must be 8-128 letters, numbers or . _ : -.")
        body = {}
        if action == "new":
            path = "/sessions/new"
        elif action == "answer":
            path = "/questions/" + segment(params, "question_id") + "/answer"
            if params.get("cancelled") is True:
                body = {"cancelled": True}
            elif isinstance(params.get("confirmed"), bool):
                body = {"confirmed": params["confirmed"]}
            else:
                body = {"value": text_arg(params, "value", 20_000)}
        elif action == "abort":
            if not re.fullmatch(r"r[1-9]\d{0,8}", text_arg(params, "run_id")):
                raise ValueError("run_id must be the desktop runner ID, for example r1.")
            body = {"runId": params["run_id"]}
            path = "/runs/abort"
        else:
            path = "/sessions/" + segment(params, "session_id") + "/" + ("messages" if action == "send" else action)
            if action == "send":
                body = {"text": text_arg(params, "text", 20_000)}
            elif action == "model":
                body = {"provider": text_arg(params, "provider"), "modelId": text_arg(params, "model_id", 300)}
            elif action == "rename":
                body = {"name": text_arg(params, "name")}
        result = self.request("POST", path, body, request_id)
        result["requestId"] = request_id
        if action == "send" and result.get("ok"):
            result["hint"] = "Accepted by the desktop, not a completed answer. Read history for this session and status for its runId."
        return result


def tool_result(value, token=""):
    # Tool outputs never expose the configured device credential, even if echoed by a host.
    raw = json.dumps(value, ensure_ascii=False)
    return raw.replace(token, "[redacted]") if token else raw
