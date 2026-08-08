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
    && dnf install -y --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
        bash \
        bind-utils \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        diffutils \
        ffmpeg-free \
        file \
        findutils \
        fuse-overlayfs \
        gawk \
        git \
        grep \
        gzip \
        iproute \
        iputils \
        jq \
        less \
        libcap \
        lsof \
        nano \
        net-tools \
        netavark \
        nmap-ncat \
        openssh-clients \
        patch \
        procps-ng \
        python3 \
        rsync \
        sed \
        aardvark-dns \
        passt \
        slirp4netns \
        tar \
        tree \
        unzip \
        util-linux-core \
        util-linux-script \
        vim-minimal \
        wget \
        which \
        xz \
        zip \
    && dnf clean all \
    && for required_command in \
        awk bash bzip2 curl diff dig ffmpeg file find git grep gzip host jq less \
        lsof nano nc netstat node npm npx nslookup patch ping podman ps python3 \
        rsync script sed setsid ssh ss tar timeout tree unshare unzip vi wget \
        which xargs xz zip; do \
        command -v "$required_command" >/dev/null \
            || { echo "missing required interactive command: $required_command" >&2; exit 1; }; \
    done \
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

# The pinned Podman base currently ships a user containers.conf. The Box
# entrypoint creates that file together with box-transport.json after
# discovering the outer gateway, so the immutable image must not contain
# either half of that runtime-owned pair. The entrypoint likewise renders the
# user storage.conf that splits the durable image cache from the disposable
# graphroot, so no inherited copy may pre-empt it.
#
# /home/podman/.local/share/ploinky-images is the reusable image storage mount
# and is backed by the workspace's .ploinky/box/images host bind. The dependency
# cache at /opt/ploinky/node_modules is likewise backed by
# .ploinky/box/dependencies. /home/podman/.local/share/containers/storage is left
# on the container writable layer so every nested container record, writable
# layer, and inner named volume dies with the outer Box.
RUN rm -f /home/podman/.config/containers/containers.conf \
        /home/podman/.config/containers/storage.conf \
    && mkdir -p \
        /opt/ploinky/node_modules \
        /workspace \
        /run/ploinky \
        /home/podman/.config/containers \
        /home/podman/.local/share/containers/storage \
        /home/podman/.local/share/ploinky-images \
    && chown -R podman:podman \
        /opt/ploinky \
        /workspace \
        /run/ploinky \
        /home/podman/.config \
        /home/podman/.local/share/containers \
        /home/podman/.local/share/ploinky-images \
    && chmod 0700 /run/ploinky /home/podman/.config /home/podman/.config/containers \
    && printf 'assistos/ploinky-box\n' > /etc/ploinky-box

# The split ranges deliberately skip the podman user's own UID/GID while
# supplying 65,534 subordinate IDs. Inner root plus IDs through 65,534 then
# fit in the required 65,535-entry rootless mapping.
RUN test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subuid)" = 65534 \
    && test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subgid)" = 65534

COPY sources/ploinky/ploinky-box/entrypoint/ploinky-box-entrypoint /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

FROM scratch AS runtime

COPY --from=prepared-rootfs / /

# Reapply Fedora's shadow-utils file capabilities after the filesystem copy.
# The native publication gates also verify the setuid-root fallback so either
# supported privilege mechanism remains explicit and testable.
RUN rpm --setcaps shadow-utils

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
