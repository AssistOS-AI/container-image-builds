# container-image-builds

Central Docker Hub image build definitions for the Ploinky/AssistOS workspace.
This repository owns the Dockerfiles and GitHub Actions workflows that publish
shared runtime images to the `assistos` Docker Hub organization.

## Images

| Image | Source repo | Build context | Dockerfile | Workflow |
| --- | --- | --- | --- | --- |
| `assistos/ploinky-node:24-bookworm-tools` | this repo | `images/ploinky-node` | `images/ploinky-node/Dockerfile` | `publish-ploinky-node-image.yml` |
| `assistos/webtty-agent:node24` | this repo | `images/webtty-agent` | `images/webtty-agent/Dockerfile` | `publish-webtty-agent-image.yml` |
| `assistos/onlyoffice-agent:9.3.1` | this repo | `images/onlyoffice-agent` | `images/onlyoffice-agent/Dockerfile` | `publish-onlyoffice-agent-image.yml` |
| `assistos/llm-runtime-cpu:cpu-arm64-smoke` | this repo | `images/llm-runtime-cpu` | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-cpu-image.yml` |
| `assistos/umami-agent:umami-stack` | this repo | `images/umami-agent` | `images/umami-agent/Dockerfile` | `publish-umami-agent-image.yml` |
| `assistos/default-local-llm:cpu-qwen25-coder-1.5b` | `AssistOS-AI/proxies` | `default-local-llm` | `images/default-local-llm/Dockerfile` | `publish-default-local-llm-image.yml` |
| `assistos/bwrap-runner:node24-python-bookworm` | `AssistOS-AI/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `AssistOS-AI/webmeetInfra` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `AssistOS-AI/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |
| `assistos/ploinky-box:runtime` | this repo plus one immutable `AssistOS-AI/ploinky` source commit | repo root; rootless nested-Podman runtime contract `6` with the canonical Ploinky entrypoint and integrated cloudflared | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |

The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` as build inputs. The `ploinky-box` workflow checks
out Ploinky at an exact commit, copies only its canonical contract-6 entrypoint
into the image, and mounts that same source read-only for candidate verification.

The LiveKit workflow accepts only the exact 40-character commit SHA at the
current tip of `webmeetInfra/ploinky-box`. It builds and smoke-tests the local
architecture before authenticating and publishing the multiarchitecture image.
Its three base images are pinned by manifest-list digest, and Ubuntu package
resolution is pinned to a dated repository snapshot with exact direct-package
versions. The pinned `libc-bin` package and both build-time and workflow smoke
gates guarantee that the startup script's `getent` dependency is present.

The LiveKit workflow keeps its stable release tag and
also exposes the pushed multiarchitecture manifest digest as the `publish` job's
`digest` output. Each workflow validates that build output as an exact sha256
digest and writes the resulting `docker.io/assistos/...@sha256:...` reference
to both the log and GitHub job summary. Publishing and pinning consumer
manifests remain separate authorized operations.

## Umami agent supply chain

The Umami Agent build has no source-image, Bun-version, or MCP-revision input.
`images/umami-agent/sources.lock.json` records the reviewed inputs, and focused
tests require the Dockerfile, embedded image metadata, and publication workflow
to agree with that lock.

| Input | Immutable selection | Architecture contract |
| --- | --- | --- |
| Umami | `docker.umami.is/umami-software/umami:3.2.0@sha256:8edfe4beaef13f9d1300619fa264ef250a3688df9cc54d24ca830ca31cb475ec` | The index resolves to `sha256:afbd42695964762c2accf8ed0d863211d764c3937dbba0bf808ba5e33afae763` for `linux/amd64` and `sha256:41c5df65ee777b762411c105f9b040e33708ef8640a19a2d2b9abf3284ee3f37` for `linux/arm64`. |
| Bun | Release `1.3.14` | The build selects the exact x64-musl or aarch64-musl archive and verifies its recorded SHA-256 before extraction. |
| `MadsNyl/umami-mcp` | Commit `3ab73beda2db0ebffb0b07439b218ef562107520` | The build fetches that object directly, checks out detached `FETCH_HEAD`, verifies the resulting commit, and verifies the committed `bun.lock` digest before frozen installation. |

