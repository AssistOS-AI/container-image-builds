ARG NODE_BASE=node:24-bookworm-slim
FROM ${NODE_BASE}

ARG LLAMA_CPP_REF=b6412
ARG LLAMA_BUILD_JOBS=1

ENV DEBIAN_FRONTEND=noninteractive
ENV HF_HOME=/models/hf-cache
ENV PLOINKY_MODELS_DIR=/models/artifacts
ENV PLOINKY_DERIVED_DIR=/models/derived
ENV PLOINKY_RUNTIME_DIR=/runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        cmake \
        curl \
        git \
        g++ \
        jq \
        libcurl4-openssl-dev \
        make \
        procps \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/hf-cli \
    && /opt/hf-cli/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hf-cli/bin/pip install --no-cache-dir huggingface_hub \
    && ln -s /opt/hf-cli/bin/hf /usr/local/bin/hf

RUN git clone --depth 1 --branch "${LLAMA_CPP_REF}" https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp \
    && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_NATIVE=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_CURL=ON \
    && cmake --build /tmp/llama.cpp/build --target llama-server --config Release -j"${LLAMA_BUILD_JOBS}" \
    && install -m 0755 /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
    && find /tmp/llama.cpp/build/bin -maxdepth 1 -type f -name '*.so*' -exec install -m 0755 {} /usr/local/lib/ \; \
    && ldconfig \
    && rm -rf /tmp/llama.cpp

RUN mkdir -p /opt/ploinky/launchers /models/hf-cache /models/artifacts /models/derived /runtime

CMD ["bash"]
