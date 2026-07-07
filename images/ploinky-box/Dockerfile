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
    && dnf install -y git slirp4netns \
    && dnf clean all
# slirp4netns: ploinky pins agent networking to slirp4netns:allow_host_loopback,
# but podman/stable ships only pasta by default.

# No baked Ploinky core: the ploinky-box wrapper bind-mounts a host checkout
# read-only at /opt/ploinky and a writable named volume at
# /opt/ploinky/node_modules. /opt/ploinky stays an empty mountpoint here.
# /etc/ploinky-box is the in-box marker: bin/ploinky runs the direct CLI when
# it exists, and ploinky's agent networking downgrades named podman networks.
# Agent runtimes (e.g. webtty's node-pty) ship in their own agent images,
# pulled by the nested podman at run time.
RUN mkdir -p /opt/ploinky /workspace /home/podman/.local/share/containers \
    && chown -R podman:podman /workspace /home/podman/.local/share/containers \
    && echo 'assistos/ploinky-box' > /etc/ploinky-box

ENV PATH=/opt/ploinky/bin:$PATH \
    PLOINKY_WORKSPACE_ROOT=/workspace

COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
