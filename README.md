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
| `assistos/ploinky-box:runtime` | this repo plus one immutable `AssistOS-AI/ploinky` source commit | repo root; rootless nested-Podman appliance with the canonical Ploinky entrypoint and integrated cloudflared | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |

The `bwrap-runner` workflow checks out exact full-SHA `basic`, `copilot-agents`,
and `AchillesCLI` inputs under `sources/`; the latter two supply the Open
Interpreter and GPTResearcher consumer gates. Those two SHAs are explicitly
prepublication consumer-code inputs: they contain the ABI/disposition adapters
while retaining the existing privileged declarations and mutable image
references. The workflow neither requires nor creates the later digest-pin and
privilege-removal commits, so publication remains the input to those consumer
changes rather than depending on them. The `livekit-server-agent`
workflow also checks out its source repository under `sources/`. The
`ploinky-box` workflow checks
out Ploinky at an exact commit, copies only its canonical Box entrypoint
into the image, and publishes native architecture images by immutable digest.

The LiveKit workflow accepts only the exact 40-character commit SHA at the
current tip of `webmeetInfra/ploinky-proxy`. It builds and smoke-tests the local
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

## Bubblewrap runner publication

`publish-bwrap-runner.yml` accepts only exact 40-character commits for the
runner source and both consumer-source gates. There is no branch/ref fallback.
The consumer SHAs are evidence-only prepublication code selections, recorded as
`prepublication-code-only`; they do not authorize or perform manifest pinning.
Native `ubuntu-24.04` amd64 and `ubuntu-24.04-arm` jobs each build and push one
architecture by digest without moving the stable tag. Each job requires
rootless Podman and runs the digest with all capabilities dropped,
`no-new-privileges`, no host namespace options, and no unconfined profile. It
records the image's effective UID/GID, capability and namespace state, SUID
inventory, Bubblewrap mode/file capabilities, platform, pinned base image,
workflow/action identity, and every exact source commit.

The native gate has no skip path. It executes both private- and empty-proc
production policies, the canonical healthcheck, and a representative staged
runner task with network disabled and filesystem write confinement. Separate
consumer gates prepare Open Interpreter with installation-only network access,
then require its networkless terminal
`PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE` disposition, and perform a real
GPTResearcher cold install in a networked container followed by import,
UI/readiness, and lightweight task-adapter checks in a separate networkless
container over the same persisted install. Installation egress is not
task-time network authority.

Only after both architecture jobs upload their digest and evidence artifacts
does the assemble job create a run-scoped candidate index from exactly those
two digests and verify exact `linux/amd64` and `linux/arm64` membership. The
candidate digest is always reported. The `node24-python-bookworm` convenience
tag moves only when dispatch explicitly sets `promote_stable=true`, and only
after all prior gates; no behavioral check occurs after promotion. Consumer
manifests must use the recorded `docker.io/assistos/bwrap-runner@sha256:...`
identity, never the convenience tag. The compatibility runner intentionally
retains privilege until this native proof exists and its later consumer update
pins the approved digest. The workflow uploads both per-architecture proof
directories and an assembled candidate evidence artifact containing the exact
index, source identities, member digests, base image, workflow run, and
multiarchitecture digest.

## Ploinky Box runtime

`docker.io/assistos/ploinky-box:runtime` is the mutable release channel for
the outer appliance. It supports native rootless Podman only;
it requires `/dev/fuse`, `/dev/net/tun`, the explicit unmask security option,
and no engine socket, privilege, added capabilities, or unconfined seccomp
profile. The image contains Podman, fuse-overlayfs, Node 24, npm/npx, Bash, Git,
SSH, curl, ffmpeg, Python 3, process/namespace tools, cloudflared, and the
rootless Netavark/pasta helpers. Its explicit interactive-shell baseline also
includes deterministic GNU text and file tools (`find`, `grep`, `sed`, `awk`,
`diff`, `patch`), JSON and transfer tools (`jq`, `wget`, `rsync`), common
archive utilities, `less`, `file`, `which`, `tree`, `nano`/`vi`, and network
diagnostics (`ss`, `ping`, `dig`, `host`, `nslookup`, `nc`, `netstat`, `lsof`).
The Dockerfile requires every advertised command during both native builds.
Ploinky source is mounted
read-only at `/opt/ploinky`; the Dockerfile copies its single canonical
`ploinky-box/entrypoint/ploinky-box-entrypoint` into the image and does not
retain a separate image-repository entrypoint implementation.

