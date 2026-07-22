import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sourceRoot = fs.realpathSync(path.resolve(
    process.env.PLOINKY_SOURCE_ROOT || 'sources/ploinky',
));

async function importFromSource(relativePath) {
    return import(pathToFileURL(path.join(sourceRoot, relativePath)).href);
}

const { BOX_IMAGE_REFERENCE } = await importFromSource('ploinky-box/constants.mjs');
const { parseOuterArguments } = await importFromSource('ploinky-box/command/parse.mjs');
const { routeOuterCommand } = await importFromSource('ploinky-box/command/route.mjs');
const {
    readSmokeGraphInputs,
    stageSmokeGraph,
} = await importFromSource('ploinky-box/smoke/graph.mjs');
const {
    readProxyTrace,
    writeCandidatePodmanProxy,
} = await importFromSource('tests/e2e/ploinkyBox/candidatePodmanProxy.mjs');
const {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} = await importFromSource('tests/e2e/ploinkyBox/nativeHelpers.mjs');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 20 * 60_000,
        ...options,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
}

function request({ hostPort, requestPath = '/health' }) {
    return new Promise((resolve, reject) => {
        const operation = http.get({
            hostname: '127.0.0.1',
            port: hostPort,
            path: requestPath,
            headers: { Host: `127.0.0.1:${hostPort}` },
            timeout: 15_000,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        operation.on('timeout', () => operation.destroy(new Error('request timed out')));
        operation.on('error', reject);
    });
}

function normalizedPortBindings(record) {
    return Object.fromEntries(Object.entries(record?.HostConfig?.PortBindings || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([containerPort, bindings]) => [
            containerPort,
            (bindings || []).map((binding) => ({
                hostIp: String(binding?.HostIp || '') || '0.0.0.0',
                hostPort: String(binding?.HostPort || ''),
            })),
        ]));
}

test('the public CLI starts the pinned Explorer graph through the candidate Box', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;

    const harness = createPodmanHarness(t, candidateReference);
    const graph = readSmokeGraphInputs(process.env, { runner: harness.runner });
    const route = routeOuterCommand(parseOuterArguments(graph.args));
    assert.equal(route.kind, 'start');
    assert.ok(route.hostPort && route.hostPort !== 8080);

    const prepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
    });
    stageSmokeGraph({
        graph,
        containerId: prepared.containerId,
        runner: harness.runner,
    });
    await harness.supervisor.runDestroyTransaction(prepared.containerId);

    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-startup-gate-'));
    t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
    const tracePath = path.join(artifactRoot, 'candidate-proxy.trace');
    const proxy = writeCandidatePodmanProxy({
        directory: path.join(artifactRoot, 'candidate-proxy'),
        realPodman: fs.realpathSync(process.env.PLOINKY_BOX_REAL_PODMAN || '/usr/bin/podman'),
        candidateReference,
        tracePath,
    });
    const environment = {
        ...process.env,
        HOME: harness.lockHome,
        PATH: `${proxy.directory}:${process.env.PATH}`,
    };
    if (harness.engineEnvironment.XDG_CONFIG_HOME) {
        environment.XDG_CONFIG_HOME = harness.engineEnvironment.XDG_CONFIG_HOME;
    }
    delete environment.PLOINKY_BOX_CANDIDATE_DIGEST;
    delete environment.PLOINKY_BOX_CANDIDATE_REF;
    delete environment.PLOINKY_BOX_REAL_PODMAN;

    const publicCli = path.join(sourceRoot, 'bin/ploinky');
    const started = run(publicCli, graph.args, {
        cwd: harness.child,
        env: environment,
    });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout,
        new RegExp(`Dashboard: http://127\\.0\\.0\\.1:${route.hostPort}/dashboard`));

    const status = run(publicCli, ['status'], {
        cwd: harness.child,
        env: environment,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /running-initialized/);

    const identity = harness.resolveIdentity();
    const inspected = harness.runner.query('podman', [
        'container', 'inspect', identity.instance,
    ]);
    assert.equal(inspected.ok, true, inspected.stderr);
    const outer = JSON.parse(inspected.stdout)[0];
    const outerId = String(outer?.Id || '');
    assert.match(outerId, /^[a-f0-9]{64}$/);
    assert.equal(outer?.State?.Running, true);
    assert.equal(outer?.HostConfig?.Privileged, false);
    assert.equal(outer?.Config?.Labels?.['io.assistos.ploinky.runtime-contract'], '6');
    assert.deepEqual(normalizedPortBindings(outer), {
        '7882/udp': [{ hostIp: '0.0.0.0', hostPort: '7882' }],
        '8080/tcp': [{ hostIp: '127.0.0.1', hostPort: String(route.hostPort) }],
    });
    assert.equal(outer?.Config?.ExposedPorts ?? null, null);
    const sourceMount = (outer?.Mounts || []).find((mount) => (
        mount.Destination === '/opt/ploinky'
    ));
    assert.ok(sourceMount, 'the running Box must mount Ploinky at /opt/ploinky');
    assert.equal(sourceMount.RW, false);
    assert.equal((outer?.Mounts || []).some((mount) => (
        /(?:docker|podman)\.sock$/.test(String(mount.Destination || ''))
    )), false);

    const agents = JSON.parse(execInBox(harness.runner, outerId, [
        'cat', '/workspace/.ploinky/agents.json',
    ]));
    const explorer = Object.entries(agents).find(([, record]) => (
        record?.runtime === 'podman'
        && /^[a-f0-9]{64}$/.test(record?.containerId || '')
    ));
    assert.ok(explorer, 'Explorer must have one running nested-Podman record');
    const nestedInspection = JSON.parse(execInBox(harness.runner, outerId, [
        'podman', 'container', 'inspect', explorer[1].containerId,
    ]))[0];
    assert.equal(nestedInspection?.State?.Running, true);

    const health = await request({ hostPort: route.hostPort });
    assert.equal(health.statusCode, 200, health.body);
    const root = await request({ hostPort: route.hostPort, requestPath: '/' });
    assert.ok([200, 302, 303, 307, 308].includes(root.statusCode), root.body);

    const trace = readProxyTrace(tracePath);
    const rewrites = trace.filter((record) => record[0] === 'rewrite');
    assert.ok(rewrites.length >= 1);
    for (const rewrite of rewrites) {
        assert.deepEqual(rewrite, ['rewrite', BOX_IMAGE_REFERENCE, candidateReference]);
    }
    assert.equal(trace.some((record) => record[0] === 'reject'), false);

    process.stdout.write(`PLOINKY_BOX_STARTUP_GATE ${JSON.stringify({
        candidateReference,
        platform: `${outer?.Os || 'linux'}/${outer?.Architecture || ''}`,
        publications: normalizedPortBindings(outer),
        sourceReadOnly: sourceMount.RW === false,
        explorer: {
            name: explorer[0],
            containerId: explorer[1].containerId,
            running: nestedInspection?.State?.Running === true,
        },
        routerHealthStatus: health.statusCode,
        rootStatus: root.statusCode,
    })}\n`);
});
