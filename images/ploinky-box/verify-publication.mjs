import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY = 'docker.io/assistos/ploinky-box';
const ARCHITECTURES = ['amd64', 'arm64'];
const RAW_FILES = ['image-inspect.json', 'immutable-webtty.json', 'native-probe.json'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function publicationContext(sourceRoot, env = process.env) {
    for (const value of [env.SOURCE_SHA, env.GITHUB_SHA]) assert.match(value || '', /^[0-9a-f]{40}$/);
    for (const value of [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT]) assert.match(value || '', /^[1-9][0-9]*$/);
    const { validateNativeProbeResult } = await import(pathToFileURL(path.resolve(sourceRoot, 'core-services/webtty/native-runtime.mjs')));
    return {
        sourceCommit: env.SOURCE_SHA,
        imageDefinitionsCommit: env.GITHUB_SHA,
        workflow: { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT },
        probeSha256: sha256(fs.readFileSync(path.join(sourceRoot, 'core-services/webtty/native-probe.mjs'))),
        packageLockSha256: sha256(fs.readFileSync(path.join(sourceRoot, 'core-services/webtty/package-lock.json'))),
        verifierSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
        validateNativeProbeResult,
    };
}

export function verifyNativeEvidence(directory, architecture, digest, context) {
    assert.ok(ARCHITECTURES.includes(architecture), 'unsupported native architecture');
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    const images = readJson(path.join(directory, 'image-inspect.json'));
    assert.equal(images.length, 1, 'expected one immutable image');
    const [image] = images;
    assert.equal(image.Os, 'linux');
    assert.equal(image.Architecture, architecture);
    assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
    assert.ok(image.RepoDigests?.some((value) => value === `${REPOSITORY}@${digest}` || value === `assistos/ploinky-box@${digest}`), 'image does not resolve the requested digest');
    assert.equal(image.Config?.User, 'podman');
    assert.deepEqual(image.Config?.Entrypoint, ['/usr/local/bin/ploinky-box-entrypoint']);
    assert.deepEqual(image.Config?.Labels || {}, {});
    const probe = readJson(path.join(directory, 'native-probe.json'));
    context.validateNativeProbeResult(probe, { architecture, platform: 'linux', uid: 1000, gid: 1000 });
    assert.equal(probe.sourceSha, context.sourceCommit);
    assert.equal(probe.packageLockSha256, context.packageLockSha256);
    const immutable = readJson(path.join(directory, 'immutable-webtty.json'));
    assert.deepEqual(Object.keys(immutable).sort(), ['contract', 'probeSha256']);
    assert.equal(immutable.probeSha256, context.probeSha256, 'image probe differs from selected source');
    assert.deepEqual(immutable.contract, probe, 'runtime proof differs from the sealed build contract');
    const evidenceSha256 = Object.fromEntries(RAW_FILES.map((name) => [name, sha256(fs.readFileSync(path.join(directory, name)))]));
    return {
        schema: 'ploinky.box.native-publication/v1',
        sourceCommit: context.sourceCommit,
        imageDefinitionsCommit: context.imageDefinitionsCommit,
        workflow: context.workflow,
        image: { repository: REPOSITORY, digest, configDigest: image.Id, platform: `linux/${architecture}` },
        probeSha256: context.probeSha256,
        packageLockSha256: context.packageLockSha256,
        verifierSha256: context.verifierSha256,
        evidenceSha256,
        native: probe,
    };
}

export function verifyNativeProofs(root, context) {
    assert.deepEqual(fs.readdirSync(root).sort(), ARCHITECTURES.map((arch) => `ploinky-box-native-${arch}`));
    return Object.fromEntries(ARCHITECTURES.map((architecture) => {
        const directory = path.join(root, `ploinky-box-native-${architecture}`);
        const digest = fs.readFileSync(path.join(directory, 'digest.txt'), 'utf8').trim();
        const expected = verifyNativeEvidence(directory, architecture, digest, context);
        assert.deepEqual(readJson(path.join(directory, 'native-proof.json')), expected, 'native proof source, run, image, or evidence changed');
        return [architecture, expected];
    }));
}

export function verifyCandidate(root, indexFile, context) {
    const proofs = verifyNativeProofs(root, context);
    const raw = fs.readFileSync(indexFile);
    const index = JSON.parse(raw);
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.manifests?.length, 2, 'expected exactly two native image members');
    const members = new Map(index.manifests.map((entry) => [`${entry.platform?.os}/${entry.platform?.architecture}`, entry.digest]));
    assert.deepEqual([...members.keys()].sort(), ['linux/amd64', 'linux/arm64']);
    assert.notEqual(proofs.amd64.image.digest, proofs.arm64.image.digest);
    for (const architecture of ARCHITECTURES) assert.equal(members.get(`linux/${architecture}`), proofs[architecture].image.digest);
    const annotations = index.annotations || {};
    for (const [key, value] of Object.entries({
        'workflow-run': context.workflow.runId,
        'workflow-attempt': context.workflow.runAttempt,
        'source-sha': context.sourceCommit,
        'image-definitions-sha': context.imageDefinitionsCommit,
        'amd64-digest': proofs.amd64.image.digest,
        'arm64-digest': proofs.arm64.image.digest,
    })) assert.equal(annotations[`io.assistos.ploinky.${key}`], value);
    return {
        schema: 'ploinky.box.candidate-publication/v1',
        sourceCommit: context.sourceCommit,
        imageDefinitionsCommit: context.imageDefinitionsCommit,
        workflow: context.workflow,
        image: { repository: REPOSITORY, digest: `sha256:${sha256(raw)}`, platforms: Object.fromEntries(ARCHITECTURES.map((arch) => [arch, proofs[arch].image.digest])) },
        probeSha256: context.probeSha256,
        packageLockSha256: context.packageLockSha256,
        verifierSha256: context.verifierSha256,
        nativeProofSha256: Object.fromEntries(ARCHITECTURES.map((arch) => [arch, sha256(fs.readFileSync(path.join(root, `ploinky-box-native-${arch}`, 'native-proof.json')))])),
    };
}

async function main() {
    const [command, evidencePath, sourceRoot, architectureOrIndex, digest] = process.argv.slice(2);
    const context = await publicationContext(sourceRoot);
    if (command === 'native') {
        const proof = verifyNativeEvidence(evidencePath, architectureOrIndex, digest, context);
        fs.writeFileSync(path.join(evidencePath, 'native-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
    } else if (command === 'proofs') {
        const proofs = verifyNativeProofs(evidencePath, context);
        assert.notEqual(proofs.amd64.image.digest, proofs.arm64.image.digest);
        for (const arch of ARCHITECTURES) process.stdout.write(`${arch}_digest=${proofs[arch].image.digest}\n`);
    } else if (command === 'candidate') {
        process.stdout.write(`${JSON.stringify(verifyCandidate(evidencePath, architectureOrIndex, context), null, 2)}\n`);
    } else throw new Error('expected native, proofs, or candidate');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
