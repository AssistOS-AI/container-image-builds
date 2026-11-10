import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE_PATH, METADATA_ASSETS, MCP_TOOLS, ADMIN_USER_ID, apiKeyRow, parseControlData, parseMcpBody, metadataAssetHash, metadataHeadAssets, nestedMetadataAssets, fetchMetadataAssets, pageAssets, verifyBuildMetadata, verifyLoopbackListener, verifyMcpTools, mcpCall, mcpSession } from '../images/umami-agent/smoke-runtime.mjs';
import { verifySchemaEngine } from '../images/umami-agent/verify-build.mjs';
import { rewriteMetadataSource, targets as metadataTargets } from '../images/umami-agent/patch-metadata-assets.mjs';
import { nativeIndex, parseReference, verifyCandidate, verifyContinuity, verifyImageSizes, verifyNativeProof, verifyPromotionEvidence, pinCandidateRun, checkCandidateArtifact, registryGet, verifyPinnedBase, verifyPromotionTarget, verifyTagsResolve } from '../images/umami-agent/verify-publication.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const dockerfile = read('images/umami-agent/Dockerfile');
const workflow = read('.github/workflows/publish-umami-agent-image.yml');
const sources = JSON.parse(read('images/umami-agent/sources.lock.json'));
const originalLoginForm = read('tests/fixtures/umami-login/LoginForm.tsx');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = character => 'sha256:' + character.repeat(64);
const metadataTypes = { ico: 'image/x-icon', png: 'image/png', svg: 'image/svg+xml', manifest: 'application/manifest+json', xml: 'application/xml' };
const write = (directory, name, value) => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};
const json = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
function temp(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-contract-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

const platforms = ['linux/amd64', 'linux/arm64'];
const publicBases = Object.entries({ ...sources.bases, legacyImage: sources.continuity.legacyImage });

test('source lock selects digest-pinned public bases, an immutable Umami source, native pnpm and pinned Prisma engines', () => {
    assert.equal(sources.schemaVersion, 3);
    for (const retired of ['runtimeBase', 'bun', 'umamiMcp', 'postgresql']) assert.ok(!(retired in sources), `${retired} belongs to the retired runtime base`);
    assert.deepEqual(Object.keys(sources.bases), ['node', 'postgres', 'upstreamUmami']);
    for (const [name, base] of publicBases) {
        assert.equal(base.image.split('@')[1], base.indexDigest, `${name} reference digest`);
        assert.match(base.indexDigest, /^sha256:[a-f0-9]{64}$/);
        for (const field of ['platformManifests', 'platformConfigs']) {
            assert.deepEqual(Object.keys(base[field]).sort(), platforms, `${name} ${field}`);
            for (const value of Object.values(base[field])) assert.match(value, /^sha256:[a-f0-9]{64}$/);
        }
    }
    assert.equal(sources.bases.node.image, 'docker.io/library/node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202');
    assert.equal(sources.bases.node.nodeVersion, '22.23.4');
    assert.equal(sources.bases.postgres.image, 'docker.io/library/postgres:18.6-alpine3.24@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395');
    assert.equal(sources.bases.postgres.postgresMajor, 18);
    assert.ok(sources.bases.postgres.postgresVersion.startsWith('18.'));
    assert.equal(sources.bases.node.alpineRelease, sources.bases.postgres.alpineRelease, 'the combined bases share one Alpine release');
    assert.ok(sources.bases.node.image.includes(`alpine${sources.bases.node.alpineRelease.replace(/\.\d+$/, '')}@`));
    assert.ok(sources.bases.postgres.image.includes(`alpine${sources.bases.postgres.alpineRelease.replace(/\.\d+$/, '')}@`));
    assert.equal(sources.bases.upstreamUmami.image, 'docker.umami.is/umami-software/umami:3.4.1@sha256:e69d1a7932e9dab0fc523edc7be1f3a53f3c261f57856fc2167ae74a8fc022e8');
    assert.equal(sources.continuity.legacyImage.image, 'docker.io/assistos/umami-agent@sha256:d797b418dd13a6eb786cba4640656b6b1bc6e5da0467b98b5b8d335a250dd5a1');
    assert.equal(sources.continuity.legacyImage.umamiVersion, '3.2.0');
    assert.equal(sources.umami.commit, '559e3c607c23d2c72d9bd4f6481bda428255323c');
    assert.equal(sources.umami.version, '3.4.1');
    assert.equal(sources.umami.basePath, BASE_PATH);
    assert.equal(sources.umami.sourceArchive.url, `https://codeload.github.com/umami-software/umami/tar.gz/${sources.umami.commit}`);
    assert.equal(sources.umami.sourceArchive.sha256, '0f84d93ba311c6e6d2ea87dc6d2a72506798a8cc0ffec39f725bad62eff17630');
    assert.equal(sources.umami.sourceFiles['pnpm-lock.yaml'], 'd1661e1e1ceadd01dd2328e27c5b04d9e30dd168b875a343b4a5f42001ad5028');
    for (const value of Object.values(sources.umami.sourceFiles)) assert.match(value, /^[a-f0-9]{64}$/);
    for (const name of ['scripts/check-db.js', 'scripts/update-tracker.js', 'prisma.config.ts', 'pnpm-workspace.yaml', 'docker/proxy.ts']) assert.ok(sources.umami.sourceFiles[name], `${name} is pinned`);
    assert.equal(sources.umami.pnpm.version, '12.3.4');
    assert.deepEqual(Object.keys(sources.umami.pnpm.artifacts).sort(), platforms);
    assert.equal(sources.umami.pnpm.artifacts['linux/amd64'].sha256, '4ac4e7fb80b3ba4ffb0e443adab5539de7581d5da0f29501859b30785731aa0e');
    assert.equal(sources.umami.pnpm.artifacts['linux/arm64'].sha256, '085f6389c412105dbe18a4209ac35a2b355e85744cd5b846970bc21faa49a22c');
    for (const artifact of Object.values(sources.umami.pnpm.artifacts)) {
        assert.ok(artifact.package.endsWith('-musl'), 'the Alpine images need the musl pnpm build');
        assert.equal(artifact.url, `https://registry.npmjs.org/${artifact.package}/-/${artifact.package.split('/')[1]}-${sources.umami.pnpm.version}.tgz`);
        assert.match(artifact.integrity, /^sha512-/);
    }
    // Prisma 7.10 downloads its schema engine from binaries.prisma.sh in the pnpm postinstall, so the bytes are pinned here.
    assert.equal(sources.umami.prisma.downloadsDuringBuild, true);
    assert.equal(sources.umami.prisma.enginesVersion, '0edf323efd1d98336f3f0a68684b56f689b900d3');
    assert.deepEqual(Object.keys(sources.umami.prisma.platforms).sort(), platforms);
    for (const platform of Object.values(sources.umami.prisma.platforms)) {
        assert.ok(platform.target.startsWith('linux-musl'));
        assert.equal(platform.url, `${sources.umami.prisma.downloadHost}/all_commits/${sources.umami.prisma.enginesVersion}/${platform.target}/schema-engine.gz`);
        assert.match(platform.sha256, /^[a-f0-9]{64}$/);
        assert.match(platform.gzipSha256, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(sources.umami.geo, { source: 'upstreamUmami', path: '/app/geo/GeoLite2-City.mmdb', bytes: 50634725,
        sha256: '3c884a441b2ab41ba01c4f99b1c9551a610de4d2e4b8f66e797c6a844c7d767b', licence: sources.umami.geo.licence });
    assert.deepEqual(sources.umami.sourcePatches.map(patch => patch.id), ['login-query-cache', 'metadata-assets']);
});

const externalFrom = /^FROM (?!scratch)(\S+)(?: AS \S+)?$/gm;
test('build is self-contained: every base is a digest-pinned public image and none is ours', () => {
    const froms = dockerfile.match(/^FROM .+$/gm);
    assert.deepEqual(froms, [
        `FROM ${sources.bases.node.image} AS node-base`,
        `FROM ${sources.bases.upstreamUmami.image} AS umami-geo`,
        `FROM ${sources.bases.postgres.image} AS postgres-base`,
        'FROM node-base AS umami-build',
        'FROM scratch',
    ]);
    for (const from of froms) assert.doesNotMatch(from, /assistos\//, 'no FROM may name an assistos image');
    assert.doesNotMatch(dockerfile, /assistos\//, 'no instruction may reference an assistos image');
    for (const [, reference] of dockerfile.matchAll(externalFrom)) {
        if (['node-base', 'umami-geo', 'postgres-base'].includes(reference)) continue;
        assert.match(reference, /@sha256:[a-f0-9]{64}$/, `${reference} must be digest-pinned`);
    }
    const library = froms.slice(0, 3).map(from => from.split(' ')[1]);
    for (const reference of library) assert.match(reference, /^(?:docker\.io\/library|docker\.umami\.is\/umami-software)\/[a-z-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
});

test('build verifies pinned inputs, applies the reviewed patches, and replaces nothing from an earlier image', () => {
    for (const value of [sources.umami.sourceArchive.url, sources.umami.sourceArchive.sha256, sources.umami.geo.sha256,
        ...Object.values(sources.umami.pnpm.artifacts).map(artifact => artifact.sha256), sources.umami.pnpm.version,
        sources.bases.node.alpineRelease, sources.bases.node.nodeVersion, sources.bases.postgres.postgresVersion,
        sources.umami.sourceFiles['pnpm-lock.yaml']]) assert.ok(dockerfile.includes(value), value);
    assert.match(dockerfile, /registry\.npmjs\.org\/@pnpm\/\$\{pnpm_package\}\/-\/\$\{pnpm_package\}-12\.3\.4\.tgz/);
    assert.match(dockerfile, /pnpm_package='exe\.linux-x64-musl'.*pnpm_package='exe\.linux-arm64-musl'/s);
    assert.doesNotMatch(dockerfile, /^ARG |apk add|npm install -g|git clone|sed -i|build-args:|refs\/heads\/|curl[^\n]*\|\s*(?:ba)?sh|bun install|bun run|BUN_INSTALL|MadsNyl|MCP_SECRET/m);
    assert.match(dockerfile, /verify-umami-build\.mjs source/);
    assert.match(dockerfile, /patch-metadata-assets\.mjs \/build/);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.match(dockerfile, /printf 'strictDepBuilds: false\\n' >> pnpm-workspace\.yaml/);
    assert.match(dockerfile, /pnpm install --frozen-lockfile;/);
    assert.match(dockerfile, /verify-umami-build\.mjs engines \/build/);
    assert.match(dockerfile, /verify-login-query-cache\.mjs \/build/);
    assert.match(dockerfile, /cp docker\/proxy\.ts src\/proxy\.ts/);
    assert.match(dockerfile, /NODE_ENV=production pnpm build:docker/);
    assert.match(dockerfile, /pnpm prune --prod/);
    assert.match(dockerfile, /SKIP_BUILD_GEO=1/);
    assert.match(dockerfile, /COPY --from=umami-geo \/app\/geo\/GeoLite2-City\.mmdb \/build\/geo\/GeoLite2-City\.mmdb/);
    assert.match(dockerfile, /cp -a \.next\/standalone\/\. \/out\//);
    assert.match(dockerfile, /rm -rf \/out\/node_modules \/out\/packages .*\/out\/\.next\/static/);
    assert.match(dockerfile, /cp -a node_modules packages public scripts prisma prisma\.config\.ts generated geo package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \/out\//);
    assert.match(dockerfile, /verify-umami-build\.mjs seal/);
    assert.match(dockerfile, /BASE_PATH=\/base-agent-additional-server\/umamiAgent\/3000/);
});

test('runtime stage is the PostgreSQL root filesystem plus Node, npm and su-exec, checked against one Alpine release', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM scratch'));
    assert.match(runtime, /^COPY --from=postgres-base \/ \/$/m);
    assert.match(runtime, /cmp \/etc\/alpine-release \/tmp\/node-alpine-release/);
    assert.match(runtime, /test "\$\(cat \/etc\/alpine-release\)" = '3\.24\.4'/);
    for (const source of ['/usr/local/bin/node', '/usr/local/lib/node_modules/npm']) assert.ok(runtime.includes(`COPY --from=node-base ${source} ${source}`));
    assert.match(runtime, /COPY --from=node-base \/usr\/lib\/libstdc\+\+\.so\.6\.0\.34 \/usr\/lib\/libgcc_s\.so\.1 \/usr\/lib\//);
    assert.match(runtime, /ln -s gosu \/usr\/local\/bin\/su-exec/);
    assert.match(runtime, /COPY --from=umami-build --chown=1000:1000 \/out\/ \/app\/\n/);
    assert.doesNotMatch(runtime, /rm -rf \/app/);
    assert.match(runtime, /RUN mkdir -p \/usr\/local\/share\/ploinky \\\n    && chown 0:0 \/usr\/local\/share\/ploinky \\\n    && chmod 0755 \/usr\/local\/share\/ploinky\nCOPY --chown=0:0 --chmod=0444 sources\.lock\.json/);
    assert.match(runtime, /COPY --chown=0:0 --chmod=0444 smoke-runtime\.mjs/);
    assert.match(runtime, /su-exec 1000:1000 node -e .*\['umami-agent-sources\.json', 'smoke-umami-runtime\.mjs'\].*readFileSync/);
    assert.match(runtime, /test -f \/app\/ploinky-umami-build\.json/);
    assert.match(runtime, /test -f \/app\/scripts\/check-db\.js/);
    assert.match(runtime, /test -f \/app\/scripts\/update-tracker\.js/);
    assert.match(runtime, /test -f \/app\/node_modules\/bcryptjs\/package\.json/);
    assert.match(runtime, /test -x \/app\/node_modules\/\.bin\/prisma/);
    assert.match(runtime, /postgres --version \| cut -d ' ' -f 3\)" = '18\.6'/);
    assert.match(runtime, /! command -v bun/);
    assert.match(runtime, /! test -e \/opt\/umami-mcp/);
    assert.match(runtime, /WORKDIR \/code\n$/);
    assert.doesNotMatch(runtime, /^ENTRYPOINT|^VOLUME|^STOPSIGNAL/m, 'none of the PostgreSQL image configuration is inherited');
    for (const [label, value] of [['io.assistos.umami.version', sources.umami.version], ['io.assistos.umami.source.revision', sources.umami.commit],
        ['io.assistos.umami.base-path', BASE_PATH], ['io.assistos.umami.pnpm-lock.sha256', sources.umami.sourceFiles['pnpm-lock.yaml']],
        ['io.assistos.umami.alpine.release', sources.bases.node.alpineRelease], ['org.opencontainers.image.base.digest', sources.bases.postgres.indexDigest],
        ['io.assistos.umami.base.node', sources.bases.node.image], ['io.assistos.umami.base.geo', sources.bases.upstreamUmami.image]]) {
        assert.ok(runtime.includes(`LABEL ${label}="${value}"`), label);
    }
});

test('workflow verifies every pinned base, assembles smoke-proven native digests, and promotes only a named digest', () => {
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^  push:|setup-qemu|image_tag:|build-args:|promote_stable|runtimeBase|bun --version/m);
    assert.match(workflow, /promote_digest:\n(?:.*\n)*?\s+required: false\n\s+default: ''\n\s+type: string/);
    assert.match(workflow, /verify-publication\.mjs verify-bases/);
    assert.match(workflow, /runner: ubuntu-24\.04\n/);
    assert.match(workflow, /runner: ubuntu-24\.04-arm\n/);
    assert.match(workflow, /platforms: \$\{\{ matrix\.platform \}\}/);
    assert.match(workflow, /push-by-digest=true,name-canonical=true,push=true/);
    assert.match(workflow, /provenance: mode=max/);
    assert.match(workflow, /sbom: true/);
    assert.match(workflow, /--network=none --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges/g);
    assert.match(workflow, /smoke-umami-runtime\.mjs/);
    assert.match(workflow, /continuity-init \/continuity/);
    assert.match(workflow, /continuity-verify \/continuity/);
    assert.match(workflow, /legacy_image="\$\(jq -r '\.continuity\.legacyImage\.image'/);
    assert.match(workflow, /docker image inspect --format '\{\{\.Size\}\}' "\$legacy_image"/);
    assert.match(workflow, /> "\$evidence\/image-sizes\.json"/);
    assert.match(workflow, /verify-publication\.mjs seal-native/);
    assert.match(workflow, /verify-publication\.mjs proofs/);
    assert.match(workflow, /verify-publication\.mjs candidate/);
    assert.match(workflow, /cmp "\$evidence\/candidate-index\.json" "\$evidence\/immutable-index\.json"/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(use[1], /^[a-f0-9]{40}$/);
    // The build and assembly jobs run only when no digest is being promoted; promotion builds nothing.
    const headers = [...workflow.matchAll(/^  ([a-z]+):\n/gm)];
    const job = name => { const i = headers.findIndex(header => header[1] === name); return workflow.slice(headers[i].index, headers[i + 1]?.index); };
    assert.match(job('build'), /if: \$\{\{ inputs\.promote_digest == '' \}\}/);
    assert.match(job('assemble'), /if: \$\{\{ inputs\.promote_digest == '' \}\}\n\s+needs: build/);
    const promote = job('promote');
    assert.match(promote, /if: \$\{\{ inputs\.promote_digest != '' \}\}/);
    assert.match(promote, /steps:\n      - name: Require dispatch from the main branch\n        run: \|\n          set -euo pipefail\n          test "\$GITHUB_REF" = refs\/heads\/main/, 'promotion runs only from main, before anything else');
    for (const input of ['candidate_run_id', 'candidate_attempt']) assert.match(workflow, new RegExp(`      ${input}:\\n(?:        .+\\n)*?        type: string`));
    assert.match(promote, /CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}/);
    assert.match(promote, /CANDIDATE_RUN_ATTEMPT: \$\{\{ inputs\.candidate_attempt \}\}/);
    assert.match(promote, /verify-publication\.mjs promote-evidence "\$evidence"/);
    assert.ok(promote.indexOf('promote-evidence') < promote.indexOf('docker/login-action'), 'candidate evidence is verified before registry credentials exist');
    assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
    assert.doesNotMatch(promote, /^\s+needs:|build-push-action|docker build\s/m);
    assert.match(promote, /PROMOTE_DIGEST: \$\{\{ inputs\.promote_digest \}\}/);
    assert.match(promote, /DOCKERHUB_TOKEN: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/);
    for (const line of promote.split('\n').filter(line => line.includes('${{ inputs.'))) {
        assert.match(line, /^\s+(?:[A-Z_]+: \$\{\{ inputs\.\w+ \}\}|if: \$\{\{ inputs\.promote_digest != '' \}\})$/, `an input reaches shell only through the environment: ${line}`);
    }
    assert.match(promote, /\[\[ "\$PROMOTE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
    assert.match(promote, /verify-publication\.mjs promote-check "\$PROMOTE_DIGEST"/);
    assert.match(promote, /--tag "docker\.io\/\$\{IMAGE_NAME\}:\$\{IMAGE_TAG\}" --tag "docker\.io\/\$\{IMAGE_NAME\}:\$\{LATEST_TAG\}"/);
    assert.match(promote, /verify-publication\.mjs verify-tags "\$PROMOTE_DIGEST"/);
    assert.match(workflow, /IMAGE_TAG: umami-stack\n  LATEST_TAG: latest/);
    assert.ok(promote.indexOf('promote-check') < promote.indexOf('imagetools create'), 'the digest is verified before any tag moves');
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

const enginePlatform = { x64: 'linux/amd64', arm64: 'linux/arm64' }[process.arch];
const enginePath = (directory, target) => `node_modules/.pnpm/@prisma+engines@7.10.0/node_modules/@prisma/engines/schema-engine-${target}`;
function application(t) {
    const directory = temp(t);
    const lock = structuredClone(sources);
    const pnpmLock = `packages:\n  '${lock.umami.prisma.enginesPackage}':\n    resolution: {}\n  '@prisma/engines-version@7.10.0-4.${lock.umami.prisma.enginesVersion}':\n    resolution: {}\n`;
    const files = { 'package.json': JSON.stringify({ version: '3.4.1', engines: { pnpm: '12.3.4' },
            dependencies: { prisma: '^7.10.0', '@prisma/client': '^7.10.0', '@prisma/adapter-pg': '^7.10.0' } }), 'pnpm-lock.yaml': pnpmLock, 'server.js': 'standalone',
        'src/app/login/LoginForm.tsx': originalLoginForm,
        'public/script.js': 'tracker',
        '.next/required-server-files.json': JSON.stringify({ config: { basePath: BASE_PATH, assetPrefix: BASE_PATH, env: { basePath: BASE_PATH }, output: 'standalone' } }) };
    for (const name of ['src/app/layout.tsx', ...Object.keys(METADATA_ASSETS).map(name => 'public/' + name)]) {
        files[name] = fs.readFileSync(path.join(root, 'tests/fixtures/umami-metadata', name));
    }
    for (const [name, value] of Object.entries(files)) write(directory, name, value);
    lock.umami.sourceFiles = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)]));
    write(directory, 'geo/GeoLite2-City.mmdb', 'pinned-geo');
    lock.umami.geo.sha256 = hash('pinned-geo');
    lock.umami.geo.bytes = 'pinned-geo'.length;
    for (const platform of Object.values(lock.umami.prisma.platforms)) platform.sha256 = hash('schema-engine');
    write(directory, enginePath(directory, lock.umami.prisma.platforms[enginePlatform].target), 'schema-engine');
    write(directory, 'lock.json', lock);
    const run = mode => spawnSync(process.execPath, mode === 'patch'
        ? [path.join(root, 'images/umami-agent/patch-metadata-assets.mjs'), directory, path.join(directory, 'lock.json')]
        : [path.join(root, 'images/umami-agent/verify-build.mjs'), mode, directory, path.join(directory, 'lock.json'), directory], { encoding: 'utf8' });
    return { directory, lock, run };
}

test('source and artifact seals bind actual bytes and never overwrite a prior seal', t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('source').status, 0);
    assert.equal(run('patch').status, 0);
    assert.equal(run('seal').status, 0);
    verifyBuildMetadata(directory, lock);
    assert.notEqual(run('seal').status, 0);
    write(directory, 'server.js', 'changed');
    assert.throws(() => verifyBuildMetadata(directory, lock));
    assert.notEqual(run('source').status, 0);
});
for (const field of ['geo', 'basePath', 'lock', 'tracker', 'patch receipt', 'manifest', 'icon', 'engine']) test(`artifact verification rejects ${field} drift`, t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('patch').status, 0);
    assert.equal(run('seal').status, 0);
    if (field === 'geo') write(directory, 'geo/GeoLite2-City.mmdb', 'changed');
    if (field === 'engine') write(directory, enginePath(directory, lock.umami.prisma.platforms[enginePlatform].target), 'changed');
    if (field === 'tracker') write(directory, 'public/script.js', 'changed');
    if (field === 'lock') write(directory, 'pnpm-lock.yaml', 'changed');
    if (field === 'basePath') write(directory, '.next/required-server-files.json', { config: { basePath: '' } });
    if (field === 'manifest') write(directory, 'public/site.webmanifest', '{}');
    if (field === 'icon') write(directory, 'public/favicon.ico', 'changed');
    if (field === 'patch receipt') {
        fs.unlinkSync(path.join(directory, 'ploinky-umami-source-patches.json'));
        write(directory, 'ploinky-umami-source-patches.json', { sourcePatches: [] });
    }
    assert.throws(() => verifyBuildMetadata(directory, lock));
});

test('seal itself rejects root-base output, replaced GeoIP and a substituted schema engine', t => {
    const { directory, run } = application(t);
    assert.equal(run('patch').status, 0);
    write(directory, 'geo/GeoLite2-City.mmdb', 'other-geo');
    assert.notEqual(run('seal').status, 0);
    write(directory, 'geo/GeoLite2-City.mmdb', 'pinned-geo');
    const required = json(directory, '.next/required-server-files.json');
    required.config.basePath = '';
    write(directory, '.next/required-server-files.json', required);
    assert.notEqual(run('seal').status, 0);
    required.config.basePath = BASE_PATH;
    write(directory, '.next/required-server-files.json', required);
    const { lock } = { lock: json(directory, 'lock.json') };
    const engine = enginePath(directory, lock.umami.prisma.platforms[enginePlatform].target);
    write(directory, engine, 'substituted');
    assert.notEqual(run('seal').status, 0);
    fs.rmSync(path.join(directory, engine));
    assert.notEqual(run('seal').status, 0, 'a postinstall that silently failed to download the engine is caught');
    write(directory, engine, 'schema-engine');
    assert.equal(run('seal').status, 0);
});

test('schema engine check requires exactly the pinned target for the build architecture', t => {
    const { directory, lock } = application(t);
    const target = lock.umami.prisma.platforms[enginePlatform].target;
    assert.deepEqual(verifySchemaEngine(directory, lock.umami.prisma, enginePlatform), { target, sha256: hash('schema-engine') });
    write(directory, enginePath(directory, 'linux-musl-other-openssl-3.0.x'), 'schema-engine');
    assert.throws(() => verifySchemaEngine(directory, lock.umami.prisma, enginePlatform), /exactly one schema engine/);
    assert.throws(() => verifySchemaEngine(directory, lock.umami.prisma, 'linux/s390x'), /no pinned Prisma schema engine/);
});

test('source verification binds the declared pnpm and Prisma lines', t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('source').status, 0);
    for (const [name, value] of [['package.json', JSON.stringify({ version: '3.4.1', engines: { pnpm: '12.3.5' }, dependencies: { prisma: '^7.10.0', '@prisma/client': '^7.10.0', '@prisma/adapter-pg': '^7.10.0' } })],
        ['pnpm-lock.yaml', "packages:\n  '@prisma/engines@7.10.0':\n"]]) {
        const changed = structuredClone(lock);
        write(directory, name, value);
        changed.umami.sourceFiles[name] = hash(value);
        write(directory, 'lock.json', changed);
        assert.notEqual(run('source').status, 0, name);
        write(directory, 'lock.json', lock);
        write(directory, name, name === 'package.json' ? JSON.stringify({ version: '3.4.1', engines: { pnpm: '12.3.4' }, dependencies: { prisma: '^7.10.0', '@prisma/client': '^7.10.0', '@prisma/adapter-pg': '^7.10.0' } }) : `packages:\n  '${lock.umami.prisma.enginesPackage}':\n    resolution: {}\n  '@prisma/engines-version@7.10.0-4.${lock.umami.prisma.enginesVersion}':\n    resolution: {}\n`);
    }
});

test('login source patch rejects changed upstream bytes, changed patch identity, and repeat application', t => {
    const { directory, lock, run } = application(t);
    const target = 'src/app/login/LoginForm.tsx';
    assert.equal(hash(originalLoginForm), sources.umami.sourceFiles[target]);
    write(directory, target, originalLoginForm + '\n');
    assert.notEqual(run('patch').status, 0);
    assert.ok(!fs.existsSync(path.join(directory, 'ploinky-umami-source-patches.json')));
    write(directory, target, originalLoginForm);
    const changedLock = structuredClone(lock);
    changedLock.umami.sourcePatches[0].sha256 = 'f'.repeat(64);
    write(directory, 'lock.json', changedLock);
    assert.notEqual(run('patch').status, 0);
    assert.equal(fs.readFileSync(path.join(directory, target), 'utf8'), originalLoginForm);
    write(directory, 'lock.json', lock);
    assert.equal(run('patch').status, 0);
    const patched = fs.readFileSync(path.join(directory, target), 'utf8');
    assert.equal(hash(patched), lock.umami.sourcePatches[0].patchedSha256);
    assert.notEqual(run('patch').status, 0);
    assert.equal(fs.readFileSync(path.join(directory, target), 'utf8'), patched);
});

test('build seal refuses missing patch proof and source changed after patching', t => {
    const { directory, run } = application(t);
    assert.notEqual(run('seal').status, 0);
    assert.equal(run('patch').status, 0);
    write(directory, 'src/app/login/LoginForm.tsx', originalLoginForm);
    assert.notEqual(run('seal').status, 0);
    assert.ok(!fs.existsSync(path.join(directory, 'ploinky-umami-build.json')));
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

function nativeProofFixture(directory, arch, identity) {
    const manifest = JSON.stringify({ config: { digest: digest('e') }, ...(arch === 'amd64' ? {} : { arch }) });
    write(directory, 'native-manifest.json', manifest);
    const nativeDigest = 'sha256:' + hash(manifest);
    const sourceIndex = JSON.stringify(index(arch, nativeDigest));
    const buildDigest = 'sha256:' + hash(sourceIndex);
    write(directory, 'source-index.json', sourceIndex);
    write(directory, 'build-digest.txt', buildDigest);
    write(directory, 'native-digest.txt', nativeDigest);
    const source = { workflowSha: identity.sha, workflowRunId: identity.runId, workflowAttempt: identity.attempt, architecture: arch,
        buildDigest, nativeDigest, sourceLockSha256: hash(JSON.stringify(sources)) };
    write(directory, 'source-evidence.json', source);
    const labels = {
        'org.opencontainers.image.revision': identity.sha, 'org.opencontainers.image.base.digest': sources.bases.postgres.indexDigest,
        'io.assistos.umami.base.node': sources.bases.node.image, 'io.assistos.umami.base.geo': sources.bases.upstreamUmami.image,
        'io.assistos.umami.version': sources.umami.version, 'io.assistos.umami.source.revision': sources.umami.commit,
        'io.assistos.umami.source.modified': 'true', 'io.assistos.umami.base-path': BASE_PATH,
        'io.assistos.umami.pnpm-lock.sha256': sources.umami.sourceFiles['pnpm-lock.yaml'], 'io.assistos.umami.alpine.release': sources.bases.node.alpineRelease,
    };
    const inspect = [{ Architecture: arch, Os: 'linux', Id: digest('e'), Config: { Labels: labels } }];
    write(directory, 'image-inspect.json', inspect);
    const smoke = { schema: 'ploinky.umami-image-smoke/v1', passed: true, uid: 1000, capabilityEffective: '0', noNewPrivileges: true,
        listener: '127.0.0.1:3001', databaseMigration: true, postgresVersion: sources.bases.postgres.postgresVersion,
        loginHttp: 200, heartbeatHttp: 200, authLoginHttp: 200, authVerifyHttp: 200, trackerHttp: 200, unprefixedNextHttp: 404,
        apiKeyWebsites: 200, apiKeyWebsiteCreate: 200, apiKeyUsers: 401, apiKeyOwnKeys: 401, sessionUsers: 200,
        mcpUnauthenticated: 401, mcpLoginToken: 401, mcpHandshake: 'initialize', mcpTools: 23, mcpListWebsites: true,
        sendBotIgnored: true, sendCacheToken: true, sessionRows: 1, sessionCountry: 'US',
        metadata: { basePath: BASE_PATH, version: sources.umami.version, sourceCommit: sources.umami.commit,
            sourcePatches: sources.umami.sourcePatches, sourcePatchReceiptSha256: 'f'.repeat(64),
            sourceArchiveSha256: sources.umami.sourceArchive.sha256, pnpmLockSha256: sources.umami.sourceFiles['pnpm-lock.yaml'],
            baseImages: { node: sources.bases.node.image, postgres: sources.bases.postgres.image, geo: sources.bases.upstreamUmami.image },
            geoDatabaseSha256: sources.umami.geo.sha256 },
        assets: ['script', 'css'].map(kind => ({ kind, path: BASE_PATH + '/_next/' + kind, bytes: 100, sha256: 'f'.repeat(64) })) };
    const sizes = { candidateBytes: 443000000, legacyBytes: 900000000, legacyImage: sources.continuity.legacyImage.image };
    write(directory, 'image-sizes.json', sizes);
    const continuityInit = { schema: 'ploinky.umami-continuity-init/v1', passed: true, umamiVersion: '3.2.0', migrations: 20,
        controlVersion: '1800', catalogVersion: '202506291', postgresUid: 70, majorVersion: '18', websiteId: '0'.repeat(32) };
    const continuity = { schema: 'ploinky.umami-continuity-smoke/v1', passed: true, existingDataDir: 'ok',
        legacy: { umamiVersion: '3.2.0', migrations: 20 }, candidate: { umamiVersion: '3.4.1', migrations: 26 },
        majorVersion: 18, catalogVersion: '202506291', controlVersion: '1800', postgresUid: 70 };
    write(directory, 'continuity-init.json', continuityInit);
    write(directory, 'continuity-smoke.json', continuity);
    smoke.metadataAssets = Object.entries(METADATA_ASSETS).map(([name, definition]) => ({ ...definition, path: BASE_PATH + '/' + name,
        status: 200, unprefixedHttp: 404, bytes: 100, sha256: metadataAssetHash(sources, name), contentType: metadataTypes[definition.kind] }));
    write(directory, 'runtime-smoke.json', smoke);
    return { source, labels, inspect, smoke, sizes, continuity };
}

test('native proof admission rejects stale run, source, failed HTTP, and image config substitution', t => {
    const directory = temp(t);
    const identity = { sha: '1'.repeat(40), runId: '12', attempt: '1' };
    const { source, labels, inspect, smoke, sizes, continuity } = nativeProofFixture(directory, 'amd64', identity);
    verifyNativeProof(directory, 'amd64', identity);
    for (const change of [{ workflowRunId: '11' }, { workflowSha: '2'.repeat(40) }, { sourceLockSha256: 'f'.repeat(64) }]) {
        write(directory, 'source-evidence.json', { ...source, ...change });
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
    }
    write(directory, 'source-evidence.json', source);
    for (const change of [{ authLoginHttp: 500 }, { passed: false }, { uid: 0 }, { assets: [] },
        { mcpTools: 22 }, { mcpTools: undefined }, { apiKeyUsers: 200 }, { apiKeyOwnKeys: 200 }, { apiKeyWebsites: 401 }, { apiKeyWebsiteCreate: 403 },
        { mcpLoginToken: 200 }, { mcpUnauthenticated: 200 }, { sendCacheToken: false }, { sendBotIgnored: false }, { sessionRows: 2 }, { sessionRows: 0 },
        { mcpListWebsites: false }, { postgresVersion: '17.5' },
        { metadata: { ...smoke.metadata, baseImages: { ...smoke.metadata.baseImages, node: 'docker.io/assistos/umami-agent@' + digest('a') } } },
        { metadataAssets: [] }, { metadataAssets: smoke.metadataAssets.slice(1) },
        { metadataAssets: [...smoke.metadataAssets, smoke.metadataAssets[0]] },
        { metadataAssets: smoke.metadataAssets.map((asset, i) => i ? asset : { ...asset, path: '/favicon.ico' }) },
        { metadataAssets: smoke.metadataAssets.map((asset, i) => i ? asset : { ...asset, sha256: '0'.repeat(64) }) },
        { metadataAssets: smoke.metadataAssets.map((asset, i) => i ? asset : { ...asset, contentType: 'text/html' }) },
        { metadataAssets: smoke.metadataAssets.map((asset, i) => i ? asset : { ...asset, contentType: 'application/octet-stream' }) },
        { metadataAssets: smoke.metadataAssets.map((asset, i) => i ? asset : { ...asset, unprefixedHttp: 200 }) },
        { metadata: { ...smoke.metadata, sourcePatches: [] } },
        { metadata: { ...smoke.metadata, sourcePatchReceiptSha256: undefined } }]) {
        write(directory, 'runtime-smoke.json', { ...smoke, ...change });
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
    }
    write(directory, 'runtime-smoke.json', smoke);
    for (const change of [{ passed: false }, { existingDataDir: 'failed' }, { candidate: { umamiVersion: '3.4.1', migrations: 20 } }, { majorVersion: 17 },
        { catalogVersion: '202401010' }, { legacy: { umamiVersion: '3.2.0', migrations: 19 } }, { postgresUid: 999 }]) {
        write(directory, 'continuity-smoke.json', { ...continuity, ...change });
        assert.throws(() => verifyContinuity(directory), JSON.stringify(change));
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity), JSON.stringify(change));
    }
    write(directory, 'continuity-smoke.json', continuity);
    fs.rmSync(path.join(directory, 'continuity-smoke.json'));
    assert.throws(() => verifyNativeProof(directory, 'amd64', identity), 'the continuity result is required evidence');
    write(directory, 'continuity-smoke.json', continuity);
    for (const change of [{ candidateBytes: 0 }, { legacyBytes: 'big' }, { legacyImage: 'docker.io/assistos/umami-agent@' + digest('a') }, { candidateBytes: undefined }]) {
        write(directory, 'image-sizes.json', { ...sizes, ...change });
        assert.throws(() => verifyImageSizes(directory), JSON.stringify(change));
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity), JSON.stringify(change));
    }
    fs.rmSync(path.join(directory, 'image-sizes.json'));
    assert.throws(() => verifyNativeProof(directory, 'amd64', identity), 'the size record is required evidence');
    write(directory, 'image-sizes.json', sizes);
    for (const [label, value] of [['io.assistos.umami.version', '3.2.0'], ['io.assistos.umami.source.revision', '2f6e2b5ff256862a081d9e74bed18a42ebf795e3'],
        ['org.opencontainers.image.base.digest', digest('a')], ['io.assistos.bun.version', '1.3.14'], ['io.assistos.umami-mcp.revision', 'a'.repeat(40)],
        ['io.assistos.umami.base.node', 'docker.io/assistos/umami-agent@' + digest('a')]]) {
        write(directory, 'image-inspect.json', [{ ...inspect[0], Config: { Labels: { ...labels, [label]: value } } }]);
        assert.throws(() => verifyNativeProof(directory, 'amd64', identity), label);
    }
    write(directory, 'image-inspect.json', inspect);
    inspect[0].Id = digest('f'); write(directory, 'image-inspect.json', inspect);
    assert.throws(() => verifyNativeProof(directory, 'amd64', identity));
});

// ---- A fake registry for the read-only promotion and base-pin checks.
function registry(t) {
    const objects = new Map();
    const add = (value, kind) => { const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); const id = 'sha256:' + hash(body); objects.set(`${kind}/${id}`, body); return id; };
    const tags = new Map();
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const { pathname } = new URL(url);
        requests.push(pathname);
        const match = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(pathname);
        if (!match) return new Response('{"token":"anonymous"}', { status: 200 });
        if (!/^Bearer anonymous$/.test(new Headers(init.headers).get('authorization') || '')) {
            return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="https://${new URL(url).hostname === 'registry-1.docker.io' ? 'auth.docker.io' : 'auth.example'}/token",service="registry.example"` } });
        }
        const body = match[3].startsWith('sha256:') ? objects.get(`${match[2]}/${match[3]}`) : tags.get(match[3]);
        return body ? new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' } }) : new Response('', { status: 404 });
    };
    return { add, tags, fetchImpl, requests, objects };
}
const imageLabels = { 'io.assistos.umami.version': sources.umami.version, 'io.assistos.umami.source.revision': sources.umami.commit };
function publishedIndex(fake, { labels = imageLabels, platforms = ['amd64', 'arm64'], attestationFor, extra = [] } = {}) {
    const images = platforms.map(architecture => {
        const config = fake.add({ os: 'linux', architecture, config: { Labels: labels } }, 'blobs');
        const manifest = fake.add({ schemaVersion: 2, config: { digest: config, mediaType: 'application/vnd.oci.image.config.v1+json', size: 1 }, layers: [] }, 'manifests');
        return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifest, size: 1, platform: { os: 'linux', architecture } };
    });
    const attestations = images.map(image => ({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: fake.add({ attestation: image.digest }, 'manifests'), size: 1,
        platform: { architecture: 'unknown', os: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': attestationFor || image.digest } }));
    return fake.add({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [...images, ...attestations, ...extra] }, 'manifests');
}

test('promotion accepts only an assistos index of exactly amd64 and arm64 naming this Umami version and commit', async t => {
    const fake = registry(t);
    const good = publishedIndex(fake);
    assert.deepEqual(await verifyPromotionTarget(good, sources, { fetchImpl: fake.fetchImpl }), { digest: good, platforms: ['linux/amd64', 'linux/arm64'] });
    assert.ok(fake.requests.some(request => request.startsWith('/v2/assistos/umami-agent/manifests/')), 'it reads the assistos/umami-agent repository');
    const missingPlatform = publishedIndex(fake, { platforms: ['amd64'] });
    const extraPlatform = publishedIndex(fake, { platforms: ['amd64', 'arm64', 's390x'] });
    const oldVersion = publishedIndex(fake, { labels: { ...imageLabels, 'io.assistos.umami.version': '3.2.0' } });
    const otherCommit = publishedIndex(fake, { labels: { ...imageLabels, 'io.assistos.umami.source.revision': 'a'.repeat(40) } });
    const noLabels = publishedIndex(fake, { labels: {} });
    const looseAttestation = publishedIndex(fake, { attestationFor: digest('a') });
    const singleManifest = fake.add({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: digest('c') }, layers: [] }, 'manifests');
    for (const [name, candidate] of Object.entries({ missingPlatform, extraPlatform, oldVersion, otherCommit, noLabels, looseAttestation, singleManifest, unknown: digest('d') })) {
        await assert.rejects(verifyPromotionTarget(candidate, sources, { fetchImpl: fake.fetchImpl }), undefined, name);
    }
    await assert.rejects(verifyPromotionTarget('sha256:short', sources, { fetchImpl: fake.fetchImpl }));
    // A registry answering with other bytes than the named digest is refused.
    const wrong = publishedIndex(fake, { platforms: ['amd64'] });
    fake.objects.set(`manifests/${good}`, fake.objects.get(`manifests/${wrong}`));
    await assert.rejects(verifyPromotionTarget(good, sources, { fetchImpl: fake.fetchImpl }), /hash to the requested digest/);
});

test('tag verification requires both tags to resolve to the promoted digest bytes', async t => {
    const fake = registry(t);
    const promoted = publishedIndex(fake);
    fake.tags.set('umami-stack', fake.objects.get(`manifests/${promoted}`));
    fake.tags.set('latest', fake.objects.get(`manifests/${promoted}`));
    assert.deepEqual(await verifyTagsResolve(promoted, ['umami-stack', 'latest'], { fetchImpl: fake.fetchImpl }), ['umami-stack', 'latest']);
    fake.tags.set('latest', fake.objects.get(`manifests/${publishedIndex(fake, { platforms: ['amd64'] })}`));
    await assert.rejects(verifyTagsResolve(promoted, ['umami-stack', 'latest'], { fetchImpl: fake.fetchImpl }), /latest must resolve/);
    await assert.rejects(verifyTagsResolve(promoted, ['missing'], { fetchImpl: fake.fetchImpl }));
});

test('pinned public bases are verified against their index, native manifests and configs', async t => {
    const fake = registry(t);
    const base = { platformManifests: {}, platformConfigs: {} };
    const manifests = ['amd64', 'arm64'].map(architecture => {
        const config = fake.add({ architecture }, 'blobs');
        const manifest = fake.add({ schemaVersion: 2, config: { digest: config } }, 'manifests');
        base.platformManifests[`linux/${architecture}`] = manifest;
        base.platformConfigs[`linux/${architecture}`] = config;
        return { digest: manifest, platform: { os: 'linux', architecture } };
    });
    const variant = { digest: digest('9'), platform: { os: 'linux', architecture: 'arm', variant: 'v7' } };
    base.indexDigest = fake.add({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [...manifests, variant] }, 'manifests');
    base.image = `registry.example/library/thing:1@${base.indexDigest}`;
    assert.deepEqual(await verifyPinnedBase('thing', base, { fetchImpl: fake.fetchImpl }), { name: 'thing', indexDigest: base.indexDigest });
    for (const [name, change] of Object.entries({
        manifest: { platformManifests: { ...base.platformManifests, 'linux/arm64': digest('1') } },
        config: { platformConfigs: { ...base.platformConfigs, 'linux/amd64': digest('2') } },
        pin: { image: `registry.example/library/thing:1@${digest('3')}` },
    })) await assert.rejects(verifyPinnedBase('thing', { ...base, ...change }, { fetchImpl: fake.fetchImpl }), undefined, name);
    assert.deepEqual(parseReference(sources.bases.node.image), { host: 'registry-1.docker.io', repository: 'library/node', tag: '22.23.4-alpine3.24', digest: sources.bases.node.indexDigest });
    assert.equal(parseReference(sources.bases.upstreamUmami.image).host, 'docker.umami.is');
    assert.equal(parseReference(sources.continuity.legacyImage.image).repository, 'assistos/umami-agent');
});

test('smoke helpers: API key digest, MCP bodies, tool inventory and pg_controldata', () => {
    const key = 'umami_' + '0123456789abcdef'.repeat(2);
    const row = apiKeyRow(key);
    assert.equal(row.hash, crypto.createHash('sha512').update(key).digest('hex'));
    assert.equal(row.prefix, 'umami_01234567');
    assert.throws(() => apiKeyRow('umami_short'));
    assert.equal(ADMIN_USER_ID, '41e2b680-648e-4b09-bcd7-3e2b10c06264');
    assert.deepEqual(parseMcpBody('application/json', '{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', 3).result, { ok: true });
    assert.deepEqual(parseMcpBody('application/json', '[{"id":1},{"id":2,"result":1}]', 2), { id: 2, result: 1 });
    assert.equal(parseMcpBody('text/event-stream', 'event: message\ndata: {"id":9,"result":{"tools":[]}}\n\n', 9).id, 9);
    assert.equal(parseMcpBody('text/event-stream', 'data: {"id":1}\n\ndata: {"id":2}\n\n', 2).id, 2);
    assert.equal(parseMcpBody('application/json', '', 1), undefined);
    assert.equal(MCP_TOOLS.length, 23);
    assert.equal(verifyMcpTools(MCP_TOOLS.map(name => ({ name }))), 23);
    for (const names of [MCP_TOOLS.slice(1), [...MCP_TOOLS, 'extra'], [...MCP_TOOLS.slice(1), MCP_TOOLS[1]], [...MCP_TOOLS.slice(1), 'other']]) {
        assert.throws(() => verifyMcpTools(names.map(name => ({ name }))));
    }
    const control = 'pg_control version number:            1800\nCatalog version number:               202506291\nDatabase cluster state:               shut down\n';
    assert.deepEqual(parseControlData(control), { controlVersion: '1800', catalogVersion: '202506291', state: 'shut down' });
    assert.throws(() => parseControlData('nothing here'));
});

test('metadata source correction preserves login patch identity and binds every exact original and patched file', t => {
    const { directory, lock, run } = application(t);
    assert.equal(hash(read('images/umami-agent/patch-login-query-cache.mjs')), lock.umami.sourcePatches[0].sha256);
    const patch = lock.umami.sourcePatches[1];
    assert.equal(patch.sha256, hash(read('images/umami-agent/patch-metadata-assets.mjs')));
    assert.deepEqual(patch.targets.map(value => value.target), metadataTargets);
    for (const item of patch.targets) {
        const original = fs.readFileSync(path.join(directory, item.target), 'utf8');
        assert.equal(hash(original), item.originalSha256);
        assert.equal(hash(rewriteMetadataSource(item.target, original)), item.patchedSha256);
    }
    assert.equal(run('source').status, 0);
    assert.equal(run('patch').status, 0);
    assert.deepEqual(json(directory, 'ploinky-umami-source-patches.json').sourcePatches, sources.umami.sourcePatches);
    assert.equal(run('seal').status, 0);
    verifyBuildMetadata(directory, lock);
});

test('metadata patch rejects substituted patch identity and target output before touching the login source', t => {
    const { directory, lock, run } = application(t);
    for (const modify of [patch => { patch.sha256 = 'f'.repeat(64); }, patch => { patch.targets[1].patchedSha256 = 'f'.repeat(64); }]) {
        const changed = structuredClone(lock);
        modify(changed.umami.sourcePatches[1]);
        write(directory, 'lock.json', changed);
        assert.notEqual(run('patch').status, 0);
        assert.equal(fs.readFileSync(path.join(directory, 'src/app/login/LoginForm.tsx'), 'utf8'), originalLoginForm);
        assert.ok(!fs.existsSync(path.join(directory, 'ploinky-umami-source-patches.json')));
    }
});

for (const target of metadataTargets) test(`metadata patch refuses changed ${target} before applying any source patch`, t => {
    const { directory, run } = application(t);
    fs.appendFileSync(path.join(directory, target), '\n');
    assert.notEqual(run('patch').status, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'src/app/login/LoginForm.tsx'), 'utf8'), originalLoginForm);
    assert.ok(!fs.existsSync(path.join(directory, 'ploinky-umami-source-patches.json')));
});

const metadataHtml = prefix => Object.entries(METADATA_ASSETS).filter(([, value]) => value.source === 'head').map(([name]) => name === 'browserconfig.xml'
    ? `<meta name="msapplication-config" content="${prefix}/${name}">`
    : `<link rel="${name === 'site.webmanifest' ? 'manifest' : 'icon'}" href="${prefix}/${name}">`).join('');

test('metadata declarations reject root, foreign, sibling-prefix and missing assets including nested icon paths', t => {
    const { directory, run } = application(t);
    assert.equal(run('patch').status, 0);
    const origin = 'http://127.0.0.1:3001';
    for (const prefix of ['', 'https://foreign.test' + BASE_PATH, BASE_PATH + '0']) assert.throws(() => metadataHeadAssets(metadataHtml(prefix), origin));
    assert.throws(() => metadataHeadAssets(metadataHtml(BASE_PATH).replace(/<meta[^>]+>/, ''), origin));
    const assets = metadataHeadAssets(metadataHtml(BASE_PATH), origin);
    assert.equal(assets.length, 7);
    for (const kind of ['manifest', 'xml']) {
        const resource = assets.find(value => value.kind === kind);
        const body = fs.readFileSync(path.join(directory, 'public', resource.name));
        assert.equal(nestedMetadataAssets(body, resource).length, kind === 'manifest' ? 2 : 1);
        for (const replacement of ['', 'https://foreign.test' + BASE_PATH, BASE_PATH + '0']) {
            assert.throws(() => nestedMetadataAssets(Buffer.from(body.toString().replaceAll(BASE_PATH, replacement)), resource));
        }
    }
});

test('native metadata probe fetches real head, manifest icons and XML tile bytes and rejects HTTP fallback', async t => {
    const { directory, lock, run } = application(t);
    assert.equal(run('patch').status, 0);
    const seen = [];
    let failure;
    const server = http.createServer((req, res) => {
        seen.push(req.url);
        const name = req.url.startsWith(BASE_PATH + '/') ? req.url.slice(BASE_PATH.length + 1) : null;
        const definition = METADATA_ASSETS[name];
        if (!definition) { res.writeHead(failure === 'unprefixed' ? 200 : 404); res.end(); return; }
        if (failure === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>fallback</html>'); return; }
        res.writeHead(200, { 'content-type': metadataTypes[definition.kind] });
        res.end(failure === 'bytes' ? Buffer.from('substituted') : fs.readFileSync(path.join(directory, 'public', name)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const observed = await fetchMetadataAssets(metadataHtml(BASE_PATH), origin, lock);
    assert.equal(observed.length, 10);
    assert.deepEqual(new Set(seen), new Set(Object.keys(METADATA_ASSETS).flatMap(name => [BASE_PATH + '/' + name, '/' + name])));
    for (const mode of ['html', 'bytes', 'unprefixed']) {
        failure = mode;
        await assert.rejects(fetchMetadataAssets(metadataHtml(BASE_PATH), origin, lock));
    }
});

test('registry credentials reach only Docker Hub, and a challenge cannot widen the scope or borrow Docker Hub\'s token service', async () => {
    const seen = [];
    const challenge = (realm, scope = '') => new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}",service="s"${scope ? `,scope="${scope}"` : ''}` } });
    const fetchImpl = realm => async (url, init = {}) => {
        const target = new URL(url);
        const authorization = new Headers(init.headers).get('authorization');
        seen.push({ host: target.hostname, authorization, scope: target.searchParams.get('scope') });
        if (target.pathname.startsWith('/token')) return new Response('{"token":"t"}');
        return authorization?.startsWith('Bearer ') ? new Response('{}') : challenge(realm(target.hostname), 'repository:assistos/umami-agent:pull,push');
    };
    const credentials = { username: 'assistos', password: 'not-a-real-token' };
    await registryGet('docker.io/assistos/umami-agent@' + digest('a'), 'manifests', digest('a'), { fetchImpl: fetchImpl(() => 'https://auth.docker.io/token'), credentials });
    const docker = seen.find(entry => entry.host === 'auth.docker.io');
    assert.equal(docker.authorization, 'Basic ' + Buffer.from('assistos:not-a-real-token').toString('base64'));
    assert.equal(docker.scope, 'repository:assistos/umami-agent:pull', 'the challenger-supplied push scope is ignored');
    seen.length = 0;
    await registryGet('docker.umami.is/umami-software/umami:3.4.1', 'manifests', '3.4.1', { fetchImpl: fetchImpl(() => 'https://ghcr.example/token'), credentials });
    assert.equal(seen.find(entry => entry.host === 'ghcr.example').authorization, null, 'no credential for another realm');
    assert.equal(seen.find(entry => entry.host === 'ghcr.example').scope, 'repository:umami-software/umami:pull');
    // A foreign registry that names Docker Hub's token service gets neither credentials nor a Docker Hub token: nothing is requested from it.
    seen.length = 0;
    await assert.rejects(registryGet('docker.umami.is/umami-software/umami:3.4.1', 'manifests', '3.4.1', { fetchImpl: fetchImpl(() => 'https://auth.docker.io/token'), credentials }), /may not use the token service auth\.docker\.io/);
    assert.ok(!seen.some(entry => entry.host === 'auth.docker.io'), 'no request reached Docker Hub\'s token service');
    assert.ok(!seen.some(entry => entry.authorization), 'no authorization header was sent anywhere');
    // Docker Hub itself may not redirect token requests to another host (the credentials would not be sent there either).
    await assert.rejects(registryGet('docker.io/assistos/umami-agent@' + digest('a'), 'manifests', digest('a'), { fetchImpl: fetchImpl(() => 'https://elsewhere.example/token'), credentials }), /may not use the token service/);
    await assert.rejects(registryGet('docker.umami.is/umami-software/umami:3.4.1', 'manifests', '3.4.1', { fetchImpl: fetchImpl(() => 'http://ghcr.example/token') }), /https/);
});

