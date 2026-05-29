ARG LIVEKIT_SERVER_IMAGE=livekit/livekit-server:v1.11.0
ARG LIVEKIT_EGRESS_IMAGE=livekit/egress:v1.9.1
ARG NODE_BASE=node:24-bookworm-slim

FROM ${LIVEKIT_SERVER_IMAGE} AS livekit-server

FROM ${NODE_BASE} AS node-runtime

FROM ${LIVEKIT_EGRESS_IMAGE} AS runtime
USER root

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eu; \
    if command -v apt-get >/dev/null 2>&1; then \
        rm -f /etc/apt/sources.list.d/google*.list; \
        apt-get update; \
        apt-get install -y --no-install-recommends \
            ca-certificates \
            curl \
            git \
            g++ \
            make \
            netcat-openbsd \
            python3 \
            tini \
            redis-server \
            coturn \
            nginx \
            certbot; \
        rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then \
        apk add --no-cache \
            ca-certificates \
            curl \
            git \
            g++ \
            make \
            netcat-openbsd \
            python3 \
            tini \
            redis \
            coturn \
            nginx \
            certbot; \
    else \
        echo "[liveKitServerAgent] unsupported base image package manager" >&2; \
        exit 1; \
    fi

COPY --from=livekit-server /livekit-server /usr/local/bin/livekit-server
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
COPY --from=node-runtime /usr/local/share/man/man1/node.1 /usr/local/share/man/man1/node.1
RUN set -eu; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

RUN set -eu; \
    command -v egress >/dev/null 2>&1 || (echo "egress binary missing" >&2 && exit 1); \
    command -v livekit-server >/dev/null 2>&1 || (echo "livekit-server binary missing" >&2 && exit 1); \
    command -v git >/dev/null 2>&1 || (echo "git binary missing" >&2 && exit 1); \
    command -v g++ >/dev/null 2>&1 || (echo "g++ binary missing" >&2 && exit 1); \
    command -v make >/dev/null 2>&1 || (echo "make binary missing" >&2 && exit 1); \
    command -v nc >/dev/null 2>&1 || (echo "nc binary missing" >&2 && exit 1); \
    command -v node >/dev/null 2>&1 || (echo "node binary missing" >&2 && exit 1); \
    command -v npm >/dev/null 2>&1 || (echo "npm binary missing" >&2 && exit 1); \
    command -v python3 >/dev/null 2>&1 || (echo "python3 binary missing" >&2 && exit 1); \
    command -v redis-server >/dev/null 2>&1 || (echo "redis-server binary missing" >&2 && exit 1); \
    command -v turnserver >/dev/null 2>&1 || (echo "turnserver binary missing" >&2 && exit 1); \
    command -v nginx >/dev/null 2>&1 || (echo "nginx binary missing" >&2 && exit 1); \
    command -v certbot >/dev/null 2>&1 || (echo "certbot binary missing" >&2 && exit 1)

WORKDIR /code

COPY scripts /code/scripts
RUN chmod +x /code/scripts/start-livekit-server-agent.sh \
    /code/scripts/health/livekit-server-agent-health.sh

ENTRYPOINT ["tini", "--"]
CMD ["sh", "/code/scripts/start-livekit-server-agent.sh"]
