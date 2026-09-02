import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_PATH = '/base-agent-additional-server/umamiAgent/3000';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = filename => hash(fs.readFileSync(filename));
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const safeDiagnostic = value => String(value).slice(-16384)
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');

export function verifyBuildMetadata(app, lock) {
    const metadata = readJson(path.join(app, 'ploinky-umami-build.json'));
    const required = path.join(app, '.next/required-server-files.json');
    const config = readJson(required).config;
    assert.equal(metadata.schema, 'ploinky.umami-build/v1');
    assert.equal(metadata.version, '3.2.0');
    assert.equal(metadata.sourceCommit, lock.umami.commit);
    assert.equal(metadata.sourceArchiveSha256, lock.umami.sourceArchive.sha256);
    assert.equal(metadata.basePath, BASE_PATH);
    assert.equal(metadata.runtimeBaseImage, lock.runtimeBase.image);
    assert.equal(metadata.pnpmVersion, lock.umami.pnpm.version);
    assert.equal(metadata.pnpmLockSha256, lock.umami.sourceFiles['pnpm-lock.yaml']);
    assert.equal(metadata.pnpmLockSha256, sha(path.join(app, 'pnpm-lock.yaml')));
    assert.equal(metadata.requiredServerFilesSha256, sha(required));
    assert.equal(metadata.standaloneServerSha256, sha(path.join(app, 'server.js')));
    assert.equal(metadata.trackerSha256, sha(path.join(app, 'public/script.js')));
    assert.equal(metadata.geoDatabaseSha256, sha(path.join(app, 'geo/GeoLite2-City.mmdb')));
    assert.equal(config.basePath, BASE_PATH);
    assert.equal(config.assetPrefix, BASE_PATH);
    assert.equal(config.env.basePath, BASE_PATH);
    assert.equal(config.output, 'standalone');
    return metadata;
}

export function pageAssets(html, origin) {
    const assets = new Map();
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
        const value = match[1].replaceAll('&amp;', '&');
        if (!value.includes('/_next/')) continue;
        const url = new URL(value, origin);
        assert.equal(url.origin, origin, 'Next assets must stay on the published origin');
        assert.ok(url.pathname.startsWith(BASE_PATH + '/_next/'), `asset escaped the compiled base path: ${url.pathname}`);
        const kind = url.pathname.endsWith('.css') ? 'css' : url.pathname.endsWith('.js') ? 'script' : /\.woff2?$/.test(url.pathname) ? 'font' : null;
        assert.ok(kind, `unrecognized Next asset type: ${url.pathname}`);
        assets.set(url.href, kind);
    }
    assert.ok([...assets.values()].includes('script'), 'login HTML has no Next script');
    assert.ok([...assets.values()].includes('css'), 'login HTML has no Next stylesheet');
    return assets;
}

export function verifyLoopbackListener(procText, port) {
    const hexadecimalPort = port.toString(16).toUpperCase().padStart(4, '0');
    const listeners = procText.split('\n').slice(1).map(line => line.trim().split(/\s+/))
        .filter(fields => fields[3] === '0A' && fields[1]?.endsWith(':' + hexadecimalPort));
    assert.equal(listeners.length, 1, 'expected exactly one Next TCP listener');
    assert.equal(listeners[0][1], '0100007F:' + hexadecimalPort, 'Next must bind only IPv4 loopback');
}

