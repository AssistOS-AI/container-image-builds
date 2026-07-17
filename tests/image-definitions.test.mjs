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
    const bindInterposer = read('images/onlyoffice-agent/docservice-loopback-bind.c');

    assert.match(workflow, /images\/onlyoffice-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/onlyoffice-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /--platform linux\/amd64,linux\/arm64/);
    assert.match(workflow, /expected_digest:[\s\S]*required:\s*true/);
    assert.match(workflow, /Verify archive digest and platform set before registry mutation/);
    assert.match(workflow, /skopeo copy --all/);
    assert.match(workflow, /remote_digest.*EXPECTED_DIGEST/);
    assert.doesNotMatch(workflow, /onlyoffice_version|node_runtime_image|ONLYOFFICE_BASE_IMAGE=/);
    assert.doesNotMatch(workflow, /^\s*push:/m);
    assert.match(workflow, /test -x \/app\/ds\/run-document-server\.sh/);

    assert.match(dockerfile, /^FROM docker\.io\/library\/node:24-bookworm-slim@sha256:[0-9a-f]{64} AS node-runtime$/m);
    assert.match(dockerfile, /^FROM docker\.io\/onlyoffice\/documentserver:9\.3\.1@sha256:[0-9a-f]{64}$/m);
    assert.doesNotMatch(dockerfile, /^ARG (NODE_RUNTIME_IMAGE|ONLYOFFICE_BASE_IMAGE)=/m);
    assert.match(dockerfile, /snapshot\.ubuntu\.com\/ubuntu\/\$\{UBUNTU_SNAPSHOT\}/);
    assert.match(dockerfile, /"g\+\+=\$\{GXX_VERSION\}"/);
    assert.match(dockerfile, /"git=\$\{GIT_VERSION\}"/);
    assert.match(dockerfile, /"python3=\$\{PYTHON_VERSION\}"/);
    assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
    assert.match(dockerfile, /\/usr\/local\/bin\/npm/);
    assert.match(dockerfile, /\bgit\b/);
    assert.match(dockerfile, /\bpython3\b/);
    assert.match(dockerfile, /\bmake\b/);
    assert.match(dockerfile, /onlyoffice-docservice-loopback-bind\.so/);
    assert.match(dockerfile, /onlyoffice-v5\.contract/);
    assert.match(dockerfile, /interposer_sha256=/);
    assert.match(dockerfile, /chmod 0444/);
    assert.match(bindInterposer, /sin_port == htons\(8000\)/);
    assert.match(bindInterposer, /INADDR_ANY/);
    assert.match(bindInterposer, /INADDR_LOOPBACK/);
    assert.match(bindInterposer, /IN6_IS_ADDR_UNSPECIFIED/);
    assert.match(bindInterposer, /in6addr_loopback/);
    assert.match(bindInterposer, /docservice-v5-port-8000/);
});

