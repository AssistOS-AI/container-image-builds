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
| `assistos/ploinky-box:runtime` | this repo; one immutable `AssistOS-AI/ploinky` commit is mounted for verification | repo root; source-free nested-Podman runtime contract `5` with integrated cloudflared | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |

The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` as build inputs. The `ploinky-box` workflow checks
out Ploinky source only for bind-mounted verification; the published runtime
image remains source-free.

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
runtime contract 5. The image contains Podman, Node 24, npm/npx, Bash, Git,
cloudflared, and the rootless networking helpers. Ploinky source is not baked into the image; the
outer supervisor mounts it read-only at `/opt/ploinky` and mounts writable named
volumes at `/workspace`, `/opt/ploinky/node_modules`, and
`/home/podman/.local/share/containers`.

The Podman base is pinned to the immutable multiarchitecture Quay OCI index
`quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964`.
The official index contains native `linux/amd64` and `linux/arm64` manifests;
both identify Podman 5.8.2. The publication matrix rebuilds and exercises both
architectures natively instead of trusting that registry metadata alone.

The final image is reconstructed from a prepared Podman filesystem through a
clean `FROM scratch` stage. Its contract metadata is exact:

| Field | Value |
| --- | --- |
| Contract label | `io.assistos.ploinky.runtime-contract=5` |
| User | `podman` |
| Environment | `USER=podman`, `HOME=/home/podman`, `PLOINKY_WORKSPACE_ROOT=/workspace`, `PLOINKY_DISABLE_HOST_SANDBOX=1`, `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent or empty |
| Declared image volumes | Absent or empty |

The integrated cloudflared binary comes from the immutable multiarchitecture
`cloudflare/cloudflared:2026.7.1` OCI index. The Dockerfile verifies the exact
amd64 or arm64 binary SHA-256, executable status, version, and real
`--token-file` support; the entrypoint rechecks the version and option before
reporting healthy. It does not start a connector. Ploinky core selects explicit
local-only or configured Cloudflare mode and supervises the connector.

The entrypoint validates its identity, mounts, devices, helper privileges,
Podman 5.4 or newer, rootless state, Netavark selection, pasta availability,
exactly 65,534 subordinate UIDs/GIDs, and exact 65,535-ID active mappings before
becoming ready. The mapping covers inner root plus UIDs/GIDs through 65,534. It first
resets only the Podman user's ephemeral run directories left by the prior outer
process; persistent container records, images, and volumes remain in the named
storage volume. Before becoming ready it enumerates, but never removes or
imports, nested containers carrying this exact ownership label:

```text
io.assistos.ploinky.managed=1
```

Any match makes startup fail with an explicit operator-recreate diagnostic.
The old box must be quiesced and its managed containers removed explicitly
before the contract-5 destroy/recreate boundary. Unlabelled containers, labels
with another value or key, nested images, and nested named volumes remain
untouched. Enumeration failure also stops the entrypoint rather than
continuing with ambiguous nested state.

Ordinary Ploinky destroy/recreate preserves the outer nested-storage volume. If
corrupt nested state prevents boot, inspect and back up that volume before
manual recovery. Removing it deletes the cached nested images, container
records, and nested volumes it contains:

```sh
ENGINE=podman # contract 5 requires a rootless outer Podman engine
INSTANCE=ploinky-box-WORKSPACE-PATHHASH

$ENGINE volume inspect "$INSTANCE-containers"
$ENGINE rm -f "$INSTANCE" 2>/dev/null || true
$ENGINE volume rm "$INSTANCE-containers"
```

The next permitted create reconstructs that one volume. Do not use this as the
normal destroy path, and do not remove it until its retained data is understood.

## Ploinky box publication

