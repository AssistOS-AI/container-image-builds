import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_BWRAP_NEVRA = 'bubblewrap-0:0.11.0-4.fc44';
const HELPER = '/usr/local/libexec/ploinky-bwrap-launch';
const SOURCE_SHA = process.env.PLOINKY_SOURCE_SHA || '';
const NATIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const fixtureSource = path.join(NATIVE_DIR, 'fixtures', 'real-provider.mjs');
const evidence = {
    architecture: process.arch,
    bwrap: null,
    helper: null,
    helperFailures: null,
    helperProvider: null,
    helperReadiness: null,
    node: process.version,
    npm: null,
    namespaces: null,
    provider: null,
    signal: null,
};

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        env: options.env || process.env,
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(
        result.status,
        0,
        `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
    return String(result.stdout || '').trim();
}

function waitForExit(child, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}

function waitForPath(target, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            if (fs.existsSync(target)) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`timed out waiting for ${target}`));
                return;
            }
            setTimeout(check, 25);
        };
        check();
    });
}

function namespaceIds() {
    return Object.fromEntries(
        ['user', 'mnt', 'pid', 'ipc', 'uts'].map((name) => [
            name,
            fs.readlinkSync(`/proc/self/ns/${name}`),
        ]),
    );
}

function makeLayout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-bwrap-'));
    const workspace = path.join(root, 'workspace');
    const selected = path.join(workspace, 'project');
    const sibling = path.join(workspace, 'sibling');
    const home = path.join(root, 'home');
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sibling, { mode: 0o700 });
    fs.mkdirSync(path.join(workspace, '.ploinky'), { mode: 0o700 });
    fs.mkdirSync(path.join(workspace, '.data'), { mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(selected, 'identity.txt'), 'retained\n', { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, '.ploinky', 'control-secret'), 'hidden\n', { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, '.data', 'other-home-secret'), 'hidden\n', { mode: 0o600 });
    fs.copyFileSync(fixtureSource, path.join(selected, 'real-provider.mjs'));
    fs.chmodSync(path.join(selected, 'real-provider.mjs'), 0o500);
    return { root, workspace, selected, sibling, home };
}

function bwrapArgs({ signalMode = false } = {}) {
    return [
        '--die-with-parent',
        '--new-session',
        '--unshare-user',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--uid', '1000',
        '--gid', '1000',
        '--clearenv',
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
        '--dir', '/workspace',
        '--ro-bind-fd', '3', '/workspace',
        '--tmpfs', '/workspace/.ploinky',
        '--tmpfs', '/workspace/.data',
        '--bind-fd', '4', '/workspace/project',
        '--dir', '/home',
        '--bind-fd', '6', '/home/agent',
        '--dir', '/run',
        '--dir', '/run/ploinky-agent',
        '--perms', '0400',
        '--ro-bind-data', '5', '/run/ploinky-agent/credential.json',
        '--setenv', 'HOME', '/home/agent',
        '--setenv', 'PATH', '/usr/local/bin:/usr/bin',
        '--setenv', 'PLOINKY_NATIVE_GATE', 'provider',
        '--chdir', '/workspace/project',
        '--',
        '/usr/local/bin/node',
        '/workspace/project/real-provider.mjs',
        ...(signalMode ? ['--wait-for-signal'] : []),
    ];
}

function spawnBwrap(layout, { signalMode = false } = {}) {
    const workspaceFd = fs.openSync(layout.workspace, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const workdirFd = fs.openSync(layout.selected, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const homeFd = fs.openSync(layout.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);

    if (!signalMode) {
        fs.renameSync(layout.selected, path.join(layout.workspace, 'retained-after-open'));
        fs.mkdirSync(layout.selected, { mode: 0o700 });
        fs.writeFileSync(path.join(layout.selected, 'identity.txt'), 'attacker\n', { mode: 0o600 });
    }

    const child = spawn('/usr/bin/bwrap', bwrapArgs({ signalMode }), {
        env: { PLOINKY_SECRET_CANARY: 'must-not-cross-clearenv' },
        stdio: ['ignore', 'pipe', 'pipe', workspaceFd, workdirFd, 'pipe', homeFd],
    });
    fs.closeSync(workspaceFd);
    fs.closeSync(workdirFd);
    fs.closeSync(homeFd);
    child.stdio[5].end('{"generation":"native-gate"}\n');
    return child;
}

function collectOutput(child) {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
        read: () => ({ stdout, stderr }),
    };
}

function encodeRecord(type, payload) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
}

function encodeDescriptor(records) {
    const header = Buffer.alloc(16);
    header.write('PLBWLP01', 0, 'ascii');
    header.writeUInt32BE(records.length, 8);
    return Buffer.concat([header, ...records]);
}

function arg(value) {
    return encodeRecord(1, value);
}

function workspace(access = 1) {
    return encodeRecord(2, Buffer.from([access]));
}

function workdir(relativePath) {
    return encodeRecord(3, relativePath);
}

function home(relativePath) {
    return encodeRecord(4, relativePath);
}

function readOnlyDirectory(source, target) {
    const sourceBytes = Buffer.from(source);
    const targetBytes = Buffer.from(target);
    const payload = Buffer.alloc(5 + sourceBytes.length + targetBytes.length);
    payload[0] = 1;
    payload.writeUInt16BE(sourceBytes.length, 1);
    payload.writeUInt16BE(targetBytes.length, 3);
    sourceBytes.copy(payload, 5);
    targetBytes.copy(payload, 5 + sourceBytes.length);
    return encodeRecord(5, payload);
}

function directory(target) {
    return encodeRecord(6, target);
}

function tmpfs(target) {
    return encodeRecord(7, target);
}

function proc() {
    return encodeRecord(8, Buffer.alloc(0));
}

function dev() {
    return encodeRecord(9, Buffer.alloc(0));
}

function systemSymlink(link) {
    const identifiers = new Map([
        ['/bin', 1],
        ['/sbin', 2],
        ['/lib', 3],
        ['/lib64', 4],
    ]);
    const identifier = identifiers.get(link);
    assert.ok(identifier, `unsupported system symlink: ${link}`);
    return encodeRecord(10, Buffer.from([identifier]));
}

function preexecBarrier(readyWriteFd, releaseReadFd) {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(readyWriteFd, 0);
    payload.writeUInt32BE(releaseReadFd, 4);
    return encodeRecord(11, payload);
}

function helperLaunchDescriptor({ signalMode = false } = {}) {
    return encodeDescriptor([
        arg('--die-with-parent'),
        arg('--new-session'),
        arg('--unshare-user'),
        arg('--unshare-pid'),
        arg('--unshare-ipc'),
        arg('--unshare-uts'),
        arg('--uid'), arg('1000'),
        arg('--gid'), arg('1000'),
        arg('--clearenv'),
        tmpfs('/run'),
        directory('/run/ploinky-agent'),
        arg('--perms'), arg('0400'),
        arg('--ro-bind-data'), arg('4'), arg('/run/ploinky-agent/credential.json'),
        proc(),
        dev(),
        tmpfs('/tmp'),
        readOnlyDirectory('/usr', '/usr'),
        systemSymlink('/bin'),
        systemSymlink('/lib'),
        systemSymlink('/lib64'),
        workspace(1),
        tmpfs('/workspace/.ploinky'),
        tmpfs('/workspace/.data'),
        workdir('project'),
        directory('/home'),
        home('.data/native-helper'),
        preexecBarrier(5, 6),
        arg('--setenv'), arg('HOME'), arg('/home/agent'),
        arg('--setenv'), arg('PATH'), arg('/usr/local/bin:/usr/bin'),
        arg('--setenv'), arg('PLOINKY_NATIVE_GATE'), arg('provider'),
        arg('--chdir'), arg('/workspace/project'),
        arg('--'),
        arg('/usr/local/bin/node'),
        arg('/workspace/project/real-provider.mjs'),
        ...(signalMode ? [arg('--wait-for-signal')] : []),
    ]);
}

const EMPTY_READINESS_SCRIPT = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs');
const workspaceEntries = fs.readdirSync('/workspace').sort();
if (JSON.stringify(workspaceEntries) !== JSON.stringify(['readiness'])) {
    throw new Error('readiness workspace is not empty: ' + workspaceEntries.join(','));
}
if (fs.existsSync('/workspace/phase2-real-workspace-canary')) {
    throw new Error('real workspace content crossed the readiness boundary');
}
if (fs.existsSync('/workspace/.data') || fs.existsSync('/workspace/.ploinky')) {
    throw new Error('workspace control state crossed the readiness boundary');
}
if (fs.readFileSync('/home/agent/readiness-home-marker', 'utf8') !== 'private readiness home\n') {
    throw new Error('readiness HOME was not mounted');
}
if (process.env.PLOINKY_SECRET_CANARY !== undefined) {
    throw new Error('parent environment crossed the readiness boundary');
}
const npm = childProcess.spawnSync('/usr/local/bin/npm', ['--version'], { encoding: 'utf8' });
if (npm.status !== 0 || !/^\d+\.\d+\.\d+$/.test(npm.stdout.trim())) {
    throw new Error('npm readiness failed: ' + npm.status + ': ' + npm.stderr);
}
let nodeWriteCode = null;
try {
    fs.appendFileSync('/usr/local/bin/node', 'must not be written\n');
} catch (error) {
    nodeWriteCode = error.code;
}
if (!['EACCES', 'EROFS', 'EPERM', 'ETXTBSY'].includes(nodeWriteCode)) {
    throw new Error('Node runtime was writable: ' + nodeWriteCode);
}
fs.writeFileSync('/workspace/readiness/readiness-write', 'ready\n', { mode: 0o600 });
fs.writeFileSync('/home/agent/readiness-state', 'ready\n', { mode: 0o600 });
const namespaces = Object.fromEntries(
    ['user', 'mnt', 'pid', 'ipc', 'uts'].map((name) => [name, fs.readlinkSync('/proc/self/ns/' + name)]),
);
const visiblePids = fs.readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
if (!visiblePids.includes(1) || visiblePids.length > 4) {
    throw new Error('readiness /proc is not private: ' + visiblePids.join(','));
}
console.log(JSON.stringify({
    event: 'empty-readiness-complete',
    cwd: process.cwd(),
    home: process.env.HOME,
    node: process.version,
    nodeWriteCode,
    npm: npm.stdout.trim(),
    namespaces,
    visiblePids,
    workspaceEntries,
}));
`;

function helperEmptyReadinessDescriptor() {
    return encodeDescriptor([
        arg('--die-with-parent'),
        arg('--new-session'),
        arg('--unshare-user'),
        arg('--unshare-pid'),
        arg('--unshare-ipc'),
        arg('--unshare-uts'),
        arg('--uid'), arg('1000'),
        arg('--gid'), arg('1000'),
        arg('--clearenv'),
        tmpfs('/run'),
        proc(),
        dev(),
        tmpfs('/tmp'),
        readOnlyDirectory('/usr', '/usr'),
        systemSymlink('/bin'),
        systemSymlink('/lib'),
        systemSymlink('/lib64'),
        tmpfs('/workspace'),
        directory('/workspace/readiness'),
        directory('/home'),
        home('.data/native-readiness'),
        arg('--setenv'), arg('HOME'), arg('/home/agent'),
        arg('--setenv'), arg('PATH'), arg('/usr/local/bin:/usr/bin'),
        arg('--chdir'), arg('/workspace/readiness'),
        arg('--'),
        arg('/usr/local/bin/node'),
        arg('-e'),
        arg(EMPTY_READINESS_SCRIPT),
    ]);
}

function waitForPreexecBarrier(child, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
        let ready = Buffer.alloc(0);
        const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for helper ${child.pid} pre-exec barrier`));
        }, timeoutMs);
        child.stdio[5].on('data', (chunk) => {
            ready = Buffer.concat([ready, chunk]);
            if (ready.length !== 1 || ready[0] !== 0x52) {
                clearTimeout(timer);
                reject(new Error(`helper ${child.pid} emitted invalid pre-exec barrier bytes`));
                return;
            }
            clearTimeout(timer);
            const executable = fs.readlinkSync(`/proc/${child.pid}/exe`);
            assert.equal(path.basename(executable), 'ploinky-bwrap-launch');
            resolve({
                readyByte: 'R',
                releaseByte: 'G',
                state: 'helper-blocked-after-openat2-before-bwrap-exec',
            });
        });
        child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error(`helper ${child.pid} exited before reaching pre-exec barrier`));
        });
    });
}

function processChildren(pid) {
    try {
        const contents = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
        return contents === '' ? [] : contents.split(/\s+/).map(Number);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function processIdentity(pid) {
    const executable = fs.readlinkSync(`/proc/${pid}/exe`);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8')
        .split('\0')
        .filter(Boolean);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const namespaceProcessGroups = status.match(/^NSpgid:\s+(.+)$/m)?.[1]
        .trim()
        .split(/\s+/)
        .map(Number) || [];
    return { pid, executable, argv, processGroup, namespaceProcessGroups, startTime };
}

function providerProcess(rootPid) {
    const pending = [rootPid];
    const seen = new Set();
    while (pending.length > 0) {
        const pid = pending.shift();
        if (seen.has(pid)) {
            continue;
        }
        seen.add(pid);
        try {
            const identity = processIdentity(pid);
            if (path.basename(identity.executable) === 'node' &&
                identity.argv.includes('/workspace/project/real-provider.mjs')) {
                assert.notEqual(pid, rootPid, 'provider command unexpectedly replaced its bwrap supervisor');
                return identity;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        pending.push(...processChildren(pid));
    }
    return null;
}

function signalOwnedProvider(rootPid, expectedIdentity) {
    const currentIdentity = providerProcess(rootPid);
    assert.ok(currentIdentity, `provider ${expectedIdentity.pid} is no longer a descendant of ${rootPid}`);
    assert.equal(currentIdentity.pid, expectedIdentity.pid, 'provider descendant PID changed before signal');
    assert.equal(currentIdentity.startTime, expectedIdentity.startTime, 'provider PID was reused before signal');
    assert.equal(path.basename(currentIdentity.executable), 'node');
    assert.ok(currentIdentity.argv.includes('/workspace/project/real-provider.mjs'));
    assert.ok(Number.isSafeInteger(currentIdentity.pid) && currentIdentity.pid > 1);
    assert.notEqual(currentIdentity.pid, process.pid, 'refusing to signal the native gate process');

    const harnessGroup = processIdentity(process.pid).processGroup;
    const supervisorGroup = processIdentity(rootPid).processGroup;
    const outerNamespaceGroup = currentIdentity.namespaceProcessGroups[0];
    const groupIsOwned = Number.isSafeInteger(currentIdentity.processGroup) &&
        currentIdentity.processGroup > 1 &&
        currentIdentity.processGroup === outerNamespaceGroup &&
        currentIdentity.processGroup !== harnessGroup &&
        currentIdentity.processGroup !== supervisorGroup;

    if (groupIsOwned) {
        process.kill(-currentIdentity.processGroup, 'SIGTERM');
        return 'validated-provider-process-group';
    }

    process.kill(currentIdentity.pid, 'SIGTERM');
    return 'validated-provider-pid';
}

function waitForProviderProcess(rootPid, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            const provider = providerProcess(rootPid);
            if (provider !== null) {
                resolve(provider);
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`timed out locating provider descendant of ${rootPid}`));
                return;
            }
            setTimeout(check, 10);
        };
        check();
    });
}

async function runHelperFailure(descriptor, expectedStatus, expectedCode) {
    const child = spawn(HELPER, [], {
        env: { PLOINKY_SECRET_CANARY: 'must-not-cross-helper' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ignore'],
    });
    const output = collectOutput(child);
    child.stdio[3].on('error', (error) => {
        if (error.code !== 'EPIPE') {
            throw error;
        }
    });
    child.stdio[3].end(descriptor);
    const result = await waitForExit(child);
    const captured = output.read();
    assert.equal(result.code, expectedStatus, `unexpected helper failure: ${captured.stderr}`);
    assert.match(captured.stderr, new RegExp(`^${expectedCode}:`));
    return expectedCode;
}

async function runHelperEmptyReadinessGate() {
    const canaryPath = '/workspace/phase2-real-workspace-canary';
    const dataRoot = '/workspace/.data';
    const readinessHome = `${dataRoot}/native-readiness`;
    const dataRootExisted = fs.existsSync(dataRoot);
    assert.equal(fs.existsSync(canaryPath), false, `readiness canary already exists: ${canaryPath}`);
    assert.equal(fs.existsSync(readinessHome), false, `readiness HOME already exists: ${readinessHome}`);
    fs.mkdirSync(readinessHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(canaryPath, 'must remain outside readiness\n', { mode: 0o600 });
    fs.writeFileSync(`${readinessHome}/readiness-home-marker`, 'private readiness home\n', {
        mode: 0o600,
    });

    try {
        const child = spawn(HELPER, [], {
            env: { PLOINKY_SECRET_CANARY: 'must-not-cross-helper' },
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
        const output = collectOutput(child);
        child.stdio[3].end(helperEmptyReadinessDescriptor());
        const result = await waitForExit(child);
        const captured = output.read();
        assert.equal(
            result.code,
            0,
            `empty-readiness provider failed (${result.code}/${result.signal}): ${captured.stderr}`,
        );
        const readinessLine = captured.stdout.trim().split('\n').find((line) => line.startsWith('{'));
        assert.ok(readinessLine, `empty-readiness provider produced no JSON evidence: ${captured.stdout}`);
        const readiness = JSON.parse(readinessLine);
        assert.equal(readiness.event, 'empty-readiness-complete');
        assert.equal(readiness.cwd, '/workspace/readiness');
        assert.equal(readiness.home, '/home/agent');
        assert.match(readiness.node, /^v24\./);
        assert.match(readiness.npm, /^\d+\.\d+\.\d+$/);
        assert.ok(['EACCES', 'EROFS', 'EPERM', 'ETXTBSY'].includes(readiness.nodeWriteCode));
        assert.deepEqual(readiness.workspaceEntries, ['readiness']);
        assert.equal(fs.readFileSync(canaryPath, 'utf8'), 'must remain outside readiness\n');
        assert.equal(fs.readFileSync(`${readinessHome}/readiness-state`, 'utf8'), 'ready\n');
        assert.equal(fs.existsSync('/workspace/readiness/readiness-write'), false);
        return readiness;
    } finally {
        fs.rmSync(canaryPath, { force: true });
        fs.rmSync(readinessHome, { recursive: true, force: true });
        if (!dataRootExisted) {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    }
}

async function runHelperRetainedInodeGate() {
    const selected = '/workspace/project';
    const retained = '/workspace/retained-after-helper-open';
    const sibling = '/workspace/sibling';
    const protectedState = '/workspace/.ploinky';
    const dataRoot = '/workspace/.data';
    const helperHome = `${dataRoot}/native-helper`;
    const canaryPath = '/tmp/ploinky-native-fd-canary';
    const created = [selected, retained, sibling, protectedState, dataRoot];

    for (const target of created) {
        assert.equal(fs.existsSync(target), false, `native helper gate target already exists: ${target}`);
    }
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sibling, { mode: 0o700 });
    fs.mkdirSync(protectedState, { mode: 0o700 });
    fs.mkdirSync(helperHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${selected}/identity.txt`, 'retained\n', { mode: 0o600 });
    fs.writeFileSync(`${protectedState}/control-secret`, 'hidden\n', { mode: 0o600 });
    fs.writeFileSync(`${dataRoot}/other-home-secret`, 'hidden\n', { mode: 0o600 });
    fs.copyFileSync(fixtureSource, `${selected}/real-provider.mjs`);
    fs.chmodSync(`${selected}/real-provider.mjs`, 0o500);
    fs.writeFileSync(canaryPath, 'must be closed before bwrap exec\n', { mode: 0o600 });
    const canaryFd = fs.openSync(canaryPath, fs.constants.O_RDONLY);

    try {
        const child = spawn(HELPER, [], {
            env: { PLOINKY_SECRET_CANARY: 'must-not-cross-helper' },
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', canaryFd],
        });
        fs.closeSync(canaryFd);
        const output = collectOutput(child);
        child.stdio[3].end(helperLaunchDescriptor());
        const retainedInodeRace = await waitForPreexecBarrier(child);

        fs.renameSync(selected, retained);
        fs.mkdirSync(selected, { mode: 0o700 });
        fs.writeFileSync(`${selected}/identity.txt`, 'attacker\n', { mode: 0o600 });
        child.stdio[4].end('{"generation":"native-gate"}\n');
        child.stdio[6].end('G');

        const result = await waitForExit(child);
        const captured = output.read();
        assert.equal(result.code, 0, `helper provider failed (${result.code}/${result.signal}): ${captured.stderr}`);
        const providerLine = captured.stdout.trim().split('\n').find((line) => line.startsWith('{'));
        assert.ok(providerLine, `helper provider produced no JSON evidence: ${captured.stdout}`);
        const provider = JSON.parse(providerLine);
        assert.equal(fs.readFileSync(`${retained}/provider-write.txt`, 'utf8'), 'provider wrote selected workdir\n');
        assert.equal(fs.existsSync(`${selected}/provider-write.txt`), false, 'helper reopened the swapped workdir path');
        assert.equal(fs.existsSync(`${sibling}/forbidden.txt`), false, 'helper provider wrote a sibling');
        assert.equal(fs.readFileSync(`${helperHome}/provider-state.txt`, 'utf8'), 'provider home state\n');
        return { ...provider, retainedInodeRace };
    } finally {
        try {
            fs.closeSync(canaryFd);
        } catch {}
        fs.rmSync(selected, { recursive: true, force: true });
        fs.rmSync(retained, { recursive: true, force: true });
        fs.rmSync(sibling, { recursive: true, force: true });
        fs.rmSync(protectedState, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(canaryPath, { force: true });
    }
}

async function runHelperSignalGate() {
    const selected = '/workspace/project';
    const sibling = '/workspace/sibling';
    const protectedState = '/workspace/.ploinky';
    const dataRoot = '/workspace/.data';
    const helperHome = `${dataRoot}/native-helper`;
    const created = [selected, sibling, protectedState, dataRoot];

    for (const target of created) {
        assert.equal(fs.existsSync(target), false, `helper signal target already exists: ${target}`);
    }
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sibling, { mode: 0o700 });
    fs.mkdirSync(protectedState, { mode: 0o700 });
    fs.mkdirSync(helperHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${selected}/identity.txt`, 'retained\n', { mode: 0o600 });
    fs.writeFileSync(`${protectedState}/control-secret`, 'hidden\n', { mode: 0o600 });
    fs.writeFileSync(`${dataRoot}/other-home-secret`, 'hidden\n', { mode: 0o600 });
    fs.copyFileSync(fixtureSource, `${selected}/real-provider.mjs`);
    fs.chmodSync(`${selected}/real-provider.mjs`, 0o500);

    try {
        const child = spawn(HELPER, [], {
            env: { PLOINKY_SECRET_CANARY: 'must-not-cross-helper' },
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        });
        const output = collectOutput(child);
        child.stdio[3].end(helperLaunchDescriptor({ signalMode: true }));
        await waitForPreexecBarrier(child);
        child.stdio[4].end('{"generation":"native-gate"}\n');
        child.stdio[6].end('G');
        await waitForPath(`${selected}/signal-ready`);
        const provider = await waitForProviderProcess(child.pid);
        const signalTarget = signalOwnedProvider(child.pid, provider);
        const result = await waitForExit(child);
        const captured = output.read();
        assert.ok(
            result.code === 0 || result.signal === 'SIGTERM',
            `signalled helper/bwrap failed (${result.code}/${result.signal}): ${captured.stderr}`,
        );
        assert.equal(fs.readFileSync(`${selected}/signal-stopped`, 'utf8'), 'SIGTERM\n');
        return {
            signalTarget,
            supervisorResult: result.code === 0 ? 'exit-0' : result.signal,
        };
    } finally {
        fs.rmSync(selected, { recursive: true, force: true });
        fs.rmSync(sibling, { recursive: true, force: true });
        fs.rmSync(protectedState, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

assert.match(SOURCE_SHA, /^[0-9a-f]{40}$/, 'PLOINKY_SOURCE_SHA must be an exact lowercase source SHA');
assert.equal(process.getuid(), 1000, 'native gate must run as the image podman user');
assert.equal(process.getgid(), 1000, 'native gate must run as the image podman group');
const outerNamespaces = namespaceIds();

const expectedArch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
assert.ok(expectedArch, `unsupported native architecture: ${process.arch}`);
evidence.bwrap = run('rpm', ['-q', '--qf', '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}', 'bubblewrap']);
assert.equal(evidence.bwrap, `${EXPECTED_BWRAP_NEVRA}.${expectedArch}`);

const bwrapHelp = run('/usr/bin/bwrap', ['--help']);
for (const requiredOption of ['--bind-fd', '--ro-bind-fd', '--ro-bind-data', '--perms']) {
    assert.match(bwrapHelp, new RegExp(`(^|\\s)${requiredOption.replaceAll('-', '\\-')}(\\s|$)`));
}
assert.equal(run('stat', ['-c', '%a:%u:%g', '/usr/bin/bwrap']), '755:0:0');
assert.equal(run('getcap', ['/usr/bin/bwrap']), '');

evidence.helper = run(HELPER, ['--version']);
assert.equal(evidence.helper, `ploinky-bwrap-launch-v1 source-sha=${SOURCE_SHA}`);
const helperCapabilities = run(HELPER, ['--capabilities']);
assert.match(helperCapabilities, /protocol=1 descriptor-fd=3/);
assert.match(helperCapabilities, /path-resolution=openat2-beneath-no-magiclinks-no-symlinks/);
assert.match(helperCapabilities, /bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms/);
assert.match(helperCapabilities, /typed-fs=dir,tmpfs,proc,dev,system-symlink/);
assert.match(helperCapabilities, /preexec-barrier=R\/G/);
assert.match(helperCapabilities, /credential-bound=4096/);
assert.equal(run('stat', ['-c', '%a:%u:%g', HELPER]), '755:0:0');
assert.equal(run('getcap', [HELPER]), '');

const helperFailures = [];
helperFailures.push(await runHelperFailure(Buffer.alloc(16), 64, 'PLOINKY_BWRAP_PROTOCOL_INVALID'));
helperFailures.push(await runHelperFailure(Buffer.alloc((256 * 1024) + 1, 0x41), 65, 'PLOINKY_BWRAP_PROTOCOL_TOO_LARGE'));
helperFailures.push(await runHelperFailure(
    encodeDescriptor([arg('--tmpfs'), arg('/tmp'), arg('--'), arg('/usr/bin/true')]),
    64,
    'PLOINKY_BWRAP_OPTION_FORBIDDEN',
));
helperFailures.push(await runHelperFailure(
    encodeDescriptor([directory('/workspace/readiness'), arg('--'), arg('/usr/bin/true')]),
    64,
    'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
));
helperFailures.push(await runHelperFailure(
    encodeDescriptor([workdir('.'), arg('--'), arg('/usr/bin/true')]),
    71,
    'PLOINKY_WORKDIR_ROOT_FORBIDDEN',
));
helperFailures.push(await runHelperFailure(
    encodeDescriptor([workdir('.data/not-a-project'), arg('--'), arg('/usr/bin/true')]),
    72,
    'PLOINKY_WORKDIR_INVALID',
));
const symlinkTarget = '/workspace/helper-symlink-target';
const symlinkPath = '/workspace/helper-symlink';
fs.mkdirSync(symlinkTarget, { mode: 0o700 });
fs.symlinkSync('helper-symlink-target', symlinkPath);
try {
    helperFailures.push(await runHelperFailure(
        encodeDescriptor([workspace(1), workdir('helper-symlink'), arg('--'), arg('/usr/bin/true')]),
        72,
        'PLOINKY_WORKDIR_INVALID',
    ));
} finally {
    fs.rmSync(symlinkPath, { force: true });
    fs.rmSync(symlinkTarget, { recursive: true, force: true });
}
evidence.helperFailures = helperFailures;
evidence.helperReadiness = await runHelperEmptyReadinessGate();
for (const name of ['user', 'mnt', 'pid', 'ipc', 'uts']) {
    assert.notEqual(
        evidence.helperReadiness.namespaces[name],
        outerNamespaces[name],
        `empty-readiness helper inherited the outer ${name} namespace`,
    );
}
evidence.helperProvider = await runHelperRetainedInodeGate();
for (const name of ['user', 'mnt', 'pid', 'ipc', 'uts']) {
    assert.notEqual(
        evidence.helperProvider.namespaces[name],
        outerNamespaces[name],
        `helper provider inherited the outer ${name} namespace`,
    );
}
const helperSignal = await runHelperSignalGate();

for (const command of ['bash', 'curl', 'ffmpeg', 'git', 'ssh', 'python3', 'script', 'unshare', 'ps', 'setsid', 'timeout']) {
    assert.notEqual(run('sh', ['-lc', `command -v ${command}`]), '');
}
for (const forbiddenCompiler of ['cc', 'gcc', 'clang']) {
    const result = spawnSync('sh', ['-lc', `command -v ${forbiddenCompiler}`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${forbiddenCompiler} leaked into the runtime image`);
}
assert.match(process.version, /^v24\./);
evidence.npm = run('/usr/local/bin/npm', ['--version']);
assert.match(evidence.npm, /^\d+\.\d+\.\d+$/);
run('/usr/bin/unshare', ['--user', '--map-current-user', '--pid', '--fork', '--mount-proc', '/usr/bin/true']);

