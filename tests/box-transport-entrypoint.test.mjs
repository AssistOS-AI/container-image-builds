import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('ploinky-box image consumes only the canonical Box entrypoint source', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    assert.match(
        dockerfile,
        /^COPY --from=ploinky-src \/ploinky-box\/entrypoint\/ploinky-box-entrypoint \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.equal(fs.existsSync(path.join(ROOT, 'images/ploinky-box/entrypoint.sh')), false);
    assert.match(workflow, /Checkout immutable Ploinky source/);
    assert.match(workflow, /path:\s*sources\/ploinky/);
    assert.match(dockerfile, /typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file/);
    assert.match(dockerfile, /ro-data-path-hardening=sealed-memfd-ro-bind-data/);
    assert.match(dockerfile, /home-sources=sandbox-workspace-v2,container-native/);
    assert.match(dockerfile, /home-marker=ploinky-home-v2-schema-2/);
    assert.match(dockerfile, /home-revalidation=post-barrier-G/);
    assert.match(dockerfile, /preexec-barrier=R\/G/);
    assert.match(dockerfile, /credential-bound=4096/);
});

test('publication workflow gates candidate publication on native Bubblewrap behavior', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');
    const podmanMachineJob = workflow.match(/\n  podman-machine-gate:[\s\S]*?(?=\n  merge:)/)?.[0] || '';

    assert.ok(podmanMachineJob);
    assert.match(workflow, /Run native Bubblewrap behavior gate/);
    assert.match(workflow, /tests\/native:\/opt\/ploinky-native-tests:ro/);
    assert.match(workflow, /ploinky-box-bwrap\.mjs/);
    assert.match(workflow, /Podman Machine Bubblewrap gate/);
    assert.match(podmanMachineJob, /runs-on:\s*macos-15-intel/);
    assert.match(podmanMachineJob, /podman-installer-macos-amd64\.pkg/);
    assert.match(podmanMachineJob, /shasum -a 256 --check/);
    assert.match(podmanMachineJob, /Developer ID Installer: Red Hat, Inc\. \(HYSCB8KRL2\)/);
    assert.doesNotMatch(podmanMachineJob, /brew install podman/);
    assert.match(podmanMachineJob, /podman machine init[\s\S]*?podman machine start/);
    assert.doesNotMatch(podmanMachineJob, /--now/);
    assert.match(podmanMachineJob, /--image "\$PODMAN_MACHINE_IMAGE"/);
    assert.match(podmanMachineJob, /ploinky-box-podman-machine-startup\.log/);
    assert.match(workflow, /\bpodman run --rm\b/);
    assert.doesNotMatch(workflow, /--privileged|seccomp=unconfined/);
    assert.doesNotMatch(workflow, /SMOKE_GRAPH_|PLOINKY_RELAY_TEST_IMAGE|PLOINKY_BOX_PROXY_TRACE/);
});

