#!/usr/bin/env bash
set -u

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

command -v bash >/dev/null 2>&1 || fail "bash not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
test -f /etc/ploinky-box || fail "/etc/ploinky-box marker missing"
test -x /opt/ploinky/bin/ploinky || fail "ploinky source not mounted read-only at /opt/ploinky"
test -d /opt/ploinky/node_modules || fail "dependency volume not mounted at /opt/ploinky/node_modules"
test -w /workspace || fail "/workspace not writable"
test -e /dev/fuse || fail "/dev/fuse not present"
test -e /dev/net/tun || fail "/dev/net/tun not present"
podman info >/dev/null 2>&1 || fail "inner podman not functional"

podman rm -af --time 0 >/dev/null 2>&1 || true
echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