The direct Alpine packages are version-pinned. The built image carries OCI
labels for the base index, Bun version, MCP commit, and MCP lock digest, plus a
read-only copy of the full source lock. The workflow smoke-checks those values,
publishes an amd64/arm64 index with provenance and an SBOM, verifies that both
platform manifests exist, and reports the resulting immutable image digest.
Publishing does not update the consumer manifest; pinning that new output is a
separate reviewed operation.

## Ploinky box runtime contract

`docker.io/assistos/ploinky-box:runtime` is the mutable release channel for
runtime contract 6. The outer appliance supports native rootless Podman only;
it requires `/dev/fuse`, `/dev/net/tun`, the explicit unmask security option,
and no engine socket, privilege, added capabilities, or unconfined seccomp
profile. The image contains Podman, fuse-overlayfs, Node 24, npm/npx, Bash, Git,
cloudflared, and the rootless Netavark/pasta helpers. Ploinky source is mounted
read-only at `/opt/ploinky`; the Dockerfile copies its single canonical
`ploinky-box/entrypoint/ploinky-box-entrypoint` into the image and does not
retain a separate image-repository entrypoint implementation.

The Podman base is pinned to the immutable multiarchitecture Quay OCI index
`quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964`.
The cloudflared source is likewise pinned, and the Dockerfile verifies the exact
architecture-specific binary digest, version 2026.7.1, and `--token-file`
support. Both amd64 and arm64 are built and tested on native runners.

The final image is reconstructed from a prepared Podman filesystem through a
clean `FROM scratch` stage. Its metadata contract is exact:

| Field | Value |
| --- | --- |
| Contract label | `io.assistos.ploinky.runtime-contract=6` |
| User | `podman` |
| Environment | `USER=podman`, `HOME=/home/podman`, `PLOINKY_WORKSPACE_ROOT=/workspace`, `PLOINKY_DISABLE_HOST_SANDBOX=1`, `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent |
| Declared image volumes | Absent |

The outer supervisor mounts retained, identity-scoped named volumes at
`/workspace`, `/opt/ploinky/node_modules`, and
`/home/podman/.local/share/containers`. The first mutating call from a
markerless workspace creates only an empty host `.ploinky` identity anchor so
descendants converge on the same Box. Status is read-only. Stop uses a dedicated
in-box helper and remains available when dependency state is missing or corrupt.
Outer candidate and replacement cleanup includes anonymous volumes while these
three named volumes survive stop, destroy, replacement, and recreation.

First boot generates a mode-restricted workspace master key and installs the
two dependency repositories at the exact commits in Ploinky's additive lock.
The key never crosses from the host, is not printed, and is excluded from nested
agents. It remains stable for the retained workspace-volume lifetime. Manual
key edits and in-place rotation are unsupported; a new key requires a distinct
workspace identity with an empty workspace volume and migration of non-secret
data only.

The Box publishes exactly loopback TCP on the selected host port to Router
`8080` and UDP `7882` to in-box `7882`. The private core listener stays on
loopback `8081` inside the Box and is never published. Custom-port output and
health probes use the external authority while the in-box Router remains on
8080. Entrypoint transport discovery writes the route/address JSON and effective
`host_containers_internal_ip` configuration as one rollback-safe pair.

Contract changes are a hard cut. Stop and explicitly destroy an older Box before
recreation; foreign exact-name containers or volumes are rejected and never
adopted. The entrypoint also rejects retained managed nested containers without
deleting or importing them. Inspect retained named volumes before any manual
recovery, and do not remove them as part of the normal destroy path.

## Ploinky box publication

Manual dispatch requires seven exact 40-character revision inputs:
`source_ref` for Ploinky plus `explorer_ref`, `webmeet_infra_ref`,
`umami_ref`, `achilles_cli_ref`, `proxies_ref`, and `basic_ref`.
The smoke graph stages exactly AssistOSExplorer, webmeetInfra, UmamiAgent,
AchillesCLI, proxies, basic, and container-image-builds; the last repository is
pinned to `GITHUB_SHA`. Ploinky is mounted separately at `/opt/ploinky` and
is not an eighth graph repository. Every checkout must be canonical, clean, and
at the supplied immutable SHA.

Each native architecture job runs all top-level image tests across
`.test.js`, `.test.mjs`, and `.test.cjs`; all Ploinky Box units; the local
core parity suite through `ploinky-local`; native lifecycle integration; the
pinned-graph smoke; and installed-package public CLI E2E. The lifecycle tests
use one candidate digest. The public CLI test has no image override: a generated
mode-0700 rootless-Podman proxy rewrites only the fixed logical runtime pull and
read-only inspect calls to that candidate and records a NUL-safe trace. Candidate
blobs are pushed by immutable digest only, and the gated digest and proxy trace
are uploaded only after every functional gate passes.

The merge job requires both architecture attestations and both proxy traces,
proves the run-scoped
`runtime-candidate-GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT` tag is unused, and creates
a staging manifest from the two exact gated digests. It annotates and inspects
that manifest, requires exactly the gated amd64 and arm64 members, records its
immutable digest, and moves `runtime` by that exact staging digest. Only
read-only digest confirmation follows promotion. The staging tag is retained as
provenance, workflow concurrency prevents competing promotion, and publication
remains a separately authorized operation.

## Secrets

Each publishing workflow logs in to Docker Hub as `assistos` and requires:

```sh
gh secret set DOCKERHUB_TOKEN --repo AssistOS-AI/container-image-builds
```

If the source repositories are private to the Actions runner, also configure a
read-only token that can check them out:

```sh
gh secret set SOURCE_REPO_TOKEN --repo AssistOS-AI/container-image-builds
```

Do not store Docker Hub token values in repository files.

## Manual Publishing

```sh
gh workflow run publish-ploinky-node-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=24-bookworm-tools

