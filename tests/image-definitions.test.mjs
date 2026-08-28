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
    assert.match(dockerfile, /\bbubblewrap\b/);
    assert.match(dockerfile, /\bffmpeg\b/);
    assert.match(dockerfile, /\bpython3\b/);
    assert.match(dockerfile, /^USER 1000:1000$/m);
});

test('onlyoffice-agent workflow layers Node onto the standard Document Server image', () => {
    const workflow = read('.github/workflows/publish-onlyoffice-agent-image.yml');
    const dockerfile = read('images/onlyoffice-agent/Dockerfile');
    const bindInterposer = read('images/onlyoffice-agent/docservice-loopback-bind.c');

    assert.match(workflow, /images\/onlyoffice-agent/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/onlyoffice-agent/);
    assert.match(workflow, /uses:\s*actions\/checkout@v4[\s\S]*?fetch-depth:\s*0/);
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
    assert.match(dockerfile, /Acquire::Retries "10"/);
    assert.match(dockerfile, /Acquire::https::Timeout "60"/);
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
    assert.match(dockerfile, /find \/var\/log -type f -exec sh -c/);
    assert.match(dockerfile, /\/var\/cache\/ldconfig\/aux-cache/);
    assert.match(dockerfile, /rm -rf \/tmp\/node-compile-cache/);
    assert.match(dockerfile, /truncate -s 0 "\$file" 2>\/dev\/null \|\| true/);
    assert.match(bindInterposer, /sin_port == htons\(8000\)/);
    assert.match(bindInterposer, /INADDR_ANY/);
    assert.match(bindInterposer, /INADDR_LOOPBACK/);
    assert.match(bindInterposer, /IN6_IS_ADDR_UNSPECIFIED/);
    assert.match(bindInterposer, /in6addr_loopback/);
    assert.match(bindInterposer, /docservice-port-8000/);
});

test('independent WebTTY image and publication workflow are retired', () => {
    const readme = read('README.md');

    assert.equal(fs.existsSync(path.join(repoRoot, 'images/webtty-agent')), false);
    assert.equal(
        fs.existsSync(path.join(repoRoot, '.github/workflows/publish-webtty-agent-image.yml')),
        false,
    );
    assert.doesNotMatch(readme, /assistos\/webtty-agent|publish-webtty-agent-image|images\/webtty-agent/);
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
    assert.match(dockerfile, /^USER root$/m);
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.match(workflow, /test "\$\(id -u\):\$\(id -g\)" = 1000:1000/);
    assert.match(workflow, /bwrap --version/);
});

