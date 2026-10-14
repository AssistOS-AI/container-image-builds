import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
    assembleIndex,
    describeLayout,
    serializeReleaseIndex,
    verifyLayerDiffIds,
    verifyLoadedImage,
    verifyReleaseIndex,
} from '../scripts/oci-layout-index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/oci-layout-index.mjs');
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const digestOf = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function scratch(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-layout-index-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function writeBlob(layout, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const digest = digestOf(bytes);
    fs.mkdirSync(path.join(layout, 'blobs', 'sha256'), { recursive: true });
    fs.writeFileSync(path.join(layout, 'blobs', 'sha256', digest.slice(7)), bytes);
    return { digest, size: bytes.length };
}

// Builds a minimal single-platform layout. `nested` mirrors buildx output
// that wraps the manifest in a one-member index.
function makeLayout(directory, { architecture, variant, os: imageOs = 'linux', layers = ['a', 'b'], nested = false, extraMember = false }) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    // Each layer is real gzip whose expansion hashes to its diff ID.
    const layerDescriptors = layers.map(content => ({
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        ...writeBlob(directory, zlib.gzipSync(Buffer.from(`${architecture}-${content}`))),
    }));
    const config = {
        architecture,
        os: imageOs,
        config: { Entrypoint: ['tini', '--'], Env: ['PATH=/usr/bin'], WorkingDir: '/code', Labels: { source: 'test' } },
        rootfs: { type: 'layers', diff_ids: layers.map(content => digestOf(Buffer.from(`${architecture}-${content}`))) },
    };
    if (variant !== undefined) {
        config.variant = variant;
    }
    const configDescriptor = { mediaType: 'application/vnd.oci.image.config.v1+json', ...writeBlob(directory, config) };
    const manifest = { schemaVersion: 2, mediaType: manifestType, config: configDescriptor, layers: layerDescriptors };
    const manifestDescriptor = { mediaType: manifestType, ...writeBlob(directory, manifest) };
    let top = manifestDescriptor;
    if (nested) {
        const members = [{ ...manifestDescriptor, platform: { architecture, os: imageOs } }];
        if (extraMember) {
            members.push({ ...manifestDescriptor, digest: writeBlob(directory, { attestation: true }).digest, platform: { architecture: 'unknown', os: 'unknown' } });
        }
        top = { mediaType: indexType, ...writeBlob(directory, { schemaVersion: 2, mediaType: indexType, manifests: members }) };
    }
    fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [top] }));
    return { manifestDigest: manifestDescriptor.digest, diffIds: config.rootfs.diff_ids, layerDigests: layerDescriptors.map(layer => layer.digest) };
}

function twoLayouts(directory) {
    const amd64 = path.join(directory, 'amd64');
    const arm64 = path.join(directory, 'arm64');
    makeLayout(amd64, { architecture: 'amd64' });
    makeLayout(arm64, { architecture: 'arm64', nested: true });
    return { amd64, arm64 };
}

test('describeLayout reads plain and one-member-index layouts and verifies every blob', t => {
    const directory = scratch(t);
    const plain = makeLayout(path.join(directory, 'plain'), { architecture: 'amd64' });
    const nested = makeLayout(path.join(directory, 'nested'), { architecture: 'arm64', variant: 'v8', nested: true });

    const plainDescription = describeLayout(path.join(directory, 'plain'));
    assert.equal(plainDescription.platform, 'linux/amd64');
    assert.equal(plainDescription.manifest.digest, plain.manifestDigest);
    assert.deepEqual(plainDescription.diffIds, plain.diffIds);
    assert.deepEqual(plainDescription.platformDescriptor, { architecture: 'amd64', os: 'linux' });

    const nestedDescription = describeLayout(path.join(directory, 'nested'));
    assert.equal(nestedDescription.platform, 'linux/arm64');
    assert.equal(nestedDescription.manifest.digest, nested.manifestDigest);
    assert.deepEqual(nestedDescription.platformDescriptor, { architecture: 'arm64', os: 'linux', variant: 'v8' });
});

