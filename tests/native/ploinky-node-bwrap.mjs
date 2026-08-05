import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_BUBBLEWRAP_VERSION = '0.8.0-2+deb12u1';
const HELPER = '/usr/local/libexec/ploinky-bwrap-launch';
const SOURCE_SHA = process.env.PLOINKY_SOURCE_SHA || '';
const NATIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = path.join(NATIVE_DIR, 'fixtures', 'real-provider.mjs');
const WORKSPACE = '/workspace';
const HELPER_CAPABILITIES =
    `ploinky-bwrap-launch-v2 source-sha=${SOURCE_SHA} protocol=2 descriptor-fd=3 `
    + 'path-resolution=openat2-beneath-no-magiclinks-no-symlinks '
    + 'bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms '
    + 'typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file '
    + 'ro-data-path-hardening=sealed-memfd-ro-bind-data '
    + 'home-sources=sandbox-workspace-v2,container-native '
    + 'home-marker=ploinky-home-v2-schema-2 home-revalidation=post-barrier-G '
    + 'preexec-barrier=R/G credential-bound=4096';

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

function encodeRecord(type, payload) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
}

function encodeDescriptor(records) {
    const header = Buffer.alloc(16);
    header.write('PLBWLP02', 0, 'ascii');
    header.writeUInt32BE(records.length, 8);
    return Buffer.concat([header, ...records]);
}

const arg = (value) => encodeRecord(1, value);
const workspace = (access = 1) => encodeRecord(2, Buffer.from([access]));
const workdir = (relativePath) => encodeRecord(3, relativePath);
const containerNativeHome = () => encodeRecord(4, Buffer.from([2]));
const directory = (target) => encodeRecord(6, target);
const tmpfs = (target) => encodeRecord(7, target);
const proc = () => encodeRecord(8, Buffer.alloc(0));
const dev = () => encodeRecord(9, Buffer.alloc(0));
const systemSymlink = (identifier) => encodeRecord(10, Buffer.from([identifier]));

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

function preexecBarrier(readyWriteFd, releaseReadFd) {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(readyWriteFd, 0);
    payload.writeUInt32BE(releaseReadFd, 4);
    return encodeRecord(11, payload);
}

