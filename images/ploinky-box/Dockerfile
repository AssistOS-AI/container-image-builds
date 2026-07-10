ARG PODMAN_BASE=quay.io/podman/stable
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM $NODE_RUNTIME_IMAGE AS node-runtime

FROM $PODMAN_BASE

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git slirp4netns \
    && dnf clean all

LABEL io.assistos.ploinky.runtime-contract="1"

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
