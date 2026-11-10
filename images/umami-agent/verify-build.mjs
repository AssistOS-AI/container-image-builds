import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const platformOf = () => ({ x64: 'linux/amd64', arm64: 'linux/arm64' })[process.arch];
const enginesDirectory = (root, prisma) => path.join(root, 'node_modules/.pnpm', prisma.enginesPackage.replace('/', '+'), 'node_modules', prisma.enginesPackage.replace(/@[^@]+$/, ''));

// Prisma's postinstall downloads the schema engine from its own CDN and ignores a failed download
// (failSilent), so an absent or substituted binary is only detectable by checking the installed bytes.
export function verifySchemaEngine(root, prisma, platform = platformOf()) {
    const expected = prisma.platforms[platform];
    assert.ok(expected, `no pinned Prisma schema engine for ${platform}`);
    const engines = enginesDirectory(root, prisma);
    const installed = fs.readdirSync(engines).filter(name => name.startsWith(prisma.binary));
    assert.equal(installed.length, 1, 'exactly one schema engine must be installed');
    assert.equal(sha(path.join(engines, installed[0])), expected.sha256, 'schema engine bytes must match the pinned SHA-256');
    return { target: expected.target, sha256: expected.sha256 };
}

function main() {
    const [mode, directory, lockPath, sourceDirectory] = process.argv.slice(2);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.schemaVersion, 3);
    assert.equal(lock.umami.version, '3.4.1');
    assert.equal(lock.umami.basePath, '/base-agent-additional-server/umamiAgent/3000');
    assert.match(lock.umami.commit, /^[a-f0-9]{40}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version, lock.umami.version);
    if (mode === 'source') {
        for (const [name, expected] of Object.entries(lock.umami.sourceFiles)) {
            assert.equal(sha(path.join(directory, name)), expected, `source input: ${name}`);
        }
        const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
        assert.equal(packageJson.engines.pnpm, lock.umami.pnpm.version, 'the pinned package manager is the one Umami declares');
        for (const name of ['prisma', '@prisma/client', '@prisma/adapter-pg']) {
            assert.equal(packageJson.dependencies[name], `^${lock.umami.prisma.version}`, `${name} follows the pinned Prisma line`);
        }
        const pnpmLock = fs.readFileSync(path.join(directory, 'pnpm-lock.yaml'), 'utf8');
        assert.ok(pnpmLock.includes(`'${lock.umami.prisma.enginesPackage}':`), 'the lockfile resolves the pinned Prisma engines package');
        assert.match(pnpmLock, new RegExp(`'@prisma/engines-version@${lock.umami.prisma.version.replaceAll('.', '\\.')}-\\d+\\.${lock.umami.prisma.enginesVersion}':`), 'the lockfile resolves the pinned Prisma engines revision');
    } else if (mode === 'engines') {
        console.log(JSON.stringify(verifySchemaEngine(directory, lock.umami.prisma)));
    } else {
        assert.equal(mode, 'seal');
        assert.ok(sourceDirectory, 'the seal requires the actual patched build source');
        const patchReceipt = path.join(directory, 'ploinky-umami-source-patches.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(patchReceipt)), {
            upstreamSourceCommit: lock.umami.commit,
            upstreamSourceArchiveSha256: lock.umami.sourceArchive.sha256,
            sourcePatches: lock.umami.sourcePatches,
        });
        assert.deepEqual(lock.umami.sourcePatches.map(patch => patch.id), ['login-query-cache', 'metadata-assets']);
        for (const patch of lock.umami.sourcePatches) {
            for (const target of patch.targets || [patch]) {
                assert.equal(sha(path.join(sourceDirectory, target.target)), target.patchedSha256, 'actual source compiled with the reviewed patch');
                if (target.target.startsWith('public/')) assert.equal(sha(path.join(directory, target.target)), target.patchedSha256, 'runtime metadata must preserve the patched public file');
            }
        }
        for (const [name, originalSha256] of Object.entries(lock.umami.sourceFiles).filter(([name]) => name.startsWith('public/'))) {
            const patch = lock.umami.sourcePatches.flatMap(value => value.targets || [value]).find(value => value.target === name);
            assert.equal(sha(path.join(directory, name)), patch?.patchedSha256 || originalSha256, 'sealed metadata asset bytes');
        }
        const required = path.join(directory, '.next/required-server-files.json');
        const config = JSON.parse(fs.readFileSync(required)).config;
        assert.equal(config.basePath, lock.umami.basePath);
        assert.equal(config.assetPrefix, lock.umami.basePath);
        assert.equal(config.env.basePath, lock.umami.basePath);
        assert.equal(config.output, 'standalone');
        assert.equal(sha(path.join(directory, 'pnpm-lock.yaml')), lock.umami.sourceFiles['pnpm-lock.yaml']);
        const geo = path.join(directory, 'geo/GeoLite2-City.mmdb');
        assert.equal(sha(geo), lock.umami.geo.sha256, 'GeoIP bytes must be the pinned upstream database');
        assert.equal(fs.statSync(geo).size, lock.umami.geo.bytes);
        const engine = verifySchemaEngine(directory, lock.umami.prisma);
        const metadata = {
            schema: 'ploinky.umami-build/v1', version: lock.umami.version,
            sourceCommit: lock.umami.commit, sourceArchiveSha256: lock.umami.sourceArchive.sha256,
            sourcePatches: lock.umami.sourcePatches, sourcePatchReceiptSha256: sha(patchReceipt),
            basePath: lock.umami.basePath,
            baseImages: { node: lock.bases.node.image, postgres: lock.bases.postgres.image, geo: lock.bases.upstreamUmami.image },
            alpineRelease: lock.bases.node.alpineRelease,
            pnpmVersion: lock.umami.pnpm.version, pnpmLockSha256: lock.umami.sourceFiles['pnpm-lock.yaml'],
            prisma: { version: lock.umami.prisma.version, enginesVersion: lock.umami.prisma.enginesVersion, schemaEngine: engine },
            requiredServerFilesSha256: sha(required), standaloneServerSha256: sha(path.join(directory, 'server.js')),
            trackerSha256: sha(path.join(directory, 'public/script.js')), geoDatabaseSha256: sha(geo),
        };
        fs.writeFileSync(path.join(directory, 'ploinky-umami-build.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
