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
        /^COPY sources\/ploinky\/ploinky-box\/entrypoint\/ploinky-box-entrypoint \/usr\/local\/bin\/ploinky-box-entrypoint$/m,
    );
    assert.equal(fs.existsSync(path.join(ROOT, 'images/ploinky-box/entrypoint.sh')), false);
    assert.match(workflow, /sources\/ploinky\/tests\/unit\/ploinkyBoxEntrypoint\.test\.mjs|ploinkyBox\*\.test\.mjs/);
    assert.match(workflow, /Run canonical Box entrypoint and unit suites/);
});

test('canonical transport behavior remains a mandatory pre-candidate source gate', () => {
    const workflow = read('.github/workflows/publish-ploinky-box-image.yml');

    const sourceGate = workflow.indexOf('Run canonical Box entrypoint and unit suites');
    const candidateBuild = workflow.indexOf('Build and push candidate by digest');
    assert.ok(sourceGate > 0 && sourceGate < candidateBuild);
    assert.match(workflow, /tests\/unit[\s\S]*?ploinkyBox\*\.test\.mjs/);
    assert.match(workflow, /node --test "\$\{tests\[@\]\}"/);
});

test('Box workflows require the unversioned image marker and empty image labels', () => {
    const publish = read('.github/workflows/publish-ploinky-box-image.yml');
    const reproduce = read('.github/workflows/reproduce-ploinky-box-private-routing.yml');

    for (const workflow of [publish, reproduce]) {
        assert.match(workflow, /assert\.deepEqual\([^;]*Labels[^;]*\{\}\)/);
        assert.match(workflow, /printf "assistos\/ploinky-box\\n" \| cmp - \/etc\/ploinky-box/);
        assert.match(workflow, /assert\.equal\(BOX_MARKER_CONTENT, 'assistos\/ploinky-box\\n'\)/);
        assert.doesNotMatch(workflow, /BOX_RUNTIME_CONTRACT|runtime-contract|contract-[0-9]+/);
    }
    assert.match(publish, /import \{ BOX_MARKER_CONTENT \}/);
    assert.match(reproduce, /import \{ BOX_MARKER_CONTENT \}/);
});
