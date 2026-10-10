"""Behavioral tests: actual HTTP routes, plugin registration, validation and transport failures."""
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "integrations" / "hermes-inkstone"
spec = importlib.util.spec_from_file_location("test_inkstone_plugin", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
client_module = sys.modules[spec.name + ".client"]
sys.path.insert(0, str(PLUGIN))
import connect


class Registration:
    def __init__(self):
        self.tools = {}
        self.commands = {}

    def register_tool(self, *, name, toolset, schema, handler):
        assert toolset == "inkstone" and schema["name"] == name
        self.tools[name] = handler

    def register_command(self, name, **kwargs):
        self.commands[name] = kwargs["handler"]


class PluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = Registration()
        plugin.register(cls.ctx)

    def read(self, **params):
        return json.loads(self.ctx.tools["inkstone_read"](params, task_id="hermes-task"))

    def control(self, **params):
        return json.loads(self.ctx.tools["inkstone_control"](params, task_id="hermes-task"))

    def test_registration_is_lazy(self):
        with patch.object(client_module, "load_connection", side_effect=AssertionError("must not connect on load")):
            ctx = Registration()
            plugin.register(ctx)
        self.assertEqual(set(ctx.tools), {"inkstone_read", "inkstone_control"})
        self.assertEqual(set(ctx.commands), {"inkstone"})

    def test_approval_user_command_and_model_boundary(self):
        questions = self.read(action="questions")["data"]["questions"]
        sensitive = next(q for q in questions if q["sensitive"])
        self.assertFalse(self.control(action="approve", question_id=sensitive["id"])["ok"])
        self.assertFalse(self.control(action="answer", question_id=sensitive["id"], confirmed=True)["ok"])
        self.assertTrue(self.control(action="answer", question_id="ordinary-question", value="file A")["ok"])
        legacy = client_module.Client(os.environ["INKSTONE_TEST_URL"], "fixture-token-hermes")
        body = {"sessionId": sensitive["sessionId"], "runId": sensitive["runId"], "digest": sensitive["approvalDigest"], "confirmed": True}
        self.assertEqual(legacy.request("POST", "/questions/" + sensitive["id"] + "/approval", body, "legacy-approval-key")["httpStatus"], 403)
        command = self.ctx.commands["inkstone"]
        self.assertIn("失效", command("approve never-shown"))
        preview = command("approvals")
        self.assertIn("fixture dangerous operation", preview)
        import re
        codes = re.findall(r"/inkstone approve ([0-9a-f]{8})", preview)
        self.assertEqual(len(codes), 2)
        before = len(self.read(action="status")["data"]["calls"])
        self.assertIn("允许", command("approve " + codes[0]))
        self.assertIn("失效", command("approve " + codes[0]))
        self.assertIn("拒绝", command("deny " + codes[1]))
        self.assertEqual(len(self.read(action="status")["data"]["calls"]), before + 2)
        self.assertFalse(any(q["sensitive"] for q in self.read(action="questions")["data"]["questions"]))

    def test_read_routes_and_pagination(self):
        for action in ("info", "status", "sessions"):
            self.assertTrue(self.read(action=action)["ok"])
        history = self.read(action="history", session_id="s-1", limit=3, before="cursor /?&")
        self.assertEqual(history["data"]["before"], "cursor /?&")
        self.assertEqual(history["data"]["limit"], 3)
        self.assertTrue(self.read(action="models", session_id="s-1")["ok"])

    def test_all_control_routes_target_ids(self):
        operations = [dict(action="new"), dict(action="select", session_id="s-1"), dict(action="send", session_id="s-1", text="local fixture task"),
                      dict(action="model", session_id="s-1", provider="fixture", model_id="local"), dict(action="rename", session_id="s-1", name="renamed"), dict(action="abort", run_id="r1")]
        for operation in operations:
            result = self.control(**operation)
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["requestId"])
            if operation["action"] == "send":
                self.assertIn("not a completed answer", result["hint"])
        calls = self.read(action="status")["data"]["calls"]
        self.assertTrue(any(call.get("action") == "send" and call.get("sessionId") == "s-1" for call in calls))
        self.assertTrue(any(call.get("action") == "abort" and call.get("runId") == "r1" for call in calls))

    def test_same_idempotency_key_does_not_repeat_send(self):
        before = len(self.read(action="status")["data"]["calls"])
        arguments = dict(action="send", session_id="s-1", text="once", request_id="same-send-123456")
        self.assertTrue(self.control(**arguments)["ok"])
        self.assertTrue(self.control(**arguments)["ok"])
        self.assertEqual(len(self.read(action="status")["data"]["calls"]), before + 1)

    def test_missing_ids_and_invalid_arguments_never_write(self):
        before = len(self.read(action="status")["data"]["calls"])
        for args in [dict(action="send", text="missing target"), dict(action="abort"), dict(action="send", session_id="../bad", text="no"),
                     dict(action="send", session_id="s-1", text=" " ), dict(action="model", session_id="s-1", provider="fixture"),
                     dict(action="send", session_id="s-1", text="x" * 20001), dict(action="approve"), dict(action="send", session_id="s-1", text="hi", request_id="short")]:
            self.assertFalse(self.control(**args)["ok"])
        for limit in [True, 0, 101, "4"]:
            self.assertFalse(self.read(action="history", session_id="s-1", limit=limit)["ok"])
        self.assertFalse(self.read(action="send")["ok"])
        self.assertEqual(len(self.read(action="status")["data"]["calls"]), before)

    def test_unauthorized_and_missing_config_are_actionable(self):
        with patch.dict(os.environ, {"INKSTONE_TOKEN": "bad-token"}):
            result = self.read(action="status")
            self.assertFalse(result["ok"])
            self.assertEqual(result["httpStatus"], 401)
            self.assertNotIn("bad-token", json.dumps(result))
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"INKSTONE_CONNECTION_FILE": str(Path(folder) / "missing.json")}):
            result = self.read(action="status")
            self.assertFalse(result["ok"])
            self.assertIn("connect.py", result["error"])

    def test_pair_and_private_atomic_save(self):
        url = os.environ["INKSTONE_TEST_URL"]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "connection.json"
            output = io.StringIO()
            with patch.dict(os.environ, {"INKSTONE_CONNECTION_FILE": str(path)}), patch.object(sys, "argv", ["connect.py", "--url", url, "--name", "Hermes test"]), patch.object(connect.getpass, "getpass", return_value=os.environ["INKSTONE_TEST_PAIR_CODE"]), patch("sys.stdout", output):
                self.assertEqual(connect.main(), 0)
            token = json.loads(path.read_text())["token"]
            self.assertNotIn(token, output.getvalue())
            self.assertTrue(client_module.Client(url, token).request("GET", "/info")["ok"])
            self.assertEqual(len(list(Path(folder).iterdir())), 1)
            with patch.dict(os.environ, {"INKSTONE_CONNECTION_FILE": str(path)}), patch.object(sys, "argv", ["connect.py", "--check"]), patch("sys.stdout", output):
                self.assertEqual(connect.main(), 0)
        # A consumed pairing code cannot produce a second device token.
        self.assertFalse(client_module.Client(url, "").request("POST", "/pair", {"code": os.environ["INKSTONE_TEST_PAIR_CODE"]})["ok"])

    def test_url_validation_and_token_redaction(self):
        for url in ["file:///tmp/x", "http://a:secret@localhost", "http://localhost/?token=x", "http://localhost/other", "http://localhost/#x", "http://localhost:0", "http://localhost:bad"]:
            with self.assertRaises(ValueError):
                client_module.normalize_url(url)
        self.assertEqual(client_module.normalize_url("https://localhost:8000/remote/v1/"), "https://localhost:8000/remote/v1")
        self.assertNotIn("secret", plugin.tool_result({"error": "secret"}, "secret"))

    def test_transport_failure_does_not_auto_retry(self):
        client = client_module.Client(os.environ["INKSTONE_TEST_URL"], "fixture-token-hermes", timeout=.1)
        with patch.object(client.opener, "open", side_effect=socket.timeout):
            result = client.control({"action": "send", "session_id": "s-1", "text": "uncertain", "request_id": "uncertain-send-key"})
            self.assertTrue(result["outcomeUnknown"])
            self.assertEqual(result["requestId"], "uncertain-send-key")
            self.assertEqual(client.opener.open.call_count, 1)

    def test_redirect_never_forwards_token(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.path)
                self.send_response(302)
                self.send_header("location", "/secret-destination")
                self.end_headers()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = client_module.Client(f"http://127.0.0.1:{server.server_port}", "secret").read({"action": "status"})
            self.assertFalse(result["ok"])
            self.assertEqual(received, ["/remote/v1/status"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
