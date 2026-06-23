ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools
FROM ${BASE_IMAGE}

ENV NODE_ENV=production

WORKDIR /opt/webtty-agent

COPY app/ ./

RUN (npm ci --omit=dev || npm install --omit=dev) \
    && node -e "require('node-pty'); console.log('node-pty ok')"

EXPOSE 7681

CMD ["node","/opt/webtty-agent/server.mjs"]
