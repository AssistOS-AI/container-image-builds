// Functional checks for the two libraries bundled in the Box image.
//
// The image owns these checks. They prove that the packaged AchillesAgentLib
// and MCP SDK expose what Ploinky actually consumes, without comparing
// revisions or hashing library bytes:
//   inspect achillesAgentLib   protected layout and required files first, then the
//                              exports, plus optional build provenance
//   smoke                      the same checks for both libraries, then their
//                              functional checks
//   self-test                  proves `smoke` rejects deliberately broken copies
//
// The tables below are the image's copy of Ploinky's library consumer surface.
// Publication verifies that `requiredEntries` covers every entry of the
// selected Ploinky source's AGENTLIB_REQUIRED_ENTRYPOINTS, so the two lists
// cannot drift apart unnoticed.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACHILLES_PACKAGE_NAME = 'ploinky-agent-lib';
export const MCP_SDK_PACKAGE_NAME = '@modelcontextprotocol/sdk';
export const LIBRARY_METADATA_SCHEMA = 'ploinky.box.library/v1';
export const MCP_SDK_METADATA_NAME = '.ploinky-box-mcp-sdk.json';

export const DEFAULT_ROOTS = Object.freeze({
    agentlibRoot: '/opt/ploinky-agentlib',
    agentlibMetadata: '/usr/local/share/ploinky/agentlib/runtime-contract.json',
    mcpSdkRoot: '/usr/local/lib/ploinky/mcp-sdk',
});

/** AchillesAgentLib modules Ploinky imports, with the exports and kinds it uses. */
export const ACHILLES_MODULES = Object.freeze([
    { subpath: 'LLMAgents/index.mjs', exports: {} },
    {
        subpath: 'LLMAgents/openAiAgenticResponder.mjs',
        exports: { isOptOutModel: 'function', runOpenAiAgenticResponse: 'function' },
    },
    {
        subpath: 'utils/LLMClient.mjs',
        exports: { defaultLLMInvokerStrategy: 'function', getPrioritizedModels: 'function' },
    },
    {
        subpath: 'jwt/jwtSign.mjs',
        exports: { signHmacJwt: 'function', bodyHashForRequest: 'function', canonicalJson: 'function' },
    },
    {
        subpath: 'jwt/jwtVerify.mjs',
        exports: {
            verifyJws: 'function',
            verifyInvocationToken: 'function',
            createMemoryReplayCache: 'function',
            canonicalJson: 'function',
            bodyHashForRequest: 'function',
            MAX_TTL_SECONDS: 'number',
            DEFAULT_CLOCK_SKEW_SECONDS: 'number',
        },
    },
]);

export const ACHILLES_REQUIRED_ENTRIES = Object.freeze([
    'package.json',
    ...ACHILLES_MODULES.map((entry) => entry.subpath),
]);

/** MCP SDK members Ploinky imports as `mcp-sdk`, by dotted path from the package entry. */
export const MCP_SDK_MEMBERS = Object.freeze([
    ...['object', 'array', 'string', 'number', 'boolean', 'null', 'literal', 'union', 'any', 'unknown']
        .map((name) => [`zod.z.${name}`, 'function']),
    ['types.isInitializeRequest', 'function'],
    ['types.McpError', 'function'],
    ['types.ErrorCode', 'object'],
    ['streamHttp.StreamableHTTPServerTransport', 'function'],
    ['mcp.McpServer', 'function'],
    ['mcp.ResourceTemplate', 'function'],
    ['client.Client', 'function'],
    ['StreamableHTTPClientTransport', 'function'],
].map(([member, kind]) => Object.freeze({ member, kind })));

/**
 * Negative fixtures. `self-test` proves `smoke` rejects each, naming what is
 * missing. `reason` is the exact rejection `smoke` must report, so a failure for
 * another cause that merely mentions the name (an import error, for example)
 * does not count.
 */
