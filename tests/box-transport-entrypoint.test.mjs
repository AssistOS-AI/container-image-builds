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
    assert.match(dockerfile, /typed-fs=dir,tmpfs,proc,dev,system-symlink/);
    assert.match(dockerfile, /preexec-barrier=R\/G/);
    assert.match(dockerfile, /credential-bound=4096/);
});

test('publication workflow gates candidate publication on native Bubblewrap behavior', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    assert.match(workflow, /Run native Bubblewrap behavior gate/);
    assert.match(workflow, /tests\/native:\/opt\/ploinky-native-tests:ro/);
    assert.match(workflow, /ploinky-box-bwrap\.mjs/);
    assert.match(workflow, /Podman Machine Bubblewrap gate/);
    assert.match(workflow, /\bpodman run --rm\b/);
    assert.doesNotMatch(workflow, /--privileged|seccomp=unconfined/);
    assert.doesNotMatch(workflow, /SMOKE_GRAPH_|PLOINKY_RELAY_TEST_IMAGE|PLOINKY_BOX_PROXY_TRACE/);
});

test('native Bubblewrap gate covers helper HOME ordering, empty readiness, and owned signals', () => {
    const nativeGate = read('tests/native/ploinky-box-bwrap.mjs');
    const providerDescriptor = nativeGate.match(
        /function helperLaunchDescriptor[\s\S]*?(?=\n}\n\nconst EMPTY_READINESS_SCRIPT)/,
    )?.[0] || '';
    const readinessDescriptor = nativeGate.match(
        /function helperEmptyReadinessDescriptor[\s\S]*?(?=\n}\n\nfunction waitForPreexecBarrier)/,
    )?.[0] || '';

    assert.ok(providerDescriptor);
    assert.ok(readinessDescriptor);
    assert.ok(providerDescriptor.indexOf("directory('/home')") < providerDescriptor.indexOf("home('.data/native-helper')"));
    assert.ok(readinessDescriptor.indexOf("tmpfs('/workspace')") < readinessDescriptor.indexOf("directory('/workspace/readiness')"));
    assert.ok(readinessDescriptor.indexOf("directory('/home')") < readinessDescriptor.indexOf("home('.data/native-readiness')"));
    assert.match(nativeGate, /spawnSync\('\/usr\/local\/bin\/npm', \['--version'\]/);
    assert.match(nativeGate, /appendFileSync\('\/usr\/local\/bin\/node'/);
    assert.match(nativeGate, /helperReadiness\.namespaces\[name\][\s\S]*?outerNamespaces\[name\]/);
    assert.match(nativeGate, /helperProvider\.namespaces\[name\][\s\S]*?outerNamespaces\[name\]/);
    assert.match(nativeGate, /path\.basename\(identity\.executable\) === 'node'/);
    assert.match(nativeGate, /identity\.argv\.includes\('\/workspace\/project\/real-provider\.mjs'\)/);
    assert.match(nativeGate, /signalOwnedProvider\(child\.pid, provider\)/);
    assert.doesNotMatch(nativeGate, /process\.kill\(-1,/);
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
