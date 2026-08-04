import assert from 'node:assert/strict';
import fs from 'node:fs';

const workspace = '/workspace';
const workdir = '/workspace/project';
const descriptorPath = '/run/ploinky-agent/credential.json';

if (process.argv.includes('--wait-for-signal')) {
    const readyPath = `${workdir}/signal-ready`;
    const stoppedPath = `${workdir}/signal-stopped`;
    fs.writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
    process.on('SIGTERM', () => {
        fs.writeFileSync(stoppedPath, 'SIGTERM\n', { mode: 0o600 });
        process.exit(0);
    });
    setInterval(() => {}, 1_000);
} else {
    assert.equal(fs.readFileSync(`${workdir}/identity.txt`, 'utf8'), 'retained\n');
    assert.equal(fs.readFileSync(descriptorPath, 'utf8'), '{"generation":"native-gate"}\n');
    assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o400);
    assert.equal(process.env.HOME, '/home/agent');
    assert.equal(process.env.PATH, '/usr/local/bin:/usr/bin');
    assert.equal(process.env.PLOINKY_NATIVE_GATE, 'provider');
    assert.equal(process.env.PLOINKY_SECRET_CANARY, undefined);
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), 1000);

    fs.writeFileSync(`${workdir}/provider-write.txt`, 'provider wrote selected workdir\n', {
        mode: 0o600,
    });
    fs.writeFileSync('/home/agent/provider-state.txt', 'provider home state\n', { mode: 0o600 });

    let siblingWriteCode = null;
    try {
        fs.writeFileSync(`${workspace}/sibling/forbidden.txt`, 'must not be written\n');
    } catch (error) {
        siblingWriteCode = error.code;
    }
    assert.ok(['EACCES', 'EROFS', 'EPERM'].includes(siblingWriteCode));

    let runtimeWriteCode = null;
    try {
        fs.appendFileSync('/usr/local/bin/node', 'must not be written\n');
    } catch (error) {
        runtimeWriteCode = error.code;
    }
    assert.ok(['EACCES', 'EROFS', 'EPERM', 'ETXTBSY'].includes(runtimeWriteCode));

    assert.equal(fs.existsSync(`${workspace}/.ploinky/control-secret`), false);
    assert.equal(fs.existsSync(`${workspace}/.data/other-home-secret`), false);
    assert.equal(fs.existsSync('/home/podman/.local/share/containers'), false);
    assert.equal(fs.existsSync('/run/podman/podman.sock'), false);
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.equal(fs.existsSync('/dev/fuse'), false);
    assert.equal(fs.existsSync('/dev/net/tun'), false);

    const fdTargets = fs.readdirSync('/proc/self/fd').flatMap((entry) => {
        try {
            return [fs.readlinkSync(`/proc/self/fd/${entry}`)];
        } catch {
            return [];
        }
    });
    assert.equal(
        fdTargets.some((target) => target.includes('ploinky-native-fd-canary')),
        false,
        `helper leaked an unrelated inherited fd: ${fdTargets.join(',')}`,
    );

    const namespaces = Object.fromEntries(
        ['user', 'mnt', 'pid', 'ipc', 'uts'].map((name) => [
            name,
            fs.readlinkSync(`/proc/self/ns/${name}`),
        ]),
    );
    const visiblePids = fs.readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .sort((left, right) => left - right);
    assert.ok(visiblePids.includes(1));
    assert.ok(visiblePids.length <= 4, `private /proc leaked PIDs: ${visiblePids.join(',')}`);

    process.stdout.write(`${JSON.stringify({
        event: 'provider-complete',
        node: process.version,
        namespaces,
        visiblePids,
        envKeys: Object.keys(process.env).sort(),
        fdTargets,
        siblingWriteCode,
        runtimeWriteCode,
    })}\n`);
}