test('describeLayout rejects corrupted layers, attestation members, and unsupported platforms', t => {
    const directory = scratch(t);
    const corrupted = makeLayout(path.join(directory, 'corrupted'), { architecture: 'amd64' });
    fs.writeFileSync(path.join(directory, 'corrupted', 'blobs', 'sha256', corrupted.layerDigests[1].slice(7)), 'tampered');
    assert.throws(() => describeLayout(path.join(directory, 'corrupted')), /mismatch/);

    makeLayout(path.join(directory, 'attested'), { architecture: 'amd64', nested: true, extraMember: true });
    assert.throws(() => describeLayout(path.join(directory, 'attested')), /no attestations/);

    makeLayout(path.join(directory, 'riscv'), { architecture: 'riscv64' });
    assert.throws(() => describeLayout(path.join(directory, 'riscv')), /unsupported image platform linux\/riscv64/);

    makeLayout(path.join(directory, 'windows'), { architecture: 'amd64', os: 'windows' });
    assert.throws(() => describeLayout(path.join(directory, 'windows')), /must target linux/);
});

test('verifyLayerDiffIds proves stored layers expand to the declared root filesystem', async t => {
    const directory = scratch(t);
    const layout = path.join(directory, 'layout');
    makeLayout(layout, { architecture: 'amd64' });
    const description = describeLayout(layout);
    await verifyLayerDiffIds(layout, description);

    // A plain tar layer's diff ID is its own digest.
    await verifyLayerDiffIds(layout, {
        ...description,
        layers: [description.diffIds[0]],
        layerMediaTypes: ['application/vnd.oci.image.layer.v1.tar'],
        diffIds: [description.diffIds[0]],
    });

    // Valid gzip of different content still fails: the blob digest matches
    // the manifest, but it does not expand to the declared diff ID.
    await assert.rejects(verifyLayerDiffIds(layout, { ...description, diffIds: [...description.diffIds].reverse() }), /does not expand to diff ID/);
    await assert.rejects(verifyLayerDiffIds(layout, { ...description, layerMediaTypes: description.layerMediaTypes.map(() => 'application/vnd.oci.image.layer.v1.tar+zstd') }), /unverifiable media type/);
    await assert.rejects(verifyLayerDiffIds(layout, { ...description, layerMediaTypes: undefined }), /lacks layer media types/);
    const notGzip = path.join(directory, 'not-gzip');
    makeLayout(notGzip, { architecture: 'arm64' });
    const notGzipDescription = describeLayout(notGzip);
    fs.writeFileSync(path.join(notGzip, 'blobs', 'sha256', notGzipDescription.layers[0].slice(7)), 'plain bytes');
    await assert.rejects(verifyLayerDiffIds(notGzip, notGzipDescription));
});

test('verifyLoadedImage binds a loaded image to the archived root filesystem and runtime config', t => {
    const directory = scratch(t);
    makeLayout(path.join(directory, 'layout'), { architecture: 'arm64' });
    const description = describeLayout(path.join(directory, 'layout'));
    assert.deepEqual(description.runtimeConfig, {
        Entrypoint: ['tini', '--'], Cmd: null, Env: ['PATH=/usr/bin'], User: '', WorkingDir: '/code', Labels: { source: 'test' },
    });
    // Docker reports absent fields as null or '', and an empty Cmd as null.
    const loadedConfig = { Entrypoint: ['tini', '--'], Cmd: [], Env: ['PATH=/usr/bin'], User: '', WorkingDir: '/code', Labels: { source: 'test' } };
    const inspect = [{ Os: 'linux', Architecture: 'arm64', RootFS: { Type: 'layers', Layers: description.diffIds }, Config: loadedConfig }];
    verifyLoadedImage(description, inspect);
    assert.throws(() => verifyLoadedImage(description, [{ ...inspect[0], Architecture: 'amd64' }]));
    assert.throws(() => verifyLoadedImage(description, [{ ...inspect[0], RootFS: { Layers: description.diffIds.slice(1) } }]), /root filesystem/);
    assert.throws(() => verifyLoadedImage(description, [{ ...inspect[0], Config: { ...loadedConfig, Entrypoint: ['sh'] } }]), /runtime configuration/);
    assert.throws(() => verifyLoadedImage(description, [{ ...inspect[0], Config: { ...loadedConfig, User: 'root' } }]), /runtime configuration/);
    assert.throws(() => verifyLoadedImage(description, [{ ...inspect[0], Config: { ...loadedConfig, Labels: null } }]), /runtime configuration/);
    assert.throws(() => verifyLoadedImage({ ...description, runtimeConfig: undefined }, inspect), /runtime configuration/);
    assert.throws(() => verifyLoadedImage(description, [inspect[0], inspect[0]]), /exactly one/);
});

