ARG PODMAN_BASE_IMAGE=quay.io/podman/upstream:latest
FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca AS node-runtime

FROM ${PODMAN_BASE_IMAGE}

USER root

COPY --from=node-runtime --chmod=0755 /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
COPY --from=node-runtime --chmod=0755 /usr/bin/bwrap /usr/bin/bwrap
COPY --chmod=0444 storage.conf /opt/roboteam-runtime/storage.conf
COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/roboteam-agent-sources.json

ENV CONTAINERS_STORAGE_CONF=/opt/roboteam-runtime/storage.conf
ENV XDG_RUNTIME_DIR=/tmp/roboteam-podman-xdg

RUN set -eux; \
    truncate -s 0 /etc/subuid; \
    truncate -s 0 /etc/subgid; \
    rm -f /usr/bin/newuidmap /usr/bin/newgidmap; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    npm install --global --omit=dev @openai/codex@0.152.1; \
    for executable in \
        /usr/bin/podman \
        /usr/bin/fuse-overlayfs \
        /usr/bin/pasta \
        /usr/bin/curl \
        /usr/bin/git \
        /usr/bin/bwrap \
        /usr/local/bin/node \
        /usr/local/bin/npm \
        /usr/local/bin/npx; do \
        test -x "$executable"; \
    done; \
    podman --version | grep -E '^podman version 6\.'; \
    codex --version | grep -F 'codex-cli 0.152.1'; \
    node -e 'JSON.parse(require("node:fs").readFileSync("/usr/local/share/ploinky/roboteam-agent-sources.json", "utf8"))'; \
    install -d -o root -g root -m 0755 /opt/roboteam-runtime; \
    printf 'roboteam-runtime-v3\n' > /opt/roboteam-runtime/contract-v3; \
    chmod 0444 /opt/roboteam-runtime/contract-v3; \
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v3)" = '0:0:444'

WORKDIR /code
CMD ["bash"]
