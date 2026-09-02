#!/bin/bash
set -euo pipefail

test -r /consumer/scripts/install-gpt-researcher.sh
: "${HOME:=/gpt-state/home}"
: "${WORKSPACE_PATH:=/gpt-state/workspace}"
export HOME WORKSPACE_PATH
mkdir -p "$HOME" "$WORKSPACE_PATH"
. /consumer/scripts/runtime-paths.sh

mode="${1:-smoke}"
case "$mode" in
    install)
        # The workflow grants network only to this cold-install phase. All
        # readiness and task compatibility below run in a second, networkless
        # container against the exact persisted installation.
        sh /consumer/scripts/install-gpt-researcher.sh
        test -x "$VENV_DIR/bin/python"
        test -d "$APP_DIR/.git"
        "$VENV_DIR/bin/python" -c 'import gpt_researcher; print("gpt-researcher-import-ok")'
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
"$VENV_DIR/bin/python" -c 'import gpt_researcher; print("gpt-researcher-import-ok")'

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

printf '%s\n' '{"ok":true,"consumer":"GPTResearcher","network":"none","readiness":true,"minimalTask":true}'
