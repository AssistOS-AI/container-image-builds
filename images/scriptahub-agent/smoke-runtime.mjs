import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// Run in a fresh candidate container with networking disabled and the ScriptaHubAgent checkout
// mounted read-only at /code, as Ploinky mounts it. The slim agent image carries no skills
// runtime, so the proof is that the manifest entry point serves /health without one.
const port = 3002;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scriptahub-slim-'));
let child;
try {
    assert.equal(process.getuid(), 1000, 'The agent must run as UID 1000');
    assert.equal(process.getgid(), 1000, 'The agent must run as GID 1000');
    const interfaces = Object.keys(os.networkInterfaces());
    assert.deepEqual(interfaces, ['lo'], 'Runtime proof requires network isolation');
    assert.equal(existsSync('/opt/scriptahub'), false, 'The image must not carry a skills runtime');
    assert.equal(existsSync('/usr/local/bin/scriptahub-skill'), false, 'The image must not carry a skill launcher');
    assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /^git version /);
    new DatabaseSync(':memory:').close();

    const config = path.join(directory, 'sources.json');
    await fs.writeFile(config, '{"schemaVersion":1,"repositories":[]}\n');
    const env = { ...process.env, SCRIPTA_CONFIG: config, SCRIPTA_DATA_DIR: path.join(directory, 'data'), SCRIPTA_PORT: String(port) };
    delete env.PLOINKY_AGENT_ID;
    delete env.PLOINKY_WORKSPACE_ROOT;
    child = spawn(process.execPath, ['/code/deployment/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The agent's own output is part of this proof's log, including a refusal to start.
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    let launchError;
    child.on('error', (error) => { launchError = error; });

    let health;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        assert.equal(Boolean(launchError), false, 'The agent could not be launched');
        assert.equal(child.exitCode, null, `The agent exited before /health answered (code ${child.exitCode})`);
        assert.equal(child.signalCode, null, 'The agent was terminated before /health answered');
        try {
            health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
            if (health.status === 200) break;
            await health.arrayBuffer();
        } catch { /* Wait only for the new local process to start listening. */ }
        await delay(200);
    }
    assert.equal(health?.status, 200, '/health did not answer within 30 seconds');
    assert.deepEqual(await health.json(), { ok: true });

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const outcome = await Promise.race([exited, delay(10_000).then(() => 'timeout')]);
    assert.notEqual(outcome, 'timeout', 'The agent did not drain within 10 seconds of SIGTERM');
    assert.deepEqual(outcome, { code: 0, signal: null }, 'SIGTERM must end the agent with exit 0');
    process.stdout.write('ScriptaHub slim agent runtime proven\n');
} catch (error) {
    process.stderr.write(`ScriptaHub slim agent runtime proof failed: ${error.message}\n`);
    process.exitCode = 1;
} finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(directory, { recursive: true, force: true });
}
