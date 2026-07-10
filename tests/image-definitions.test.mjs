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
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /docker run --rm "\$IMAGE_NAME:smoke" sh -c 'node --version && nginx -v && cloudflared --version'/);
    assert.match(workflow, /nginx -v/);
    assert.match(workflow, /cloudflared --version/);

    assert.match(dockerfile, /^ARG BASE_IMAGE=docker\.io\/assistos\/ploinky-node:24-bookworm-tools$/m);
    assert.match(dockerfile, /^ARG CLOUDFLARED_IMAGE=docker\.io\/cloudflare\/cloudflared:latest$/m);
    assert.match(dockerfile, /^FROM \$\{CLOUDFLARED_IMAGE\} AS cloudflared$/m);
    assert.match(dockerfile, /^FROM \$\{BASE_IMAGE\}$/m);
    assert.match(dockerfile, /COPY --from=cloudflared \/usr\/local\/bin\/cloudflared \/usr\/local\/bin\/cloudflared/);
    assert.match(dockerfile, /^ENV PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
    assert.match(dockerfile, /\bnginx\b/);
    assert.match(dockerfile, /\bca-certificates\b/);
    assert.match(dockerfile, /\bopenssl\b/);
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
    assert.match(workflow, /git -C sources\/webmeetInfra rev-parse --short=12 HEAD/);
    assert.match(workflow, /context:\s*\.\/sources\/webmeetInfra\/liveKitServerAgent/);
    assert.match(workflow, /file:\s*\.\/images\/livekit-server-agent\/Dockerfile/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/livekit-server-agent/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(dockerfile, /^ARG LIVEKIT_SERVER_IMAGE=livekit\/livekit-server:v1\.11\.0$/m);
    assert.match(dockerfile, /COPY\s+scripts\s+\/code\/scripts/);
    assert.match(dockerfile, /livekit-server/);
    assert.match(dockerfile, /\begress\b/);
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

test('ploinky-box image is runtime-only contract v1', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const entrypoint = read('images/ploinky-box/entrypoint.sh');

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
    assert.match(dockerfile, /dnf install -y git slirp4netns/);
    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.runtime-contract="1"$/m);
    assert.match(dockerfile, /mkdir -p \/opt\/ploinky \/workspace/);
    assert.match(dockerfile, /echo 'assistos\/ploinky-box' > \/etc\/ploinky-box/);
    assert.match(dockerfile, /^ENV PATH=\/opt\/ploinky\/bin:\$PATH \\$/m);
    assert.match(dockerfile, /^\s+PLOINKY_WORKSPACE_ROOT=\/workspace$/m);
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

    for (const command of ['bash', 'node', 'npm', 'git', 'podman']) {
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
    assert.match(entrypoint, /^test -w \/workspace \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -e \/dev\/fuse \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^test -e \/dev\/net\/tun \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^podman info >\/dev\/null 2>&1 \|\| fail "[^"\n]+"$/m);
    assert.match(entrypoint, /^podman rm -af --time 0 >\/dev\/null 2>&1 \|\| true$/m);
    assert.match(entrypoint, /^\s+exec "\$@"$/m);
    assert.match(entrypoint, /^exec sleep infinity$/m);
    assert.doesNotMatch(entrypoint, /achillesAgentLib/);
    assert.doesNotMatch(entrypoint, /mcp-sdk/);
});

test('ploinky-box workflow publishes immutable runtime v1 after required checks', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    assert.match(workflow, /IMAGE_TAG:\s*podman-node24-runtime-v1/);
    assert.doesNotMatch(workflow, /^\s+image_tag:/m);
    assert.match(workflow, /Verify immutable tag is unused/);
    assert.match(workflow, /case "\$status" in/);
    assert.match(workflow, /404\)/);
    assert.match(workflow, /200\)/);
    assert.match(workflow, /unexpected registry status/);
    assert.doesNotMatch(
        workflow,
        /imagetools inspect[^\n]*>[\/]dev\/null 2>&1/,
    );
    assert.match(workflow, /io\.assistos\.ploinky\.runtime-contract/);
    assert.match(workflow, /npx (?:--version|-v)/);
    assert.match(workflow, /podman version/);
    assert.match(workflow, /podman info/);
    assert.match(workflow, /nested-ok/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /tags:\s*type=raw,value=podman-node24-runtime-v1/);

    const entrypointStep = workflow.match(
        /- name: Verify ploinky-box entrypoint self-check[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';
    assert.ok(entrypointStep);
    assert.match(entrypointStep, /--privileged/);
    assert.match(entrypointStep, /sources\/ploinky:\/opt\/ploinky:ro/);
    assert.match(entrypointStep, /node_modules/);

    const mountedSourceStep = workflow.match(
        /- name: Verify mounted Ploinky source and dependency volume[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';
    assert.ok(mountedSourceStep);
    assert.match(mountedSourceStep, /ploinky-install-deps/);
    assert.match(mountedSourceStep, /achillesAgentLib/);
    assert.match(mountedSourceStep, /mcp-sdk/);
    const installerIndex = mountedSourceStep.indexOf('ploinky-install-deps');
    assert.ok(installerIndex > 0);
    const beforeInstall = mountedSourceStep.slice(0, installerIndex);
    const afterInstall = mountedSourceStep.slice(installerIndex);
    assert.doesNotMatch(beforeInstall, /ploinky help/);
    assert.match(beforeInstall, /output=\$\(docker run/);
    assert.match(beforeInstall, /ploinky list agents/);
    assert.match(beforeInstall, /code=\$\?/);
    assert.match(beforeInstall, /test "\$code" -ne 0/);
    assert.match(
        beforeInstall,
        /Ploinky cannot run until dependencies are installed/,
    );
    assert.match(afterInstall, /ploinky help/);
    assert.match(afterInstall, /ploinky list agents/);

    const nestedStep = workflow.match(
        /- name: Nested podman contract check[\s\S]*?(?=\n      - name:)/,
    )?.[0] || '';
    assert.ok(nestedStep);
    assert.match(nestedStep, /--privileged/);
    assert.match(nestedStep, /docker\.io\/library\/alpine echo nested-ok/);
    assert.doesNotMatch(nestedStep, /continue-on-error:\s*true/);

    const manifestStep = workflow.match(
        /- name: Verify published multi-architecture manifest[\s\S]*?(?=\n      - name:|\s*$)/,
    )?.[0] || '';
    assert.ok(manifestStep);
    assert.match(manifestStep, /docker buildx imagetools inspect/);
    assert.match(manifestStep, /linux\/amd64/);
    assert.match(manifestStep, /linux\/arm64/);

    const buildAndPushStep = workflow.match(
        /- name: Build and push[\s\S]*?(?=\n      - name:|\s*$)/,
    )?.[0] || '';
    assert.ok(buildAndPushStep);
    assert.match(
        buildAndPushStep,
        /^\s+uses:\s*docker\/build-push-action@v6\s*$/m,
    );
    assert.match(buildAndPushStep, /^\s+context:\s*\.\s*$/m);
    assert.match(
        buildAndPushStep,
        /^\s+file:\s*\.\/images\/ploinky-box\/Dockerfile\s*$/m,
    );
    assert.match(
        buildAndPushStep,
        /^\s+platforms:\s*linux\/amd64,linux\/arm64\s*$/m,
    );
    assert.match(buildAndPushStep, /^\s+push:\s*true\s*$/m);
    assert.match(
        buildAndPushStep,
        /^\s+tags:\s*\$\{\{\s*steps\.meta\.outputs\.tags\s*\}\}\s*$/m,
    );
    assert.ok(
        workflow.indexOf(buildAndPushStep) < workflow.indexOf(manifestStep),
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
