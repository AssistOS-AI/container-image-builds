#!/usr/bin/env bash
set -euo pipefail

require_contract() {
    test "$(id -u):$(id -g)" = '0:0'
    test "$(cat /opt/roboteam-runtime/contract-v6)" = 'roboteam-runtime-v6'
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v6)" = '0:0:444'
    test -x /usr/local/bin/roboteam-podman-init
    sh -n /usr/local/bin/roboteam-podman-init
    test -x /usr/bin/podman
    test -x /usr/bin/fuse-overlayfs
    test -x /usr/bin/pasta
    test -x /usr/local/bin/node
    test -x /usr/local/bin/npm
    test -x /usr/local/bin/npx
    test -x /usr/local/bin/rg
    # Coding agents shell out to procps-ng: Codex's background app-server records its start time with
    # `ps -p <pid> -o lstart=`, and robot terminals see this image's /usr through Bubblewrap.
    test -x /usr/bin/ps
    test -x /usr/bin/pgrep
    test -x /usr/bin/pkill
    for executable in which tput clear infocmp script hostname lsof file fd; do
        command -v "$executable" >/dev/null
    done
    test -n "$(LC_ALL=C TZ=UTC ps -p "$$" -o lstart= | tr -d ' ')"
    # Pi decides whether fd is installed by running `fd --version`.
    fd --version | grep -q '^fd '
    test ! -e /usr/bin/newuidmap
    test ! -e /usr/bin/newgidmap
    node --version
    npm --version
    NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main' npm --version
    test "$(podman --version)" = 'podman version 5.8.7'
    rg --version | head -n 1 | grep -q '^ripgrep 15\.1\.0 '
}

case "${1:-contract}" in
    contract)
        require_contract
        ;;
    nested)
        require_contract
        roboteam-podman-init
        install -d /data/podman/images /tmp/roboteam-podman-xdg
        podman run --rm --ipc none --tmpfs /dev/shm:rw,size=1g,mode=1777 --network pasta \
            docker.io/library/alpine:latest sh -ec 'mkdir -p /data/nested-probe /tmp/nested-probe; echo nested-podman-ok'
        ;;
    *)
        echo "usage: $0 [contract|nested]" >&2
        exit 64
        ;;
esac