export const SELF_TEST_CASES = Object.freeze([
    { name: 'agentlib-missing-responder-module', expected: 'LLMAgents/openAiAgenticResponder.mjs',
        reason: 'is missing required entry LLMAgents/openAiAgenticResponder.mjs' },
    { name: 'agentlib-missing-isOptOutModel', expected: 'isOptOutModel',
        reason: "export 'isOptOutModel' is missing" },
    { name: 'agentlib-missing-runOpenAiAgenticResponse', expected: 'runOpenAiAgenticResponse',
        reason: "export 'runOpenAiAgenticResponse' is missing" },
    { name: 'mcp-sdk-missing-StreamableHTTPClientTransport', expected: 'StreamableHTTPClientTransport',
        reason: "export 'StreamableHTTPClientTransport' is missing" },
].map((entry) => Object.freeze(entry)));

const COMMIT = /^[0-9a-f]{40}$/;
const EXCHANGE_TIMEOUT_MS = 30_000;

export class LibrarySmokeError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'LibrarySmokeError';
    }
}

function fail(message, cause) {
    throw new LibrarySmokeError(message, cause ? { cause } : undefined);
}

function readJson(file, description) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return fail(`${description} is missing or unreadable: ${file}`, error);
    }
}

function readPackage(root, library, expectedName) {
    const pkg = readJson(path.join(root, 'package.json'), `${library} package.json`);
    if (pkg?.name !== expectedName) {
        fail(`${library} package.json declares '${String(pkg?.name)}'; expected '${expectedName}'`);
    }
    if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
        fail(`${library} package.json declares no version`);
    }
    return pkg;
}

/** The regular file a required entry names, resolved beneath the library root. */
function requiredFile(root, library, relative) {
    const absolute = path.join(root, relative);
    let real;
    try {
        if (!fs.statSync(absolute).isFile()) throw new Error('not a regular file');
        real = fs.realpathSync(absolute);
    } catch (error) {
        return fail(`${library} is missing required entry ${relative}`, error);
    }
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
        fail(`${library} required entry ${relative} resolves outside the package`);
    }
    return real;
}

/** The MCP SDK entry, `exports["."]` of its package manifest. */
export function mcpSdkEntry(pkg) {
    const target = pkg?.exports?.['.'];
    const entry = typeof target === 'string' ? target : target?.import ?? target?.default;
    if (typeof entry !== 'string' || !entry.startsWith('./')) {
        fail(`${MCP_SDK_PACKAGE_NAME} package.json declares no usable exports["."] entry`);
    }
    return entry;
}

function kindOf(value) {
    return value === null ? 'null' : typeof value;
}

function assertKind(library, where, name, value, kind) {
    const ok = kind === 'number' ? Number.isFinite(value) && typeof value === 'number' : kindOf(value) === kind;
    if (!ok) {
        const state = value === undefined ? 'is missing' : `has kind ${kindOf(value)}, expected ${kind}`;
        fail(`${library} ${where} export '${name}' ${state}`);
    }
}

async function importFile(library, relative, file) {
    try {
        return await import(pathToFileURL(file).href);
    } catch (error) {
        return fail(`${library} entry ${relative} does not import: ${error.message}`, error);
    }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function assertProtected(target, description, owner) {
    const stat = fs.lstatSync(target);
    if (stat.uid !== owner || (!stat.isSymbolicLink() && (stat.mode & 0o022))) {
        fail(`${description} must be owned by root and not writable by the runtime user: ${target}`);
    }
}

/** A symlink is kept only when its literal and resolved targets stay inside the package. */
function assertConfinedSymlink(realRoot, absolute, description) {
    const literal = path.resolve(path.dirname(absolute), fs.readlinkSync(absolute));
    let real = literal;
    try {
        real = fs.realpathSync(absolute);
    } catch (_) { /* dangling: the literal target still has to be inside the package */ }
    for (const target of [literal, real]) {
        if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
            fail(`${description} contains a symlink escaping the package: ${path.relative(realRoot, absolute)}`);
        }
    }
}

/**
 * Root-owned, read-only, Git-free package tree. No file content is read.
 *
 * `allowSymlinks` keeps symlinks whose targets stay inside the package (AchillesAgentLib
 * may ship some; the MCP SDK may not). `owner` and `boundary` exist only so tests can
 * exercise the whole check without root: the owner defaults to root and every ancestor
 * up to the filesystem root is protected unless a nearer `boundary` is named.
 */
