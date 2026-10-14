#!/usr/bin/env node
// Assembles a two-platform OCI image index from single-platform OCI layouts
// that native runners built and tested. Nothing here contacts a registry: the
// publishing workflows verify the assembled index digest first and only then
// copy the layout with `skopeo copy --all`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const RELEASE_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const GZIP_LAYER_TYPES = new Set([
    'application/vnd.oci.image.layer.v1.tar+gzip',
    'application/vnd.docker.image.rootfs.diff.tar.gzip',
]);
const PLAIN_LAYER_TYPES = new Set([
    'application/vnd.oci.image.layer.v1.tar',
    'application/vnd.docker.image.rootfs.diff.tar',
]);
const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const INDEX_MEDIA_TYPES = new Set([INDEX_MEDIA_TYPE, 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_MEDIA_TYPES = new Set([
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
]);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const annotationKeyPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/;

const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

function blobPath(layout, digest) {
    assert.match(digest, digestPattern, `malformed blob digest ${digest}`);
    return path.join(layout, 'blobs', 'sha256', digest.slice('sha256:'.length));
}

function fileDigest(filename) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    const fd = fs.openSync(filename, 'r');
    try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, count));
        }
    } finally {
        fs.closeSync(fd);
    }
    return `sha256:${hash.digest('hex')}`;
}

function verifyBlob(layout, descriptor) {
    assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0, `invalid size for ${descriptor.digest}`);
    const filename = blobPath(layout, descriptor.digest);
    assert.equal(fs.statSync(filename).size, descriptor.size, `size mismatch for ${descriptor.digest}`);
    assert.equal(fileDigest(filename), descriptor.digest, `content mismatch for ${descriptor.digest}`);
}

function readBlob(layout, descriptor) {
    verifyBlob(layout, descriptor);
    return fs.readFileSync(blobPath(layout, descriptor.digest));
}

function platformOf(config) {
    assert.equal(config.os, 'linux', 'image config must target linux');
    const platform = `${config.os}/${config.architecture}`;
    assert.ok(RELEASE_PLATFORMS.includes(platform), `unsupported image platform ${platform}`);
    const descriptor = { architecture: config.architecture, os: config.os };
    if (config.variant !== undefined) {
        assert.equal(platform, 'linux/arm64', `unexpected platform variant on ${platform}`);
        assert.equal(config.variant, 'v8', `unexpected arm64 variant ${config.variant}`);
        descriptor.variant = config.variant;
    }
    return { platform, descriptor };
}

// Describes the one image in a single-platform layout and verifies every blob
// it references. Buildx writes either the manifest itself or a one-member
// index into index.json; attestation members are rejected.
export function describeLayout(layout) {
    assert.deepEqual(readJson(path.join(layout, 'oci-layout')), { imageLayoutVersion: '1.0.0' });
    const root = readJson(path.join(layout, 'index.json'));
    assert.equal(root.schemaVersion, 2);
    assert.ok(Array.isArray(root.manifests) && root.manifests.length === 1, 'layout must reference exactly one image');
    let descriptor = root.manifests[0];
    if (INDEX_MEDIA_TYPES.has(descriptor.mediaType)) {
        const nested = JSON.parse(readBlob(layout, descriptor));
        assert.ok(Array.isArray(nested.manifests) && nested.manifests.length === 1,
            'single-platform layout must contain exactly one image manifest and no attestations');
        descriptor = nested.manifests[0];
    }
    assert.ok(MANIFEST_MEDIA_TYPES.has(descriptor.mediaType), `unsupported manifest media type ${descriptor.mediaType}`);
    const manifest = JSON.parse(readBlob(layout, descriptor));
    assert.equal(manifest.schemaVersion, 2);
    if (manifest.mediaType !== undefined) {
        assert.equal(manifest.mediaType, descriptor.mediaType);
    }
    const config = JSON.parse(readBlob(layout, manifest.config));
    assert.ok(Array.isArray(manifest.layers) && manifest.layers.length > 0, 'image must have layers');
    for (const layer of manifest.layers) {
        verifyBlob(layout, layer);
    }
    const diffIds = config.rootfs?.diff_ids;
    assert.ok(Array.isArray(diffIds) && diffIds.length === manifest.layers.length, 'config diff_ids must match the layer list');
    for (const diffId of diffIds) {
        assert.match(diffId, digestPattern);
    }
    const { platform, descriptor: platformDescriptor } = platformOf(config);
    return {
        platform,
        platformDescriptor,
        manifest: { mediaType: descriptor.mediaType, digest: descriptor.digest, size: descriptor.size },
        config: manifest.config.digest,
        layers: manifest.layers.map(layer => layer.digest),
        layerMediaTypes: manifest.layers.map(layer => layer.mediaType),
        diffIds,
        runtimeConfig: runtimeConfigOf(config.config),
    };
}

