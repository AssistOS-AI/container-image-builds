#!/usr/bin/env bash
set -euo pipefail

target="${1:-all}"
case "$target" in
    agent|desktop|browser|all) ;;
    *)
        echo "usage: install-roboteam-local-in-box.sh [agent|desktop|browser|all]" >&2
        exit 64
        ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
context="$repository_root/images/roboteam-agent"
agent_image="docker.io/assistos/roboteam-agent:runtime"
desktop_image="docker.io/assistos/roboteam-desktop:runtime"
browser_image="docker.io/assistos/roboteam-browser:runtime"

build_image() {
    local image="$1"
    local dockerfile="$2"
    echo "[local-images] building $image"
    podman build --pull=missing -t "$image" -f "$context/$dockerfile" "$context"
}

robot_runtime_container() {
    local -a candidates=()
    mapfile -t candidates < <(podman ps \
        --filter label=io.assistos.ploinky.managed=1 \
        --filter label=io.assistos.ploinky.resource=agent \
        --filter name=_roboTeamAgent_ \
        --format '{{.ID}}')
    if [ "${#candidates[@]}" -ne 1 ]; then
        echo "[local-images] expected one running managed RoboTeam container, found ${#candidates[@]}" >&2
        echo "[local-images] start or reinstall roboTeamAgent before installing local GUI images" >&2
        exit 1
    fi
    printf '%s\n' "${candidates[0]}"
}

load_nested_image() {
    local outer_container="$1"
    local image="$2"
    echo "[local-images] streaming $image into RoboTeam nested Podman"
    podman save "$image" | podman exec --interactive "$outer_container" /usr/bin/podman load
    podman exec "$outer_container" /usr/bin/podman image inspect "$image" >/dev/null
}

outer_container=""
if [ "$target" = desktop ] || [ "$target" = browser ] || [ "$target" = all ]; then
    outer_container="$(robot_runtime_container)"
fi

if [ "$target" = desktop ] || [ "$target" = all ]; then
    build_image "$desktop_image" Dockerfile.workstation
    load_nested_image "$outer_container" "$desktop_image"
fi

if [ "$target" = browser ] || [ "$target" = all ]; then
    build_image "$browser_image" Dockerfile.browser
    load_nested_image "$outer_container" "$browser_image"
fi

if [ "$target" = agent ] || [ "$target" = all ]; then
    build_image "$agent_image" Dockerfile
fi

echo "[local-images] reinstalling roboTeamAgent with local image storage"
/opt/ploinky/bin/ploinky-local reinstall roboTeamAgent
echo "[local-images] installed target '$target' without publishing"