export function assertProtectedLayout(root, description, { allowSymlinks = false, owner = 0, boundary = null } = {}) {
    const resolved = path.resolve(root);
    const stop = boundary === null ? null : path.resolve(boundary);
    let ancestor = resolved;
    while (true) {
        assertProtected(ancestor, description, owner);
        const parent = path.dirname(ancestor);
        if (parent === ancestor || ancestor === stop) break;
        ancestor = parent;
    }
    // Walk the canonical tree so a symlinked ancestor cannot make a target look like an escape.
    const realRoot = fs.realpathSync(resolved);
    const walk = (directory) => {
        for (const name of fs.readdirSync(directory)) {
            const absolute = path.join(directory, name);
            if (directory === realRoot && name === '.git') fail(`${description} must not contain Git metadata`);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                if (!allowSymlinks) fail(`${description} must not contain symlinks: ${absolute}`);
                assertConfinedSymlink(realRoot, absolute, description);
            }
            assertProtected(absolute, description, owner);
            if (stat.isDirectory()) walk(absolute);
        }
    };
    walk(realRoot);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The build-generated provenance record, or the reason it is unavailable.
 * Provenance is diagnostic: an unavailable record never blocks a usable package.
 */
export function readProvenance(metadataPath, library, packageName) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (error) {
        return { record: null, problem: `provenance record is unavailable: ${error.code || error.message}` };
    }
    const branchOk = value?.branch === null || (typeof value?.branch === 'string' && value.branch !== '');
    if (value?.schema !== LIBRARY_METADATA_SCHEMA || value.library !== library
        || value.packageName !== packageName
        || typeof value.packageVersion !== 'string' || !value.packageVersion
        || typeof value.repository !== 'string' || !value.repository
        || !branchOk || !COMMIT.test(String(value.commit))) {
        return { record: null, problem: 'provenance record does not match ploinky.box.library/v1' };
    }
    return {
        record: {
            schema: value.schema,
            library: value.library,
            packageName: value.packageName,
            packageVersion: value.packageVersion,
            repository: value.repository,
            branch: value.branch,
            commit: value.commit,
        },
        problem: null,
    };
}

// ---------------------------------------------------------------------------
// AchillesAgentLib
// ---------------------------------------------------------------------------

/** Package identity and every required file, resolved inside the package. Nothing is imported. */
export function checkAchillesStructure(root) {
    const library = 'achillesAgentLib';
    const pkg = readPackage(root, library, ACHILLES_PACKAGE_NAME);
    const files = Object.fromEntries(ACHILLES_MODULES
        .map(({ subpath }) => [subpath, requiredFile(root, library, subpath)]));
    return { pkg, files };
}

/**
 * Every export Ploinky imports, by actually importing the modules. The whole structure is
 * proven first, so no library code runs from a package that is missing anything.
 */
export async function checkAchillesAgentLib(root) {
    const library = 'achillesAgentLib';
    const { pkg, files } = checkAchillesStructure(root);
    const modules = {};
    for (const { subpath, exports } of ACHILLES_MODULES) {
        const namespace = await importFile(library, subpath, files[subpath]);
        for (const [name, kind] of Object.entries(exports)) {
            assertKind(library, subpath, name, namespace[name], kind);
        }
        modules[subpath] = namespace;
    }
    return { pkg, modules };
}

function assertJwtRoundTrip(modules) {
    const { signHmacJwt, bodyHashForRequest } = modules['jwt/jwtSign.mjs'];
    const { verifyInvocationToken, createMemoryReplayCache } = modules['jwt/jwtVerify.mjs'];
    const secret = crypto.randomBytes(32);
    const body = { probe: 'library-smoke' };
    const issued = Math.floor(Date.now() / 1000);
    const token = signHmacJwt({
        payload: {
            iss: 'ploinky-router', aud: 'library-smoke', typ: 'invocation', tool: 'probe',
            jti: crypto.randomUUID(), iat: issued, exp: issued + 30, bh: bodyHashForRequest(body),
        },
        secret,
    });
    const options = {
        secret, expectedAudience: 'library-smoke', expectedTool: 'probe', bodyObject: body,
        replayCache: createMemoryReplayCache(),
    };
    verifyInvocationToken(token, options);
    for (const [description, retry] of [
        ['a replayed token', () => verifyInvocationToken(token, options)],
        ['a token with a different secret', () => verifyInvocationToken(token, {
            ...options, secret: crypto.randomBytes(32), replayCache: createMemoryReplayCache(),
        })],
    ]) {
        let accepted = false;
        try {
            retry();
            accepted = true;
        } catch (_) { /* expected rejection */ }
        if (accepted) fail(`achillesAgentLib jwt verification accepted ${description}`);
    }
}

