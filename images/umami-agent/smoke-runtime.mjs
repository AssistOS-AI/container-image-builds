import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_PATH = '/base-agent-additional-server/umamiAgent/3000';
export const METADATA_ASSETS = {
    'favicon.ico': { kind: 'ico', source: 'head' },
    'apple-touch-icon.png': { kind: 'png', source: 'head' },
    'favicon-32x32.png': { kind: 'png', source: 'head' },
    'favicon-16x16.png': { kind: 'png', source: 'head' },
    'site.webmanifest': { kind: 'manifest', source: 'head' },
    'safari-pinned-tab.svg': { kind: 'svg', source: 'head' },
    'browserconfig.xml': { kind: 'xml', source: 'head' },
    'android-chrome-192x192.png': { kind: 'png', source: 'manifest' },
    'android-chrome-512x512.png': { kind: 'png', source: 'manifest' },
    'mstile-150x150.png': { kind: 'png', source: 'browserconfig' },
};
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
    assert.equal(lock.schemaVersion, 3);
    assert.equal(metadata.schema, 'ploinky.umami-build/v1');
    assert.equal(metadata.version, '3.4.1');
    assert.equal(metadata.version, lock.umami.version);
    assert.equal(metadata.sourceCommit, lock.umami.commit);
    assert.equal(metadata.sourceArchiveSha256, lock.umami.sourceArchive.sha256);
    assert.deepEqual(metadata.sourcePatches, lock.umami.sourcePatches);
    const patchReceipt = path.join(app, 'ploinky-umami-source-patches.json');
    assert.equal(metadata.sourcePatchReceiptSha256, sha(patchReceipt));
    assert.deepEqual(readJson(patchReceipt), {
        upstreamSourceCommit: lock.umami.commit,
        upstreamSourceArchiveSha256: lock.umami.sourceArchive.sha256,
        sourcePatches: lock.umami.sourcePatches,
    });
    assert.equal(metadata.basePath, BASE_PATH);
    assert.deepEqual(metadata.baseImages, { node: lock.bases.node.image, postgres: lock.bases.postgres.image, geo: lock.bases.upstreamUmami.image });
    assert.equal(metadata.alpineRelease, lock.bases.node.alpineRelease);
    assert.equal(metadata.pnpmVersion, lock.umami.pnpm.version);
    assert.equal(metadata.pnpmLockSha256, lock.umami.sourceFiles['pnpm-lock.yaml']);
    assert.equal(metadata.pnpmLockSha256, sha(path.join(app, 'pnpm-lock.yaml')));
    assert.equal(metadata.prisma.version, lock.umami.prisma.version);
    assert.equal(metadata.prisma.enginesVersion, lock.umami.prisma.enginesVersion);
    assert.match(metadata.prisma.schemaEngine.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.values(lock.umami.prisma.platforms).some(platform => platform.sha256 === metadata.prisma.schemaEngine.sha256), 'schema engine must be a pinned binary');
    const engines = path.join(app, 'node_modules/.pnpm', lock.umami.prisma.enginesPackage.replace('/', '+'), 'node_modules', lock.umami.prisma.enginesPackage.replace(/@[^@]+$/, ''));
    const installedEngines = fs.readdirSync(engines).filter(name => name.startsWith(lock.umami.prisma.binary));
    assert.equal(installedEngines.length, 1, 'exactly one schema engine is installed');
    assert.equal(sha(path.join(engines, installedEngines[0])), metadata.prisma.schemaEngine.sha256, 'installed schema engine bytes');
    assert.equal(metadata.requiredServerFilesSha256, sha(required));
    assert.equal(metadata.standaloneServerSha256, sha(path.join(app, 'server.js')));
    assert.equal(metadata.trackerSha256, sha(path.join(app, 'public/script.js')));
    assert.equal(metadata.geoDatabaseSha256, sha(path.join(app, 'geo/GeoLite2-City.mmdb')));
    assert.equal(metadata.geoDatabaseSha256, lock.umami.geo.sha256);
    assert.equal(config.basePath, BASE_PATH);
    assert.equal(config.assetPrefix, BASE_PATH);
    assert.equal(config.env.basePath, BASE_PATH);
    assert.equal(config.output, 'standalone');
    for (const name of Object.keys(METADATA_ASSETS)) {
        assert.equal(sha(path.join(app, 'public', name)), metadataAssetHash(lock, name), 'runtime metadata asset bytes');
    }
    return metadata;
}

