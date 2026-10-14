FROM docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils antiword libreoffice-writer libreoffice-impress fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bizanso-runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && node --input-type=module -e "import 'node:sqlite'"
COPY sources.lock.json transformers.mjs model.mjs prepare-model.mjs ./
RUN node prepare-model.mjs
COPY smoke-runtime.mjs ./

ENV MODEL_CACHE=/opt/bizanso-runtime/models \
    MODEL_OFFLINE=1 \
    BIZANSO_TRANSFORMERS_MODULE=/opt/bizanso-runtime/transformers.mjs
USER 1000:1000
CMD ["node", "/app/bizanso/src/runtime.mjs"]