test('native Bubblewrap gate covers helper HOME ordering, empty readiness, and owned signals', () => {
    const nativeGate = read('tests/native/ploinky-box-bwrap.mjs');
    const waitForExit = nativeGate.match(
        /function waitForExit[\s\S]*?(?=\n}\n\nfunction waitForPath)/,
    )?.[0] || '';
    const providerDescriptor = nativeGate.match(
        /function helperLaunchDescriptor[\s\S]*?(?=\n}\n\nconst EMPTY_READINESS_SCRIPT)/,
    )?.[0] || '';
    const readinessDescriptor = nativeGate.match(
        /function helperEmptyReadinessDescriptor[\s\S]*?(?=\n}\n\nfunction waitForPreexecBarrier)/,
    )?.[0] || '';

    assert.ok(providerDescriptor);
    assert.ok(readinessDescriptor);
    assert.match(nativeGate, /const HELPER_HOME_KEY = 'native-helper\.sandbox-v2'/);
    assert.match(nativeGate, /const READINESS_HOME_KEY = 'native-readiness\.sandbox-v2'/);
    assert.ok(providerDescriptor.indexOf("directory('/home')") < providerDescriptor.indexOf('sandboxHome(HELPER_HOME_KEY)'));
    assert.ok(readinessDescriptor.indexOf("tmpfs('/workspace')") < readinessDescriptor.indexOf("directory('/workspace/readiness')"));
    assert.ok(readinessDescriptor.indexOf("directory('/home')") < readinessDescriptor.indexOf('sandboxHome(READINESS_HOME_KEY)'));
    assert.match(nativeGate, /header\.write\('PLBWLP02'/);
    assert.match(nativeGate, /function sandboxHome\(homeKey\)/);
    assert.match(nativeGate, /\.ploinky-home-abi\.json/);
    assert.match(nativeGate, /runHelperHomeMarkerReplacementGate/);
    assert.match(nativeGate, /wrong-home-key-new-inode-after-R/);
    assert.match(nativeGate, /PLOINKY_HOME_STATE_INCOMPATIBLE/);
    assert.match(nativeGate, /Buffer\.from\('\.data\/legacy-home'\)/);
    assert.match(nativeGate, /Buffer\.from\(\[0xff\]\)/);
    assert.match(nativeGate, /Buffer\.from\(\[2, 0\]\)/);
    assert.match(nativeGate, /function readOnlyDataPath\(source, target\)/);
    assert.match(nativeGate, /return encodeRecord\(12, payload\)/);
    assert.match(providerDescriptor, /\.\.\.productionReadOnlyDataPathRecords\(\)/);
    assert.match(readinessDescriptor, /\.\.\.productionReadOnlyDataPathRecords\(\)/);
    let mappingOffset = -1;
    for (const mapping of [
        "source: '/etc/resolv.conf', target: '/etc/resolv.conf'",
        "source: '/etc/hosts', target: '/etc/hosts'",
        "source: '/etc/passwd', target: '/etc/passwd'",
        "source: '/etc/group', target: '/etc/group'",
        "source: '/etc/authselect/nsswitch.conf', target: '/etc/nsswitch.conf'",
        "source: '/etc/ld.so.cache', target: '/etc/ld.so.cache'",
    ]) {
        const nextOffset = nativeGate.indexOf(mapping, mappingOffset + 1);
        assert.ok(nextOffset > mappingOffset, `production read-only data path is missing or out of order: ${mapping}`);
        mappingOffset = nextOffset;
    }
    assert.match(nativeGate, /PLOINKY_MOUNT_DESTINATION_UNSUPPORTED/);
    assert.match(nativeGate, /resolverMode, 0o444/);
    assert.match(nativeGate, /resolverMutationCodes/);
    assert.match(nativeGate, /chmodSync\(resolverPath, 0o644\)/);
    assert.match(nativeGate, /appendFileSync\(resolverPath/);
    assert.match(nativeGate, /truncateSync\(resolverPath, 0\)/);
    assert.match(nativeGate, /renameSync\(resolverPath, resolverMovedPath\)/);
    assert.match(nativeGate, /unlinkSync\(resolverPath\)/);
    assert.match(nativeGate, /resolverBeforeBytes\.equals\(resolverAfterBytes\)/);
    assert.match(nativeGate, /resolverIdentityAfter, readiness\.resolverIdentityBefore/);
    assert.match(nativeGate, /pinnedDataPathSources/);
    assert.match(nativeGate, /sandboxBytes\.equals\(pinnedDataPathSources\[index\]\.bytes\)/);
    assert.match(nativeGate, /source-to-target remap/);
    assert.match(nativeGate, /sources must have distinct content/);
    assert.match(nativeGate, /ro-data-path-hardening=sealed-memfd-ro-bind-data/);
    assert.match(nativeGate, /spawnSync\('\/usr\/local\/bin\/npm', \['--version'\]/);
    assert.match(nativeGate, /appendFileSync\('\/usr\/local\/bin\/node'/);
    assert.match(nativeGate, /helperReadiness\.namespaces\[name\][\s\S]*?outerNamespaces\[name\]/);
    assert.match(nativeGate, /helperProvider\.namespaces\[name\][\s\S]*?outerNamespaces\[name\]/);
    assert.match(nativeGate, /path\.basename\(identity\.executable\) === 'node'/);
    assert.match(nativeGate, /identity\.argv\.includes\('\/workspace\/project\/real-provider\.mjs'\)/);
    assert.match(nativeGate, /signalOwnedProvider\(child\.pid, provider\)/);
    assert.doesNotMatch(nativeGate, /process\.kill\(-1,/);
    assert.ok(waitForExit);
    assert.match(waitForExit, /child\.once\('close'/);
    assert.doesNotMatch(waitForExit, /child\.once\('exit'/);
});

test('Box image and reproduction workflow bind the source label to the immutable checkout', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const reproduce = read('.github/workflows/reproduce-ploinky-box-private-routing.yml');

    assert.match(dockerfile, /printf 'assistos\/ploinky-box\\n' > \/etc\/ploinky-box/);
    assert.match(dockerfile, /^LABEL io\.assistos\.ploinky\.source-sha=\$PLOINKY_SOURCE_SHA$/m);
    assert.match(reproduce, /'io\.assistos\.ploinky\.source-sha': process\.env\.PLOINKY_SOURCE_SHA/);
    assert.match(reproduce, /printf "assistos\/ploinky-box\\n" \| cmp - \/etc\/ploinky-box/);
    assert.match(reproduce, /assert\.equal\(BOX_MARKER_CONTENT, 'assistos\/ploinky-box\\n'\)/);
    assert.doesNotMatch(reproduce, /BOX_RUNTIME_CONTRACT|runtime-contract|contract-[0-9]+/);
    assert.match(reproduce, /import \{ BOX_MARKER_CONTENT \}/);
});
