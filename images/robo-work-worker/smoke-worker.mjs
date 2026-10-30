#!/usr/bin/env node
// Image smoke: tool versions, Bubblewrap flags and the node-pty contract.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const failures = [];
const run = (cmd, args) => {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

for (const absent of ['/usr/bin/podman', '/usr/bin/fuse-overlayfs', '/usr/bin/fusermount3', '/usr/bin/cargo', '/usr/bin/rustc']) {
    if (fs.existsSync(absent)) failures.push(`${absent} must not be present`);
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
