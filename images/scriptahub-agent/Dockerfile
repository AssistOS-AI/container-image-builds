FROM docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669

USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates chromium espeak-ng ffmpeg fonts-dejavu-core fonts-liberation \
    ghostscript git libreoffice-writer poppler-utils python3 python3-dev python3-venv \
    qpdf libsndfile1 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Context is the ScriptaHubAgent repository. Sources and locks are included;
# installed libraries come only from the explicit preparation step below.
RUN apt-get update && apt-get install -y --no-install-recommends sox \
    && rm -rf /var/lib/apt/lists/*
COPY scriptahubAgent/skills/ /opt/scriptahub/runtime/skills/
COPY scriptahubAgent/deployment/ /opt/scriptahub/runtime/
COPY scriptahubAgent/site/reader/reader.css /opt/scriptahub/runtime/reader/reader.css
RUN printf '%s\n' '#!/bin/sh' 'exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"' > /usr/local/bin/chromium-browser \
    && printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/node /opt/scriptahub/runtime/run-skill.mjs "$@"' > /usr/local/bin/scriptahub-skill \
    && chmod 0755 /usr/local/bin/chromium-browser /usr/local/bin/scriptahub-skill \
    && node /opt/scriptahub/runtime/prepare-skills.mjs /opt/scriptahub/runtime \
    && rm -rf /root/.cache /root/.npm \
    && chmod -R a+rX /opt/scriptahub/runtime

ENV PDF2HTML_RUNTIME_ROOT=/opt/scriptahub/runtime/skills/pdf2html
ENV PDF2HTML_CHROMIUM_EXECUTABLE=/usr/local/bin/chromium-browser
ENV VALIDATEBOOK_PDF2HTML=/opt/scriptahub/runtime/skills/pdf2html/scripts/pdf2html
ENV VALIDATEBOOK_CHROMIUM=/usr/local/bin/chromium-browser
ENV VALIDATEBOOK_READER_CSS=/opt/scriptahub/runtime/reader/reader.css
ENV SCRIPTA_SKILLS_LOCAL=1
USER 1000:1000
RUN node /opt/scriptahub/runtime/verify-skills.mjs /opt/scriptahub/runtime
