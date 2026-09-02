import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Run in a fresh candidate container with networking disabled. Chromium uses
// the existing SearchAgent launch policy; the container supplies confinement.
const require = createRequire('/opt/search-agent/package.json');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'search-runtime-'));
const python = '/opt/search-agent/searx-pyenv/bin/python';
let searxng;
let searxngDiagnostics = '';
let browser;
let fixture;
try {
    assert.equal(process.getuid(), 1000, 'Search runtime must use UID 1000');
    assert.equal(process.getgid(), 1000, 'Search runtime must use GID 1000');
    const status = await fs.readFile('/proc/self/status', 'utf8');
    assert.match(status, /^CapEff:\s*0000000000000000$/m);
    assert.match(status, /^NoNewPrivs:\s*1$/m);
    const interfaces = Object.keys(os.networkInterfaces());
    assert.deepEqual(interfaces, ['lo'], 'Runtime proof requires network isolation');
    const imports = JSON.parse(execFileSync(python, ['-c', [
        'import json, platform, searx, flask, httpx',
        'print(json.dumps({"version": platform.python_version(), "searxFile": searx.__file__, "flask": flask.__name__, "httpx": httpx.__name__}))',
    ].join('; ')], { encoding: 'utf8' }));
    assert.ok(imports.searxFile.startsWith('/opt/search-agent/searxng-src/searx/'));
    const packageVersion = require('puppeteer-core/package.json').version;
    assert.equal(packageVersion, '25.9.0');

    const settingsPath = path.join(directory, 'settings.yml');
    await fs.writeFile(settingsPath, 'use_default_settings: true\nsearch:\n  formats: [html, json]\nserver:\n  bind_address: "127.0.0.1"\n  port: 8888\n  limiter: false\n  secret_key: "isolated-runtime-proof-only"\n', { mode: 0o600 });
    searxng = spawn(python, ['-m', 'searx.webapp'], {
        cwd: '/opt/search-agent/searxng-src',
        env: { ...process.env, SEARXNG_SETTINGS_PATH: settingsPath },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    searxng.stderr.on('data', (chunk) => {
        searxngDiagnostics = (searxngDiagnostics + chunk.toString()).slice(-16_384);
    });
    let launchError;
    searxng.on('error', (error) => { launchError = error; });
    let health;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        assert.equal(Boolean(launchError), false, 'SearXNG could not start');
        assert.equal(searxng.exitCode, null, 'SearXNG exited before readiness');
        assert.equal(searxng.signalCode, null, 'SearXNG was terminated before readiness');
        try {
            health = await fetch('http://127.0.0.1:8888/healthz', { signal: AbortSignal.timeout(1000) });
            await health.arrayBuffer();
            if (health.status === 200) break;
        } catch { /* Wait only for the new local process to become ready. */ }
        await delay(100);
    }
    assert.equal(health?.status, 200, 'SearXNG readiness failed');
    const index = await fetch('http://127.0.0.1:8888/', { signal: AbortSignal.timeout(5000) });
    assert.equal(index.status, 200, 'SearXNG index failed');
    assert.match(await index.text(), /<form\b/);
    const config = await fetch('http://127.0.0.1:8888/config', { signal: AbortSignal.timeout(5000) });
    assert.equal(config.status, 200, 'SearXNG JSON configuration failed');
    assert.ok(Array.isArray((await config.json()).engines));
    const invalidSearch = await fetch('http://127.0.0.1:8888/search?format=json', { signal: AbortSignal.timeout(5000) });
    assert.equal(invalidSearch.status, 400, 'SearXNG must reject an empty search');
    assert.deepEqual(await invalidSearch.json(), { error: 'No query' });

    fixture = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Search runtime</title><main id="proof">pending</main><script>document.querySelector("#proof").textContent = String(6 * 7)</script>');
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage',
            '--disable-setuid-sandbox', '--no-sandbox', '--no-first-run', '--no-default-browser-check'],
    });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', () => browserErrors.push('pageerror'));
    page.on('requestfailed', () => browserErrors.push('requestfailed'));
    const navigation = await page.goto(`http://127.0.0.1:${fixture.address().port}/`, { waitUntil: 'load', timeout: 10_000 });
    assert.equal(navigation.status(), 200);
    assert.equal(await page.title(), 'Search runtime');
    assert.equal(await page.$eval('#proof', (node) => node.textContent), '42');
    assert.deepEqual(browserErrors, []);
    const chromiumVersion = await browser.version();
    await browser.close();
    browser = undefined;
    process.stdout.write(`${JSON.stringify({
        schema: 'ploinky.search-runtime/v1', ok: true, uid: process.getuid(), gid: process.getgid(),
        noNewPrivileges: true, capabilities: '0000000000000000', networkInterfaces: interfaces,
        nodeVersion: process.version, python: imports, puppeteerVersion: packageVersion,
        chromiumVersion, searxng: { healthStatus: health.status, indexStatus: index.status,
            configurationStatus: config.status, invalidSearchStatus: invalidSearch.status },
        browser: { documentStatus: navigation.status(), javascriptResult: '42', errors: browserErrors },
    }, null, 2)}\n`);
} catch (error) {
    // Only this isolated fixture process runs here; deployment credentials are
    // never supplied to the candidate container. Preserve bounded diagnostics.
    if (searxngDiagnostics) process.stderr.write(`SearXNG fixture stderr (bounded tail):\n${searxngDiagnostics}\n`);
    throw error;
} finally {
    if (browser) await browser.close();
    if (fixture) {
        fixture.closeAllConnections();
        await new Promise((resolve) => fixture.close(resolve));
    }
    if (searxng && searxng.exitCode === null && searxng.signalCode === null && searxng.pid) {
        const exited = once(searxng, 'exit');
        searxng.kill('SIGTERM');
        const force = setTimeout(() => searxng.kill('SIGKILL'), 3000);
        await exited;
        clearTimeout(force);
    }
    await fs.rm(directory, { recursive: true, force: true });
}
