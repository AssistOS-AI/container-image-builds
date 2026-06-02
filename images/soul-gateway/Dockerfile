ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV SOUL_GATEWAY_IMAGE_APP_DIR=/opt/soul-gateway

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        sqlite3 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/soul-gateway

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src /opt/soul-gateway/src
COPY startup.sh install.sh cli.sh /opt/soul-gateway/
COPY manifest.json /opt/soul-gateway/manifest.json

RUN chmod +x /opt/soul-gateway/startup.sh \
    /opt/soul-gateway/install.sh \
    /opt/soul-gateway/cli.sh \
    && node -e "import('node:sqlite').then(() => console.log('node:sqlite ok'))" \
    && sqlite3 --version

WORKDIR /opt/soul-gateway
