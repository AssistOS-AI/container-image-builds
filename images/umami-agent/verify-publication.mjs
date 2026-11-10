import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_PATH, METADATA_ASSETS, metadataAssetHash, verifyMetadataContentType } from './smoke-runtime.mjs';

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

// The existing-data-directory evidence: the legacy image initialised the data, the candidate then started on it.
export function verifyContinuity(directory, sources = lock) {
    const initial = read(path.join(directory, 'continuity-init.json'));
    const result = read(path.join(directory, 'continuity-smoke.json'));
    assert.equal(initial.schema, 'ploinky.umami-continuity-init/v1');
    assert.equal(initial.passed, true);
    assert.equal(initial.umamiVersion, sources.continuity.legacyImage.umamiVersion);
    assert.equal(result.schema, 'ploinky.umami-continuity-smoke/v1');
    assert.equal(result.passed, true);
    assert.equal(result.existingDataDir, 'ok');
    assert.equal(result.legacy.umamiVersion, sources.continuity.legacyImage.umamiVersion);
    assert.equal(result.legacy.migrations, initial.migrations);
    assert.equal(result.candidate.umamiVersion, sources.umami.version);
    assert.ok(result.candidate.migrations > result.legacy.migrations, 'the candidate must migrate the legacy data forward');
    assert.equal(result.majorVersion, sources.bases.postgres.postgresMajor);
    assert.equal(result.catalogVersion, initial.catalogVersion);
    assert.equal(result.controlVersion, initial.controlVersion);
    assert.equal(result.postgresUid, initial.postgresUid);
    return result;
}

// V-A2 records the candidate's size against the legacy image it replaces.
export function verifyImageSizes(directory, sources = lock) {
    const sizes = read(path.join(directory, 'image-sizes.json'));
    assert.equal(sizes.legacyImage, sources.continuity.legacyImage.image);
    for (const field of ['candidateBytes', 'legacyBytes']) assert.ok(Number.isSafeInteger(sizes[field]) && sizes[field] > 0, `${field} must be a positive byte count`);
    return sizes;
}

const manifestTypes = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const indexTypes = manifestTypes.slice(0, 2);

export function parseReference(reference) {
    const match = /^(?:(?<host>[a-z0-9.-]+(?::\d+)?)\/)?(?<repository>[a-z0-9._\/-]+?)(?::(?<tag>[\w.-]+))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/.exec(reference);
    assert.ok(match, `unparseable image reference: ${reference}`);
    let { host, repository } = match.groups;
    if (!host) { host = 'docker.io'; }
    if (host === 'docker.io') {
        host = 'registry-1.docker.io';
        if (!repository.includes('/')) repository = 'library/' + repository;
    }
    return { host, repository, tag: match.groups.tag, digest: match.groups.digest };
}

// Anonymous, read-only registry access: follow the registry's own Bearer challenge for a pull token.
export async function registryGet(reference, kind, id, { fetchImpl = fetch, accept, credentials } = {}) {
    const { host, repository } = parseReference(reference);
    const url = `https://${host}/v2/${repository}/${kind}/${id}`;
    const headers = { accept: accept || manifestTypes.join(', ') };
    let response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    if (response.status === 401) {
        const challenge = /^Bearer\s+(.+)$/i.exec(response.headers.get('www-authenticate') || '')?.[1];
        assert.ok(challenge, `${url} requires credentials that this read-only check does not use`);
        const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
        const tokenUrl = new URL(fields.realm);
        if (fields.service) tokenUrl.searchParams.set('service', fields.service);
        tokenUrl.searchParams.set('scope', fields.scope || `repository:${repository}:pull`);
        // Credentials, when supplied, go only to Docker Hub's own token service and never to another realm.
        const authorization = credentials && tokenUrl.hostname === 'auth.docker.io'
            ? { authorization: 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64') } : {};
        const token = await (await fetchImpl(tokenUrl, { headers: authorization, signal: AbortSignal.timeout(30000) })).json();
        response = await fetchImpl(url, { headers: { ...headers, authorization: `Bearer ${token.token || token.access_token}` }, signal: AbortSignal.timeout(30000) });
    }
    assert.equal(response.status, 200, `${url} returned ${response.status}`);
    return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || '' };
}

async function digestVerified(reference, kind, digest, options) {
    const { body, contentType } = await registryGet(reference, kind, digest, options);
    assert.equal('sha256:' + hash(body), digest, `${kind} bytes must hash to the requested digest`);
    return { body, contentType, json: JSON.parse(body.toString('utf8')) };
}

const platformEntry = (index, platform) => {
    const [os, architecture] = platform.split('/');
    const matches = index.manifests.filter(entry => entry.platform?.os === os && entry.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `index must hold exactly one ${platform} image`);
    return matches[0];
};

