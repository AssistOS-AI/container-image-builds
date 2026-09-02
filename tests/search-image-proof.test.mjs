import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/publish-search-agent-image.yml', import.meta.url), 'utf8');
const admission = workflow.match(/node --input-type=module <<'NODE' >> "\$GITHUB_OUTPUT"\n([\s\S]*?)\n\s+NODE/)[1];
const indexAdmission = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
const baseImage = workflow.match(/^  BASE_IMAGE: (.+)$/m)[1];
const workflowSha = 'a'.repeat(40);
const digestFor = (arch) => `sha256:${(arch === 'amd64' ? '1' : '2').repeat(64)}`;

function proof(arch) {
    const digest = digestFor(arch);
    return {
        digest,
        source: { imageDigest: digest, architecture: arch, workflowSha, baseImage,
            workflowRunId: '100', workflowAttempt: '1', searxngCommit: '9fea41204fdfa7a5cfa15b0ebd12904c520478ce' },
        images: [{ Architecture: arch, Config: { User: '1000:1000', Labels: { 'org.opencontainers.image.revision': workflowSha } },
            RepoDigests: [`assistos/search-agent@${digest}`] }],
        transport: { ok: true, probes: Array.from({ length: 14 }, () => ({ ok: true })) },
        runtime: { schema: 'ploinky.search-runtime/v1', ok: true, uid: 1000, gid: 1000,
            noNewPrivileges: true, capabilities: '0000000000000000', networkInterfaces: ['lo'],
            nodeVersion: 'v24.20.0', python: { version: '3.13.5' }, puppeteerVersion: '25.9.0',
            searxng: { healthStatus: 200, indexStatus: 200, configurationStatus: 200, invalidSearchStatus: 400 },
            browser: { documentStatus: 200, javascriptResult: '42', errors: [] } },
    };
}

function writeProof(root, arch, value) {
    const directory = path.join(root, `search-agent-proof-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'digest.txt'), value.digest);
    for (const [field, file] of Object.entries({ source: 'source-evidence', images: 'image-inspect', transport: 'git-transport', runtime: 'runtime' })) {
        fs.writeFileSync(path.join(directory, `${file}.json`), JSON.stringify(value[field]));
    }
}

function execute(source, root) {
    return spawnSync(process.execPath, ['--input-type=module', '-'], {
        // Change only the fixture directory. Execute the actual admission code.
        input: source.replace("'/tmp/search-agent-proofs'", 'process.env.SEARCH_PROOF_DIRECTORY'),
        encoding: 'utf8', timeout: 5000,
        env: { SEARCH_PROOF_DIRECTORY: root, RUNNER_TEMP: root, GITHUB_SHA: workflowSha,
            GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', IMAGE_NAME: 'assistos/search-agent', BASE_IMAGE: baseImage,
            AMD64_DIGEST: digestFor('amd64'), ARM64_DIGEST: digestFor('arm64') },
    });
}

test('search-agent native proof admission rejects source, privilege, browser and transport drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-image-proof-'));
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
            ['root runtime', (p) => { p.runtime.uid = 0; }],
            ['runtime capability', (p) => { p.runtime.capabilities = '0000000000000001'; }],
            ['external browser network', (p) => { p.runtime.networkInterfaces.push('eth0'); }],
            ['SearXNG failure', (p) => { p.runtime.searxng.configurationStatus = 500; }],
            ['browser failure', (p) => { p.runtime.browser.errors.push('requestfailed'); }],
            ['missing Git operation', (p) => { p.transport.probes.pop(); }],
            ['failed Git operation', (p) => { p.transport.probes[0].ok = false; }],
        ];
        for (const [description, mutate] of invalid) {
            const value = proof('arm64');
            mutate(value);
            writeProof(root, 'arm64', value);
            assert.notEqual(execute(admission, root).status, 0, `must reject ${description}`);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('search-agent candidate index accepts only the two proven native digests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-index-proof-'));
    const evidence = path.join(root, 'search-agent-candidate-evidence');
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
