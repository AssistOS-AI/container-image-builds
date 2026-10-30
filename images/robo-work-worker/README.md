# RoboWork worker image

Runtime image for the RoboWork worker (`assistos/robo-work-worker:runtime`). It is not published from this definition until a reviewed publication is dispatched.

## Contents

| Component | Source |
| --- | --- |
| Base | `docker.io/library/fedora:44` by index digest (see `sources.lock.json`) |
| Node 24 and npm | copied from the digest-pinned `assistos/ploinky-node:24-bookworm-tools`, the same source as `roboteam-agent` |
| Bubblewrap | unchanged Fedora package at `/usr/bin/bwrap`; the smoke script requires 0.11 or newer and checks that `bwrap --help` lists `--args`, `--bind-fd`, `--ro-bind-fd`, `--disable-userns`, `--assert-userns-disabled`, `--block-fd`, `--info-fd`, `--json-status-fd`, `--seccomp`, `--hostname` and `--unshare-cgroup-try` |
| Namespace tools | util-linux (`setpriv`, `unshare`, `nsenter`, `mount`), iproute2, nftables |
| Shell and utilities | `bash` (`/bin/sh` is bash), git, curl, ca-certificates, ripgrep 15.1.0 (pinned checksum, as in `roboteam-agent`) |
| Coding agents | `@openai/codex`, `@anthropic-ai/claude-code`, `opencode-ai` with `@opencode-ai/plugin`, `@earendil-works/pi-coding-agent`, installed with `npm ci` from `agent-tools/package-lock.json` into `/opt/robo-work-tools` |
| Terminal PTY | Ploinky's immutable node-pty build copied from the pinned `assistos/ploinky-box` index at `/usr/local/lib/ploinky/webtty` (the location `core-services/webtty/native-runtime.mjs` expects); no native build happens here |

## Deliberate omissions

Podman, fuse-overlayfs and pasta are omitted: the `roboteam-agent` GUI recipe needs them, the v1 worker does not. There is no Rust, FUSE helper, file server or compiler.

## ALA

`roboteam-agent` does not bake AdvancedLanguageAgent; it arrives from the Ploinky workspace checkout through the manifest link-install. The worker does the same. The reviewed pin is AdvancedLanguageAgent `cf2996dcf22465d5ed408a0e93aec2ca59f1f91b`, recorded in `sources.lock.json`.

## Runtime identity

The container runs as root because the supervisor requires it. Robots run as uid 1000 inside Bubblewrap.

## Coding-agent versions

`roboteam-agent` resolves coding agents at run time into a cache. The worker pins exact versions and the lock hashes instead; changing one means rebuilding and adopting a new image.

## Smoke

`podman run --rm <image>` runs `smoke-worker.mjs`, which prints tool versions, checks the Bubblewrap version and flags, confirms the omitted binaries are absent, and runs the node-pty `native-probe --verify` as uid 1000.

## Local build behind slow IPv6

The Dockerfile sets `ip_resolve=4` for dnf, `--ipv4` for curl and `--dns-result-order=ipv4first` for Node/npm. Use `podman build --layers`.
