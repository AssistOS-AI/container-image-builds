import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [mode, directory, lockPath, sourceDirectory] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
assert.equal(lock.schemaVersion, 2);
assert.equal(lock.umami.version, '3.2.0');
assert.equal(lock.umami.basePath, '/base-agent-additional-server/umamiAgent/3000');
assert.match(lock.umami.commit, /^[a-f0-9]{40}$/);
assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version, lock.umami.version);
if (mode === 'source') {
    for (const [name, expected] of Object.entries(lock.umami.sourceFiles)) {
        assert.equal(sha(path.join(directory, name)), expected, `source input: ${name}`);
    }
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
    assert.equal(sha(geo), sha(lock.umami.geo.path), 'GeoIP bytes must come unchanged from the pinned runtime base');
    const metadata = {
        schema: 'ploinky.umami-build/v1', version: lock.umami.version,
        sourceCommit: lock.umami.commit, sourceArchiveSha256: lock.umami.sourceArchive.sha256,
        sourcePatches: lock.umami.sourcePatches, sourcePatchReceiptSha256: sha(patchReceipt),
        basePath: lock.umami.basePath, runtimeBaseImage: lock.runtimeBase.image,
        pnpmVersion: lock.umami.pnpm.version, pnpmLockSha256: lock.umami.sourceFiles['pnpm-lock.yaml'],
        requiredServerFilesSha256: sha(required), standaloneServerSha256: sha(path.join(directory, 'server.js')),
        trackerSha256: sha(path.join(directory, 'public/script.js')), geoDatabaseSha256: sha(geo),
    };
    fs.writeFileSync(path.join(directory, 'ploinky-umami-build.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
}
