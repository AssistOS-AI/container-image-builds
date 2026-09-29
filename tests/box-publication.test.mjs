import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicationContext, verifyNativeEvidence, verifyNativeProofs, verifyCandidate } from '../images/ploinky-box/verify-publication.mjs';
import { LIBRARIES } from '../images/ploinky-box/resolve-libraries.mjs';
import {
    ACHILLES_PACKAGE_NAME, ACHILLES_REQUIRED_ENTRIES, LIBRARY_METADATA_SCHEMA, MCP_SDK_MEMBERS,
    MCP_SDK_PACKAGE_NAME, SELF_TEST_CASES,
} from '../images/ploinky-box/smoke-libraries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHES = ['amd64', 'arm64'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-ploinky-box-image.yml'), 'utf8');
// The frozen selections the prerequisite job hands to the verifier; one branch is
// a resolved default, the other an explicit commit.
const SELECTIONS = {
    achillesAgentLib: { repository: LIBRARIES.achillesAgentLib.repository, branch: 'master', commit: '9'.repeat(40), packageVersion: '0.1.0' },
    'mcp-sdk': { repository: LIBRARIES['mcp-sdk'].repository, branch: null, commit: '7'.repeat(40), packageVersion: '1.19.1' },
};
const LIBRARY_ENV = {
    AGENTLIB_REPOSITORY: SELECTIONS.achillesAgentLib.repository, AGENTLIB_BRANCH: 'master', AGENTLIB_COMMIT: '9'.repeat(40),
    MCP_SDK_REPOSITORY: SELECTIONS['mcp-sdk'].repository, MCP_SDK_BRANCH: '', MCP_SDK_COMMIT: '7'.repeat(40),
};
const PACKAGE_NAMES = { achillesAgentLib: ACHILLES_PACKAGE_NAME, 'mcp-sdk': MCP_SDK_PACKAGE_NAME };

