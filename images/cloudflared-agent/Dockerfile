ARG CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:latest
ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

FROM ${BASE_IMAGE}

USER root
ENV NODE_ENV=production

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN set -eu; \
    command -v cloudflared >/dev/null 2>&1; \
    cloudflared --version; \
    node --version; \
    npm --version

WORKDIR /code
CMD ["node", "/code/runtime/cloudflared-supervisor.mjs"]
