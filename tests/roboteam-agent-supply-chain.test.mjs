import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const dockerfile = read('images/roboteam-agent/Dockerfile');
const workflow = read('.github/workflows/publish-roboteam-agent-image.yml');
const smoke = read('scripts/smoke-roboteam-agent.sh');
const desktopSmoke = read('scripts/smoke-roboteam-desktop.mjs');
const sources = JSON.parse(read('images/roboteam-agent/sources.lock.json'));
const SHA256 = /^sha256:[0-9a-f]{64}$/;

test('RoboTeam source lock selects exact multi-architecture and Debian inputs', () => {
    assert.equal(sources.schemaVersion, 1);
    assert.match(sources.base.indexDigest, SHA256);
    assert.equal(sources.base.image, `docker.io/assistos/ploinky-node:24-bookworm-tools@${sources.base.indexDigest}`);
    assert.deepEqual(Object.keys(sources.base.platformManifests).sort(), ['linux/amd64', 'linux/arm64']);
    for (const digest of Object.values(sources.base.platformManifests)) {
        assert.match(digest, SHA256);
        assert.notEqual(digest, sources.base.indexDigest);
    }
    assert.match(sources.debianSnapshot.timestamp, /^\d{8}T\d{6}Z$/);
    for (const archive of Object.values(sources.debianSnapshot.archives)) {
        assert.match(archive, new RegExp(`/archive/(?:debian|debian-security)/${sources.debianSnapshot.timestamp}/$`));
    }
    assert.deepEqual(Object.keys(sources.packages).sort(), [
        'ca-certificates', 'chromium', 'dbus-x11', 'fonts-liberation', 'openbox',
        'passwd', 'websockify', 'x11vnc', 'xfonts-base', 'xterm', 'xvfb',
    ]);
    for (const version of Object.values(sources.packages)) {
        assert.match(version, /^[0-9][0-9A-Za-z.+:~_-]*$/);
    }
    assert.equal(sources.novncArtifact.version, '1:1.3.0-1');
    assert.match(sources.novncArtifact.url, new RegExp(`^${sources.debianSnapshot.archives.debian.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}pool/`));
    assert.match(sources.novncArtifact.sha256, /^[0-9a-f]{64}$/);
});

test('Dockerfile consumes the immutable lock and bakes the complete root controller runtime', () => {
    const from = dockerfile.match(/^FROM .+$/gm) ?? [];
    assert.deepEqual(from, [`FROM ${sources.base.image}`]);
    assert.doesNotMatch(dockerfile, /^ARG /m);
    assert.doesNotMatch(dockerfile, /(?:latest|refs\/heads\/|curl[^\n]*\|\s*(?:ba)?sh)/i);
    assert.ok(dockerfile.includes(sources.debianSnapshot.timestamp));
    for (const [packageName, version] of Object.entries(sources.packages)) {
        assert.ok(dockerfile.includes(`'${packageName}=${version}'`), `${packageName} is not version-pinned`);
        assert.ok(dockerfile.includes(`dpkg-query -W -f='\${Version}' ${packageName}`));
    }
    assert.ok(dockerfile.includes(sources.novncArtifact.url));
    assert.ok(dockerfile.includes(sources.novncArtifact.sha256));
    assert.match(dockerfile, /sha256sum --check --strict/);
    assert.match(dockerfile, /dpkg-deb --extract \/tmp\/novnc\.deb/);
    for (const executable of [
        '/bin/bash', '/usr/bin/chromium', '/usr/bin/dbus-launch', '/usr/bin/getent',
        '/usr/bin/openbox', '/usr/bin/openbox-session', '/usr/bin/passwd',
        '/usr/bin/websockify', '/usr/bin/x11vnc', '/usr/bin/xterm', '/usr/bin/Xvfb',
        '/usr/sbin/useradd',
    ]) {
        assert.ok(dockerfile.includes(executable), `${executable} is not build-time validated`);
    }
    assert.match(dockerfile, /test -r \/usr\/share\/novnc\/core\/rfb\.js/);
    assert.match(dockerfile, /COPY --chmod=0444 sources\.lock\.json \/usr\/local\/share\/ploinky\/roboteam-agent-sources\.json/);
    assert.equal(dockerfile.match(/^USER root$/gm)?.length, 2);
    assert.match(dockerfile, /USER root\nWORKDIR \/code\nCMD \["bash"\]\s*$/);
});

