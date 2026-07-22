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
    assert.match(dockerfile, /onlyoffice\.contract/);
    assert.match(dockerfile, /interposer_sha256=/);
    assert.match(dockerfile, /chmod 0444/);
    assert.match(bindInterposer, /sin_port == htons\(8000\)/);
    assert.match(bindInterposer, /INADDR_ANY/);
    assert.match(bindInterposer, /INADDR_LOOPBACK/);
    assert.match(bindInterposer, /IN6_IS_ADDR_UNSPECIFIED/);
    assert.match(bindInterposer, /in6addr_loopback/);
    assert.match(bindInterposer, /docservice-port-8000/);
});

test('webtty-agent workflow builds and publishes the node-pty terminal image', () => {
    const workflow = read('.github/workflows/publish-webtty-agent-image.yml');
    const dockerfile = read('images/webtty-agent/Dockerfile');
    const packageJson = JSON.parse(read('images/webtty-agent/app/package.json'));
    const html = read('images/webtty-agent/app/public/webtty.html');
    const startScript = read('images/webtty-agent/webtty-start.sh');

    assert.match(workflow, /images\/webtty-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/webtty-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /DEFAULT_BASE_IMAGE:\s*docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}/);
    assert.match(workflow, /base_image must equal the reviewed immutable ploinky-node index/);
    assert.match(workflow, /webtty\.contract/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, /\bnode-pty\b/);
    assert.match(dockerfile, /public\/assets\/vendor\/xterm\/xterm\.js/);
    assert.match(dockerfile, /webtty\.contract/);
    assert.match(dockerfile, /public\.tar/);
    assert.match(dockerfile, /chmod 0444/);
    assert.match(dockerfile, /CMD \["\/usr\/local\/bin\/webtty-start"\]/);
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
    assert.match(dockerfile, /livekit-egress-loopback\.contract/);
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

test('ploinky-box image is the exact contract-6 runtime assembled from immutable Ploinky source', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const instructions = dockerfileInstructions(dockerfile);
    const fromInstructions = instructions.filter(({ keyword }) => keyword === 'FROM');

    assert.match(
        dockerfile,
        /^ARG PODMAN_BASE=quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/m,
    );
    assert.match(
        dockerfile,
        /^ARG CLOUDFLARED_IMAGE=docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:[0-9a-f]{64}$/m,
    );
    assert.equal(fromInstructions.at(-1)?.source.trim(), 'FROM scratch AS runtime');
    assert.match(dockerfile, /^COPY --from=prepared-rootfs \/ \/$/m);
    assert.match(
        dockerfile,
        /^COPY sources\/ploinky\/ploinky-box\/entrypoint\/ploinky-box-entrypoint \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.doesNotMatch(dockerfile, /COPY images\/ploinky-box\/entrypoint\.sh/);
    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.runtime-contract="6"$/m);
    assert.match(dockerfile, /printf '6\\n' > \/etc\/ploinky-box/);
    assert.match(
        dockerfile,
        /rm -f \/home\/podman\/\.config\/containers\/containers\.conf/,
    );
    assert.match(dockerfile, /dnf install -y git iproute libcap netavark aardvark-dns passt slirp4netns util-linux-core/);
    assert.match(dockerfile, /cloudflared tunnel run --help/);
    assert.match(dockerfile, /--token-file/);
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
    assert.match(dockerfile, /^USER podman$/m);
    assert.match(dockerfile, /^WORKDIR \/workspace$/m);
    assert.match(
        dockerfile,
        /^ENTRYPOINT \["\/usr\/local\/bin\/ploinky-box-entrypoint"\]$/m,
    );
    assert.equal(instructions.filter(({ keyword }) => keyword === 'EXPOSE').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'VOLUME').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'CMD').length, 0);
    assert.doesNotMatch(dockerfile, /npm install/);
});

test('ploinky-box workflow gates contract-6 native digests and exact publications before moving runtime', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const buildJob = workflow.match(/\n  build:[\s\S]*?(?=\n  merge:)/)?.[0] || '';
    const mergeJob = workflow.match(/\n  merge:[\s\S]*$/)?.[0] || '';

    assert.ok(buildJob);
    assert.ok(mergeJob);
    assert.match(workflow, /source_ref:[\s\S]*?required:\s*true/);
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
    assert.match(buildJob, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(buildJob, /platform:\s*linux\/amd64/);
    assert.match(buildJob, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(buildJob, /setup-qemu-action/);
    assert.match(buildJob, /Build and push candidate by digest/);
    assert.match(buildJob, /push-by-digest=true/);
    assert.match(buildJob, /name-canonical=true/);
    assert.match(buildJob, /runtime-contract"\] == "6"/);
    assert.match(buildJob, /ExposedPorts == null/);
    assert.match(buildJob, /PLOINKY_BOX_REQUIRE_PODMAN:\s*["']?1/);
    assert.match(buildJob, /PLOINKY_BOX_CANDIDATE_DIGEST/);
    assert.match(buildJob, /SMOKE_GRAPH_ARGS_JSON/);
    assert.match(buildJob, /SMOKE_GRAPH_REPOSITORIES_JSON/);
    assert.match(buildJob, /SMOKE_GRAPH_REVISIONS_JSON/);
    assert.match(buildJob, /ploinkyBoxNative\.test\.mjs/);
    assert.match(buildJob, /ploinkyBoxSmokeGraph\.test\.mjs/);
    assert.match(buildJob, /publicCli\.test\.mjs/);
    assert.match(buildJob, /--test-concurrency=1/);
    assert.doesNotMatch(buildJob, /--privileged|--cap-add|seccomp=unconfined/);
    assert.doesNotMatch(buildJob, /Move runtime tag/);
    assert.match(mergeJob, /test "\$\{#files\[@\]\}" -eq 2/);
    assert.match(mergeJob, /docker buildx imagetools create/);
    assert.match(mergeJob, /linux\/amd64/);
    assert.match(mergeJob, /linux\/arm64/);
    assert.match(mergeJob, /runtime_digest/);
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
