ARG CUDA_BASE=nvidia/cuda:12.8.1-devel-ubuntu24.04
FROM ${CUDA_BASE}

ARG CUDA_VERSION=12.8.1
ARG LLAMA_CPP_COMMIT=a885dcff11a7b73f9377812d6151f6b15d307de0
ARG LLAMA_BUILD_JOBS=1
ARG SGLANG_VERSION=0.4.6.post1
ARG TENSORRT_LLM_VERSION=0.20.0
ARG HF_HUB_VERSION=0.33.2
ARG NODE_VERSION=24.4.1
ARG NODE_DIST_ARCH=arm64
ARG NODE_DIST_SHA256=555659c36fc72d0617e278b5d26ffcaebc3760a3de354926b1e5f1b0bfd66083

LABEL org.assistos.llm-runtime.image-id="llm-runtime-nvidia-spark-arm64-sm121" \
      org.assistos.llm-runtime.supported-engines="llamacpp-cuda-sm121,sglang,trtllm" \
      org.assistos.llm-runtime.platform="linux/arm64" \
      org.assistos.llm-runtime.lockfile="/opt/ploinky/engineVersions.lock.json"

ENV DEBIAN_FRONTEND=noninteractive
ENV HF_HOME=/models/hf-cache
ENV PLOINKY_MODELS_DIR=/models/artifacts
ENV PLOINKY_DERIVED_DIR=/models/derived
ENV PLOINKY_RUNTIME_DIR=/runtime
ENV PLOINKY_LAUNCHERS_DIR=/workspace/modelLaunchers
ENV PLOINKY_MCP_PORT=9000
ENV PLOINKY_INFERENCE_PORT=8080
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

EXPOSE 9000 8080
VOLUME ["/workspace", "/models", "/runtime"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        cmake \
        curl \
        file \
        git \
        g++ \
        iproute2 \
        jq \
        libcurl4-openssl-dev \
        lsof \
        make \
        netcat-openbsd \
        pciutils \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        tini \
        usbutils \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_DIST_ARCH}.tar.xz" \
    && echo "${NODE_DIST_SHA256}  node-v${NODE_VERSION}-linux-${NODE_DIST_ARCH}.tar.xz" | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-${NODE_DIST_ARCH}.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-${NODE_DIST_ARCH}.tar.xz" \
    && node --version

RUN python3 -m venv /opt/hf-cli \
    && /opt/hf-cli/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hf-cli/bin/pip install --no-cache-dir "huggingface_hub==${HF_HUB_VERSION}" \
    && if [ -x /opt/hf-cli/bin/hf ]; then \
        ln -s /opt/hf-cli/bin/hf /usr/local/bin/hf; \
      else \
        ln -s /opt/hf-cli/bin/huggingface-cli /usr/local/bin/hf; \
      fi \
    && ln -s /usr/local/bin/hf /usr/local/bin/huggingface-cli

RUN mkdir -p \
        /opt/engines/llamacpp/bin \
        /opt/engines/sglang \
        /opt/engines/trtllm \
        /workspace/modelLaunchers \
        /models/hf-cache \
        /models/artifacts \
        /models/derived \
        /runtime

RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git /opt/engines/llamacpp/src \
    && git -C /opt/engines/llamacpp/src fetch --depth 1 origin "${LLAMA_CPP_COMMIT}" \
    && git -C /opt/engines/llamacpp/src checkout FETCH_HEAD \
    && cmake -S /opt/engines/llamacpp/src -B /opt/engines/llamacpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_CUDA=ON \
        -DGGML_NATIVE=OFF \
        -DCMAKE_CUDA_ARCHITECTURES=121 \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_CURL=ON \
    && cmake --build /opt/engines/llamacpp/build --target llama-server --config Release -j"${LLAMA_BUILD_JOBS}" \
    && install -m 0755 /opt/engines/llamacpp/build/bin/llama-server /opt/engines/llamacpp/bin/llama-server \
    && ln -s /opt/engines/llamacpp/bin/llama-server /usr/local/bin/llama-server \
    && ldconfig \
    && rm -rf /opt/engines/llamacpp/src/.git

RUN python3 -m venv /opt/engines/sglang/venv \
    && /opt/engines/sglang/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/engines/sglang/venv/bin/pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu128 "sglang[all]==${SGLANG_VERSION}"

RUN python3 -m venv /opt/engines/trtllm/venv \
    && /opt/engines/trtllm/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/engines/trtllm/venv/bin/pip install --no-cache-dir --extra-index-url https://pypi.nvidia.com "tensorrt_llm==${TENSORRT_LLM_VERSION}"

COPY sources/llm-runtime/shared/runtime-agent/ /opt/ploinky/runtime-agent/
COPY images/llm-runtime-nvidia-spark-arm64-sm121/engineVersions.lock.json /opt/ploinky/engineVersions.lock.json

WORKDIR /opt/ploinky/runtime-agent

ENTRYPOINT ["tini", "--", "node", "/opt/ploinky/runtime-agent/mcp-server.mjs"]
