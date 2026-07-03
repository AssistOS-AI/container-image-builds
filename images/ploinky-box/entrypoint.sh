#!/usr/bin/env bash
# ploinky-box entrypoint: self-check, then run the given command or idle.
# The self-check is the single source of in-box diagnostics; the wrapper's
# `up` health-wait surfaces these messages verbatim.
set -u

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
[ -x /opt/ploinky/bin/ploinky ] || fail "/opt/ploinky/bin/ploinky missing or not executable"
[ -d /opt/ploinky/node_modules/achillesAgentLib ] || fail "achillesAgentLib missing under /opt/ploinky/node_modules"
[ -w /workspace ] || fail "/workspace not writable (named-volume ownership problem)"
[ -e /dev/fuse ] || fail "/dev/fuse not present - run the box with --device /dev/fuse"
podman info >/dev/null 2>&1 \
    || fail "inner podman not functional - check --security-opt seccomp=unconfined, --device /dev/fuse, and subuid mapping"

echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
