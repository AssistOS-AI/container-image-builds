# Native Ubuntu 24.04 toolchain for process-scoped QA bootstrap. The host keeps
# its own Git, configuration and distro-managed TLS libraries.
FROM docker.io/library/ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517 AS builder

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl gettext libcurl4-openssl-dev \
    libexpat1-dev libssl-dev perl pkg-config python3 xz-utils zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN set -eu; \
    curl --fail --location --silent --show-error \
      https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz -o git.tar.xz; \
    printf '%s  %s\n' \
      457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357 git.tar.xz \
      | sha256sum --check --strict -; \
    tar -xJf git.tar.xz; \
    case "$(curl-config --ssl-backends)" in OpenSSL|OpenSSL\ v3+) ;; *) exit 1 ;; esac; \
    cd git-2.55.0; \
    make -j2 prefix=/opt/qa-git RUNTIME_PREFIX=YesPlease NO_TCLTK=YesPlease \
      NO_RUST=YesPlease CURL_CONFIG=/usr/bin/curl-config all; \
    make prefix=/opt/qa-git RUNTIME_PREFIX=YesPlease NO_TCLTK=YesPlease \
      NO_RUST=YesPlease CURL_CONFIG=/usr/bin/curl-config DESTDIR=/out install; \
    /out/opt/qa-git/bin/git --version; \
    mkdir -p /out/opt/qa-git/share/qa-git; \
    printf '%s\n' \
      'git_version=2.55.0' \
      'git_source_sha256=457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357' \
      'ubuntu_index_sha256=33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517' \
      'tls_backend=ubuntu-libcurl-openssl' \
      'runtime_prefix=true' > /out/opt/qa-git/share/qa-git/source.contract

FROM docker.io/library/node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0 AS node-runtime

FROM docker.io/library/ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517 AS validation
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl libcurl4t64 libexpat1 libssl3t64 perl zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
# A different prefix proves that helpers and templates relocate together.
COPY --from=builder /out/opt/qa-git /opt/relocated/qa-git
COPY scripts/smoke-git-transport.mjs /opt/probes/smoke-git-transport.mjs
ENV PATH=/opt/relocated/qa-git/bin:/usr/local/bin:/usr/bin:/bin
RUN set -eu; \
    test "$(git --exec-path)" = /opt/relocated/qa-git/libexec/git-core; \
    ldd "$(git --exec-path)/git-remote-https" > /tmp/git-https-linkage.txt; \
    grep -Fq 'libcurl.so.4' /tmp/git-https-linkage.txt; \
    if grep -Eq 'libcurl-gnutls|not found' /tmp/git-https-linkage.txt; then \
      cat /tmp/git-https-linkage.txt; exit 1; \
    fi; \
    git init /tmp/template-probe; \
    test -f /tmp/template-probe/.git/hooks/pre-commit.sample; \
    mkdir -p /proof; \
    node /opt/probes/smoke-git-transport.mjs > /proof/git-transport.json; \
    cat /proof/git-transport.json

FROM scratch AS artifact
COPY --from=validation /opt/relocated/qa-git /qa-git
COPY --from=validation /proof /proof