// Indexes BuildKit published for these images: OnlyOffice and Egress through
// the Buildx OCI exporter, LiveKit through build-push-action. The fixtures are
// the registry's raw bytes, so their digests are the published references.
const BUILDKIT_INDEXES = {
    'onlyoffice-agent': 'sha256:70484bd71c144af9ef28e5599ce99272c715c7bac011e90e0e64f49ac7312839',
    'livekit-server-agent': 'sha256:fc05e4349bc1eab5a1f28ad4bd8a7ec3324867bdaf526eb55c4cdb7031b46eea',
    'livekit-egress': 'sha256:0e70e2dd162582153984a0969cba7eb76f1ac0283246e889d7817c297224c7f6',
};

test('serializeReleaseIndex reproduces BuildKit multiplatform indexes byte for byte', () => {
    for (const [name, digest] of Object.entries(BUILDKIT_INDEXES)) {
        const raw = fs.readFileSync(path.join(root, 'tests/fixtures/buildkit-indexes', `${name}.json`));
        assert.equal(digestOf(raw), digest, `${name} fixture is not the published index`);
        const members = JSON.parse(raw).manifests.map(entry => ({
            manifest: { mediaType: entry.mediaType, digest: entry.digest, size: entry.size },
            platformDescriptor: entry.platform,
        }));
        const serialized = serializeReleaseIndex(members);
        assert.ok(serialized.equals(raw), `${name} serialization differs from BuildKit`);
        assert.equal(digestOf(serialized), digest);
    }
});

test('assembleIndex writes a BuildKit-identical, deterministic two-platform index from proven members', t => {
    const directory = scratch(t);
    const layouts = twoLayouts(directory);
    const proofs = { amd64: describeLayout(layouts.amd64), arm64: describeLayout(layouts.arm64) };
    const members = [
        { platform: 'linux/amd64', layout: layouts.amd64, proof: proofs.amd64 },
        { platform: 'linux/arm64', layout: layouts.arm64, proof: proofs.arm64 },
    ];
    const first = assembleIndex({ members, outDir: path.join(directory, 'first') });
    const second = assembleIndex({ members, outDir: path.join(directory, 'second') });
    assert.equal(first.digest, second.digest);
    assert.deepEqual(first.members, { 'linux/amd64': proofs.amd64.manifest.digest, 'linux/arm64': proofs.arm64.manifest.digest });

    const top = JSON.parse(fs.readFileSync(path.join(directory, 'first', 'index.json'), 'utf8'));
    assert.deepEqual(top.manifests, [{ mediaType: indexType, digest: first.digest, size: first.size }]);
    const indexBytes = fs.readFileSync(path.join(directory, 'first', 'blobs', 'sha256', first.digest.slice(7)));
    assert.equal(digestOf(indexBytes), first.digest);
    const index = JSON.parse(indexBytes);
    assert.deepEqual(index.manifests.map(entry => entry.platform), [{ architecture: 'amd64', os: 'linux' }, { architecture: 'arm64', os: 'linux' }]);
    assert.equal(index.annotations, undefined);
    assert.ok(indexBytes.equals(serializeReleaseIndex(Object.values(proofs))), 'assembled index must use the BuildKit serialization');
    assert.notEqual(indexBytes.at(-1), 0x0a, 'BuildKit writes no trailing newline');
    verifyReleaseIndex(indexBytes, { digest: first.digest, members: first.members });

    // The assembled layout is itself a valid input: each member resolves.
    for (const description of Object.values(proofs)) {
        for (const digest of [description.manifest.digest, description.config, ...description.layers]) {
            assert.ok(fs.existsSync(path.join(directory, 'first', 'blobs', 'sha256', digest.slice(7))), `missing blob ${digest}`);
        }
    }
});

test('assembleIndex refuses wrong order, mismatched proofs, wrong platforms, and reused output', t => {
    const directory = scratch(t);
    const layouts = twoLayouts(directory);
    const proofs = { amd64: describeLayout(layouts.amd64), arm64: describeLayout(layouts.arm64) };
    const good = [
        { platform: 'linux/amd64', layout: layouts.amd64, proof: proofs.amd64 },
        { platform: 'linux/arm64', layout: layouts.arm64, proof: proofs.arm64 },
    ];
    assert.throws(() => assembleIndex({ members: [...good].reverse(), outDir: path.join(directory, 'reversed') }));
    assert.throws(() => assembleIndex({ members: [good[0], { ...good[1], proof: proofs.amd64 }], outDir: path.join(directory, 'proof') }), /native proof/);
    assert.throws(() => assembleIndex({ members: [good[0], { ...good[1], layout: layouts.amd64 }], outDir: path.join(directory, 'platform') }), /is not linux\/arm64/);
    fs.mkdirSync(path.join(directory, 'used'));
    fs.writeFileSync(path.join(directory, 'used', 'leftover'), '');
    assert.throws(() => assembleIndex({ members: good, outDir: path.join(directory, 'used') }), /new or empty/);
});

