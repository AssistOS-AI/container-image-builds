import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const dockerfile = read('images/umami-agent/Dockerfile');
const workflow = read('.github/workflows/publish-umami-agent-image.yml');
const sources = JSON.parse(read('images/umami-agent/sources.lock.json'));

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

test('Umami source lock records exact multi-architecture inputs', () => {
    assert.equal(sources.schemaVersion, 1);
    assert.equal(sources.umami.version, '3.2.0');
    assert.match(sources.umami.indexDigest, SHA256);
    assert.equal(
        sources.umami.image,
        `docker.umami.is/umami-software/umami:3.2.0@${sources.umami.indexDigest}`,
    );
    assert.deepEqual(Object.keys(sources.umami.platformManifests).sort(), [
        'linux/amd64',
        'linux/arm64',
    ]);
    for (const digest of Object.values(sources.umami.platformManifests)) {
        assert.match(digest, SHA256);
        assert.notEqual(digest, sources.umami.indexDigest);
    }

    assert.equal(sources.bun.version, '1.3.14');
    assert.equal(sources.bun.release, 'https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14');
    assert.deepEqual(Object.keys(sources.bun.artifacts).sort(), ['linux/amd64', 'linux/arm64']);
    assert.equal(sources.bun.artifacts['linux/amd64'].name, 'bun-linux-x64-musl.zip');
    assert.equal(sources.bun.artifacts['linux/arm64'].name, 'bun-linux-aarch64-musl.zip');
    for (const artifact of Object.values(sources.bun.artifacts)) {
        assert.match(artifact.sha256, HEX_SHA256);
    }

    assert.equal(sources.umamiMcp.repository, 'https://github.com/MadsNyl/umami-mcp.git');
    assert.match(sources.umamiMcp.commit, COMMIT);
    assert.match(sources.umamiMcp.bunLockSha256, HEX_SHA256);
    assert.ok(Number.isFinite(Date.parse(sources.umamiMcp.committedAt)));
});

test('Dockerfile consumes only the reviewed immutable source lock', () => {
    const fromInstructions = dockerfile.match(/^FROM .+$/gm) ?? [];
    assert.deepEqual(fromInstructions, [`FROM ${sources.umami.image}`]);
    assert.doesNotMatch(dockerfile, /^ARG .*?(?:IMAGE|VERSION|REF|REVISION|COMMIT|SHA256)=/m);
    assert.doesNotMatch(dockerfile, /(?:latest|refs\/heads\/|checkout (?:origin\/)?(?:main|master)\b|git clone|--depth|curl[^\n]*\|\s*(?:ba)?sh)/i);

    assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.base\\.digest="${sources.umami.indexDigest}"`));
    assert.match(dockerfile, new RegExp(`io\\.assistos\\.bun\\.version="${sources.bun.version}"`));
    assert.match(dockerfile, new RegExp(`io\\.assistos\\.umami-mcp\\.revision="${sources.umamiMcp.commit}"`));
    assert.match(dockerfile, /COPY --chmod=0444 sources\.lock\.json \/usr\/local\/share\/ploinky\/umami-agent-sources\.json/);

    for (const artifact of Object.values(sources.bun.artifacts)) {
        assert.ok(dockerfile.includes(artifact.name));
        assert.ok(dockerfile.includes(artifact.sha256));
    }
    assert.ok(dockerfile.includes(`/bun-v${sources.bun.version}/`));
    assert.match(dockerfile, /sha256sum -c -/);
    assert.ok(dockerfile.includes(`test "$(bun --version)" = '${sources.bun.version}'`));

    assert.ok(dockerfile.includes(`fetch --no-tags origin ${sources.umamiMcp.commit}`));
    assert.match(dockerfile, /checkout --detach FETCH_HEAD/);
    assert.ok(dockerfile.includes(`rev-parse HEAD)" = '${sources.umamiMcp.commit}'`));
    assert.ok(dockerfile.includes(sources.umamiMcp.bunLockSha256));
    assert.match(dockerfile, /bun install --frozen-lockfile/);
});

test('publication workflow cannot override source pins and records a verifiable index', () => {
    assert.doesNotMatch(workflow, /umami_base_image|UMAMI_BASE_IMAGE|build-args:/);
    assert.doesNotMatch(workflow, /provenance:\s*false/);
    assert.match(workflow, /node --test tests\/umami-agent-supply-chain\.test\.mjs/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /provenance:\s*mode=max/);
    assert.match(workflow, /sbom:\s*true/);
    assert.match(workflow, /BUILD_DIGEST.*\^sha256:\[0-9a-f\]\{64\}\$/s);
    assert.match(workflow, /docker buildx imagetools inspect/);
    assert.match(workflow, /Verify pinned Umami base platform manifests/);
    assert.match(workflow, /\.umami\.platformManifests\[\$platform\]/);
    assert.match(workflow, /platform\.architecture == "amd64"/);
    assert.match(workflow, /platform\.architecture == "arm64"/);
    assert.match(workflow, /images\/umami-agent\/sources\.lock\.json/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, `workflow action is not SHA-pinned: ${use[0]}`);
    }
});
