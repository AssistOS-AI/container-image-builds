FROM docker.io/library/node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS node-base

FROM docker.umami.is/umami-software/umami:3.4.1@sha256:e69d1a7932e9dab0fc523edc7be1f3a53f3c261f57856fc2167ae74a8fc022e8 AS umami-geo

FROM docker.io/library/postgres:18.6-alpine3.24@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395 AS postgres-base

FROM node-base AS umami-build

USER root
WORKDIR /build
ENV NODE_ENV=development \
    BASE_PATH=/base-agent-additional-server/umamiAgent/3000 \
    SKIP_BUILD_GEO=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://user:pass@localhost:5432/dummy

COPY sources.lock.json /tmp/umami-sources.lock.json
COPY verify-build.mjs /tmp/verify-umami-build.mjs
COPY patch-login-query-cache.mjs patch-metadata-assets.mjs verify-login-query-cache.mjs /tmp/

# pnpm 12 is a native executable. Its checksum-pinned musl package is the only package-manager input.
RUN set -eux; \
    test "$(node --version)" = 'v22.23.4'; \
    test "$(cat /etc/alpine-release)" = '3.24.4'; \
    case "$(uname -m)" in \
      x86_64) pnpm_package='exe.linux-x64-musl'; pnpm_sha256='4ac4e7fb80b3ba4ffb0e443adab5539de7581d5da0f29501859b30785731aa0e' ;; \
      aarch64) pnpm_package='exe.linux-arm64-musl'; pnpm_sha256='085f6389c412105dbe18a4209ac35a2b355e85744cd5b846970bc21faa49a22c' ;; \
      *) echo "unsupported Umami build architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    wget --quiet --output-document=/tmp/pnpm.tgz "https://registry.npmjs.org/@pnpm/${pnpm_package}/-/${pnpm_package}-12.3.4.tgz"; \
    printf '%s  %s\n' "$pnpm_sha256" /tmp/pnpm.tgz | sha256sum -c -; \
    mkdir -p /opt/umami-build-tools/pnpm; \
    tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/umami-build-tools/pnpm; \
    chmod 0755 /opt/umami-build-tools/pnpm/pnpm; \
    ln -s /opt/umami-build-tools/pnpm/pnpm /usr/local/bin/pnpm; \
    test "$(pnpm --version)" = '12.3.4'

RUN set -eux; \
    wget --quiet --output-document=/tmp/umami-source.tar.gz https://codeload.github.com/umami-software/umami/tar.gz/559e3c607c23d2c72d9bd4f6481bda428255323c; \
    printf '%s  %s\n' '0f84d93ba311c6e6d2ea87dc6d2a72506798a8cc0ffec39f725bad62eff17630' /tmp/umami-source.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/umami-source.tar.gz --strip-components=1 -C /build; \
    node /tmp/verify-umami-build.mjs source /build /tmp/umami-sources.lock.json; \
    node /tmp/patch-metadata-assets.mjs /build /tmp/umami-sources.lock.json

# Upstream's own image supplies GeoLite2; the build only copies and re-checks its bytes.
COPY --from=umami-geo /app/geo/GeoLite2-City.mmdb /build/geo/GeoLite2-City.mmdb

RUN set -eux; \
    printf '%s  %s\n' '3c884a441b2ab41ba01c4f99b1c9551a610de4d2e4b8f66e797c6a844c7d767b' /build/geo/GeoLite2-City.mmdb | sha256sum -c -; \
    cp docker/proxy.ts src/proxy.ts; \
    printf 'strictDepBuilds: false\n' >> pnpm-workspace.yaml; \
    pnpm install --frozen-lockfile; \
    node /tmp/verify-umami-build.mjs engines /build /tmp/umami-sources.lock.json; \
    node /tmp/verify-login-query-cache.mjs /build /tmp/umami-sources.lock.json

