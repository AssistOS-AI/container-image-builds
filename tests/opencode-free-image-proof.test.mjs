import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/publish-opencode-free-agent-image.yml', import.meta.url), 'utf8');
const admission = workflow.match(/node --input-type=module <<'NODE' >> "\$GITHUB_OUTPUT"\n([\s\S]*?)\n\s+NODE/)[1];
const indexAdmission = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
const baseImage = workflow.match(/^  BASE_IMAGE: (.+)$/m)[1];
const workflowSha = 'a'.repeat(40);
const digestFor = (arch) => `sha256:${(arch === 'amd64' ? '1' : '2').repeat(64)}`;
const releases = {
    amd64: { asset: 'opencode-linux-x64.tar.gz', assetSha256: 'e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4',
        binarySha256: 'f9dab32248695e9ebd56b16a1921798fd85112cf5a69c7dfd0cabc1e17be4a11' },
    arm64: { asset: 'opencode-linux-arm64.tar.gz', assetSha256: 'd4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6',
        binarySha256: '82ab43b7e8b7d931c26ba170c90de6082a2e2af8fc84a9ce9a506357b91160d7' },
};
const tools = ['bash', 'edit', 'glob', 'grep', 'invalid', 'question', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'websearch', 'write'];

function proof(arch) {
    const digest = digestFor(arch);
    return {
        digest,
        source: { imageDigest: digest, architecture: arch, workflowSha, baseImage, workflowRunId: '100', workflowAttempt: '1',
            cliVersion: '1.18.31', releaseAsset: releases[arch].asset, releaseAssetSha256: releases[arch].assetSha256,
            binarySha256: releases[arch].binarySha256 },
        images: [{ Architecture: arch, Config: { User: '1000:1000', Labels: { 'org.opencontainers.image.revision': workflowSha } },
            RepoDigests: [`assistos/opencode-free-agent@${digest}`] }],
        runtime: { schema: 'ploinky.opencode-free-runtime/v1', ok: true, uid: 1000, gid: 1000,
            noNewPrivileges: true, capabilities: '0000000000000000', networkInterfaces: ['lo'],
            cliVersion: '1.18.31', binarySha256: releases[arch].binarySha256, configReadOnly: true,
            resolvedTools: [...tools], lastPermissionRule: { permission: '*', action: 'ask', pattern: '*' } },
    };
}

