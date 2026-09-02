FROM docker.io/library/node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0 AS node-runtime

# Open Interpreter 0.4.3 requires tiktoken 0.7, whose published Linux wheels
# support Python 3.12. Keep the Trixie Git stack and provide the
# official Python runtime instead of introducing distro Python 3.13.
FROM docker.io/library/python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        bash \
        coreutils \
        findutils \
        grep \
        libcap2-bin \
        sed \
        git \
        curl \
        build-essential \
        pkg-config \
    && python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && test ! -e /usr/bin/python3 \
    && test ! -L /usr/bin/python3 \
    && ln -s /usr/local/bin/python3 /usr/bin/python3 \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && /usr/bin/python3 -c 'import sys; assert sys.version_info[:2] == (3, 12)' \
    && node --version && npm --version \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives

# Install the reusable local sandbox runner under a stable image path so research
# provider agents (which use this image as their container base) can invoke the
# runner from inside their own container without depending on a separate Ploinky
# runner agent or MCP hop.
COPY bin/ /opt/bwrap-runner/bin/
COPY lib/ /opt/bwrap-runner/lib/
RUN chmod +x /opt/bwrap-runner/bin/sandbox-exec.mjs \
    && chmod +x /opt/bwrap-runner/bin/healthcheck.mjs \
    && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/bwrap-runner/bin/sandbox-exec.mjs "$@"\n' \
        > /usr/local/bin/bwrap-sandbox-exec \
    && chmod +x /usr/local/bin/bwrap-sandbox-exec

WORKDIR /code