// Every pinned public base: the index digest, each native manifest and each image config must be exactly the pinned bytes.
export async function verifyPinnedBase(name, base, options) {
    const [repositoryReference, digest] = base.image.split('@');
    assert.equal(digest, base.indexDigest, `${name}: the image reference digest is the pinned index`);
    const index = (await digestVerified(base.image, 'manifests', digest, options)).json;
    assert.ok(indexTypes.includes(index.mediaType), `${name}: pinned base must be an image index`);
    for (const platform of ['linux/amd64', 'linux/arm64']) {
        const entry = platformEntry(index, platform);
        assert.equal(entry.digest, base.platformManifests[platform], `${name} ${platform} manifest`);
        const manifest = (await digestVerified(repositoryReference, 'manifests', entry.digest, options)).json;
        assert.equal(manifest.config.digest, base.platformConfigs[platform], `${name} ${platform} config`);
    }
    return { name, indexDigest: digest };
}

export async function verifyPinnedBases(sources = lock, options) {
    const bases = [...Object.entries(sources.bases), ['legacyImage', sources.continuity.legacyImage]];
    return Promise.all(bases.map(([name, base]) => verifyPinnedBase(name, base, options)));
}

export const PUBLISHED_IMAGE = 'docker.io/assistos/umami-agent';

// A promotable digest is an assistos/umami-agent index of exactly linux/amd64 and linux/arm64 (plus attestations that bind to them)
// whose image configs name this Umami version and source commit.
export async function verifyPromotionTarget(digest, sources = lock, options) {
    assert.match(digest, digestPattern);
    const reference = `${PUBLISHED_IMAGE}@${digest}`;
    const index = (await digestVerified(reference, 'manifests', digest, options)).json;
    assert.ok(indexTypes.includes(index.mediaType), 'the digest must be an image index');
    assert.ok(Array.isArray(index.manifests));
    const images = index.manifests.filter(entry => entry.platform?.os !== 'unknown');
    assert.deepEqual(images.map(entry => `${entry.platform.os}/${entry.platform.architecture}`).sort(), ['linux/amd64', 'linux/arm64'],
        'the index must hold exactly linux/amd64 and linux/arm64 images');
    const imageDigests = new Set(images.map(entry => entry.digest));
    for (const entry of index.manifests.filter(item => !imageDigests.has(item.digest))) {
        assert.deepEqual(entry.platform, { architecture: 'unknown', os: 'unknown' });
        assert.equal(entry.annotations?.['vnd.docker.reference.type'], 'attestation-manifest');
        assert.ok(imageDigests.has(entry.annotations?.['vnd.docker.reference.digest']), 'attestations must bind to a listed image');
    }
    for (const entry of images) {
        const manifest = (await digestVerified(reference, 'manifests', entry.digest, options)).json;
        const config = (await digestVerified(reference, 'blobs', manifest.config.digest, options)).json;
        assert.equal(`${config.os}/${config.architecture}`, `${entry.platform.os}/${entry.platform.architecture}`);
        assert.equal(config.config?.Labels?.['io.assistos.umami.version'], sources.umami.version, 'image labels must name the Umami version');
        assert.equal(config.config?.Labels?.['io.assistos.umami.source.revision'], sources.umami.commit, 'image labels must name the Umami source commit');
    }
    return { digest, platforms: images.map(entry => `${entry.platform.os}/${entry.platform.architecture}`).sort() };
}