test('webtty-agent workflow builds and publishes the node-pty terminal image', () => {
    const workflow = read('.github/workflows/publish-webtty-agent-image.yml');
    const dockerfile = read('images/webtty-agent/Dockerfile');
    const packageJson = JSON.parse(read('images/webtty-agent/app/package.json'));
    const html = read('images/webtty-agent/app/public/webtty.html');
    const startScript = read('images/webtty-agent/webtty-v5-start.sh');

    assert.match(workflow, /images\/webtty-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/webtty-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /DEFAULT_BASE_IMAGE:\s*docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}/);
    assert.match(workflow, /base_image must equal the reviewed immutable ploinky-node index/);
    assert.match(workflow, /webtty-v5\.contract/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /\bnode-pty\b/);
    assert.match(dockerfile, /public\/assets\/vendor\/xterm\/xterm\.js/);
    assert.match(dockerfile, /webtty-v5\.contract/);
    assert.match(dockerfile, /public-v5\.tar/);
    assert.match(dockerfile, /chmod 0444/);
    assert.match(dockerfile, /CMD \["\/usr\/local\/bin\/webtty-v5-start"\]/);
    assert.match(startScript, /contract_version=5/);
    assert.match(startScript, /package_lock_sha256/);
    assert.match(startScript, /server_sha256/);
    assert.match(startScript, /public_archive_sha256/);
    assert.match(startScript, /exec node/);
    assert.equal(packageJson.dependencies.xterm, '5.3.0');
    assert.equal(packageJson.dependencies['xterm-addon-fit'], '0.8.0');
    assert.equal(packageJson.dependencies['xterm-addon-web-links'], '0.9.0');
    assert.match(html, /assets\/vendor\/xterm\/xterm\.js/);
    assert.match(html, /assets\/vendor\/xterm\/xterm\.css/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /\bunpkg\b|jsdelivr|cdnjs/i);
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
    assert.match(workflow, /docker\/login-action@[0-9a-f]{40}/);
    assert.match(workflow, /docker\/build-push-action@[0-9a-f]{40}/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /postgres --version/);
    assert.match(workflow, /bun --version/);
    assert.match(workflow, /\/opt\/umami-mcp\/dist\/index\.js/);

    assert.match(dockerfile, /^FROM docker\.umami\.is\/umami-software\/umami:3\.2\.0@sha256:[0-9a-f]{64}$/m);
    assert.doesNotMatch(dockerfile, /^ARG (?:UMAMI_BASE_IMAGE|BUN_VERSION|UMAMI_MCP_(?:REF|COMMIT))=/m);
    assert.match(dockerfile, /\bpostgresql18=18\.4-r0\b/);
    assert.match(dockerfile, /\bpostgresql18-client=18\.4-r0\b/);
    assert.match(dockerfile, /\bpostgresql18-contrib=18\.4-r0\b/);
    assert.match(dockerfile, /\bsu-exec\b/);
    assert.match(dockerfile, /BUN_INSTALL=\/opt\/bun/);
    assert.match(dockerfile, /github\.com\/MadsNyl\/umami-mcp\.git/);
    assert.match(dockerfile, /git -C "\$\{UMAMI_MCP_DIR\}" checkout --detach FETCH_HEAD/);
    assert.match(dockerfile, /git -C "\$\{UMAMI_MCP_DIR\}" rev-parse HEAD/);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.match(dockerfile, /bun install --frozen-lockfile/);
    assert.match(dockerfile, /bun run build/);
    assert.doesNotMatch(dockerfile, /(?:postgresql-latest|curl[^\n]*\|\s*(?:ba)?sh|git clone --depth|refs\/heads\/|checkout (?:origin\/)?(?:main|master)\b)/);
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
    assert.match(workflow, /egress_image:[\s\S]*?required:\s*true/);
    assert.match(workflow, /docker\\\.io\/assistos\/livekit-egress@sha256/);
    assert.doesNotMatch(workflow, /source_ref:[\s\S]*?default:\s*['"]?main/);
    assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(workflow, /refs\/heads\/ploinky-box/);
    assert.match(workflow, /git -C sources\/webmeetInfra rev-parse HEAD/);
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
    assert.match(dockerfile, /^ARG LIVEKIT_EGRESS_IMAGE$/m);
    assert.match(workflow, /--build-arg LIVEKIT_EGRESS_IMAGE=/);
    assert.match(workflow, /build-args:[\s\S]*LIVEKIT_EGRESS_IMAGE=/);
    assert.match(dockerfile, /livekit-egress-loopback-v5\.contract/);
    assert.match(dockerfile, /sha256sum --check --strict/);
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
    assert.match(dockerfile, /ENTRYPOINT \["tini", "--"\]/);

    assert.match(dockerfile, /COPY\s+scripts\s+\/code\/scripts/);
    assert.match(dockerfile, /livekit-server/);
    assert.match(dockerfile, /\begress\b/);
    assert.match(dockerfile, /\bredis-server\b/);

    // This image contains only the SFU, Egress, Redis, and their build/runtime
    // dependencies. python3 was the runtime for a synthetic
    // "python3 -m http.server" health endpoint in liveKitServerAgent's
    // supervisor script that is being removed as part of the same
    // cross-repo change — re-check this assertion if a future change adds
    // back a python3-dependent script here.
    assert.doesNotMatch(dockerfile, /\bcoturn\b/);
    assert.doesNotMatch(dockerfile, /\bturnserver\b/);
    assert.doesNotMatch(dockerfile, /\bnginx\b/);
    assert.doesNotMatch(dockerfile, /\bcertbot\b/);
    assert.doesNotMatch(dockerfile, /\bpython3\b/);
});

test('retired Ploinky network-gateway build artifacts stay absent', () => {
    assert.equal(
        fs.existsSync(path.join(repoRoot, 'images/ploinky-network-gateway')),
        false,
    );
    assert.equal(
        fs.existsSync(path.join(repoRoot, '.github/workflows/publish-ploinky-network-gateway.yml')),
        false,
    );
    assert.doesNotMatch(read('README.md'), /ploinky-network-gateway/);
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

test('ploinky-box image is a source-free contract-5 runtime with pinned cloudflared', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const entrypoint = read('images/ploinky-box/entrypoint.sh');
    const instructions = dockerfileInstructions(dockerfile);
    const fromInstructions = instructions.filter(({ keyword }) => keyword === 'FROM');

    assert.match(
        dockerfile,
        /^ARG PODMAN_BASE=quay\.io\/podman\/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964$/m,
    );
    assert.match(
        dockerfile,
        /^ARG NODE_RUNTIME_IMAGE=docker\.io\/library\/node:24-bookworm-slim$/m,
    );
    assert.match(
        dockerfile,
        /^ARG CLOUDFLARED_IMAGE=docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe$/m,
    );
    assert.match(dockerfile, /^FROM \$CLOUDFLARED_IMAGE AS cloudflared$/m);
    assert.match(
        dockerfile,
        /^COPY --from=cloudflared \/usr\/local\/bin\/cloudflared \/usr\/local\/bin\/cloudflared$/m,
    );
    assert.match(dockerfile, /a76297bc59df96887b94d8cdb2aabe2401fc7b2bf3527b05d9a311b7341d190a/);
    assert.match(dockerfile, /254ee7bd4966d32e87c3d223c4b90d2b8f49e0a6a468484a09ea6346b50b2957/);
    assert.match(dockerfile, /sha256sum --check --strict/);
    assert.match(dockerfile, /cloudflared --version/);
    assert.match(dockerfile, /cloudflared tunnel run --help/);
    assert.match(dockerfile, /--token-file/);
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
    assert.equal(fromInstructions.at(-1)?.source.trim(), 'FROM scratch AS runtime');
    assert.match(dockerfile, /^COPY --from=prepared-rootfs \/ \/$/m);
    assert.match(dockerfile, /rpm --setcaps shadow-utils/);
    assert.match(
        dockerfile,
        /dnf install -y git iproute libcap netavark aardvark-dns passt slirp4netns util-linux-core/,
    );
    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.runtime-contract="5"$/m);
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

    for (const command of ['bash', 'node', 'npm', 'npx', 'git', 'podman', 'ss', 'nsenter']) {
        assert.match(
            entrypoint,
            new RegExp(
                '^command -v ' + command + ' >\\/dev\\/null 2>&1 \\|\\| fail "[^"\\n]+"$',
                'm',
            ),
        );
    }
    assert.match(entrypoint, /^EXPECTED_CLOUDFLARED_VERSION=2026\.7\.1$/m);
    assert.match(entrypoint, /require_cloudflared_contract/);
    assert.match(entrypoint, /cloudflared tunnel run --help/);
    assert.match(entrypoint, /--token-file/);
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
    assert.match(entrypoint, /^MINIMUM_PODMAN_VERSION=5\.4$/m);
    assert.match(entrypoint, /inner Podman network backend must be netavark/);
    assert.match(entrypoint, /command -v pasta/);
    assert.match(entrypoint, /pasta --version/);
    assert.match(entrypoint, /^MANAGED_LABEL='io\.assistos\.ploinky\.managed=1'$/m);
    assert.match(
        entrypoint,
        /podman ps --all --quiet --filter "label=\$MANAGED_LABEL"/,
    );
    assert.match(entrypoint, /cannot enumerate Ploinky-managed nested containers/);
    assert.match(entrypoint, /retained Ploinky-managed nested containers were found/);
    assert.match(entrypoint, /v5 will not delete or import old state/);
    assert.doesNotMatch(entrypoint, /podman rm/);
    assert.match(entrypoint, /^\s+exec "\$@"$/m);
    assert.match(entrypoint, /^exec sleep infinity$/m);
    assert.doesNotMatch(entrypoint, /achillesAgentLib/);
    assert.doesNotMatch(entrypoint, /mcp-sdk/);
});

test('ploinky-box workflow gates native contract-5 digests before moving runtime', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const resolveJob = workflow.match(/\n  resolve-source:[\s\S]*?(?=\n  build:)/)?.[0] || '';
    const buildJob = workflow.match(/\n  build:[\s\S]*?(?=\n  merge:)/)?.[0] || '';
    const mergeJob = workflow.match(/\n  merge:[\s\S]*$/)?.[0] || '';
    const metadataGate = buildJob.match(
        /- name: Inspect exact contract-5 metadata and platform[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';

    assert.ok(resolveJob);
    assert.ok(buildJob);
    assert.ok(mergeJob);
    assert.match(workflow, /IMAGE_TAG:\s*runtime/);
    assert.doesNotMatch(workflow, /podman-node24-runtime-v1/);
    assert.doesNotMatch(workflow, /^\s+image_tag:/m);
    assert.doesNotMatch(workflow, /Verify immutable tag is unused/);
    assert.match(resolveJob, /source_sha:\s*\$\{\{ steps\.source\.outputs\.sha \}\}/);
    assert.match(resolveJob, /\[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    assert.doesNotMatch(resolveJob, /default:\s*master/);
    assert.match(resolveJob, /git -C sources\/ploinky rev-parse HEAD/);
    assert.match(buildJob, /ref:\s*\$\{\{ needs\.resolve-source\.outputs\.source_sha \}\}/);
    assert.match(buildJob, /Gate checked-out Ploinky contract-5 source/);
    assert.match(buildJob, /REQUIRED_RUNTIME_CONTRACT/);
    assert.match(buildJob, /assert\.equal\([\s\S]*?REQUIRED_RUNTIME_CONTRACT,[\s\S]*?'5'/);
    assert.match(buildJob, /networkHardCutSourceAbsence\.test\.mjs/);
    assert.match(buildJob, /networkContract\.test\.mjs/);
    assert.match(buildJob, /networkLifecycle\.test\.mjs/);
    assert.match(buildJob, /runtimeDocumentation\.test\.mjs/);
    assert.match(buildJob, /container\/runtime-supervisor-tests\.mjs/);
    const sourceGateIndex = buildJob.indexOf('Gate checked-out Ploinky contract-5 source');
    const candidateBuildIndex = buildJob.indexOf('Build and push candidate by digest');
    assert.ok(sourceGateIndex > 0 && sourceGateIndex < candidateBuildIndex);
    assert.ok(buildJob.indexOf('container/runtime-supervisor-tests.mjs') < candidateBuildIndex);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(buildJob, /platform:\s*linux\/amd64/);
    assert.match(buildJob, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(buildJob, /setup-qemu-action/);
    assert.match(
        buildJob,
        /docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe/,
    );
    assert.match(buildJob, /Verify pinned multiarchitecture cloudflared source/);
    assert.match(buildJob, /docker buildx imagetools inspect --raw/);
    assert.match(buildJob, /cloudflared_sha256:/);
    assert.match(buildJob, /sha256sum --check --strict/);
    assert.match(buildJob, /cloudflared tunnel run --help/);
    assert.match(buildJob, /--token-file/);
    assert.match(buildJob, /Require rootless Podman for contract-5 runtime gates/);
    assert.match(buildJob, /podman info --format '\{\{\.Host\.Security\.Rootless\}\}'/);
    assert.match(buildJob, /push-by-digest=true/);
    assert.match(buildJob, /name-canonical=true/);
    assert.ok(metadataGate);
    assert.match(metadataGate, /io\.assistos\.ploinky\.runtime-contract/);
    assert.match(metadataGate, /runtime-contract"\] == "5"/);
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
    assert.match(buildJob, /Gate exact fixed outer publications and lifecycle/);
    assert.match(buildJob, /container\/smoke-runtime\.mjs/);
    for (const sourceRef of [
        'explorer_ref',
        'webmeet_infra_ref',
        'umami_ref',
        'achilles_cli_ref',
        'proxies_ref',
        'basic_ref',
    ]) {
        assert.match(workflow, new RegExp(`${sourceRef}:[\\s\\S]*?required:\\s*true`));
        assert.match(buildJob, new RegExp(`inputs\\.${sourceRef}`));
    }
    assert.match(buildJob, /Require immutable full-graph source SHAs/);
    assert.match(buildJob, /\[\[ "\$sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    assert.match(buildJob, /SMOKE_FULL_GRAPH_ARGS_JSON:\s*'\["start","AssistOSExplorer\/explorer","18080"\]'/);
    assert.match(buildJob, /SMOKE_FULL_GRAPH_REPOSITORIES_JSON/);
    for (const repository of [
        'AchillesCLI',
        'AssistOSExplorer',
        'UmamiAgent',
        'basic',
        'container-image-builds',
        'proxies',
        'webmeetInfra',
    ]) {
        assert.match(buildJob, new RegExp(`full-workspace/${repository}`));
    }
    assert.match(buildJob, /podman --version/);
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
    assert.match(buildJob, /run -d --name "\$outer" --user podman[\s\S]*?--security-opt unmask=ALL/);
    assert.doesNotMatch(buildJob, /--privileged|--cap-add|seccomp=unconfined/);
    assert.doesNotMatch(buildJob, /slirp4netns:allow_host_loopback=true/);
    assert.match(buildJob, /Gate contract-5 hard cut and native host-gateway topology/);
    assert.match(buildJob, /old-gateway/);
    assert.match(buildJob, /old-default-agent/);
    assert.match(buildJob, /old-multi-agent/);
    assert.match(buildJob, /manual-running/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed=0/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed=10/);
    assert.match(buildJob, /io\.assistos\.ploinky\.managed-extra=1/);
    assert.match(buildJob, /sentinel-volume/);
    assert.match(buildJob, /hard-cut-workspace-sentinel/);
    assert.match(buildJob, /hard-cut-storage-sentinel/);
    assert.match(buildJob, /hard-cut-deps-sentinel/);
    assert.match(buildJob, /createNetworkLifecycleAdapter/);
    assert.match(buildJob, /lifecycle\.ensureNetwork\('primary'\)/);
    assert.match(buildJob, /lifecycle\.ensureNetwork\('secondary'\)/);
    assert.match(buildJob, /reused\.created, false/);
    assert.match(buildJob, /lifecycle\.runManagedContainerTransaction/);
    assert.match(buildJob, /lifecycle\.agentIdentityLabelArgs\(network\)/);
    assert.match(buildJob, /lifecycle\.verifyContainerContract/);
    assert.match(buildJob, /buildRuntimeRouterEnv\('podman'/);
    assert.match(buildJob, /networkContractHash\(defaultNetwork\)/);
    assert.match(buildJob, /networkContractHash\(bridgeNetwork\)/);
    assert.match(buildJob, /schema2-networks-before-hard-cut\.json/);
    assert.match(buildJob, /managed-topology\.json/);
    assert.doesNotMatch(buildJob, /managed_args=/);
    assert.doesNotMatch(buildJob, /run_outer 3/);
    assert.match(buildJob, /PLOINKY_ROUTER_URL\)" = "http:\/\/host\.containers\.internal:8080"/);
    assert.match(buildJob, /PLOINKY_INTERNAL_ROUTER_URL\)" = "http:\/\/host\.containers\.internal:\$router_port"/);
    assert.match(buildJob, /RoutingServer\.js/);
    assert.match(buildJob, /PORT=8080/);
    assert.match(buildJob, /router_port=8081/);
    assert.match(buildJob, /podman exec "\$agent" nc -z -w 3 host\.containers\.internal 8080/);
    assert.match(buildJob, /! podman exec "\$agent" wget -T 3 -qO- http:\/\/host\.containers\.internal:8080\/status/);
    assert.match(buildJob, /! podman exec default-agent wget -T 3 -qO- http:\/\/host\.containers\.internal:8080\/status/);
    assert.match(buildJob, /nc -z -w 3 host\.containers\.internal "\$router_port"/);
    assert.doesNotMatch(buildJob, /18081/);
    assert.match(buildJob, /same-network-peer/);
    assert.match(buildJob, /isolated-peer/);
    assert.match(buildJob, /https:\/\/example\.com/);
    assert.match(buildJob, /host\.containers\.internal:18082/);
    assert.match(buildJob, /networks-before-router-restart\.json/);
    assert.match(buildJob, /networks-after-router-restart\.json/);
    assert.match(buildJob, /rpm -q netavark aardvark-dns passt/);
    assert.match(buildJob, /pasta --version/);
    assert.match(buildJob, /injected managed-container enumeration failure/);
    assert.match(buildJob, /EXPLICIT-MANAGED-STATE-REMOVAL-OK/);
    assert.match(buildJob, /retained-managed-target/);
    assert.match(buildJob, /v5 will not delete or import old state/);
    const descriptorIndex = buildJob.indexOf('Export gated candidate digest');
    const uploadIndex = buildJob.indexOf('Upload gated candidate digest');
    assert.ok(descriptorIndex > 0 && descriptorIndex < uploadIndex);
    assert.match(buildJob, /docker image inspect --format '\{\{\.Os\}\}\/\{\{\.Architecture\}\}'/);
    assert.match(buildJob, /actions\/upload-artifact@[0-9a-f]{40}/);

    assert.match(mergeJob, /needs:\s*\n\s+- resolve-source\s*\n\s+- build/);
    assert.match(mergeJob, /actions\/download-artifact@[0-9a-f]{40}/);
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
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, `workflow action is not SHA-pinned: ${use[0]}`);
    }
});

test('runtime channel documentation requires an explicit destroy/recreate boundary', () => {
    const readme = read('README.md');

    assert.match(readme, /consults the channel only when creating[\s\S]*?after an explicit destroy/);
    assert.match(readme, /configuration[\s\S]*?drift is rejected before mutation/);
    assert.match(readme, /explicit destroy followed by[\s\S]*?recreate/);
    assert.match(readme, /release channel[\s\S]*?separately authorized registry release action/);
    assert.match(readme, /never a supervisor transaction/);
    assert.doesNotMatch(readme, /supervisor creates a missing outer box or performs a current-contract/);
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
