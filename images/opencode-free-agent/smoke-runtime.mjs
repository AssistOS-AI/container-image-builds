import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run in a fresh candidate container with networking disabled. No credential
// is supplied and no inference command is run: `debug agent chat --pure` only
// resolves the baked configuration into the agent the CLI would use.
const CLI = '/opt/opencode/bin/opencode';
const CONFIG_HOME = '/opt/opencode-free/config';
const CONFIG_DIRECTORY = `${CONFIG_HOME}/opencode`;
const CONFIG_FILE = `${CONFIG_DIRECTORY}/opencode.json`;
const SOURCE_CONTRACT = '/opt/opencode-free/source.contract';
const EXPECTED_TOOLS = ['bash', 'edit', 'glob', 'grep', 'invalid', 'question', 'read',
    'skill', 'task', 'todowrite', 'webfetch', 'websearch', 'write'];
const WILDCARD_ASK = { permission: '*', action: 'ask', pattern: '*' };

async function isWritable(target) {
    try {
        await fs.access(target, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

async function sha256File(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

// Parse rule for `opencode debug agent chat --pure` (OpenCode 1.18.31): stdout
// is one JSON object. Enabled tools are the keys of `.tools` whose value is
// `true`. `.permission` is an ordered rule list; the CLI appends its own
// `external_directory` allow rules after the configured ones, so the rule that
// governs every other permission is the last element whose `.permission` is
// `*`. That rule must be the wildcard ask, and only `external_directory` rules
// may follow it.
function parseResolvedAgent(stdout) {
    const agent = JSON.parse(stdout);
    assert.equal(agent.name, 'chat', 'debug agent must resolve the chat agent');
    assert.ok(agent.tools && typeof agent.tools === 'object', 'debug agent output has no tools map');
    assert.ok(Array.isArray(agent.permission), 'debug agent output has no permission list');
    const resolvedTools = Object.entries(agent.tools)
        .filter(([, enabled]) => enabled === true).map(([name]) => name).sort();
    const index = agent.permission.findLastIndex((rule) => rule?.permission === '*');
    assert.notEqual(index, -1, 'debug agent output has no wildcard permission rule');
    const rule = agent.permission[index];
    const lastPermissionRule = { permission: rule.permission, action: rule.action, pattern: rule.pattern };
    const trailingPermissions = agent.permission.slice(index + 1).map((entry) => entry?.permission);
    return { resolvedTools, lastPermissionRule, trailingPermissions };
}

const root = await fs.mkdtemp('/var/tmp/opencode-free/proof-');
try {
    assert.equal(process.getuid(), 1000, 'OpenCode runtime must use UID 1000');
    assert.equal(process.getgid(), 1000, 'OpenCode runtime must use GID 1000');
    const status = await fs.readFile('/proc/self/status', 'utf8');
    assert.match(status, /^CapEff:\s*0000000000000000$/m);
    assert.match(status, /^NoNewPrivs:\s*1$/m);
    const networkInterfaces = Object.keys(os.networkInterfaces());
    assert.deepEqual(networkInterfaces, ['lo'], 'Runtime proof requires network isolation');

    const contract = Object.fromEntries((await fs.readFile(SOURCE_CONTRACT, 'utf8')).trim().split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(contract.cli_version, '1.18.31');
    assert.match(contract.binary_sha256, /^[0-9a-f]{64}$/);
    const binarySha256 = await sha256File(CLI);
    assert.equal(binarySha256, contract.binary_sha256, 'CLI binary does not match source.contract');

    const configDirectory = await fs.stat(CONFIG_DIRECTORY);
    const configFile = await fs.stat(CONFIG_FILE);
    assert.equal(configDirectory.uid, 0);
    assert.equal(configFile.uid, 0);
    assert.equal(configDirectory.mode & 0o7777, 0o555);
    assert.equal(configFile.mode & 0o7777, 0o444);
    const configReadOnly = !(await isWritable(CONFIG_HOME)) && !(await isWritable(CONFIG_DIRECTORY))
        && !(await isWritable(CONFIG_FILE));
    assert.equal(configReadOnly, true, 'Baked OpenCode configuration must not be writable');
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    assert.deepEqual(config.permission, { '*': 'ask' });
    assert.equal(config.default_agent, 'chat');
    assert.equal(Object.hasOwn(config, 'tools'), false);

    // The throwaway root holds every writable CLI location; the configuration
    // stays the baked read-only one.
    for (const directory of ['home', 'data', 'state', 'cache', 'tmp', 'work']) {
        await fs.mkdir(path.join(root, directory), { mode: 0o700 });
    }
    const env = {
        PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), XDG_CONFIG_HOME: CONFIG_HOME,
        XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
        XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: path.join(root, 'tmp'),
        LANG: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    };
    const run = (args) => {
        const result = spawnSync(CLI, args, {
            cwd: path.join(root, 'work'), env, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
        });
        if (result.status !== 0) process.stderr.write(`opencode ${args.join(' ')} stderr (bounded tail):\n${String(result.stderr).slice(-4096)}\n`);
        assert.equal(result.error, undefined, `opencode ${args.join(' ')} could not run`);
        assert.equal(result.status, 0, `opencode ${args.join(' ')} failed`);
        return result.stdout;
    };
    const cliVersion = run(['--version']).trim();
    assert.equal(cliVersion, '1.18.31');
    const { resolvedTools, lastPermissionRule, trailingPermissions } = parseResolvedAgent(run(['debug', 'agent', 'chat', '--pure']));
    assert.deepEqual(resolvedTools, EXPECTED_TOOLS);
    assert.deepEqual(lastPermissionRule, WILDCARD_ASK);
    assert.ok(trailingPermissions.every((permission) => permission === 'external_directory'),
        'Only external_directory rules may follow the wildcard ask rule');
    assert.deepEqual(await fs.readdir(CONFIG_DIRECTORY), ['opencode.json'], 'CLI must not write into the baked configuration');

    process.stdout.write(`${JSON.stringify({
        schema: 'ploinky.opencode-free-runtime/v1', ok: true, uid: process.getuid(), gid: process.getgid(),
        noNewPrivileges: true, capabilities: '0000000000000000', networkInterfaces,
        cliVersion, binarySha256, configReadOnly, resolvedTools, lastPermissionRule,
    }, null, 2)}\n`);
} finally {
    await fs.rm(root, { recursive: true, force: true });
}
