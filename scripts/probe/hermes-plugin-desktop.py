"""Actual plugin handlers and actual desktop; only reversible fixture operations."""
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

path = Path(os.environ["INKSTONE_PLUGIN_PATH"]) if os.environ.get("INKSTONE_PLUGIN_PATH") else Path(__file__).resolve().parents[2] / "integrations/hermes-inkstone"
spec = importlib.util.spec_from_file_location("desktop_inkstone_plugin", path / "__init__.py", submodule_search_locations=[str(path)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

tools = {}
commands = {}
checks = 0
class Context:
    def register_tool(self, **tool):
        tools[tool["name"]] = tool["handler"]
    def register_command(self, name, **kwargs):
        commands[name] = kwargs['handler']
if os.environ.get("INKSTONE_OFFICIAL_HERMES"):
    from hermes_cli.plugins import PluginManager
    from hermes_cli.plugins_manifest import parse_manifest_file
    from tools.registry import registry
    manager = PluginManager()
    manifest = parse_manifest_file(path / "plugin.yaml", path, "user", "")
    assert manifest is not None
    manager._load_plugin(manifest)
    loaded = manager._plugins["inkstone"]
    assert loaded.enabled and not loaded.error, loaded.error
    tools = {name: registry.get_entry(name, scope=manager.scope_key).handler for name in ("inkstone_read", "inkstone_control")}
    commands = {"inkstone": manager._plugin_commands["inkstone"]["handler"]}
    print("PASS installed Hermes official manifest loader, tool registry and user command")
else:
    plugin.register(Context())

def call(tool, **args):
    result = json.loads(tools[tool](args))
    if not result.get("ok"):
        raise AssertionError(str(result))
    return result

def check(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1
    print("PASS " + message)

fixture = os.environ["INKSTONE_DESKTOP_FIXTURE_ID"]
info = call("inkstone_read", action="info")
check("send" in info["capabilities"], "desktop capability negotiation")
for attempt in range(100):
    status = call("inkstone_read", action="status")
    if status["data"].get("desktop", {}).get("ready"):
        break
    time.sleep(.1)
sessions = call("inkstone_read", action="sessions")
check(any(s["id"] == fixture for s in sessions["data"]["sessions"]), "stored desktop fixture visible")
history = call("inkstone_read", action="history", session_id=fixture, limit=5)
check(any(m.get("text") == "Hermes desktop fixture" for m in history["data"]["messages"]), "actual persisted history readable")
selected = call("inkstone_control", action="select", session_id=fixture)
check(selected["ok"], "select actual desktop/pi session")
check('human-approval' in info['capabilities'], 'paired user receives human approval capability')
until = time.time() + 12
while True:
    questions = call('inkstone_read', action='questions')['data']['questions']
    ordinary = next((q for q in questions if 'Hermes ordinary question fixture' in q.get('title', '')), None)
    if ordinary:
        break
    if time.time() > until:
        raise AssertionError('Ordinary pi UI question did not appear')
    time.sleep(.1)
check(call('inkstone_control', action='answer', question_id=ordinary['id'], value='phone-ok')['ok'],
      'phone answers ordinary pi UI question')
for label in ('approve', 'deny'):
    until = time.time() + 12
    while True:
        questions = call('inkstone_read', action='questions')['data']['questions']
        target = next((q for q in questions if 'Hermes approval fixture ' + ('allow' if label == 'approve' else 'deny') in q.get('message', '')), None)
        if target:
            break
        if time.time() > until:
            raise AssertionError('Real pi capability approval did not appear: ' + label)
        time.sleep(.1)
    check(target['sessionId'] == fixture, 'real approval retains selected session origin')
    blocked = json.loads(tools['inkstone_control']({'action':'answer', 'question_id':target['id'], 'confirmed':True}))
    check(not blocked.get('ok'), 'model ordinary answer cannot approve real pending operation')
    preview = commands['inkstone']('approvals')
    code = re.search(r'/inkstone approve ([0-9a-f]{8})', preview).group(1)
    check('已将你的' in commands['inkstone'](label + ' ' + code), 'user slash command reaches real desktop: ' + label)
until = time.time() + 5
while True:
    if os.environ.get('INKSTONE_OFFICIAL_HERMES'):
        # The orchestrator checks the original pi replies on the Windows host.
        break
    result_path = Path(os.environ['INKSTONE_DESKTOP_APPROVAL_RESULT'])
    result = json.loads(result_path.read_text()) if result_path.exists() else []
    if isinstance(result, list) and len(result) == 2:
        break
    if time.time() > until:
        raise AssertionError('pi capability requests did not resume: ' + str(result))
    time.sleep(.1)
if not os.environ.get('INKSTONE_OFFICIAL_HERMES'):
    check(result[0]['summary']['allowed'] is True and result[1]['summary']['allowed'] is False,
          'original real pi capability requests resume with allow and deny')
models = call("inkstone_read", action="models", session_id=fixture)
check(models["ok"], "actual model list readable without inference")
renamed = call("inkstone_control", action="rename", session_id=fixture, name="Hermes fixture renamed")
check(renamed["ok"], "rename isolated persisted session")
created = call("inkstone_control", action="new")
check(created["ok"], "create actual desktop/pi session")
check(call("inkstone_control", action="select", session_id=fixture)["ok"], "return to original fixture")
check(call('inkstone_control', action='send', session_id=fixture, text='/inkstone-probe')['ok'],
      'phone submits harmless registered pi command to explicit session')
time.sleep(.5)
print(f"{checks}/{checks} plugin checks passed; synthetic confirmations and harmless pi command, no model inference")
