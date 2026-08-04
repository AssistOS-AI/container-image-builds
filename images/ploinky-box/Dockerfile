# quay.io's immutable OCI index for Podman 5.8.2, verified to include native
# linux/amd64 and linux/arm64 manifests. Candidate CI re-proves the full stack.
ARG PODMAN_BASE=quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
ARG CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:2026.7.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe
ARG BUBBLEWRAP_NEVRA=bubblewrap-0:0.11.0-4.fc44
ARG PLOINKY_SOURCE_SHA

FROM $CLOUDFLARED_IMAGE AS cloudflared

FROM $NODE_RUNTIME_IMAGE AS node-runtime

FROM $PODMAN_BASE AS bwrap-launch-builder

RUN dnf install -y gcc glibc-devel binutils \
    && dnf clean all
ARG PLOINKY_SOURCE_SHA
COPY --from=ploinky-src /ploinky-box/native/ploinky-bwrap-launch.c /build/ploinky-bwrap-launch.c
RUN case "$PLOINKY_SOURCE_SHA" in \
        ''|*[!0-9a-f]*) echo 'PLOINKY_SOURCE_SHA must be exactly 40 lowercase hexadecimal characters' >&2; exit 1 ;; \
    esac \
    && test "${#PLOINKY_SOURCE_SHA}" -eq 40 \
    && cc -std=c17 -O2 -Wall -Wextra -Werror \
        "-DPLOINKY_SOURCE_SHA=\"${PLOINKY_SOURCE_SHA}\"" \
        -o /build/ploinky-bwrap-launch /build/ploinky-bwrap-launch.c \
    && strip --strip-all /build/ploinky-bwrap-launch \
    && test -x /build/ploinky-bwrap-launch \
    && test ! -u /build/ploinky-bwrap-launch \
    && test ! -g /build/ploinky-bwrap-launch \
    && test "$(stat -c '%a:%u:%g' /build/ploinky-bwrap-launch)" = '755:0:0' \
    && test "$(/build/ploinky-bwrap-launch --version)" = "ploinky-bwrap-launch-v1 source-sha=${PLOINKY_SOURCE_SHA}"

FROM $PODMAN_BASE AS prepared-rootfs

ARG BUBBLEWRAP_NEVRA
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
ARG TARGETARCH
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && case "$TARGETARCH" in \
        amd64) rpm_arch=x86_64 ;; \
        arm64) rpm_arch=aarch64 ;; \
        *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && dnf install -y --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
        "${BUBBLEWRAP_NEVRA}.${rpm_arch}" \
        bash \
        ca-certificates \
        coreutils \
        curl \
        ffmpeg-free \
        git \
        iproute \
        libcap \
        openssh-clients \
        procps-ng \
        python3 \
        fuse-overlayfs \
        netavark \
        aardvark-dns \
        passt \
        slirp4netns \
        util-linux-core \
        util-linux-script \
    && dnf clean all \
    && test "$(rpm -q --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' bubblewrap)" = "${BUBBLEWRAP_NEVRA}.${rpm_arch}" \
    && test "$(stat -c '%a:%u:%g' /usr/bin/bwrap)" = '755:0:0' \
    && test -z "$(getcap /usr/bin/bwrap)" \
    && bwrap_help="$(bwrap --help 2>&1)" \
    && printf '%s\n' "$bwrap_help" | grep -F -- '--bind-fd FD DEST' \
    && printf '%s\n' "$bwrap_help" | grep -F -- '--ro-bind-fd FD DEST' \
    && printf '%s\n' "$bwrap_help" | grep -F -- '--ro-bind-data FD DEST' \
    && printf '%s\n' "$bwrap_help" | grep -F -- '--perms OCTAL' \
    && for required_command in bash curl ffmpeg git ssh python3 script unshare ps setsid timeout; do \
        command -v "$required_command" >/dev/null; \
    done \
    && node --version | grep -E '^v24\.' \
    && npm --version \
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

ARG PLOINKY_SOURCE_SHA
COPY --from=bwrap-launch-builder /build/ploinky-bwrap-launch /usr/local/libexec/ploinky-bwrap-launch
RUN test -x /usr/local/libexec/ploinky-bwrap-launch \
    && test ! -u /usr/local/libexec/ploinky-bwrap-launch \
    && test ! -g /usr/local/libexec/ploinky-bwrap-launch \
    && test "$(stat -c '%a:%u:%g' /usr/local/libexec/ploinky-bwrap-launch)" = '755:0:0' \
    && test "$(/usr/local/libexec/ploinky-bwrap-launch --version)" = "ploinky-bwrap-launch-v1 source-sha=${PLOINKY_SOURCE_SHA}" \
    && test "$(/usr/local/libexec/ploinky-bwrap-launch --capabilities)" = "ploinky-bwrap-launch-v1 source-sha=${PLOINKY_SOURCE_SHA} protocol=1 descriptor-fd=3 path-resolution=openat2-beneath-no-magiclinks-no-symlinks bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file ro-data-path-hardening=sealed-memfd-ro-bind-data preexec-barrier=R/G credential-bound=4096"

# The pinned Podman base currently ships a user containers.conf. The Box
# entrypoint creates that file together with box-transport.json after
# discovering the outer gateway, so the immutable image must not contain
# either half of that runtime-owned pair.
RUN rm -f /home/podman/.config/containers/containers.conf \
    && mkdir -p \
        /opt/ploinky/node_modules \
        /workspace \
        /run/ploinky \
        /home/podman/.config/containers \
        /home/podman/.local/share/containers/storage \
    && chown -R podman:podman \
        /opt/ploinky \
        /workspace \
        /run/ploinky \
        /home/podman/.config \
        /home/podman/.local/share/containers \
    && chmod 0700 /run/ploinky /home/podman/.config /home/podman/.config/containers \
    && printf 'assistos/ploinky-box\n' > /etc/ploinky-box

# The split ranges deliberately skip the podman user's own UID/GID while
# supplying 65,534 subordinate IDs. Inner root plus IDs through 65,534 then
# fit in the required 65,535-entry rootless mapping.
RUN test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subuid)" = 65534 \
    && test "$(awk -F: '$1 == "podman" { total += $3 } END { print total + 0 }' /etc/subgid)" = 65534

COPY --from=ploinky-src /ploinky-box/entrypoint/ploinky-box-entrypoint /usr/local/bin/ploinky-box-entrypoint
RUN chmod 0755 /usr/local/bin/ploinky-box-entrypoint

FROM scratch AS runtime

ARG PLOINKY_SOURCE_SHA
COPY --from=prepared-rootfs / /

LABEL io.assistos.ploinky.source-sha=$PLOINKY_SOURCE_SHA

# Reapply Fedora's shadow-utils file capabilities after the filesystem copy.
# The native publication gates also verify the setuid-root fallback so either
# supported privilege mechanism remains explicit and testable.
RUN rpm --setcaps shadow-utils

ENV PATH=/opt/ploinky/bin:/usr/local/bin:/usr/bin \
    USER=podman \
    HOME=/home/podman \
    PLOINKY_WORKSPACE_ROOT=/workspace \
    container=oci \
    _CONTAINERS_USERNS_CONFIGURED="" \
    BUILDAH_ISOLATION=chroot

USER podman
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ploinky-box-entrypoint"]
