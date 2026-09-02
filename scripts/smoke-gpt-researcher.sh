#!/bin/bash
set -euo pipefail

test -r /consumer/scripts/install-gpt-researcher.sh
: "${HOME:=/gpt-state/home}"
: "${WORKSPACE_PATH:=/gpt-state/workspace}"
export HOME WORKSPACE_PATH
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$HOME" "$WORKSPACE_PATH"
. /consumer/scripts/runtime-paths.sh

verify_install() {
    "$VENV_DIR/bin/python" - "$APP_DIR" "$VENV_DIR" <<'PY'
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote, urlparse

import gpt_researcher

app, venv = (Path(value).resolve() for value in sys.argv[1:])
distribution = importlib.metadata.distribution("gpt-researcher")
direct_url = json.loads(distribution.read_text("direct_url.json"))
url = urlparse(direct_url["url"])
assert url.scheme == "file" and not url.netloc, direct_url
assert Path(unquote(url.path)).resolve() == app, direct_url
assert direct_url.get("dir_info", {}).get("editable", False) is False, direct_url
installed = Path(gpt_researcher.__file__).resolve().parent
assert installed.is_relative_to(venv), installed
source = app / "gpt_researcher"
modules = sorted(source.rglob("*.py"))
assert modules, source
for module in modules:
    target = installed / module.relative_to(source)
    assert target.is_file() and target.read_bytes() == module.read_bytes(), module
status = subprocess.check_output(["git", "-C", str(app), "status", "--porcelain=v1"], text=True)
assert not status, status
head = subprocess.check_output(["git", "-C", str(app), "rev-parse", "HEAD"], text=True).strip()
print(json.dumps({"ok": True, "consumer": "GPTResearcher", "upstreamSha": head,
                  "distributionVersion": distribution.version, "sourceModulesVerified": len(modules),
                  "sameCheckoutInstall": True, "cleanCheckout": True}))
PY
}

mode="${1:-smoke}"
case "$mode" in
    install)
        # The workflow grants network only to this cold-install phase. All
        # readiness and task compatibility below run in a second, networkless
        # container against the exact persisted installation.
        sh /consumer/scripts/install-gpt-researcher.sh
        test -x "$VENV_DIR/bin/python"
        test -d "$APP_DIR/.git"
        verify_install
        printf '%s\n' '{"ok":true,"consumer":"GPTResearcher","coldInstall":true}'
        exit 0
        ;;
    smoke)
        ;;
    *)
        echo "usage: $0 install|smoke" >&2
        exit 2
        ;;
esac

test -x "$VENV_DIR/bin/python"
test -d "$APP_DIR/.git"
verify_install

# Exercise an actual lightweight tool/task path without provider credentials.
settings_json="$(node /consumer/scripts/get-settings.mjs)"
node -e '
const record = JSON.parse(process.argv[1]);
if (record.ok !== true || !record.settings) process.exit(1);
' "$settings_json"
PYTHONPATH=/consumer/scripts "$VENV_DIR/bin/python" -c '
from gpt_researcher_agent.io_utils import parse_input
task = parse_input("{\"query\":\"runner compatibility smoke\",\"useLocalDocs\":false}")
assert task and task["query"] == "runner compatibility smoke"
print("gpt-researcher-task-adapter-ok")
'

# Invoke the actual configured research command on its deterministic invalid-
# input path. This reaches the installed Python adapter without provider or
# egress authority and proves its structured terminal contract.
set +e
task_output="$(PYTHONPATH=/consumer/scripts sh /consumer/scripts/run-research.sh </dev/null)"
task_status=$?
set -e
test "$task_status" -eq 1
node -e '
const record = JSON.parse(process.argv[1]);
if (record.ok !== false || !String(record.error).includes("Invalid or missing input")) process.exit(1);
' "$task_output"

# Run the real UI and real readiness script. AgentServer is outside this image's
# ownership, so a bounded loopback health stub supplies only that one endpoint.
python3 -c '
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{\"ok\":true}")
    def log_message(self, *_):
        pass
HTTPServer(("127.0.0.1", 7000), H).serve_forever()
' &
agent_health_pid=$!
(
    cd "$APP_DIR"
    export PYTHONPATH=/consumer/scripts
    exec "$VENV_DIR/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8000
) >/tmp/gpt-researcher-ui.log 2>&1 &
ui_pid=$!
cleanup() {
    kill "$ui_pid" "$agent_health_pid" 2>/dev/null || true
    wait "$ui_pid" "$agent_health_pid" 2>/dev/null || true
}
trap cleanup EXIT

ready=false
for _ in $(seq 1 90); do
    if sh /consumer/readiness.sh >/tmp/gpt-readiness.log 2>&1; then
        ready=true
        break
    fi
    if ! kill -0 "$ui_pid" 2>/dev/null; then
        tail -200 /tmp/gpt-researcher-ui.log >&2
        exit 1
    fi
    sleep 1
done
test "$ready" = true
verify_install

printf '%s\n' '{"ok":true,"consumer":"GPTResearcher","network":"none","readiness":true,"minimalTask":true}'
