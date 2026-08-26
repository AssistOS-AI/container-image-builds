FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca AS searxng-builder

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libffi-dev \
        libssl-dev \
        libxml2-dev \
        libxslt1-dev \
        libyaml-dev \
        pkg-config \
        python3 \
        python3-dev \
        python3-venv \
        zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    git init /opt/search-agent/searxng-src; \
    git -C /opt/search-agent/searxng-src remote add origin https://github.com/searxng/searxng.git; \
    git -C /opt/search-agent/searxng-src fetch --depth 1 origin 9fea41204fdfa7a5cfa15b0ebd12904c520478ce; \
    git -C /opt/search-agent/searxng-src checkout --detach FETCH_HEAD; \
    test "$(git -C /opt/search-agent/searxng-src rev-parse HEAD)" = 9fea41204fdfa7a5cfa15b0ebd12904c520478ce; \
    python3 -m venv /opt/search-agent/searx-pyenv; \
    /opt/search-agent/searx-pyenv/bin/python -m pip install --no-cache-dir --upgrade pip setuptools wheel; \
    /opt/search-agent/searx-pyenv/bin/python -m pip install --no-cache-dir \
        msgspec==0.21.1 \
        pybind11==3.0.1 \
        pyyaml==6.0.3 \
        typing-extensions==4.16.0; \
    /opt/search-agent/searx-pyenv/bin/python -m pip install --no-cache-dir --no-build-isolation -e /opt/search-agent/searxng-src; \
    rm -rf /opt/search-agent/searxng-src/.git /root/.cache; \
    /opt/search-agent/searx-pyenv/bin/python -c 'import searx, flask, httpx'

FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca

ENV NODE_PATH=/opt/search-agent/node_modules \
    PYTHONDONTWRITEBYTECODE=1 \
    SEARXNG_HOME=/opt/search-agent \
    SEARXNG_VENV=/opt/search-agent/searx-pyenv \
    SEARXNG_APP_DIR=/opt/search-agent/searxng-src

USER root

COPY package.json package-lock.json /opt/search-agent/
COPY --from=searxng-builder /opt/search-agent/searxng-src /opt/search-agent/searxng-src
COPY --from=searxng-builder /opt/search-agent/searx-pyenv /opt/search-agent/searx-pyenv

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends chromium fonts-liberation; \
    rm -rf /var/lib/apt/lists/*; \
    cd /opt/search-agent; \
    PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --ignore-scripts; \
    find /opt/search-agent -type d -exec chmod 0755 {} +; \
    find /opt/search-agent -type f -exec chmod a+r {} +; \
    /opt/search-agent/searx-pyenv/bin/python -c 'import searx, flask, httpx'; \
    node -e "require('puppeteer-core')"; \
    chromium --version

USER 1000:1000

CMD ["bash"]
