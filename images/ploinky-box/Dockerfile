ARG PODMAN_BASE=quay.io/podman/stable
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

FROM ${PODMAN_BASE}

# Node 24 runtime: bookworm glibc binary runs on the newer-glibc Fedora base
# (same multi-stage trick as images/onlyoffice-agent).
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git \
    && dnf clean all

# Ploinky baked from the workflow checkout (submodules: true pins achillesAgentLib).
# --ignore-scripts skips the postinstall that would clone achillesAgentLib master
# over the pinned checkout (and would fail: git clone into a non-empty dir errors).
# npm >= 11 prunes packages not listed in package.json, so the pinned submodule
# is parked aside during install and restored afterwards.
COPY sources/ploinky /opt/ploinky
RUN cd /opt/ploinky \
    && mv node_modules/achillesAgentLib /tmp/achillesAgentLib-pinned \
    && npm install --ignore-scripts \
    && mv /tmp/achillesAgentLib-pinned node_modules/achillesAgentLib \
    && test -d node_modules/achillesAgentLib \
    && test -d node_modules/mcp-sdk \
    && rm -rf .git node_modules/achillesAgentLib/.git \
    && mkdir -p /workspace /home/podman/.local/share/containers \
    && chown -R podman:podman /workspace /home/podman/.local/share/containers

ENV PATH=/opt/ploinky/bin:$PATH \
    PLOINKY_WORKSPACE_ROOT=/workspace

COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