export async function verifyTagsResolve(digest, tags, options) {
    assert.match(digest, digestPattern);
    for (const tag of tags) {
        const { body } = await registryGet(`${PUBLISHED_IMAGE}:${tag}`, 'manifests', tag, options);
        assert.equal('sha256:' + hash(body), digest, `${tag} must resolve to ${digest}`);
    }
    return tags;
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
    assert.equal(labels['org.opencontainers.image.base.digest'], sources.bases.postgres.indexDigest);
    assert.equal(labels['io.assistos.umami.base.node'], sources.bases.node.image);
    assert.equal(labels['io.assistos.umami.base.geo'], sources.bases.upstreamUmami.image);
    assert.equal(labels['io.assistos.umami.version'], sources.umami.version);
    assert.equal(labels['io.assistos.umami.source.revision'], sources.umami.commit);
    assert.equal(labels['io.assistos.umami.source.modified'], 'true');
    assert.equal(labels['io.assistos.umami.base-path'], BASE_PATH);
    assert.equal(labels['io.assistos.umami.pnpm-lock.sha256'], sources.umami.sourceFiles['pnpm-lock.yaml']);
    assert.equal(labels['io.assistos.umami.alpine.release'], sources.bases.node.alpineRelease);
    for (const retired of ['io.assistos.umami-mcp.revision', 'io.assistos.umami-mcp.bun-lock.sha256', 'io.assistos.bun.version']) {
        assert.equal(labels[retired], undefined, `${retired} belongs to the retired Bun and umami-mcp stack`);
    }
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
    for (const field of ['loginHttp', 'heartbeatHttp', 'authLoginHttp', 'authVerifyHttp', 'trackerHttp', 'apiKeyWebsites', 'apiKeyWebsiteCreate', 'sessionUsers']) assert.equal(smoke[field], 200, field);
    assert.equal(smoke.unprefixedNextHttp, 404);
    assert.ok([401, 403].includes(smoke.apiKeyUsers), 'an API key must be refused on /api/users');
    assert.ok([401, 403].includes(smoke.apiKeyOwnKeys), 'an API key must be refused on /api/me/api-keys');
    assert.equal(smoke.mcpUnauthenticated, 401);
    assert.equal(smoke.mcpLoginToken, 401);
    assert.equal(smoke.mcpTools, 23);
    assert.ok(['initialize', 'direct'].includes(smoke.mcpHandshake));
    assert.equal(smoke.mcpListWebsites, true);
    assert.equal(smoke.sendBotIgnored, true);
    assert.equal(smoke.sendCacheToken, true);
    assert.equal(smoke.sessionRows, 1);
    assert.equal(smoke.sessionCountry, 'US');
    assert.equal(smoke.postgresVersion, sources.bases.postgres.postgresVersion);
    assert.equal(smoke.metadata.basePath, BASE_PATH);
    assert.equal(smoke.metadata.version, sources.umami.version);
    assert.equal(smoke.metadata.sourceCommit, sources.umami.commit);
    assert.equal(smoke.metadata.sourceArchiveSha256, sources.umami.sourceArchive.sha256);
    assert.deepEqual(smoke.metadata.sourcePatches, sources.umami.sourcePatches);
    assert.match(smoke.metadata.sourcePatchReceiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(smoke.metadata.pnpmLockSha256, sources.umami.sourceFiles['pnpm-lock.yaml']);
    assert.deepEqual(smoke.metadata.baseImages, { node: sources.bases.node.image, postgres: sources.bases.postgres.image, geo: sources.bases.upstreamUmami.image });
    assert.equal(smoke.metadata.geoDatabaseSha256, sources.umami.geo.sha256);
    verifyContinuity(directory, sources);
    verifyImageSizes(directory, sources);
    const kinds = new Set();
    for (const asset of smoke.assets) {
        assert.ok(asset.path.startsWith(BASE_PATH + '/_next/'));
        assert.ok(['script', 'css', 'font'].includes(asset.kind));
        assert.ok(asset.bytes > 0);
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        kinds.add(asset.kind);
    }
    assert.ok(kinds.has('script') && kinds.has('css'));
    assert.ok(Array.isArray(smoke.metadataAssets), 'native proof must include metadata resources');
    assert.deepEqual(smoke.metadataAssets.map(asset => asset.path).sort(), Object.keys(METADATA_ASSETS).map(name => BASE_PATH + '/' + name).sort(),
        'native proof must cover all head and nested metadata resources exactly once');
    for (const asset of smoke.metadataAssets) {
        const name = asset.path.slice(BASE_PATH.length + 1);
        assert.equal(asset.kind, METADATA_ASSETS[name].kind);
        assert.equal(asset.source, METADATA_ASSETS[name].source);
        assert.equal(asset.status, 200);
        assert.equal(asset.unprefixedHttp, 404);
        assert.ok(asset.bytes > 0);
        assert.equal(asset.sha256, metadataAssetHash(sources, name));
        assert.equal(typeof asset.contentType, 'string');
        verifyMetadataContentType(asset.kind, asset.contentType);
    }
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

async function main() {
    const [mode, directory, architecture] = process.argv.slice(2);
    const options = process.env.DOCKERHUB_USERNAME && process.env.DOCKERHUB_TOKEN
        ? { credentials: { username: process.env.DOCKERHUB_USERNAME, password: process.env.DOCKERHUB_TOKEN } } : {};
    if (mode === 'verify-bases') {
        for (const base of await verifyPinnedBases(lock, options)) console.log(`${base.name}=${base.indexDigest}`);
        return;
    }
    if (mode === 'promote-check') {
        const result = await verifyPromotionTarget(directory, lock, options);
        console.log(`promotable=${result.digest} platforms=${result.platforms.join(',')}`);
        return;
    }
    if (mode === 'verify-tags') {
        await verifyTagsResolve(directory, architecture.split(','), options);
        console.log(`tags=${architecture} digest=${directory}`);
        return;
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
