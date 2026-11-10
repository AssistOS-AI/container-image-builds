# Build context is the ScriptaHubAgent checkout. Assets are selected by immutable digest
# by the publication workflow and checked against this checkout before they are copied.
ARG SCRIPTA_ASSETS_IMAGE
FROM ${SCRIPTA_ASSETS_IMAGE} AS manuscript-assets
FROM docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates chromium espeak-ng ffmpeg fonts-dejavu-core fonts-liberation \
    ghostscript git libreoffice-writer poppler-utils python3 python3-dev python3-venv \
    qpdf libsndfile1 build-essential sox \
    && rm -rf /var/lib/apt/lists/*
COPY skills/ /opt/scriptahub/runtime/skills/
COPY scriptahubAgent/deployment/ /opt/scriptahub/runtime/
COPY scriptahubAgent/site/reader/reader.css /opt/scriptahub/runtime/reader/reader.css
RUN printf '%s\n' '#!/bin/sh' 'exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"' > /usr/local/bin/chromium-browser \
    && chmod 0755 /usr/local/bin/chromium-browser
RUN --mount=type=bind,from=manuscript-assets,source=/assets,target=/mnt/assets \
    node /opt/scriptahub/runtime/verify-assets.mjs \
        --skills /opt/scriptahub/runtime/skills \
        --runtime /mnt/assets/runtime --native-build /mnt/assets/native-build --exact \
    && cp -R --no-preserve=ownership /mnt/assets/runtime/. /opt/scriptahub/runtime/ \
    && mkdir -p /opt/scriptahub/native-build \
    && if [ -d /mnt/assets/native-build ]; then cp -R --no-preserve=ownership /mnt/assets/native-build/. /opt/scriptahub/native-build/; fi \
    && node /opt/scriptahub/runtime/prepare-skills.mjs /opt/scriptahub/runtime \
    && rm -rf /root/.cache /root/.npm \
    && chmod -R a+rX /opt/scriptahub/runtime
ENV PDF2HTML_RUNTIME_ROOT=/opt/scriptahub/runtime/skills/pdf2html \
    PDF2HTML_CHROMIUM_EXECUTABLE=/usr/local/bin/chromium-browser \
    VALIDATEBOOK_PDF2HTML=/opt/scriptahub/runtime/skills/pdf2html/scripts/pdf2html \
    VALIDATEBOOK_CHROMIUM=/usr/local/bin/chromium-browser \
    VALIDATEBOOK_READER_CSS=/opt/scriptahub/runtime/reader/reader.css
USER 1000:1000
RUN node /opt/scriptahub/runtime/verify-skills.mjs /opt/scriptahub/runtime