export async function smokeAchillesAgentLib(root) {
    const { pkg, modules } = await checkAchillesAgentLib(root);
    const { isOptOutModel } = modules['LLMAgents/openAiAgenticResponder.mjs'];
    for (const sample of ['none', 'gpt-probe']) {
        if (typeof isOptOutModel(sample) !== 'boolean') {
            fail("achillesAgentLib export 'isOptOutModel' did not return a boolean");
        }
    }
    assertJwtRoundTrip(modules);
    return {
        packageName: pkg.name,
        packageVersion: pkg.version,
        requiredEntries: [...ACHILLES_REQUIRED_ENTRIES],
        checks: ['imports', 'exports', 'isOptOutModel', 'jwt-round-trip'],
    };
}

// ---------------------------------------------------------------------------
// MCP SDK
// ---------------------------------------------------------------------------

function memberOf(namespace, dotted) {
    return dotted.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]),
        namespace);
}

export async function checkMcpSdk(root) {
    const library = 'mcp-sdk';
    const pkg = readPackage(root, library, MCP_SDK_PACKAGE_NAME);
    const entry = mcpSdkEntry(pkg);
    const namespace = await importFile(library, entry, requiredFile(root, library, entry));
    for (const { member, kind } of MCP_SDK_MEMBERS) {
        const [name] = member.split('.');
        if (!(name in namespace)) fail(`${library} entry ${entry} export '${name}' is missing`);
        assertKind(library, entry, member, memberOf(namespace, member), kind);
    }
    return { pkg, entry, namespace };
}

function assertZodSchema({ z }) {
    const schema = z.object({
        text: z.string(),
        count: z.number(),
        flag: z.boolean(),
        tags: z.array(z.string()),
        mode: z.union([z.literal('a'), z.literal('b')]),
        nothing: z.null(),
        anything: z.any(),
        unknown: z.unknown(),
    });
    schema.parse({
        text: 'probe', count: 1, flag: true, tags: ['x'], mode: 'a', nothing: null, anything: 1, unknown: 'x',
    });
    let accepted = false;
    try {
        schema.parse({ text: 1 });
        accepted = true;
    } catch (_) { /* expected rejection */ }
    if (accepted) fail('mcp-sdk zod schema accepted an invalid value');
}

/** One in-process, loopback-only MCP exchange: list a tool, then call it. */
async function loopbackExchange(namespace) {
    const { zod, mcp, streamHttp, client, StreamableHTTPClientTransport } = namespace;
    const server = new mcp.McpServer({ name: 'ploinky-box-library-smoke', version: '1.0.0' });
    server.registerTool('echo', {
        description: 'Return the supplied text.',
        inputSchema: { text: zod.z.string() },
    }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
    const transport = new streamHttp.StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);
    const httpServer = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            let body;
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                body = raw ? JSON.parse(raw) : undefined;
            } catch (_) {
                response.writeHead(400).end();
                return;
            }
            transport.handleRequest(request, response, body).catch(() => response.destroy());
        });
    });
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
    });
    const consumer = new client.Client({ name: 'ploinky-box-library-smoke-client', version: '1.0.0' });
    let timer;
    try {
        const exchange = (async () => {
            const { port } = httpServer.address();
            await consumer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
            const listed = await consumer.listTools();
            if (!listed.tools?.some((tool) => tool.name === 'echo')) fail('mcp-sdk loopback did not list the tool');
            const called = await consumer.callTool({ name: 'echo', arguments: { text: 'probe' } });
            if (called.content?.[0]?.text !== 'probe') fail('mcp-sdk loopback tool call returned the wrong result');
        })();
        await Promise.race([exchange, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new LibrarySmokeError('mcp-sdk loopback exchange timed out')),
                EXCHANGE_TIMEOUT_MS);
        })]);
    } finally {
        clearTimeout(timer);
        await consumer.close().catch(() => {});
        await server.close().catch(() => {});
        httpServer.closeAllConnections?.();
        await new Promise((resolve) => httpServer.close(resolve));
    }
}

