FROM docker.umami.is/umami-software/umami:3.2.0@sha256:8edfe4beaef13f9d1300619fa264ef250a3688df9cc54d24ca830ca31cb475ec

ARG TARGETARCH

LABEL org.opencontainers.image.base.name="docker.umami.is/umami-software/umami:3.2.0"
LABEL org.opencontainers.image.base.digest="sha256:8edfe4beaef13f9d1300619fa264ef250a3688df9cc54d24ca830ca31cb475ec"
LABEL io.assistos.umami.version="3.2.0"
LABEL io.assistos.bun.version="1.3.14"
LABEL io.assistos.umami-mcp.revision="3ab73beda2db0ebffb0b07439b218ef562107520"
LABEL io.assistos.umami-mcp.bun-lock.sha256="92e41e798c3593657116f461377d92e8b74dbcf605f279e6e1832dbcfd0aa46f"

USER root

ENV BUN_INSTALL=/opt/bun
ENV UMAMI_MCP_DIR=/opt/umami-mcp
ENV PATH=/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/umami-agent-sources.json

RUN set -eux; \
    apk add --no-cache \
        'bash=5.3.9-r1' \
        'ca-certificates=20260611-r0' \
        'curl=8.21.0-r0' \
        'git=2.54.0-r0' \
        'postgresql18=18.4-r0' \
        'postgresql18-client=18.4-r0' \
        'postgresql18-contrib=18.4-r0' \
        'su-exec=0.3-r0' \
        'unzip=6.0-r16'; \
    case "${TARGETARCH:-$(apk --print-arch)}" in \
        amd64|x86_64) \
            bun_asset='bun-linux-x64-musl.zip'; \
            bun_dir='bun-linux-x64-musl'; \
            bun_sha256='14bd9aedeebf1dba67e8def9531c89bc989ecfdf1de42e5bfcaf1b8cd9294719' \
            ;; \
        arm64|aarch64) \
            bun_asset='bun-linux-aarch64-musl.zip'; \
            bun_dir='bun-linux-aarch64-musl'; \
            bun_sha256='b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb' \
            ;; \
        *) \
            echo "unsupported Umami Agent build architecture: ${TARGETARCH:-$(apk --print-arch)}" >&2; \
            exit 1 \
            ;; \
    esac; \
    mkdir -p "${BUN_INSTALL}/bin" /tmp/bun; \
    curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
        --output /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/${bun_asset}"; \
    printf '%s  %s\n' "${bun_sha256}" /tmp/bun.zip | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 "/tmp/bun/${bun_dir}/bun" "${BUN_INSTALL}/bin/bun"; \
    test "$(bun --version)" = '1.3.14'; \
    git init "${UMAMI_MCP_DIR}"; \
    git -C "${UMAMI_MCP_DIR}" remote add origin https://github.com/MadsNyl/umami-mcp.git; \
    git -C "${UMAMI_MCP_DIR}" fetch --no-tags origin 3ab73beda2db0ebffb0b07439b218ef562107520; \
    git -C "${UMAMI_MCP_DIR}" checkout --detach FETCH_HEAD; \
    test "$(git -C "${UMAMI_MCP_DIR}" rev-parse HEAD)" = '3ab73beda2db0ebffb0b07439b218ef562107520'; \
    printf '%s  %s\n' \
        '92e41e798c3593657116f461377d92e8b74dbcf605f279e6e1832dbcfd0aa46f' \
        "${UMAMI_MCP_DIR}/bun.lock" | sha256sum -c -; \
    cd "${UMAMI_MCP_DIR}"; \
    bun install --frozen-lockfile; \
    bun run build; \
    test -f dist/index.js; \
    rm -rf .git /root/.bun /tmp/*

RUN test -f /app/server.js \
    && test -f /app/scripts/update-tracker.js \
    && test -f "${UMAMI_MCP_DIR}/dist/index.js" \
    && test "$(bun --version)" = '1.3.14' \
    && test "$(postgres --version | cut -d ' ' -f 3)" = '18.4'

WORKDIR /code
