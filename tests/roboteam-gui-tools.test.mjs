import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeMcp } from '../images/roboteam-agent/smoke-mcp.mjs';

const root = fileURLToPath(new URL('../images/roboteam-agent/', import.meta.url));
const read = (name) => readFileSync(path.join(root, name));
const lock = JSON.parse(read('sources.lock.json'));

test('GUI package closures have exact direct versions, integrity and sealed lockfiles', () => {
    for (const mode of ['browser', 'desktop']) {
        const selection = lock.guiTools[mode];
        for (const [name, digest] of Object.entries(selection.files)) {
            assert.equal(createHash('sha256').update(read(`${mode}-tools/${name}`)).digest('hex'), digest);
        }
        const manifest = JSON.parse(read(`${mode}-tools/package.json`));
        const packages = JSON.parse(read(`${mode}-tools/package-lock.json`)).packages;
        assert.deepEqual(manifest.dependencies, { [selection.package]: selection.version });
        assert.equal(packages[`node_modules/${selection.package}`].version, selection.version);
        for (const [name, entry] of Object.entries(packages)) {
            if (!name) continue;
            assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, name);
            assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, name);
        }
    }
});

test('desktop release has both native GNU Linux assets and retained upstream license', () => {
    const release = lock.guiTools.computerUseLinux;
    assert.deepEqual(Object.keys(release.platforms).sort(), ['linux/amd64', 'linux/arm64']);
    for (const [platform, asset] of Object.entries(release.platforms)) {
        assert.ok(asset.url.includes(`/v${release.version}/`));
        assert.ok(asset.url.endsWith(`${platform.endsWith('amd64') ? 'x86_64' : 'aarch64'}-unknown-linux-gnu`));
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        assert.ok(asset.size > 0);
    }
    assert.equal(createHash('sha256').update(read('desktop-tools/computer-use-linux.LICENSE')).digest('hex'), release.license.sha256);
});

test('build preparation accepts sealed browser inputs and rejects changed locks before install', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'roboteam-gui-tools-'));
    try {
        for (const name of ['prepare-gui-tools.mjs', 'sources.lock.json']) copyFileSync(path.join(root, name), path.join(temporary, name));
        for (const name of ['package.json', 'package-lock.json']) copyFileSync(path.join(root, 'browser-tools', name), path.join(temporary, name));
        const run = () => spawnSync(process.execPath, [path.join(temporary, 'prepare-gui-tools.mjs'), 'browser'], { cwd: tmpdir(), encoding: 'utf8' });
        assert.equal(run().status, 0);
        writeFileSync(path.join(temporary, 'package-lock.json'), '{}');
        const changed = run();
        assert.notEqual(changed.status, 0);
        assert.match(changed.stderr, /package-lock.json hash differs/);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('offline smoke fails when installed payload is absent', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'roboteam-gui-smoke-'));
    try {
        for (const name of ['smoke-gui-tools.mjs', 'smoke-mcp.mjs', 'sources.lock.json']) copyFileSync(path.join(root, name), path.join(temporary, name));
        for (const name of ['package.json', 'package-lock.json']) copyFileSync(path.join(root, 'browser-tools', name), path.join(temporary, name));
        const result = spawnSync(process.execPath, [path.join(temporary, 'smoke-gui-tools.mjs'), 'browser'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ENOENT/);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('MCP probe completes initialize and tools/list without invoking desktop tools', async () => {
    const fixture = `
        const readline = require('node:readline');
        const input = readline.createInterface({ input: process.stdin });
        input.on('line', line => {
            const frame = JSON.parse(line);
            if (frame.method === 'notifications/initialized') return;
            if (!['initialize', 'tools/list'].includes(frame.method)) process.exit(9);
            const result = frame.id === 1
                ? { protocolVersion: '2025-06-18', serverInfo: { name: 'computer-use-linux', version: '0.7.31' } }
                : { tools: [{ name: 'get_app_state' }] };
            console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
        });`;
    await smokeMcp(process.execPath, ['-e', fixture], '0.7.31');
    await assert.rejects(smokeMcp(process.execPath, ['-e', fixture], '0.0.0'), /0.7.31/);
    await assert.rejects(smokeMcp(process.execPath, ['-e', fixture.replace("[{ name: 'get_app_state' }]", '[]')], '0.7.31'), /Empty MCP tool catalog/);
    await assert.rejects(smokeMcp(process.execPath, ['-e', 'process.exit(0)'], '0.7.31'), /before successful completion/);
    await assert.rejects(smokeMcp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '0.7.31', 200), /timed out/);
});
