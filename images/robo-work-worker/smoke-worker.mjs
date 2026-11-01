#!/usr/bin/env node
// Image smoke: tool versions, Bubblewrap flags and the node-pty contract.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createContract } from './environment-contract.mjs';

const failures = [];
const run = (cmd, args) => {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
        failures.push(`${cmd} ${args.join(' ')}: ${error.message.split('\n')[0]}`);
        return '';
    }
};
const first = (text) => text.split('\n')[0];
const report = (name, value) => console.log(`${name}: ${value}`);

report('node', process.version);
if (!process.version.startsWith('v24.')) failures.push(`node major ${process.version}`);
report('npm', run('npm', ['--version']));
report('git', first(run('git', ['--version'])));
report('curl', first(run('curl', ['--version'])));
report('rg', first(run('rg', ['--version'])));
report('bash', first(run('bash', ['--version'])));
report('sh', fs.realpathSync('/bin/sh'));
report('python3', first(run('python3', ['--version'])));

const bwrapVersion = run('/usr/bin/bwrap', ['--version']);
report('bwrap', bwrapVersion);
const match = /(\d+)\.(\d+)\.(\d+)/.exec(bwrapVersion);
if (!match || Number(match[1]) !== 0 || Number(match[2]) < 11) failures.push(`bubblewrap < 0.11: ${bwrapVersion}`);
const help = run('/usr/bin/bwrap', ['--help']);
for (const flag of ['--args', '--bind-fd', '--ro-bind-fd', '--disable-userns', '--assert-userns-disabled',
    '--block-fd', '--info-fd', '--json-status-fd', '--seccomp', '--hostname', '--unshare-cgroup-try']) {
    if (!help.includes(flag)) failures.push(`bwrap --help lacks ${flag}`);
}
report('bwrap-flags', 'checked');

for (const tool of ['setpriv', 'unshare', 'nsenter', 'mount']) {
    report(tool, first(run(tool, ['--version'])));
}
report('ip', run('ip', ['-V']));
report('nft', run('nft', ['--version']));
report('codex', first(run('codex', ['--version'])));
report('claude', first(run('claude', ['--version'])));
report('opencode', first(run('opencode', ['--version'])));
report('pi', first(run('pi', ['--version'])));

const pluginPkg = JSON.parse(fs.readFileSync('/opt/robo-work-tools/node_modules/@opencode-ai/plugin/package.json', 'utf8'));
report('@opencode-ai/plugin', pluginPkg.version);

const podmanVersion = run('/usr/bin/podman', ['--version']);
report('podman', podmanVersion);
if (podmanVersion !== 'podman version 5.8.9') failures.push(`unexpected Podman version ${podmanVersion}`);
const sources = JSON.parse(fs.readFileSync('/usr/local/share/ploinky/robo-work-worker-sources.json', 'utf8'));
const rpmArch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
for (const name of ['podman', 'containers-common', 'crun', 'conmon', 'fuse-overlayfs']) {
    const version = sources.distributionPackages.packages[name];
    const expected = `${name}-${version}${version.endsWith('.noarch') ? '' : `.${rpmArch}`}`;
    const actual = run('rpm', ['-q', '--qf', '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}', name]);
    if (actual !== expected) failures.push(`package mismatch: ${actual}; expected ${expected}`);
}
for (const absent of ['/usr/bin/cargo', '/usr/bin/rustc']) {
    if (fs.existsSync(absent)) failures.push(`${absent} must not be present`);
}

try {
    const contract = JSON.parse(fs.readFileSync('/opt/robo-work-runtime/environment-contract.json', 'utf8'));
    if (JSON.stringify(contract) !== JSON.stringify(createContract())) failures.push('Environment contract differs from injected ELF requirements');
    report('GLIBC_FLOOR', contract.glibcFloor);
    report('GLIBCXX', contract.glibcxxVersions.join(','));
    report('CXXABI', contract.cxxabiVersions.join(','));
    for (const [name, target] of Object.entries(contract.wrapperTargets)) {
        fs.accessSync(target, fs.constants.R_OK);
        report(`wrapper ${name}`, `${contract.injections.bin}/${name} -> ${target.replace('/opt/robo-work-tools', contract.injections.tools)}`);
    }
    fs.accessSync(contract.caBundle, fs.constants.R_OK);
    for (const file of ['/opt/robo-work-runtime/ca', contract.caBundle, '/opt/robo-work-runtime/environment-contract.json']) {
        const stat = fs.statSync(file);
        if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o222)) failures.push(`mutable or non-root Environment injection ${file}`);
    }
    const storage = fs.readFileSync('/etc/containers/storage.conf', 'utf8');
    for (const line of ['driver = "overlay"', 'graphroot = "/var/lib/robo-work/podman/storage"', 'runroot = "/run/robo-work-podman"']) {
        if (!storage.includes(line)) failures.push(`storage config lacks ${line}`);
    }
    const registries = fs.readFileSync('/etc/containers/registries.conf', 'utf8');
    if (!registries.includes('unqualified-search-registries = []') || !registries.includes('short-name-mode = "enforcing"')) failures.push('registry short-name policy missing');
} catch (error) {
    failures.push(`Environment contract: ${error.message}`);
}

// Ploinky's terminal worker runs the probe as uid 1000.
if (process.getuid() === 0) {
    const probe = run('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups',
        'node', '/usr/local/share/ploinky/webtty/native-probe.mjs', '--verify']);
    report('node-pty', probe ? 'native-probe --verify ok' : 'FAILED');
}

if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
}
console.log('robo-work-worker smoke ok');