function libraryEvidence() {
    const provenance = Object.fromEntries(Object.entries(SELECTIONS).map(([library, selection]) => [library, {
        schema: LIBRARY_METADATA_SCHEMA, library, packageName: PACKAGE_NAMES[library],
        packageVersion: selection.packageVersion, repository: selection.repository, branch: selection.branch, commit: selection.commit,
    }]));
    const smoke = {
        schema: 'ploinky.box.library-smoke/v1', ok: true, protectedLayout: true,
        libraries: {
            achillesAgentLib: {
                packageName: ACHILLES_PACKAGE_NAME, packageVersion: '0.1.0', requiredEntries: [...ACHILLES_REQUIRED_ENTRIES],
                checks: ['imports', 'exports', 'isOptOutModel', 'jwt-round-trip'],
            },
            'mcp-sdk': {
                packageName: MCP_SDK_PACKAGE_NAME, packageVersion: '1.19.1', entry: './index.mjs',
                members: MCP_SDK_MEMBERS.map(({ member }) => member), checks: ['imports', 'exports', 'zod-schema', 'loopback-tool-call'],
            },
        },
    };
    const selfTest = {
        schema: 'ploinky.box.library-self-test/v1', ok: true, control: { accepted: true },
        cases: SELF_TEST_CASES.map(({ name, expected }) => ({ name, expected, rejected: true })),
    };
    return { provenance, smoke, selfTest };
}

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'sources/ploinky');
    const webtty = path.join(source, 'core-services/webtty');
    fs.mkdirSync(webtty, { recursive: true });
    fs.writeFileSync(path.join(webtty, 'native-probe.mjs'), '// Selected immutable source fixture.\n');
    fs.writeFileSync(path.join(webtty, 'package-lock.json'), '{}\n');
    // The stand-in for Ploinky's dependency-free contract module lists the full AgentLib entry set.
    fs.mkdirSync(path.join(source, 'agentlib'));
    fs.writeFileSync(path.join(source, 'agentlib/contract.mjs'),
        `export const AGENTLIB_REQUIRED_ENTRYPOINTS = Object.freeze(${JSON.stringify(ACHILLES_REQUIRED_ENTRIES)});\n`);
    // The selected Ploinky source owns native capability validation. This fixture
    // rejects a failed capability so publication cannot silently bypass that call.
    fs.writeFileSync(path.join(webtty, 'native-runtime.mjs'), `
      import assert from 'node:assert/strict';
      export function validateNativeProbeResult(probe, expected) {
        assert.equal(probe.schema, 'ploinky.webtty.native/v1');
        for (const key of ['architecture', 'platform', 'uid', 'gid']) assert.equal(probe[key], expected[key]);
        for (const key of ['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity']) assert.equal(probe.pty[key], true);
      }
    `);
    const env = { ...process.env, ...LIBRARY_ENV, SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
    const context = await publicationContext(source, env);
    const proofs = path.join(root, 'proofs');
    fs.mkdirSync(proofs);
    const digests = { amd64: `sha256:${'c'.repeat(64)}`, arm64: `sha256:${'d'.repeat(64)}` };
    for (const arch of ARCHES) {
        const dir = path.join(proofs, `ploinky-box-native-${arch}`);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'digest.txt'), digests[arch] + '\n');
        writeJson(path.join(dir, 'image-inspect.json'), [{
            Os: 'linux', Architecture: arch, Id: `sha256:${(arch === 'amd64' ? 'e' : 'f').repeat(64)}`,
            RepoDigests: [`assistos/ploinky-box@${digests[arch]}`],
            Config: { User: 'podman', Entrypoint: ['/usr/local/bin/ploinky-box-entrypoint'], Labels: {} },
        }]);
        const probe = {
            schema: 'ploinky.webtty.native/v1', nodeMajor: 24, nodeAbi: '137', platform: 'linux', architecture: arch,
            nodePtyVersion: '1.0.0', packageLockSha256: context.packageLockSha256,
            nativeArtifactPath: '/usr/local/lib/ploinky/webtty/node_modules/node-pty/build/Release/pty.node',
            nativeArtifactSha256: '1'.repeat(64), sourceSha: context.sourceCommit, uid: 1000, gid: 1000,
            pty: Object.fromEntries(['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity'].map((key) => [key, true])),
        };
        writeJson(path.join(dir, 'native-probe.json'), probe);
        writeJson(path.join(dir, 'immutable-webtty.json'), { probeSha256: context.probeSha256, contract: probe });
        const evidence = libraryEvidence();
        writeJson(path.join(dir, 'library-provenance.json'), evidence.provenance);
        writeJson(path.join(dir, 'library-smoke.json'), evidence.smoke);
        writeJson(path.join(dir, 'library-self-test.json'), evidence.selfTest);
        writeJson(path.join(dir, 'native-proof.json'), verifyNativeEvidence(dir, arch, digests[arch], context));
    }
    const index = {
        schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: ARCHES.map((arch) => ({ digest: digests[arch], platform: { os: 'linux', architecture: arch } })),
        annotations: Object.fromEntries(Object.entries({
            'workflow-run': '123', 'workflow-attempt': '1', 'source-sha': context.sourceCommit,
            'image-definitions-sha': context.imageDefinitionsCommit,
            'amd64-digest': digests.amd64, 'arm64-digest': digests.arm64,
        }).map(([key, value]) => [`io.assistos.ploinky.${key}`, value])),
    };
    const indexFile = path.join(root, 'index.json');
    writeJson(indexFile, index);
    return { root, source, context, env, proofs, digests, index, indexFile, dir: path.join(proofs, 'ploinky-box-native-amd64') };
}

test('native evidence and exact index bind both architectures, source, run, and immutable bytes', async (t) => {
    const f = await fixture(t);
    const proof = verifyCandidate(f.proofs, f.indexFile, f.context);
    assert.equal(proof.image.digest, `sha256:${hash(fs.readFileSync(f.indexFile))}`);
    assert.deepEqual(proof.image.platforms, f.digests);
    assert.equal(proof.sourceCommit, f.env.SOURCE_SHA);
    assert.equal(proof.imageDefinitionsCommit, f.env.GITHUB_SHA);
    assert.equal(Object.keys(proof.nativeProofSha256).length, 2);
});

test('failed native PTY capabilities cannot enter a candidate', async (t) => {
    const f = await fixture(t);
    const file = path.join(f.dir, 'native-probe.json');
    const original = readJson(file);
    for (const key of Object.keys(original.pty)) {
        writeJson(file, { ...original, pty: { ...original.pty, [key]: false } });
        assert.throws(() => verifyNativeProofs(f.proofs, f.context), `accepted failed ${key}`);
    }
});

