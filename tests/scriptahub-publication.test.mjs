import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const lock = JSON.parse(read('images/scriptahub-agent/sources.lock.json'));
const workflow = read('.github/workflows/publish-scriptahub-agent-image.yml');

test('ScriptaHub agent builds a verified hosted runtime from the locked source', () => {
    assert.equal(lock.repository, 'https://github.com/Axiologic/ScriptaHubAgent.git');
    assert.match(lock.revision, /^[0-9a-f]{40}$/);
    assert.equal(lock.image, 'docker.io/assistos/scriptahub-agent');
    assert.deepEqual(lock.platforms, ['linux/amd64', 'linux/arm64']);
    const dockerfile = read('images/scriptahub-agent/Dockerfile');
    assert.match(dockerfile, new RegExp(`FROM ${lock.baseImage}`));
    assert.match(dockerfile, /FROM \${SCRIPTA_ASSETS_IMAGE} AS manuscript-assets/);
    const verify = dockerfile.indexOf('verify-assets.mjs');
    const copy = dockerfile.indexOf('cp -R --no-preserve=ownership /mnt/assets/runtime');
    assert.ok(verify >= 0 && copy > verify);
    assert.match(dockerfile.slice(verify, copy), /--exact/);
    assert.match(dockerfile, /prepare-skills.mjs/);
    assert.match(dockerfile, /USER 1000:1000\nRUN node .*verify-skills.mjs/);
    assert.match(workflow, /context: source/);
    assert.match(workflow, /Source lock predates hosted processing protocol/);
    assert.match(workflow, /processing-runtime-acceptance.mjs/);
    assert.match(workflow, /processing-protocol.json/);
    assert.match(workflow, /assert.deepEqual\(protocol, \{version: 1\}/);
    assert.match(workflow, /SCRIPTA_ASSETS_IMAGE.*scriptahub-assets@sha256/);
    assert.match(workflow, /sha256sum assets-index.json/);
    assert.match(workflow, /index.manifests.length, 2/);
    assert.match(workflow, /runner: ubuntu-24\.04-arm/);
    assert.match(workflow, /runner: ubuntu-24\.04\s/);
    assert.doesNotMatch(workflow, /setup-qemu|SOURCE_REPO_TOKEN/);
});

test('runtime publication requires native offline proof and source equality before login or push', () => {
    const build = workflow.indexOf('name: Build locally before publication');
    const proof = workflow.indexOf('name: Prove the hosted runtime and exact deployed sources offline');
    const login = workflow.indexOf('name: Log in to Docker Hub');
    const publish = workflow.indexOf('name: Publish verified candidate');
    assert.ok(build >= 0 && proof > build && login > proof && publish > login);
    assert.match(workflow.slice(build, proof), /push: false/);
    const proofStep = workflow.slice(proof, login);
    assert.match(proofStep, /docker save "\$candidate" \| podman load/);
    assert.match(proofStep, /podman image inspect "\$config_id"/);
    assert.match(proofStep, /podman.Id.replace\(\/\^sha256:\//);
    assert.match(proofStep, /assert.equal\(podman.Architecture, docker.Architecture/);
    assert.match(proofStep, /assert.deepEqual\(podman.Labels \?\? podman.Config.Labels, docker.Config.Labels/);
    assert.match(proofStep, /Insufficient Podman import headroom/);
    assert.equal((proofStep.match(/podman run --rm --init --network=none --cap-drop=ALL --security-opt=no-new-privileges --security-opt=label=disable --security-opt='unmask=\/proc\/\*' --ipc=private/g) || []).length, 2);
    assert.match(workflow, /dpkg-query -W podman catatonit/);
    assert.match(workflow.slice(publish), /docker image inspect --format '\{\{.Id\}\}' "\$candidate".*config-id.txt/);
    assert.match(proofStep, /smoke-runtime\.mjs/);
    assert.match(proofStep, /processing-runtime-acceptance\.mjs/);
    assert.match(proofStep, /source\/skills:\/source-skills:ro/);
    for (const label of ['skills-tree', 'deployment-tree', 'reader-css-blob', 'assets-image']) assert.ok(workflow.includes(`io.assistos.scriptahub.${label}`));
    assert.match(workflow, /Native candidates differ/);
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
