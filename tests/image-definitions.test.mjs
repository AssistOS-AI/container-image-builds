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

function exists(relativePath) {
    return fs.existsSync(path.join(repoRoot, relativePath));
}

function readJson(relativePath) {
    return JSON.parse(read(relativePath));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseWorkflowMatrixRows(workflow) {
    const rows = [];
    let current = null;
    for (const line of workflow.split('\n')) {
        const rowMatch = line.match(/^\s*-\s+tag:\s*([^\s#]+)/);
        if (rowMatch) {
            current = { tag: rowMatch[1] };
            rows.push(current);
            continue;
        }
        const propertyMatch = line.match(/^\s+([a-z_]+):\s*([^\s#]+.*)$/);
        if (!current || !propertyMatch) continue;
        const [, key, rawValue] = propertyMatch;
        if (['image_context', 'platform', 'runner'].includes(key)) {
            current[key] = rawValue.trim();
        }
    }
    return rows;
}

function parseDockerfileArgDefaults(dockerfile) {
    const args = {};
    for (const line of dockerfile.split('\n')) {
        const match = line.match(/^ARG\s+([A-Z0-9_]+)(?:=(.*))?$/);
        if (!match) continue;
        const [, name, value = ''] = match;
        args[name] = value.trim();
    }
    return args;
}

const approvedLockVersionFields = new Set([
    'llamaCppCommit',
    'vllmVersion',
    'sglangVersion',
    'tensorRtLlmVersion',
    'openvinoModelServerVersion',
    'cudaVersion',
    'rocmVersion',
    'pythonVersion',
    'nodeVersion',
    'nodeDistSha256',
]);

const approvedLockMetadataFields = new Set([
    'schemaVersion',
    'imageId',
    'platform',
    'supportedEngines',
    'lockfilePath',
]);

const retiredLockFields = [
    'imageNamespace',
    'tags',
    'runtimeAgentSource',
    'node',
    'huggingface_hub',
    'cuda',
    'nvidia',
    'backend',
    'rocm',
    'hip',
    'vulkan',
    'intel',
    'oneapi',
];

const forbiddenNodeBootstrapPattern = new RegExp([
    ['node', 'source'].join(''),
    ['setup_', '24', '\\.x'].join(''),
    ['curl -fsSL .* ', '\\|', ' bash'].join(''),
].join('|'), 'i');

const runtimeImageSpecs = [
    {
        dir: 'images/llm-runtime-cpu',
        imageId: 'llm-runtime-cpu',
        platformLabel: 'linux/amd64,linux/arm64',
        supportedEngines: ['llamacpp-cpu'],
        tags: [
            { tag: 'cpu-amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' },
            { tag: 'cpu-arm64', platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
        ],
        lockVersionFields: ['llamaCppCommit', 'pythonVersion'],
        argLockFields: {
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
        },
        requiredDocker: [
            /\/opt\/engines\/llamacpp/,
            /git clone[\s\S]+llama\.cpp[\s\S]+\/opt\/engines\/llamacpp\/src/,
            /cmake -S \/opt\/engines\/llamacpp\/src -B \/opt\/engines\/llamacpp\/build/,
            /-DGGML_NATIVE=OFF/,
            /install -m 0755 \/opt\/engines\/llamacpp\/build\/bin\/llama-server \/opt\/engines\/llamacpp\/bin\/llama-server/,
        ],
    },
    {
        dir: 'images/llm-runtime-nvidia-amd64',
        imageId: 'llm-runtime-nvidia-amd64',
        platformLabel: 'linux/amd64',
        supportedEngines: ['llamacpp-cuda', 'vllm', 'sglang', 'trtllm'],
        tags: [{ tag: 'nvidia-amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' }],
        lockVersionFields: ['llamaCppCommit', 'vllmVersion', 'sglangVersion', 'tensorRtLlmVersion', 'cudaVersion', 'pythonVersion', 'nodeVersion', 'nodeDistSha256'],
        argLockFields: {
            CUDA_VERSION: 'cudaVersion',
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
            VLLM_VERSION: 'vllmVersion',
            SGLANG_VERSION: 'sglangVersion',
            TENSORRT_LLM_VERSION: 'tensorRtLlmVersion',
            NODE_VERSION: 'nodeVersion',
            NODE_DIST_SHA256: 'nodeDistSha256',
        },
        nodeDistribution: {
            arch: 'x64',
            sha256: '7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d',
        },
        requiredDocker: [
            /nvidia\/cuda:[^\s]+devel/,
            /\/opt\/engines\/llamacpp/,
            /-DGGML_CUDA=ON/,
            /\/opt\/engines\/vllm\/venv/,
            /pip install[\s\S]+"vllm==\$\{VLLM_VERSION\}"/,
            /\/opt\/engines\/sglang\/venv/,
            /pip install[\s\S]+"sglang\[all\]==\$\{SGLANG_VERSION\}"/,
            /\/opt\/engines\/trtllm\/venv/,
            /pip install[\s\S]+"tensorrt_llm==\$\{TENSORRT_LLM_VERSION\}"/,
        ],
    },
    {
        dir: 'images/llm-runtime-nvidia-spark-arm64-sm121',
        imageId: 'llm-runtime-nvidia-spark-arm64-sm121',
        platformLabel: 'linux/arm64',
        supportedEngines: ['llamacpp-cuda-sm121', 'sglang', 'trtllm'],
        tags: [{ tag: 'nvidia-spark-arm64-sm121', platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' }],
        lockVersionFields: ['llamaCppCommit', 'sglangVersion', 'tensorRtLlmVersion', 'cudaVersion', 'pythonVersion', 'nodeVersion', 'nodeDistSha256'],
        argLockFields: {
            CUDA_VERSION: 'cudaVersion',
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
            SGLANG_VERSION: 'sglangVersion',
            TENSORRT_LLM_VERSION: 'tensorRtLlmVersion',
            NODE_VERSION: 'nodeVersion',
            NODE_DIST_SHA256: 'nodeDistSha256',
        },
        nodeDistribution: {
            arch: 'arm64',
            sha256: '555659c36fc72d0617e278b5d26ffcaebc3760a3de354926b1e5f1b0bfd66083',
        },
        requiredDocker: [
            /nvidia\/cuda:[^\s]+devel/,
            /-DGGML_CUDA=ON/,
            /-DCMAKE_CUDA_ARCHITECTURES=121/,
            /\/opt\/engines\/sglang\/venv/,
            /pip install[\s\S]+"sglang\[all\]==\$\{SGLANG_VERSION\}"/,
            /\/opt\/engines\/trtllm\/venv/,
            /pip install[\s\S]+"tensorrt_llm==\$\{TENSORRT_LLM_VERSION\}"/,
        ],
        forbiddenDocker: [/\/opt\/engines\/vllm\/venv/, /VLLM_VERSION/, /"vllm"/],
    },
    {
        dir: 'images/llm-runtime-amd-rocm-amd64',
        imageId: 'llm-runtime-amd-rocm-amd64',
        platformLabel: 'linux/amd64',
        supportedEngines: ['llamacpp-rocm', 'vllm-rocm', 'sglang-rocm', 'llamacpp-vulkan-fallback'],
        tags: [{ tag: 'amd-rocm-amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' }],
        lockVersionFields: ['llamaCppCommit', 'vllmVersion', 'sglangVersion', 'rocmVersion', 'pythonVersion', 'nodeVersion', 'nodeDistSha256'],
        argLockFields: {
            ROCM_VERSION: 'rocmVersion',
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
            VLLM_VERSION: 'vllmVersion',
            SGLANG_VERSION: 'sglangVersion',
            NODE_VERSION: 'nodeVersion',
            NODE_DIST_SHA256: 'nodeDistSha256',
        },
        nodeDistribution: {
            arch: 'x64',
            sha256: '7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d',
        },
        requiredDocker: [
            /rocm\/dev-ubuntu/,
            /\/opt\/engines\/llamacpp/,
            /-DGGML_HIP=ON/,
            /-DGGML_VULKAN=ON/,
            /\/opt\/engines\/vllm\/venv/,
            /pip install[\s\S]+"vllm==\$\{VLLM_VERSION\}"/,
            /\/opt\/engines\/sglang\/venv/,
            /pip install[\s\S]+"sglang\[all\]==\$\{SGLANG_VERSION\}"/,
        ],
    },
    {
        dir: 'images/llm-runtime-vulkan-amd64',
        imageId: 'llm-runtime-vulkan-amd64',
        platformLabel: 'linux/amd64',
        supportedEngines: ['llamacpp-vulkan', 'llamacpp-cpu-fallback'],
        tags: [{ tag: 'vulkan-amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' }],
        lockVersionFields: ['llamaCppCommit', 'pythonVersion'],
        argLockFields: {
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
        },
        requiredDocker: [
            /vulkan-tools/,
            /libvulkan-dev/,
            /\/opt\/engines\/llamacpp/,
            /-DGGML_VULKAN=ON/,
            /-DGGML_NATIVE=OFF/,
        ],
    },
    {
        dir: 'images/llm-runtime-vulkan-arm64',
        imageId: 'llm-runtime-vulkan-arm64',
        platformLabel: 'linux/arm64',
        supportedEngines: ['llamacpp-vulkan', 'llamacpp-cpu-fallback'],
        tags: [{ tag: 'vulkan-arm64', platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' }],
        lockVersionFields: ['llamaCppCommit', 'pythonVersion'],
        argLockFields: {
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
        },
        requiredDocker: [
            /vulkan-tools/,
            /libvulkan-dev/,
            /\/opt\/engines\/llamacpp/,
            /-DGGML_VULKAN=ON/,
            /-DGGML_NATIVE=OFF/,
        ],
    },
    {
        dir: 'images/llm-runtime-intel-amd64',
        imageId: 'llm-runtime-intel-amd64',
        platformLabel: 'linux/amd64',
        supportedEngines: ['openvino-model-server', 'llamacpp-cpu', 'llamacpp-vulkan'],
        tags: [{ tag: 'intel-amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' }],
        lockVersionFields: ['llamaCppCommit', 'openvinoModelServerVersion', 'pythonVersion'],
        argLockFields: {
            OPENVINO_MODEL_SERVER_VERSION: 'openvinoModelServerVersion',
            LLAMA_CPP_COMMIT: 'llamaCppCommit',
        },
        requiredDocker: [
            /openvino\/model_server:\$\{OPENVINO_MODEL_SERVER_VERSION\}/,
            /\/opt\/engines\/openvino/,
            /COPY --from=openvino-model-server/,
            /ENV PATH=\/opt\/engines\/openvino\/bin:\$\{PATH\}/,
            /ENV LD_LIBRARY_PATH=\/opt\/engines\/openvino\/lib:\$\{LD_LIBRARY_PATH\}/,
            /ENV PYTHONPATH=\/opt\/engines\/openvino\/lib\/python:\$\{PYTHONPATH\}/,
            /\/opt\/engines\/openvino\/bin\/ovms --version/,
            /\/opt\/engines\/llamacpp/,
            /-DGGML_VULKAN=ON/,
            /-DGGML_NATIVE=OFF/,
        ],
    },
];

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

test('llm-runtime workflow publishes the required assistos/llm-runtime image matrix', () => {
    const legacyLauncherEnv = ['PLOINKY', 'LLM', 'LAUNCHERS', 'DIR'].join('_');
    const legacyLauncherPaths = [
        ['/opt', 'ploinky', 'launchers'].join('/'),
        ['/code', 'launchers'].join('/'),
    ];
    const legacyLauncherPathVariables = [
        'legacy_ploinky_launcher_path',
        'legacy_code_launcher_path',
    ];

    assert.equal(exists('.github/workflows/publish-llm-runtime-cpu-image.yml'), false);

    const workflow = read('.github/workflows/publish-llm-runtime-images.yml');
    const expectedRows = runtimeImageSpecs.flatMap((spec) => (
        spec.tags.map((tag) => ({
            tag: tag.tag,
            image_context: spec.dir,
            platform: tag.platform,
            runner: tag.runner,
        }))
    ));

    assert.match(workflow, /IMAGE_NAME:\s*assistos\/llm-runtime/);
    assert.match(workflow, /docker\/login-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}/);
    assert.match(workflow, /repository:\s*AssistOS-AI\/llm-runtime/);
    assert.match(workflow, /path:\s*sources\/llm-runtime/);
    assert.match(workflow, /sources\/llm-runtime\/shared\/runtime-agent\/mcp-server\.mjs/);
    assert.match(workflow, /sources\/llm-runtime\/shared\/runtime-agent\/lib\/runtimeContract\.mjs/);
    assert.match(workflow, /grep -q "PLOINKY_LAUNCHERS_DIR" "\$runtime_contract"/);
    assert.match(workflow, /grep -q "\/workspace\/modelLaunchers" "\$runtime_contract"/);
    assert.match(workflow, /grep -q "\/health" "\$mcp_server"/);
    assert.match(workflow, /legacy_ploinky_launcher_path/);
    assert.match(workflow, /legacy_code_launcher_path/);
    assert.match(workflow, /for runtime_source_file in "\$mcp_server" "\$runtime_contract"; do/);
    for (const legacyLauncherPathVariable of legacyLauncherPathVariables) {
        assert.ok(
            workflow.includes(`grep -q "\${${legacyLauncherPathVariable}}" "$runtime_source_file"`),
            `workflow must reject ${legacyLauncherPathVariable} in both runtime source files`,
        );
    }
    assert.doesNotMatch(workflow, new RegExp(escapeRegExp(legacyLauncherEnv)));
    for (const legacyLauncherPath of legacyLauncherPaths) {
        assert.doesNotMatch(workflow, new RegExp(escapeRegExp(legacyLauncherPath)));
    }

    assert.deepEqual(parseWorkflowMatrixRows(workflow), expectedRows);

    assert.match(workflow, /type=raw,value=\$\{\{\s*matrix\.tag\s*\}\}/);
    assert.match(workflow, /tags:\s*\$\{\{\s*steps\.meta\.outputs\.tags\s*\}\}/);
    assert.match(workflow, /file:\s*\$\{\{\s*matrix\.image_context\s*\}\}\/Dockerfile/);
    assert.match(workflow, /name:\s*Smoke build CPU runtime image/);
    assert.match(workflow, /if:\s*\$\{\{\s*matrix\.tag == 'cpu-amd64'\s*\}\}/);
    assert.match(workflow, /smoke_dir="\$\(mktemp -d\)"/);
    assert.match(workflow, /mkdir -p "\$smoke_dir\/runtime"/);
    assert.match(workflow, /selected-architecture\.json/);
    assert.match(workflow, /docker build[\s\S]+-f images\/llm-runtime-cpu\/Dockerfile[\s\S]+\./);
    assert.match(workflow, /docker run -d --name llm-runtime-cpu-smoke[\s\S]+-v "\$smoke_dir\/runtime\/selected-architecture\.json:\/runtime\/selected-architecture\.json:ro"/);
    assert.match(workflow, /curl -fsS http:\/\/127\.0\.0\.1:9000\/health/);
    assert.match(workflow, /hf --help/);
    assert.match(workflow, /test -f \/opt\/ploinky\/engineVersions\.lock\.json/);
    assert.match(workflow, /test -f \/runtime\/selected-architecture\.json/);
    assert.match(workflow, /test -d \/workspace\/modelLaunchers/);
    assert.match(workflow, /pgrep -fa '\[l\]lama-server\|\[v\]llm\|\[s\]glang\|\[t\]rtllm\|\[o\]vms'/);
    assert.doesNotMatch(workflow, /assistos\/llm-runtime-cpu/);
    assert.doesNotMatch(workflow, /cpu-arm64-smoke/);
    assert.doesNotMatch(workflow, /llama-server --version/);
});

test('llm-runtime Dockerfiles share the clean MCP runtime image contract', () => {
    const legacyStarter = ['start', 'runtime', 'agent'].join('-');
    const legacyEnvPrefix = ['PLOINKY', 'LLM', ''].join('_');
    const legacyPorts = new RegExp(`\\b${9000 + 1}\\b|\\b${9000 + 2}\\b`);

    for (const spec of runtimeImageSpecs) {
        const dockerfile = read(`${spec.dir}/Dockerfile`);
        const dockerArgs = parseDockerfileArgDefaults(dockerfile);
        const lockfilePath = `${spec.dir}/engineVersions.lock.json`;
        const lockfile = readJson(lockfilePath);

        assert.equal(lockfile.schemaVersion, 1);
        assert.equal(lockfile.imageId, spec.imageId);
        assert.equal(lockfile.platform, spec.platformLabel);
        assert.equal(lockfile.lockfilePath, '/opt/ploinky/engineVersions.lock.json');
        assert.deepEqual(lockfile.supportedEngines, spec.supportedEngines);

        for (const key of Object.keys(lockfile)) {
            assert.ok(
                approvedLockMetadataFields.has(key) || approvedLockVersionFields.has(key),
                `${lockfilePath} uses unapproved lockfile field '${key}'`,
            );
        }
        for (const field of retiredLockFields) {
            assert.equal(Object.hasOwn(lockfile, field), false, `${lockfilePath} must not use retired field '${field}'`);
        }
        for (const field of spec.lockVersionFields) {
            assert.equal(typeof lockfile[field], 'string', `${lockfilePath} must pin ${field}`);
            assert.notEqual(lockfile[field].length, 0, `${lockfilePath} ${field} must not be empty`);
        }
        for (const field of approvedLockVersionFields) {
            if (!spec.lockVersionFields.includes(field)) {
                assert.equal(Object.hasOwn(lockfile, field), false, `${lockfilePath} must not pin irrelevant ${field}`);
            }
        }
        for (const [argName, lockField] of Object.entries(spec.argLockFields || {})) {
            assert.equal(
                dockerArgs[argName],
                lockfile[lockField],
                `${spec.dir}/Dockerfile ARG ${argName} must match ${lockfilePath} ${lockField}`,
            );
        }

        assert.match(dockerfile, new RegExp(`org\\.assistos\\.llm-runtime\\.image-id="${escapeRegExp(spec.imageId)}"`));
        assert.match(dockerfile, new RegExp(`org\\.assistos\\.llm-runtime\\.supported-engines="${escapeRegExp(spec.supportedEngines.join(','))}"`));
        assert.match(dockerfile, new RegExp(`org\\.assistos\\.llm-runtime\\.platform="${escapeRegExp(spec.platformLabel)}"`));
        assert.match(dockerfile, /org\.assistos\.llm-runtime\.lockfile="\/opt\/ploinky\/engineVersions\.lock\.json"/);
        assert.match(dockerfile, /COPY\s+sources\/llm-runtime\/shared\/runtime-agent\/\s+\/opt\/ploinky\/runtime-agent\//);
        assert.match(
            dockerfile,
            new RegExp(`COPY\\s+${escapeRegExp(spec.dir)}\\/engineVersions\\.lock\\.json\\s+\\/opt\\/ploinky\\/engineVersions\\.lock\\.json`),
        );
        assert.match(dockerfile, /\bhuggingface_hub\b/);
        assert.match(dockerfile, /\/opt\/hf-cli\/bin\/huggingface-cli/);
        assert.doesNotMatch(dockerfile, /&& ln -s \/opt\/hf-cli\/bin\/hf \/usr\/local\/bin\/hf/);
        assert.match(dockerfile, /\bbash\b/);
        assert.match(dockerfile, /\bcurl\b/);
        assert.match(dockerfile, /\bjq\b/);
        assert.match(dockerfile, /\bpython3\b/);
        assert.match(dockerfile, /\btini\b/);
        assert.match(dockerfile, /\bprocps\b/);
        assert.match(dockerfile, /\biproute2\b/);
        assert.match(dockerfile, /\/workspace\/modelLaunchers/);
        assert.doesNotMatch(dockerfile, /\/opt\/ploinky\/launchers/);
        assert.match(dockerfile, /ENV\s+HF_HOME=\/models\/hf-cache/);
        assert.match(dockerfile, /ENV\s+PLOINKY_MODELS_DIR=\/models\/artifacts/);
        assert.match(dockerfile, /ENV\s+PLOINKY_DERIVED_DIR=\/models\/derived/);
        assert.match(dockerfile, /ENV\s+PLOINKY_RUNTIME_DIR=\/runtime/);
        assert.match(dockerfile, /ENV\s+PLOINKY_LAUNCHERS_DIR=\/workspace\/modelLaunchers/);
        assert.match(dockerfile, /ENV\s+PLOINKY_MCP_PORT=9000/);
        assert.match(dockerfile, /ENV\s+PLOINKY_INFERENCE_PORT=8080/);
        assert.match(dockerfile, /EXPOSE\s+9000\s+8080/);
        assert.match(dockerfile, /VOLUME\s+\["\/workspace",\s*"\/models",\s*"\/runtime"\]/);
        assert.match(dockerfile, /\/opt\/engines/);
        assert.match(lockfile.llamaCppCommit, /^[a-f0-9]{40}$/, `${lockfilePath} llamaCppCommit must be a full commit SHA`);
        assert.match(
            dockerfile,
            /cmake -S \/opt\/engines\/llamacpp\/src -B \/opt\/engines\/llamacpp\/build[\s\S]+-DGGML_NATIVE=OFF[\s\S]+cmake --build \/opt\/engines\/llamacpp\/build/,
            `${spec.dir}/Dockerfile must disable native CPU tuning in the llama.cpp CMake build`,
        );
        assert.doesNotMatch(dockerfile, forbiddenNodeBootstrapPattern);
        if (spec.nodeDistribution) {
            assert.equal(dockerArgs.NODE_VERSION, '24.4.1', `${spec.dir}/Dockerfile must pin Node version`);
            assert.equal(dockerArgs.NODE_DIST_ARCH, spec.nodeDistribution.arch, `${spec.dir}/Dockerfile must pin Node dist architecture`);
            assert.equal(dockerArgs.NODE_DIST_SHA256, spec.nodeDistribution.sha256, `${spec.dir}/Dockerfile must pin Node dist checksum`);
            assert.match(dockerfile, /https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION\}\/node-v\$\{NODE_VERSION\}-linux-\$\{NODE_DIST_ARCH\}\.tar\.xz/);
            assert.match(dockerfile, /echo "\$\{NODE_DIST_SHA256\}  node-v\$\{NODE_VERSION\}-linux-\$\{NODE_DIST_ARCH\}\.tar\.xz" \| sha256sum -c -/);
            assert.match(dockerfile, /tar -xJf "node-v\$\{NODE_VERSION\}-linux-\$\{NODE_DIST_ARCH\}\.tar\.xz" -C \/usr\/local --strip-components=1/);
            assert.match(dockerfile, /node --version/);
        }
        for (const pattern of spec.requiredDocker) {
            assert.match(dockerfile, pattern, `${spec.dir}/Dockerfile missing engine contract ${pattern}`);
        }
        for (const pattern of spec.forbiddenDocker || []) {
            assert.doesNotMatch(dockerfile, pattern, `${spec.dir}/Dockerfile must not claim ${pattern}`);
        }
        assert.match(dockerfile, /ENTRYPOINT\s+\["tini",\s*"--",\s*"node",\s*"\/opt\/ploinky\/runtime-agent\/mcp-server\.mjs"\]/);
        assert.doesNotMatch(dockerfile, /CMD\s+\["bash"\]/);
        assert.doesNotMatch(dockerfile, new RegExp(legacyStarter));
        assert.doesNotMatch(dockerfile, new RegExp(legacyEnvPrefix));
        assert.doesNotMatch(dockerfile, legacyPorts);
    }
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
