// Hermetic stand-ins for the two bundled libraries. They exercise the image's
// preparation and smoke tools without network or an installed package; the real
// libraries are covered separately when a test source is supplied.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const write = (root, relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
};

const JWT_SIGN = `import crypto from 'node:crypto';
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
export function bodyHashForRequest(body) {
    return crypto.createHash('sha256').update(canonicalJson(body ?? {})).digest('base64url');
}
export function signHmacJwt({ payload, secret }) {
    const input = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.'
        + Buffer.from(JSON.stringify(payload)).toString('base64url');
    return input + '.' + crypto.createHmac('sha256', secret).update(input).digest('base64url');
}
`;

const JWT_VERIFY = `import crypto from 'node:crypto';
import { canonicalJson, bodyHashForRequest } from './jwtSign.mjs';
export const MAX_TTL_SECONDS = 120;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;
export function createMemoryReplayCache() {
    const seen = new Set();
    return { seen: (jti) => seen.has(jti), remember: (jti) => seen.add(jti) };
}
export function verifyJws(token, { secret, expectedAudience, bodyObject, replayCache }) {
    const [header, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
    if (signature !== expected) throw new Error('signature invalid');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (expectedAudience && payload.aud !== expectedAudience) throw new Error('audience mismatch');
    if (bodyObject !== undefined && payload.bh !== bodyHashForRequest(bodyObject)) throw new Error('body hash mismatch');
    if (replayCache) {
        if (replayCache.seen(payload.jti)) throw new Error('token replayed');
        replayCache.remember(payload.jti);
    }
    return { header, payload };
}
export function verifyInvocationToken(token, options) {
    const result = verifyJws(token, options);
    if (result.payload.typ !== 'invocation') throw new Error('not an invocation token');
    if (options.expectedTool && result.payload.tool !== options.expectedTool) throw new Error('tool mismatch');
    return result;
}
export { canonicalJson, bodyHashForRequest };
`;

/** A dependency-free AgentLib package that satisfies every consumer Ploinky has. */
export function writeAgentLibFixture(root, { omit = [], override = {}, license = true, packageJson = {} } = {}) {
    const files = {
        'package.json': JSON.stringify({
            name: 'ploinky-agent-lib', version: '1.2.3', type: 'module', ...(license ? { license: 'MIT' } : {}),
            exports: { '.': './index.mjs', './jwt/*': './jwt/*' }, dependencies: {}, ...packageJson,
        }, null, 2),
        'LLMAgents/index.mjs': 'export const DEFAULT_AGENT_NAME = "default";\n',
        'LLMAgents/openAiAgenticResponder.mjs':
            'export function isOptOutModel(model) { return typeof model === "string" && model === "none"; }\n'
            + 'export async function runOpenAiAgenticResponse() { throw new Error("no model in the smoke"); }\n',
        'utils/LLMClient.mjs':
            'export const defaultLLMInvokerStrategy = async function defaultLLMInvokerStrategy() {};\n'
            + 'export function getPrioritizedModels() { return []; }\n',
        'jwt/jwtSign.mjs': JWT_SIGN,
        'jwt/jwtVerify.mjs': JWT_VERIFY,
        ...(license ? { LICENSE: 'MIT License fixture\n' } : {}),
        'README.md': 'Fixture library.\n',
    };
    for (const [relative, text] of Object.entries({ ...files, ...override })) {
        if (!omit.includes(relative)) write(root, relative, text);
    }
    return root;
}

