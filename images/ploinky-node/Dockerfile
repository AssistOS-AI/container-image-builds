FROM docker.io/library/node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        curl \
        ffmpeg \
        git \
        g++ \
        make \
        openssh-client \
        python3 \
    && rm -rf /var/lib/apt/lists/*

USER 1000:1000
