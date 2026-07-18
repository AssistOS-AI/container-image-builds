import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINT = path.join(ROOT, 'images', 'ploinky-box', 'entrypoint.sh');

function makeFixture(t, {
    route = [{ dev: 'eth0', prefsrc: '10.88.0.2' }],
    address = [{ ifname: 'eth0', addr_info: [{ family: 'inet', local: '10.88.0.2' }] }],
} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-entrypoint-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const routeJson = path.join(dir, 'route.json');
    const addressJson = path.join(dir, 'address.json');
    fs.writeFileSync(routeJson, JSON.stringify(route));
    fs.writeFileSync(addressJson, JSON.stringify(address));
    fs.writeFileSync(path.join(bin, 'ip'), `#!/bin/sh
case "$*" in
  "-j -4 route get 198.51.100.1") cat "$ROUTE_JSON" ;;
  "-j -4 address show dev eth0") cat "$ADDRESS_JSON" ;;
  *) echo "unexpected ip args: $*" >&2; exit 99 ;;
esac
`);
    fs.chmodSync(path.join(bin, 'ip'), 0o755);
    return {
        dir,
        bin,
        routeJson,
        addressJson,
        transportFile: path.join(dir, 'run', 'ploinky', 'box-transport.json'),
        containersConf: path.join(dir, 'home', 'podman', '.config', 'containers', 'containers.conf'),
    };
}

function runEntrypoint(fixture, {
    transportOwner,
} = {}) {
    const env = {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        ROUTE_JSON: fixture.routeJson,
        ADDRESS_JSON: fixture.addressJson,
        PLOINKY_BOX_ENTRYPOINT_TRANSPORT_ONLY: '1',
        PLOINKY_BOX_TRANSPORT_FILE: fixture.transportFile,
        PLOINKY_BOX_PODMAN_CONTAINERS_CONF: fixture.containersConf,
    };
    delete env.PLOINKY_BOX_TRANSPORT_OWNER;
    if (transportOwner !== undefined) {
        env.PLOINKY_BOX_TRANSPORT_OWNER = transportOwner;
    }
    return spawnSync('bash', [ENTRYPOINT], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
    });
}

function mode(file) {
    return fs.statSync(file).mode & 0o777;
}

test('entrypoint writes the discovered transport contract and effective Podman host-gateway config', (t) => {
    const fixture = makeFixture(t);
    const result = runEntrypoint(fixture);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.transportFile, 'utf8')), {
        address: '10.88.0.2',
        interface: 'eth0',
    });
    assert.equal(mode(fixture.transportFile), 0o600);
    assert.equal(mode(path.dirname(fixture.transportFile)), 0o700);
    assert.equal(fs.readFileSync(fixture.containersConf, 'utf8'), [
        '[containers]',
        'host_containers_internal_ip="10.88.0.2"',
        '',
    ].join('\n'));
    assert.equal(mode(fixture.containersConf), 0o600);
});

test('entrypoint fails closed on ambiguous route discovery', (t) => {
    const fixture = makeFixture(t, {
        route: [
            { dev: 'eth0', prefsrc: '10.88.0.2' },
            { dev: 'eth0', prefsrc: '10.88.0.2' },
        ],
    });
    const result = runEntrypoint(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /default route result must be exact/);
    assert.equal(fs.existsSync(fixture.transportFile), false);
});