function writeProof(root, arch, value) {
    const directory = path.join(root, `opencode-free-agent-proof-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'digest.txt'), value.digest);
    for (const [field, file] of Object.entries({ source: 'source-evidence', images: 'image-inspect', runtime: 'runtime' })) {
        fs.writeFileSync(path.join(directory, `${file}.json`), JSON.stringify(value[field]));
    }
}

function execute(source, root) {
    return spawnSync(process.execPath, ['--input-type=module', '-'], {
        // Change only the fixture directory. Execute the actual admission code.
        input: source.replace("'/tmp/opencode-free-agent-proofs'", 'process.env.OPENCODE_FREE_PROOF_DIRECTORY'),
        encoding: 'utf8', timeout: 5000,
        env: { OPENCODE_FREE_PROOF_DIRECTORY: root, RUNNER_TEMP: root, GITHUB_SHA: workflowSha,
            GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', IMAGE_NAME: 'assistos/opencode-free-agent', BASE_IMAGE: baseImage,
            AMD64_DIGEST: digestFor('amd64'), ARM64_DIGEST: digestFor('arm64') },
    });
}

test('opencode-free-agent native proof admission rejects source, privilege, configuration and confinement drift', () => {
    assert.ok(admission.includes("'/tmp/opencode-free-agent-proofs'"), 'fixture directory substitution must apply');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-free-image-proof-'));
    try {
        writeProof(root, 'amd64', proof('amd64'));
        writeProof(root, 'arm64', proof('arm64'));
        const good = execute(admission, root);
        assert.equal(good.status, 0, good.stderr);
        assert.equal(good.stdout, `amd64_digest=${digestFor('amd64')}\narm64_digest=${digestFor('arm64')}\n`);
        const invalid = [
            ['another workflow attempt', (p) => { p.source.workflowAttempt = '0'; }],
            ['old base image', (p) => { p.source.baseImage = 'old-runtime'; }],
            ['foreign image source', (p) => { p.images[0].Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40); }],
            ['unbound digest', (p) => { p.images[0].RepoDigests = []; }],
            ['root image user', (p) => { p.images[0].Config.User = 'root'; }],
            ['another CLI release', (p) => { p.source.cliVersion = '1.18.30'; }],
            ['foreign release asset', (p) => { p.source.releaseAssetSha256 = 'c'.repeat(64); }],
            ['source binary drift', (p) => { p.source.binarySha256 = 'd'.repeat(64); }],
            ['binary sha mismatch', (p) => { p.runtime.binarySha256 = 'e'.repeat(64); }],
            ['wrong runtime schema', (p) => { p.runtime.schema = 'ploinky.search-runtime/v1'; }],
            ['failed runtime', (p) => { p.runtime.ok = false; }],
            ['root runtime', (p) => { p.runtime.uid = 0; }],
            ['runtime capability', (p) => { p.runtime.capabilities = '0000000000000001'; }],
            ['privilege escalation', (p) => { p.runtime.noNewPrivileges = false; }],
            ['non-lo interface', (p) => { p.runtime.networkInterfaces.push('eth0'); }],
            ['network interface instead of lo', (p) => { p.runtime.networkInterfaces = ['eth0']; }],
            ['another runtime CLI version', (p) => { p.runtime.cliVersion = '1.18.32'; }],
            ['writable configuration', (p) => { p.runtime.configReadOnly = false; }],
            ['12 tools', (p) => { p.runtime.resolvedTools.pop(); }],
            ['14 tools', (p) => { p.runtime.resolvedTools.push('patch'); }],
            ['substituted tool', (p) => { p.runtime.resolvedTools[0] = 'patch'; }],
            ['wildcard allow as last rule', (p) => { p.runtime.lastPermissionRule.action = 'allow'; }],
            ['wildcard deny as last rule', (p) => { p.runtime.lastPermissionRule.action = 'deny'; }],
            ['non-wildcard last rule', (p) => { p.runtime.lastPermissionRule = { permission: 'external_directory', action: 'allow', pattern: '*' }; }],
            ['narrowed last rule pattern', (p) => { p.runtime.lastPermissionRule.pattern = '*.env'; }],
            ['missing last rule', (p) => { delete p.runtime.lastPermissionRule; }],
        ];
        for (const [description, mutate] of invalid) {
            const value = proof('arm64');
            mutate(value);
            writeProof(root, 'arm64', value);
            assert.notEqual(execute(admission, root).status, 0, `must reject ${description}`);
        }
        const swapped = proof('arm64');
        swapped.source.binarySha256 = releases.amd64.binarySha256;
        swapped.runtime.binarySha256 = releases.amd64.binarySha256;
        writeProof(root, 'arm64', swapped);
        assert.notEqual(execute(admission, root).status, 0, 'must reject an amd64 binary in the arm64 image');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('opencode-free-agent candidate index accepts only the two proven native digests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-free-index-proof-'));
    const evidence = path.join(root, 'opencode-free-agent-candidate-evidence');
    fs.mkdirSync(evidence);
    const member = (arch) => ({ platform: { os: 'linux', architecture: arch }, digest: digestFor(arch) });
    try {
        for (const [members, accepted] of [
            [[member('amd64'), member('arm64')], true],
            [[member('amd64')], false],
            [[member('amd64'), member('amd64')], false],
            [[member('amd64'), { ...member('arm64'), digest: digestFor('amd64') }], false],
            [[member('amd64'), member('arm64'), member('arm64')], false],
        ]) {
            fs.writeFileSync(path.join(evidence, 'candidate-index.json'), JSON.stringify({ manifests: members }));
            assert.equal(execute(indexAdmission, root).status === 0, accepted);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
