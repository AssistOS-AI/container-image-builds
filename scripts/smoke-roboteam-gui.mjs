// Run inside a deployed RoboTeam container. No workflow or coding agent is started.
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolCache } from '/code/server/tool-cache.mjs';
import { buildRobotRunArgs } from '/code/server/runtime-manager.mjs';

const execFile = promisify(execFileCallback);
const isolated = process.argv.includes('--isolated-storage');
const cwd = path.resolve(process.argv.find((arg) => arg.startsWith('--cwd='))?.slice(6) || process.env.PLOINKY_WORKSPACE_ROOT);
const relativeCwd = path.relative(process.env.PLOINKY_WORKSPACE_ROOT, cwd);
if (relativeCwd === '..' || relativeCwd.startsWith('../') || path.isAbsolute(relativeCwd)) {
    throw new Error('Smoke cwd must stay inside the workspace');
}
const directory = await mkdtemp('/tmp/roboteam-gui-smoke.');
const robot = { id: `smoke-${randomUUID()}`, name: 'GUI deployment smoke' };
const flags = isolated ? [
    '--root', `${directory}/storage`, '--runroot', `${directory}/run`, '--imagestore', '/data/podman/images',
    '--storage-opt', 'overlay.force_mask=0700', '--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs',
] : [];
const podman = async (args) => execFile('/usr/bin/podman', [...flags, ...args], { maxBuffer: 1024 * 1024 });
let mounted = false;
let containerName;

try {
    if (isolated) {
        await execFile('mount', ['-t', 'tmpfs', '-o', 'size=2g,mode=0700,nosuid,nodev', 'tmpfs', directory]);
        mounted = true;
    }
    await mkdir(`${directory}/home`);
    const shellTools = await new ToolCache().prepareShellTools();
    const descriptor = JSON.parse(await readFile('/data/tool-cache/browser/current.json', 'utf8'));
    const run = buildRobotRunArgs({
        robot, mode: 'browser', dataDir: '/data', timezone: 'UTC',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/3001/',
        images: { browser: 'docker.io/assistos/roboteam-browser:runtime' },
        cwd,
        toolsPath: `/data/tool-cache/browser/generations/${descriptor.generation}`,
        shellTools, homePath: `${directory}/home`,
    });
    containerName = run.containerName;
    console.log(`Starting ${containerName}`);
    await podman(run.args);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        const result = await podman(['exec', containerName, '/bin/sh', '-c',
            'curl --fail --max-time 1 -s http://127.0.0.1:9222/json/version >/dev/null && curl --max-time 1 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8100/mcp && curl --max-time 1 -s -o /dev/null -w " %{http_code}" http://127.0.0.1:3000/']).catch(() => null);
        if (result && result.stdout.trim() === '400 200') {
            ready = true;
            break;
        }
        if (attempt === 59) console.log('Last HTTP probe:', result?.stdout);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) {
        const details = await podman(['exec', containerName, '/bin/sh', '-c',
            'ls -ld /usr /usr/share /usr/share/selkies*; cat /config/nginx/site-confs/default.conf; tail -8 /config/log/nginx/error.log']).catch((error) => ({ stdout: error.stdout, stderr: error.stderr }));
        console.log(details.stdout, details.stderr);
        throw new Error('Chromium CDP, MCP and GUI HTTP 200 did not become ready');
    }
    console.log('Chromium CDP, MCP and GUI HTTP 200 ready');
    const storage = isolated ? `${directory}/storage` : '/var/lib/roboteam-podman/storage';
    console.log((await execFile('df', ['-h', storage])).stdout.trim());
} finally {
    if (containerName) await podman(['rm', '-f', containerName]).catch(() => {});
    if (mounted) {
        await execFile('umount', [directory]);
        await rmdir(directory);
    } else {
        await rm(directory, { recursive: true, force: true });
    }
}
