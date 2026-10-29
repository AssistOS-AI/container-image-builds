// Run in the image with --network=none and without mounted tool generations.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { smokeMcp } from './smoke-mcp.mjs';

const root = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, root));
const lock = JSON.parse(read('sources.lock.json'));
const mode = process.argv[2];
assert.ok(['browser', 'desktop'].includes(mode), 'Expected browser or desktop');
const selection = lock.guiTools[mode];
for (const [name, digest] of Object.entries(selection.files)) {
    assert.equal(createHash('sha256').update(read(name)).digest('hex'), digest, `${name} hash differs`);
}
const packageLock = JSON.parse(read('package-lock.json'));
for (const [location, expected] of Object.entries(packageLock.packages)) {
    if (!location || expected.optional) continue;
    const installed = JSON.parse(read(`${location}/package.json`));
    assert.equal(installed.version, expected.version, `${location} version differs`);
}
function run(relative, args) {
    const result = spawnSync(fileURLToPath(new URL(relative, root)), args, { encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
    return result.stdout + result.stderr;
}
if (mode === 'browser') {
    assert.match(run('node_modules/.bin/playwright-mcp', ['--version']), new RegExp(`\\b${selection.version.replaceAll('.', '\\.')}\\b`));
    const help = run('node_modules/.bin/playwright-mcp', ['--help']);
    for (const flag of ['--cdp-endpoint', '--allowed-hosts', '--port', '--host']) assert.ok(help.includes(flag), flag);
} else {
    const release = lock.guiTools.computerUseLinux;
    const asset = release.platforms[`linux/${process.arch === 'x64' ? 'amd64' : process.arch}`];
    assert.ok(asset, 'Unsupported architecture');
    assert.equal(createHash('sha256').update(read('computer-use-linux')).digest('hex'), asset.sha256);
    await smokeMcp(fileURLToPath(new URL('computer-use-linux', root)), ['mcp'], release.version);
    const help = run('node_modules/.bin/supergateway', ['--help']);
    for (const flag of ['--stdio', '--outputTransport', '--stateful', '--sessionTimeout', '--streamableHttpPath', '--healthEndpoint']) assert.ok(help.includes(flag), flag);
}
console.log(`Offline ${mode} payload smoke passed on ${process.platform}/${process.arch}`);
