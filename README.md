# container-image-builds

Central Docker Hub image build definitions for the Ploinky/AssistOS workspace.
This repository owns the Dockerfiles and GitHub Actions workflows that publish
shared runtime images to the `assistos` Docker Hub organization.

## Images

| Image | Source repo | Build context | Dockerfile | Workflow |
| --- | --- | --- | --- | --- |
| `assistos/ploinky-node:24-bookworm-tools` | this repo | `images/ploinky-node` | `images/ploinky-node/Dockerfile` | `publish-ploinky-node-image.yml` |
| `assistos/onlyoffice-agent:9.3.1` | this repo | `images/onlyoffice-agent` | `images/onlyoffice-agent/Dockerfile` | `publish-onlyoffice-agent-image.yml` |
| `assistos/llm-runtime-cpu:cpu-arm64-smoke` | this repo | `images/llm-runtime-cpu` | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-cpu-image.yml` |
| `assistos/default-local-llm:cpu` | `PloinkyRepos/proxies` | `default-local-llm` | `images/default-local-llm/Dockerfile` | `publish-default-local-llm-image.yml` |
| `assistos/bwrap-runner:node24-python-bookworm` | `PloinkyRepos/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `PloinkyRepos/webmeetInfra` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `PloinkyRepos/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |

The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` and build with the Dockerfiles in this repository.

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

gh workflow run publish-onlyoffice-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f onlyoffice_version=9.3.1 \
  -f image_tag=9.3.1

gh workflow run publish-llm-runtime-cpu-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f llama_cpp_ref=b6412 \
  -f image_tag=cpu-arm64-smoke \
  -f platforms=linux/arm64

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
```

`publish-ploinky-node-image.yml` and `publish-onlyoffice-agent-image.yml` also
run on pushes to their image definitions or workflow files. The other publish
workflows stay manual because their build contexts live in separate source
repositories.
