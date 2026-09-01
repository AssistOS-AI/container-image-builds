#!/usr/bin/env bash
set -euo pipefail

require_contract() {
    test "$(id -u):$(id -g)" = '0:0'
    test "$(cat /opt/roboteam-runtime/contract-v2)" = 'roboteam-runtime-v2'
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v2)" = '0:0:444'
    test -x /usr/bin/podman
    test -x /usr/bin/fuse-overlayfs
    test -x /usr/bin/pasta
    test -x /usr/local/bin/node
    test ! -e /usr/bin/newuidmap
    test ! -e /usr/bin/newgidmap
    node --version
    podman --version
}

case "${1:-contract}" in
    contract)
        require_contract
        ;;
    nested)
        require_contract
        install -d /data/podman/storage /tmp/roboteam-podman-run /tmp/roboteam-podman-xdg
        podman run --rm --ipc private --shm-size 1g docker.io/library/alpine:latest echo nested-podman-ok
        ;;
    *)
        echo "usage: $0 [contract|nested]" >&2
        exit 64
        ;;
esac