The publication workflow requires `source_ref` to be an exact 40-character
Ploinky commit SHA. Native `linux/amd64` and `linux/arm64` jobs check out that
same SHA and first prove that its exported required runtime contract is exactly
`5`. The selected source hard-cut, network-contract, network-lifecycle,
documentation, and supervisor suites must pass before an image is built. The
supervisor suite includes contract-4 rejection before mutation.

Each native job pushes an untagged candidate by digest and independently gates
exact metadata, mounted source/dependency installation, a rootless outer Podman
launch, the exact two physical-host publications, and the managed rootless
network topology. Each
native gate records Podman, Netavark, Aardvark-DNS, and pasta versions. The
checked-out Ploinky network lifecycle creates the persisted schema-2 bridges
with its production naming and labels. After explicit outer destroy/recreate,
the same lifecycle must recognize those exact bridges as reusable and must
create and verify default and multi-bridge agent containers through its managed
transaction. The gate does not hand-copy the production hosts arguments or
network identity labels.

The native gate seeds gateway-era managed containers, manual containers,
images, nested named-volume data, and sentinel data in all three outer volumes.
It removes the managed containers in an explicit operator step before the
destroy/recreate boundary, then proves manual/data preservation and
Ploinky-driven schema-2 network reuse. A separate gate proves that contract 5 rejects
retained managed containers without deleting or importing them. It starts the
actual RoutingServer with fixed public/control `8080`, strict private `8081`,
and Unix-socket detailed health. Lifecycle-created managed agents must have
exactly one `host.containers.internal` entry, reach private `8081`, and reach
public Router `8080` only for allowed agent surfaces while an unauthenticated
status/control request is denied; the same gate also proves same-network traffic,
isolated-bridge denial, egress, loopback-only box-service denial, and unchanged
networks across Router restart. On the currently observed rootless Podman
host-gateway topology, strict private-listener startup cannot acquire an
approved managed-interface bind, so this native publication lane remains
release-blocked pending Ploinky DS004 Question #8. It must not widen the bind or
install a forwarding fallback to pass. Managed-state enumeration failure is a
separate fail-closed gate.
The runtime gates use only `--user podman`, `/dev/fuse`, `/dev/net/tun`, and
`--security-opt unmask=ALL`. They do not use privilege, added capabilities, or
an unconfined seccomp profile. Ploinky adds `label=disable` only when an SELinux
host requires it.

Each job uploads its digest only after every native gate passes. The merge job
requires exactly two nonempty, distinct digest artifacts before atomically
moving the sole public tag, `runtime`, to their multiarchitecture manifest. It
then prints the final manifest digest and verified source SHA. Workflow-level
concurrency prevents two dispatches from racing the mutable channel.

Publication remains a separately authorized operation. A failed candidate job
can leave untagged registry content, but it cannot move `:runtime`.

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
  -f source_ref="$(git -C ../ploinky rev-parse HEAD)"
```

WebTTY publication is a two-step hard cut. The workflow accepts only the
reviewed immutable `ploinky-node` base and emits a root-owned byte-contract
marker. After the multi-architecture index is published and inspected, update
the consumer manifest to that exact index digest. Until then, the consumer's
required `/usr/local/bin/webtty-start` entrypoint makes the previous pinned
image fail before opening its listener; no mutable-tag fallback is permitted.

`runtime` is intentionally mutable, but an already-created Ploinky box stays on
its inspected image ID. The supervisor consults the channel only when creating
a missing outer box after an explicit destroy. Any contract or configuration
drift is rejected before mutation and requires an explicit destroy followed by
recreate; the supervisor never stops, renames, replaces, restores, or rolls back
an existing box. Moving the release channel back to a previously verified
contract-5 manifest digest is a separately authorized registry release action,
never a supervisor transaction, and the channel must not point to an older
contract.

`publish-ploinky-node-image.yml`, `publish-webtty-agent-image.yml`, and
`publish-onlyoffice-agent-image.yml` also run on pushes to their image
definitions or workflow files. The other publish workflows stay manual because
their build contexts live in separate source repositories.
