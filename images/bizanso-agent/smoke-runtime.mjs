import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import { inputs, loadModel } from './model.mjs';

assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s*0000000000000000$/m);
assert.match(status, /^NoNewPrivs:\s*1$/m);
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
assert.deepEqual(readdirSync('/opt/bizanso-runtime').sort(), [
    'model.mjs', 'models', 'node_modules', 'package-lock.json', 'package.json',
    'prepare-model.mjs', 'smoke-runtime.mjs', 'sources.lock.json', 'transformers.mjs',
].sort());
assert.equal(existsSync('/app/bizanso'), false, 'Public runtime must not contain application source');
const library = JSON.parse(readFileSync(new URL('./node_modules/@huggingface/transformers/package.json', import.meta.url)));
assert.equal(library.version, inputs.transformersVersion);
const tools = {};
for (const [tool, args] of [['pdftotext', ['-v']], ['antiword', ['-h']], ['libreoffice', ['--version']]]) {
    const result = spawnSync(tool, args, { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    tools[tool] = `${result.stdout}${result.stderr}`.trim();
    assert.ok(tools[tool].length > 0);
}
const db = new DatabaseSync(':memory:');
try { assert.equal(db.prepare('SELECT 42 AS value').get().value, 42); }
finally { db.close(); }
const extractor = await loadModel({ offline: true });
let similarity;
try {
    const vectors = [];
    for (const text of ['query: Secure software development.', 'query: Dezvoltare software sigură.']) {
        const result = await extractor(text, { pooling: 'mean', normalize: true });
        assert.equal(result.data.length, inputs.model.dimensions);
        assert.ok(Array.from(result.data).every(Number.isFinite));
        const norm = Math.hypot(...result.data);
        assert.ok(Math.abs(norm - 1) < 0.001);
        vectors.push(result.data);
    }
    similarity = vectors[0].reduce((total, value, index) => total + value * vectors[1][index], 0);
    assert.ok(similarity > 0.7, 'Multilingual inference must produce compatible vectors');
} finally { await extractor.dispose(); }
console.log(JSON.stringify({
    schema: 'assistos.bizanso-runtime-proof/v1', ok: true, architecture: process.arch,
    uid: process.getuid(), gid: process.getgid(), offline: true, noApplicationSource: true,
    capabilities: '0000000000000000', noNewPrivileges: true, networkInterfaces: Object.keys(os.networkInterfaces()),
    model: inputs.model, transformersVersion: inputs.transformersVersion, similarity, tools,
}));
