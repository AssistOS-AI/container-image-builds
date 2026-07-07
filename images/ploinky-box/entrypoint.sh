#!/usr/bin/env bash
# ploinky-box entrypoint: self-check, then run the given command or idle.
# The self-check is the single source of in-box diagnostics; the wrapper's
# `up` health-wait surfaces these messages verbatim.
# Ploinky core is NOT baked into this image: the wrapper mounts a host
# checkout read-only at /opt/ploinky plus a writable dependency volume at
# /opt/ploinky/node_modules. Dependencies are installed by the first
# `ploinky` run (confirm/install flow), so this self-check must not require
# node_modules content - only the mountpoints.
set -u

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
[ -f /etc/ploinky-box ] || fail "/etc/ploinky-box marker missing (image build problem)"
[ -x /opt/ploinky/bin/ploinky ] || fail "ploinky source not mounted: bind-mount a ploinky checkout read-only at /opt/ploinky (the ploinky-box wrapper does this automatically)"
[ -d /opt/ploinky/node_modules ] || fail "dependency volume not mounted at /opt/ploinky/node_modules"
[ -w /workspace ] || fail "/workspace not writable (named-volume ownership problem)"
[ -e /dev/fuse ] || fail "/dev/fuse not present - run the box with --device /dev/fuse"
[ -e /dev/net/tun ] || fail "/dev/net/tun not present - run the box with --device /dev/net/tun (slirp4netns agent networking needs it)"
podman info >/dev/null 2>&1 \
    || fail "inner podman not functional - check --security-opt seccomp=unconfined, --device /dev/fuse, and subuid mapping"

# Fresh slate: an unclean box stop leaves inner podman with stale "running"
# containers (dead conmon/rootlessport, PID reuse fools liveness), which stops
# ploinky from recreating agents on resume. Agent containers are disposable -
# `ploinky start` recreates them from /workspace/.ploinky state.
podman rm -af --time 0 >/dev/null 2>&1 || true

echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