gh workflow run publish-webtty-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=node24

gh workflow run publish-onlyoffice-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f onlyoffice_version=9.3.1 \
  -f image_tag=9.3.1

gh workflow run publish-llm-runtime-cpu-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f llama_cpp_ref=b6412 \
  -f image_tag=cpu-arm64-smoke \
  -f platforms=linux/arm64

gh workflow run publish-default-local-llm-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=cpu-qwen25-coder-1.5b \
  -f model_repo=bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF \
  -f model_file=Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf

gh workflow run publish-umami-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=umami-stack

gh workflow run publish-bwrap-runner.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main \
  -f image_tag=node24-python-bookworm

gh workflow run publish-livekit-server-agent.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../webmeetInfra rev-parse HEAD)" \
  -f image_tag=webmeet-infra

gh workflow run publish-soul-gateway-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main \
  -f image_tag=node24-sqlite

gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../ploinky rev-parse HEAD)" \
  -f explorer_ref="$(git -C ../AssistOSExplorer rev-parse HEAD)" \
  -f webmeet_infra_ref="$(git -C ../webmeetInfra rev-parse HEAD)" \
  -f umami_ref="$(git -C ../UmamiAgent rev-parse HEAD)" \
  -f achilles_cli_ref="$(git -C ../AchillesCLI rev-parse HEAD)" \
  -f proxies_ref="$(git -C ../proxies rev-parse HEAD)" \
  -f basic_ref="$(git -C ../basic rev-parse HEAD)"
```

WebTTY publication is a two-step hard cut. The workflow accepts only the
reviewed immutable `ploinky-node` base and emits a root-owned byte-contract
marker. After the multi-architecture index is published and inspected, update
the consumer manifest to that exact index digest. Until then, the consumer's
required `/usr/local/bin/webtty-start` entrypoint makes the previous pinned
image fail before opening its listener; no mutable-tag fallback is permitted.

`runtime` is intentionally mutable, but an already-created Ploinky Box stays on
its inspected image ID. The supervisor consults the channel only when creating
a missing Box or performing a validated current-contract replacement. Contract
or configuration drift is rejected before mutation and requires an explicit
destroy followed by recreate. Moving the release channel to a different
verified contract-6 manifest digest is a separately authorized registry release
action, never a supervisor transaction; the channel must not point to an older
contract. Reuse, status, stop, and destroy do not pull the channel.

`publish-ploinky-node-image.yml`, `publish-webtty-agent-image.yml`, and
`publish-onlyoffice-agent-image.yml` also run on pushes to their image
definitions or workflow files. The other publish workflows stay manual because
their build contexts live in separate source repositories.
