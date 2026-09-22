FROM docker.io/assistos/ploinky-node:24-trixie-tools@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669

ARG TARGETARCH

USER root

# The unmodified OpenCode CLI release binary. The release tarball holds a
# single `opencode` member at the archive root.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset=opencode-linux-x64.tar.gz;   sha=e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4 ;; \
      arm64) asset=opencode-linux-arm64.tar.gz; sha=d4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/anomalyco/opencode/releases/download/v1.18.31/$asset" -o /tmp/opencode.tar.gz; \
    printf '%s  %s\n' "$sha" /tmp/opencode.tar.gz | sha256sum --check --strict -; \
    mkdir -p /opt/opencode/bin /opt/opencode-free/config/opencode /var/tmp/opencode-free; \
    tar -xzf /tmp/opencode.tar.gz -C /opt/opencode/bin; \
    rm /tmp/opencode.tar.gz; \
    test -x /opt/opencode/bin/opencode; \
    test "$(/opt/opencode/bin/opencode --version)" = 1.18.31; \
    printf 'cli_version=1.18.31\nrelease_asset=%s\nrelease_asset_sha256=%s\nbinary_sha256=%s\n' \
      "$asset" "$sha" "$(sha256sum /opt/opencode/bin/opencode | cut -c1-64)" > /opt/opencode-free/source.contract; \
    chown 1000:1000 /var/tmp/opencode-free; \
    chmod 0700 /var/tmp/opencode-free

# Baked, root-owned, read-only CLI configuration reached through
# XDG_CONFIG_HOME=/opt/opencode-free/config.
COPY opencode.json /opt/opencode-free/config/opencode/opencode.json

RUN set -eux; \
    chown -R root:root /opt/opencode-free /opt/opencode; \
    chmod 0444 /opt/opencode-free/config/opencode/opencode.json /opt/opencode-free/source.contract; \
    chmod 0555 /opt/opencode-free/config/opencode /opt/opencode-free/config /opt/opencode-free; \
    chmod 0755 /opt/opencode/bin/opencode

USER 1000:1000
