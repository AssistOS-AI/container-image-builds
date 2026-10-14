import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputs, lockHash, verifyNativeProofs } from '../images/bizanso-agent/verify-publication.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('runtime build context has pinned dependencies and no application checkout or source copy', () => {
    const file = read('images/bizanso-agent/Dockerfile');
    const manifest = JSON.parse(read('images/bizanso-agent/package.json'));
    const lock = JSON.parse(read('images/bizanso-agent/package-lock.json'));
    assert.equal(file.split('\n')[0], `FROM ${inputs.baseImage}`);
    assert.equal(manifest.dependencies['@huggingface/transformers'], inputs.transformersVersion);
    assert.equal(lock.packages['node_modules/@huggingface/transformers'].version, inputs.transformersVersion);
    assert.equal(lock.packages[''].name, manifest.name);
    assert.match(inputs.model.revision, /^[0-9a-f]{40}$/);
    assert.match(file, /^USER 1000:1000$/m);
    assert.match(file, /BIZANSO_TRANSFORMERS_MODULE=\/opt\/bizanso-runtime\/transformers\.mjs/);
    assert.doesNotMatch(file, /COPY\s+\.|sources\/|git clone|Axiologic|COPY\s+(?:src|static|skills|docs)\b/);
});

test('publication builds native architectures, proves offline inference, and promotes only explicitly', () => {
    const workflow = read('.github/workflows/publish-bizanso-agent-image.yml');
    assert.match(workflow, /context: images\/bizanso-agent/);
    assert.match(workflow, /runner: ubuntu-24\.04-arm/);
    assert.match(workflow, /runner: ubuntu-24\.04\s/);
    assert.match(workflow, /push-by-digest=true/);
    assert.match(workflow, /--network=none --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(workflow, /verify-publication\.mjs/);
    assert.match(workflow, /if: \$\{\{ inputs\.promote_stable == true \}\}/);
    assert.match(workflow, /password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /Axiologic|SOURCE_REPO_TOKEN|setup-qemu-action/);
    for (const match of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(match[1], /^[0-9a-f]{40}$/);
});

function proofFixture() {
    const root = mkdtempSync(join(tmpdir(), 'bizanso-runtime-proof-'));
    const expected = { workflowSha: '1'.repeat(40), runId: '42', attempt: '1' };
    for (const [arch, digit] of [['amd64', 'a'], ['arm64', 'b']]) {
        const folder = join(root, `bizanso-runtime-proof-${arch}`);
        mkdirSync(folder);
        const digest = `sha256:${digit.repeat(64)}`;
        writeFileSync(join(folder, 'digest.txt'), digest);
        writeFileSync(join(folder, 'source-evidence.json'), JSON.stringify({
            imageDigest: digest, architecture: arch, workflowSha: expected.workflowSha,
            workflowRunId: expected.runId, workflowAttempt: expected.attempt,
            baseImage: inputs.baseImage, packageLockSha256: lockHash, model: inputs.model,
        }));
        writeFileSync(join(folder, 'image-inspect.json'), JSON.stringify([{
            Architecture: arch, RepoDigests: [`assistos/bizanso-agent@${digest}`],
            Config: { User: '1000:1000', Labels: {
                'org.opencontainers.image.revision': expected.workflowSha,
                'org.opencontainers.image.source': 'https://github.com/AssistOS-AI/container-image-builds',
            } },
        }]));
        writeFileSync(join(folder, 'runtime.json'), JSON.stringify({
            schema: 'assistos.bizanso-runtime-proof/v1', ok: true, architecture: arch === 'amd64' ? 'x64' : 'arm64',
            uid: 1000, gid: 1000, offline: true, noApplicationSource: true,
            capabilities: '0000000000000000', noNewPrivileges: true, networkInterfaces: ['lo'],
            transformersVersion: inputs.transformersVersion, model: inputs.model, similarity: 0.9,
            tools: { pdftotext: 'version', antiword: 'usage', libreoffice: 'version' },
        }));
    }
    return { root, expected };
}

test('assembly accepts only bound successful proofs from the same run and locked model', () => {
    const { root, expected } = proofFixture();
    try {
        assert.deepEqual(verifyNativeProofs(root, expected), { amd64: `sha256:${'a'.repeat(64)}`, arm64: `sha256:${'b'.repeat(64)}` });
        for (const override of [{ runId: 'other' }, { attempt: '2' }, { workflowSha: '2'.repeat(40) }]) {
            assert.throws(() => verifyNativeProofs(root, { ...expected, ...override }));
        }
        const path = join(root, 'bizanso-runtime-proof-arm64/runtime.json');
        const proof = JSON.parse(readFileSync(path));
        for (const patch of [{ ok: false }, { offline: false }, { noApplicationSource: false }, { architecture: 'x64' },
            { model: { ...inputs.model, revision: '2'.repeat(40) } }]) {
            writeFileSync(path, JSON.stringify({ ...proof, ...patch }));
            assert.throws(() => verifyNativeProofs(root, expected));
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
