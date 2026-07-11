# container-image-builds

Central Docker Hub image build definitions for the Ploinky/AssistOS workspace.
This repository owns the Dockerfiles and GitHub Actions workflows that publish
shared runtime images to the `assistos` Docker Hub organization.

## Images

| Image | Source repo | Build context | Dockerfile | Workflow |
| --- | --- | --- | --- | --- |
| `assistos/ploinky-node:24-bookworm-tools` | this repo | `images/ploinky-node` | `images/ploinky-node/Dockerfile` | `publish-ploinky-node-image.yml` |
| `assistos/webtty-agent:node24` | this repo | `images/webtty-agent` | `images/webtty-agent/Dockerfile` | `publish-webtty-agent-image.yml` |
| `assistos/cloudflared-agent:node24-cloudflared` | this repo | `images/cloudflared-agent` | `images/cloudflared-agent/Dockerfile` | `publish-cloudflared-agent-image.yml` |
| `assistos/web-publishing-agent:node24-nginx-cloudflared` | this repo | `images/web-publishing-agent` | `images/web-publishing-agent/Dockerfile` | `publish-web-publishing-agent-image.yml` |
| `assistos/onlyoffice-agent:9.3.1` | this repo | `images/onlyoffice-agent` | `images/onlyoffice-agent/Dockerfile` | `publish-onlyoffice-agent-image.yml` |
| `assistos/llm-runtime-cpu:cpu-arm64-smoke` | this repo | `images/llm-runtime-cpu` | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-cpu-image.yml` |
| `assistos/umami-agent:umami-stack` | this repo | `images/umami-agent` | `images/umami-agent/Dockerfile` | `publish-umami-agent-image.yml` |
| `assistos/default-local-llm:cpu-qwen25-coder-1.5b` | `AssistOS-AI/proxies` | `default-local-llm` | `images/default-local-llm/Dockerfile` | `publish-default-local-llm-image.yml` |
| `assistos/bwrap-runner:node24-python-bookworm` | `AssistOS-AI/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `AssistOS-AI/webmeetInfra` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `AssistOS-AI/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |
| `assistos/ploinky-box:runtime` | this repo; one immutable `AssistOS-AI/ploinky` commit is mounted for verification | repo root; source-free nested-Podman runtime contract `2` | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |

The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` as build inputs. The `ploinky-box` workflow checks
out Ploinky source only for bind-mounted verification; the published runtime
image remains source-free.

## Ploinky box runtime contract

`docker.io/assistos/ploinky-box:runtime` is the mutable release channel for
runtime contract 2. The image contains Podman, Node 24, npm/npx, Bash, Git, and
the rootless networking helpers. Ploinky source is not baked into the image; the
outer supervisor mounts it read-only at `/opt/ploinky` and mounts writable named
volumes at `/workspace`, `/opt/ploinky/node_modules`, and
`/home/podman/.local/share/containers`.

The final image is reconstructed from a prepared Podman filesystem through a
clean `FROM scratch` stage. Its contract metadata is exact:

| Field | Value |
| --- | --- |
| Contract label | `io.assistos.ploinky.runtime-contract=2` |
| User | `podman` |
| Environment | `USER=podman`, `HOME=/home/podman`, `PLOINKY_WORKSPACE_ROOT=/workspace`, `PLOINKY_DISABLE_HOST_SANDBOX=1`, `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent or empty |
| Declared image volumes | Absent or empty |

The entrypoint validates its identity, mounts, devices, helper privileges,
subordinate UID/GID mappings, and nested Podman before becoming ready. It first
resets only the Podman user's ephemeral run directories left by the prior outer
process; persistent container records, images, and volumes remain in the named
storage volume. On every outer-box boot it then removes running and stopped
nested containers carrying this exact ownership label:

```text
io.assistos.ploinky.managed=1
```

It does not use an all-container selector. Unlabelled containers, labels with
another value or key, nested images, and nested named volumes remain untouched.
Enumeration or removal failure stops the entrypoint with a diagnostic instead
of continuing with ambiguous nested state.

Ordinary Ploinky destroy/recreate preserves the outer nested-storage volume. If
corrupt nested state prevents boot, inspect and back up that volume before
manual recovery. Removing it deletes the cached nested images, container
records, and nested volumes it contains:

```sh
ENGINE=podman # or docker, matching the owning outer runtime
INSTANCE=ploinky-box-WORKSPACE-PATHHASH

$ENGINE volume inspect "$INSTANCE-containers"
$ENGINE rm -f "$INSTANCE" 2>/dev/null || true
$ENGINE volume rm "$INSTANCE-containers"
```

The next permitted create reconstructs that one volume. Do not use this as the
normal destroy path, and do not remove it until its retained data is understood.

## Ploinky box publication

The publication workflow resolves `source_ref` once to a full Ploinky commit
SHA. Native `linux/amd64` and `linux/arm64` jobs check out that same SHA, push
untagged candidates by digest, and independently gate exact metadata, mounted
source/dependency installation, rootless mappings, nested Alpine execution,
selective cleanup, failure diagnostics, and nested image/volume preservation.

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

gh workflow run publish-cloudflared-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=node24-cloudflared

gh workflow run publish-web-publishing-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=node24-nginx-cloudflared

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
  -f source_ref=main \
  -f image_tag=webmeet-infra

gh workflow run publish-soul-gateway-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main \
  -f image_tag=node24-sqlite

gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=ploinky-box
```

`runtime` is intentionally mutable, but already-created compatible Ploinky
boxes stay on their inspected image ID. The channel is consulted only when the
supervisor creates or intentionally replaces an outer box. Rollback moves
`runtime` to a previously verified contract-2 manifest digest; it never points
the channel back to contract 1.

`publish-ploinky-node-image.yml`, `publish-webtty-agent-image.yml`,
`publish-cloudflared-agent-image.yml`, `publish-web-publishing-agent-image.yml`,
and `publish-onlyoffice-agent-image.yml` also run on pushes to their image
definitions or workflow files. The other publish workflows stay manual because
their build contexts live in separate source repositories.
