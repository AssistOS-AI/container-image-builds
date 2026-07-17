ARG BASE_IMAGE=docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:95ec6e79245cf6a193b3cdd95b0f7a329edf938f1bdf29e7f4fe361df784cdea
FROM ${BASE_IMAGE}

ENV NODE_ENV=production

WORKDIR /opt/webtty-agent

COPY app/package.json app/package-lock.json ./

RUN npm ci --omit=dev \
    && node -e "require('node-pty'); console.log('node-pty ok')"

COPY app/ ./
COPY --chmod=0555 webtty-v5-start.sh /usr/local/bin/webtty-v5-start

RUN install -d public/assets/vendor/xterm \
    && install -m 0644 node_modules/xterm/css/xterm.css public/assets/vendor/xterm/xterm.css \
    && install -m 0644 node_modules/xterm/lib/xterm.js public/assets/vendor/xterm/xterm.js \
    && install -m 0644 node_modules/xterm-addon-fit/lib/xterm-addon-fit.js public/assets/vendor/xterm/xterm-addon-fit.js \
    && install -m 0644 node_modules/xterm-addon-web-links/lib/xterm-addon-web-links.js public/assets/vendor/xterm/xterm-addon-web-links.js \
    && ! grep -R -E 'https?://(unpkg|cdn\.jsdelivr|cdnjs)' public \
    && tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
        -C public -cf public-v5.tar . \
    && install -d -m 0755 /usr/local/share/ploinky \
    && { \
        printf '%s\n' 'contract_version=5'; \
        printf 'package_lock_sha256=%s\n' "$(sha256sum package-lock.json | awk '{print $1}')"; \
        printf 'server_sha256=%s\n' "$(sha256sum server.mjs | awk '{print $1}')"; \
        printf 'public_archive_sha256=%s\n' "$(sha256sum public-v5.tar | awk '{print $1}')"; \
        printf 'start_script_sha256=%s\n' "$(sha256sum /usr/local/bin/webtty-v5-start | awk '{print $1}')"; \
    } > /usr/local/share/ploinky/webtty-v5.contract \
    && chown 0:0 /usr/local/share/ploinky/webtty-v5.contract \
        /usr/local/bin/webtty-v5-start public-v5.tar \
    && chmod 0444 /usr/local/share/ploinky/webtty-v5.contract public-v5.tar \
    && chmod 0555 /usr/local/bin/webtty-v5-start

EXPOSE 7681

CMD ["/usr/local/bin/webtty-v5-start"]
