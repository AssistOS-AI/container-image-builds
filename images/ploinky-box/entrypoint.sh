#!/usr/bin/env bash
set -u

MANAGED_LABEL='io.assistos.ploinky.managed=1'
EXPECTED_SUBORDINATE_IDS=65534
EXPECTED_MAPPED_IDS=65535
MINIMUM_PODMAN_VERSION=5.4
EXPECTED_CLOUDFLARED_VERSION=2026.7.1

fail() {
    echo "[ploinky-box] SELF-CHECK FAILED: $1" >&2
    exit 1
}

write_box_transport_contract() {
    local transport_file="${PLOINKY_BOX_TRANSPORT_FILE:-/run/ploinky/box-transport.json}"
    local containers_conf="${PLOINKY_BOX_PODMAN_CONTAINERS_CONF:-/home/podman/.config/containers/containers.conf}"
    local owner="${PLOINKY_BOX_TRANSPORT_OWNER:-}"
    local route_json
    local route_pair
    local transport_address
    local transport_interface
    local address_json
    local write_result

    route_json="$(ip -j -4 route get 198.51.100.1 2>&1)" \
        || fail "cannot discover box default route: ${route_json:-no diagnostic}"
    route_pair="$(ROUTE_JSON="$route_json" node - <<'NODE'
try {
  const net = require('node:net');
  const routes = JSON.parse(process.env.ROUTE_JSON || '[]');
  if (!Array.isArray(routes) || routes.length !== 1) {
    throw new Error('default route result must be exact');
  }
  const route = routes[0] || {};
  const address = String(route.prefsrc || '').trim();
  const dev = String(route.dev || '').trim();
  if (net.isIP(address) !== 4 || !dev || /[\u0000-\u0020\u007f/\\]/.test(dev)) {
    throw new Error('default route result lacks exact IPv4 prefsrc/device');
  }
  const first = Number(address.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224) {
    throw new Error('default route prefsrc is not a routable box IPv4 address');
  }
  process.stdout.write(`${address} ${dev}`);
} catch (error) {
  process.stdout.write(error.message || String(error));
  process.exit(1);
}
NODE
)" || fail "$route_pair"
    transport_address="${route_pair%% *}"
    transport_interface="${route_pair#* }"
    address_json="$(ip -j -4 address show dev "$transport_interface" 2>&1)" \
        || fail "cannot inspect box transport interface '$transport_interface': ${address_json:-no diagnostic}"
    write_result="$(
        ROUTE_JSON="$route_json" \
        ADDRESS_JSON="$address_json" \
        TRANSPORT_FILE="$transport_file" \
        CONTAINERS_CONF="$containers_conf" \
        TRANSPORT_ADDRESS="$transport_address" \
        TRANSPORT_INTERFACE="$transport_interface" \
        node - <<'NODE'
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');

  function fail(message) { throw new Error(message); }
  function parseArray(value, label) {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) fail(`${label} must be a JSON array`);
    return parsed;
  }
  function writeAtomic(file, bytes, mode) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, bytes, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, mode);
  }

  const address = process.env.TRANSPORT_ADDRESS || '';
  const iface = process.env.TRANSPORT_INTERFACE || '';
  if (net.isIP(address) !== 4 || !iface) fail('transport route parse did not produce an exact address/interface');
  const routes = parseArray(process.env.ROUTE_JSON, 'route output');
  if (routes.length !== 1 || String(routes[0]?.prefsrc || '') !== address || String(routes[0]?.dev || '') !== iface) {
    fail('default route result changed during transport write');
  }
  const interfaces = parseArray(process.env.ADDRESS_JSON, 'address output');
  const record = interfaces.find((entry) => String(entry?.ifname || '') === iface);
  const assigned = Array.isArray(record?.addr_info) && record.addr_info.some((entry) => (
    String(entry?.family || '') === 'inet' && String(entry?.local || '') === address
  ));
  if (!assigned) fail('transport address is not assigned to the discovered interface');

  writeAtomic(process.env.TRANSPORT_FILE, `${JSON.stringify({ address, interface: iface })}\n`, 0o600);
  writeAtomic(process.env.CONTAINERS_CONF, `[containers]\nhost_containers_internal_ip="${address}"\n`, 0o600);
} catch (error) {
  process.stdout.write(error.message || String(error));
  process.exit(1);
}
NODE
    )" || fail "$write_result"
    if [ -n "$owner" ] && [ "$owner" != "skip" ]; then
        chown "$owner" "$transport_file" "$containers_conf" \
            || fail "cannot set podman ownership on transport files"
    fi
    chmod 0600 "$transport_file" "$containers_conf" \
        || fail "cannot set private transport file modes"
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

reject_retained_managed_containers() {
    local managed_ids

    if ! managed_ids="$(podman ps --all --quiet --filter "label=$MANAGED_LABEL" 2>&1)"; then
        fail "cannot enumerate Ploinky-managed nested containers: ${managed_ids:-no diagnostic}"
    fi
    test -z "$managed_ids" || fail \
        "retained Ploinky-managed nested containers were found; stop/remove them explicitly in the old box, destroy it, and recreate with runtime contract 5 (v5 will not delete or import old state)"
}

if [ "${PLOINKY_BOX_ENTRYPOINT_TRANSPORT_ONLY:-}" = "1" ]; then
    write_box_transport_contract
    exit 0
fi

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

require_cloudflared_contract() {
    local version_output
    local help_output

    command -v cloudflared >/dev/null 2>&1 || fail "cloudflared not on PATH"
    test -x "$(command -v cloudflared)" || fail "cloudflared is not executable"
    version_output="$(cloudflared --version 2>&1)" \
        || fail "cannot inspect cloudflared version: ${version_output:-no diagnostic}"
    case "$version_output" in
        "cloudflared version $EXPECTED_CLOUDFLARED_VERSION"|"cloudflared version $EXPECTED_CLOUDFLARED_VERSION "*) ;;
        *) fail "cloudflared must be exactly $EXPECTED_CLOUDFLARED_VERSION (observed ${version_output:-unknown})" ;;
    esac
    help_output="$(cloudflared tunnel run --help 2>&1)" \
        || fail "cannot inspect cloudflared tunnel-run options: ${help_output:-no diagnostic}"
    [[ "$help_output" == *"--token-file"* ]] \
        || fail "cloudflared $EXPECTED_CLOUDFLARED_VERSION lacks required --token-file support"
}

command -v bash >/dev/null 2>&1 || fail "bash not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm not on PATH"
command -v npx >/dev/null 2>&1 || fail "npx not on PATH"
command -v git >/dev/null 2>&1 || fail "git not on PATH"
command -v podman >/dev/null 2>&1 || fail "podman not on PATH"
command -v ss >/dev/null 2>&1 || fail "ss not on PATH"
command -v nsenter >/dev/null 2>&1 || fail "nsenter not on PATH"
require_cloudflared_contract
test "$(id -un 2>/dev/null)" = 'podman' || fail "process user must be podman"
require_value USER podman
require_value HOME /home/podman
require_value PLOINKY_WORKSPACE_ROOT /workspace
require_value PLOINKY_DISABLE_HOST_SANDBOX 1
require_value container oci
require_value _CONTAINERS_USERNS_CONFIGURED ''
require_value BUILDAH_ISOLATION chroot
write_box_transport_contract
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

# A contract-5 process never deletes, imports, or translates retained managed
# runtime state. Operators must make the old box quiescent and remove its
# managed containers before the explicit destroy/recreate boundary.
reject_retained_managed_containers
echo "[ploinky-box] self-check OK"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec sleep infinity
