# quay.io's immutable OCI index for Podman 5.8.2, verified to include native
# linux/amd64 and linux/arm64 manifests. Candidate CI re-proves the full stack.
ARG PODMAN_BASE=quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim
ARG CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:2026.7.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe

FROM $CLOUDFLARED_IMAGE AS cloudflared

FROM $NODE_RUNTIME_IMAGE AS node-runtime

FROM $PODMAN_BASE AS prepared-rootfs

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
ARG TARGETARCH
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && dnf install -y git iproute libcap netavark aardvark-dns passt slirp4netns util-linux-core \
    && dnf clean all \
    && rpm --setcaps shadow-utils \
    && case "$TARGETARCH" in \
        amd64) cloudflared_sha256='a76297bc59df96887b94d8cdb2aabe2401fc7b2bf3527b05d9a311b7341d190a' ;; \
        arm64) cloudflared_sha256='254ee7bd4966d32e87c3d223c4b90d2b8f49e0a6a468484a09ea6346b50b2957' ;; \
        *) echo "unsupported cloudflared architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && printf '%s  %s\n' "$cloudflared_sha256" /usr/local/bin/cloudflared | sha256sum --check --strict - \
    && test -x /usr/local/bin/cloudflared \
    && cloudflared --version | grep -E '^cloudflared version 2026\.7\.1([[:space:]]|$)' \
    && cloudflared tunnel run --help 2>&1 | grep -F -- '--token-file'

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
# fit in the required 65,535-entry rootless mapping.
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

LABEL io.assistos.ploinky.runtime-contract="5"

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
