#!/usr/bin/env node
// Offline image preflight only. S1-S5 own mount, confinement and cgroup evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function smokeEnvironmentSpike({
    run = (command, args) => execFileSync(command, args, {
        encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    read = (path) => fs.readFileSync(path, 'utf8'),
    stat = (path) => fs.statSync(path),
    nodeVersion = process.version,
    lock = JSON.parse(read(new URL('./environment-spike-packages.lock.json', import.meta.url))),
    base = JSON.parse(read('/usr/local/share/ploinky/robo-work-worker-sources.json')),
} = {}) {
    assert.match(nodeVersion, /^v24\./, 'Node.js 24 required');
    assert.equal(run('rpm', ['--eval', '%{_arch}']), lock.resolution.architecture, 'unresolved architecture');
    for (const entry of lock.directPackages) {
        const actual = run('rpm', ['-q', '--qf', '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}', entry.name]);
        assert.equal(actual, entry.nevra, `${entry.name} NEVRA mismatch`);
    }
    const versions = { node: nodeVersion };
    for (const [tool, expected] of [
        ['podman', 'podman version 5.8.9'], ['crun', 'crun version 1.28'],
        ['conmon', 'conmon version 2.2.1'], ['fuse-overlayfs', 'fuse-overlayfs: version 1.17'],
    ]) {
        versions[tool] = run(tool, ['--version']);
        assert.ok(versions[tool].split('\n').includes(expected), `${tool} version mismatch`);
    }
    for (const path of ['/usr/share/containers/storage.conf', '/usr/share/containers/containers.conf']) {
        assert.ok(read(path).length > 0, `missing storage prerequisite ${path}`);
    }
    for (const command of ['mount', 'unshare', 'setpriv', 'nsenter', 'fusermount3']) {
        versions[command] = run(command, ['--version']);
    }
    assert.equal(read(base.runtimeContract.path), base.runtimeContract.content, 'base runtime contract');
    const contract = stat(base.runtimeContract.path);
    assert.equal(contract.uid, 0, 'contract uid');
    assert.equal(contract.gid, 0, 'contract gid');
    assert.equal(contract.mode & 0o777, 0o444, 'contract mode');
    const bwrap = run('/usr/bin/bwrap', ['--version']);
    assert.match(bwrap, /^bubblewrap 0\.(?:1[1-9]|[2-9]\d)\./, 'bubblewrap >= 0.11 required');
    versions.bwrap = bwrap;
    const help = run('/usr/bin/bwrap', ['--help']);
    for (const flag of ['--args', '--bind-fd', '--ro-bind-fd', '--disable-userns', '--assert-userns-disabled',
        '--block-fd', '--info-fd', '--json-status-fd', '--seccomp', '--hostname', '--unshare-cgroup-try']) {
        assert.ok(help.includes(flag), `bwrap lacks ${flag}`);
    }
    for (const command of ['npm', 'git', 'curl', 'rg', 'bash', 'python3', 'nft']) {
        versions[command] = run(command, ['--version']).split('\n')[0];
    }
    versions.ip = run('ip', ['-V']);
    for (const [command, name] of [['codex', '@openai/codex'], ['claude', '@anthropic-ai/claude-code'],
        ['opencode', 'opencode-ai'], ['pi', '@earendil-works/pi-coding-agent']]) {
        versions[command] = run(command, ['--version']).split('\n')[0];
        assert.ok(versions[command].includes(base.agentTools.packages[name]), `${command} inherited version mismatch`);
    }
    const plugin = JSON.parse(read('/opt/robo-work-tools/node_modules/@opencode-ai/plugin/package.json'));
    assert.equal(plugin.version, base.agentTools.packages['@opencode-ai/plugin']);
    run('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups', 'node',
        '/usr/local/share/ploinky/webtty/native-probe.mjs', '--verify']);
    return { scope: 'environment-spike-image-preflight', versions,
        storage: 'distribution configuration and tools present; create/mount unverified (S1)',
        acceptance: 'Not product smoke, A-10, S1-S5 or final worker acceptance' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.log(JSON.stringify(smokeEnvironmentSpike(), null, 2));
    } catch (error) {
        console.error(`Environment spike preflight failed: ${error.message}. Rebuild the test overlay from its locked Fedora 44 amd64 inputs; see dependencies.md. No dependency is installed at startup.`);
        process.exitCode = 1;
    }
}
