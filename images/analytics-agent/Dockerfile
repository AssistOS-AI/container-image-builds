ARG UMAMI_BASE_IMAGE=docker.umami.is/umami-software/umami:postgresql-latest
FROM ${UMAMI_BASE_IMAGE}

USER root

ENV BUN_INSTALL=/opt/bun
ENV UMAMI_MCP_DIR=/opt/umami-mcp
ENV PATH=/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        git \
        postgresql \
        postgresql-client \
        postgresql-contrib \
        su-exec \
        unzip \
    && mkdir -p /opt \
    && curl -fsSL https://bun.sh/install | bash \
    && git clone --depth 1 https://github.com/MadsNyl/umami-mcp.git "${UMAMI_MCP_DIR}" \
    && cd "${UMAMI_MCP_DIR}" \
    && bun install --frozen-lockfile \
    && bun run build \
    && rm -rf /root/.bun /tmp/*

RUN test -f /app/server.js \
    && test -f /app/scripts/update-tracker.js \
    && test -f "${UMAMI_MCP_DIR}/dist/index.js" \
    && postgres --version \
    && bun --version

WORKDIR /code