const candidateRun = (overrides = {}) => ({ id: 1234, run_attempt: 2, repository: { full_name: 'AssistOS-AI/container-image-builds' }, head_repository: { full_name: 'AssistOS-AI/container-image-builds' },
    path: '.github/workflows/publish-umami-agent-image.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), ...overrides });
const candidateInputs = { runId: '1234', runAttempt: '2' };

test('promotion pins a successful dispatched candidate run and exactly one live artifact built at its commit', () => {
    const repository = 'AssistOS-AI/container-image-builds';
    const run = pinCandidateRun(candidateRun(), candidateInputs, repository);
    for (const change of [{ id: 9 }, { run_attempt: 1 }, { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'push' }, { path: '.github/workflows/other.yml' },
        { repository: { full_name: 'someone/else' } }, { head_repository: { full_name: 'someone/else' } }, { head_sha: 'short' }]) {
        assert.throws(() => pinCandidateRun(candidateRun(change), candidateInputs, repository), JSON.stringify(change));
    }
    assert.throws(() => pinCandidateRun(candidateRun(), { runId: '12x4', runAttempt: '2' }, repository));
    const artifact = (change = {}) => ({ name: 'umami-candidate-1234-2', expired: false, workflow_run: { id: 1234, head_sha: run.head_sha }, ...change });
    assert.equal(checkCandidateArtifact([artifact()], candidateInputs, run).name, 'umami-candidate-1234-2');
    for (const listing of [[], [artifact(), artifact()], [artifact({ expired: true })], [artifact({ name: 'umami-candidate-1234-1' })],
        [artifact({ workflow_run: { id: 5, head_sha: run.head_sha } })], [artifact({ workflow_run: { id: 1234, head_sha: 'b'.repeat(40) } })]]) {
        assert.throws(() => checkCandidateArtifact(listing, candidateInputs, run));
    }
});

test('promotion evidence must name the promoted digest and carry passing native proofs for the candidate commit', t => {
    const directory = temp(t);
    const identity = { sha: '1'.repeat(40), runId: '12', attempt: '1' };
    const manifests = [];
    for (const arch of ['amd64', 'arm64']) {
        const proof = path.join(directory, 'native-proofs', 'umami-proof-' + arch);
        nativeProofFixture(proof, arch, identity);
        manifests.push(...json(proof, 'source-index.json').manifests);
    }
    const candidate = JSON.stringify({ schemaVersion: 2, manifests });
    write(directory, 'candidate-index.json', candidate);
    write(directory, 'immutable-index.json', candidate);
    const promoted = 'sha256:' + hash(candidate);
    write(directory, 'digest.txt', promoted + '\n');
    assert.deepEqual(verifyPromotionEvidence(directory, promoted, identity, sources), ['amd64', 'arm64']);
    const arm64 = path.join(directory, 'native-proofs/umami-proof-arm64');
    const attempts = {
        'another promoted digest': [() => {}, digest('d'), identity, /names another digest/],
        'another workflow run': [() => {}, promoted, { ...identity, runId: '13' }, /./],
        'another commit': [() => {}, promoted, { ...identity, sha: '2'.repeat(40) }, /./],
        'a candidate index that does not hash to the digest': [() => write(directory, 'candidate-index.json', candidate + '\n'), promoted, identity, /does not hash/],
        'an immutable index that differs': [() => { write(directory, 'candidate-index.json', candidate); write(directory, 'immutable-index.json', candidate + '\n'); }, promoted, identity, /immutable index differs/],
        'a failed smoke in one proof': [() => { write(directory, 'immutable-index.json', candidate); write(arm64, 'runtime-smoke.json', { ...json(arm64, 'runtime-smoke.json'), passed: false }); }, promoted, identity, /./],
    };
    for (const [name, [mutate, digestArgument, who, message]] of Object.entries(attempts)) {
        mutate();
        assert.throws(() => verifyPromotionEvidence(directory, digestArgument, who, sources), message, name);
    }
    fs.rmSync(arm64, { recursive: true });
    assert.throws(() => verifyPromotionEvidence(directory, promoted, identity, sources), /./, 'a missing proof set');
});

for (const mode of ['stateless-initialize', 'direct-only', 'event-stream']) test(`MCP probe completes the tool inventory over ${mode}`, async t => {
    const tools = MCP_TOOLS.map(name => ({ name }));
    const seen = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const message = body ? JSON.parse(body) : {};
            seen.push([message.method, request.headers['mcp-protocol-version'] || null]);
            const reply = result => {
                const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
                if (mode === 'event-stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: message\ndata: ${payload}\n\n`); }
                else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(payload); }
            };
            if (request.headers.authorization !== 'Bearer umami_key') { response.writeHead(401); response.end('{}'); return; }
            if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
            if (message.method === 'initialize') {
                if (mode === 'direct-only') { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"stateless"}'); return; }
                return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'umami' } });
            }
            if (message.method === 'tools/list') {
                const page = message.params?.cursor ? 2 : 1;
                return reply(page === 1 ? { tools: tools.slice(0, 20), nextCursor: 'next' } : { tools: tools.slice(20) });
            }
            response.writeHead(404); response.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const session = await mcpSession(origin, 'umami_key');
    assert.equal(session.handshake, mode === 'direct-only' ? 'direct' : 'initialize');
    assert.equal(verifyMcpTools(session.tools), 23);
    if (mode !== 'direct-only') assert.ok(seen.some(([method, version]) => method === 'tools/list' && version === '2025-06-18'), 'the negotiated protocol version is sent');
    assert.equal((await mcpCall(origin, 'umami_other', { jsonrpc: '2.0', id: 5, method: 'tools/list' })).status, 401);
});
