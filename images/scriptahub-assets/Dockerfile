FROM docker.io/library/rust@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922 AS native-build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends python3 cmake clang pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY scriptahubAgent/deployment/skills-runtime.json /build-config.json
COPY scriptahubAgent/deployment/build-native.sh /build-native.sh
RUN TARGETARCH="$TARGETARCH" sh /build-native.sh

# docling.rs replaced its models-v1 release assets on 2026-11-01 with different bytes. The pinned models
# (skills/pdf2html/external/native/integrity.json) come from the last image built with them; the fetch stage
# still verifies every file against its pinned SHA-256 and downloads only a file that is missing.
FROM docker.io/assistos/scriptahub-agent@sha256:81040fe16c49349572e37048ef0d4660078097774542f502c9c3a21ba0d3e534 AS verified-models

# Context is the ScriptaHubAgent repository. The tree below holds only downloaded model and native files; the
# inventories it is checked against are the repository's own, so no file is accepted on the word of its source.
FROM docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669 AS fetch
USER root
COPY skills/pdf2html/external/native/integrity.json /inventory/skills/pdf2html/external/native/integrity.json
COPY skills/pdf2html/external/native/sources/sources.json /inventory/skills/pdf2html/external/native/sources/sources.json
COPY scriptahubAgent/deployment/ /inventory/deployment/
COPY --from=verified-models /opt/scriptahub/runtime/skills/pdf2html/external/native/models/ /assets/runtime/skills/pdf2html/external/native/models/
COPY --from=native-build /out/ /assets/native-build/
RUN mkdir -p /assets/runtime /assets/native-build \
    && node /inventory/deployment/prepare-assets.mjs --skills /inventory/skills --runtime /assets/runtime \
    && chmod -R a+rX,go-w,a-st /assets \
    && node /inventory/deployment/verify-assets.mjs --skills /inventory/skills --runtime /assets/runtime --native-build /assets/native-build --exact

FROM scratch
COPY --from=fetch /assets/ /assets/