test('search-agent image bakes SearXNG, Chromium, and Puppeteer for an unprivileged runtime', () => {
    const workflow = read('.github/workflows/publish-search-agent-image.yml');
    const dockerfile = read('images/search-agent/Dockerfile');
    const packageJson = JSON.parse(read('images/search-agent/package.json'));

    assert.match(workflow, /IMAGE_NAME:\s*assistos\/search-agent/);
    assert.match(workflow, /default:\s*searxng-browser/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(workflow, /push-by-digest=true/);
    assert.match(workflow, /--cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(workflow, /docker buildx imagetools create/);
    assert.match(workflow, /grep -q 'linux\/amd64'/);
    assert.match(workflow, /grep -q 'linux\/arm64'/);

    assert.match(dockerfile, /^FROM docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64} AS searxng-builder$/m);
    assert.equal(
        dockerfile.match(/^FROM docker\.io\/assistos\/ploinky-node:24-bookworm-tools@sha256:[0-9a-f]{64}(?: AS searxng-builder)?$/gm)?.length,
        2,
    );
    assert.match(dockerfile, /9fea41204fdfa7a5cfa15b0ebd12904c520478ce/);
    assert.match(dockerfile, /msgspec==0\.21\.1/);
    assert.match(dockerfile, /--no-build-isolation -e \/opt\/search-agent\/searxng-src/);
    assert.match(dockerfile, /COPY --from=searxng-builder \/opt\/search-agent\/searx-pyenv/);
    assert.match(dockerfile, /\bchromium\b/);
    assert.match(dockerfile, /python3 -m venv \/opt\/search-agent\/searx-pyenv/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.match(dockerfile, /^ENV NODE_PATH=\/opt\/search-agent\/node_modules/m);
    assert.match(dockerfile, /^USER root$/m);
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.equal(packageJson.dependencies['puppeteer-core'], '25.9.0');
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

test('bwrap-runner workflow publishes only digest-proven native candidates before optional promotion', () => {
    const workflow = read('.github/workflows/publish-bwrap-runner.yml');
    const dockerfile = read('images/bwrap-runner/Dockerfile');
    const gptSmoke = read('scripts/smoke-gpt-researcher.sh');

    assert.match(workflow, /source_ref:[\s\S]*?required:\s*true/);
    assert.match(workflow, /copilot_agents_ref:[\s\S]*?required:\s*true/);
    assert.match(workflow, /achilles_cli_ref:[\s\S]*?required:\s*true/);
    assert.match(workflow, /prepublication consumer-code SHAs/);
    assert.doesNotMatch(workflow, /source_ref:[\s\S]*?default:\s*['"]?main/);
    assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(workflow, /repository:\s*AssistOS-AI\/basic/);
    assert.match(workflow, /path:\s*sources\/basic/);
    assert.match(workflow, /repository:\s*AssistOS-AI\/copilot-agents/);
    assert.match(workflow, /repository:\s*AssistOS-AI\/AchillesCLI/);
    assert.match(workflow, /git -C sources\/basic rev-parse HEAD/);
    assert.match(workflow, /git -C sources\/copilot-agents rev-parse HEAD/);
    assert.match(workflow, /git -C sources\/AchillesCLI rev-parse HEAD/);
    assert.match(workflow, /git status --porcelain=v1/);
    assert.match(workflow, /context:\s*\.\/sources\/basic\/bwrap-runner/);
    assert.match(workflow, /file:\s*\.\/images\/bwrap-runner\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/bwrap-runner/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(workflow, /platform:\s*linux\/amd64/);
    assert.match(workflow, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(workflow, /setup-qemu-action/);
    assert.match(workflow, /push-by-digest=true/);
    assert.match(workflow, /name-canonical=true/);
    assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.match(workflow, /podman info --format '\{\{\.Host\.Security\.Rootless\}\}'/);
    assert.match(workflow, /--cap-drop=all/);
    assert.match(workflow, /--security-opt=no-new-privileges/);
    assert.match(workflow, /for field in CapInh CapPrm CapEff CapBnd CapAmb/);
    assert.doesNotMatch(workflow, /--privileged|--cap-add|seccomp=unconfined|apparmor=unconfined/);
    assert.match(workflow, /bwrapRunnerNative\.mjs/);
    assert.match(workflow, /Run canonical health and representative task by digest/);
    assert.match(workflow, /Prepare Open Interpreter and prove deterministic disposition/);
    assert.match(workflow, /PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE/);
    assert.match(workflow, /Run GPTResearcher cold-install, readiness, and task smoke/);
    const gptStep = workflow.match(
        /- name: Run GPTResearcher cold-install, readiness, and task smoke[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';
    assert.ok(gptStep);
    assert.ok(gptStep.indexOf('/smoke-gpt-researcher.sh install') < gptStep.indexOf('--network=none'));
    assert.ok(gptStep.indexOf('--network=none') < gptStep.indexOf('/smoke-gpt-researcher.sh smoke'));
    assert.match(workflow, /bwrap-runner-proof-\$\{\{ matrix\.arch \}\}/);
    assert.match(workflow, /Assemble and inspect only the proven native digests/);
    assert.match(workflow, /assert\.equal\(index\.manifests\.length, 2\)/);
    assert.match(workflow, /members\.get\('linux\/amd64'\)/);
    assert.match(workflow, /members\.get\('linux\/arm64'\)/);
    assert.match(workflow, /candidate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.match(workflow, /Upload assembled candidate evidence/);
    assert.match(workflow, /release-evidence\.json/);
    assert.match(workflow, /candidateDigest: process\.env\.CANDIDATE_DIGEST/);
    assert.match(workflow, /consumerCodeBoundary: 'prepublication-code-only'/);
    assert.match(workflow, /if:\s*\$\{\{ inputs\.promote_stable == true \}\}/);
    const assemble = workflow.indexOf('Assemble and inspect only the proven native digests');
    const promote = workflow.indexOf('Move stable tag by exact proven candidate digest');
    const confirm = workflow.indexOf('Read-only post-promotion digest confirmation');
    assert.ok(assemble > 0 && assemble < promote && promote < confirm);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, `workflow action is not SHA-pinned: ${use[0]}`);
    }

    const baseDigest = '4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d';
    assert.match(dockerfile, new RegExp(`^FROM node:24\\.15\\.0-bookworm-slim@sha256:${baseDigest}$`, 'm'));
    assert.match(workflow, new RegExp(`BASE_IMAGE: docker\\.io/library/node:24\\.15\\.0-bookworm-slim@sha256:${baseDigest}`));
    assert.match(dockerfile, /\blibcap2-bin\b/);
    assert.match(dockerfile, /COPY\s+bin\/\s+\/opt\/bwrap-runner\/bin\//);
    assert.match(dockerfile, /COPY\s+lib\/\s+\/opt\/bwrap-runner\/lib\//);
    assert.match(dockerfile, /\/usr\/local\/bin\/bwrap-sandbox-exec/);

    assert.match(gptSmoke, /install-gpt-researcher\.sh/);
    assert.match(gptSmoke, /gpt-researcher-import-ok/);
    assert.match(gptSmoke, /readiness\.sh/);
    assert.match(gptSmoke, /gpt-researcher-task-adapter-ok/);
    assert.match(gptSmoke, /start-research\.py <\/dev\/null/);
    assert.match(gptSmoke, /"coldInstall":true/);
    assert.match(gptSmoke, /"network":"none","readiness":true,"minimalTask":true/);
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
    assert.match(workflow, /refs\/heads\/ploinky-proxy/);
    assert.doesNotMatch(workflow, /refs\/heads\/ploinky-box/);
    assert.match(workflow, /git -C sources\/webmeetInfra rev-parse HEAD/);
    assert.match(workflow, /context:\s*\.\/sources\/webmeetInfra\/liveKitServerAgent/);
    assert.match(workflow, /file:\s*\.\/images\/livekit-server-agent\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/livekit-server-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /- name: Build and push\s+id: build\s+uses: docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /Smoke build local architecture/);
    assert.match(workflow, /docker build[\s\S]*sources\/webmeetInfra\/liveKitServerAgent/);
    assert.match(workflow, /for binary in livekit-server egress redis-server pulseaudio setpriv ps node npm git g\+\+ getent ip make curl nc tini/);
    assert.match(dockerfile, /Acquire::Retries "10"/);
    assert.match(dockerfile, /Acquire::https::Timeout "60"/);
    assert.match(dockerfile, /Components: main universe/);
    assert.match(dockerfile, /APT::Update::Error-Mode "any"/);
    assert.match(dockerfile, /command -v ps/);
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

test('ploinky-box image is a source-owned rootless Podman appliance', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const readme = read('README.md');
    const instructions = dockerfileInstructions(dockerfile);
    const fromInstructions = instructions.filter(({ keyword }) => keyword === 'FROM');

    assert.match(
        dockerfile,
        /^ARG PODMAN_BASE=quay\.io\/podman\/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964$/m,
    );
    assert.match(
        dockerfile,
        /^ARG NODE_RUNTIME_IMAGE=docker\.io\/library\/node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df$/m,
    );
    assert.match(
        dockerfile,
        /^ARG CLOUDFLARED_IMAGE=docker\.io\/cloudflare\/cloudflared:2026\.7\.1@sha256:188bb03589a32affed3cf4d0590565ffe67b78866e6b5582574afab2b705bafe$/m,
    );
    assert.equal(fromInstructions.at(-1)?.source.trim(), 'FROM scratch AS runtime');
    assert.match(dockerfile, /^FROM \$PODMAN_BASE AS prepared-rootfs-base$/m);
    assert.match(dockerfile, /^FROM prepared-rootfs-base AS webtty-builder$/m);
    assert.match(dockerfile, /^FROM prepared-rootfs-base AS prepared-rootfs$/m);
    assert.match(dockerfile, /^COPY --from=prepared-rootfs \/ \/$/m);
    for (const requiredPackage of [
        'bash', 'bind-utils', 'bzip2', 'ca-certificates', 'coreutils', 'curl',
        'diffutils', 'ffmpeg-free', 'file', 'findutils', 'fuse-overlayfs', 'gawk',
        'git', 'grep', 'gzip', 'iproute', 'iputils', 'jq', 'less', 'libcap',
        'lsof', 'nano', 'net-tools', 'netavark', 'nmap-ncat', 'openssh-clients',
        'patch', 'procps-ng', 'python3', 'rsync', 'sed', 'aardvark-dns', 'passt',
        'slirp4netns', 'tar', 'tree', 'unzip', 'util-linux-core',
        'util-linux-script', 'vim-minimal', 'wget', 'which', 'xz', 'zip',
    ]) {
        assert.match(dockerfile, new RegExp(`\\n\\s+${requiredPackage.replace('-', '\\-')} \\\\`));
    }
    const commandProbe = dockerfile.match(
        /for required_command in \\\n[\s\S]*?command -v "\$required_command" >\/dev\/null \\\n[\s\S]*?exit 1; \}; \\\n\s+done/,
    )?.[0] || '';
    assert.match(commandProbe, /missing required interactive command: \$required_command/);
    for (const requiredCommand of [
        'awk', 'bash', 'bzip2', 'curl', 'diff', 'dig', 'ffmpeg', 'file', 'find',
        'git', 'grep', 'gzip', 'host', 'jq', 'less', 'lsof', 'nano', 'nc',
        'netstat', 'node', 'npm', 'npx', 'nslookup', 'patch', 'ping', 'podman',
        'ps', 'python3', 'rsync', 'script', 'sed', 'setsid', 'ssh', 'ss', 'tar',
        'timeout', 'tree', 'unshare', 'unzip', 'vi', 'wget', 'which', 'xargs',
        'xz', 'zip',
    ]) {
        assert.match(commandProbe, new RegExp(`\\b${requiredCommand}\\b`));
    }
    assert.match(dockerfile, /rpm --setcaps shadow-utils/);
    assert.match(dockerfile, /sha256sum --check --strict/);
    assert.match(dockerfile, /cloudflared tunnel run --help/);
    assert.match(dockerfile, /--token-file/);
    assert.doesNotMatch(dockerfile, /^LABEL\s/m);
    assert.doesNotMatch(dockerfile, /^EXPOSE\s/m);
    assert.doesNotMatch(dockerfile, /io\.assistos\.ploinky\.runtime-contract/);
    assert.match(dockerfile, /printf 'assistos\/ploinky-box\\n' > \/etc\/ploinky-box/);
    for (const ownedTarget of [
        '/opt/ploinky/node_modules',
        '/workspace',
        '/run/ploinky',
        '/home/podman/.config/containers',
        '/home/podman/.local/share/containers/storage',
        '/home/podman/.local/share/ploinky-images',
    ]) {
        assert.ok(dockerfile.includes(ownedTarget), 'missing owned mount target ' + ownedTarget);
    }
    assert.match(
        dockerfile,
        /chown -R podman:podman[\s\S]*?\/opt\/ploinky[\s\S]*?\/workspace[\s\S]*?\/run\/ploinky[\s\S]*?\/home\/podman\/\.config[\s\S]*?\/home\/podman\/\.local\/share\/containers[\s\S]*?\/home\/podman\/\.local\/share\/ploinky-images/,
    );
    assert.match(dockerfile, /chmod 0700 \/run\/ploinky/);
    assert.match(
        dockerfile,
        /rm -f \/home\/podman\/\.config\/containers\/containers\.conf/,
    );
    // The entrypoint renders the user storage.conf that separates the durable
    // image cache from the disposable graphroot; an inherited copy would
    // silently win and repersist nested container state.
    assert.match(
        dockerfile,
        /rm -f[\s\S]{0,120}?\/home\/podman\/\.config\/containers\/storage\.conf/,
    );
    // Only the image cache is a durable mount; the graphroot must stay on the
    // Box writable layer so nested state dies with the outer Box.
    assert.doesNotMatch(dockerfile, /^VOLUME\s/m);
    assert.doesNotMatch(readme, /retained workspace-volume/i);
    assert.doesNotMatch(readme, /three (?:managed |explicitly )?named volumes/i);
    assert.doesNotMatch(readme, /durable named volume/i);
    assert.match(
        readme,
        /workspace-backed cache directories:[\s\S]*?\.ploinky\/box\/dependencies[\s\S]*?\/opt\/ploinky\/node_modules[\s\S]*?\.ploinky\/box\/images[\s\S]*?\/home\/podman\/\.local\/share\/ploinky-images/,
    );
    assert.match(
        dockerfile,
        /\.ploinky\/box\/images host bind[\s\S]*?\.ploinky\/box\/dependencies/,
    );
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
        assert.ok(dockerfile.includes(requiredEnv), 'missing exact ENV ' + requiredEnv);
    }
    assert.match(
        dockerfile,
        /^COPY sources\/ploinky\/ploinky-box\/entrypoint\/ploinky-box-entrypoint \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.match(dockerfile, /^COPY sources\/ploinky\/core-services\/webtty\/package\.json \/tmp\/webtty-build\/package\.json$/m);
    assert.match(dockerfile, /^COPY sources\/ploinky\/core-services\/webtty\/package-lock\.json \/tmp\/webtty-build\/package-lock\.json$/m);
    assert.match(dockerfile, /^COPY sources\/ploinky\/core-services\/webtty\/native-probe\.mjs \/usr\/local\/share\/ploinky\/webtty\/native-probe\.mjs$/m);
    assert.match(dockerfile, /ARG PLOINKY_SOURCE_SHA/);
    assert.match(dockerfile, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/);
    assert.match(dockerfile, /npm ci --omit=dev --no-audit --no-fund/);
    assert.match(dockerfile, /--build-contract[\s\S]*?--package-lock[\s\S]*?--source-sha/);
    assert.match(dockerfile, /node \/usr\/local\/share\/ploinky\/webtty\/native-probe\.mjs --verify/);
    assert.match(dockerfile, /COPY --from=webtty-builder \/usr\/local\/lib\/ploinky\/webtty\/node_modules/);
    assert.match(dockerfile, /COPY --from=webtty-builder \/usr\/local\/share\/ploinky\/webtty\/native-probe\.mjs/);
    assert.match(dockerfile, /COPY --from=webtty-builder \/usr\/local\/share\/ploinky\/webtty\/runtime-contract\.json/);
    assert.match(dockerfile, /chown -R 0:0 \/usr\/local\/lib\/ploinky\/webtty \/usr\/local\/share\/ploinky\/webtty/);
    assert.match(dockerfile, /USER podman[\s\S]*?RUN node \/usr\/local\/share\/ploinky\/webtty\/native-probe\.mjs --verify[\s\S]*?USER root/);
    assert.match(dockerfile, /! command -v gcc/);
    assert.match(dockerfile, /! command -v g\+\+/);
    assert.match(dockerfile, /! command -v make/);
    assert.match(dockerfile, /-name \.npm -o -name \.cache -o -name node-gyp/);
    assert.match(dockerfile, /test ! -e \/tmp\/webtty-build/);
    assert.doesNotMatch(dockerfile, /spawn-helper/);
    assert.doesNotMatch(dockerfile, /NODE_PATH|WEBTTY_PORT|\b7681\b/);
    assert.match(dockerfile, /^RUN chmod 0755 \/usr\/local\/bin\/ploinky-box-entrypoint$/m);
    assert.equal(fs.existsSync(path.join(repoRoot, 'images/ploinky-box/entrypoint.sh')), false);
    assert.doesNotMatch(dockerfile, /COPY images\/ploinky-box\/entrypoint\.sh/);
    assert.match(dockerfile, /^USER podman$/m);
    assert.match(dockerfile, /^WORKDIR \/workspace$/m);
    assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/ploinky-box-entrypoint"\]$/m);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'VOLUME').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'EXPOSE').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'LABEL').length, 0);
    assert.equal(instructions.filter(({ keyword }) => keyword === 'CMD').length, 0);
});

test('ploinky-box workflow publishes two native immutable digests without behavioral gates', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const buildJob = workflow.match(/\n  build:[\s\S]*?(?=\n  merge:)/)?.[0] || '';
    const mergeJob = workflow.match(/\n  merge:[\s\S]*$/)?.[0] || '';
    const ploinkyCheckout = buildJob.match(
        /- name: Checkout immutable Ploinky source[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';

    assert.ok(buildJob);
    assert.ok(mergeJob);
    assert.match(ploinkyCheckout, /fetch-depth:\s*0/);
    assert.match(workflow, /source_ref:[\s\S]*?required:\s*true/);
    assert.match(workflow, /IMAGE_TAG:\s*latest/);
    assert.match(workflow, /COMPATIBILITY_IMAGE_TAG:\s*runtime/);
    assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
    assert.doesNotMatch(
        workflow,
        /explorer_ref|webmeet_infra_ref|umami_ref|achilles_cli_ref|proxies_ref|basic_ref/,
    );
    assert.match(buildJob, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(buildJob, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(buildJob, /platform:\s*linux\/amd64/);
    assert.match(buildJob, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(buildJob, /setup-qemu-action|--privileged|seccomp=unconfined/);
    for (const repository of [
        'AssistOSExplorer', 'webmeetInfra', 'UmamiAgent', 'AchillesCLI', 'proxies', 'basic',
    ]) {
        assert.doesNotMatch(buildJob, new RegExp(repository));
    }
    assert.match(read('.gitignore'), /^sources\/$/m);
    assert.match(buildJob, /git[\s\S]*?status[\s\S]*?--porcelain=v1/);
    assert.match(buildJob, /Build and push architecture image by digest/);
    assert.match(
        buildJob,
        /build-args:\s*\|[\s\S]*?PLOINKY_SOURCE_SHA=\$\{\{ needs\.resolve-source\.outputs\.source_sha \}\}/,
    );
    assert.match(buildJob, /push-by-digest=true/);
    assert.match(buildJob, /name-canonical=true/);
    assert.match(buildJob, /Record architecture digest evidence/);
    assert.match(buildJob, /\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.match(buildJob, /ploinky-box-digest-\$\{\{ matrix\.arch \}\}/);
    assert.match(buildJob, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.doesNotMatch(
        workflow,
        /\bnode --test\b|tests\/(?:unit|integration|e2e)\/|\bpodman\b|SMOKE_GRAPH_|PLOINKY_RELAY_TEST_IMAGE|PLOINKY_BOX_PROXY_TRACE/,
    );
    assert.doesNotMatch(workflow, /\bgated?\b/i);

    assert.match(mergeJob, /needs:\s*\n\s+- resolve-source\s*\n\s+- build/);
    assert.match(mergeJob, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(mergeJob, /pattern:\s*ploinky-box-digest-\*/);
    assert.match(mergeJob, /test "\$\{#digest_files\[@\]\}" -eq 2/);
    assert.match(mergeJob, /runtime-candidate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.match(mergeJob, /Prove the run-scoped staging tag is unused/);
    assert.match(mergeJob, /io\.assistos\.ploinky\.workflow-run/);
    assert.match(mergeJob, /io\.assistos\.ploinky\.source-sha/);
    assert.match(mergeJob, /io\.assistos\.ploinky\.amd64-digest/);
    assert.match(mergeJob, /io\.assistos\.ploinky\.arm64-digest/);
    assert.match(mergeJob, /assert\.equal\(index\.manifests\.length, 2\)/);
    assert.match(mergeJob, /members\.get\('linux\/amd64'\)/);
    assert.match(mergeJob, /members\.get\('linux\/arm64'\)/);
    assert.match(mergeJob, /Assemble and inspect the exact two-member manifest/);
    assert.match(mergeJob, /imagetools inspect --raw "\$STAGING_REF"/);
    assert.match(mergeJob, /sha256sum "\$RUNNER_TEMP\/staging-index\.json"/);
    assert.doesNotMatch(mergeJob, /sed -n 's\/\^Digest:/);
    assert.match(mergeJob, /Move latest and runtime compatibility alias by the exact inspected staging digest/);
    assert.match(mergeJob, /--tag "docker\.io\/\$\{IMAGE_NAME\}:\$\{IMAGE_TAG\}"/);
    assert.match(mergeJob, /--tag "docker\.io\/\$\{IMAGE_NAME\}:\$\{COMPATIBILITY_IMAGE_TAG\}"/);
    assert.match(mergeJob, /docker\.io\/\$\{IMAGE_NAME\}@\$\{STAGING_DIGEST\}/);
    assert.match(mergeJob, /Read-only post-promotion digest confirmation/);
    assert.match(mergeJob, /test "\$latest_digest" = "\$STAGING_DIGEST"/);
    assert.match(mergeJob, /test "\$runtime_digest" = "\$STAGING_DIGEST"/);
    const promote = mergeJob.indexOf('Move latest and runtime compatibility alias by the exact inspected staging digest');
    const readOnly = mergeJob.indexOf('Read-only post-promotion digest confirmation');
    assert.ok(promote > 0 && promote < readOnly);
    assert.doesNotMatch(mergeJob.slice(promote), /node --test|podman run|docker run/);
    assert.match(mergeJob, /Published latest and runtime:/);
    assert.match(mergeJob, /GITHUB_STEP_SUMMARY/);

    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, 'workflow action is not SHA-pinned: ' + use[0]);
    }
});

test('latest channel documentation separates creation from hard-cut recovery', () => {
    const readme = read('README.md');

    assert.match(readme, /latest[^\n]*primary mutable release channel/);
    assert.match(readme, /runtime[^\n]*compatibility/);
    assert.match(readme, /consults the selected channel only when creating[\s\S]*?validated replacement/);
    assert.match(readme, /incompatible image or unrecognized configuration\s+drift is rejected before mutation/i);
    assert.match(readme, /explicit[\s\S]*?destroy followed by\s+recreate/);
    assert.match(readme, /release channel[\s\S]*?separately authorized registry release[\s\S]*?action/);
    assert.match(readme, /never a supervisor\s+transaction/);
    assert.match(readme, /Reuse,\s+status, stop, and destroy do not pull the channel/);
    assert.match(readme, /private WebTTY native contract/);
    assert.match(readme, /source SHA is provenance\s+only; runtime compatibility never compares it/);
    assert.doesNotMatch(
        readme,
        /(?:image name|tags?|labels?|marker|release channel)[^\n]*(?:runtime-contract|contract-[0-9]+)/i,
    );
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
