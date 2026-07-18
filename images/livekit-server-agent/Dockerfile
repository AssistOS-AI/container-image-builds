# Digest-pinned 2026-07-12 via the Docker Hub registry v2 API (anonymous pull
# token flow: GET https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull,
# then GET https://registry-1.docker.io/v2/<repo>/manifests/<tag> with an
# Accept header covering manifest-list/OCI-index media types; digest read
# from the docker-content-digest response header). Each digest below was
# confirmed to be a genuine multi-platform manifest index, not a
# single-platform manifest.
# livekit/livekit-server:v1.11.0
ARG LIVEKIT_SERVER_IMAGE=livekit/livekit-server:v1.11.0@sha256:100b9a870616d02f5e3795b34e0b593b5054a26f8131a94fd3fa322ed3154b16
# No default is permitted. The publication workflow accepts only a verified,
# immutable docker.io/assistos/livekit-egress@sha256:<index> produced by the
# loopback-patched Egress workflow.
ARG LIVEKIT_EGRESS_IMAGE
# node:24-bookworm-slim
ARG NODE_BASE=node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

FROM ${LIVEKIT_SERVER_IMAGE} AS livekit-server

FROM ${NODE_BASE} AS node-runtime

FROM ${LIVEKIT_EGRESS_IMAGE} AS runtime
USER root

# Direct runtime/build packages are version-pinned so a later repository
# update fails visibly instead of silently changing the published image.
# Versions were resolved from the Ubuntu 24.04 repositories on 2026-07-12.
ARG GIT_VERSION=1:2.43.0-1ubuntu7.3
ARG GXX_VERSION=4:13.2.0-7ubuntu1
ARG IPROUTE_VERSION=6.1.0-1ubuntu6.4
ARG LIBC_BIN_VERSION=2.39-0ubuntu8.7
ARG MAKE_VERSION=4.3-4.1build2
ARG NETCAT_VERSION=1.226-1ubuntu2
ARG TINI_VERSION=0.19.0-1
ARG REDIS_VERSION=5:7.0.15-1ubuntu0.24.04.4
ARG UBUNTU_SNAPSHOT=20260712T000000Z

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eu; \
    command -v apt-get >/dev/null 2>&1 || \
        (echo "[liveKitServerAgent] pinned runtime must be Ubuntu/Debian" >&2 && exit 1); \
    rm -f /etc/apt/sources.list.d/google*.list; \
    sed -Ei \
        "s#https?://(archive|security|ports)\\.ubuntu\\.com/ubuntu(-ports)?/?#https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/#g" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    printf '%s\n' 'Acquire::Check-Valid-Until "false";' \
        > /etc/apt/apt.conf.d/99snapshot-valid-until; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "git=${GIT_VERSION}" \
        "g++=${GXX_VERSION}" \
        "iproute2=${IPROUTE_VERSION}" \
        "libc-bin=${LIBC_BIN_VERSION}" \
        "make=${MAKE_VERSION}" \
        "netcat-openbsd=${NETCAT_VERSION}" \
        "tini=${TINI_VERSION}" \
        "redis-server=${REDIS_VERSION}"; \
    rm -rf /var/lib/apt/lists/*

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
    command -v curl >/dev/null 2>&1 || (echo "curl binary missing" >&2 && exit 1); \
    command -v git >/dev/null 2>&1 || (echo "git binary missing" >&2 && exit 1); \
    command -v g++ >/dev/null 2>&1 || (echo "g++ binary missing" >&2 && exit 1); \
    command -v getent >/dev/null 2>&1 || (echo "getent binary missing" >&2 && exit 1); \
    command -v ip >/dev/null 2>&1 || (echo "ip binary missing" >&2 && exit 1); \
    command -v make >/dev/null 2>&1 || (echo "make binary missing" >&2 && exit 1); \
    command -v nc >/dev/null 2>&1 || (echo "nc binary missing" >&2 && exit 1); \
    command -v node >/dev/null 2>&1 || (echo "node binary missing" >&2 && exit 1); \
    command -v npm >/dev/null 2>&1 || (echo "npm binary missing" >&2 && exit 1); \
    command -v redis-server >/dev/null 2>&1 || (echo "redis-server binary missing" >&2 && exit 1); \
    contract=/usr/local/share/ploinky/livekit-egress-loopback.contract; \
    test -f "$contract" && test ! -L "$contract" || \
        (echo "patched Egress v5 contract marker missing" >&2 && exit 1); \
    test "$(stat -c '%u:%g:%a' "$contract")" = '0:0:444' || \
        (echo "patched Egress v5 contract marker ownership or mode is invalid" >&2 && exit 1); \
    test "$(sed -n '1p' "$contract")" = 'contract_version=5'; \
    test "$(sed -n '2p' "$contract")" = 'source_commit=ba52a026bea409bde31dcc7da9ba5322e967520c'; \
    test "$(sed -n '3p' "$contract")" = 'health_listener=127.0.0.1:7981'; \
    test "$(sed -n '4p' "$contract")" = 'template_listener=127.0.0.1:7980'; \
    test "$(wc -l < "$contract")" -eq 5; \
    expected_egress_sha="$(sed -n 's/^binary_sha256=//p' "$contract")"; \
    test "$(printf '%s' "$expected_egress_sha" | wc -c)" -eq 64; \
    printf '%s  %s\n' "$expected_egress_sha" /usr/bin/egress | sha256sum --check --strict -

WORKDIR /code

COPY scripts /code/scripts
RUN chmod +x /code/scripts/start-livekit-server-agent.sh

ENTRYPOINT ["tini", "--"]
CMD ["sh", "/code/scripts/start-livekit-server-agent.sh"]
