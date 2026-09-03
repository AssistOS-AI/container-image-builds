import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('ploinky-box image consumes only the canonical entrypoint and sealed runtime inputs', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    const sourceCopies = dockerfile.match(/^COPY sources\/ploinky\/.*$/gm) || [];
    assert.deepEqual(sourceCopies, [
        'COPY sources/ploinky/ploinky-box/entrypoint/ploinky-box-entrypoint /usr/local/bin/ploinky-box-entrypoint',
        'COPY sources/ploinky/ploinky-box/dependencies.lock.json /tmp/ploinky-box-dependencies.lock.json',
        'COPY sources/ploinky/ploinky-box/mcp-sdk-bundle.mjs /tmp/mcp-sdk-bundle.mjs',
        'COPY sources/ploinky/core-services/webtty/package.json /tmp/webtty-build/package.json',
        'COPY sources/ploinky/core-services/webtty/package-lock.json /tmp/webtty-build/package-lock.json',
        'COPY sources/ploinky/core-services/webtty/native-probe.mjs /usr/local/share/ploinky/webtty/native-probe.mjs',
    ]);
    assert.doesNotMatch(dockerfile, /COPY sources\/ploinky\/(?:cli|core-services\/(?!webtty\/)|node_modules|package\.json)/);
    assert.equal(fs.existsSync(path.join(ROOT, 'images/ploinky-box/entrypoint.sh')), false);
    assert.match(workflow, /Checkout immutable Ploinky source/);
    assert.match(workflow, /path:\s*sources\/ploinky/);
    assert.match(workflow, /Resolve immutable MCP SDK input from the Ploinky lock/);
    assert.match(workflow, /path:\s*sources\/mcp-sdk/);
    assert.match(workflow, /persist-credentials:\s*false/);
    assert.match(workflow, /PLOINKY_SOURCE_SHA=\$\{\{ needs\.resolve-source\.outputs\.source_sha \}\}/);
});

test('publication verifies immutable native capability without running full graph tests', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    assert.doesNotMatch(workflow, /\bnode --test\b/);
    assert.doesNotMatch(workflow, /tests\/(?:unit|integration|e2e)\//);
    assert.match(workflow, /native-probe\.mjs --verify/);
    assert.match(workflow, /verify-publication\.mjs native/);
    assert.doesNotMatch(workflow, /podman run/);
    assert.doesNotMatch(workflow, /SMOKE_GRAPH_|PLOINKY_RELAY_TEST_IMAGE|PLOINKY_BOX_PROXY_TRACE/);
});

test('Box image and reproduction workflow require the unversioned marker and empty labels', () => {
    const dockerfile = read('images/ploinky-box/Dockerfile');
    const reproduce = read('.github/workflows/reproduce-ploinky-box-private-routing.yml');

    assert.match(dockerfile, /printf 'assistos\/ploinky-box\\n' > \/etc\/ploinky-box/);
    assert.doesNotMatch(dockerfile, /^LABEL\s/m);
    assert.match(reproduce, /assert\.deepEqual\([^;]*Labels[^;]*\{\}\)/);
    assert.match(reproduce, /printf "assistos\/ploinky-box\\n" \| cmp - \/etc\/ploinky-box/);
    assert.match(reproduce, /assert\.equal\(BOX_MARKER_CONTENT, 'assistos\/ploinky-box\\n'\)/);
    assert.doesNotMatch(reproduce, /BOX_RUNTIME_CONTRACT|runtime-contract|contract-[0-9]+/);
    assert.match(reproduce, /import \{ BOX_MARKER_CONTENT \}/);
});
