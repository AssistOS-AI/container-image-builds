# Both defaults are multi-platform manifest indexes resolved from Docker Hub on
# 2026-07-13. Keeping the tag alongside the digest documents the release while
# the digest makes registry resolution immutable.
ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:95ec6e79245cf6a193b3cdd95b0f7a329edf938f1bdf29e7f4fe361df784cdea
ARG CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:2026.7.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

FROM ${BASE_IMAGE}

USER root
ENV NODE_ENV=production
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ARG DEBIAN_SNAPSHOT=20260712T000000Z
ARG CA_CERTIFICATES_VERSION=20230311+deb12u1
ARG NGINX_VERSION=1.22.1-9+deb12u9
ARG OPENSSL_VERSION=3.0.20-1~deb12u2

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN set -eu; \
    grep -qx 'VERSION_CODENAME=bookworm' /etc/os-release || \
        (echo "web-publishing-agent base must be Debian Bookworm" >&2 && exit 1); \
    rm -f \
        /etc/apt/sources.list \
        /etc/apt/sources.list.d/*.list \
        /etc/apt/sources.list.d/*.sources; \
    printf '%s\n' \
        "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
        > /etc/apt/sources.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        "ca-certificates=${CA_CERTIFICATES_VERSION}" \
        "nginx=${NGINX_VERSION}" \
        "openssl=${OPENSSL_VERSION}"; \
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