test('verifyReleaseIndex enforces the exact platform set, digest, and members', () => {
    const member = platform => ({ mediaType: manifestType, digest: digestOf(Buffer.from(platform)), size: 1, platform: { architecture: platform.split('/')[1], os: 'linux' } });
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [member('linux/amd64'), member('linux/arm64')] }));
    const result = verifyReleaseIndex(bytes, { digest: digestOf(bytes), members: { 'linux/arm64': digestOf(Buffer.from('linux/arm64')) } });
    assert.equal(result.digest, digestOf(bytes));

    const attested = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [member('linux/amd64'), member('linux/arm64'), { ...member('linux/amd64'), platform: { architecture: 'unknown', os: 'unknown' } }] }));
    assert.throws(() => verifyReleaseIndex(attested), /no attestations/);
    const amd64Only = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [member('linux/amd64'), member('linux/amd64')] }));
    assert.throws(() => verifyReleaseIndex(amd64Only));
    assert.throws(() => verifyReleaseIndex(bytes, { digest: `sha256:${'0'.repeat(64)}` }), /does not equal/);
    assert.throws(() => verifyReleaseIndex(bytes, { members: { 'linux/amd64': `sha256:${'0'.repeat(64)}` } }), /member differs/);
});

test('command line assembles from proofs and prints the index digest', t => {
    const directory = scratch(t);
    const layouts = twoLayouts(directory);
    const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    for (const arch of ['amd64', 'arm64']) {
        const described = run(['describe', layouts[arch], '--platform', `linux/${arch}`]);
        assert.equal(described.status, 0, described.stderr);
        fs.writeFileSync(path.join(directory, `${arch}.json`), described.stdout);
    }
    assert.notEqual(run(['describe', layouts.amd64, '--platform', 'linux/arm64']).status, 0);
    const wrongRootfs = path.join(directory, 'wrong-rootfs');
    makeLayout(wrongRootfs, { architecture: 'amd64' });
    const wrongDescription = describeLayout(wrongRootfs);
    const configPath = path.join(wrongRootfs, 'blobs', 'sha256', wrongDescription.config.slice(7));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.rootfs.diff_ids.reverse();
    // Rewrite config and manifest so every compressed digest still verifies.
    const configBlob = writeBlob(wrongRootfs, config);
    const manifestPath = path.join(wrongRootfs, 'blobs', 'sha256', wrongDescription.manifest.digest.slice(7));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.config = { ...manifest.config, ...configBlob };
    const manifestBlob = writeBlob(wrongRootfs, manifest);
    fs.writeFileSync(path.join(wrongRootfs, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: manifestType, ...manifestBlob }] }));
    assert.equal(describeLayout(wrongRootfs).manifest.digest, manifestBlob.digest);
    const rejected = run(['describe', wrongRootfs]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not expand to diff ID/);

    const assembled = run([
        'assemble', '--out', path.join(directory, 'out'),
        '--member', `linux/amd64=${layouts.amd64}`, '--proof', `linux/amd64=${path.join(directory, 'amd64.json')}`,
        '--member', `linux/arm64=${layouts.arm64}`, '--proof', `linux/arm64=${path.join(directory, 'arm64.json')}`,
    ]);
    assert.equal(assembled.status, 0, assembled.stderr);
    const { digest } = JSON.parse(assembled.stdout);
    const indexFile = path.join(directory, 'out', 'blobs', 'sha256', digest.slice(7));
    const verified = run(['verify-index', indexFile, '--expected-digest', digest]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.notEqual(run(['verify-index', indexFile, '--expected-digest', `sha256:${'0'.repeat(64)}`]).status, 0);
    assert.notEqual(run(['assemble', '--out', path.join(directory, 'missing-proof'), '--member', `linux/amd64=${layouts.amd64}`]).status, 0);
});
