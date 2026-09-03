#!/usr/bin/env bash
set -euo pipefail

require_contract() {
    test "$(id -u):$(id -g)" = '0:0'
    test "$(cat /opt/roboteam-runtime/contract-v4)" = 'roboteam-runtime-v4'
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v4)" = '0:0:444'
    test -x /usr/bin/podman
    test -x /usr/bin/fuse-overlayfs
    test -x /usr/bin/pasta
    test -x /usr/local/bin/node
    test -x /usr/local/bin/npm
    test -x /usr/local/bin/npx
    test ! -e /usr/bin/newuidmap
    test ! -e /usr/bin/newgidmap
    node --version
    npm --version
    podman --version | grep -E '^podman version 6\.'
}

case "${1:-contract}" in
    contract)
        require_contract
        ;;
    nested)
        require_contract
        install -d /data/podman/storage /tmp/roboteam-podman-run /tmp/roboteam-podman-xdg
        podman run --rm --ipc private --shm-size 1g --network pasta \
            docker.io/library/alpine:latest echo nested-podman-ok
        ;;
    *)
        echo "usage: $0 [contract|nested]" >&2
        exit 64
        ;;
esac