The Podman base is pinned to the immutable multiarchitecture Quay OCI index
`quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964`.
The cloudflared source is likewise pinned, and the Dockerfile verifies the exact
architecture-specific binary digest, version 2026.7.1, and `--token-file`
support. Both amd64 and arm64 are built on native runners.

The final image is reconstructed from a prepared Podman filesystem through a
clean `FROM scratch` stage. Its metadata is exact:

| Field | Value |
| --- | --- |
| Image labels | None |
| Marker | `/etc/ploinky-box` contains exactly `assistos/ploinky-box` followed by one newline |
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
`host_containers_internal_ip` configuration as one rollback-safe pair. Neither
runtime-owned file is present in the immutable image, including any
`containers.conf` inherited from the pinned Podman base.

Runtime-definition changes are a hard cut. Stop and explicitly destroy an
incompatible Box before recreation; foreign exact-name containers or volumes
are rejected and never adopted. The entrypoint also rejects retained managed
nested containers without deleting or importing them. Inspect retained named
volumes before any manual recovery, and do not remove them as part of the normal
destroy path.

## Ploinky box publication

Manual dispatch requires one exact 40-character Ploinky commit in `source_ref`.
The workflow verifies that immutable source checkout and its own image-definition
checkout are clean and at the requested revisions. It performs no behavioral,
unit, integration, E2E, Podman, or sibling-repository test execution.

Each native architecture job builds and pushes one image blob by immutable
digest, validates the digest format, and uploads only that digest as publication
evidence. The merge job requires exactly one amd64 digest and one arm64 digest,
proves the run-scoped
`runtime-candidate-GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT` tag is unused, and creates
a staging manifest from those two exact digests. It annotates and inspects
that manifest, requires exactly the supplied amd64 and arm64 members, records its
immutable digest, and moves `runtime` by that exact staging digest. Only
read-only digest confirmation follows promotion. The staging tag is retained as
provenance, workflow concurrency prevents competing promotion, and functional
validation remains separate from this publication-only workflow.

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
  -f source_ref="$(git -C ../basic rev-parse HEAD)" \
  -f copilot_agents_ref="$(git -C ../copilot-agents rev-parse HEAD)" \
  -f achilles_cli_ref="$(git -C ../AchillesCLI rev-parse HEAD)" \
  -f promote_stable=false

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
  -f source_ref="$(git -C ../ploinky rev-parse HEAD)"
```

WebTTY publication is a two-step hard cut. The workflow accepts only the
reviewed immutable `ploinky-node` base and emits a root-owned byte-contract
marker. After the multi-architecture index is published and inspected, update
the consumer manifest to that exact index digest. Until then, the consumer's
required `/usr/local/bin/webtty-start` entrypoint makes the previous pinned
image fail before opening its listener; no mutable-tag fallback is permitted.

`runtime` is intentionally mutable, but an already-created Ploinky Box stays on
its inspected image ID. The supervisor consults the channel only when creating
a missing Box or performing a validated replacement. Image or configuration
drift is rejected before mutation and requires an explicit destroy followed by
recreate. Moving the release channel to a different verified manifest digest is
a separately authorized registry release action, never a supervisor
transaction; the channel must not point to an incompatible image. Reuse,
status, stop, and destroy do not pull the channel.

`publish-ploinky-node-image.yml`, `publish-webtty-agent-image.yml`, and
`publish-onlyoffice-agent-image.yml` also run on pushes to their image
definitions or workflow files. The other publish workflows stay manual because
their build contexts live in separate source repositories.
