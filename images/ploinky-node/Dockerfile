ARG NODE_BASE=node:24-bookworm-slim
FROM ${NODE_BASE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        ffmpeg \
        git \
        g++ \
        make \
        openssh-client \
        python3 \
    && rm -rf /var/lib/apt/lists/*