export async function smokeMcpSdk(root) {
    const { pkg, entry, namespace } = await checkMcpSdk(root);
    assertZodSchema(namespace.zod);
    try {
        await loopbackExchange(namespace);
    } catch (error) {
        if (error instanceof LibrarySmokeError) throw error;
        fail(`mcp-sdk loopback exchange failed: ${error.message}`, error);
    }
    return {
        packageName: pkg.name,
        packageVersion: pkg.version,
        entry,
        members: MCP_SDK_MEMBERS.map(({ member }) => member),
        checks: ['imports', 'exports', 'zod-schema', 'loopback-tool-call'],
    };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function inspectAchillesAgentLib({
    agentlibRoot = DEFAULT_ROOTS.agentlibRoot,
    agentlibMetadata = DEFAULT_ROOTS.agentlibMetadata,
    protectedLayout = true,
    layout = {},
} = {}) {
    // The protected layout and the structure are proven before any library module runs.
    if (protectedLayout) {
        assertProtectedLayout(agentlibRoot, 'achillesAgentLib package', { ...layout, allowSymlinks: true });
    }
    const { pkg } = await checkAchillesAgentLib(agentlibRoot);
    const provenance = readProvenance(agentlibMetadata, 'achillesAgentLib', ACHILLES_PACKAGE_NAME);
    return {
        schema: 'ploinky.box.library-inspect/v1',
        library: 'achillesAgentLib',
        packageName: pkg.name,
        packageVersion: pkg.version,
        provenance: provenance.record,
        ...(provenance.problem ? { provenanceProblem: provenance.problem } : {}),
    };
}

export async function runSmoke({
    agentlibRoot = DEFAULT_ROOTS.agentlibRoot,
    mcpSdkRoot = DEFAULT_ROOTS.mcpSdkRoot,
    protectedLayout = true,
    layout = {},
} = {}) {
    // Both trees are proven protected before either library runs. Only AchillesAgentLib may
    // keep symlinks, and only ones that stay inside its package.
    if (protectedLayout) {
        assertProtectedLayout(agentlibRoot, 'achillesAgentLib package', { ...layout, allowSymlinks: true });
        assertProtectedLayout(mcpSdkRoot, 'mcp-sdk package', { ...layout, allowSymlinks: false });
    }
    return {
        schema: 'ploinky.box.library-smoke/v1',
        ok: true,
        // Publication evidence must show the protected layout was checked, not relaxed.
        protectedLayout: Boolean(protectedLayout),
        libraries: {
            achillesAgentLib: await smokeAchillesAgentLib(agentlibRoot),
            'mcp-sdk': await smokeMcpSdk(mcpSdkRoot),
        },
    };
}

function copyTree(source, destination, { skipRootGit = false } = {}) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (skipRootGit && entry.name === '.git') continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(from), to);
        } else if (entry.isDirectory()) {
            copyTree(from, to);
        } else if (entry.isFile()) {
            fs.copyFileSync(from, to);
            fs.chmodSync(to, fs.statSync(from).mode & 0o111 ? 0o755 : 0o644);
        }
    }
}

/**
 * Disposable broken copies under the temporary directory. The AchillesAgentLib
 * fixtures copy the real package and change exactly one thing. The MCP SDK
 * fixture re-exports the real package entry without one member.
 */
