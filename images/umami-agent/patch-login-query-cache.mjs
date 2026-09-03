import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const target = 'src/app/login/LoginForm.tsx';
export const receiptName = 'ploinky-umami-source-patches.json';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const edits = [
    ["import { useRouter } from 'next/navigation';", "import { useQueryClient } from '@tanstack/react-query';\nimport { useRouter } from 'next/navigation';"],
    ['  const router = useRouter();', '  const router = useRouter();\n  const queryClient = useQueryClient();'],
    ['        setClientAuthToken(token);\n        setUser(user);',
        "        setClientAuthToken(token);\n        await queryClient.cancelQueries({ queryKey: ['login'], exact: true });\n        queryClient.setQueryData(['login'], user);\n        setUser(user);"],
];

export function rewriteLoginForm(source, reverse = false) {
    for (const pair of reverse ? [...edits].reverse() : edits) {
        const [before, after] = reverse ? [pair[1], pair[0]] : pair;
        assert.equal(source.split(before).length, 2, 'login cache patch must match each exact source fragment once');
        source = source.replace(before, after);
    }
    return source;
}

export function applyLoginCachePatch(directory, lock) {
    assert.equal(lock.umami.sourcePatches.length, 1, 'only the reviewed login cache patch is supported');
    const patch = lock.umami.sourcePatches[0];
    assert.equal(patch.id, 'login-query-cache');
    assert.equal(patch.file, 'patch-login-query-cache.mjs');
    assert.equal(patch.target, target);
    assert.equal(sha(fs.readFileSync(fileURLToPath(import.meta.url))), patch.sha256, 'source patch identity');
    assert.equal(patch.originalSha256, lock.umami.sourceFiles[target], 'upstream target identity');
    const filename = path.join(directory, target);
    const source = fs.readFileSync(filename, 'utf8');
    assert.equal(sha(source), patch.originalSha256, 'refuse changed or already-patched upstream LoginForm');
    const patched = rewriteLoginForm(source);
    assert.equal(sha(patched), patch.patchedSha256, 'patched LoginForm identity');
    const receipt = path.join(directory, receiptName);
    assert.ok(!fs.existsSync(receipt), 'refuse an existing patch receipt');
    fs.writeFileSync(filename, patched);
    fs.writeFileSync(receipt, JSON.stringify({
        upstreamSourceCommit: lock.umami.commit,
        upstreamSourceArchiveSha256: lock.umami.sourceArchive.sha256,
        sourcePatches: lock.umami.sourcePatches,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [directory, lockPath] = process.argv.slice(2);
    applyLoginCachePatch(directory, JSON.parse(fs.readFileSync(lockPath, 'utf8')));
}
