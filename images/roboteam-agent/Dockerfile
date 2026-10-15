ARG PODMAN_BASE_IMAGE=quay.io/podman/stable@sha256:f345d8d4fddea244d3a1ced27bcec82d14cc9e32cb5ead7f5882b0baf59dc8b0
FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca AS node-runtime

FROM ${PODMAN_BASE_IMAGE}

USER root
ENV HOME=/root
ENV USER=root
ENTRYPOINT []

COPY --from=node-runtime --chmod=0755 /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
COPY --from=node-runtime --chmod=0755 /usr/bin/bwrap /usr/bin/bwrap
COPY --chmod=0444 storage.conf /opt/roboteam-runtime/storage.conf
COPY --chmod=0755 roboteam-podman-init /usr/local/bin/roboteam-podman-init
COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/roboteam-agent-sources.json

ENV CONTAINERS_STORAGE_CONF=/opt/roboteam-runtime/storage.conf
ENV XDG_RUNTIME_DIR=/tmp/roboteam-podman-xdg

ARG TARGETARCH

# OpenCode's skill, glob and grep tools need ripgrep on PATH. Without it OpenCode
# downloads ripgrep into the robot home at run time, and extracting that archive
# fails inside the Bubblewrap sandbox, so every skill load returns the tar error.
# The unmodified upstream release binary is pinned by its published checksum.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset=ripgrep-15.1.0-x86_64-unknown-linux-musl; sha=1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599 ;; \
      arm64) asset=ripgrep-15.1.0-aarch64-unknown-linux-gnu; sha=2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/$asset.tar.gz" -o /tmp/ripgrep.tar.gz; \
    printf '%s  %s\n' "$sha" /tmp/ripgrep.tar.gz | sha256sum --check --strict -; \
    tar --no-same-owner -xzf /tmp/ripgrep.tar.gz -C /tmp "$asset/rg"; \
    install -o root -g root -m 0755 "/tmp/$asset/rg" /usr/local/bin/rg; \
    rm -rf /tmp/ripgrep.tar.gz "/tmp/$asset"; \
    case "$(rg --version | head -n 1)" in 'ripgrep 15.1.0 '*) ;; *) exit 1 ;; esac

RUN set -eux; \
    truncate -s 0 /etc/subuid; \
    truncate -s 0 /etc/subgid; \
    rm -f /usr/bin/newuidmap /usr/bin/newgidmap; \
    rm -f /usr/local/bin/npm /usr/local/bin/npx; \
    printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js "$@"' > /usr/local/bin/npm; \
    printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npx-cli.js "$@"' > /usr/local/bin/npx; \
    chmod 0755 /usr/local/bin/npm /usr/local/bin/npx; \
    for executable in \
        /usr/bin/podman \
        /usr/bin/fuse-overlayfs \
        /usr/bin/pasta \
        /usr/bin/curl \
        /usr/bin/git \
        /usr/bin/bwrap \
        /usr/local/bin/node \
        /usr/local/bin/npm \
        /usr/local/bin/npx \
        /usr/local/bin/rg; do \
        test -x "$executable"; \
    done; \
    test "$(podman --version)" = 'podman version 5.8.7'; \
    node -e 'JSON.parse(require("node:fs").readFileSync("/usr/local/share/ploinky/roboteam-agent-sources.json", "utf8"))'; \
    install -d -o root -g root -m 0755 /opt/roboteam-runtime; \
    sh -n /usr/local/bin/roboteam-podman-init; \
    test -x /usr/bin/mount; \
    test -x /usr/bin/findmnt; \
    printf 'roboteam-runtime-v6\n' > /opt/roboteam-runtime/contract-v6; \
    chmod 0444 /opt/roboteam-runtime/contract-v6; \
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v6)" = '0:0:444'

WORKDIR /code
CMD ["bash"]
