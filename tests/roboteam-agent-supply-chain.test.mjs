import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const dockerfile = read('images/roboteam-agent/Dockerfile');
const storage = read('images/roboteam-agent/storage.conf');
const workflow = read('.github/workflows/publish-roboteam-agent-image.yml');
const smoke = read('scripts/smoke-roboteam-agent.sh');
const sources = JSON.parse(read('images/roboteam-agent/sources.lock.json'));
const SHA256 = /^sha256:[0-9a-f]{64}$/;

test('RoboTeam locks exact multi-architecture Node and Podman bases', () => {
    assert.equal(sources.schemaVersion, 2);
    for (const base of [sources.nodeBase, sources.podmanBase]) {
        assert.match(base.indexDigest, SHA256);
        assert.ok(base.image.endsWith(`@${base.indexDigest}`));
        assert.deepEqual(Object.keys(base.platformManifests).sort(), ['linux/amd64', 'linux/arm64']);
        for (const digest of Object.values(base.platformManifests)) assert.match(digest, SHA256);
    }
});

test('outer image combines Node with the nested Podman controller', () => {
    assert.match(dockerfile, new RegExp(`^FROM ${sources.nodeBase.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} AS node-runtime$`, 'm'));
    assert.match(dockerfile, new RegExp(`^FROM ${sources.podmanBase.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(dockerfile, /COPY --from=node-runtime --chmod=0755 \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
    assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/lib\/node_modules\/npm\/ \/usr\/local\/lib\/node_modules\/npm\//);
    assert.doesNotMatch(dockerfile, /COPY --from=node-runtime \/usr\/local\/ \/usr\/local\//);
    for (const executable of [
        '/usr/bin/podman',
        '/usr/bin/fuse-overlayfs',
        '/usr/bin/pasta',
        '/usr/local/bin/node',
        '/usr/local/bin/npm',
        '/usr/local/bin/npx',
    ]) {
        assert.ok(dockerfile.includes(executable));
    }
    assert.match(dockerfile, /rm -f \/usr\/bin\/newuidmap \/usr\/bin\/newgidmap/);
    assert.match(smoke, /npm --version/);
    assert.match(storage, /graphroot = "\/data\/podman\/storage"/);
    assert.match(storage, /ignore_chown_errors = "true"/);
    assert.match(storage, /mount_program = "\/usr\/bin\/fuse-overlayfs"/);
    assert.match(dockerfile, /podman --version \| grep -E '\^podman version 6\\\.'/);
    assert.doesNotMatch(dockerfile, /chromium|Xvfb|x11vnc|websockify|novnc/i);
});

test('runtime contract and smoke describe bounded nested Podman v3', () => {
    assert.equal(sources.runtimeContract.path, '/opt/roboteam-runtime/contract-v3');
    assert.equal(sources.runtimeContract.content, 'roboteam-runtime-v3\n');
    for (const source of [dockerfile, smoke]) {
        assert.match(source, /roboteam-runtime-v3/);
        assert.match(source, /podman/);
    }
});

test('publication pushes a verified multi-architecture runtime image directly', () => {
    assert.match(workflow, /^\s{2}push:\s*$/m);
    assert.match(workflow, /^\s{4}branches:\s*\n\s{6}- main$/m);
    for (const triggerPath of [
        'images/roboteam-agent/**',
        'scripts/smoke-roboteam-agent.sh',
        'tests/roboteam-agent-supply-chain.test.mjs',
        '.github/workflows/publish-roboteam-agent-image.yml',
    ]) {
        const escapedPath = triggerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(workflow, new RegExp(`^\\s{6}- ${escapedPath}$`, 'm'));
    }
    assert.match(workflow, /IMAGE_TAG:\s*runtime/);
    assert.match(workflow, /name:\s*Build and push runtime/);
    assert.match(workflow, /docker\/setup-qemu-action@/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /^\s{10}push:\s*true$/m);
    assert.match(workflow, /tags:\s*docker\.io\/\$\{\{ env\.IMAGE_NAME \}\}:\$\{\{ env\.IMAGE_TAG \}\}/);
    assert.match(workflow, /node --test tests\/roboteam-agent-supply-chain\.test\.mjs/);
    assert.match(workflow, /bash \/smoke-roboteam-agent\.sh contract/);
    assert.doesNotMatch(workflow, /bash \/smoke-roboteam-agent\.sh nested/);
    assert.doesNotMatch(workflow, /push-by-digest|candidate-|Promote proven candidate/);
    assert.doesNotMatch(workflow, /--privileged/);
    assert.doesNotMatch(workflow, /--cap-add SYS_ADMIN|--cap-add NET_ADMIN|--device \/dev\/fuse|--device \/dev\/net\/tun/);
    assert.match(smoke, /--ipc private --shm-size 1g/);
    assert.match(smoke, /--network pasta/);
    assert.doesNotMatch(workflow, /podman\.sock|docker\.sock/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, `workflow action is not SHA-pinned: ${use[0]}`);
    }
});
