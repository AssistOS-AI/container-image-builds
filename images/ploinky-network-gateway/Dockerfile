# golang:1.25.6-alpine3.22, pinned to its multi-platform OCI index.
ARG GO_BUILDER=docker.io/library/golang:1.25.6-alpine3.22@sha256:fa3380ab0d73b706e6b07d2a306a4dc68f20bfc1437a6a6c47c8f88fe4af6f75

FROM ${GO_BUILDER} AS builder

WORKDIR /src
COPY main.go ./
RUN CGO_ENABLED=0 go build \
        -buildvcs=false \
        -trimpath \
        -ldflags='-s -w' \
        -o /out/ploinky-network-gateway \
        ./main.go \
    && mkdir -p /out/rootfs/run/ploinky \
    && cp /out/ploinky-network-gateway /out/rootfs/ploinky-network-gateway

FROM scratch

COPY --from=builder /out/rootfs/ /

LABEL org.opencontainers.image.title="Ploinky network gateway" \
    org.opencontainers.image.description="Fixed raw-TCP proxy from port 8080 to /run/ploinky/router.sock"

USER 65532:65532
EXPOSE 8080/tcp
ENTRYPOINT ["/ploinky-network-gateway"]
