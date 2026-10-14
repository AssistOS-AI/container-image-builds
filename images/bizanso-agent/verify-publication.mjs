import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./', import.meta.url));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
export const inputs = read(`${directory}/sources.lock.json`);
export const lockHash = createHash('sha256').update(readFileSync(`${directory}/package-lock.json`)).digest('hex');

export function verifyNativeProofs(root, expected) {
    assert.match(expected.workflowSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(readdirSync(root).sort(), ['bizanso-runtime-proof-amd64', 'bizanso-runtime-proof-arm64']);
    const digests = {};
    for (const arch of ['amd64', 'arm64']) {
        const folder = `${root}/bizanso-runtime-proof-${arch}`;
        const digest = readFileSync(`${folder}/digest.txt`, 'utf8').trim();
        assert.match(digest, /^sha256:[0-9a-f]{64}$/);
        const source = read(`${folder}/source-evidence.json`);
        const runtime = read(`${folder}/runtime.json`);
        const images = read(`${folder}/image-inspect.json`);
        assert.equal(source.imageDigest, digest);
        assert.equal(source.architecture, arch);
        assert.equal(source.workflowSha, expected.workflowSha);
        assert.equal(source.workflowRunId, expected.runId);
        assert.equal(source.workflowAttempt, expected.attempt);
        assert.equal(source.baseImage, inputs.baseImage);
        assert.equal(source.packageLockSha256, lockHash);
        assert.deepEqual(source.model, inputs.model);
        assert.equal(images.length, 1);
        assert.equal(images[0].Architecture, arch);
        assert.equal(images[0].Config.User, '1000:1000');
        assert.equal(images[0].Config.Labels['org.opencontainers.image.revision'], expected.workflowSha);
        assert.equal(images[0].Config.Labels['org.opencontainers.image.source'], 'https://github.com/AssistOS-AI/container-image-builds');
        assert.ok(images[0].RepoDigests.some(value => value === `docker.io/assistos/bizanso-agent@${digest}`
            || value === `assistos/bizanso-agent@${digest}`));
        assert.equal(runtime.schema, 'assistos.bizanso-runtime-proof/v1');
        assert.equal(runtime.ok, true);
        assert.equal(runtime.architecture, arch === 'amd64' ? 'x64' : 'arm64');
        assert.equal(runtime.uid, 1000);
        assert.equal(runtime.gid, 1000);
        assert.equal(runtime.offline, true);
        assert.equal(runtime.noApplicationSource, true);
        assert.equal(runtime.capabilities, '0000000000000000');
        assert.equal(runtime.noNewPrivileges, true);
        assert.deepEqual(runtime.networkInterfaces, ['lo']);
        assert.equal(runtime.transformersVersion, inputs.transformersVersion);
        assert.deepEqual(runtime.model, inputs.model);
        assert.ok(Number.isFinite(runtime.similarity) && runtime.similarity > 0.7);
        for (const tool of ['pdftotext', 'antiword', 'libreoffice']) {
            assert.equal(typeof runtime.tools[tool], 'string');
            assert.ok(runtime.tools[tool].length > 0);
        }
        digests[arch] = digest;
    }
    assert.notEqual(digests.amd64, digests.arm64);
    return digests;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const digests = verifyNativeProofs(process.argv[2], {
        workflowSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    for (const [arch, digest] of Object.entries(digests)) console.log(`${arch}_digest=${digest}`);
}
