# default-local-llm image: node (for AgentServer) + llama.cpp llama-server (built
# from a pinned source tag) + a baked Qwen2.5-1.5B GGUF (offline at runtime).
ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools
FROM ${BASE_IMAGE}

ARG MODEL_REPO=Qwen/Qwen2.5-1.5B-Instruct-GGUF
ARG MODEL_FILE=qwen2.5-1.5b-instruct-q4_k_m.gguf
ARG MODEL_REVISION=main
ARG LLAMA_CPP_TAG=b4519

ENV LLAMA_MODEL_PATH=/opt/models/${MODEL_FILE}

# Build llama-server from a pinned tag, then strip build deps.
# GGML_NATIVE=OFF is REQUIRED for this distributed image: the build runner's CPU is
# not the deployment CPU, and a -mcpu=native build silently miscomputes (degenerate
# garbage output) on a different host. OFF builds portable kernels with runtime dispatch.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git cmake build-essential libcurl4-openssl-dev ca-certificates curl; \
    git clone --depth 1 --branch "${LLAMA_CPP_TAG}" https://github.com/ggml-org/llama.cpp /tmp/llama.cpp; \
    cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_SERVER=ON -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF; \
    cmake --build /tmp/llama.cpp/build --target llama-server -j "$(nproc)"; \
    install -m 0755 /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server; \
    rm -rf /tmp/llama.cpp; \
    apt-get purge -y git cmake build-essential libcurl4-openssl-dev; \
    apt-get autoremove -y; \
    apt-get install -y --no-install-recommends libgomp1; \
    rm -rf /var/lib/apt/lists/*

# Bake the GGUF (offline at runtime).
RUN set -eux; \
    mkdir -p /opt/models; \
    curl -fL "https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}" -o "/opt/models/${MODEL_FILE}"; \
    test -f "/opt/models/${MODEL_FILE}"

CMD ["bash"]
