import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE_PATH, pageAssets, verifyBuildMetadata, verifyLoopbackListener } from '../images/umami-agent/smoke-runtime.mjs';
import { nativeIndex, verifyNativeProof, verifyCandidate } from '../images/umami-agent/verify-publication.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const dockerfile = read('images/umami-agent/Dockerfile');
const workflow = read('.github/workflows/publish-umami-agent-image.yml');
const sources = JSON.parse(read('images/umami-agent/sources.lock.json'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = character => 'sha256:' + character.repeat(64);
const write = (directory, name, value) => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
};
const json = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
function temp(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-contract-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('source lock preserves the exact runtime stack and selects immutable Umami source and pnpm', () => {
    assert.equal(sources.schemaVersion, 2);
    assert.equal(sources.runtimeBase.image, 'docker.io/assistos/umami-agent@sha256:5ca78a8263f000bfa6f5039e225452f8a4ec6526c52157955dc83454128c8bf6');
    assert.equal(sources.runtimeBase.image.split('@')[1], sources.runtimeBase.indexDigest);
    assert.equal(sources.runtimeBase.nodeVersion, '22.23.1');
    for (const field of ['platformManifests', 'platformConfigs']) {
        assert.deepEqual(Object.keys(sources.runtimeBase[field]).sort(), ['linux/amd64', 'linux/arm64']);
        for (const value of Object.values(sources.runtimeBase[field])) assert.match(value, /^sha256:[a-f0-9]{64}$/);
    }
    assert.equal(sources.umami.commit, '2f6e2b5ff256862a081d9e74bed18a42ebf795e3');
    assert.equal(sources.umami.version, '3.2.0');
    assert.equal(sources.umami.basePath, BASE_PATH);
    assert.equal(sources.umami.sourceArchive.url, `https://codeload.github.com/umami-software/umami/tar.gz/${sources.umami.commit}`);
    assert.equal(sources.umami.sourceArchive.sha256, 'faf2071ada0aef901f29d314eb1b1b2705698c5489df786d003dfd248bb7a0bd');
    assert.equal(sources.umami.sourceFiles['pnpm-lock.yaml'], 'b5ba02abd9e346194926658cbfecd95fe4c0a5c765d653a745cf3deb06ec8171');
    for (const value of Object.values(sources.umami.sourceFiles)) assert.match(value, /^[a-f0-9]{64}$/);
    assert.equal(sources.umami.pnpm.version, '10.15.1');
    assert.equal(sources.umami.pnpm.sha256, '8c53af02ae3ec1fb0ae75377f8d4d6217c2d7cbe6f03c16350cabf7493de6eff');
    assert.equal(sources.bun.version, '1.3.14');
    assert.equal(sources.bun.artifacts['linux/amd64'].sha256, '14bd9aedeebf1dba67e8def9531c89bc989ecfdf1de42e5bfcaf1b8cd9294719');
    assert.equal(sources.bun.artifacts['linux/arm64'].sha256, 'b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb');
    assert.equal(sources.umamiMcp.commit, '3ab73beda2db0ebffb0b07439b218ef562107520');
    assert.equal(sources.umamiMcp.bunLockSha256, '92e41e798c3593657116f461377d92e8b74dbcf605f279e6e1832dbcfd0aa46f');
    assert.deepEqual(sources.postgresql, { version: '18.4', source: 'runtimeBase' });
    assert.deepEqual(sources.umami.geo, { source: 'runtimeBase', path: '/app/geo/GeoLite2-City.mmdb' });
});

test('build uses verified supported source output and completely replaces the old application', () => {
    assert.deepEqual(dockerfile.match(/^FROM .+$/gm), [`FROM ${sources.runtimeBase.image} AS umami-build`, `FROM ${sources.runtimeBase.image}`]);
    for (const value of [sources.umami.sourceArchive.url, sources.umami.sourceArchive.sha256, sources.umami.pnpm.url, sources.umami.pnpm.sha256]) assert.ok(dockerfile.includes(value));
    assert.doesNotMatch(dockerfile, /^ARG |apk add|npm install -g|git clone|sed -i|build-args:|refs\/heads\/|curl[^\n]*\|\s*(?:ba)?sh/m);
    assert.match(dockerfile, /verify-umami-build\.mjs source/);
    assert.match(dockerfile, /install --frozen-lockfile --prod=false/);
    assert.match(dockerfile, /cp docker\/proxy\.ts src\/proxy\.ts/);
    assert.match(dockerfile, /NODE_ENV=production npm run build-docker/);
    assert.match(dockerfile, /pnpm\.cjs prune --prod/);
    assert.match(dockerfile, /SKIP_BUILD_GEO=1/);
    assert.match(dockerfile, /cp -a \/app\/geo\/\. \/build\/geo\//);
    assert.match(dockerfile, /rm -rf \/out\/node_modules .*\/out\/\.next\/static/);
    assert.match(dockerfile, /cp -a \.next\/standalone\/\. \/out\//);
    assert.match(dockerfile, /cp -a node_modules public scripts prisma prisma\.config\.ts generated geo package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \/out\//);
    assert.match(dockerfile, /verify-umami-build\.mjs seal/);
    assert.match(dockerfile, /RUN rm -rf \/app && mkdir \/app\nCOPY --from=umami-build --chown=1000:1000 \/out\/ \/app\//);
    assert.match(dockerfile, /RUN mkdir -p \/usr\/local\/share\/ploinky \\\n    && chown 0:0 \/usr\/local\/share\/ploinky \\\n    && chmod 0755 \/usr\/local\/share\/ploinky\nCOPY --chown=0:0 --chmod=0444 sources\.lock\.json/);
    assert.match(dockerfile, /COPY --chown=0:0 --chmod=0444 smoke-runtime\.mjs/);
    assert.match(dockerfile, /su-exec 1000:1000 node -e .*\['umami-agent-sources\.json', 'smoke-umami-runtime\.mjs'\].*readFileSync/);
});

test('workflow assembles smoke-proven native digest outputs before explicit stable promotion', () => {
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^  push:|setup-qemu|image_tag:|build-args:/m);
    assert.match(workflow, /promote_stable:[\s\S]*?default: false/);
    assert.match(workflow, /runner: ubuntu-24\.04\n/);
    assert.match(workflow, /runner: ubuntu-24\.04-arm\n/);
    assert.match(workflow, /platforms: \$\{\{ matrix\.platform \}\}/);
    assert.match(workflow, /push-by-digest=true,name-canonical=true,push=true/);
    assert.match(workflow, /provenance: mode=max/);
    assert.match(workflow, /sbom: true/);
    assert.match(workflow, /--network=none --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges/g);
    assert.match(workflow, /smoke-umami-runtime\.mjs/);
    assert.match(workflow, /verify-publication\.mjs seal-native/);
    assert.match(workflow, /verify-publication\.mjs proofs/);
    assert.match(workflow, /verify-publication\.mjs candidate/);
    assert.match(workflow, /if: \$\{\{ inputs\.promote_stable == true \}\}/);
    assert.match(workflow, /needs: assemble/);
    assert.match(workflow, /cmp "\$evidence\/candidate-index\.json" "\$evidence\/immutable-index\.json"/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(use[1], /^[a-f0-9]{40}$/);
});

const html = prefix => `<script src="${prefix}/_next/static/main.js"></script><link href="${prefix}/_next/static/main.css" rel="stylesheet"><link rel="preload" as="font" href="${prefix}/_next/static/media/font.woff2">`;
test('HTML proof accepts real prefixed scripts/styles/fonts and rejects escaped asset namespaces', () => {
    const assets = pageAssets(html(BASE_PATH), 'http://127.0.0.1:3001');
    assert.deepEqual([...assets.values()], ['script', 'css', 'font']);
    for (const prefix of ['', 'https://other.test' + BASE_PATH, BASE_PATH + '-other']) assert.throws(() => pageAssets(html(prefix), 'http://127.0.0.1:3001'));
    assert.throws(() => pageAssets('<script src="' + BASE_PATH + '/_next/main.js"></script>', 'http://127.0.0.1:3001'));
});

test('listener proof rejects wildcard, duplicate, and absent listeners', () => {
    const header = 'sl local_address rem_address st';
    const line = '0: 0100007F:0BB9 00000000:0000 0A';
    verifyLoopbackListener(header + '\n' + line, 3001);
    for (const body of ['', line.replace('0100007F', '00000000'), line + '\n' + line]) assert.throws(() => verifyLoopbackListener(header + '\n' + body, 3001));
});

function application(t) {
    const directory = temp(t);
    const lock = structuredClone(sources);
    const files = { 'package.json': '{"version":"3.2.0"}', 'pnpm-lock.yaml': 'exact-lock', 'server.js': 'standalone',
        'public/script.js': 'tracker', 'geo/GeoLite2-City.mmdb': 'retained-geo',
        '.next/required-server-files.json': JSON.stringify({ config: { basePath: BASE_PATH, assetPrefix: BASE_PATH, env: { basePath: BASE_PATH }, output: 'standalone' } }) };
    for (const [name, value] of Object.entries(files)) write(directory, name, value);
    lock.umami.sourceFiles = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)]));
    lock.umami.geo.path = path.join(directory, 'original-geo');
    write(directory, 'original-geo', 'retained-geo');
    write(directory, 'lock.json', lock);
    const run = mode => spawnSync(process.execPath, [path.join(root, 'images/umami-agent/verify-build.mjs'), mode, directory, path.join(directory, 'lock.json')], { encoding: 'utf8' });
    return { directory, lock, run };
}

test('source and artifact seals bind actual bytes and never overwrite a prior seal', t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('source').status, 0);
    assert.equal(run('seal').status, 0);
    verifyBuildMetadata(directory, lock);
    assert.notEqual(run('seal').status, 0);
    write(directory, 'server.js', 'changed');
    assert.throws(() => verifyBuildMetadata(directory, lock));
    assert.notEqual(run('source').status, 0);
});
for (const field of ['geo', 'basePath', 'lock', 'tracker']) test(`artifact verification rejects ${field} drift`, t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('seal').status, 0);
    if (field === 'geo') write(directory, 'geo/GeoLite2-City.mmdb', 'changed');
    if (field === 'tracker') write(directory, 'public/script.js', 'changed');
    if (field === 'lock') write(directory, 'pnpm-lock.yaml', 'changed');
    if (field === 'basePath') write(directory, '.next/required-server-files.json', { config: { basePath: '' } });
    assert.throws(() => verifyBuildMetadata(directory, lock));
});

