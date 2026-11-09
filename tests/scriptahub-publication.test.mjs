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
    assert.deepEqual(lock.platforms, ['linux/amd64','linux/arm64']);
    // The application image is the pinned base alone: it runs no skill, so it carries no skills runtime.
    const agentDockerfile = read('images/scriptahub-agent/Dockerfile');
    assert.deepEqual(agentDockerfile.split('\n').filter(line => /^FROM\b/.test(line)), [`FROM ${lock.baseImage}`]);
    assert.doesNotMatch(agentDockerfile, /apt-get|prepare-skills|verify-skills|native-build|scriptahub-agent@sha256/);
    assert.doesNotMatch(agentDockerfile, /^(?:COPY|ADD|ENV)\b/m);
    assert.equal(lock.nativeBuilder, undefined);
    assert.match(workflow, /repository: Axiologic\/ScriptaHubAgent/);
    assert.match(workflow, /ref: \$\{\{ steps.source.outputs.revision \}\}/);
    assert.match(workflow, /runner: ubuntu-24\.04-arm/);
    assert.match(workflow, /runner: ubuntu-24\.04\s/);
    assert.doesNotMatch(workflow, /setup-qemu|SOURCE_REPO_TOKEN/);
});

test('runtime publication requires native offline proof and source equality before login or push', () => {
    const build = workflow.indexOf('name: Build locally before publication');
    const proof = workflow.indexOf('name: Prove the slim runtime serves the exact deployed sources offline');
    const login = workflow.indexOf('name: Log in to Docker Hub');
    const publish = workflow.indexOf('name: Publish verified candidate');
    assert.ok(build >= 0 && proof > build && login > proof && publish > login);
    assert.match(workflow.slice(build, proof), /push: false/);
    assert.match(workflow.slice(proof, login), /--network=none --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(workflow.slice(proof, login), /smoke-runtime\.mjs/);
    assert.match(workflow.slice(proof, login), /source\/scriptahubAgent:\/code:ro/);
    assert.doesNotMatch(workflow.slice(proof, login), /verify-skills|check-runtime/);
    assert.match(workflow, /if test "\$PROMOTE_STABLE" = true/);
    assert.match(workflow, /runtime-index\.json.*\n.*test .* = "\$digest"/);
    assert.match(workflow, /needs: publish/);
    assert.match(workflow, /index.manifests.length,2/);
    assert.match(workflow, /password: \$\{\{ secrets.DOCKERHUB_TOKEN \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    for (const match of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(match[1], /^[0-9a-f]{40}$/);
});

const assetsLock = JSON.parse(read('images/scriptahub-assets/sources.lock.json'));
const assetsDockerfile = read('images/scriptahub-assets/Dockerfile');
const assetsWorkflow = read('.github/workflows/publish-scriptahub-assets-image.yml');
const robotWorkflow = read('.github/workflows/publish-scriptahub-robot-image.yml');
const pinnedUses = text => { for (const match of text.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(match[1], /^[0-9a-f]{40}$/); };

test('ScriptaHub assets lock names the public source, both platforms and every digest-pinned build input', () => {
    assert.equal(assetsLock.schemaVersion, 1);
    assert.equal(assetsLock.repository, 'https://github.com/Axiologic/ScriptaHubAgent.git');
    assert.match(assetsLock.revision, /^[0-9a-f]{40}$/);
    assert.equal(assetsLock.image, 'docker.io/assistos/scriptahub-assets');
    assert.deepEqual(assetsLock.platforms, ['linux/amd64', 'linux/arm64']);
    assert.match(assetsLock.nativeBuilder, /^docker\.io\/library\/rust@sha256:[0-9a-f]{64}$/);
    assert.match(assetsLock.modelsSource, /^docker\.io\/assistos\/scriptahub-agent@sha256:[0-9a-f]{64}$/);
    assert.equal(assetsLock.modelsSource, 'docker.io/assistos/scriptahub-agent@sha256:81040fe16c49349572e37048ef0d4660078097774542f502c9c3a21ba0d3e534');
    assert.match(assetsLock.fetchBase, /^docker\.io\/assistos\/ploinky-node@sha256:[0-9a-f]{64}$/);
    assert.equal(assetsLock.fetchBase, lock.baseImage);
});

test('ScriptaHub assets image is built from digest-pinned stages, verifies its tree, and publishes only that tree', () => {
    assert.ok(assetsDockerfile.startsWith(`FROM ${assetsLock.nativeBuilder} AS native-build`));
    assert.ok(assetsDockerfile.includes(`FROM ${assetsLock.modelsSource} AS verified-models`));
    assert.ok(assetsDockerfile.includes(`FROM ${assetsLock.fetchBase} AS fetch`));
    const fetchRun = assetsDockerfile.slice(assetsDockerfile.indexOf('AS fetch'), assetsDockerfile.lastIndexOf('FROM scratch'));
    const prepare = fetchRun.indexOf('prepare-assets.mjs');
    const verify = fetchRun.indexOf('verify-assets.mjs');
    const normalize = fetchRun.indexOf('chmod -R a+rX,go-w,a-st /assets');
    assert.ok(prepare >= 0 && normalize > prepare && verify > normalize, 'files are fetched, given plain permissions, then verified');
    assert.match(fetchRun.slice(verify), /^verify-assets\.mjs[^\n]*--exact/);
    assert.match(fetchRun, /COPY --from=verified-models \/opt\/scriptahub\/runtime\/skills\/pdf2html\/external\/native\/models\/ /);
    assert.match(fetchRun, /COPY --from=native-build \/out\/ \/assets\/native-build\//);
    assert.match(fetchRun, /mkdir -p \/assets\/runtime \/assets\/native-build/, 'an ARM64 tree still has its empty native-build directory');
    // The published image is nothing but the verified tree, and it depends on the verifying stage.
    const finalStage = assetsDockerfile.slice(assetsDockerfile.lastIndexOf('FROM scratch'));
    assert.equal(finalStage.trim(), 'FROM scratch\nCOPY --from=fetch /assets/ /assets/');
    assert.doesNotMatch(fetchRun, /\b(?:apt-get|npm|pip)\b/, 'the fetch stage installs no package manager content');
});

test('ScriptaHub assets publication proves the exported bytes offline before login and push, natively per architecture', () => {
    assert.match(assetsWorkflow, /images\/scriptahub-assets\/sources\.lock\.json/);
    assert.match(assetsWorkflow, /file: images\/scriptahub-assets\/Dockerfile/);
    assert.match(assetsWorkflow, /repository: Axiologic\/ScriptaHubAgent/);
    assert.match(assetsWorkflow, /ref: \$\{\{ steps.source.outputs.revision \}\}/);
    assert.match(assetsWorkflow, /runner: ubuntu-24\.04-arm/);
    assert.match(assetsWorkflow, /runner: ubuntu-24\.04\s/);
    assert.doesNotMatch(assetsWorkflow, /setup-qemu|SOURCE_REPO_TOKEN/);
    assert.match(assetsWorkflow, /docker system prune -af/);
    const build = assetsWorkflow.indexOf('name: Build locally before publication');
    const proof = assetsWorkflow.indexOf('name: Prove the exported assets offline against the exact inventories');
    const login = assetsWorkflow.indexOf('name: Log in to Docker Hub');
    const publish = assetsWorkflow.indexOf('name: Publish verified candidate');
    assert.ok(build >= 0 && proof > build && login > proof && publish > login);
    assert.match(assetsWorkflow.slice(build, proof), /push: false/);
    const proofStep = assetsWorkflow.slice(proof, login);
    assert.match(proofStep, /--network=none --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(proofStep, /docker create "\$candidate" \/none/);
    assert.match(proofStep, /docker cp "\$cid":\/assets "\$tree"/);
    assert.match(proofStep, /verify-assets\.mjs --skills \/scripta-source\/skills[^\n]*\\\n\s*--runtime \/assets\/runtime --native-build \/assets\/native-build --exact/);
    assert.match(proofStep, /-v "\$tree:\/assets:ro"/);
    assert.match(proofStep, /rm -rf "\$tree"/);
    assert.match(assetsWorkflow, /group: publish-scriptahub-assets-image/);
    assert.equal(assetsWorkflow.match(/group: publish-scriptahub-assets-image/g).length, 1);
    assert.match(assetsWorkflow, /if test "\$PROMOTE_STABLE" = true/);
    assert.match(assetsWorkflow, /needs: publish/);
    assert.match(assetsWorkflow, /index.manifests.length,2/);
    assert.match(assetsWorkflow, /deepEqual\(members,\{'linux\/amd64':process.env.AMD64,'linux\/arm64':process.env.ARM64\}\)/);
    assert.match(assetsWorkflow, /image=docker\.io\/assistos\/scriptahub-assets$/m);
    assert.match(assetsWorkflow, /password: \$\{\{ secrets.DOCKERHUB_TOKEN \}\}/);
    assert.match(assetsWorkflow, /persist-credentials: false/);
    pinnedUses(assetsWorkflow);
});

test('ScriptaHub robot publication takes a verified assets index by digest and keeps its source revision lock', () => {
    assert.match(robotWorkflow, /scripta_assets_image:/);
    assert.doesNotMatch(robotWorkflow, /scripta_runtime_image|SCRIPTA_RUNTIME_IMAGE|scriptahub-agent@sha256|runtime-image/);
    const resolve = robotWorkflow.slice(robotWorkflow.indexOf('name: Resolve source revision and base image digests'), robotWorkflow.indexOf('  publish:'));
    assert.match(resolve, /node --test tests\/scriptahub-publication\.test\.mjs/);
    assert.ok(resolve.includes('[[ "$SCRIPTA_ASSETS_IMAGE" =~ ^docker\\.io/assistos/scriptahub-assets@sha256:[0-9a-f]{64}$ ]]'));
    assert.match(resolve, /imagetools inspect --raw "\$SCRIPTA_ASSETS_IMAGE" > assets-index\.json/);
    assert.match(resolve, /sha256sum assets-index\.json[^\n]*= "\$\{SCRIPTA_ASSETS_IMAGE#\*@\}"/, 'the input is the index itself');
    assert.match(resolve, /assert\.equal\(index\.manifests\.length,2\)/);
    assert.match(resolve, /\['linux\/amd64','linux\/arm64'\]/);
    assert.match(resolve, /images\/scriptahub-agent\/sources\.lock\.json/);
    assert.match(robotWorkflow, /SCRIPTA_ASSETS_IMAGE=\$\{\{ needs\.resolve\.outputs\.assets \}\}/);
    assert.match(robotWorkflow, /io\.assistos\.scriptahub\.assets-image=\$\{\{ needs\.resolve\.outputs\.assets \}\}/);
    assert.match(robotWorkflow, /file: source\/scriptahubAgent\/deployment\/Dockerfile\.robot/);
    const build = robotWorkflow.indexOf('name: Build and verify locally before publication');
    const proof = robotWorkflow.indexOf('name: Prove the installed runtime matches the exact sources');
    const login = robotWorkflow.indexOf('name: Log in to Docker Hub');
    const publish = robotWorkflow.indexOf('name: Publish verified candidate');
    assert.ok(build >= 0 && proof > build && login > proof && publish > login);
    assert.match(robotWorkflow.slice(proof, login), /--network=none --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(robotWorkflow.slice(proof, login), /verify-skills\.mjs/);
    assert.match(robotWorkflow, /if test "\$PROMOTE_STABLE" = true/);
    pinnedUses(robotWorkflow);
});