function buildFixtures({ agentlibRoot, mcpSdkRoot }, scratch) {
    const responder = 'LLMAgents/openAiAgenticResponder.mjs';
    const agentlibVariant = (name, change) => {
        const root = path.join(scratch, name);
        copyTree(agentlibRoot, root, { skipRootGit: true });
        change(path.join(root, responder));
        return { agentlibRoot: root, mcpSdkRoot };
    };
    const sdkEntry = requiredFile(mcpSdkRoot, 'mcp-sdk', mcpSdkEntry(readPackage(mcpSdkRoot, 'mcp-sdk', MCP_SDK_PACKAGE_NAME)));
    const stubRoot = path.join(scratch, 'mcp-sdk-missing-StreamableHTTPClientTransport');
    fs.mkdirSync(stubRoot, { recursive: true });
    fs.writeFileSync(path.join(stubRoot, 'package.json'), JSON.stringify({
        name: MCP_SDK_PACKAGE_NAME, version: '0.0.0-self-test', type: 'module', exports: { '.': './index.mjs' },
    }));
    fs.writeFileSync(path.join(stubRoot, 'index.mjs'),
        `export { zod, types, streamHttp, mcp, client } from ${JSON.stringify(pathToFileURL(sdkEntry).href)};\n`);
    return {
        'agentlib-missing-responder-module': agentlibVariant('agentlib-missing-responder-module',
            (file) => fs.rmSync(file)),
        'agentlib-missing-isOptOutModel': agentlibVariant('agentlib-missing-isOptOutModel',
            (file) => fs.writeFileSync(file, 'export async function runOpenAiAgenticResponse() {}\n')),
        'agentlib-missing-runOpenAiAgenticResponse': agentlibVariant('agentlib-missing-runOpenAiAgenticResponse',
            (file) => fs.writeFileSync(file, 'export function isOptOutModel() { return false; }\n')),
        'mcp-sdk-missing-StreamableHTTPClientTransport': { agentlibRoot, mcpSdkRoot: stubRoot },
    };
}

function smokeChild(roots) {
    const result = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url), 'smoke',
        '--agentlib-root', roots.agentlibRoot, '--mcp-sdk-root', roots.mcpSdkRoot, '--allow-unprotected-layout',
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { status: result.status, stderr: String(result.stderr || ''), error: result.error };
}

/**
 * Prove that `smoke` rejects each negative fixture. Any fixture that is
 * accepted, or rejected without naming what is missing, fails the self-test.
 * An intact control must pass, so a rejection is attributable to the fixture.
 */
export async function runSelfTest({
    agentlibRoot = DEFAULT_ROOTS.agentlibRoot,
    mcpSdkRoot = DEFAULT_ROOTS.mcpSdkRoot,
    run = smokeChild,
} = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-library-self-test-'));
    try {
        const roots = { agentlibRoot, mcpSdkRoot };
        const control = run(roots);
        if (control.status !== 0) {
            fail(`self-test control failed on the intact libraries: ${control.stderr.trim() || control.error?.message}`);
        }
        const fixtures = buildFixtures(roots, scratch);
        const cases = SELF_TEST_CASES.map(({ name, expected, reason }) => {
            const outcome = run(fixtures[name]);
            if (outcome.status === 0) fail(`self-test fixture ${name} was accepted by smoke`);
            if (!outcome.stderr.includes(reason)) {
                fail(`self-test fixture ${name} was rejected without naming ${expected} as missing: ${outcome.stderr.trim()}`);
            }
            return { name, expected, rejected: true };
        });
        return { schema: 'ploinky.box.library-self-test/v1', ok: true, control: { accepted: true }, cases };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const FLAGS = Object.freeze({
    '--agentlib-root': 'agentlibRoot',
    '--agentlib-metadata': 'agentlibMetadata',
    '--mcp-sdk-root': 'mcpSdkRoot',
});

export function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (!['inspect', 'smoke', 'self-test'].includes(command)) {
        fail('Usage: smoke-libraries.mjs <inspect achillesAgentLib|smoke|self-test> [--agentlib-root DIR] '
            + '[--agentlib-metadata FILE] [--mcp-sdk-root DIR] [--allow-unprotected-layout]');
    }
    const options = {};
    let index = 0;
    if (command === 'inspect') {
        if (rest[0] !== 'achillesAgentLib') fail('inspect supports only achillesAgentLib');
        index = 1;
    }
    for (; index < rest.length; index += 1) {
        const flag = rest[index];
        if (flag === '--allow-unprotected-layout') {
            options.protectedLayout = false;
            continue;
        }
        const key = FLAGS[flag];
        const value = rest[index + 1];
        if (!key || !value || value.startsWith('--') || key in options) fail(`Invalid argument ${flag}`);
        options[key] = value;
        index += 1;
    }
    return { command, options };
}

async function main() {
    const { command, options } = parseArguments(process.argv.slice(2));
    const result = command === 'inspect' ? await inspectAchillesAgentLib(options)
        : command === 'smoke' ? await runSmoke(options)
            : await runSelfTest(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    main().then(() => process.exit(0), (error) => {
        process.stderr.write(`ploinky-box library check failed: ${error.message}\n`);
        process.exit(1);
    });
}