test('seal itself rejects old root-base output and replaced GeoIP', t => {
    const { directory, run } = application(t);
    write(directory, 'geo/GeoLite2-City.mmdb', 'other-geo');
    assert.notEqual(run('seal').status, 0);
    write(directory, 'geo/GeoLite2-City.mmdb', 'retained-geo');
    const required = json(directory, '.next/required-server-files.json');
    required.config.basePath = '';
    write(directory, '.next/required-server-files.json', required);
    assert.notEqual(run('seal').status, 0);
});

function index(arch, image = digest(arch === 'amd64' ? 'a' : 'b')) {
    return { schemaVersion: 2, manifests: [
        { digest: image, size: 1, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { architecture: arch, os: 'linux' } },
        { digest: digest(arch === 'amd64' ? 'c' : 'd'), size: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
            platform: { architecture: 'unknown', os: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': image } },
    ] };
}
test('native index requires one exact native image with bound attestations', () => {
    assert.equal(nativeIndex(index('amd64'), 'amd64'), digest('a'));
    for (const mutate of [i => i.manifests.pop(), i => i.manifests.push(i.manifests[0]), i => i.manifests[0].platform.architecture = 'arm64',
        i => i.manifests[1].annotations['vnd.docker.reference.digest'] = digest('f')]) {
        const value = index('amd64'); mutate(value); assert.throws(() => nativeIndex(value, 'amd64'));
    }
});
test('candidate assembly cannot replace platforms, drop attestations, or introduce extra members', () => {
    const proofs = ['amd64', 'arm64'].map(architecture => ({ architecture, index: index(architecture) }));
    const candidate = { schemaVersion: 2, manifests: proofs.flatMap(proof => proof.index.manifests) };
    verifyCandidate(candidate, proofs);
    for (const mutate of [i => i.manifests.pop(), i => i.manifests.push(i.manifests[0]), i => i.manifests[0].digest = digest('f')]) {
        const value = structuredClone(candidate); mutate(value); assert.throws(() => verifyCandidate(value, proofs));
    }
});

test('native proof admission rejects stale run, source, failed HTTP, and image config substitution', t => {
    const directory = temp(t);
    const identity = { sha: '1'.repeat(40), runId: '12', attempt: '1' };
    const manifest = JSON.stringify({ config: { digest: digest('e') } });
    write(directory, 'native-manifest.json', manifest);
    const nativeDigest = 'sha256:' + hash(manifest);
    const sourceIndex = JSON.stringify(index('amd64', nativeDigest));
    const buildDigest = 'sha256:' + hash(sourceIndex);
    write(directory, 'source-index.json', sourceIndex);
    write(directory, 'build-digest.txt', buildDigest);
    write(directory, 'native-digest.txt', nativeDigest);
    const source = { workflowSha: identity.sha, workflowRunId: identity.runId, workflowAttempt: identity.attempt, architecture: 'amd64',
        buildDigest, nativeDigest, sourceLockSha256: hash(JSON.stringify(sources)) };
    write(directory, 'source-evidence.json', source);
    const inspect = [{ Architecture: 'amd64', Os: 'linux', Id: digest('e'), Config: { Labels: {
        'org.opencontainers.image.revision': identity.sha, 'org.opencontainers.image.base.digest': sources.runtimeBase.indexDigest,
        'io.assistos.umami.source.revision': sources.umami.commit, 'io.assistos.umami.base-path': BASE_PATH,
        'io.assistos.umami-mcp.revision': sources.umamiMcp.commit, 'io.assistos.umami-mcp.bun-lock.sha256': sources.umamiMcp.bunLockSha256,
        'io.assistos.bun.version': sources.bun.version,
    } } }];
    write(directory, 'image-inspect.json', inspect);
    const smoke = { schema: 'ploinky.umami-image-smoke/v1', passed: true, uid: 1000, capabilityEffective: '0', noNewPrivileges: true,
        listener: '127.0.0.1:3001', databaseMigration: true, loginHttp: 200, heartbeatHttp: 200, authLoginHttp: 200, authVerifyHttp: 200,
        trackerHttp: 200, unprefixedNextHttp: 404, metadata: { basePath: BASE_PATH, sourceCommit: sources.umami.commit,
            sourceArchiveSha256: sources.umami.sourceArchive.sha256, pnpmLockSha256: sources.umami.sourceFiles['pnpm-lock.yaml'], runtimeBaseImage: sources.runtimeBase.image },
        assets: ['script', 'css'].map(kind => ({ kind, path: BASE_PATH + '/_next/' + kind, bytes: 100, sha256: 'f'.repeat(64) })) };
    write(directory, 'runtime-smoke.json', smoke);
    verifyNativeProof(directory, 'amd64', identity);
    for (const change of [{ workflowRunId: '11' }, { workflowSha: '2'.repeat(40) }, { sourceLockSha256: 'f'.repeat(64) }]) {
        write(directory, 'source-evidence.json', { ...source, ...change });
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
    }
    write(directory, 'source-evidence.json', source);
    for (const change of [{ authLoginHttp: 500 }, { passed: false }, { uid: 0 }, { assets: [] }]) {
        write(directory, 'runtime-smoke.json', { ...smoke, ...change });
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
    }
    write(directory, 'runtime-smoke.json', smoke);
    inspect[0].Id = digest('f'); write(directory, 'image-inspect.json', inspect);
    assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
});
