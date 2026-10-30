# RoboWork worker runtime. Digest-pinned inputs are recorded in sources.lock.json.
# The worker runs as container root (the supervisor needs it); robots run as
# uid 1000 inside Bubblewrap. No Rust or other native source is built here, and
# Podman, fuse-overlayfs, pasta, a FUSE helper and a file server are omitted on
# purpose. ALA is not baked: it comes from the Ploinky workspace checkout.
ARG FEDORA_BASE=docker.io/library/fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
ARG NODE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca
ARG PLOINKY_BOX_IMAGE=docker.io/assistos/ploinky-box@sha256:882f950f191007e70745f0494991dbe44e4150564e55a1a1602e1a1f16c5aa12

FROM ${NODE_IMAGE} AS node-runtime
FROM ${PLOINKY_BOX_IMAGE} AS ploinky-webtty

FROM ${FEDORA_BASE}

USER root
ENV HOME=/root
ENV USER=root
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENTRYPOINT []

# Same Node 24 source as roboteam-agent: node and npm from the pinned tools image.
COPY --from=node-runtime --chmod=0755 /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/

# Ploinky's prebuilt immutable node-pty (no native build here). The contract and
# probe live beside it; the path is fixed by core-services/webtty/native-runtime.mjs.
COPY --from=ploinky-webtty /usr/local/lib/ploinky/webtty/node_modules /usr/local/lib/ploinky/webtty/node_modules
COPY --from=ploinky-webtty /usr/local/share/ploinky/webtty/native-probe.mjs /usr/local/share/ploinky/webtty/native-probe.mjs
COPY --from=ploinky-webtty /usr/local/share/ploinky/webtty/runtime-contract.json /usr/local/share/ploinky/webtty/runtime-contract.json

# Unchanged distribution packages at exact NEVRAs: a repository that no longer
# serves one fails the build instead of drifting. Fedora's bubblewrap is installed as shipped.
RUN set -eux; \
    dnf install -y --setopt=ip_resolve=4 --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
        bash-5.3.9-3.fc44 \
        bubblewrap-0.12.0-1.fc44 \
        ca-certificates-2025.2.80_v9.0.304-7.fc44 \
        curl-8.18.0-8.fc44 \
        git-2.56.0-1.fc44 \
        iproute-6.17.0-2.fc44 \
        nftables-1:1.1.6-2.fc44 \
        util-linux-2.41.6-1.fc44 \
        findutils-1:4.10.0-7.fc44 \
        which-2.25-1.fc44 \
        tar-2:1.35-8.fc44 \
        gzip-1.14-2.fc44 \
        python3-3.14.8-1.fc44 \
        python3-libs-3.14.8-1.fc44 \
        python-pip-wheel-26.0.1-3.fc44 \
        mpdecimal-4.0.1-3.fc44; \
    dnf clean all; \
    rm -rf /var/cache/dnf /var/cache/libdnf5; \
    ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    test -x /usr/bin/bwrap

ARG TARGETARCH

# Pinned upstream ripgrep, as in roboteam-agent.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset=ripgrep-15.1.0-x86_64-unknown-linux-musl; sha=1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599 ;; \
      arm64) asset=ripgrep-15.1.0-aarch64-unknown-linux-gnu; sha=2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --ipv4 --fail --location --silent --show-error \
      "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/$asset.tar.gz" -o /tmp/ripgrep.tar.gz; \
    printf '%s  %s\n' "$sha" /tmp/ripgrep.tar.gz | sha256sum --check --strict -; \
    tar --no-same-owner -xzf /tmp/ripgrep.tar.gz -C /tmp "$asset/rg"; \
    install -o root -g root -m 0755 "/tmp/$asset/rg" /usr/local/bin/rg; \
    rm -rf /tmp/ripgrep.tar.gz "/tmp/$asset"; \
    case "$(rg --version | head -n 1)" in 'ripgrep 15.1.0 '*) ;; *) exit 1 ;; esac

# Locked coding-agent tree (codex, claude, opencode with its plugin tree, pi).
COPY agent-tools/package.json agent-tools/package-lock.json /opt/robo-work-tools/
RUN set -eux; \
    cd /opt/robo-work-tools; \
    npm ci --no-audit --no-fund --no-update-notifier; \
    rm -rf /root/.npm /tmp/*; \
    for bin in codex claude opencode pi; do \
      ln -s "/opt/robo-work-tools/node_modules/.bin/$bin" "/usr/local/bin/$bin"; \
    done; \
    chown -R root:root /opt/robo-work-tools; \
    chmod -R a+rX,go-w /opt/robo-work-tools

COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/robo-work-worker-sources.json
COPY --chmod=0755 smoke-worker.mjs /usr/local/share/ploinky/robo-work-worker-smoke.mjs

RUN set -eux; \
    node -e 'JSON.parse(require("node:fs").readFileSync("/usr/local/share/ploinky/robo-work-worker-sources.json", "utf8"))'; \
    install -d -o root -g root -m 0755 /opt/robo-work-runtime; \
    printf 'robo-work-worker-v1\n' > /opt/robo-work-runtime/contract-v1; \
    chmod 0444 /opt/robo-work-runtime/contract-v1

WORKDIR /code
CMD ["node", "/usr/local/share/ploinky/robo-work-worker-smoke.mjs"]
