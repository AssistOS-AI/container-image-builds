#!/usr/bin/env bash
set -euo pipefail

mode="${1:-contract}"

require_runtime_contract() {
    test "$(id -u):$(id -g)" = '0:0'
    for executable in \
        /bin/bash \
        /usr/bin/chromium \
        /usr/bin/dbus-launch \
        /usr/bin/getent \
        /usr/bin/openbox \
        /usr/bin/openbox-session \
        /usr/bin/passwd \
        /usr/bin/websockify \
        /usr/bin/x11vnc \
        /usr/bin/xterm \
        /usr/bin/Xvfb \
        /usr/sbin/useradd; do
        test -x "$executable"
    done
    test -r /usr/share/novnc/core/rfb.js
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v1)" = '0:0:444'
    test "$(cat /opt/roboteam-runtime/contract-v1)" = 'roboteam-runtime-v1'
    test "$(wc -l < /opt/roboteam-runtime/contract-v1)" -eq 1
    chromium --version
}

case "$mode" in
    contract)
        require_runtime_contract
        ;;
    controller)
        require_runtime_contract
        profile_uid=42001
        profile_user=roboteam-smoke
        profile_root=/tmp/roboteam-profile
        install -d -o root -g root -m 0700 "$profile_root"
        /usr/sbin/useradd \
            --uid "$profile_uid" \
            --user-group \
            --no-create-home \
            --home-dir "$profile_root" \
            --shell /bin/bash \
            "$profile_user"
        profile_gid="$(/usr/bin/getent passwd "$profile_user" | cut -d: -f4)"
        test -n "$profile_gid"
        chown "$profile_uid:$profile_gid" "$profile_root"
        test "$(stat -c '%u:%g' "$profile_root")" = "$profile_uid:$profile_gid"
        PROFILE_UID="$profile_uid" PROFILE_GID="$profile_gid" node <<'NODE'
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const uid = Number(process.env.PROFILE_UID);
const gid = Number(process.env.PROFILE_GID);
const child = spawnSync('/usr/bin/id', ['-u'], { uid, gid, encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout.trim(), String(uid));
NODE
        ;;
    *)
        echo "usage: $0 [contract|controller]" >&2
        exit 64
        ;;
esac
