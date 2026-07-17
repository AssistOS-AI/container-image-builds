# Every stage is an immutable multi-architecture index verified through the
# Docker Hub registry v2 API on 2026-07-15.
FROM docker.io/library/node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS node-runtime

FROM docker.io/onlyoffice/documentserver:9.3.1@sha256:53a06109f1f4029a78f913a061e14f01bff023d109024073a13d4416b54d2195

ARG GXX_VERSION=4:13.2.0-7ubuntu1
ARG GIT_VERSION=1:2.43.0-1ubuntu7.3
ARG MAKE_VERSION=4.3-4.1build2
ARG PYTHON_VERSION=3.12.3-0ubuntu2.1
ARG UBUNTU_SNAPSHOT=20260712T000000Z

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY docservice-loopback-bind.c /tmp/docservice-loopback-bind.c

RUN set -eu; \
    find /etc/apt/sources.list.d -maxdepth 1 -type f ! -name ubuntu.sources -delete; \
    sed -Ei \
        "s#https?://(archive|security|ports)\\.ubuntu\\.com/ubuntu(-ports)?/?#https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/#g" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    if grep -R -E '^[[:space:]]*(deb|URIs:)[[:space:]]+https?://' \
        /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null \
        | grep -v 'snapshot.ubuntu.com/ubuntu/'; then \
        echo 'OnlyOffice build has an unpinned external apt source.' >&2; \
        exit 1; \
    fi; \
    printf '%s\n' 'Acquire::Check-Valid-Until "false";' \
        > /etc/apt/apt.conf.d/99snapshot-valid-until; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        "g++=${GXX_VERSION}" \
        "git=${GIT_VERSION}" \
        "make=${MAKE_VERSION}" \
        "python3=${PYTHON_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    node --version; \
    npm --version; \
    git --version; \
    python3 --version; \
    make --version; \
    cc -shared -fPIC -O2 -Wall -Wextra -Werror \
        -Wl,-z,relro,-z,now \
        -o /usr/local/lib/onlyoffice-docservice-loopback-bind.so \
        /tmp/docservice-loopback-bind.c -ldl; \
    chown root:root /usr/local/lib/onlyoffice-docservice-loopback-bind.so; \
    chmod 0555 /usr/local/lib/onlyoffice-docservice-loopback-bind.so; \
    rm -f /tmp/docservice-loopback-bind.c; \
    test -s /usr/local/lib/onlyoffice-docservice-loopback-bind.so; \
    contract_dir=/usr/local/share/ploinky; \
    contract_file="$contract_dir/onlyoffice-v5.contract"; \
    interposer_sha256="$(sha256sum /usr/local/lib/onlyoffice-docservice-loopback-bind.so | awk '{print $1}')"; \
    mkdir -p "$contract_dir"; \
    printf '%s\n' \
      'contract_version=5' \
      'documentserver_index_sha256=53a06109f1f4029a78f913a061e14f01bff023d109024073a13d4416b54d2195' \
      "ubuntu_snapshot=${UBUNTU_SNAPSHOT}" \
      'docservice_bind_scope=docservice-v5-port-8000' \
      "interposer_sha256=${interposer_sha256}" \
      > "$contract_file"; \
    chown root:root "$contract_file"; \
    chmod 0444 "$contract_file"; \
    test "$(wc -l < "$contract_file")" -eq 5