RUN set -eux; \
    NODE_ENV=production pnpm build:docker; \
    pnpm prune --prod; \
    mkdir /out; \
    cp -a .next/standalone/. /out/; \
    rm -rf /out/node_modules /out/packages /out/public /out/scripts /out/prisma /out/generated /out/geo /out/.next/static; \
    cp -a node_modules packages public scripts prisma prisma.config.ts generated geo package.json pnpm-lock.yaml pnpm-workspace.yaml /out/; \
    cp -a .next/static /out/.next/static; \
    cp .next/required-server-files.json /out/.next/required-server-files.json; \
    cp ploinky-umami-source-patches.json /out/; \
    node /tmp/verify-umami-build.mjs seal /out /tmp/umami-sources.lock.json /build

# The runtime keeps the PostgreSQL image's root filesystem but none of its image configuration
# (entrypoint, volume, stop signal, PGDATA, locale), which would change how the agent starts it.
FROM scratch

COPY --from=postgres-base / /

USER root
LABEL org.opencontainers.image.base.name="docker.io/library/postgres:18.6-alpine3.24"
LABEL org.opencontainers.image.base.digest="sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395"
LABEL io.assistos.umami.base.node="docker.io/library/node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202"
LABEL io.assistos.umami.base.geo="docker.umami.is/umami-software/umami:3.4.1@sha256:e69d1a7932e9dab0fc523edc7be1f3a53f3c261f57856fc2167ae74a8fc022e8"
LABEL io.assistos.umami.version="3.4.1"
LABEL io.assistos.umami.source.revision="559e3c607c23d2c72d9bd4f6481bda428255323c"
LABEL io.assistos.umami.source.modified="true"
LABEL io.assistos.umami.base-path="/base-agent-additional-server/umamiAgent/3000"
LABEL io.assistos.umami.pnpm-lock.sha256="d1661e1e1ceadd01dd2328e27c5b04d9e30dd168b875a343b4a5f42001ad5028"
LABEL io.assistos.umami.alpine.release="3.24.4"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS= \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    BASE_PATH=/base-agent-additional-server/umamiAgent/3000

# Node, npm and the libraries Node links against come from the Node image of the same Alpine release.
COPY --from=node-base /etc/alpine-release /tmp/node-alpine-release
RUN set -eux; \
    cmp /etc/alpine-release /tmp/node-alpine-release; \
    test "$(cat /etc/alpine-release)" = '3.24.4'; \
    rm -f /tmp/node-alpine-release
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node-base /usr/lib/libstdc++.so.6.0.34 /usr/lib/libgcc_s.so.1 /usr/lib/
RUN set -eux; \
    ln -sf libstdc++.so.6.0.34 /usr/lib/libstdc++.so.6; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -s gosu /usr/local/bin/su-exec; \
    addgroup -g 1000 node; \
    adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=umami-build --chown=1000:1000 /out/ /app/
RUN mkdir -p /usr/local/share/ploinky \
    && chown 0:0 /usr/local/share/ploinky \
    && chmod 0755 /usr/local/share/ploinky
COPY --chown=0:0 --chmod=0444 sources.lock.json /usr/local/share/ploinky/umami-agent-sources.json
COPY --chown=0:0 --chmod=0444 smoke-runtime.mjs /usr/local/share/ploinky/smoke-umami-runtime.mjs
RUN test -f /app/server.js \
    && test -f /app/scripts/check-db.js \
    && test -f /app/scripts/update-tracker.js \
    && test -f /app/ploinky-umami-build.json \
    && test -f /app/geo/GeoLite2-City.mmdb \
    && test -f /app/node_modules/bcryptjs/package.json \
    && test -f /app/node_modules/prisma/package.json \
    && test -x /app/node_modules/.bin/prisma \
    && test "$(node --version)" = 'v22.23.4' \
    && test "$(npm --version | cut -d . -f 1)" = '10' \
    && test "$(postgres --version | cut -d ' ' -f 3)" = '18.6' \
    && test "$(id -u postgres)" = '70' \
    && test "$(su-exec 1000:1000 id -u)" = '1000' \
    && for tool in postgres initdb pg_ctl pg_controldata pg_isready psql createdb su-exec; do command -v "$tool" > /dev/null || exit 1; done \
    && ! command -v bun \
    && ! test -e /opt/umami-mcp \
    && su-exec 1000:1000 node -e "for (const file of ['umami-agent-sources.json', 'smoke-umami-runtime.mjs']) require('fs').readFileSync('/usr/local/share/ploinky/' + file)"

EXPOSE 3000
WORKDIR /code