function providerDescriptor({ signalMode = false } = {}) {
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
        arg('--ro-bind-data'), arg('6'), arg('/run/ploinky-agent/credential.json'),
        proc(),
        dev(),
        tmpfs('/tmp'),
        readOnlyDirectory('/usr', '/usr'),
        systemSymlink(1),
        systemSymlink(2),
        systemSymlink(3),
        systemSymlink(4),
        workspace(1),
        tmpfs('/workspace/.ploinky'),
        tmpfs('/workspace/.data'),
        workdir('project'),
        directory('/home'),
        containerNativeHome(),
        preexecBarrier(4, 5),
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

function waitForExit(child, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}

function waitForBarrier(stream, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('helper pre-exec barrier timed out')), timeoutMs);
        stream.once('data', (chunk) => {
            clearTimeout(timer);
            assert.equal(chunk.toString(), 'R');
            resolve();
        });
        stream.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function namespaces() {
    return Object.fromEntries(
        ['user', 'mnt', 'pid', 'ipc', 'uts'].map((name) => [
            name,
            fs.readlinkSync(`/proc/self/ns/${name}`),
        ]),
    );
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
            setTimeout(check, 10);
        };
        check();
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
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return {
        pid,
        executable,
        argv,
        processGroup: Number(fields[2]),
        startTime: fields[19],
        namespaceProcessGroups: status.match(/^NSpgid:\s+(.+)$/m)?.[1]
            .trim()
            .split(/\s+/)
            .map(Number) || [],
    };
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
            if (path.basename(identity.executable) === 'node'
                && identity.argv.includes('/workspace/project/real-provider.mjs')
                && identity.argv.includes('--wait-for-signal')) {
                assert.notEqual(pid, rootPid, 'provider replaced its bwrap supervisor');
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

function signalOwnedProvider(rootPid, expectedIdentity) {
    const currentIdentity = providerProcess(rootPid);
    assert.ok(currentIdentity, `provider ${expectedIdentity.pid} is no longer owned by ${rootPid}`);
    assert.equal(currentIdentity.pid, expectedIdentity.pid, 'provider descendant PID changed');
    assert.equal(currentIdentity.startTime, expectedIdentity.startTime, 'provider PID was reused');
    assert.equal(path.basename(currentIdentity.executable), 'node');
    assert.ok(currentIdentity.argv.includes('/workspace/project/real-provider.mjs'));
    assert.ok(Number.isSafeInteger(currentIdentity.pid) && currentIdentity.pid > 1);
    assert.notEqual(currentIdentity.pid, process.pid, 'refusing to signal the gate process');

    const harnessGroup = processIdentity(process.pid).processGroup;
    const supervisorGroup = processIdentity(rootPid).processGroup;
    const outerNamespaceGroup = currentIdentity.namespaceProcessGroups[0];
    const groupIsOwned = Number.isSafeInteger(currentIdentity.processGroup)
        && currentIdentity.processGroup > 1
        && currentIdentity.processGroup === outerNamespaceGroup
        && currentIdentity.processGroup !== harnessGroup
        && currentIdentity.processGroup !== supervisorGroup;
    if (groupIsOwned) {
        process.kill(-currentIdentity.processGroup, 'SIGTERM');
        return 'validated-provider-process-group';
    }
    process.kill(currentIdentity.pid, 'SIGTERM');
    return 'validated-provider-pid';
}

assert.match(SOURCE_SHA, /^[0-9a-f]{40}$/, 'PLOINKY_SOURCE_SHA must be an exact source commit');
assert.equal(process.getuid(), 1000, 'coding-image native gate must run as UID 1000');
assert.equal(process.getgid(), 1000, 'coding-image native gate must run as GID 1000');
assert.equal(fs.statSync(WORKSPACE).uid, 1000, '/workspace must be owned by the service user');
assert.equal(fs.statSync('/root').uid, 1000, 'container-native HOME must be owned by the service user');
assert.equal(fs.statSync('/root').gid, 1000, 'container-native HOME must use the service group');
assert.equal(fs.statSync('/root').mode & 0o777, 0o700, 'container-native HOME must use mode 0700');

const expectedArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
assert.ok(['amd64', 'arm64'].includes(expectedArchitecture), `unsupported architecture ${process.arch}`);
assert.equal(
    run('dpkg-query', ['-W', '-f=${Version}', 'bubblewrap']),
    EXPECTED_BUBBLEWRAP_VERSION,
);
const bwrapHelp = run('/usr/bin/bwrap', ['--help']);
for (const requiredOption of ['--bind-fd', '--ro-bind-fd', '--ro-bind-data', '--perms']) {
    assert.match(bwrapHelp, new RegExp(`(^|\\s)${requiredOption.replaceAll('-', '\\-')}(\\s|$)`));
}
assert.equal(run('stat', ['-c', '%a:%u:%g', '/usr/bin/bwrap']), '755:0:0');
assert.equal(run('getcap', ['/usr/bin/bwrap']), '');
assert.equal(run(HELPER, ['--version']), `ploinky-bwrap-launch-v2 source-sha=${SOURCE_SHA}`);
assert.equal(run(HELPER, ['--capabilities']), HELPER_CAPABILITIES);
assert.equal(run('stat', ['-c', '%a:%u:%g', HELPER]), '755:0:0');
assert.equal(run('getcap', [HELPER]), '');
for (const command of ['node', 'npm', 'bash', 'curl', 'ffmpeg', 'git', 'ssh', 'python3', 'make', 'g++', 'script', 'unshare', 'ps', 'setsid', 'timeout']) {
    assert.notEqual(run('sh', ['-lc', `command -v ${command}`]), '');
}
assert.match(process.version, /^v24\./);
const npmVersion = run('npm', ['--version']);
assert.match(npmVersion, /^\d+\.\d+\.\d+$/);

const outerStatus = fs.readFileSync('/proc/self/status', 'utf8');
for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    assert.equal(
        outerStatus.match(new RegExp(`^${field}:\\s+([0-9a-f]+)$`, 'm'))?.[1],
        '0000000000000000',
        `${field} must be empty at the native gate boundary`,
    );
}
assert.equal(
    outerStatus.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1],
    '1',
    'native gate must run with no-new-privileges',
);