function command(file, args, options = {}) {
    try { return execFileSync(file, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
    catch (error) {
        const output = String(error.stdout || '') + String(error.stderr || '');
        const failure = new Error(`${file} failed (${error.status ?? error.code}); output SHA256 ${hash(output)}`);
        failure.commandOutput = safeDiagnostic(output);
        throw failure;
    }
}

function startDatabase(home, env) {
    const directory = path.join(home, 'postgres');
    const stop = () => command('pg_ctl', ['-D', directory, '-m', 'immediate', '-w', 'stop'], { timeout: 15000 });
    let started = false;
    try {
        command('initdb', ['-D', directory, '-U', 'smoke', '--auth=trust', '--no-locale', '--encoding=UTF8']);
        command('pg_ctl', ['-D', directory, '-l', path.join(home, 'postgres.log'), '-o', `-h 127.0.0.1 -p 54329 -k ${home}`, '-w', 'start']);
        started = true;
        command('createdb', ['-h', '127.0.0.1', '-p', '54329', '-U', 'smoke', 'umami']);
        command(process.execPath, ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'run', 'check-db'], { cwd: '/app', env });
        command(process.execPath, ['scripts/update-tracker.js'], { cwd: '/app', env });
        return stop;
    } catch (error) {
        if (started) stop();
        fs.rmSync(home, { recursive: true, force: true });
        throw error;
    }
}

async function main() {
    assert.equal(process.getuid(), 1000, 'image smoke must use the agent UID');
    const procStatus = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(procStatus, /^CapEff:\s+0+$/m, 'image smoke must have no effective capabilities');
    assert.match(procStatus, /^NoNewPrivs:\s+1$/m, 'image smoke must prohibit privilege elevation');
    const app = '/app';
    const lock = readJson('/usr/local/share/ploinky/umami-agent-sources.json');
    const metadata = verifyBuildMetadata(app, lock);
    assert.equal(process.versions.node, lock.runtimeBase.nodeVersion);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-image-smoke-'));
    const port = 3001;
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HOME: home, HOSTNAME: '127.0.0.1', PORT: String(port),
        NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BASE_PATH,
        DATABASE_URL: 'postgresql://smoke:smoke@127.0.0.1:54329/umami',
        APP_SECRET: 'image-smoke-has-no-external-authority' };
    const stopDatabase = startDatabase(home, env);
    const child = spawn(process.execPath, [path.join(app, 'server.js')], {
        cwd: app, env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-32768); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-32768); });
    let closed = false;
    const done = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
    let spawnError;
    child.once('error', error => { spawnError = error; });
    try {
        let response;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            assert.equal(closed, false, `Next exited before readiness; output SHA256 ${hash(output)}`);
            try {
                response = await fetch(origin + BASE_PATH + '/login', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
                if (response.status === 200) break;
                await response.arrayBuffer();
            } catch { /* Startup may precede the first listen call. */ }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(response?.status, 200, 'prefixed login did not become ready');
        assert.match(response.headers.get('content-type') || '', /text\/html/);
        const html = await response.text();
        const assets = pageAssets(html, origin);
        const observed = [];
        for (const [url, kind] of assets) {
            const asset = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
            assert.equal(asset.status, 200, `prefixed ${kind} asset returned ${asset.status}`);
            assert.match(asset.headers.get('content-type') || '', kind === 'css' ? /text\/css/ : kind === 'font' ? /(?:font\/|application\/(?:font|octet-stream))/ : /(?:java|ecma)script/);
            const body = Buffer.from(await asset.arrayBuffer());
            assert.ok(body.length > 0, 'empty Next asset');
            observed.push({ path: new URL(url).pathname, kind, bytes: body.length, sha256: hash(body) });
        }
        const heartbeat = await fetch(origin + BASE_PATH + '/api/heartbeat', { signal: AbortSignal.timeout(10000) });
        assert.equal(heartbeat.status, 200);
        assert.deepEqual(await heartbeat.json(), { ok: true });
        const login = await fetch(origin + BASE_PATH + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'umami' }), signal: AbortSignal.timeout(15000) });
        assert.equal(login.status, 200, 'fresh database admin login');
        const authentication = await login.json();
        assert.equal(typeof authentication.token, 'string');
        assert.ok(authentication.token.length > 20);
        assert.equal(authentication.user.username, 'admin');
        const verify = await fetch(origin + BASE_PATH + '/api/auth/verify', { method: 'POST',
            headers: { authorization: `Bearer ${authentication.token}` }, signal: AbortSignal.timeout(15000) });
        assert.equal(verify.status, 200, 'authenticated API verification');
        assert.equal((await verify.json()).username, 'admin');
        const tracker = await fetch(origin + BASE_PATH + '/script.js', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        assert.equal(tracker.status, 200, 'prefixed tracker script');
        assert.equal(hash(Buffer.from(await tracker.arrayBuffer())), metadata.trackerSha256);
        const actualAsset = new URL([...assets.keys()][0]);
        const bare = await fetch(origin + actualAsset.pathname.slice(BASE_PATH.length) + actualAsset.search, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        assert.equal(bare.status, 404, 'the actual emitted Next asset must be unavailable without the compiled prefix');
        await bare.arrayBuffer();
        verifyLoopbackListener(fs.readFileSync('/proc/net/tcp', 'utf8'), port);
        assert.ok(!fs.readFileSync('/proc/net/tcp6', 'utf8').split('\n').map(line => line.trim().split(/\s+/)).some(fields => fields[3] === '0A' && fields[1]?.endsWith(':0BB9')),
            'Next must not expose an additional IPv6 listener');
        assert.equal(closed, false, 'Next stopped during asset verification');
        console.log(JSON.stringify({ schema: 'ploinky.umami-image-smoke/v1', passed: true, uid: process.getuid(),
            capabilityEffective: '0', noNewPrivileges: true, listener: '127.0.0.1:3001',
            metadata, loginHttp: 200, databaseMigration: true, heartbeatHttp: 200, authLoginHttp: 200, authVerifyHttp: 200, trackerHttp: 200, unprefixedNextHttp: 404, assets: observed }));
    } catch (error) {
        error.serverOutput = safeDiagnostic(output);
        throw error;
    } finally {
        if (!closed) child.kill('SIGTERM');
        const timeout = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 5000);
        timeout.unref();
        await done;
        clearTimeout(timeout);
        stopDatabase();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ schema: 'ploinky.umami-image-smoke-failure/v1', passed: false,
            error: safeDiagnostic(error.message), commandOutput: error.commandOutput, serverOutput: error.serverOutput }));
        process.exitCode = 1;
    });
}
