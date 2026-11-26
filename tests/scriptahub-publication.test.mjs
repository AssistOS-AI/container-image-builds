import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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
    assert.equal((proofStep.match(/-v "\$PWD\/source:\/workspace\/ScriptaHubAgent:ro" -v "\$PWD\/source\/scriptahubAgent:\/code:ro"/g) || []).length, 2);
    assert.equal((proofStep.match(/-e WORKSPACE_PATH=\/workspace -e DEPENDENCY_FINGERPRINT="\$DEPENDENCY"/g) || []).length, 2);
    assert.match(proofStep, /'io.assistos.scriptahub.dependency-fingerprint': process.env.DEPENDENCY/);
    assert.match(workflow, /Source lock predates mounted skill sources/);
    assert.match(workflow, /cat-file -e "\$SOURCE_REVISION:scriptahubAgent\/deployment\/dependency-inputs.txt"/);
    assert.match(workflow, /dependency=\$\(dependency_fingerprint source "\$SOURCE_REVISION"\) \|\|/);
    assert.match(workflow, /echo "dependency=\$\{dependency\}" >> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /io.assistos.scriptahub.dependency-fingerprint=\$\{\{ steps.trees.outputs.dependency \}\}/);
    for (const legacy of ['skills-tree', 'deployment-tree', 'reader-css-blob']) assert.match(workflow, new RegExp(`io\\.assistos\\.scriptahub\\.${legacy}=`), 'legacy label kept for rollback');
    const assemble = workflow.slice(workflow.indexOf('assemble:'));
    assert.match(assemble, /'io.assistos.scriptahub.reader-css-blob', 'io.assistos.scriptahub.dependency-fingerprint'\]/);
    const smoke = read('images/scriptahub-agent/smoke-runtime.mjs');
    assert.ok(smoke.indexOf("'/bin/chmod', ['-R', 'u+rwx', directory]") > 0 && smoke.indexOf("'/bin/chmod', ['-R', 'u+rwx', directory]") < smoke.lastIndexOf('fs.rm(directory'), 'read-only skill snapshots must be made writable before the proof removes its directory');
    for (const text of [/receipt.dependencyFingerprint, label/, /assert\.equal\(mounted, label/, /checkoutReader\('\/workspace\/ScriptaHubAgent'\)/, /WORKSPACE_PATH: '\/workspace'/, /source\.json/]) assert.match(smoke, text);
    for (const label of ['skills-tree', 'deployment-tree', 'reader-css-blob', 'assets-image', 'dependency-fingerprint']) assert.ok(workflow.includes(`io.assistos.scriptahub.${label}`));
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

// The sh+git fingerprint contract: the workflow's marked block is executed against temp git repositories.
const block = (() => {
    const begin = workflow.indexOf('# BEGIN ScriptaHub dependency fingerprint');
    const end = workflow.indexOf('# END ScriptaHub dependency fingerprint');
    assert.ok(begin >= 0 && end > begin);
    return workflow.slice(begin, end + '# END ScriptaHub dependency fingerprint'.length).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
})();
const INPUTS = 'scriptahubAgent/deployment/dependency-inputs.txt';
const LOCK = 'skills/x/external/html/package-lock.json';
const GOLDEN = 'b46a273fb33f3535a42f1244c246494d87596d7214588d45b9bdb74877b40016';
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture({ list = `${INPUTS}\n${LOCK}\n`, files = { [LOCK]: '{}\n' }, symlinks = {}, executable = [] } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptahub-fingerprint-'));
    roots.push(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
    if (list !== null) write(INPUTS, list);
    for (const [file, content] of Object.entries(files)) write(file, content);
    for (const [file, target] of Object.entries(symlinks)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.symlinkSync(target, path.join(root, file)); }
    for (const file of executable) fs.chmodSync(path.join(root, file), 0o755);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    return root;
}
const run = (shell, root) => spawnSync(shell, ['-eu', '-c', `${block}\ndependency_fingerprint "$1" HEAD`, 'sh', root], { encoding: 'utf8' });
const shells = ['sh', 'bash', ...(fs.existsSync('/bin/dash') ? ['dash'] : [])];

test('the workflow sh fingerprint block has no single quotes and matches the golden vector under every available POSIX shell', () => {
    assert.doesNotMatch(block, /'/);
    for (const shell of shells) {
        const result = run(shell, fixture());
        assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
        assert.equal(result.stdout, `${GOLDEN}\n`);
    }
});

test('the workflow sh fingerprint block accepts executable blobs and unrelated untracked or dirty files do not matter', () => {
    const executableRoot = fixture({ executable: [LOCK] });
    assert.match(execFileSync('git', ['-C', executableRoot, 'ls-tree', 'HEAD', '--', LOCK], { encoding: 'utf8' }), /^100755 blob /);
    for (const shell of shells) assert.equal(run(shell, executableRoot).stdout, `${GOLDEN}\n`, shell);
    const root = fixture();
    fs.writeFileSync(path.join(root, LOCK), 'dirty\n');
    fs.writeFileSync(path.join(root, 'untracked'), 'x');
    assert.equal(run('sh', root).stdout, `${GOLDEN}\n`);
});

const negatives = {
    'CRLF line endings': { list: `${INPUTS}\r\n${LOCK}\r\n` },
    'a missing final newline': { list: `${INPUTS}\n${LOCK}` },
    'an empty list': { list: '' },
    'a blank line': { list: `${INPUTS}\n\n${LOCK}\n` },
    'an unsorted list': { list: `${LOCK}\n${INPUTS}\n` },
    'a duplicate entry': { list: `${INPUTS}\n${LOCK}\n${LOCK}\n` },
    'a dot-dot segment': { list: `${INPUTS}\nskills/../${LOCK}\n`, files: { [LOCK]: '{}\n' } },
    'a dot segment': { list: `${INPUTS}\nskills/./x\n` },
    'a character outside the path pattern': { list: `${INPUTS}\nskills/a b\n`, files: { 'skills/a b': 'x' } },
    'a leading slash': { list: `/${INPUTS}\n` },
    'a NUL byte': { list: `${INPUTS}\n${LOCK}\u0000\n` },
    'a symlink entry (mode 120000)': { symlinks: { [LOCK]: INPUTS }, files: {} },
    'a missing self entry': { list: `${LOCK}\n` },
    'an entry absent from the tree': { list: `${INPUTS}\nskills/x/missing.json\n`, files: {} },
    'a directory entry': { list: `${INPUTS}\nskills\n` },
};
for (const [name, options] of Object.entries(negatives)) {
    test(`the workflow sh fingerprint block fails closed on ${name}`, () => {
        for (const shell of shells) {
            const result = run(shell, fixture(options));
            assert.notEqual(result.status, 0, `${shell} accepted ${name}`);
            assert.equal(result.stdout, '', `${shell} printed a fingerprint for ${name}`);
        }
    });
}

test('the workflow sh fingerprint block fails closed when the inputs file is absent at the revision', () => {
    const root = fixture({ list: null });
    assert.notEqual(run('sh', root).status, 0);
});

test('the golden vector blob ids are the ones the plan states', () => {
    const blob = text => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
    assert.equal(blob(`${INPUTS}\n${LOCK}\n`), 'd67c3732bb949e42f387870a4b7b259d7587f9dd');
    assert.equal(blob('{}\n'), '0967ef424bce6791893e9a57bb952f80fd536e93');
});
