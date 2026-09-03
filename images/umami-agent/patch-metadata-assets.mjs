import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLoginCachePatch, receiptName } from './patch-login-query-cache.mjs';

export const BASE_PATH = '/base-agent-additional-server/umamiAgent/3000';
export const targets = ['src/app/layout.tsx', 'public/site.webmanifest', 'public/browserconfig.xml'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const headAssets = ['favicon.ico', 'apple-touch-icon.png', 'favicon-32x32.png', 'favicon-16x16.png', 'site.webmanifest', 'safari-pinned-tab.svg'];

export function rewriteMetadataSource(target, source, basePath = BASE_PATH) {
    assert.equal(basePath, BASE_PATH, 'only the compiled Router publication is supported');
    assert.ok(targets.includes(target), 'unrecognized metadata source');
    const edits = target === targets[0]
        ? [...headAssets.map(name => [`href="/${name}"`, 'href={`${process.env.basePath || \'\'}/' + name + '`}']),
            ['        <meta name="msapplication-TileColor"', '        <meta name="msapplication-config" content={`${process.env.basePath || \'\'}/browserconfig.xml`} />\n        <meta name="msapplication-TileColor"']]
        : (target === targets[1] ? ['android-chrome-192x192.png', 'android-chrome-512x512.png'] : ['mstile-150x150.png'])
            .map(name => [`"/${name}"`, `"${basePath}/${name}"`]);
    for (const [before, after] of edits) {
        assert.equal(source.split(before).length, 2, 'metadata patch must match each exact source fragment once');
        source = source.replace(before, after);
    }
    return source;
}

export function applySourcePatches(directory, lock) {
    assert.deepEqual(lock.umami.sourcePatches.map(patch => patch.id), ['login-query-cache', 'metadata-assets']);
    assert.equal(lock.umami.basePath, BASE_PATH);
    const patch = lock.umami.sourcePatches[1];
    assert.equal(patch.file, 'patch-metadata-assets.mjs');
    assert.equal(hash(fs.readFileSync(fileURLToPath(import.meta.url))), patch.sha256, 'metadata patch identity');
    assert.deepEqual(patch.targets.map(item => item.target), targets);
    const changed = patch.targets.map(item => {
        assert.equal(item.originalSha256, lock.umami.sourceFiles[item.target], 'upstream metadata identity');
        const filename = path.join(directory, item.target);
        const original = fs.readFileSync(filename, 'utf8');
        assert.equal(hash(original), item.originalSha256, 'refuse changed or already-patched upstream metadata');
        const modified = rewriteMetadataSource(item.target, original, lock.umami.basePath);
        assert.equal(hash(modified), item.patchedSha256, 'patched metadata identity');
        return { filename, modified };
    });
    // Keep the independently verified login patch and its one-patch contract unchanged.
    const loginLock = { ...lock, umami: { ...lock.umami, sourcePatches: [lock.umami.sourcePatches[0]] } };
    applyLoginCachePatch(directory, loginLock);
    const receipt = path.join(directory, receiptName);
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(previous, {
        upstreamSourceCommit: lock.umami.commit,
        upstreamSourceArchiveSha256: lock.umami.sourceArchive.sha256,
        sourcePatches: loginLock.umami.sourcePatches,
    });
    for (const { filename, modified } of changed) fs.writeFileSync(filename, modified);
    fs.unlinkSync(receipt);
    fs.writeFileSync(receipt, JSON.stringify({ ...previous, sourcePatches: lock.umami.sourcePatches }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [directory, lockPath] = process.argv.slice(2);
    applySourcePatches(directory, JSON.parse(fs.readFileSync(lockPath, 'utf8')));
}
