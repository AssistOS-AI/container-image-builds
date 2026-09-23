FROM docker.io/assistos/ploinky-node:24-trixie-tools@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669
# local-llm agent runtime: the pinned llama.cpp CUDA 12.8 release build and the
# pinned Ollama release on the Ploinky Node base. amd64 only, because the pinned
# CUDA builds exist only for x86-64. The NVIDIA driver libraries and nvidia-smi
# are not part of the image: a Ploinky Box GPU grant binds them read-only under
# /usr/local/nvidia at runtime. No model weights are ever part of the image.
ARG TARGETARCH
# Optional plain-HTTP mirror of the exact release assets (for local builds on a
# slow link). The sha256 checks pin the bytes whatever the source.
ARG RELEASE_MIRROR=
USER root
RUN set -eu; \
    test "${TARGETARCH:-amd64}" = amd64; \
    llama=b11125; ollama=0.34.3; \
    fetch() { \
        name=$1; url=$2; sha=$3; \
        if [ -n "$RELEASE_MIRROR" ]; then url="$RELEASE_MIRROR/$name"; fi; \
        curl -fsSL --retry 5 --retry-all-errors -o "/tmp/$name" "$url"; \
        printf '%s  %s\n' "$sha" "/tmp/$name" | sha256sum --check --strict -; \
    }; \
    fetch "llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        "https://github.com/ggml-org/llama.cpp/releases/download/$llama/llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        fedb8e04a0e6eb11e7f0687e02e778e848d1a2ddbf1ca835c6c6fb0a7853cf5f; \
    fetch "cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        "https://github.com/ggml-org/llama.cpp/releases/download/$llama/cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        038f3591191e489723bc4a0199af21b0a74ab5bdf2241f0296247967f671fcf5; \
    fetch ollama-linux-amd64.tar.zst \
        "https://github.com/ollama/ollama/releases/download/v$ollama/ollama-linux-amd64.tar.zst" \
        e83a089fd0cd2f79ee2933cca2085846a2065f497adbc6467c402177c68423f9; \
    mkdir -p /opt/llama.cpp /opt/ollama /opt/local-llm; \
    tar -xzf "/tmp/llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" -C /opt/llama.cpp --strip-components=1 --no-same-owner; \
    tar -xzf "/tmp/cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" -C /opt/llama.cpp --strip-components=1 --no-same-owner; \
    node -e "process.stdin.pipe(require('node:zlib').createZstdDecompress()).pipe(process.stdout)" \
        < /tmp/ollama-linux-amd64.tar.zst | tar -x -C /opt/ollama --no-same-owner; \
    rm -f /tmp/*.tar.gz /tmp/*.tar.zst; \
    chown -R root:root /opt/llama.cpp /opt/ollama /opt/local-llm; \
    chmod -R go-w /opt/llama.cpp /opt/ollama; \
    /opt/llama.cpp/llama-server --version 2>&1 | grep -q "build 11125,"; \
    /opt/ollama/bin/ollama --version 2>&1 | grep -q "version is $ollama"; \
    printf 'llama_cpp=%s\nllama_cpp_cuda=12.8\nollama=%s\n' "$llama" "$ollama" > /opt/local-llm/source.contract; \
    chmod 0444 /opt/local-llm/source.contract
# llama.cpp and its CUDA backend find their own libraries through RUNPATH
# $ORIGIN, and Ollama points its runner at its own library directories, so the
# shared library path holds only the granted driver libraries.
ENV PATH=/usr/local/nvidia/bin:/opt/llama.cpp:/opt/ollama/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64
# Ploinky prefixes the image entrypoint to the agent command; keep it neutral.
ENTRYPOINT []
CMD ["node"]
USER 1000:1000
