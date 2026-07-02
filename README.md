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
| `docker.io/assistos/llm-runtime:cpu-amd64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:cpu-arm64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:nvidia-amd64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-nvidia-amd64/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:nvidia-spark-arm64-sm121` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-nvidia-spark-arm64-sm121/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:amd-rocm-amd64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-amd-rocm-amd64/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:vulkan-amd64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-vulkan-amd64/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:vulkan-arm64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-vulkan-arm64/Dockerfile` | `publish-llm-runtime-images.yml` |
| `docker.io/assistos/llm-runtime:intel-amd64` | `AssistOS-AI/llm-runtime` | this repo plus `shared/runtime-agent` source checkout | `images/llm-runtime-intel-amd64/Dockerfile` | `publish-llm-runtime-images.yml` |
| `assistos/umami-agent:umami-stack` | this repo | `images/umami-agent` | `images/umami-agent/Dockerfile` | `publish-umami-agent-image.yml` |
| `assistos/default-local-llm:cpu` | `AssistOS-AI/proxies` | `default-local-llm` | `images/default-local-llm/Dockerfile` | `publish-default-local-llm-image.yml` |
| `assistos/bwrap-runner:node24-python-bookworm` | `AssistOS-AI/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `AssistOS-AI/webmeetInfra` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `AssistOS-AI/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |

The `bwrap-runner` and `livekit-server-agent` workflows check out their source
repositories under `sources/` and build with the Dockerfiles in this repository.
The `llm-runtime` workflow also checks out `AssistOS-AI/llm-runtime` under
`sources/llm-runtime` so each runtime image Dockerfile can copy
`sources/llm-runtime/shared/runtime-agent` into `/opt/ploinky/runtime-agent`.

LLM runtime images publish under one Docker Hub namespace,
`docker.io/assistos/llm-runtime`, with hardware-specific tags. Each image
includes the runtime MCP server, `hf`, bash, curl, jq, Python 3, tini,
inspection utilities, the standard `/workspace/modelLaunchers`, `/models/*`,
and `/runtime` directories, and `/opt/ploinky/engineVersions.lock.json`. They
enter through `tini -- node /opt/ploinky/runtime-agent/mcp-server.mjs`;
engines are selected and launched by runtime requests, not by container boot.
Every image declares the full runtime env, volume, and expose contract through
`HF_HOME`, `PLOINKY_MODELS_DIR`, `PLOINKY_DERIVED_DIR`,
`PLOINKY_RUNTIME_DIR`, `PLOINKY_LAUNCHERS_DIR`,
`PLOINKY_MCP_PORT=9000`, `PLOINKY_INFERENCE_PORT=8080`,
`EXPOSE 9000 8080`, and the `/workspace`, `/models`, and `/runtime` volumes.

Every LLM runtime Dockerfile must copy its sibling `engineVersions.lock.json`
to `/opt/ploinky/engineVersions.lock.json`. The single
`publish-llm-runtime-images.yml` matrix owns all hardware tags, validates the
checked-out runtime source for the clean `PLOINKY_LAUNCHERS_DIR`
`/workspace/modelLaunchers` contract, and smoke-tests the CPU image with mounted
runtime state by checking the MCP health endpoint, the lockfile, launcher
directory, Hugging Face CLI, and absence of pre-started engine processes.

| Tag | Engine stack |
| --- | --- |
| `cpu-amd64`, `cpu-arm64` | llama.cpp CPU under `/opt/engines/llamacpp` |
| `nvidia-amd64` | CUDA llama.cpp plus vLLM, SGLang, and TensorRT-LLM virtual environments under `/opt/engines` |
| `nvidia-spark-arm64-sm121` | sm_121 CUDA llama.cpp plus Spark-targeted SGLang and TensorRT-LLM virtual environments; no vLLM claim |
| `amd-rocm-amd64` | ROCm llama.cpp plus vLLM/SGLang ROCm environments and Vulkan fallback metadata |
| `vulkan-amd64`, `vulkan-arm64` | llama.cpp Vulkan with CPU fallback under `/opt/engines/llamacpp` |
| `intel-amd64` | OpenVINO Model Server under `/opt/engines/openvino` plus llama.cpp CPU/Vulkan support |

Runtime lockfiles use `schemaVersion`, `imageId`, `platform`,
`supportedEngines`, `lockfilePath`, and only the version pins relevant to the
installed engines: `llamaCppCommit`, `vllmVersion`, `sglangVersion`,
`tensorRtLlmVersion`, `openvinoModelServerVersion`, `cudaVersion`,
`rocmVersion`, `pythonVersion`, `nodeVersion`, and `nodeDistSha256`.
GPU runtime images install Node.js from official release tarballs and verify
the tarball SHA256 recorded in the image lockfile.

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

gh workflow run publish-llm-runtime-images.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main

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
```

`publish-ploinky-node-image.yml`, `publish-webtty-agent-image.yml`,
`publish-onlyoffice-agent-image.yml`, and `publish-llm-runtime-images.yml` also
run on pushes to their image definitions or workflow files. The remaining
publish workflows stay manual because their build contexts live in separate
source repositories.