test('different image digest, architecture, probe bytes, source, or sealed contract is rejected', async (t) => {
    const f = await fixture(t);
    const changes = [
        ['image-inspect.json', (v) => { v[0].RepoDigests = [`assistos/ploinky-box@sha256:${'0'.repeat(64)}`]; }],
        ['image-inspect.json', (v) => { v[0].Architecture = 'arm64'; }],
        ['immutable-webtty.json', (v) => { v.probeSha256 = '0'.repeat(64); }],
        ['immutable-webtty.json', (v) => { v.contract.nativeArtifactSha256 = '0'.repeat(64); }],
        ['native-probe.json', (v) => { v.sourceSha = '0'.repeat(40); }],
    ];
    for (const [name, change] of changes) {
        const file = path.join(f.dir, name);
        const original = fs.readFileSync(file);
        const value = JSON.parse(original); change(value); writeJson(file, value);
        assert.throws(() => verifyNativeProofs(f.proofs, f.context), `accepted altered ${name}`);
        fs.writeFileSync(file, original);
    }
});

test('missing, additional, stale-run, and changed raw evidence fails closed', async (t) => {
    const f = await fixture(t);
    const file = path.join(f.dir, 'native-proof.json');
    const proof = readJson(file);
    writeJson(file, { ...proof, workflow: { ...proof.workflow, runAttempt: '2' } });
    assert.throws(() => verifyNativeProofs(f.proofs, f.context));
    writeJson(file, proof);
    fs.appendFileSync(path.join(f.dir, 'native-probe.json'), '\n');
    assert.throws(() => verifyNativeProofs(f.proofs, f.context), 'changed raw bytes accepted');
    fs.mkdirSync(path.join(f.proofs, 'unexpected'));
    assert.throws(() => verifyNativeProofs(f.proofs, f.context));
    fs.rmSync(path.join(f.proofs, 'unexpected'), { recursive: true });
    fs.rmSync(path.join(f.proofs, 'ploinky-box-native-arm64'), { recursive: true });
    assert.throws(() => verifyNativeProofs(f.proofs, f.context));
});