export function metadataAssetHash(lock, name) {
    assert.ok(Object.hasOwn(METADATA_ASSETS, name), 'unknown metadata asset');
    const target = 'public/' + name;
    const patch = lock.umami.sourcePatches.flatMap(value => value.targets || [value]).find(value => value.target === target);
    const expected = patch?.patchedSha256 || lock.umami.sourceFiles[target];
    assert.match(expected, /^[a-f0-9]{64}$/);
    return expected;
}

function metadataResource(value, documentUrl, source) {
    const url = new URL(value, documentUrl);
    const origin = new URL(documentUrl).origin;
    const entry = Object.entries(METADATA_ASSETS).find(([name, definition]) => definition.source === source
        && url.href === origin + BASE_PATH + '/' + name);
    assert.ok(entry, 'metadata resource escaped its exact published path');
    return { url: url.href, name: entry[0], ...entry[1] };
}

export function metadataHeadAssets(html, origin) {
    const found = new Map();
    for (const [tag] of html.matchAll(/<(?:link|meta)\b[^>]*>/g)) {
        const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)]
            .map(match => [match[1], match[2].replaceAll('&amp;', '&')]));
        const isLink = tag.startsWith('<link') && /(?:^|\s)(?:icon|apple-touch-icon|mask-icon|manifest)(?:\s|$)/.test(attributes.rel || '');
        const isConfig = tag.startsWith('<meta') && attributes.name === 'msapplication-config';
        if (!isLink && !isConfig) continue;
        const entry = metadataResource(isLink ? attributes.href : attributes.content, origin, 'head');
        assert.ok(!found.has(entry.name), 'duplicate metadata declaration');
        found.set(entry.name, entry);
    }
    assert.deepEqual([...found.keys()].sort(), Object.keys(METADATA_ASSETS).filter(name => METADATA_ASSETS[name].source === 'head').sort(),
        'HTML must declare every published icon, manifest, and browser configuration');
    return [...found.values()];
}

