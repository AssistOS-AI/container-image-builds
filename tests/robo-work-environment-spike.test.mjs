import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { smokeEnvironmentSpike } from '../images/robo-work-worker/smoke-environment-spike.mjs';

const root = new URL('../images/robo-work-worker/', import.meta.url);
const lock = JSON.parse(fs.readFileSync(new URL('environment-spike-packages.lock.json', root)));
const base = JSON.parse(fs.readFileSync(new URL('sources.lock.json', root)));

function fixture() {
    const calls = [];
    return { calls, lock, base, nodeVersion: 'v24.18.1',
        stat: () => ({ uid: 0, gid: 0, mode: 0o100444 }),
        read: (path) => path === base.runtimeContract.path ? base.runtimeContract.content
            : path.endsWith('package.json') ? JSON.stringify({ version: base.agentTools.packages['@opencode-ai/plugin'] }) : 'distribution configuration',
        run(command, args) {
            calls.push([command, args]);
            if (command === 'rpm') return args[0] === '--eval' ? 'x86_64'
                : lock.directPackages.find((p) => p.name === args.at(-1)).nevra;
            if (command === '/usr/bin/bwrap') return args[0] === '--version' ? 'bubblewrap 0.12.0'
                : '--args --bind-fd --ro-bind-fd --disable-userns --assert-userns-disabled --block-fd --info-fd --json-status-fd --seccomp --hostname --unshare-cgroup-try';
            return { podman: 'podman version 5.8.9', crun: 'crun version 1.28', conmon: 'conmon version 2.2.1',
                'fuse-overlayfs': 'fusermount3 version: 3.18.3\nfuse-overlayfs: version 1.17',
                codex: 'codex-cli 0.166.0', claude: '2.1.314 (Claude Code)', opencode: '1.19.5', pi: '1.4.0' }[command] ?? 'tool version';
        },
    };
}

test('spike preflight checks the retained contract without invoking product smoke or Podman storage operations', () => {
    const input = fixture();
    assert.equal(smokeEnvironmentSpike(input).scope, 'environment-spike-image-preflight');
    assert.deepEqual(input.calls.filter(([command]) => command === 'podman'), [['podman', ['--version']]]);
    assert.ok(input.calls.some(([command, args]) => command === 'setpriv' && args.includes('--verify')));
});

test('missing tools, changed NEVRAs, architecture, contract, tool versions and flags fail closed', () => {
    for (const override of [
        { nodeVersion: '' }, { nodeVersion: 'v22.0.0' },
        { run: () => { throw new Error('podman ENOENT'); } },
        { stat: () => ({ uid: 1000, gid: 0, mode: 0o100444 }) },
        { read: () => '' },
    ]) assert.throws(() => smokeEnvironmentSpike({ ...fixture(), ...override }));
    for (const command of ['rpm', 'podman', 'crun', 'conmon', 'fuse-overlayfs', '/usr/bin/bwrap', 'codex', 'claude', 'opencode', 'pi']) {
        const input = fixture();
        const run = input.run;
        input.run = (name, args) => name === command ? 'incompatible' : run(name, args);
        assert.throws(() => smokeEnvironmentSpike(input), undefined, command);
    }
});

test('overlay installs only the recorded exact direct NEVRAs on the pinned base', () => {
    const dockerfile = fs.readFileSync(new URL('Dockerfile.environment-spike', root), 'utf8');
    assert.ok(dockerfile.includes(`FROM ${lock.baseImage}`));
    assert.equal(lock.directPackages.length, 5);
    assert.equal(lock.observedAdditionalPackages.length, 17);
    for (const entry of lock.directPackages) assert.ok(dockerfile.includes(entry.nevra), entry.name);
    assert.match(dockerfile, /test "\$\(rpm --eval '%\{_arch\}'\)" = x86_64/);
    assert.ok(!dockerfile.includes('smoke-worker.mjs'));
});
