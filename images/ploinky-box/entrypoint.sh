#!/usr/bin/env bash
set -u

MANAGED_LABEL='io.assistos.ploinky.managed=1'
EXPECTED_SUBORDINATE_IDS=65534
EXPECTED_MAPPED_IDS=65535
MINIMUM_PODMAN_VERSION=5.4

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

require_value() {
    local name="$1"
    local expected="$2"
    local actual="${!name-}"
    test "$actual" = "$expected" \
        || fail "$name must be '$expected' (observed '${actual:-<empty>}')"
}

require_helper_privilege() {
    local helper="$1"
    local capability="$2"
    local path
    local capabilities

    path="$(command -v "$helper" 2>/dev/null)" \
        || fail "$helper not on PATH"
    test "$(stat -c '%u' "$path" 2>/dev/null)" = '0' \
        || fail "$helper must be owned by root"
    capabilities="$(getcap "$path" 2>/dev/null || true)"
    if [[ "$capabilities" == *"${capability}=ep"* ]] \
        || [[ "$capabilities" == *"${capability}+ep"* ]] \
        || test -u "$path"; then
        return
    fi
    fail "$helper requires ${capability}=ep file capability or setuid-root"
}

configured_subid_count() {
    local file="$1"
    awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' "$file"
}

mapped_id_count() {
    awk '{ total += $3 } END { print total + 0 }'
}

require_full_mapping() {
    local kind="$1"
    local subid_file="/etc/sub${kind}"
    local proc_file="/proc/self/${kind}_map"
    local configured
    local mapping
    local mapped

    configured="$(configured_subid_count "$subid_file")" \
        || fail "cannot read $subid_file"
    test "$configured" -eq "$EXPECTED_SUBORDINATE_IDS" \
        || fail "podman subordinate ${kind^^} range must contain exactly $EXPECTED_SUBORDINATE_IDS IDs (observed $configured)"
    mapping="$(podman unshare cat "$proc_file" 2>&1)" \
        || fail "cannot inspect Podman ${kind^^} mapping: $mapping"
    mapped="$(printf '%s\n' "$mapping" | mapped_id_count)"
    test "$mapped" -eq "$EXPECTED_MAPPED_IDS" \
        || fail "Podman ${kind^^} mapping must contain exactly $EXPECTED_MAPPED_IDS IDs (observed $mapped)"
}

reset_ephemeral_podman_runtime() {
    local uid
    local path

    uid="$(id -u)"
    for path in \
        "/tmp/storage-run-$uid" \
        "/tmp/podman-run-$uid"; do
        test -e "$path" || continue
        rm -rf -- "$path" \
            || fail "cannot reset stale nested Podman runtime path $path"
    done
}

remove_managed_containers() {
    local managed_ids
    local id
    local removal_output

    if ! managed_ids="$(podman ps --all --quiet --filter "label=$MANAGED_LABEL" 2>&1)"; then
        fail "cannot enumerate Ploinky-managed nested containers: ${managed_ids:-no diagnostic}"
    fi

    while IFS= read -r id; do
        test -n "$id" || continue
        if ! removal_output="$(podman rm --force --time 0 "$id" 2>&1)"; then
            fail "cannot remove Ploinky-managed nested container $id: ${removal_output:-no diagnostic}"
        fi
    done <<< "$managed_ids"
}

require_managed_network_stack() {
    local podman_version
    local oldest_version
    local network_backend
    local pasta_version

    podman_version="$(podman --version 2>/dev/null | awk '{ print $3 }')" \
        || fail "cannot inspect inner Podman version"
    [[ "$podman_version" =~ ^[0-9]+\.[0-9]+([.][0-9]+)?([.-][0-9A-Za-z.-]+)?$ ]] \
        || fail "inner Podman returned an invalid version '${podman_version:-<empty>}'"
    oldest_version="$(printf '%s\n%s\n' "$MINIMUM_PODMAN_VERSION" "$podman_version" | sort -V | head -n 1)"
    test "$oldest_version" = "$MINIMUM_PODMAN_VERSION" \
        || fail "inner Podman must be $MINIMUM_PODMAN_VERSION or newer (observed $podman_version)"

    network_backend="$(podman info --format '{{.Host.NetworkBackend}}' 2>&1)" \
        || fail "cannot inspect inner Podman network backend: ${network_backend:-no diagnostic}"
    test "$network_backend" = netavark \
        || fail "inner Podman network backend must be netavark (observed ${network_backend:-unknown})"

    command -v pasta >/dev/null 2>&1 || fail "pasta backend not on PATH"
    pasta_version="$(pasta --version 2>&1)" \
        || fail "pasta backend is not operational: ${pasta_version:-no diagnostic}"
    test -n "$pasta_version" || fail "pasta backend returned no version evidence"
}

command -v bash >/dev/null 2>&1 || fail "bash not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v npx >/dev/null 2>&1 || fail "npx not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
test "$(id -un 2>/dev/null)" = 'podman' || fail "process user must be podman"
require_value USER podman
require_value HOME /home/podman
require_value PLOINKY_WORKSPACE_ROOT /workspace
require_value PLOINKY_DISABLE_HOST_SANDBOX 1
require_value container oci
require_value _CONTAINERS_USERNS_CONFIGURED ''
require_value BUILDAH_ISOLATION chroot
test -f /etc/ploinky-box || fail "/etc/ploinky-box marker missing"
test -x /opt/ploinky/bin/ploinky || fail "ploinky source not mounted read-only at /opt/ploinky"
test -d /opt/ploinky/node_modules || fail "dependency volume not mounted at /opt/ploinky/node_modules"
test -w /opt/ploinky/node_modules || fail "dependency volume not writable at /opt/ploinky/node_modules"
test -w /workspace || fail "/workspace not writable"
test -e /dev/fuse || fail "/dev/fuse not present"
test -e /dev/net/tun || fail "/dev/net/tun not present"
require_helper_privilege newuidmap cap_setuid
require_helper_privilege newgidmap cap_setgid
reset_ephemeral_podman_runtime
podman version >/dev/null 2>&1 || fail "inner podman version check failed"
if ! podman_info="$(podman info 2>&1)"; then
    fail "inner podman not functional: ${podman_info:-no diagnostic}"
fi
inner_rootless="$(podman info --format '{{.Host.Security.Rootless}}' 2>&1)" \
    || fail "cannot inspect inner Podman rootless state: ${inner_rootless:-no diagnostic}"
test "$inner_rootless" = true \
    || fail "inner Podman must be rootless (observed ${inner_rootless:-unknown})"
require_managed_network_stack
require_full_mapping uid
require_full_mapping gid

# This exact filter intentionally catches pre-contract-4 gateway and agent
# containers. It does not remove manual containers, images, named volumes, or
# valid managed networks stored in the three retained outer volumes.
remove_managed_containers
echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
