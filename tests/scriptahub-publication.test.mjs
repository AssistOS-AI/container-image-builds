import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const lock = JSON.parse(read('images/scriptahub-agent/sources.lock.json'));
const workflow = read('.github/workflows/publish-scriptahub-agent-image.yml');

test('ScriptaHub publication binds an immutable public source and the supported native platform', () => {
    assert.equal(lock.repository, 'https://github.com/Axiologic/ScriptaHubAgent.git');
    assert.match(lock.revision, /^[0-9a-f]{40}$/);
    assert.equal(lock.image, 'docker.io/assistos/scriptahub-agent');
    assert.equal(lock.platform, 'linux/arm64');
    assert.equal(read('images/scriptahub-agent/Dockerfile').split('\n')[0], `FROM ${lock.baseImage}`);
    assert.match(workflow, /repository: Axiologic\/ScriptaHubAgent/);
    assert.match(workflow, /ref: \$\{\{ steps.source.outputs.revision \}\}/);
    assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
    assert.doesNotMatch(workflow, /setup-qemu|linux\/amd64|SOURCE_REPO_TOKEN/);
});

test('runtime publication requires native offline proof and source equality before login or push', () => {
    const build = workflow.indexOf('name: Build locally before publication');
    const proof = workflow.indexOf('name: Prove offline runtime and exact deployed sources');
    const login = workflow.indexOf('name: Log in to Docker Hub');
    const publish = workflow.indexOf('name: Publish verified candidate');
    assert.ok(build >= 0 && proof > build && login > proof && publish > login);
    assert.match(workflow.slice(build, proof), /push: false/);
    assert.match(workflow.slice(proof, login), /--network=none --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(workflow.slice(proof, login), /verify-skills\.mjs/);
    assert.match(workflow.slice(proof, login), /check-runtime\.mjs/);
    assert.match(workflow, /if test "\$PROMOTE_STABLE" = true/);
    assert.match(workflow, /runtime-manifest\.json.*\n.*test .* = "\$digest"/);
    assert.match(workflow, /password: \$\{\{ secrets.DOCKERHUB_TOKEN \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    for (const match of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(match[1], /^[0-9a-f]{40}$/);
});