export function nestedMetadataAssets(body, resource) {
    let source;
    let values;
    if (resource.kind === 'manifest') {
        const manifest = JSON.parse(body.toString('utf8'));
        assert.ok(Array.isArray(manifest.icons), 'manifest must declare icons');
        assert.ok(manifest.icons.every(icon => icon.type === 'image/png'), 'manifest icon media types');
        source = 'manifest'; values = manifest.icons.map(icon => icon.src);
    } else if (resource.kind === 'xml') {
        source = 'browserconfig';
        values = [...body.toString('utf8').matchAll(/<square150x150logo\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    } else return [];
    const resources = values.map(value => metadataResource(value, resource.url, source));
    assert.deepEqual(resources.map(value => value.name).sort(), Object.keys(METADATA_ASSETS).filter(name => METADATA_ASSETS[name].source === source).sort(),
        'nested metadata must declare exactly the published icons or tile');
    return resources;
}

export function verifyMetadataContentType(kind, contentType) {
    const types = { ico: /^image\/(?:x-icon|vnd\.microsoft\.icon)$/i, png: /^image\/png$/i, svg: /^image\/svg\+xml$/i,
        manifest: /^application\/(?:manifest\+json|json)$/i, xml: /^(?:application|text)\/xml$/i };
    assert.ok(types[kind]?.test(contentType.split(';')[0].trim()), 'metadata asset returned the wrong media type');
}

export function verifyMetadataContent(kind, contentType, body) {
    verifyMetadataContentType(kind, contentType);
    assert.ok(body.length > 0, 'empty metadata asset');
    if (kind === 'png') assert.ok(body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'invalid PNG asset');
    if (kind === 'ico') assert.ok(body.subarray(0, 4).equals(Buffer.from('00000100', 'hex')), 'invalid icon asset');
    if (kind === 'svg') assert.match(body.toString('utf8'), /<svg[\s>]/, 'invalid SVG asset');
    if (kind === 'xml') assert.match(body.toString('utf8'), /<browserconfig[\s>]/, 'invalid browser configuration');
    if (kind === 'manifest') assert.equal(typeof JSON.parse(body.toString('utf8')), 'object');
}

export async function fetchMetadataAssets(html, origin, lock) {
    const pending = metadataHeadAssets(html, origin);
    const observed = [];
    for (const resource of pending) {
        const response = await fetch(resource.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200, 'published metadata asset must load');
        const body = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || '';
        verifyMetadataContent(resource.kind, contentType, body);
        assert.equal(hash(body), metadataAssetHash(lock, resource.name), 'HTTP metadata bytes must match the pinned source or recorded patch');
        pending.push(...nestedMetadataAssets(body, resource));
        const unprefixed = await fetch(origin + '/' + resource.name, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        assert.equal(unprefixed.status, 404, 'metadata assets must be unavailable outside the compiled prefix');
        await unprefixed.arrayBuffer();
        observed.push({ path: new URL(resource.url).pathname, kind: resource.kind, source: resource.source,
            status: 200, contentType, bytes: body.length, sha256: hash(body), unprefixedHttp: 404 });
    }
    assert.equal(observed.length, Object.keys(METADATA_ASSETS).length);
    return observed;
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

export const MCP_TOOLS = ['list_websites', 'get_website_daterange', 'get_website_stats', 'get_website_traffic', 'get_website_metrics', 'get_realtime',
    'get_events', 'get_event_stats', 'get_event_series', 'get_event_properties', 'get_sessions', 'get_session_stats', 'get_session',
    'get_annotations', 'list_segments', 'list_funnels', 'run_funnel', 'get_goals', 'run_journey', 'run_retention', 'run_attribution',
    'get_revenue', 'get_performance'];
export const ADMIN_USER_ID = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
const DATABASE_PORT = 54329;
const NPM_CLI = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Umami stores an API key as the unsalted SHA-512 hex digest of the whole key and displays its first 14 characters.
export function apiKeyRow(key) {
    assert.match(key, /^umami_[0-9a-f]{32}$/);
    return { hash: crypto.createHash('sha512').update(key).digest('hex'), prefix: key.slice(0, 14) };
}

export function parseMcpBody(contentType, text, id) {
    const messages = [];
    if (/text\/event-stream/i.test(contentType)) {
        for (const event of text.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) messages.push(JSON.parse(data));
        }
    } else if (text.trim()) {
        const parsed = JSON.parse(text);
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return messages.find(message => message.id === id);
}

export function verifyMcpTools(tools) {
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length, 'duplicate MCP tool');
    assert.equal(names.length, 23, 'the built-in MCP exposes 23 tools');
    assert.deepEqual([...names].sort(), [...MCP_TOOLS].sort(), 'the built-in MCP tool names');
    return names.length;
}

export function parseControlData(text) {
    const field = name => {
        const match = text.match(new RegExp(`^${name}:\\s+(.+)$`, 'm'));
        assert.ok(match, `pg_controldata did not report "${name}"`);
        return match[1].trim();
    };
    return { controlVersion: field('pg_control version number'), catalogVersion: field('Catalog version number'), state: field('Database cluster state') };
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

const psql = sql => command('psql', ['-h', '127.0.0.1', '-p', String(DATABASE_PORT), '-U', 'smoke', '-d', 'umami', '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-At', '-c', sql]).trim();
const npmRun = (script, cwd, env) => command(process.execPath, [NPM_CLI, 'run', script], { cwd, env });
const startPostgres = (directory, sockets, log) => command('pg_ctl', ['-D', directory, '-l', log, '-o', `-h 127.0.0.1 -p ${DATABASE_PORT} -k ${sockets}`, '-w', 'start']);
const stopPostgres = (directory, mode = 'fast') => command('pg_ctl', ['-D', directory, '-m', mode, '-w', 'stop'], { timeout: 30000 });

function startDatabase(home, env) {
    const directory = path.join(home, 'postgres');
    let started = false;
    try {
        command('initdb', ['-D', directory, '-U', 'smoke', '--auth=trust', '--no-locale', '--encoding=UTF8']);
        startPostgres(directory, home, path.join(home, 'postgres.log'));
        started = true;
        command('createdb', ['-h', '127.0.0.1', '-p', String(DATABASE_PORT), '-U', 'smoke', 'umami']);
        npmRun('check:db', '/app', env);
        command(process.execPath, ['scripts/update-tracker.js'], { cwd: '/app', env });
        return () => stopPostgres(directory, 'immediate');
    } catch (error) {
        if (started) stopPostgres(directory, 'immediate');
        fs.rmSync(home, { recursive: true, force: true });
        throw error;
    }
}

function verifyRuntimeStack(lock) {
    assert.equal(process.versions.node, lock.bases.node.nodeVersion);
    assert.equal(fs.readFileSync('/etc/alpine-release', 'utf8').trim(), lock.bases.node.alpineRelease);
    assert.equal(lock.bases.node.alpineRelease, lock.bases.postgres.alpineRelease, 'both bases come from one Alpine release');
    const version = command('postgres', ['--version']).match(/\(PostgreSQL\) (\d+\.\d+)/)?.[1];
    assert.equal(version, lock.bases.postgres.postgresVersion);
    assert.equal(Number(version.split('.')[0]), lock.bases.postgres.postgresMajor);
    for (const missing of ['/opt/bun', '/opt/umami-mcp']) assert.ok(!fs.existsSync(missing), `${missing} must not exist`);
    fs.accessSync('/usr/local/bin/su-exec', fs.constants.X_OK);
    return version;
}

async function http(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(origin + pathname, { method, redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

export async function mcpCall(origin, key, body, headers = {}) {
    const response = await http(origin, BASE_PATH + '/mcp', { method: 'POST', body,
        headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', ...headers } });
    return { ...response, message: response.status === 200 && 'id' in body ? parseMcpBody(response.headers.get('content-type') || '', response.text, body.id) : undefined };
}

async function mcpListTools(origin, key, headers) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
        const response = await mcpCall(origin, key, { jsonrpc: '2.0', id: 10 + page, method: 'tools/list', params: cursor ? { cursor } : {} }, headers);
        assert.equal(response.status, 200, `MCP tools/list returned ${response.status}: ${safeDiagnostic(response.text).slice(0, 300)}`);
        assert.ok(response.message?.result, `MCP tools/list returned no result: ${safeDiagnostic(response.text).slice(0, 300)}`);
        tools.push(...response.message.result.tools);
        cursor = response.message.result.nextCursor;
        if (!cursor) return tools;
    }
    assert.fail('MCP tools/list did not finish within five pages');
}

// The built-in MCP is a stateless Streamable HTTP endpoint. Try the initialize handshake first, then a direct request.
export async function mcpSession(origin, key) {
    const initialized = await mcpCall(origin, key, { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ploinky-image-smoke', version: '1' } } });
    const attempts = [];
    if (initialized.message?.result?.protocolVersion) {
        const headers = { 'mcp-protocol-version': initialized.message.result.protocolVersion };
        const sessionId = initialized.headers.get('mcp-session-id');
        if (sessionId) headers['mcp-session-id'] = sessionId;
        await mcpCall(origin, key, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
        attempts.push(['initialize', headers]);
    }
    attempts.push(['direct', {}]);
    let failure;
    for (const [handshake, headers] of attempts) {
        try { return { handshake, headers, tools: await mcpListTools(origin, key, headers) }; } catch (error) { failure ??= error; }
    }
    throw failure;
}

async function verifyRuntime() {
    assert.equal(process.getuid(), 1000, 'image smoke must use the agent UID');
    const procStatus = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(procStatus, /^CapEff:\s+0+$/m, 'image smoke must have no effective capabilities');
    assert.match(procStatus, /^NoNewPrivs:\s+1$/m, 'image smoke must prohibit privilege elevation');
    const app = '/app';
    const lock = readJson('/usr/local/share/ploinky/umami-agent-sources.json');
    const metadata = verifyBuildMetadata(app, lock);
    const postgresVersion = verifyRuntimeStack(lock);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-image-smoke-'));
    const port = 3001;
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HOME: home, HOSTNAME: '127.0.0.1', PORT: String(port),
        NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BASE_PATH, MCP_ENABLED: '1',
        DATABASE_URL: `postgresql://smoke:smoke@127.0.0.1:${DATABASE_PORT}/umami`,
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
        const metadataAssets = await fetchMetadataAssets(html, origin, lock);
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
        const tracker = await http(origin, BASE_PATH + '/script.js');
        assert.equal(tracker.status, 200, 'prefixed tracker script');
        assert.match(tracker.headers.get('content-type') || '', /(?:java|ecma)script/, 'tracker media type');
        assert.equal(hash(Buffer.from(tracker.text)), metadata.trackerSha256);
        const actualAsset = new URL([...assets.keys()][0]);
        const bare = await fetch(origin + actualAsset.pathname.slice(BASE_PATH.length) + actualAsset.search, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        assert.equal(bare.status, 404, 'the actual emitted Next asset must be unavailable without the compiled prefix');
        await bare.arrayBuffer();

        // API key: insert a key the way a bootstrap would, then prove what it may and may not reach under the compiled base path.
        const apiKey = 'umami_' + crypto.randomBytes(16).toString('hex');
        const row = apiKeyRow(apiKey);
        psql(`INSERT INTO api_key (api_key_id, user_id, name, key_hash, key_prefix) VALUES ('${crypto.randomUUID()}', '${ADMIN_USER_ID}', 'image smoke', '${row.hash}', '${row.prefix}')`);
        const key = { authorization: `Bearer ${apiKey}` };
        const session = { authorization: `Bearer ${authentication.token}` };
        const websiteId = crypto.randomUUID();
        const websites = await http(origin, BASE_PATH + '/api/websites', { headers: key });
        assert.equal(websites.status, 200, 'API key must authenticate /api/websites');
        const created = await http(origin, BASE_PATH + '/api/websites', { method: 'POST', headers: key,
            body: { id: websiteId, name: 'Image smoke', domain: 'smoke.example' } });
        assert.equal(created.status, 200, `API key must create a website with an explicit id: ${safeDiagnostic(created.text).slice(0, 300)}`);
        assert.equal(created.json().id, websiteId);
        const listed = await http(origin, BASE_PATH + '/api/websites', { headers: key });
        assert.ok(listed.json().data.some(website => website.id === websiteId), 'created website must be listed for the key');
        const usersControl = await http(origin, BASE_PATH + '/api/users', { headers: session });
        assert.equal(usersControl.status, 200, 'a login session must reach /api/users');
        const keyUsers = await http(origin, BASE_PATH + '/api/users', { headers: key });
        assert.ok([401, 403].includes(keyUsers.status), `an API key must be refused on /api/users under the base path, got ${keyUsers.status}`);
        const keyOwnKeys = await http(origin, BASE_PATH + '/api/me/api-keys', { headers: key });
        assert.ok([401, 403].includes(keyOwnKeys.status), `an API key must be refused on /api/me/api-keys, got ${keyOwnKeys.status}`);

        // Built-in MCP: stateless Streamable HTTP, API keys only.
        const unauthenticated = await http(origin, BASE_PATH + '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } });
        assert.equal(unauthenticated.status, 401, 'MCP must refuse requests without an API key');
        const loginTokenMcp = await mcpCall(origin, authentication.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(loginTokenMcp.status, 401, 'MCP must refuse login tokens');
        const mcp = await mcpSession(origin, apiKey);
        const mcpTools = verifyMcpTools(mcp.tools);
        const called = await mcpCall(origin, apiKey, { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'list_websites', arguments: {} } }, mcp.headers);
        assert.equal(called.status, 200, `MCP tools/call returned ${called.status}`);
        assert.ok(called.message?.result && !called.message.result.isError, 'MCP list_websites must succeed');
        assert.ok(JSON.stringify(called.message.result).includes(websiteId), 'MCP list_websites must report the created website');

        // Collection: a browser user agent creates one session, a crawler none.
        const payload = { type: 'event', payload: { website: websiteId, hostname: 'smoke.example', url: '/smoke', title: 'Smoke', language: 'en-US', screen: '1920x1080' } };
        const bot = await http(origin, BASE_PATH + '/api/send', { method: 'POST', body: payload, headers: { 'user-agent': 'curl/8.0 Googlebot/2.1' } });
        assert.equal(bot.status, 200);
        assert.deepEqual(bot.json(), { beep: 'boop' }, 'crawler user agents must be ignored');
        const sent = await http(origin, BASE_PATH + '/api/send', { method: 'POST', body: payload,
            headers: { 'user-agent': BROWSER_USER_AGENT, 'cf-connecting-ip': '8.8.8.8' } });
        assert.equal(sent.status, 200, `api/send returned ${sent.status}: ${safeDiagnostic(sent.text).slice(0, 300)}`);
        const sentBody = sent.json();
        assert.equal(typeof sentBody.cache, 'string');
        assert.ok(sentBody.cache.length > 20, 'api/send must return a cache token');
        const sessionRows = Number(psql(`SELECT count(*) FROM session WHERE website_id = '${websiteId}'`));
        assert.equal(sessionRows, 1, 'api/send must create exactly one session row');
        assert.equal(Number(psql(`SELECT count(*) FROM website_event WHERE website_id = '${websiteId}'`)), 1);
        assert.equal(psql(`SELECT country FROM session WHERE website_id = '${websiteId}'`), 'US', 'the pinned GeoIP database must resolve the forwarded client address');

        verifyLoopbackListener(fs.readFileSync('/proc/net/tcp', 'utf8'), port);
        assert.ok(!fs.readFileSync('/proc/net/tcp6', 'utf8').split('\n').map(line => line.trim().split(/\s+/)).some(fields => fields[3] === '0A' && fields[1]?.endsWith(':0BB9')),
            'Next must not expose an additional IPv6 listener');
        assert.equal(closed, false, 'Next stopped during asset verification');
        console.log(JSON.stringify({ schema: 'ploinky.umami-image-smoke/v1', passed: true, uid: process.getuid(),
            capabilityEffective: '0', noNewPrivileges: true, listener: '127.0.0.1:3001', postgresVersion,
            metadata, loginHttp: 200, databaseMigration: true, heartbeatHttp: 200, authLoginHttp: 200, authVerifyHttp: 200, trackerHttp: 200, unprefixedNextHttp: 404,
            apiKeyWebsites: websites.status, apiKeyWebsiteCreate: created.status, apiKeyUsers: keyUsers.status, apiKeyOwnKeys: keyOwnKeys.status, sessionUsers: usersControl.status,
            mcpUnauthenticated: unauthenticated.status, mcpLoginToken: loginTokenMcp.status, mcpHandshake: mcp.handshake, mcpTools, mcpListWebsites: true,
            sendBotIgnored: true, sendCacheToken: true, sessionRows, sessionCountry: 'US', assets: observed, metadataAssets }));
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

// Existing-data-directory continuity. The workflow runs `continuity-init` in the pinned legacy image and `continuity-verify`
// in the candidate, on one data directory. Both phases use only Node built-ins and the image's own PostgreSQL tools.
function continuityEnvironment(directory) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-continuity-'));
    return { home, sockets: path.join(home, 'sockets'), data: path.join(directory, 'postgres'), initFile: path.join(directory, 'continuity-init.json'),
        env: { ...process.env, HOME: home, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
            DATABASE_URL: `postgresql://smoke:smoke@127.0.0.1:${DATABASE_PORT}/umami` } };
}

function continuityInit(directory) {
    assert.equal(process.getuid(), 1000, 'continuity smoke must use the agent UID');
    const { home, sockets, data, initFile, env } = continuityEnvironment(directory);
    fs.mkdirSync(sockets);
    assert.ok(!fs.existsSync(data) && !fs.existsSync(initFile), 'continuity initialisation needs an empty data directory');
    let started = false;
    try {
        command('initdb', ['-D', data, '-U', 'smoke', '--auth=trust', '--no-locale', '--encoding=UTF8']);
        startPostgres(data, sockets, path.join(home, 'postgres.log'));
        started = true;
        command('createdb', ['-h', '127.0.0.1', '-p', String(DATABASE_PORT), '-U', 'smoke', 'umami']);
        npmRun('check-db', '/app', env);
        const websiteId = crypto.randomUUID();
        psql(`INSERT INTO website (website_id, name, domain, user_id, created_by) VALUES ('${websiteId}', 'continuity', 'continuity.example', '${ADMIN_USER_ID}', '${ADMIN_USER_ID}')`);
        psql('CREATE TABLE continuity_marker (id integer PRIMARY KEY, note text NOT NULL)');
        psql("INSERT INTO continuity_marker VALUES (1, 'written by the legacy image')");
        const migrations = Number(psql('SELECT count(*) FROM _prisma_migrations'));
        // The legacy image's server tools are not assumed to include pg_controldata, so its control file is read through SQL.
        const [controlVersion, catalogVersion] = psql('SELECT pg_control_version, catalog_version_no FROM pg_control_system()').split('|');
        assert.match(controlVersion, /^\d+$/);
        assert.match(catalogVersion, /^\d+$/);
        stopPostgres(data);
        started = false;
        const initial = { postgresVersion: command('postgres', ['--version']).trim(), umamiVersion: readJson('/app/package.json').version,
            majorVersion: fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim(), postgresUid: Number(command('id', ['-u', 'postgres']).trim()),
            controlVersion, catalogVersion, migrations, websiteId };
        fs.writeFileSync(initFile, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ schema: 'ploinky.umami-continuity-init/v1', passed: true, ...initial }));
    } finally {
        if (started) stopPostgres(data, 'immediate');
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function continuityVerify(directory) {
    assert.equal(process.getuid(), 1000, 'continuity smoke must use the agent UID');
    const lock = readJson('/usr/local/share/ploinky/umami-agent-sources.json');
    const { home, sockets, data, initFile, env } = continuityEnvironment(directory);
    fs.mkdirSync(sockets);
    const initial = readJson(initFile);
    assert.equal(initial.umamiVersion, lock.continuity.legacyImage.umamiVersion, 'the data directory came from the pinned legacy Umami');
    const before = parseControlData(command('pg_controldata', [data]));
    assert.deepEqual(before, { controlVersion: initial.controlVersion, catalogVersion: initial.catalogVersion, state: 'shut down' },
        'the candidate PostgreSQL must see a cleanly shut down control file with the versions the legacy PostgreSQL wrote');
    const major = fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim();
    assert.equal(major, initial.majorVersion);
    assert.equal(Number(major), lock.bases.postgres.postgresMajor);
    assert.equal(Number(command('id', ['-u', 'postgres']).trim()), initial.postgresUid, 'the postgres user keeps its numeric id');
    let started = false;
    try {
        startPostgres(data, sockets, path.join(home, 'postgres.log'));
        started = true;
        assert.equal(psql("SELECT note FROM continuity_marker WHERE id = 1"), 'written by the legacy image');
        assert.equal(psql(`SELECT count(*) FROM website WHERE website_id = '${initial.websiteId}'`), '1');
        npmRun('check:db', '/app', env);
        const migrations = Number(psql('SELECT count(*) FROM _prisma_migrations'));
        assert.ok(migrations > initial.migrations, 'the candidate must apply its newer migrations to the existing data');
        assert.equal(psql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL'), '0');
        assert.equal(psql("SELECT to_regclass('api_key') IS NOT NULL"), 't', 'the API key table must exist after migration');
        assert.equal(psql(`SELECT count(*) FROM website WHERE website_id = '${initial.websiteId}'`), '1');
        assert.equal(psql("SELECT note FROM continuity_marker WHERE id = 1"), 'written by the legacy image');
        stopPostgres(data);
        started = false;
        const after = parseControlData(command('pg_controldata', [data]));
        assert.equal(after.state, 'shut down');
        assert.equal(after.catalogVersion, before.catalogVersion);
        console.log(JSON.stringify({ schema: 'ploinky.umami-continuity-smoke/v1', passed: true, existingDataDir: 'ok',
            legacy: { umamiVersion: initial.umamiVersion, postgresVersion: initial.postgresVersion, migrations: initial.migrations },
            candidate: { postgresVersion: command('postgres', ['--version']).trim(), migrations, umamiVersion: readJson('/app/package.json').version },
            majorVersion: Number(major), catalogVersion: after.catalogVersion, controlVersion: after.controlVersion, postgresUid: initial.postgresUid }));
    } finally {
        if (started) stopPostgres(data, 'immediate');
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function main() {
    const [mode = 'runtime', directory] = process.argv.slice(2);
    if (mode === 'runtime') return verifyRuntime();
    assert.ok(directory && path.isAbsolute(directory), 'continuity phases need an absolute data directory');
    if (mode === 'continuity-init') return continuityInit(directory);
    assert.equal(mode, 'continuity-verify');
    return continuityVerify(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ schema: 'ploinky.umami-image-smoke-failure/v1', passed: false,
            error: safeDiagnostic(error.message), commandOutput: error.commandOutput, serverOutput: error.serverOutput }));
        process.exitCode = 1;
    });
}