test('extra, replaced, duplicate-platform, or wrong-provenance index members are rejected', async (t) => {
    const f = await fixture(t);
    for (const mutate of [
        (v) => v.manifests.push({ digest: `sha256:${'0'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } }),
        (v) => { v.manifests[0].digest = `sha256:${'0'.repeat(64)}`; },
        (v) => { v.manifests[1].platform.architecture = 'amd64'; },
        (v) => { v.annotations['io.assistos.ploinky.source-sha'] = '0'.repeat(40); },
        (v) => { v.annotations['io.assistos.ploinky.workflow-attempt'] = '2'; },
    ]) {
        const value = structuredClone(f.index); mutate(value); writeJson(f.indexFile, value);
        assert.throws(() => verifyCandidate(f.proofs, f.indexFile, f.context));
    }
});

test('publication context rejects symbolic or malformed revision and run inputs', async (t) => {
    const f = await fixture(t);
    for (const change of [{ SOURCE_SHA: 'main' }, { SOURCE_SHA: 'a'.repeat(64) }, { GITHUB_SHA: '' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '-1' }]) {
        await assert.rejects(publicationContext(f.source, { ...f.env, ...change }));
    }
});

function stepBody(name) {
    const marker = `      - name: ${name}\n`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1);
    const end = workflow.indexOf('\n      - name:', start + marker.length);
    const step = workflow.slice(start, end < 0 ? undefined : end);
    return step.split('        run: |\n')[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n').trim();
}

test('publication evidence binds both libraries to the frozen selections and their functional checks', async (t) => {
    const f = await fixture(t);
    const proofs = verifyNativeProofs(f.proofs, f.context);
    for (const arch of ARCHES) {
        assert.deepEqual(proofs[arch].libraries, {
            achillesAgentLib: { ...SELECTIONS.achillesAgentLib, packageName: ACHILLES_PACKAGE_NAME },
            'mcp-sdk': { ...SELECTIONS['mcp-sdk'], packageName: MCP_SDK_PACKAGE_NAME },
        });
        assert.equal(proofs[arch].libraryChecks.smoke.ok, true);
        assert.equal(proofs[arch].libraryChecks.selfTest.ok, true);
    }
    const candidate = verifyCandidate(f.proofs, f.indexFile, f.context);
    assert.deepEqual(candidate.libraries, proofs.amd64.libraries);
    assert.deepEqual(candidate.libraryChecks, { amd64: { smoke: true, selfTest: true }, arm64: { smoke: true, selfTest: true } });
    assert.deepEqual(Object.keys(proofs.amd64.evidenceSha256).sort(), [
        'image-inspect.json', 'immutable-webtty.json', 'library-provenance.json', 'library-self-test.json', 'library-smoke.json', 'native-probe.json',
    ]);
});

test('library provenance, smoke, and self-test evidence that differs from the frozen inputs is rejected', async (t) => {
    const f = await fixture(t);
    const other = 'f'.repeat(40);
    const changes = [
        ['library-provenance.json', (v) => { v.achillesAgentLib.commit = other; }],
        ['library-provenance.json', (v) => { v['mcp-sdk'].commit = other; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.branch = 'main'; }],
        ['library-provenance.json', (v) => { v['mcp-sdk'].branch = 'main'; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.repository = 'https://github.com/AssistOS-AI/MCPSDK.git'; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.packageName = MCP_SDK_PACKAGE_NAME; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.packageVersion = ''; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.schema = 'ploinky.box.library/v0'; }],
        ['library-provenance.json', (v) => { v.achillesAgentLib.fingerprint = '0'.repeat(64); }],
        ['library-provenance.json', (v) => { delete v['mcp-sdk']; }],
        ['library-smoke.json', (v) => { v.ok = false; }],
        ['library-smoke.json', (v) => { v.protectedLayout = false; }],
        ['library-smoke.json', (v) => { delete v.protectedLayout; }],
        ['library-smoke.json', (v) => { v.libraries.achillesAgentLib.packageVersion = '9.9.9'; }],
        ['library-smoke.json', (v) => { v.libraries['mcp-sdk'].packageName = ACHILLES_PACKAGE_NAME; }],
        ['library-smoke.json', (v) => { v.libraries.achillesAgentLib.requiredEntries = v.libraries.achillesAgentLib.requiredEntries.filter((entry) => !entry.includes('openAiAgenticResponder')); }],
        ['library-smoke.json', (v) => { v.libraries['mcp-sdk'].members = v.libraries['mcp-sdk'].members.slice(1); }],
        ['library-self-test.json', (v) => { v.ok = false; }],
        ['library-self-test.json', (v) => { v.cases.pop(); }],
        ['library-self-test.json', (v) => { v.cases[0].rejected = false; }],
        ['library-self-test.json', (v) => { v.control.accepted = false; }],
    ];
    for (const [name, change] of changes) {
        const file = path.join(f.dir, name);
        const original = fs.readFileSync(file);
        const value = JSON.parse(original); change(value); writeJson(file, value);
        assert.throws(() => verifyNativeProofs(f.proofs, f.context), `accepted altered ${name}: ${change}`);
        fs.writeFileSync(file, original);
    }
});

test('the smoke must cover every AgentLib entry the selected Ploinky source consumes', async (t) => {
    const f = await fixture(t);
    // A distinct source root: a module URL is imported once per process.
    const extended = path.join(f.root, 'sources/ploinky-extended');
    fs.cpSync(f.source, extended, { recursive: true });
    fs.writeFileSync(path.join(extended, 'agentlib/contract.mjs'),
        `export const AGENTLIB_REQUIRED_ENTRYPOINTS = ${JSON.stringify([...ACHILLES_REQUIRED_ENTRIES, 'utils/newConsumer.mjs'])};\n`);
    const context = await publicationContext(extended, f.env);
    assert.throws(() => verifyNativeProofs(f.proofs, context), /does not cover AgentLib entry utils\/newConsumer\.mjs/);
    assert.doesNotThrow(() => verifyNativeProofs(f.proofs, f.context));
});

test('mismatched architecture library inputs and frozen selections are rejected', async (t) => {
    const f = await fixture(t);
    const arm64 = path.join(f.proofs, 'ploinky-box-native-arm64');
    const file = path.join(arm64, 'library-provenance.json');
    const original = readJson(file);
    const proof = path.join(arm64, 'native-proof.json');
    // An arm64 image built from a different commit than the frozen pair cannot enter a candidate.
    writeJson(file, { ...original, 'mcp-sdk': { ...original['mcp-sdk'], commit: 'e'.repeat(40) } });
    assert.throws(() => verifyNativeProofs(f.proofs, f.context));
    writeJson(file, original);
    // Frozen selections must be exact commits of the selected repositories.
    for (const change of [
        { AGENTLIB_COMMIT: 'master' }, { MCP_SDK_COMMIT: 'a'.repeat(64) }, { AGENTLIB_COMMIT: '' },
        { AGENTLIB_REPOSITORY: 'https://github.com/AssistOS-AI/MCPSDK.git' },
        { MCP_SDK_REPOSITORY: 'https://token@github.com/AssistOS-AI/MCPSDK.git' },
        { AGENTLIB_BRANCH: 'main\ncommit=evil' }, { MCP_SDK_BRANCH: 'a b' },
    ]) {
        await assert.rejects(publicationContext(f.source, { ...f.env, ...change }), JSON.stringify(change));
    }
    assert.ok(fs.existsSync(proof));
});

test('the actual candidate shell writes only its run-scoped tag and retains verified evidence', async (t) => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.root, 'images/ploinky-box'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'images/ploinky-box/verify-publication.mjs'), path.join(f.root, 'images/ploinky-box/verify-publication.mjs'));
    const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    const log = path.join(f.root, 'docker-operations.jsonl');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
      if (args[2] === 'inspect' && args.includes('--raw')) process.stdout.write(fs.readFileSync(process.env.INDEX_FILE));
      else if (args[2] !== 'create') process.exit(1);
    `, { mode: 0o755 });
    const runner = path.join(f.root, 'runner'); fs.mkdirSync(runner);
    const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, IMAGE_NAME: 'assistos/ploinky-box',
        STAGING_REF: 'docker.io/assistos/ploinky-box:runtime-candidate-123-1', RUNNER_TEMP: runner,
        AMD64_DIGEST: f.digests.amd64, ARM64_DIGEST: f.digests.arm64,
        GITHUB_OUTPUT: path.join(f.root, 'output'), GITHUB_STEP_SUMMARY: path.join(f.root, 'summary'),
        DOCKER_LOG: log, INDEX_FILE: f.indexFile };
    const body = stepBody('Assemble and inspect the exact two-member manifest').replaceAll('/tmp/ploinky-box-proofs', f.proofs);
    const result = spawnSync('bash', ['-e', '-c', body], { cwd: f.root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const operations = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const writes = operations.filter((args) => args[2] === 'create');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][writes[0].indexOf('--tag') + 1], env.STAGING_REF);
    assert.ok(!operations.flat().some((arg) => /:(latest|runtime)$/.test(arg)));
    const candidate = path.join(runner, 'ploinky-box-candidate-evidence');
    assert.equal(readJson(path.join(candidate, 'candidate-proof.json')).image.digest, `sha256:${hash(fs.readFileSync(f.indexFile))}`);
    // The candidate proof and the publication summary name both libraries, their resolved branch or explicit commit, and versions.
    assert.deepEqual(readJson(path.join(candidate, 'candidate-proof.json')).libraries, verifyCandidate(f.proofs, f.indexFile, f.context).libraries);
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, new RegExp(`Library achillesAgentLib: ploinky-agent-lib 0\\.1\\.0 from ${LIBRARIES.achillesAgentLib.repository.replaceAll('.', '\\.')} master at ${'9'.repeat(40)}`));
    assert.match(summary, new RegExp(`Library mcp-sdk: @modelcontextprotocol/sdk 1\\.19\\.1 from [^\\n]* \\(explicit commit\\) at ${'7'.repeat(40)}`));
    for (const arch of ARCHES) assert.deepEqual(fs.readFileSync(path.join(candidate, 'native-proofs', `ploinky-box-native-${arch}`, 'native-proof.json')), fs.readFileSync(path.join(f.proofs, `ploinky-box-native-${arch}`, 'native-proof.json')));
});
