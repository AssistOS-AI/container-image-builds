ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim
ARG ONLYOFFICE_BASE_IMAGE=docker.io/onlyoffice/documentserver:9.3.1

FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

FROM ${ONLYOFFICE_BASE_IMAGE}

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        g++ \
        git \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version \
    && npm --version \
    && git --version \
    && python3 --version \
    && make --version