const SDK_BODY = `import { randomUUID } from 'node:crypto';
const make = (check) => ({ parse(value) { if (!check(value)) throw new Error('invalid'); return value; } });
const passes = (schema, value) => { try { schema.parse(value); return true; } catch (_) { return false; } };
const z = {
    string: () => make((v) => typeof v === 'string'),
    number: () => make((v) => typeof v === 'number'),
    boolean: () => make((v) => typeof v === 'boolean'),
    null: () => make((v) => v === null),
    any: () => make(() => true),
    unknown: () => make(() => true),
    literal: (expected) => make((v) => v === expected),
    union: (options) => make((v) => options.some((option) => passes(option, v))),
    array: (item) => make((v) => Array.isArray(v) && v.every((entry) => passes(item, entry))),
    object: (shape) => make((v) => v && typeof v === 'object'
        && Object.entries(shape).every(([key, schema]) => passes(schema, v[key]))),
};
class McpServer {
    constructor(info) { this.info = info; this.tools = new Map(); }
    registerTool(name, definition, callback) { this.tools.set(name, { definition, callback }); }
    async connect(transport) { transport.server = this; }
    async close() {}
}
class ResourceTemplate {}
class StreamableHTTPServerTransport {
    constructor(options) { this.options = options; }
    async handleRequest(request, response, body) {
        const send = (result, headers = {}) => {
            response.writeHead(200, { 'content-type': 'application/json', ...headers });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (body.method === 'initialize') {
            send({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: this.server.info },
                { 'mcp-session-id': this.options.sessionIdGenerator() });
        } else if (body.id === undefined) {
            response.writeHead(202).end();
        } else if (body.method === 'tools/list') {
            send({ tools: [...this.server.tools.keys()].map((name) => ({ name })) });
        } else if (body.method === 'tools/call') {
            send(await this.server.tools.get(body.params.name).callback(body.params.arguments));
        }
    }
}
class ClientTransport {
    constructor(url) { this.url = url; this.counter = 0; this.session = null; }
    async post(payload) {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(this.session ? { 'mcp-session-id': this.session } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
        });
        this.session ??= response.headers.get('mcp-session-id');
        return payload.id === undefined ? null : (await response.json()).result;
    }
    rpc(method, params) { return this.post({ id: ++this.counter, method, params }); }
}
class Client {
    constructor(info) { this.info = info; }
    async connect(transport) {
        this.transport = transport;
        await transport.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: this.info });
        await transport.post({ method: 'notifications/initialized' });
    }
    listTools() { return this.transport.rpc('tools/list', {}); }
    callTool({ name, arguments: args }) { return this.transport.rpc('tools/call', { name, arguments: args }); }
    async close() {}
}
`;

/**
 * The stand-in package entry. `without` names one dotted export path
 * (for example `client.Client`) that the package must not provide.
 */
export function sdkEntry(without = null) {
    return `${SDK_BODY}
const surface = {
    zod: { z },
    types: { isInitializeRequest() { return false; }, McpError: class McpError extends Error {}, ErrorCode: { InvalidRequest: -32600 } },
    streamHttp: { StreamableHTTPServerTransport },
    mcp: { McpServer, ResourceTemplate },
    client: { Client },
    StreamableHTTPClientTransport: ClientTransport,
};
const removed = ${JSON.stringify(without)};
if (removed) {
    const keys = removed.split('.');
    let cursor = surface;
    for (const key of keys.slice(0, -1)) { cursor[key] = { ...cursor[key] }; cursor = cursor[key]; }
    delete cursor[keys.at(-1)];
}
export const { zod, types, streamHttp, mcp, client, StreamableHTTPClientTransport } = surface;
`;
}

/** A stand-in MCP SDK package. */
export function writeSdkFixture(root, { without = null, entry = sdkEntry(without), name = '@modelcontextprotocol/sdk', exportsMap = { '.': './index.mjs' } } = {}) {
    write(root, 'package.json', JSON.stringify({ name, version: '1.19.1', type: 'module', exports: exportsMap }, null, 2));
    write(root, 'index.mjs', entry);
    return root;
}

const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export function git(root, ...args) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

/** Commit everything under `root` as one revision and return its commit. */
export function commitAll(root) {
    if (!fs.existsSync(path.join(root, '.git'))) git(root, 'init', '-q');
    git(root, 'add', '--all', '--force');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'fixture');
    return git(root, 'rev-parse', 'HEAD');
}
