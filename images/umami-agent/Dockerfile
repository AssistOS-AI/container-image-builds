FROM docker.io/assistos/umami-agent@sha256:5ca78a8263f000bfa6f5039e225452f8a4ec6526c52157955dc83454128c8bf6 AS umami-build

USER root
WORKDIR /build
ENV NODE_ENV=development \
    BASE_PATH=/base-agent-additional-server/umamiAgent/3000 \
    SKIP_BUILD_GEO=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://user:pass@localhost:5432/dummy

COPY sources.lock.json /tmp/umami-sources.lock.json
COPY verify-build.mjs /tmp/verify-umami-build.mjs

RUN set -eux; \
    test "$(node --version)" = 'v22.23.1'; \
    test "$(bun --version)" = '1.3.14'; \
    test "$(postgres --version | cut -d ' ' -f 3)" = '18.4'; \
    curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
      --output /tmp/umami-source.tar.gz \
      https://codeload.github.com/umami-software/umami/tar.gz/2f6e2b5ff256862a081d9e74bed18a42ebf795e3; \
    printf '%s  %s\n' 'faf2071ada0aef901f29d314eb1b1b2705698c5489df786d003dfd248bb7a0bd' /tmp/umami-source.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/umami-source.tar.gz --strip-components=1 -C /build; \
    curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
      --output /tmp/pnpm.tgz https://registry.npmjs.org/pnpm/-/pnpm-10.15.1.tgz; \
    printf '%s  %s\n' '8c53af02ae3ec1fb0ae75377f8d4d6217c2d7cbe6f03c16350cabf7493de6eff' /tmp/pnpm.tgz | sha256sum -c -; \
    mkdir -p /opt/umami-build-tools/pnpm; \
    tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/umami-build-tools/pnpm; \
    test "$(node /opt/umami-build-tools/pnpm/bin/pnpm.cjs --version)" = '10.15.1'; \
    node /tmp/verify-umami-build.mjs source /build /tmp/umami-sources.lock.json; \
    test -s /app/geo/GeoLite2-City.mmdb; \
    mkdir -p /build/geo; \
    cp -a /app/geo/. /build/geo/; \
    cp docker/proxy.ts src/proxy.ts; \
    node /opt/umami-build-tools/pnpm/bin/pnpm.cjs install --frozen-lockfile --prod=false; \
    NODE_ENV=production npm run build-docker; \
    node /opt/umami-build-tools/pnpm/bin/pnpm.cjs prune --prod; \
    mkdir /out; \
    cp -a .next/standalone/. /out/; \
    rm -rf /out/node_modules /out/public /out/scripts /out/prisma /out/generated /out/geo /out/.next/static; \
    cp -a node_modules public scripts prisma prisma.config.ts generated geo package.json pnpm-lock.yaml pnpm-workspace.yaml /out/; \
    cp -a .next/static /out/.next/static; \
    cp .next/required-server-files.json /out/.next/required-server-files.json; \
    node /tmp/verify-umami-build.mjs seal /out /tmp/umami-sources.lock.json

FROM docker.io/assistos/umami-agent@sha256:5ca78a8263f000bfa6f5039e225452f8a4ec6526c52157955dc83454128c8bf6

USER root
LABEL org.opencontainers.image.base.name="docker.io/assistos/umami-agent"
LABEL org.opencontainers.image.base.digest="sha256:5ca78a8263f000bfa6f5039e225452f8a4ec6526c52157955dc83454128c8bf6"
LABEL io.assistos.umami.version="3.2.0"
LABEL io.assistos.umami.source.revision="2f6e2b5ff256862a081d9e74bed18a42ebf795e3"
LABEL io.assistos.umami.base-path="/base-agent-additional-server/umamiAgent/3000"
LABEL io.assistos.umami.pnpm-lock.sha256="b5ba02abd9e346194926658cbfecd95fe4c0a5c765d653a745cf3deb06ec8171"

ENV NODE_ENV=production \
    BASE_PATH=/base-agent-additional-server/umamiAgent/3000 \
    NEXT_TELEMETRY_DISABLED=1

# Replace the complete application; the immutable base supplies only the retained runtime stack.
RUN rm -rf /app && mkdir /app
COPY --from=umami-build --chown=1000:1000 /out/ /app/
RUN mkdir -p /usr/local/share/ploinky \
    && chown 0:0 /usr/local/share/ploinky \
    && chmod 0755 /usr/local/share/ploinky
COPY --chown=0:0 --chmod=0444 sources.lock.json /usr/local/share/ploinky/umami-agent-sources.json
COPY --chown=0:0 --chmod=0444 smoke-runtime.mjs /usr/local/share/ploinky/smoke-umami-runtime.mjs
RUN test -f /app/server.js \
    && test -f /app/scripts/update-tracker.js \
    && test -f /app/node_modules/.bin/prisma \
    && test -f /opt/umami-mcp/dist/index.js \
    && test "$(node --version)" = 'v22.23.1' \
    && test "$(bun --version)" = '1.3.14' \
    && test "$(postgres --version | cut -d ' ' -f 3)" = '18.4' \
    && su-exec 1000:1000 node -e "for (const file of ['umami-agent-sources.json', 'smoke-umami-runtime.mjs']) require('fs').readFileSync('/usr/local/share/ploinky/' + file)"

WORKDIR /code
