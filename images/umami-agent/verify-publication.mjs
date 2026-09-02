import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_PATH } from './smoke-runtime.mjs';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = filename => hash(fs.readFileSync(filename));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const lockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources.lock.json');
const lock = read(lockPath);

export function nativeIndex(index, architecture) {
    assert.ok(['amd64', 'arm64'].includes(architecture));
    assert.equal(index.schemaVersion, 2);
    assert.ok(Array.isArray(index.manifests));
    const images = index.manifests.filter(entry => entry.platform?.os === 'linux');
    assert.equal(images.length, 1, 'native build must contain exactly its own image');
    const image = images[0];
    assert.equal(image.platform.architecture, architecture);
    assert.match(image.digest, digestPattern);
    const attestations = index.manifests.filter(entry => entry !== image);
    assert.ok(attestations.length > 0, 'native build must retain provenance/SBOM attestations');
    const seen = new Set([image.digest]);
    for (const entry of attestations) {
        assert.deepEqual(entry.platform, { architecture: 'unknown', os: 'unknown' });
        assert.equal(entry.annotations?.['vnd.docker.reference.type'], 'attestation-manifest');
        assert.equal(entry.annotations?.['vnd.docker.reference.digest'], image.digest);
        assert.match(entry.digest, digestPattern);
        assert.ok(!seen.has(entry.digest), 'duplicate index member');
        seen.add(entry.digest);
    }
    return image.digest;
}

export function verifyNativeProof(directory, architecture, identity, sources = lock) {
    const indexFile = path.join(directory, 'source-index.json');
    const index = read(indexFile);
    const nativeDigest = nativeIndex(index, architecture);
    const buildDigest = fs.readFileSync(path.join(directory, 'build-digest.txt'), 'utf8').trim();
    assert.equal(buildDigest, 'sha256:' + sha(indexFile));
    assert.equal(fs.readFileSync(path.join(directory, 'native-digest.txt'), 'utf8').trim(), nativeDigest);
    const source = read(path.join(directory, 'source-evidence.json'));
    assert.equal(source.workflowSha, identity.sha);
    assert.equal(source.workflowRunId, identity.runId);
    assert.equal(source.workflowAttempt, identity.attempt);
    assert.equal(source.architecture, architecture);
    assert.equal(source.buildDigest, buildDigest);
    assert.equal(source.nativeDigest, nativeDigest);
    assert.equal(source.sourceLockSha256, hash(JSON.stringify(sources)));
    const inspect = read(path.join(directory, 'image-inspect.json'));
    assert.equal(inspect.length, 1);
    assert.equal(inspect[0].Architecture, architecture);
    assert.equal(inspect[0].Os, 'linux');
    assert.match(inspect[0].Id, digestPattern);
    const labels = inspect[0].Config.Labels;
    assert.equal(labels['org.opencontainers.image.revision'], identity.sha);
    assert.equal(labels['org.opencontainers.image.base.digest'], sources.runtimeBase.indexDigest);
    assert.equal(labels['io.assistos.umami.source.revision'], sources.umami.commit);
    assert.equal(labels['io.assistos.umami.base-path'], BASE_PATH);
    assert.equal(labels['io.assistos.umami-mcp.revision'], sources.umamiMcp.commit);
    assert.equal(labels['io.assistos.umami-mcp.bun-lock.sha256'], sources.umamiMcp.bunLockSha256);
    assert.equal(labels['io.assistos.bun.version'], sources.bun.version);
    const manifest = read(path.join(directory, 'native-manifest.json'));
    assert.equal('sha256:' + sha(path.join(directory, 'native-manifest.json')), nativeDigest);
    assert.equal(manifest.config.digest, inspect[0].Id);
    const smoke = read(path.join(directory, 'runtime-smoke.json'));
    assert.equal(smoke.schema, 'ploinky.umami-image-smoke/v1');
    assert.equal(smoke.passed, true);
    assert.equal(smoke.uid, 1000);
    assert.equal(smoke.capabilityEffective, '0');
    assert.equal(smoke.noNewPrivileges, true);
    assert.equal(smoke.listener, '127.0.0.1:3001');
    assert.equal(smoke.databaseMigration, true);
    for (const field of ['loginHttp', 'heartbeatHttp', 'authLoginHttp', 'authVerifyHttp', 'trackerHttp']) assert.equal(smoke[field], 200);
    assert.equal(smoke.unprefixedNextHttp, 404);
    assert.equal(smoke.metadata.basePath, BASE_PATH);
    assert.equal(smoke.metadata.sourceCommit, sources.umami.commit);
    assert.equal(smoke.metadata.sourceArchiveSha256, sources.umami.sourceArchive.sha256);
    assert.equal(smoke.metadata.pnpmLockSha256, sources.umami.sourceFiles['pnpm-lock.yaml']);
    assert.equal(smoke.metadata.runtimeBaseImage, sources.runtimeBase.image);
    const kinds = new Set();
    for (const asset of smoke.assets) {
        assert.ok(asset.path.startsWith(BASE_PATH + '/_next/'));
        assert.ok(['script', 'css', 'font'].includes(asset.kind));
        assert.ok(asset.bytes > 0);
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        kinds.add(asset.kind);
    }
    assert.ok(kinds.has('script') && kinds.has('css'));
    return { architecture, buildDigest, nativeDigest, index };
}

