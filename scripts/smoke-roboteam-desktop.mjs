import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const profileUid = 42002;
const profileUser = 'roboteam-desktop-smoke';
const profileRoot = '/tmp/roboteam-desktop-profile';
const displayNumber = 99;
const display = `:${displayNumber}`;
const rfbPort = 5901;
const websockifyPort = 6081;
const processes = [];

function provisionProfile() {
    fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    const created = spawnSync('/usr/sbin/useradd', [
        '--uid', String(profileUid),
        '--user-group',
        '--no-create-home',
        '--home-dir', profileRoot,
        '--shell', '/bin/bash',
        profileUser,
    ], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const passwd = spawnSync('/usr/bin/getent', ['passwd', profileUser], { encoding: 'utf8' });
    assert.equal(passwd.status, 0, passwd.stderr);
    const profileGid = Number(passwd.stdout.trim().split(':')[3]);
    assert.ok(Number.isInteger(profileGid) && profileGid > 0);
    for (const directory of ['.cache', '.config', '.runtime', 'browser']) {
        fs.mkdirSync(`${profileRoot}/${directory}`, { recursive: true, mode: 0o700 });
        fs.chownSync(`${profileRoot}/${directory}`, profileUid, profileGid);
    }
    fs.chownSync(profileRoot, profileUid, profileGid);
    return profileGid;
}

function start(name, command, args, profileGid, extraEnv = {}) {
    const stderr = [];
    const child = spawn(command, args, {
        uid: profileUid,
        gid: profileGid,
        env: {
            ...process.env,
            DISPLAY: display,
            HOME: profileRoot,
            LOGNAME: profileUser,
            USER: profileUser,
            XDG_CACHE_HOME: `${profileRoot}/.cache`,
            XDG_CONFIG_HOME: `${profileRoot}/.config`,
            XDG_RUNTIME_DIR: `${profileRoot}/.runtime`,
            ...extraEnv,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
        if (stderr.join('').length < 8192) stderr.push(String(chunk));
    });
    processes.push({ name, child, stderr });
    return child;
}

async function waitFor(predicate, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(250);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        const closed = () => {
            socket.destroy();
            resolve(false);
        };
        socket.once('error', closed);
        socket.once('timeout', closed);
    });
}

function requireRunning(name) {
    const processEntry = processes.find((entry) => entry.name === name);
    assert.ok(processEntry, `${name} was not started`);
    assert.equal(
        processEntry.child.exitCode,
        null,
        `${name} exited early: ${processEntry.stderr.join('').trim()}`,
    );
}

async function stopAll() {
    for (const { child } of [...processes].reverse()) {
        if (child.exitCode === null) child.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const { child } of [...processes].reverse()) {
        if (child.exitCode === null) child.kill('SIGKILL');
    }
}

let result;
try {
    const profileGid = provisionProfile();
    start('xvfb', '/usr/bin/Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], profileGid);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${displayNumber}`), 'Xvfb socket did not become ready');
    requireRunning('xvfb');

    start('openbox', '/usr/bin/openbox-session', [], profileGid);
    start('xterm', '/usr/bin/xterm', [
        '-display', display,
        '-geometry', '80x24',
        '-e', '/bin/bash', '-lc', 'printf ready > /tmp/roboteam-xterm-ready; sleep 60',
    ], profileGid);
    await waitFor(() => fs.existsSync('/tmp/roboteam-xterm-ready'), 'xterm command did not execute');

    start('chromium', '/usr/bin/chromium', [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileRoot}/browser`,
        'about:blank',
    ], profileGid);
    await new Promise((resolve) => setTimeout(resolve, 750));
    requireRunning('chromium');

    start('x11vnc', '/usr/bin/x11vnc', [
        '-display', display,
        '-rfbport', String(rfbPort),
        '-localhost',
        '-forever',
        '-shared',
        '-nopw',
        '-xkb',
        '-quiet',
    ], profileGid);
    await waitFor(() => portIsOpen(rfbPort), 'x11vnc listener did not become ready');
    requireRunning('x11vnc');

    start('websockify', '/usr/bin/websockify', [String(websockifyPort), `127.0.0.1:${rfbPort}`], profileGid);
    await waitFor(() => portIsOpen(websockifyPort), 'websockify listener did not become ready');
    requireRunning('websockify');
    requireRunning('openbox');
    requireRunning('xterm');
    requireRunning('chromium');

    result = {
        ok: true,
        code: 'ROBOTEAM_DESKTOP_RUNTIME_READY',
        uid: profileUid,
        gid: profileGid,
        display,
        rfb: `127.0.0.1:${rfbPort}`,
        websockify: `127.0.0.1:${websockifyPort}`,
        processes: processes.map(({ name }) => name),
    };
} finally {
    await stopAll();
}

process.stdout.write(`${JSON.stringify(result)}\n`);
