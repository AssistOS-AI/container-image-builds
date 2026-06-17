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

# Bake the GGUF to the exact path the launcher checks:
#   $PLOINKY_MODELS_DIR/<repo with / -> __>/<revision>/<file>
RUN safe_repo="$(printf '%s' "$MODEL_REPO" | sed 's#/#__#g')" \
    && target="${PLOINKY_MODELS_DIR}/${safe_repo}/${MODEL_REVISION}" \
    && mkdir -p "$target" \
    && hf download "$MODEL_REPO" "$MODEL_FILE" --revision "$MODEL_REVISION" --local-dir "$target" \
    && test -f "$target/$MODEL_FILE"

CMD ["bash"]