test('runtime marker and smoke agree on the consumer-stable contract', () => {
    assert.deepEqual(sources.runtimeContract, {
        path: '/opt/roboteam-runtime/contract-v1',
        content: 'roboteam-runtime-v1\n',
        owner: '0:0',
        mode: '0444',
        controllerUser: 'root',
    });
    for (const source of [dockerfile, smoke]) {
        assert.match(source, /\/opt\/roboteam-runtime\/contract-v1/);
        assert.match(source, /roboteam-runtime-v1/);
        assert.match(source, /0:0:444/);
        assert.match(source, /\/usr\/share\/novnc\/core\/rfb\.js/);
    }
    assert.match(smoke, /\/usr\/sbin\/useradd/);
    assert.match(smoke, /chown "\$profile_uid:\$profile_gid"/);
    assert.match(smoke, /spawnSync\('\/usr\/bin\/id'.*\{ uid, gid/s);
    assert.match(desktopSmoke, /ROBOTEAM_DESKTOP_RUNTIME_READY/);
    for (const processName of ['xvfb', 'openbox', 'xterm', 'chromium', 'x11vnc', 'websockify']) {
        assert.ok(desktopSmoke.includes(`'${processName}'`));
    }
    assert.match(desktopSmoke, /'-nolisten', 'tcp'/);
    assert.match(desktopSmoke, /'-localhost'/);
});

test('publication is native, candidate-first, exact-digest, and never privileged', () => {
    assert.doesNotMatch(workflow, /^\s*push:/m);
    assert.match(workflow, /promote_stable:[\s\S]*default:\s*false/);
    assert.match(workflow, /IMAGE_NAME:\s*assistos\/roboteam-agent/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(workflow, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(workflow, /platform:\s*linux\/amd64/);
    assert.match(workflow, /platform:\s*linux\/arm64/);
    assert.doesNotMatch(workflow, /setup-qemu-action/);
    assert.match(workflow, /push-by-digest=true/);
    assert.match(workflow, /name-canonical=true/);
    assert.match(workflow, /node --test tests\/roboteam-agent-supply-chain\.test\.mjs/);
    assert.match(workflow, /Verify the exact Ploinky Node base platform member/);
    assert.match(workflow, /--network=none/);
    assert.match(workflow, /--cap-drop=all/);
    assert.match(workflow, /--cap-add=chown/);
    assert.match(workflow, /--cap-add=setuid/);
    assert.match(workflow, /--cap-add=setgid/);
    assert.match(workflow, /--cap-add=kill/);
    assert.match(workflow, /--security-opt=no-new-privileges/);
    assert.match(workflow, /smoke-roboteam-desktop\.mjs/);
    assert.match(workflow, /ROBOTEAM_DESKTOP_RUNTIME_READY/);
    assert.doesNotMatch(workflow, /--privileged|seccomp=unconfined|apparmor=unconfined/);
    assert.match(workflow, /candidate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.match(workflow, /assert\.equal\(index\.manifests\.length, 2\)/);
    assert.match(workflow, /members\.get\('linux\/amd64'\)/);
    assert.match(workflow, /members\.get\('linux\/arm64'\)/);
    assert.match(workflow, /candidate_digest="sha256:\$\(sha256sum/);
    assert.match(workflow, /if:\s*\$\{\{ inputs\.promote_stable == true \}\}/);
    for (const use of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
        assert.match(use[1], /^[0-9a-f]{40}$/, `workflow action is not SHA-pinned: ${use[0]}`);
    }
});