const layout = makeLayout();
try {
    const child = spawnBwrap(layout);
    const output = collectOutput(child);
    const result = await waitForExit(child);
    const captured = output.read();
    assert.equal(result.code, 0, `provider bwrap failed (${result.code}/${result.signal}): ${captured.stderr}`);
    const providerLine = captured.stdout.trim().split('\n').find((line) => line.startsWith('{'));
    assert.ok(providerLine, `provider produced no JSON evidence: ${captured.stdout}`);
    evidence.provider = JSON.parse(providerLine);
    evidence.namespaces = evidence.provider.namespaces;
    for (const name of ['user', 'mnt', 'pid', 'ipc', 'uts']) {
        assert.notEqual(evidence.namespaces[name], outerNamespaces[name], `${name} namespace was inherited`);
    }
    assert.equal(fs.readFileSync(path.join(layout.workspace, 'retained-after-open', 'provider-write.txt'), 'utf8'), 'provider wrote selected workdir\n');
    assert.equal(fs.existsSync(path.join(layout.selected, 'provider-write.txt')), false, 'path swap selected the attacker directory');
    assert.equal(fs.existsSync(path.join(layout.sibling, 'forbidden.txt')), false, 'provider wrote a sibling directory');
    assert.equal(fs.readFileSync(path.join(layout.home, 'provider-state.txt'), 'utf8'), 'provider home state\n');
} finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
}

const signalLayout = makeLayout();
try {
    const child = spawnBwrap(signalLayout, { signalMode: true });
    const output = collectOutput(child);
    await waitForPath(path.join(signalLayout.selected, 'signal-ready'));
    const provider = await waitForProviderProcess(child.pid);
    const signalTarget = signalOwnedProvider(child.pid, provider);
    const result = await waitForExit(child);
    const captured = output.read();
    assert.ok(
        result.code === 0 || result.signal === 'SIGTERM',
        `signalled bwrap failed (${result.code}/${result.signal}): ${captured.stderr}`,
    );
    assert.equal(fs.readFileSync(path.join(signalLayout.selected, 'signal-stopped'), 'utf8'), 'SIGTERM\n');
    evidence.signal = {
        directBwrap: {
            signalTarget,
            supervisorResult: result.code === 0 ? 'exit-0' : result.signal,
        },
        helperBwrap: helperSignal,
        providerObserved: 'SIGTERM-clean',
    };
} finally {
    fs.rmSync(signalLayout.root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ event: 'ploinky-box-bwrap-native-gate', ...evidence })}\n`);
