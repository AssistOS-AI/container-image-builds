# LiveKit Egress v1.9.1 source and all inherited build/runtime images are
# immutable. The one local patch changes the detailed health listener from
# wildcard to loopback; no Egress API or recording behavior is changed.
ARG EGRESS_SOURCE_COMMIT=ba52a026bea409bde31dcc7da9ba5322e967520c
ARG EGRESS_SOURCE_ARCHIVE_SHA256=692cbeea4836f9577e0e595fdddd34abf2183717197402cbcdca3f71b904d6b3
ARG GSTREAMER_DEV_IMAGE=livekit/gstreamer:1.22.12-dev@sha256:1d0d553310720113cedb194aceaa7c97d4b5f23f3b9280b0cf2015119dda39f5
ARG EGRESS_TEMPLATES_IMAGE=livekit/egress-templates:sha-fe250b1@sha256:2c8dd5eee79894cb995745254b5aa47fe6c05d7c19bc8e70360739096f5ea3bb
ARG EGRESS_RUNTIME_IMAGE=livekit/egress:v1.9.1@sha256:99f6a19cd93a6336c518845bae22a151ad63497329b62f1b1b8c4125c52d57c8

FROM ${EGRESS_TEMPLATES_IMAGE} AS templates
FROM ${GSTREAMER_DEV_IMAGE} AS builder

ARG TARGETARCH
ARG EGRESS_SOURCE_COMMIT
ARG EGRESS_SOURCE_ARCHIVE_SHA256

USER root
WORKDIR /workspace

RUN set -eu; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
      amd64|x86_64) arch=amd64; go_sha=49bbb517cfa9eee677e1e7897f7cf9cfdbcf49e05f61984a2789136de359f9bd ;; \
      arm64|aarch64) arch=arm64; go_sha=faec7f7f8ae53fda0f3d408f52182d942cc89ef5b7d3d9f23ff117437d4b2d2f ;; \
      *) echo "unsupported target architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/go.tar.gz "https://go.dev/dl/go1.23.1.linux-${arch}.tar.gz"; \
    echo "${go_sha}  /tmp/go.tar.gz" | sha256sum -c -; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm /tmp/go.tar.gz

ENV PATH=/usr/local/go/bin:${PATH}

RUN set -eu; \
    curl -fsSLo /tmp/egress.tar.gz \
      "https://github.com/livekit/egress/archive/${EGRESS_SOURCE_COMMIT}.tar.gz"; \
    echo "${EGRESS_SOURCE_ARCHIVE_SHA256}  /tmp/egress.tar.gz" | sha256sum -c -; \
    test "$(tar -tzf /tmp/egress.tar.gz | head -n 1)" = "egress-${EGRESS_SOURCE_COMMIT}/"; \
    tar -xzf /tmp/egress.tar.gz --strip-components=1; \
    rm /tmp/egress.tar.gz; \
    grep -Fq 'http.ListenAndServe(fmt.Sprintf(":%d", conf.HealthPort), &httpHandler{svc: svc})' cmd/server/main.go; \
    sed -i 's/http.ListenAndServe(fmt.Sprintf(":%d", conf.HealthPort), &httpHandler{svc: svc})/http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", conf.HealthPort), \&httpHandler{svc: svc})/' cmd/server/main.go; \
    grep -Fq 'http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", conf.HealthPort), &httpHandler{svc: svc})' cmd/server/main.go; \
    ! grep -Fq 'http.ListenAndServe(fmt.Sprintf(":%d", conf.HealthPort), &httpHandler{svc: svc})' cmd/server/main.go

COPY --from=templates /workspace/build/ /workspace/cmd/server/templates/

RUN set -eu; \
    find cmd/server/templates -name '*.map' -delete; \
    go mod download; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in amd64|x86_64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; esac; \
    CGO_ENABLED=1 GOOS=linux GOARCH="$arch" GO111MODULE=on GODEBUG=disablethp=1 \
      go build -a -trimpath -buildvcs=false -o /workspace/egress ./cmd/server

FROM ${EGRESS_RUNTIME_IMAGE} AS runtime
ARG EGRESS_SOURCE_COMMIT
USER root
COPY --from=builder --chmod=0755 /workspace/egress /usr/bin/egress
RUN set -eu; \
    test -x /usr/bin/egress; \
    test "$(/usr/bin/egress --version | awk '{print $NF}')" = "1.9.0"; \
    contract_dir=/usr/local/share/ploinky; \
    contract_file="$contract_dir/livekit-egress-loopback.contract"; \
    binary_sha256="$(sha256sum /usr/bin/egress | awk '{print $1}')"; \
    mkdir -p "$contract_dir"; \
    printf '%s\n' \
      'contract_version=5' \
      "source_commit=${EGRESS_SOURCE_COMMIT}" \
      'health_listener=127.0.0.1:7981' \
      'template_listener=127.0.0.1:7980' \
      "binary_sha256=${binary_sha256}" \
      > "$contract_file"; \
    chown root:root "$contract_file"; \
    chmod 0444 "$contract_file"; \
    test "$(wc -l < "$contract_file")" -eq 5
LABEL org.opencontainers.image.source="https://github.com/livekit/egress" \
      org.opencontainers.image.revision="${EGRESS_SOURCE_COMMIT}" \
      org.opencontainers.image.version="v1.9.1-ploinky-loopback-health" \
      io.ploinky.patch="egress-health-7981-loopback-only"
USER egress
