FROM docker.io/nvidia/cuda@sha256:38ce689230907646c84d57c37653259f8a021ba8c1b1525fa2a0d9654cc895e0 AS ik-builder
# ik_llama.cpp publishes no release binaries, so it is built here from a pinned
# commit (runners plan, R6 = a) with CUDA 12.8.2, the toolchain of the pinned
# llama.cpp release build (nvidia/cuda:12.8.2-devel-ubuntu24.04, linux/amd64).
# Kernels for Ampere and Ada consumer GPUs only (sm_86, sm_89): the full
# llama.cpp architecture list does not build within the workflow's time limit.
# CPU code targets AVX2 with FMA and F16C, never the build machine's CPU.
# RUNPATH finds ik's own libraries next to the binary and the CUDA runtime
# libraries in /opt/llama.cpp (the same CUDA 12.8 release), so the image does
# not carry a second copy of cuBLAS. libggml.so links the driver library
# libcuda.so.1, which only the Box GPU grant provides, so the link allows it
# to be missing here (as ik's own CI does).
ARG IK_COMMIT=20f7a72edd7049fe5a87eef2b5e9a50ae109ca4b
ARG IK_CUDA_ARCHITECTURES=86-real;89-real
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git cmake ninja-build; \
    rm -rf /var/lib/apt/lists/*; \
    git init -q /src; \
    cd /src; \
    git remote add origin https://github.com/ikawrakow/ik_llama.cpp.git; \
    git fetch --depth 1 origin "$IK_COMMIT"; \
    git checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$IK_COMMIT"; \
    cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$IK_CUDA_ARCHITECTURES" \
        -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
        -DGGML_NCCL=OFF -DGGML_IQK_FA_ALL_QUANTS=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
        -DCMAKE_INSTALL_RPATH='$ORIGIN:$ORIGIN/../llama.cpp' -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
        -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined; \
    cmake --build /build --target llama-server -j "$(nproc)"; \
    mkdir /out; \
    cp /build/bin/llama-server /out/; \
    find /build -name '*.so' -type f -exec cp {} /out/ \; ; \
    mkdir /tmp/stub; \
    ln -s /usr/local/cuda/lib64/stubs/libcuda.so /tmp/stub/libcuda.so.1; \
    LD_LIBRARY_PATH=/tmp/stub:/usr/local/cuda/lib64 /out/llama-server --version > /tmp/ik-version 2>&1; \
    grep -q "($(printf %.7s "$IK_COMMIT")" /tmp/ik-version

FROM docker.io/assistos/ploinky-node:24-trixie-tools@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669
# local-llm agent runtime: the pinned llama.cpp CUDA 12.8 release build, the
# pinned Ollama release and ik_llama.cpp built above, on the Ploinky Node base.
# amd64 only, because the pinned CUDA builds exist only for x86-64. The NVIDIA
# driver libraries and nvidia-smi are not part of the image: a Ploinky Box GPU
# grant binds them read-only under /usr/local/nvidia at runtime. No model
# weights are ever part of the image.
ARG TARGETARCH
# Optional plain-HTTP mirror of the exact release assets (for local builds on a
# slow link). The sha256 checks pin the bytes whatever the source.
ARG RELEASE_MIRROR=
USER root
COPY --from=ik-builder /out/ /opt/ik_llama.cpp/
RUN set -eu; \
    test "${TARGETARCH:-amd64}" = amd64; \
    llama=b11159; ollama=0.34.4; ik=20f7a72edd7049fe5a87eef2b5e9a50ae109ca4b; \
    fetch() { \
        name=$1; url=$2; sha=$3; \
        if [ -n "$RELEASE_MIRROR" ]; then url="$RELEASE_MIRROR/$name"; fi; \
        curl -fsSL --retry 5 --retry-all-errors -o "/tmp/$name" "$url"; \
        printf '%s  %s\n' "$sha" "/tmp/$name" | sha256sum --check --strict -; \
    }; \
    fetch "llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        "https://github.com/ggml-org/llama.cpp/releases/download/$llama/llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        5840b0f87ec10400d7eea2f36138a45ddd9bdd6a794eb81d20a7f150d09c66bd; \
    fetch "cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        "https://github.com/ggml-org/llama.cpp/releases/download/$llama/cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" \
        f79ae034d707096f825be4b512366253950d3fa4895921a8c2577d4271ff8a18; \
    fetch ollama-linux-amd64.tar.zst \
        "https://github.com/ollama/ollama/releases/download/v$ollama/ollama-linux-amd64.tar.zst" \
        c238986e61d40c0cc5f4a9b9e40b9eea104350b77efa34741fc134e105cb9533; \
    mkdir -p /opt/llama.cpp /opt/ollama /opt/local-llm; \
    tar -xzf "/tmp/llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" -C /opt/llama.cpp --strip-components=1 --no-same-owner; \
    tar -xzf "/tmp/cudart-llama-$llama-bin-ubuntu-cuda-12.8-x64.tar.gz" -C /opt/llama.cpp --strip-components=1 --no-same-owner; \
    node -e "process.stdin.pipe(require('node:zlib').createZstdDecompress()).pipe(process.stdout)" \
        < /tmp/ollama-linux-amd64.tar.zst | tar -x -C /opt/ollama --no-same-owner; \
    rm -f /tmp/*.tar.gz /tmp/*.tar.zst; \
    test -x /opt/ik_llama.cpp/llama-server; \
    chown -R root:root /opt/llama.cpp /opt/ollama /opt/ik_llama.cpp /opt/local-llm; \
    chmod -R go-w /opt/llama.cpp /opt/ollama /opt/ik_llama.cpp; \
    /opt/llama.cpp/llama-server --version 2>&1 | grep -q "build 11159,"; \
    /opt/ollama/bin/ollama --version 2>&1 | grep -q "version is $ollama"; \
    printf 'llama_cpp=%s\nllama_cpp_cuda=12.8\nollama=%s\nik_llama_cpp=%s\nik_llama_cpp_cuda=12.8\n' "$llama" "$ollama" "$ik" > /opt/local-llm/source.contract; \
    chmod 0444 /opt/local-llm/source.contract
# On-demand runners (runners plan §5.2): the pinned uv that rebuilds each
# runner's environment offline from its verified cache, and /opt/runners, where
# uid 1000 builds the runnable copies in the container's own filesystem. Triton,
# which vLLM and ExLlamaV3 load, compiles a small C launcher at run time, so the
# image carries a C compiler and the Python headers. PyTorch and the runners
# themselves never enter the image.
RUN set -eu; \
    uv=0.12.18; \
    apt-get update; \
    apt-get install -y --no-install-recommends gcc libc6-dev libpython3.13-dev; \
    rm -rf /var/lib/apt/lists/*; \
    name="uv-x86_64-unknown-linux-gnu.tar.gz"; \
    url="https://github.com/astral-sh/uv/releases/download/$uv/$name"; \
    if [ -n "$RELEASE_MIRROR" ]; then url="$RELEASE_MIRROR/$name"; fi; \
    curl -fsSL --retry 5 --retry-all-errors -o "/tmp/$name" "$url"; \
    printf '%s  %s\n' 89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16 "/tmp/$name" | sha256sum --check --strict -; \
    tar -xzf "/tmp/$name" -C /usr/local/bin --strip-components=1 --no-same-owner uv-x86_64-unknown-linux-gnu/uv; \
    rm -f "/tmp/$name"; \
    chown root:root /usr/local/bin/uv; \
    chmod 0755 /usr/local/bin/uv; \
    /usr/local/bin/uv --version 2>&1 | grep -q "uv $uv"; \
    install -d -o 1000 -g 1000 -m 0755 /opt/runners; \
    chmod u+w /opt/local-llm/source.contract; \
    printf 'uv=%s\n' "$uv" >> /opt/local-llm/source.contract; \
    chmod 0444 /opt/local-llm/source.contract
# The only runners that can be installed on demand, and the only files they may
# download: admins choose a runner id, never a URL.
COPY --chmod=0444 runners.lock.json /opt/local-llm/runners.lock.json
# llama.cpp and its CUDA backend find their own libraries through RUNPATH
# $ORIGIN, ik_llama.cpp through RUNPATH $ORIGIN and /opt/llama.cpp, and Ollama
# points its runner at its own library directories, so the shared library path
# holds only the granted driver libraries. Both servers are named llama-server;
# the agent calls each by its absolute path, and only llama.cpp is on PATH.
ENV PATH=/usr/local/nvidia/bin:/opt/llama.cpp:/opt/ollama/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64
# Ploinky prefixes the image entrypoint to the agent command; keep it neutral.
ENTRYPOINT []
CMD ["node"]
USER 1000:1000