async function uncompressedDigest(filename) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filename), zlib.createGunzip(), async source => {
        for await (const chunk of source) {
            hash.update(chunk);
        }
    });
    return `sha256:${hash.digest('hex')}`;
}

// Proves that every stored layer expands to the root filesystem its config
// declares. Runtimes verify diff IDs when they load an image, so this makes
// the published blobs equivalent to the image the native gates tested.
// Compression this helper cannot expand with Node built-ins is rejected.
export async function verifyLayerDiffIds(layout, description) {
    assert.equal(description.layerMediaTypes?.length, description.layers.length, 'layout description lacks layer media types');
    for (const [index, digest] of description.layers.entries()) {
        const mediaType = description.layerMediaTypes[index];
        let actual;
        if (GZIP_LAYER_TYPES.has(mediaType)) {
            actual = await uncompressedDigest(blobPath(layout, digest));
        } else if (PLAIN_LAYER_TYPES.has(mediaType)) {
            actual = digest;
        } else {
            assert.fail(`layer ${digest} has unverifiable media type ${mediaType}`);
        }
        assert.equal(actual, description.diffIds[index], `layer ${digest} does not expand to diff ID ${description.diffIds[index]}`);
    }
}

// The runtime fields a container starts from. Runtimes report an absent list or
// map as null and an absent string as '', so both sides are normalized alike.
const RUNTIME_LIST_FIELDS = ['Entrypoint', 'Cmd', 'Env'];
const RUNTIME_STRING_FIELDS = ['User', 'WorkingDir'];

function runtimeConfigOf(config = {}) {
    const runtime = {};
    for (const field of RUNTIME_LIST_FIELDS) {
        const value = config?.[field];
        runtime[field] = Array.isArray(value) && value.length > 0 ? value : null;
    }
    for (const field of RUNTIME_STRING_FIELDS) {
        runtime[field] = typeof config?.[field] === 'string' ? config[field] : '';
    }
    const labels = config?.Labels;
    runtime.Labels = labels && Object.keys(labels).length > 0 ? labels : null;
    return runtime;
}

// Proves that the image a runtime loaded has the archived layout's platform,
// root filesystem, and runtime configuration. Diff IDs and these fields
// survive the OCI to Docker conversion that loading performs, so this binds the
// tested image to the bytes that are later published.
export function verifyLoadedImage(description, inspect) {
    const records = Array.isArray(inspect) ? inspect : [inspect];
    assert.equal(records.length, 1, 'expected exactly one inspected image');
    const [image] = records;
    assert.equal(`${image.Os}/${image.Architecture}`, description.platform);
    assert.deepEqual(image.RootFS?.Layers, description.diffIds, 'loaded image root filesystem differs from the archived layout');
    assert.ok(description.runtimeConfig, 'layout description lacks its runtime configuration');
    assert.deepEqual(runtimeConfigOf(image.Config), description.runtimeConfig, 'loaded image runtime configuration differs from the archived layout');
}

function linkBlob(source, target, digest) {
    const to = blobPath(target, digest);
    if (fs.existsSync(to)) {
        return;
    }
    try {
        fs.linkSync(blobPath(source, digest), to);
    } catch {
        fs.copyFileSync(blobPath(source, digest), to);
    }
}

function sortedAnnotations(annotations) {
    const entries = Object.entries(annotations).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [key, value] of entries) {
        assert.match(key, annotationKeyPattern, `malformed annotation key ${key}`);
        assert.equal(typeof value, 'string');
        assert.ok(value.length > 0, `empty annotation ${key}`);
    }
    return Object.fromEntries(entries);
}

