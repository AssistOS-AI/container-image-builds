import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const initializer = new URL('../images/roboteam-agent/roboteam-podman-init', import.meta.url).pathname;

async function fixture(t, filesystem) {
    const directory = await mkdtemp(path.join(tmpdir(), 'roboteam-storage-init-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const state = path.join(directory, 'state');
    const calls = path.join(directory, 'calls');
    const scripts = {
        install: '#!/bin/sh\nexit 0\n',
        findmnt: '#!/bin/sh\nif [ -f "$PROBE_STATE" ]; then read -r state < "$PROBE_STATE"; printf "%s\\n" "$state"; else exit 1; fi\n',
        mount: '#!/bin/sh\nif [ "${PROBE_MOUNT_FAIL:-0}" = 1 ]; then exit 18; fi\nprintf "tmpfs\\n" > "$PROBE_STATE"\nprintf "%s\\n" "$*" >> "$PROBE_CALLS"\n',
    };
    for (const [name, source] of Object.entries(scripts)) {
        await writeFile(path.join(directory, name), source, { mode: 0o755 });
    }
    if (filesystem) await writeFile(state, `${filesystem}\n`);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, PROBE_STATE: state, PROBE_CALLS: calls };
    return { calls, env, run: () => execFile('sh', [initializer], { env }) };
}

test('storage initializes a bounded private tmpfs once and reuses it', async (t) => {
    const probe = await fixture(t);
    await probe.run();
    await probe.run();
    assert.equal(await readFile(probe.calls, 'utf8'), '-t tmpfs -o size=2g,mode=0700,nosuid,nodev tmpfs /var/lib/roboteam-podman\n');
});

test('storage refuses a pre-existing mount with a different filesystem', async (t) => {
    const probe = await fixture(t, 'overlay');
    await assert.rejects(probe.run(), (error) => error.code === 1 && /must use tmpfs, not overlay/.test(error.stderr));
    await assert.rejects(readFile(probe.calls), { code: 'ENOENT' });
});

test('storage mount failure is fatal without a fallback', async (t) => {
    const probe = await fixture(t);
    probe.env.PROBE_MOUNT_FAIL = '1';
    await assert.rejects(probe.run(), { code: 18 });
    await assert.rejects(readFile(probe.calls), { code: 'ENOENT' });
});
