#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const supportedTargets = new Set(['agent', 'desktop', 'browser', 'all']);
const target = String(process.argv[2] || 'all').trim().toLowerCase();

if (!supportedTargets.has(target) || process.argv.length > 3) {
    console.error('usage: install-roboteam-local.mjs [agent|desktop|browser|all]');
    process.exit(64);
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const workspaceRoot = path.resolve(repositoryRoot, '..');
const relativeRepository = path.relative(workspaceRoot, repositoryRoot);
if (!relativeRepository || relativeRepository.startsWith('..') || path.isAbsolute(relativeRepository)) {
    throw new Error('container-image-builds must be inside the Ploinky workspace');
}

const ploinkyRoot = path.resolve(process.env.PLOINKY_SOURCE_DIR || path.join(workspaceRoot, 'ploinky'));
const supervisorModule = path.join(ploinkyRoot, 'ploinky-box', 'supervisor.mjs');
const processModule = path.join(ploinkyRoot, 'ploinky-box', 'process.mjs');
if (!fs.existsSync(supervisorModule) || !fs.existsSync(processModule)) {
    throw new Error(`Ploinky source was not found at ${ploinkyRoot}; set PLOINKY_SOURCE_DIR`);
}

process.chdir(workspaceRoot);
const [{ createBoxSupervisor }, { buildEngineProcessEnvironment }] = await Promise.all([
    import(pathToFileURL(supervisorModule)),
    import(pathToFileURL(processModule)),
]);

const engineEnvironment = buildEngineProcessEnvironment(process.env);
const supervisor = createBoxSupervisor({ env: process.env });
const status = supervisor.inspectBoxStatus();
const box = status.ownership?.handles?.container;
const engine = status.ownership?.engine;
if (status.state !== 'running-initialized' || !box?.id || !engine?.name) {
    throw new Error(`the owned Ploinky Box must be running and initialized (current state: ${status.state})`);
}

const inBoxScript = `/workspace/${relativeRepository.split(path.sep).join('/')}/scripts/install-roboteam-local-in-box.sh`;
const result = spawnSync(engine.name, [
    'container', 'exec',
    '--interactive',
    '--user', 'podman',
    '--workdir', '/workspace',
    box.id,
    '/bin/bash', inBoxScript, target,
], {
    cwd: workspaceRoot,
    env: engineEnvironment,
    stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
