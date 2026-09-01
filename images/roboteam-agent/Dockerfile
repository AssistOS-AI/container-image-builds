FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca AS node-runtime

FROM quay.io/podman/stable@sha256:eb8fbd5345bba2010078e9e1612b267a4709bb4ad0775bf030fba69be87cfadc

USER root

COPY --from=node-runtime /usr/local/ /usr/local/
COPY --chmod=0444 storage.conf /opt/roboteam-runtime/storage.conf
COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/roboteam-agent-sources.json

RUN set -eux; \
    truncate -s 0 /etc/subuid; \
    truncate -s 0 /etc/subgid; \
    rm -f /usr/bin/newuidmap /usr/bin/newgidmap; \
    for executable in \
        /usr/bin/podman \
        /usr/bin/fuse-overlayfs \
        /usr/bin/pasta \
        /usr/bin/curl \
        /usr/bin/git \
        /usr/local/bin/node; do \
        test -x "$executable"; \
    done; \
    node -e 'JSON.parse(require("node:fs").readFileSync("/usr/local/share/ploinky/roboteam-agent-sources.json", "utf8"))'; \
    install -d -o root -g root -m 0755 /opt/roboteam-runtime; \
    printf 'roboteam-runtime-v2\n' > /opt/roboteam-runtime/contract-v2; \
    chmod 0444 /opt/roboteam-runtime/contract-v2; \
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v2)" = '0:0:444'

ENV CONTAINERS_STORAGE_CONF=/opt/roboteam-runtime/storage.conf
ENV XDG_RUNTIME_DIR=/tmp/roboteam-podman-xdg

WORKDIR /code
CMD ["bash"]
