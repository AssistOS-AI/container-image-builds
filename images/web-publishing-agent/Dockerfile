ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools
ARG CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:latest

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

FROM ${BASE_IMAGE}

USER root
ENV NODE_ENV=production

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN set -eu; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        nginx \
        openssl; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --system --create-home --home-dir /home/web-publishing --shell /usr/sbin/nologin web-publishing; \
    mkdir -p \
        /code \
        /home/web-publishing/.cloudflared \
        /var/cache/nginx \
        /var/lib/nginx \
        /var/log/nginx; \
    chown -R web-publishing:web-publishing \
        /code \
        /home/web-publishing \
        /var/cache/nginx \
        /var/lib/nginx \
        /var/log/nginx; \
    command -v cloudflared >/dev/null 2>&1; \
    command -v nginx >/dev/null 2>&1; \
    node --version; \
    npm --version; \
    nginx -v; \
    cloudflared --version

WORKDIR /code
EXPOSE 8081
USER web-publishing

CMD ["node", "/code/runtime/supervisor.mjs"]
