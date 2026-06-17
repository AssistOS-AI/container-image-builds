# base-local image: llama.cpp runtime + a baked GGUF so the launcher's
# `prepare` step is a cache hit (no runtime network).
ARG BASE_IMAGE=docker.io/assistos/llm-runtime-cpu:cpu-arm64-smoke
FROM ${BASE_IMAGE}

ARG MODEL_REPO=Qwen/Qwen2.5-1.5B-Instruct-GGUF
ARG MODEL_FILE=qwen2.5-1.5b-instruct-q4_k_m.gguf
ARG MODEL_REVISION=main

# The launcher reads these to locate/serve the model; set them so the baked
# file is exactly what start/prepare expect.
ENV LLAMA_CPP_DEFAULT_REPO=${MODEL_REPO}
ENV LLAMA_CPP_DEFAULT_FILE=${MODEL_FILE}
ENV LLAMA_CPP_DEFAULT_REVISION=${MODEL_REVISION}
ENV PLOINKY_MODEL_SEED_DIR=/opt/ploinky/model-seed

# Bake the GGUF into a seed dir OUTSIDE /models. The runtime bind-mounts a host
# volume over /models, which would shadow a model baked under it; the launcher's
# prepare step copies from this seed dir into the model cache (no network).
RUN safe_repo="$(printf '%s' "$MODEL_REPO" | sed 's#/#__#g')" \
    && safe_rev="$(printf '%s' "$MODEL_REVISION" | sed 's#/#__#g')" \
    && target="${PLOINKY_MODEL_SEED_DIR}/${safe_repo}/${safe_rev}" \
    && mkdir -p "$target" \
    && hf download "$MODEL_REPO" "$MODEL_FILE" --revision "$MODEL_REVISION" --local-dir "$target" \
    && test -f "$target/$MODEL_FILE"

CMD ["bash"]
