import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function dockerfileInstructions(dockerfile) {
    const instructions = [];
    let logicalInstruction = '';

    for (const line of dockerfile.split(/\r?\n/)) {
        if (!logicalInstruction && /^\s*(?:#.*)?$/.test(line)) {
            continue;
        }

        logicalInstruction += logicalInstruction ? `\n${line}` : line;
        if (/\\\s*$/.test(line)) {
            continue;
        }

        const keyword = logicalInstruction.match(/^\s*([A-Za-z]+)\b/)?.[1];
        if (keyword) {
            instructions.push({
                keyword: keyword.toUpperCase(),
                source: logicalInstruction,
            });
        }
        logicalInstruction = '';
    }

    return instructions;
}

test('ploinky-node workflow builds the local image definition', () => {
    const workflow = read('.github/workflows/publish-ploinky-node-image.yml');
    const dockerfile = read('images/ploinky-node/Dockerfile');

    assert.match(workflow, /images\/ploinky-node/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(dockerfile, /^ARG NODE_BASE=node:24-bookworm-slim$/m);
    assert.match(dockerfile, /\bffmpeg\b/);
    assert.match(dockerfile, /\bpython3\b/);
});

test('onlyoffice-agent workflow layers Node onto the standard Document Server image', () => {
    const workflow = read('.github/workflows/publish-onlyoffice-agent-image.yml');
    const dockerfile = read('images/onlyoffice-agent/Dockerfile');

    assert.match(workflow, /images\/onlyoffice-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/onlyoffice-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /onlyoffice_base_image=docker\.io\/onlyoffice\/documentserver:\$\{onlyoffice_version\}/);
    assert.match(workflow, /test -x \/app\/ds\/run-document-server\.sh/);

    assert.match(dockerfile, /^ARG NODE_RUNTIME_IMAGE=docker\.io\/library\/node:24-bookworm-slim$/m);
    assert.match(dockerfile, /^ARG ONLYOFFICE_BASE_IMAGE=docker\.io\/onlyoffice\/documentserver:9\.3\.1$/m);
    assert.match(dockerfile, /^FROM \$\{NODE_RUNTIME_IMAGE\} AS node-runtime$/m);
    assert.match(dockerfile, /^FROM \$\{ONLYOFFICE_BASE_IMAGE\}$/m);
    assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
    assert.match(dockerfile, /\/usr\/local\/bin\/npm/);
    assert.match(dockerfile, /\bgit\b/);
    assert.match(dockerfile, /\bpython3\b/);
    assert.match(dockerfile, /\bmake\b/);
});

test('webtty-agent workflow builds and publishes the node-pty terminal image', () => {
    const workflow = read('.github/workflows/publish-webtty-agent-image.yml');
    const dockerfile = read('images/webtty-agent/Dockerfile');

    assert.match(workflow, /images\/webtty-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/webtty-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools$/m);
    assert.match(dockerfile, /\bnode-pty\b/);
});

test('web-publishing-agent workflow builds the nginx and cloudflared image', () => {
    const workflow = read('.github/workflows/publish-web-publishing-agent-image.yml');
    const dockerfile = read('images/web-publishing-agent/Dockerfile');

    assert.match(workflow, /images\/web-publishing-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/web-publishing-agent/);
    assert.match(workflow, /DEFAULT_IMAGE_TAG:\s*node24-nginx-cloudflared/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /- name: Build and push\s+id: build\s+uses: docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /docker run --rm "\$IMAGE_NAME:smoke" sh -c 'node --version && nginx -v && cloudflared --version'/);
    assert.match(workflow, /nginx -v/);
    assert.match(workflow, /cloudflared --version/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG CLOUDFLARED_IMAGE=docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:[0-9a-f]{64}$/m);
    assert.match(workflow, /default: 'docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:[0-9a-f]{64}'/);
    assert.match(workflow, /default: 'docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}'/);
    assert.match(workflow, /DEFAULT_CLOUDFLARED_IMAGE:\s*docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:[0-9a-f]{64}/);
    assert.match(workflow, /DEFAULT_BASE_IMAGE:\s*docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}/);
    assert.match(workflow, /digest_ref_pattern='[^'\n]*@sha256:\[0-9a-f\]\{64\}\$'/);
    assert.match(workflow, /cloudflared_image must be an immutable tag@sha256 manifest digest reference/);
    assert.match(workflow, /base_image must be an immutable tag@sha256 manifest digest reference/);
    assert.match(workflow, /Validate multiarchitecture source manifests/);
    assert.match(workflow, /docker manifest inspect "\$source_ref"/);
    assert.match(workflow, /\.platform\.architecture == "amd64"/);
    assert.match(workflow, /\.platform\.architecture == "arm64"/);
    assert.match(dockerfile, /^FROM \$\{CLOUDFLARED_IMAGE\} AS cloudflared$/m);
    assert.match(dockerfile, /^FROM \$\{BASE_IMAGE\}$/m);
    assert.match(dockerfile, /COPY --from=cloudflared \/usr\/local\/bin\/cloudflared \/usr\/local\/bin\/cloudflared/);
    assert.match(dockerfile, /^ENV PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
    assert.match(dockerfile, /\bnginx\b/);
    assert.match(dockerfile, /\bca-certificates\b/);
    assert.match(dockerfile, /\bopenssl\b/);
    assert.match(dockerfile, /^ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m);
    assert.match(dockerfile, /^ARG CA_CERTIFICATES_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG NGINX_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG OPENSSL_VERSION=\S+$/m);
    assert.match(dockerfile, /VERSION_CODENAME=bookworm/);
    assert.match(dockerfile, /\/etc\/apt\/sources\.list\.d\/\*\.list/);
    assert.match(dockerfile, /\/etc\/apt\/sources\.list\.d\/\*\.sources/);
    assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\} bookworm main/);
    assert.match(dockerfile, /"ca-certificates=\$\{CA_CERTIFICATES_VERSION\}"/);
    assert.match(dockerfile, /"nginx=\$\{NGINX_VERSION\}"/);
    assert.match(dockerfile, /"openssl=\$\{OPENSSL_VERSION\}"/);
    assert.match(workflow, /outputs:\s+digest:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.match(workflow, /Published immutable image:/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(dockerfile, /^USER web-publishing$/m);
    assert.match(dockerfile, /CMD \["node", "\/code\/runtime\/supervisor\.mjs"\]/);
});

test('llm-runtime-cpu workflow builds the real CPU runtime image', () => {
    const workflow = read('.github/workflows/publish-llm-runtime-cpu-image.yml');
    const dockerfile = read('images/llm-runtime-cpu/Dockerfile');

    assert.match(workflow, /images\/llm-runtime-cpu/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/llm-runtime-cpu/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /runs-on:\s*ubuntu-24\.04-arm/);
    assert.match(workflow, /DEFAULT_PLATFORMS:\s*linux\/arm64/);
    assert.match(workflow, /llama-server --version/);
    assert.match(dockerfile, /^ARG NODE_BASE=node:24-bookworm-slim$/m);
    assert.match(dockerfile, /^ARG LLAMA_CPP_REF=b6412$/m);
    assert.match(dockerfile, /\bhuggingface_hub\b/);
    assert.match(dockerfile, /\bllama-server\b/);
    assert.match(dockerfile, /GGML_NATIVE=OFF/);
    assert.match(dockerfile, /\/models\/hf-cache/);
    assert.match(dockerfile, /\/models\/artifacts/);
    assert.match(dockerfile, /\/models\/derived/);
});

test('default-local-llm workflow publishes the Qwen2.5 Coder image as multi-arch', () => {
    const workflow = read('.github/workflows/publish-default-local-llm-image.yml');
    const dockerfile = read('images/default-local-llm/Dockerfile');

    assert.match(workflow, /IMAGE_NAME:\s*assistos\/default-local-llm/);
    assert.match(workflow, /default:\s*cpu-qwen25-coder-1\.5b/);
    assert.match(workflow, /default:\s*bartowski\/Qwen2\.5-Coder-1\.5B-Instruct-GGUF/);
    assert.match(workflow, /default:\s*Qwen2\.5-Coder-1\.5B-Instruct-Q4_K_M\.gguf/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(workflow, /push-by-digest=true/);
    assert.match(workflow, /docker run --rm "docker\.io\/\$\{IMAGE_NAME\}@\$\{\{ steps\.build\.outputs\.digest \}\}"/);
    assert.match(workflow, /docker buildx imagetools create/);
    assert.match(workflow, /grep -q 'linux\/amd64'/);
    assert.match(workflow, /grep -q 'linux\/arm64'/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools$/m);
    assert.match(dockerfile, /^ARG MODEL_REPO=bartowski\/Qwen2\.5-Coder-1\.5B-Instruct-GGUF$/m);
    assert.match(dockerfile, /^ARG MODEL_FILE=Qwen2\.5-Coder-1\.5B-Instruct-Q4_K_M\.gguf$/m);
    assert.match(dockerfile, /GGML_NATIVE=OFF/);
    assert.match(dockerfile, /llama-server/);
});

test('umami-agent workflow builds the all-in-one Umami stack', () => {
    const workflow = read('.github/workflows/publish-umami-agent-image.yml');
    const dockerfile = read('images/umami-agent/Dockerfile');

    assert.match(workflow, /images\/umami-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/umami-agent/);
    assert.match(workflow, /DEFAULT_IMAGE_TAG:\s*umami-stack/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /postgres --version/);
    assert.match(workflow, /bun --version/);
    assert.match(workflow, /\/opt\/umami-mcp\/dist\/index\.js/);

    assert.match(dockerfile, /^ARG UMAMI_BASE_IMAGE=docker\.umami\.is\/umami-software\/umami:postgresql-latest$/m);
    assert.match(dockerfile, /\bpostgresql\b/);
    assert.match(dockerfile, /\bpostgresql-client\b/);
    assert.match(dockerfile, /\bpostgresql-contrib\b/);
    assert.match(dockerfile, /\bsu-exec\b/);
    assert.match(dockerfile, /BUN_INSTALL=\/opt\/bun/);
    assert.match(dockerfile, /github\.com\/MadsNyl\/umami-mcp\.git/);
    assert.match(dockerfile, /bun install --frozen-lockfile/);
    assert.match(dockerfile, /bun run build/);
});

test('bwrap-runner workflow builds source checkout with centralized Dockerfile', () => {
    const workflow = read('.github/workflows/publish-bwrap-runner.yml');
    const dockerfile = read('images/bwrap-runner/Dockerfile');

    assert.match(workflow, /repository:\s*AssistOS-AI\/basic/);
    assert.match(workflow, /path:\s*sources\/basic/);
    assert.match(workflow, /git -C sources\/basic rev-parse --short=12 HEAD/);
    assert.match(workflow, /context:\s*\.\/sources\/basic\/bwrap-runner/);
    assert.match(workflow, /file:\s*\.\/images\/bwrap-runner\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/bwrap-runner/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(dockerfile, /^FROM node:24\.15\.0-bookworm-slim$/m);
    assert.match(dockerfile, /COPY\s+bin\/\s+\/opt\/bwrap-runner\/bin\//);
    assert.match(dockerfile, /COPY\s+lib\/\s+\/opt\/bwrap-runner\/lib\//);
    assert.match(dockerfile, /\/usr\/local\/bin\/bwrap-sandbox-exec/);
});

test('livekit workflow builds source checkout with centralized Dockerfile', () => {
    const workflow = read('.github/workflows/publish-livekit-server-agent.yml');
    const dockerfile = read('images/livekit-server-agent/Dockerfile');

    assert.match(workflow, /repository:\s*AssistOS-AI\/webmeetInfra/);
    assert.match(workflow, /path:\s*sources\/webmeetInfra/);
    assert.match(workflow, /source_ref:[\s\S]*?required:\s*true/);
    assert.doesNotMatch(workflow, /source_ref:[\s\S]*?default:\s*['"]?main/);
    assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(workflow, /refs\/heads\/ploinky-box/);
    assert.match(workflow, /git -C sources\/webmeetInfra rev-parse HEAD/);
    assert.match(workflow, /Verify host-hook-only credential contract/);
    assert.match(workflow, /\$matches\[0\]\.sharedGeneratedSecret == true\s+and \$matches\[0\]\.runtime == false/);
    assert.match(workflow, /\(\$matches \| length\) == 1/);
    assert.match(workflow, /for profile in default dev prod/);
    assert.match(workflow, /WEBMEET_LIVEKIT_API_KEY WEBMEET_LIVEKIT_API_SECRET WEBMEET_TURN_AUTH_SECRET/);
    assert.match(workflow, /sources\/webmeetInfra\/liveKitServerAgent\/manifest\.json/);
    assert.match(workflow, /sources\/webmeetInfra\/turnServerAgent\/manifest\.json/);
    assert.match(workflow, /context:\s*\.\/sources\/webmeetInfra\/liveKitServerAgent/);
    assert.match(workflow, /file:\s*\.\/images\/livekit-server-agent\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/livekit-server-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /- name: Build and push\s+id: build\s+uses: docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /Smoke build local architecture/);
    assert.match(workflow, /docker build[\s\S]*sources\/webmeetInfra\/liveKitServerAgent/);
    assert.match(workflow, /for binary in livekit-server egress redis-server node npm git g\+\+ getent ip make curl nc tini/);
    assert.match(workflow, /for retired in turnserver nginx certbot python3/);
    // Base images are pinned by manifest digest, not tag alone (webmeet
    // network-hardening trim: resolved via the Docker Hub registry v2 API,
    // see the comment block above the ARG lines in the Dockerfile itself).
    assert.match(dockerfile, /^ARG LIVEKIT_SERVER_IMAGE=livekit\/livekit-server:v1\.11\.0@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG LIVEKIT_EGRESS_IMAGE=livekit\/egress:v1\.9\.1@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG NODE_BASE=node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG GIT_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG GXX_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG IPROUTE_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG LIBC_BIN_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG MAKE_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG NETCAT_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG TINI_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG REDIS_VERSION=\S+$/m);
    assert.match(dockerfile, /^ARG UBUNTU_SNAPSHOT=\d{8}T\d{6}Z$/m);
    assert.match(dockerfile, /snapshot\.ubuntu\.com\/ubuntu\/\$\{UBUNTU_SNAPSHOT\}/);
    assert.match(dockerfile, /"git=\$\{GIT_VERSION\}"/);
    assert.match(dockerfile, /"iproute2=\$\{IPROUTE_VERSION\}"/);
    assert.match(dockerfile, /"libc-bin=\$\{LIBC_BIN_VERSION\}"/);
    assert.match(dockerfile, /"redis-server=\$\{REDIS_VERSION\}"/);
    assert.match(dockerfile, /command -v getent/);
    assert.match(workflow, /outputs:\s+digest:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.match(workflow, /Published immutable image:/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.doesNotMatch(dockerfile, /scripts\/health\/livekit-server-agent-health\.sh/);
    assert.match(
        dockerfile,
        /ENTRYPOINT \["env", "-u", "WEBMEET_LIVEKIT_API_KEY", "-u", "WEBMEET_LIVEKIT_API_SECRET", "-u", "WEBMEET_TURN_AUTH_SECRET", "tini", "--"\]/,
    );
    assert.match(workflow, /pid1_env="\$\(tr "\\000" "\\n" < \/proc\/1\/environ\)"/);
    assert.match(workflow, /Normal Ploinky startup never puts[\s\S]*OCI Config\.Env/);
    assert.match(workflow, /WEBMEET_LIVEKIT_API_KEY WEBMEET_LIVEKIT_API_SECRET WEBMEET_TURN_AUTH_SECRET/);

    assert.match(dockerfile, /COPY\s+scripts\s+\/code\/scripts/);
    assert.match(dockerfile, /livekit-server/);
    assert.match(dockerfile, /\begress\b/);
    assert.match(dockerfile, /\bredis-server\b/);

    // Coturn/Nginx/Certbot were split out into a dedicated turnServerAgent
    // image (webmeet network-hardening design); this combined image must
    // never reintroduce them. python3 was the runtime for a synthetic
    // "python3 -m http.server" health endpoint in liveKitServerAgent's
    // supervisor script that is being removed as part of the same
    // cross-repo change — re-check this assertion if a future change adds
    // back a python3-dependent script here.
    assert.doesNotMatch(dockerfile, /\bcoturn\b/);
    assert.doesNotMatch(dockerfile, /\bnginx\b/);
    assert.doesNotMatch(dockerfile, /\bcertbot\b/);
    assert.doesNotMatch(dockerfile, /\bturnserver\b/);
    assert.doesNotMatch(dockerfile, /\bpython3\b/);
});

test('Ploinky network gateway is a fixed minimal raw-TCP to Unix-socket proxy', () => {
    const workflow = read('.github/workflows/publish-ploinky-network-gateway.yml');
    const dockerfile = read('images/ploinky-network-gateway/Dockerfile');
    const source = read('images/ploinky-network-gateway/main.go');
    const instructions = dockerfileInstructions(dockerfile);
    const fromInstructions = instructions.filter(({ keyword }) => keyword === 'FROM');

    assert.match(
        dockerfile,
        /^ARG GO_BUILDER=docker\.io\/library\/golang:1\.25\.6-alpine3\.22@sha256:[0-9a-f]{64}$/m,
    );
    assert.equal(fromInstructions.at(-1)?.source.trim(), 'FROM scratch');
    assert.match(dockerfile, /^USER 65532:65532$/m);
    assert.match(dockerfile, /^EXPOSE 8080\/tcp$/m);
    assert.match(dockerfile, /^ENTRYPOINT \["\/ploinky-network-gateway"\]$/m);
    assert.doesNotMatch(dockerfile, /^LABEL\s/m, 'image labels would be inherited by the exact-owned gateway container');
    assert.equal(instructions.filter(({ keyword }) => keyword === 'CMD').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'VOLUME').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'ENV').length, 0);

    assert.match(source, /listenAddress = ":8080"/);
    assert.match(source, /routerSocket\s+= "\/run\/ploinky\/router\.sock"/);
    assert.match(source, /net\.Listen\("tcp4", listenAddress\)/);
    assert.match(source, /net\.DialUnix\("unix", nil, &net\.UnixAddr\{Name: routerSocket/);
    assert.match(source, /arguments are not supported/);
    assert.doesNotMatch(source, /os\.Getenv|flag\.|http\.|agent|workspace|docker\.sock|podman\.sock/i);

    assert.match(workflow, /IMAGE_NAME:\s*assistos\/ploinky-network-gateway/);
    assert.match(workflow, /default: '1'/);
    assert.doesNotMatch(workflow, /default: ['"]?latest/);
    assert.match(workflow, /--read-only/);
    assert.match(workflow, /--cap-drop ALL/);
    assert.match(workflow, /--security-opt no-new-privileges/);
    assert.match(workflow, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=1m/);
    assert.match(workflow, /--sysctl net\.ipv4\.ip_forward=0/);
    assert.match(
        workflow,
        /type=bind,src=\$socket_path,dst=\/run\/ploinky\/router\.sock,readonly/,
    );
    assert.match(workflow, /test "\$\(docker inspect --format '\{\{len \.Mounts\}\}' "\$container"\)" = 1/);
    assert.doesNotMatch(workflow, /--privileged|--cap-add|seccomp=unconfined/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /outputs:[\s\S]*?digest:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(workflow, /\$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
});

test('soul-gateway workflow builds source checkout with SQLite and baked gateway code', () => {
    const workflow = read('.github/workflows/publish-soul-gateway-image.yml');
    const dockerfile = read('images/soul-gateway/Dockerfile');

    assert.match(workflow, /repository:\s*AssistOS-AI\/proxies/);
    assert.match(workflow, /path:\s*sources\/proxies/);
    assert.match(workflow, /git -C sources\/proxies rev-parse --short=12 HEAD/);
    assert.match(workflow, /context:\s*\.\/sources\/proxies\/soul-gateway/);
    assert.match(workflow, /file:\s*\.\/images\/soul-gateway\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/soul-gateway/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /node -e "import\('node:sqlite'\)/);
    assert.match(workflow, /sqlite3 --version/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools$/m);
    assert.match(dockerfile, /\bsqlite3\b/);
    assert.match(dockerfile, /WORKDIR \/opt\/soul-gateway/);
    assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
    assert.match(dockerfile, /RUN npm ci --omit=dev/);
    assert.match(dockerfile, /COPY src \/opt\/soul-gateway\/src/);
    assert.match(dockerfile, /COPY startup\.sh install\.sh cli\.sh \/\opt\/soul-gateway\//);
});

test('ploinky-box image is a source-free contract-3 scratch runtime', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const entrypoint = read('images/ploinky-box/entrypoint.sh');
    const instructions = dockerfileInstructions(dockerfile);
    const fromInstructions = instructions.filter(({ keyword }) => keyword === 'FROM');

    assert.match(dockerfile, /^ARG PODMAN_BASE=quay\.io\/podman\/stable$/m);
    assert.match(
        dockerfile,
        /^ARG NODE_RUNTIME_IMAGE=docker\.io\/library\/node:24-bookworm-slim$/m,
    );
    assert.match(
        dockerfile,
        /^COPY --from=node-runtime \/usr\/local\/bin\/node \/usr\/local\/bin\/node$/m,
    );
    assert.match(
        dockerfile,
        /^COPY --from=node-runtime \/usr\/local\/lib\/node_modules \/usr\/local\/lib\/node_modules$/m,
    );
    assert.match(
        dockerfile,
        /ln -s \/usr\/local\/lib\/node_modules\/npm\/bin\/npm-cli\.js \/usr\/local\/bin\/npm/,
    );
    assert.match(
        dockerfile,
        /ln -s \/usr\/local\/lib\/node_modules\/npm\/bin\/npx-cli\.js \/usr\/local\/bin\/npx/,
    );
    assert.match(dockerfile, /dnf install -y git libcap slirp4netns/);
    assert.equal(fromInstructions.at(-1)?.source.trim(), 'FROM scratch AS runtime');
    assert.match(dockerfile, /^COPY --from=prepared-rootfs \/ \/$/m);
    assert.match(dockerfile, /rpm --setcaps shadow-utils/);
    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.runtime-contract="3"$/m);
    assert.match(dockerfile, /\/etc\/subuid\)" = 65534/);
    assert.match(dockerfile, /\/etc\/subgid\)" = 65534/);
    assert.match(dockerfile, /\/opt\/ploinky\/node_modules/);
    assert.match(dockerfile, /echo 'assistos\/ploinky-box' > \/etc\/ploinky-box/);
    assert.match(dockerfile, /^ENV PATH=\/opt\/ploinky\/bin:\/usr\/local\/bin:\/usr\/bin \\$/m);
    for (const requiredEnv of [
        'USER=podman',
        'HOME=/home/podman',
        'PLOINKY_WORKSPACE_ROOT=/workspace',
        'PLOINKY_DISABLE_HOST_SANDBOX=1',
        'container=oci',
        '_CONTAINERS_USERNS_CONFIGURED=""',
        'BUILDAH_ISOLATION=chroot',
    ]) {
        assert.ok(dockerfile.includes(requiredEnv), `missing exact ENV ${requiredEnv}`);
    }
    assert.match(
        dockerfile,
        /^COPY images\/ploinky-box\/entrypoint\.sh \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.match(
        dockerfile,
        /^RUN chmod 0755 \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.match(dockerfile, /^USER podman$/m);
    assert.match(dockerfile, /^WORKDIR \/workspace$/m);
    assert.match(
        dockerfile,
        /^ENTRYPOINT \["\/usr\/local\/bin\/ploinky-box-entrypoint"\]$/m,
    );
    assert.doesNotMatch(dockerfile, /COPY sources\/ploinky/);
    assert.doesNotMatch(dockerfile, /npm install/);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'VOLUME').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'CMD').length, 0);

    for (const command of ['bash', 'node', 'npm', 'npx', 'git', 'podman']) {
        assert.match(
            entrypoint,
            new RegExp(
                '^command -v ' + command + ' >\\/dev\\/null 2>&1 \\|\\| fail "[^"\\n]+"$',
                'm',
            ),
        );
    }
    assert.match(entrypoint, /^test -f \/etc\/ploinky-box \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -x \/opt\/ploinky\/bin\/ploinky \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -d \/opt\/ploinky\/node_modules \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -w \/opt\/ploinky\/node_modules \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -w \/workspace \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -e \/dev\/fuse \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -e \/dev\/net\/tun \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /require_value PLOINKY_DISABLE_HOST_SANDBOX 1/);
    assert.match(entrypoint, /require_value _CONTAINERS_USERNS_CONFIGURED ''/);
    assert.match(entrypoint, /require_helper_privilege newuidmap cap_setuid/);
    assert.match(entrypoint, /require_helper_privilege newgidmap cap_setgid/);
    assert.match(entrypoint, /reset_ephemeral_podman_runtime/);
    assert.match(entrypoint, /\/tmp\/storage-run-\$uid/);
    assert.match(entrypoint, /\/tmp\/podman-run-\$uid/);
    assert.match(entrypoint, /podman unshare cat "\$proc_file"/);
    assert.match(entrypoint, /^EXPECTED_SUBORDINATE_IDS=65534$/m);
    assert.match(entrypoint, /^EXPECTED_MAPPED_IDS=65535$/m);
    assert.match(entrypoint, /configured" -eq "\$EXPECTED_SUBORDINATE_IDS/);
    assert.match(entrypoint, /mapped" -eq "\$EXPECTED_MAPPED_IDS/);
    assert.match(entrypoint, /^podman version >\/dev\/null 2>&1 \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /inner podman not functional: \$\{podman_info:-no diagnostic\}/);
    assert.match(entrypoint, /podman info --format '\{\{\.Host\.Security\.Rootless\}\}'/);
    assert.match(entrypoint, /inner Podman must be rootless/);
    assert.match(entrypoint, /^MANAGED_LABEL='io\.assistos\.ploinky\.managed=1'$/m);
    assert.match(
        entrypoint,
        /podman ps --all --quiet --filter "label=\$MANAGED_LABEL"/,
    );
    assert.match(entrypoint, /podman rm --force --time 0 "\$id"/);
    assert.match(entrypoint, /cannot enumerate Ploinky-managed nested containers/);
    assert.match(entrypoint, /cannot remove Ploinky-managed nested container/);
    assert.doesNotMatch(entrypoint, /podman rm (?:-a|--all|-af)\b/);
    assert.doesNotMatch(entrypoint, /podman rm[^\n]*--volumes/);
    assert.match(entrypoint, /^\s+exec "\$@"$/m);
    assert.match(entrypoint, /^exec sleep infinity$/m);
    assert.doesNotMatch(entrypoint, /achillesAgentLib/);
    assert.doesNotMatch(entrypoint, /mcp-sdk/);
});

test('ploinky-box workflow gates native contract-3 digests before moving runtime', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const resolveJob = workflow.match(/\n  resolve-source:[\s\S]*?(?=\n  build:)/)?.[0] || '';
    const buildJob = workflow.match(/\n  build:[\s\S]*?(?=\n  merge:)/)?.[0] || '';
    const mergeJob = workflow.match(/\n  merge:[\s\S]*$/)?.[0] || '';
    const metadataGate = buildJob.match(
        /- name: Inspect exact contract-3 metadata and platform[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';

    assert.ok(resolveJob);
    assert.ok(buildJob);
    assert.ok(mergeJob);
    assert.match(workflow, /IMAGE_TAG:\s*runtime/);
    assert.doesNotMatch(workflow, /podman-node24-runtime-v1/);
    assert.doesNotMatch(workflow, /^\s+image_tag:/m);
    assert.doesNotMatch(workflow, /Verify immutable tag is unused/);
    assert.match(resolveJob, /source_sha:\s*\$\{\{ steps\.source\.outputs\.sha \}\}/);
    assert.match(resolveJob, /git -C sources\/ploinky rev-parse HEAD/);
    assert.match(buildJob, /ref:\s*\$\{\{ needs\.resolve-source\.outputs\.source_sha \}\}/);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(buildJob, /platform:\s*linux\/amd64/);
    assert.match(buildJob, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(buildJob, /setup-qemu-action/);
    assert.match(buildJob, /Require rootless Podman for contract-3 runtime gates/);
    assert.match(buildJob, /podman info --format '\{\{\.Host\.Security\.Rootless\}\}'/);
    assert.match(buildJob, /push-by-digest=true/);
    assert.match(buildJob, /name-canonical=true/);
    assert.ok(metadataGate);
    assert.match(metadataGate, /io\.assistos\.ploinky\.runtime-contract/);
    assert.match(metadataGate, /runtime-contract"\] == "3"/);
    assert.match(metadataGate, /\(\$env \| length\) == 8/);
    for (const exactCheck of [
        '$env.PATH == "/opt/ploinky/bin:/usr/local/bin:/usr/bin"',
        '$env.USER == "podman"',
        '$env.HOME == "/home/podman"',
        '$env.PLOINKY_WORKSPACE_ROOT == "/workspace"',
        '$env.PLOINKY_DISABLE_HOST_SANDBOX == "1"',
        '$env.container == "oci"',
        '$env._CONTAINERS_USERNS_CONFIGURED == ""',
        '$env.BUILDAH_ISOLATION == "chroot"',
    ]) {
        assert.ok(metadataGate.includes(exactCheck), `metadata gate lacks exact check: ${exactCheck}`);
    }
    assert.match(metadataGate, /Config\.Cmd == null/);
    assert.match(metadataGate, /Config\.Volumes == null/);
    assert.match(buildJob, /ploinky-install-deps/);
    assert.match(buildJob, /sources\/ploinky:\/opt\/ploinky:ro/);
    assert.match(buildJob, /podman version/);
    assert.match(buildJob, /podman info/);
    assert.match(buildJob, /Host\.Security\.Rootless/);
    assert.match(buildJob, /--user podman/);
    assert.match(buildJob, /--device \/dev\/fuse/);
    assert.match(buildJob, /--device \/dev\/net\/tun/);
    assert.match(buildJob, /--security-opt unmask=ALL/);
    assert.doesNotMatch(buildJob, /--privileged/);
    assert.doesNotMatch(buildJob, /seccomp=unconfined/);
    assert.match(buildJob, /newuidmap/);
    assert.match(buildJob, /newgidmap/);
    assert.match(buildJob, /\/proc\/self\/uid_map/);
    assert.match(buildJob, /\/proc\/self\/gid_map/);
    assert.match(buildJob, /test "\$uid_configured" -eq 65534/);
    assert.match(buildJob, /test "\$gid_configured" -eq 65534/);
    assert.match(buildJob, /test "\$uid_mapped" -eq 65535/);
    assert.match(buildJob, /test "\$gid_mapped" -eq 65535/);
    assert.match(buildJob, /podman run -d --name "\$outer" --user podman[\s\S]*?--security-opt unmask=ALL/);
    assert.doesNotMatch(buildJob, /--privileged|--cap-add|seccomp=unconfined/);
    assert.match(buildJob, /docker\.io\/library\/alpine echo nested-ok/);
    assert.match(buildJob, /managed-running/);
    assert.match(buildJob, /managed-stopped/);
    assert.match(buildJob, /manual-running/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed=0/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed=10/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed-extra=1/);
    assert.match(buildJob, /sentinel-volume/);
    assert.match(buildJob, /injected managed-container enumeration failure/);
    assert.match(buildJob, /injected managed-container removal failure/);
    const descriptorIndex = buildJob.indexOf('Export gated candidate digest');
    const uploadIndex = buildJob.indexOf('Upload gated candidate digest');
    assert.ok(descriptorIndex > 0 && descriptorIndex < uploadIndex);
    assert.match(buildJob, /docker image inspect --format '\{\{\.Os\}\}\/\{\{\.Architecture\}\}'/);
    assert.match(buildJob, /actions\/upload-artifact@v4/);

    assert.match(mergeJob, /needs:\s*\n\s+- resolve-source\s*\n\s+- build/);
    assert.match(mergeJob, /actions\/download-artifact@v4/);
    assert.match(mergeJob, /test "\$\{#files\[@\]\}" -eq 2/);
    assert.match(mergeJob, /amd64_file=\/tmp\/ploinky-box-digests\/amd64\.txt/);
    assert.match(mergeJob, /arm64_file=\/tmp\/ploinky-box-digests\/arm64\.txt/);
    assert.match(mergeJob, /echo "amd64_digest=\$amd64_digest"/);
    assert.match(mergeJob, /echo "arm64_digest=\$arm64_digest"/);
    assert.match(mergeJob, /test "\$amd64_digest" != "\$arm64_digest"/);
    assert.match(mergeJob, /steps\.candidates\.outputs\.amd64_digest/);
    assert.match(mergeJob, /steps\.candidates\.outputs\.arm64_digest/);
    assert.match(mergeJob, /docker buildx imagetools create/);
    assert.match(mergeJob, /docker\.io\/\$\{IMAGE_NAME\}:\$\{IMAGE_TAG\}/);
    assert.match(mergeJob, /docker buildx imagetools inspect/);
    assert.match(mergeJob, /linux\/amd64/);
    assert.match(mergeJob, /linux\/arm64/);
    assert.match(mergeJob, /runtime_digest/);
    assert.doesNotMatch(buildJob, /Move runtime tag/);
});

test('ploinky-node does not install a container engine or client', () => {
    const dockerfile = read('images/ploinky-node/Dockerfile');
    const forbiddenTokens = [
        'podman',
        'docker-cli',
        'docker-ce',
        'docker-ce-cli',
        'docker.io',
        'moby-engine',
        'moby-cli',
    ];
    const forbiddenContainerEngine =
        /\b(?:podman|docker-cli|docker-ce|docker-ce-cli|docker\.io|moby-engine|moby-cli)\b/i;
    const runInstructions = dockerfileInstructions(dockerfile)
        .filter(({ keyword }) => keyword === 'RUN')
        .map(({ source }) => source)
        .join('\n');

    assert.doesNotMatch(runInstructions, forbiddenContainerEngine);

    const registryOnlyProbe = [
        'ARG NODE_BASE=docker.io/library/node:24-bookworm-slim',
        'FROM docker.io/library/node:24-bookworm-slim',
    ].join('\n');
    assert.deepEqual(
        dockerfileInstructions(registryOnlyProbe).filter(({ keyword }) => keyword === 'RUN'),
        [],
    );

    for (const token of forbiddenTokens) {
        const leadingWhitespaceProbe = dockerfileInstructions(
            `  RUN apt-get install -y ${token}`,
        )
            .filter(({ keyword }) => keyword === 'RUN')
            .map(({ source }) => source)
            .join('\n');
        assert.match(leadingWhitespaceProbe, forbiddenContainerEngine);
    }

    const continuationProbe = dockerfileInstructions(
        ['  RUN apt-get update \\', '    && apt-get install -y moby-cli'].join('\n'),
    )
        .filter(({ keyword }) => keyword === 'RUN')
        .map(({ source }) => source)
        .join('\n');
    assert.match(continuationProbe, forbiddenContainerEngine);
});