fs.mkdirSync(path.join(WORKSPACE, 'project'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(WORKSPACE, 'sibling'), { mode: 0o700 });
fs.mkdirSync(path.join(WORKSPACE, '.ploinky'), { mode: 0o700 });
fs.mkdirSync(path.join(WORKSPACE, '.data'), { mode: 0o700 });
fs.writeFileSync(path.join(WORKSPACE, 'project', 'identity.txt'), 'retained\n', { mode: 0o600 });
fs.writeFileSync(path.join(WORKSPACE, '.ploinky', 'control-secret'), 'hidden\n', { mode: 0o600 });
fs.writeFileSync(path.join(WORKSPACE, '.data', 'other-home-secret'), 'hidden\n', { mode: 0o600 });
fs.copyFileSync(FIXTURE_SOURCE, path.join(WORKSPACE, 'project', 'real-provider.mjs'));
fs.chmodSync(path.join(WORKSPACE, 'project', 'real-provider.mjs'), 0o500);

const outerNamespaces = namespaces();
const fdCanaryPath = '/tmp/ploinky-native-fd-canary';
fs.writeFileSync(fdCanaryPath, 'must not reach provider\n', { mode: 0o600 });
const fdCanaryFd = fs.openSync(fdCanaryPath, 'r');
const child = spawn(HELPER, [], {
    env: { PLOINKY_SECRET_CANARY: 'must-not-cross-clearenv' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', fdCanaryFd],
});
fs.closeSync(fdCanaryFd);
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdio[3].end(providerDescriptor());
child.stdio[6].end('{"generation":"native-gate"}\n');

await waitForBarrier(child.stdio[4]);
fs.renameSync(path.join(WORKSPACE, 'project'), path.join(WORKSPACE, 'retained-after-open'));
fs.mkdirSync(path.join(WORKSPACE, 'project'), { mode: 0o700 });
fs.writeFileSync(path.join(WORKSPACE, 'project', 'identity.txt'), 'attacker\n', { mode: 0o600 });
child.stdio[5].end('G');

const result = await waitForExit(child);
assert.equal(result.code, 0, `helper/provider failed (${result.code}/${result.signal}): ${stderr}`);
const providerLine = stdout.trim().split('\n').find((line) => line.startsWith('{'));
assert.ok(providerLine, `provider emitted no JSON evidence: ${stdout}`);
const provider = JSON.parse(providerLine);
for (const name of ['user', 'mnt', 'pid', 'ipc', 'uts']) {
    assert.notEqual(provider.namespaces[name], outerNamespaces[name], `${name} namespace was inherited`);
}
assert.equal(
    fs.readFileSync(path.join(WORKSPACE, 'retained-after-open', 'provider-write.txt'), 'utf8'),
    'provider wrote selected workdir\n',
);
assert.equal(fs.existsSync(path.join(WORKSPACE, 'project', 'provider-write.txt')), false);
assert.equal(fs.existsSync(path.join(WORKSPACE, 'sibling', 'forbidden.txt')), false);
assert.equal(
    fs.readFileSync('/root/provider-state.txt', 'utf8'),
    'provider home state\n',
);

fs.rmSync(path.join(WORKSPACE, 'project'), { recursive: true });
fs.renameSync(path.join(WORKSPACE, 'retained-after-open'), path.join(WORKSPACE, 'project'));

fs.rmSync(path.join(WORKSPACE, 'project', 'provider-write.txt'), { force: true });
const symlinkChild = spawn(HELPER, [], {
    env: { PLOINKY_SECRET_CANARY: 'must-not-cross-clearenv' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
});
let symlinkStdout = '';
let symlinkStderr = '';
symlinkChild.stdout.setEncoding('utf8');
symlinkChild.stderr.setEncoding('utf8');
symlinkChild.stdout.on('data', (chunk) => { symlinkStdout += chunk; });
symlinkChild.stderr.on('data', (chunk) => { symlinkStderr += chunk; });
symlinkChild.stdio[3].end(providerDescriptor());
symlinkChild.stdio[6].end('{"generation":"native-gate"}\n');
await waitForBarrier(symlinkChild.stdio[4]);
fs.renameSync(
    path.join(WORKSPACE, 'project'),
    path.join(WORKSPACE, 'retained-after-symlink-open'),
);
fs.symlinkSync('sibling', path.join(WORKSPACE, 'project'));
symlinkChild.stdio[5].end('G');
const symlinkResult = await waitForExit(symlinkChild);
let postOpenSymlinkSwap = 'retained-inode';
if (symlinkResult.code === 0) {
    assert.match(symlinkStdout, /"event":"provider-complete"/);
    assert.equal(
        fs.readFileSync(
            path.join(WORKSPACE, 'retained-after-symlink-open', 'provider-write.txt'),
            'utf8',
        ),
        'provider wrote selected workdir\n',
    );
} else {
    postOpenSymlinkSwap = 'failed-closed';
    assert.equal(symlinkResult.code, 1, symlinkStderr);
    assert.match(symlinkStderr, /Race condition binding dirfd/);
    assert.doesNotMatch(symlinkStderr, /Cannot find module|MODULE_NOT_FOUND/);
}
assert.equal(fs.existsSync(path.join(WORKSPACE, 'sibling', 'provider-write.txt')), false);
fs.unlinkSync(path.join(WORKSPACE, 'project'));
fs.renameSync(
    path.join(WORKSPACE, 'retained-after-symlink-open'),
    path.join(WORKSPACE, 'project'),
);

const signalChild = spawn(HELPER, [], {
    env: { PLOINKY_SECRET_CANARY: 'must-not-cross-clearenv' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
});
let signalStderr = '';
signalChild.stderr.setEncoding('utf8');
signalChild.stderr.on('data', (chunk) => { signalStderr += chunk; });
signalChild.stdio[3].end(providerDescriptor({ signalMode: true }));
signalChild.stdio[6].end('{"generation":"native-gate"}\n');
await waitForBarrier(signalChild.stdio[4]);
signalChild.stdio[5].end('G');
await waitForPath(path.join(WORKSPACE, 'project', 'signal-ready'));
const expectedSignalIdentity = await waitForProviderProcess(signalChild.pid);
const signalTarget = signalOwnedProvider(signalChild.pid, expectedSignalIdentity);
const signalResult = await waitForExit(signalChild);
assert.ok(
    signalResult.code === 0 || signalResult.signal === 'SIGTERM',
    `signalled provider failed (${signalResult.code}/${signalResult.signal}): ${signalStderr}`,
);
assert.equal(
    fs.readFileSync(path.join(WORKSPACE, 'project', 'signal-stopped'), 'utf8'),
    'SIGTERM\n',
);

fs.symlinkSync('project', path.join(WORKSPACE, 'symlink-project'));
const rejected = spawn(HELPER, [], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let rejectedStderr = '';
rejected.stderr.setEncoding('utf8');
rejected.stderr.on('data', (chunk) => { rejectedStderr += chunk; });
rejected.stdio[3].end(encodeDescriptor([
    workspace(1),
    workdir('symlink-project'),
    arg('--'),
    arg('/usr/bin/true'),
]));
const rejectedResult = await waitForExit(rejected);
assert.equal(rejectedResult.code, 72, `symlink launch returned ${rejectedResult.code}: ${rejectedStderr}`);
assert.match(rejectedStderr, /PLOINKY_WORKDIR_INVALID/);

process.stdout.write(`${JSON.stringify({
    event: 'ploinky-node-bwrap-native-gate',
    architecture: expectedArchitecture,
    sourceSha: SOURCE_SHA,
    bubblewrap: EXPECTED_BUBBLEWRAP_VERSION,
    helper: HELPER_CAPABILITIES,
    node: process.version,
    npm: npmVersion,
    provider,
    retainedSource: true,
    postOpenSymlinkSwap,
    signal: {
        target: signalTarget,
        providerObserved: 'SIGTERM-clean',
    },
    symlinkRejected: true,
})}\n`);