export function verifyCandidate(candidate, proofs) {
    assert.equal(candidate.schemaVersion, 2);
    assert.deepEqual(proofs.map(proof => proof.architecture).sort(), ['amd64', 'arm64']);
    const expected = proofs.flatMap(proof => proof.index.manifests);
    assert.equal(new Set(expected.map(entry => entry.digest)).size, expected.length);
    assert.equal(candidate.manifests.length, expected.length);
    const canonical = entries => entries.map(entry => ({ digest: entry.digest, mediaType: entry.mediaType,
        size: entry.size, platform: entry.platform, annotations: entry.annotations || {} }))
        .sort((a, b) => a.digest.localeCompare(b.digest));
    assert.deepEqual(canonical(candidate.manifests), canonical(expected),
        'candidate must preserve exactly the proven native images and their attestations');
}

function main() {
    const [mode, directory, architecture] = process.argv.slice(2);
    if (mode === 'native-index') {
        console.log(nativeIndex(read(path.join(directory, 'source-index.json')), architecture));
        return;
    }
    const identity = { sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
    assert.match(identity.sha, /^[a-f0-9]{40}$/);
    assert.match(identity.runId, /^\d+$/);
    assert.match(identity.attempt, /^\d+$/);
    if (mode === 'seal-native') {
        fs.writeFileSync(path.join(directory, 'source-evidence.json'), JSON.stringify({
            workflowSha: identity.sha, workflowRunId: identity.runId, workflowAttempt: identity.attempt,
            architecture, buildDigest: fs.readFileSync(path.join(directory, 'build-digest.txt'), 'utf8').trim(),
            nativeDigest: fs.readFileSync(path.join(directory, 'native-digest.txt'), 'utf8').trim(),
            sourceLockSha256: hash(JSON.stringify(lock)),
        }, null, 2) + '\n', { flag: 'wx' });
        verifyNativeProof(directory, architecture, identity);
        return;
    }
    assert.ok(['proofs', 'candidate'].includes(mode));
    assert.deepEqual(fs.readdirSync(directory).sort(), ['umami-proof-amd64', 'umami-proof-arm64']);
    const proofs = ['amd64', 'arm64'].map(arch => verifyNativeProof(path.join(directory, 'umami-proof-' + arch), arch, identity));
    if (mode === 'candidate') verifyCandidate(read(architecture), proofs);
    else for (const proof of proofs) console.log(`${proof.architecture}_digest=${proof.buildDigest}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