// Writes a new layout holding exactly the amd64 and arm64 members, in that
// order, under a canonical index. Equal member bytes and annotations always
// give the same index digest, so an approved digest can be checked before any
// registry mutation. Each member must match the proof its native job recorded.
export function assembleIndex({ members, outDir, annotations = {} }) {
    assert.deepEqual(members.map(member => member.platform), RELEASE_PLATFORMS);
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'output layout directory must be new or empty');
    fs.mkdirSync(path.join(outDir, 'blobs', 'sha256'), { recursive: true });
    const described = members.map(member => {
        const description = describeLayout(member.layout);
        assert.equal(description.platform, member.platform, `layout ${member.layout} is not ${member.platform}`);
        if (member.proof !== undefined) {
            assert.equal(description.manifest.digest, member.proof.manifest?.digest, `${member.platform} manifest differs from its native proof`);
            assert.deepEqual(description.diffIds, member.proof.diffIds, `${member.platform} root filesystem differs from its native proof`);
        }
        for (const digest of [description.manifest.digest, description.config, ...description.layers]) {
            linkBlob(member.layout, outDir, digest);
        }
        return description;
    });
    assert.notEqual(described[0].manifest.digest, described[1].manifest.digest);
    const index = {
        schemaVersion: 2,
        mediaType: INDEX_MEDIA_TYPE,
        manifests: described.map(description => ({
            ...description.manifest,
            platform: description.platformDescriptor,
        })),
    };
    const canonicalAnnotations = sortedAnnotations(annotations);
    if (Object.keys(canonicalAnnotations).length > 0) {
        index.annotations = canonicalAnnotations;
    }
    const bytes = Buffer.from(JSON.stringify(index));
    const digest = sha256(bytes);
    fs.writeFileSync(blobPath(outDir, digest), bytes);
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
        schemaVersion: 2,
        mediaType: INDEX_MEDIA_TYPE,
        manifests: [{ mediaType: INDEX_MEDIA_TYPE, digest, size: bytes.length }],
    }));
    fs.writeFileSync(path.join(outDir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    return {
        digest,
        size: bytes.length,
        members: Object.fromEntries(described.map(description => [description.platform, description.manifest.digest])),
    };
}

// Checks raw index bytes, for example a registry's copy of a published index or
// an input index, against the exact release platform set.
export function verifyReleaseIndex(bytes, expected = {}) {
    const index = JSON.parse(bytes);
    assert.equal(index.schemaVersion, 2);
    assert.ok(INDEX_MEDIA_TYPES.has(index.mediaType), 'not an image index');
    assert.ok(Array.isArray(index.manifests) && index.manifests.length === RELEASE_PLATFORMS.length,
        'index must contain exactly the release platforms and no attestations');
    const members = new Map(index.manifests.map(entry => [`${entry.platform?.os}/${entry.platform?.architecture}`, entry.digest]));
    assert.deepEqual([...members.keys()].sort(), [...RELEASE_PLATFORMS]);
    for (const digest of members.values()) {
        assert.match(digest, digestPattern);
    }
    const digest = sha256(bytes);
    if (expected.digest !== undefined) {
        assert.equal(digest, expected.digest, `index digest ${digest} does not equal ${expected.digest}`);
    }
    for (const [platform, memberDigest] of Object.entries(expected.members || {})) {
        assert.equal(members.get(platform), memberDigest, `${platform} member differs`);
    }
    return { digest, members: Object.fromEntries(members) };
}

function parsePairs(values, flag) {
    return values.map(value => {
        const separator = value.indexOf('=');
        assert.ok(separator > 0, `${flag} expects key=value, got ${value}`);
        return [value.slice(0, separator), value.slice(separator + 1)];
    });
}

function parseArguments(argv) {
    const options = { member: [], proof: [], annotation: [], positional: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const flag = argument.startsWith('--') ? argument.slice(2) : null;
        if (flag === null) {
            options.positional.push(argument);
            continue;
        }
        assert.ok(index + 1 < argv.length, `--${flag} needs a value`);
        const value = argv[++index];
        if (Array.isArray(options[flag])) {
            options[flag].push(value);
        } else {
            assert.ok(['out', 'platform', 'expected-digest'].includes(flag), `unknown option --${flag}`);
            options[flag] = value;
        }
    }
    return options;
}

async function main(argv) {
    const [command, ...rest] = argv;
    const options = parseArguments(rest);
    if (command === 'describe') {
        assert.equal(options.positional.length, 1, 'usage: describe <layout> [--platform os/arch]');
        const description = describeLayout(options.positional[0]);
        if (options.platform !== undefined) {
            assert.equal(description.platform, options.platform);
        }
        await verifyLayerDiffIds(options.positional[0], description);
        return description;
    }
    if (command === 'verify-loaded') {
        assert.equal(options.positional.length, 2, 'usage: verify-loaded <describe.json> <inspect.json>');
        verifyLoadedImage(readJson(options.positional[0]), readJson(options.positional[1]));
        return { ok: true };
    }
    if (command === 'assemble') {
        assert.ok(options.out, 'usage: assemble --out <dir> --member os/arch=<layout> --proof os/arch=<describe.json> [--annotation key=value]');
        const proofs = new Map(parsePairs(options.proof, '--proof').map(([platform, file]) => [platform, readJson(file)]));
        const members = parsePairs(options.member, '--member').map(([platform, layout]) => {
            assert.ok(proofs.has(platform), `missing --proof for ${platform}`);
            return { platform, layout, proof: proofs.get(platform) };
        });
        assert.equal(proofs.size, members.length, 'every --proof needs a matching --member');
        for (const member of members) {
            await verifyLayerDiffIds(member.layout, describeLayout(member.layout));
        }
        return assembleIndex({
            members,
            outDir: options.out,
            annotations: Object.fromEntries(parsePairs(options.annotation, '--annotation')),
        });
    }
    if (command === 'verify-index') {
        assert.equal(options.positional.length, 1, 'usage: verify-index <raw-index.json> [--expected-digest sha256:...] [--member os/arch=sha256:...]');
        return verifyReleaseIndex(fs.readFileSync(options.positional[0]), {
            digest: options['expected-digest'],
            members: Object.fromEntries(parsePairs(options.member, '--member')),
        });
    }
    throw new Error(`unknown command ${command}; expected describe, verify-loaded, assemble, or verify-index`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
}
