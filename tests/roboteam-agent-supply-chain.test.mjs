import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const dockerfile = read('images/roboteam-agent/Dockerfile');
const workstationDockerfile = read('images/roboteam-agent/Dockerfile.workstation');
const browserDockerfile = read('images/roboteam-agent/Dockerfile.browser');
const computerUseLauncher = read('images/roboteam-agent/roboteam-computer-use-mcp');
const desktopMcpService = read('images/roboteam-agent/services/desktop-mcp.run');
const browserMcpService = read('images/roboteam-agent/services/browser-mcp.run');
const storage = read('images/roboteam-agent/storage.conf');
const workflow = read('.github/workflows/publish-roboteam-agent-image.yml');
const smoke = read('scripts/smoke-roboteam-agent.sh');
const sources = JSON.parse(read('images/roboteam-agent/sources.lock.json'));
const SHA256 = /^sha256:[0-9a-f]{64}$/;

test('RoboTeam locks immutable bases and constrains the rolling Podman 6 base', () => {
    assert.equal(sources.schemaVersion, 3);
    for (const base of [sources.nodeBase, sources.workstationBase, sources.browserBase]) {
        assert.match(base.indexDigest, SHA256);
        assert.ok(base.image.endsWith(`@${base.indexDigest}`));
        assert.deepEqual(Object.keys(base.platformManifests).sort(), ['linux/amd64', 'linux/arm64']);
        for (const digest of Object.values(base.platformManifests)) assert.match(digest, SHA256);
    }
    assert.equal(sources.podmanBase.image, 'quay.io/podman/upstream:latest');
    assert.equal(sources.podmanBase.requiredVersionMajor, 6);
});

test('workstation image pins Webtop and computer-use-linux for both architectures', () => {
    assert.match(workstationDockerfile, new RegExp(`^FROM ${sources.workstationBase.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal(sources.computerUseLinux.version, '0.5.0');
    assert.match(workstationDockerfile, /ARG TARGETARCH/);
    assert.match(workstationDockerfile, /COMPUTER_USE_LINUX_VERSION=0\.5\.0/);
    for (const platform of ['linux/amd64', 'linux/arm64']) {
        const artifact = sources.computerUseLinux.artifacts[platform];
        assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
        assert.ok(workstationDockerfile.includes(artifact.sha256));
    }
    for (const dependency of ['at-spi2-core', 'gnome-screenshot', 'wmctrl', 'x11-utils', 'xdotool']) {
        assert.match(workstationDockerfile, new RegExp(`\\b${dependency}\\b`));
    }
    assert.match(computerUseLauncher, /pgrep -x xfce4-session/);
    assert.match(computerUseLauncher, /DBUS_SESSION_BUS_ADDRESS/);
    assert.match(computerUseLauncher, /COMPUTER_USE_LINUX_SCREENSHOT_BACKEND=gnome-screenshot/);
    assert.match(computerUseLauncher, /unset COMPUTER_USE_LINUX_ENABLE_SHELL/);
    assert.match(computerUseLauncher, /computer-use-linux mcp/);
    assert.match(workstationDockerfile, /supergateway@3\.4\.3/);
    assert.match(desktopMcpService, /outputTransport streamableHttp/);
    assert.match(desktopMcpService, /--port 8100/);
    assert.match(browserDockerfile, /@playwright\/mcp@0\.0\.79/);
    assert.match(browserDockerfile, new RegExp(`^FROM ${sources.browserBase.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(browserMcpService, /--cdp-endpoint http:\/\/127\.0\.0\.1:9222/);
    assert.match(browserMcpService, /--port 8100/);
});

test('outer image combines Node with the nested Podman controller', () => {
    assert.match(dockerfile, new RegExp(`^FROM ${sources.nodeBase.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} AS node-runtime$`, 'm'));
    assert.match(dockerfile, /^ARG PODMAN_BASE_IMAGE=quay\.io\/podman\/upstream:latest$/m);
    assert.match(dockerfile, /^FROM \$\{PODMAN_BASE_IMAGE\}$/m);
    assert.match(dockerfile, /COPY --from=node-runtime --chmod=0755 \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
    assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/lib\/node_modules\/npm\/ \/usr\/local\/lib\/node_modules\/npm\//);
    assert.doesNotMatch(dockerfile, /COPY --from=node-runtime \/usr\/local\/ \/usr\/local\//);
    for (const executable of [
        '/usr/bin/podman',
        '/usr/bin/fuse-overlayfs',
        '/usr/bin/pasta',
        '/usr/bin/bwrap',
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
    assert.match(dockerfile, /@openai\/codex@0\.152\.1/);
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

test('publication pushes verified multi-architecture runtime, desktop, and browser images directly', () => {
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
    assert.match(workflow, /DESKTOP_IMAGE_NAME:\s*assistos\/roboteam-desktop/);
    assert.match(workflow, /DESKTOP_IMAGE_TAG:\s*cul-0\.5\.0-v1/);
    assert.match(workflow, /BROWSER_IMAGE_NAME:\s*assistos\/roboteam-browser/);
    assert.match(workflow, /name:\s*Build and push runtime/);
    assert.match(workflow, /docker\/setup-qemu-action@/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /^\s{10}push:\s*true$/m);
    assert.match(workflow, /tags:\s*docker\.io\/\$\{\{ env\.IMAGE_NAME \}\}:\$\{\{ env\.IMAGE_TAG \}\}/);
    assert.match(workflow, /file:\s*images\/roboteam-agent\/Dockerfile\.workstation/);
    assert.match(workflow, /tags:\s*docker\.io\/\$\{\{ env\.DESKTOP_IMAGE_NAME \}\}:\$\{\{ env\.DESKTOP_IMAGE_TAG \}\}/);
    assert.match(workflow, /file:\s*images\/roboteam-agent\/Dockerfile\.browser/);
    assert.match(workflow, /tags:\s*docker\.io\/\$\{\{ env\.BROWSER_IMAGE_NAME \}\}:\$\{\{ env\.BROWSER_IMAGE_TAG \}\}/);
    assert.match(workflow, /Smoke build and verify local workstation tools/);
    assert.match(workflow, /node --test tests\/roboteam-agent-supply-chain\.test\.mjs/);
    assert.match(workflow, /RESOLVED_BASE_IMAGE/);
    assert.match(workflow, /build-args: PODMAN_BASE_IMAGE=\$\{\{ steps\.resolve_base\.outputs\.image \}\}/);
    assert.match(workflow, /org\.opencontainers\.image\.base\.digest=\$\{\{ steps\.resolve_base\.outputs\.digest \}\}/);
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
