ARG NODE_BASE=docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
ARG BUBBLEWRAP_VERSION=0.8.0-2+deb12u1
ARG PLOINKY_SOURCE_SHA

FROM $NODE_BASE AS bwrap-launch-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        binutils \
        gcc \
        libc6-dev \
    && rm -rf /var/lib/apt/lists/*

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
    && test "$(/build/ploinky-bwrap-launch --version)" = "ploinky-bwrap-launch-v2 source-sha=${PLOINKY_SOURCE_SHA}"

FROM $NODE_BASE

ARG BUBBLEWRAP_VERSION
ARG PLOINKY_SOURCE_SHA
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        "bubblewrap=${BUBBLEWRAP_VERSION}" \
        ca-certificates \
        curl \
        ffmpeg \
        git \
        g++ \
        libcap2-bin \
        make \
        openssh-client \
        procps \
        python3 \
        util-linux \
    && test "$(dpkg-query -W -f='${Package}=${Version}' bubblewrap)" = "bubblewrap=${BUBBLEWRAP_VERSION}" \
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
    && rm -rf /var/lib/apt/lists/*

COPY --from=bwrap-launch-builder /build/ploinky-bwrap-launch /usr/local/libexec/ploinky-bwrap-launch
RUN test -x /usr/local/libexec/ploinky-bwrap-launch \
    && test ! -u /usr/local/libexec/ploinky-bwrap-launch \
    && test ! -g /usr/local/libexec/ploinky-bwrap-launch \
    && test "$(stat -c '%a:%u:%g' /usr/local/libexec/ploinky-bwrap-launch)" = '755:0:0' \
    && test -z "$(getcap /usr/local/libexec/ploinky-bwrap-launch)" \
    && test "$(/usr/local/libexec/ploinky-bwrap-launch --version)" = "ploinky-bwrap-launch-v2 source-sha=${PLOINKY_SOURCE_SHA}" \
    && test "$(/usr/local/libexec/ploinky-bwrap-launch --capabilities)" = "ploinky-bwrap-launch-v2 source-sha=${PLOINKY_SOURCE_SHA} protocol=2 descriptor-fd=3 path-resolution=openat2-beneath-no-magiclinks-no-symlinks bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file ro-data-path-hardening=sealed-memfd-ro-bind-data home-sources=sandbox-workspace-v2,container-native home-marker=ploinky-home-v2-schema-2 home-revalidation=post-barrier-G preexec-barrier=R/G credential-bound=4096" \
    && install -d -m 0700 -o 1000 -g 1000 /workspace /root

LABEL io.assistos.ploinky.source-sha=$PLOINKY_SOURCE_SHA

USER 1000:1000
