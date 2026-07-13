ARG PODMAN_BASE=quay.io/podman/stable
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM $NODE_RUNTIME_IMAGE AS node-runtime

FROM $PODMAN_BASE AS prepared-rootfs

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git libcap slirp4netns \
    && dnf clean all \
    && rpm --setcaps shadow-utils

RUN mkdir -p \
        /opt/ploinky/node_modules \
        /workspace \
        /home/podman/.local/share/containers \
    && chown -R podman:podman \
        /opt/ploinky \
        /workspace \
        /home/podman/.local/share/containers \
    && echo 'assistos/ploinky-box' > /etc/ploinky-box

# The split ranges deliberately skip the podman user's own UID/GID while
# supplying 65,534 subordinate IDs. Inner root plus IDs through 65,534 then
# fit in the required 65,535-entry rootless mapping (Coturn uses UID 65,534).
RUN test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subuid)" = 65534 \
    && test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subgid)" = 65534

COPY images/ploinky-box/entrypoint.sh /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

FROM scratch AS runtime

COPY --from=prepared-rootfs / /

# Reapply Fedora's shadow-utils file capabilities after the filesystem copy.
# The native publication gates also verify the setuid-root fallback so either
# supported privilege mechanism remains explicit and testable.
RUN rpm --setcaps shadow-utils

LABEL io.assistos.ploinky.runtime-contract="3"

ENV PATH=/opt/ploinky/bin:/usr/local/bin:/usr/bin \
    USER=podman \
    HOME=/home/podman \
    PLOINKY_WORKSPACE_ROOT=/workspace \
    PLOINKY_DISABLE_HOST_SANDBOX=1 \
    container=oci \
    _CONTAINERS_USERNS_CONFIGURED="" \
    BUILDAH_ISOLATION=chroot

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
