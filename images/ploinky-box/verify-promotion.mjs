// Promotion-only verification of an already built Ploinky Box candidate.
//
// The promotion workflow never builds. It pins one earlier run of
// publish-ploinky-box-image.yml, downloads that run's evidence, rebuilds the
// publication context from the CANDIDATE (its run, attempt, Ploinky source, image
// definitions and frozen library inputs, never from the promotion run), runs the
// candidate's own verifier against the raw index fetched by digest, and checks
// the operator's acceptance receipt against the same pins. Only after all of that
// does a second job log in and move `latest` and `runtime`.
//
// The candidate's verifier (and the Ploinky modules it loads) is candidate code.
// It runs in a child Node process with a minimal environment, so it cannot patch
// this process's `assert` or other state; this process keeps the raw-index hash,
// artifact equality, native-evidence hash and receipt-binding checks for itself.
// It also runs against a private copy of the evidence and compares its output only
// with an in-memory snapshot taken and hash-checked before it started, so nothing
// the child writes to disk is ever read back as trusted input.
//
// Every registry or Actions command goes through an injected executor
// `(command, args) => stdout`, so tests substitute it and nothing here reaches a
// network by itself. The verifier module is loaded, in the child, from the
// checkout of the candidate's image-definition commit: its own bytes are part of
// every saved proof (`verifierSha256`), so only that exact file reproduces them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineImageId, parseCanonicalReceipt } from './acceptance-receipt.mjs';

export const CANDIDATE_REPOSITORY = 'AssistOS-AI/container-image-builds';
export const CANDIDATE_WORKFLOW_PATH = '.github/workflows/publish-ploinky-box-image.yml';
export const IMAGE_REPOSITORY = 'docker.io/assistos/ploinky-box';
export const ALIASES = Object.freeze(['latest', 'runtime']);
const ARCHITECTURES = ['amd64', 'arm64'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POSITIVE = /^[1-9][0-9]{0,18}$/;
const NOT_FOUND = /not found|manifest unknown|no such manifest|name unknown/i;
const RAW_FILES = ['image-inspect.json', 'immutable-webtty.json', 'native-probe.json', 'library-smoke.json', 'library-self-test.json', 'library-provenance.json'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const asBuffer = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? '')));

/** The default executor. Arguments are never interpolated into a shell. */
export function defaultExec(command, args) {
    const result = spawnSync(command, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    if (result.error || result.status !== 0) {
        const stderr = String(result.stderr ?? '').trim().slice(0, 1000);
        const error = new Error(`${command} ${args.slice(0, 3).join(' ')} failed${result.status === null ? '' : ` with status ${result.status}`}${stderr ? `: ${stderr}` : ''}${result.error ? `: ${result.error.message}` : ''}`);
        error.stderr = stderr;
        throw error;
    }
    return result.stdout;
}

/**
 * Validate and normalize the dispatch inputs. A tag, a short or upper-case
 * digest, a symbolic revision, and a malformed run or attempt are all rejected.
 */
export function validateInputs(env, { requireReceipt = true } = {}) {
    const inputs = {
        runId: String(env.CANDIDATE_RUN_ID ?? ''), runAttempt: String(env.CANDIDATE_RUN_ATTEMPT ?? ''),
        digest: String(env.CANDIDATE_DIGEST ?? ''), sourceSha: String(env.SOURCE_SHA ?? ''),
        imageDefinitionsSha: String(env.IMAGE_DEFINITIONS_SHA ?? ''),
    };
    assert.match(inputs.runId, POSITIVE, 'candidate_run_id must be a positive run number');
    assert.match(inputs.runAttempt, POSITIVE, 'candidate_run_attempt must be a positive attempt number');
    assert.match(inputs.digest, DIGEST, 'candidate_digest must be an immutable sha256:<64 hex> index digest, never a tag');
    assert.match(inputs.sourceSha, COMMIT, 'source_sha must be an exact 40-character commit');
    assert.match(inputs.imageDefinitionsSha, COMMIT, 'image_definitions_sha must be an exact 40-character commit');
    if (requireReceipt) {
        // Valid and canonical, so the stored evidence is exactly the validated value.
        parseCanonicalReceipt(env.ACCEPTANCE_RECEIPT_JSON);
        inputs.receiptText = env.ACCEPTANCE_RECEIPT_JSON;
    }
    return inputs;
}

/**
 * Pin the candidate run. `/runs/<id>/attempts/<n>` is used rather than
 * `/runs/<id>`, which always describes the latest attempt.
 */
export function pinCandidateRun(run, inputs) {
    assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'the candidate run record is malformed');
    assert.equal(String(run.id), inputs.runId, 'the record is another run');
    assert.equal(run.repository?.full_name, CANDIDATE_REPOSITORY, 'the candidate run belongs to another repository');
    assert.equal(run.head_repository?.full_name, CANDIDATE_REPOSITORY, 'the candidate run was built from another repository');
    assert.match(String(run.path), /^\.github\/workflows\/publish-ploinky-box-image\.yml(@refs\/(heads|tags)\/[A-Za-z0-9._\/-]+)?$/, 'the candidate run is not publish-ploinky-box-image.yml');
    assert.equal(run.event, 'workflow_dispatch', 'the candidate run was not dispatched');
    assert.equal(run.status, 'completed', 'the candidate run did not complete');
    assert.equal(run.conclusion, 'success', 'the candidate run did not succeed');
    assert.equal(String(run.run_attempt), inputs.runAttempt, 'the record is another run attempt');
    assert.equal(run.head_sha, inputs.imageDefinitionsSha, 'the candidate run head differs from image_definitions_sha');
    return run;
}

export const artifactNamesFor = ({ runId, runAttempt }) => [
    `ploinky-box-candidate-${runId}-${runAttempt}`, 'ploinky-box-native-amd64', 'ploinky-box-native-arm64',
    `ploinky-box-library-inputs-${runId}-${runAttempt}`,
];

/** Exactly one live artifact of each required name, produced by the pinned run. */
export function checkArtifactListing(listing, inputs) {
    assert.ok(Array.isArray(listing), 'artifact listing is malformed');
    return artifactNamesFor(inputs).map((name) => {
        const matches = listing.filter((artifact) => artifact?.name === name);
        assert.ok(matches.length > 0, `the candidate run has no artifact ${name}`);
        assert.ok(matches.length === 1, `the candidate run has more than one artifact ${name}`);
        const [artifact] = matches;
        assert.ok(artifact.expired === false, `artifact ${name} is expired`);
        assert.equal(String(artifact.workflow_run?.id), inputs.runId, `artifact ${name} belongs to another run`);
        assert.equal(artifact.workflow_run?.head_sha, inputs.imageDefinitionsSha, `artifact ${name} was built from another image-definition commit`);
        return artifact;
    });
}

/** The layout the verifier expects: native evidence in a directory of its own. */
export function evidenceLayout(evidenceDir) {
    return {
        candidate: path.join(evidenceDir, 'candidate'),
        proofs: path.join(evidenceDir, 'proofs'),
        libraryInputs: path.join(evidenceDir, 'library-inputs'),
    };
}

/** Download only the four named artifacts, only from the pinned run. */
export function downloadCandidateEvidence(inputs, evidenceDir, exec = defaultExec) {
    const layout = evidenceLayout(evidenceDir);
    const [candidate, amd64, arm64, libraryInputs] = artifactNamesFor(inputs);
    fs.mkdirSync(layout.proofs, { recursive: true });
    for (const [name, directory] of [
        [candidate, layout.candidate], [amd64, path.join(layout.proofs, 'ploinky-box-native-amd64')],
        [arm64, path.join(layout.proofs, 'ploinky-box-native-arm64')], [libraryInputs, layout.libraryInputs],
    ]) {
        assert.ok(!fs.existsSync(directory), `${directory} already exists`);
        exec('gh', ['run', 'download', inputs.runId, '--repo', CANDIDATE_REPOSITORY, '--name', name, '--dir', directory]);
    }
}

/** The frozen library selections of the candidate, as the env `publicationContext` reads. */
export function loadLibraryInputs(file) {
    const value = readJson(file);
    assert.deepEqual(Object.keys(value).sort(), ['libraries', 'schema'], 'library inputs must contain exactly schema and libraries');
    assert.equal(value.schema, 'ploinky.box.library-inputs/v1', 'library inputs schema is not supported');
    assert.deepEqual(Object.keys(value.libraries).sort(), ['achillesAgentLib', 'mcp-sdk'], 'library inputs must name exactly achillesAgentLib and mcp-sdk');
    const prefixes = { achillesAgentLib: 'AGENTLIB', 'mcp-sdk': 'MCP_SDK' };
    const env = {};
    for (const [library, selection] of Object.entries(value.libraries)) {
        assert.deepEqual(Object.keys(selection).sort(), ['branch', 'commit', 'repository'], `${library} selection must contain exactly repository, branch and commit`);
        assert.equal(typeof selection.repository, 'string', `${library} repository is malformed`);
        assert.match(selection.commit, COMMIT, `${library} commit must be exact`);
        assert.ok(selection.branch === null || typeof selection.branch === 'string', `${library} branch is malformed`);
        env[`${prefixes[library]}_REPOSITORY`] = selection.repository;
        env[`${prefixes[library]}_BRANCH`] = selection.branch ?? '';
        env[`${prefixes[library]}_COMMIT`] = selection.commit;
    }
    return { env, commits: { achillesAgentLib: value.libraries.achillesAgentLib.commit, 'mcp-sdk': value.libraries['mcp-sdk'].commit } };
}

/** The raw index bytes of an immutable reference, read-only. */
export function fetchRawIndex(reference, exec) {
    return asBuffer(exec('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]));
}

// Relative file paths, sorted. A link, device, or other non-regular entry is rejected.
function listFiles(root, prefix = '') {
    const files = [];
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...listFiles(root, relative));
        else {
            assert.ok(entry.isFile(), `${relative} is not a regular file`);
            files.push(relative);
        }
    }
    return files.sort();
}

function sameTree(left, right, label) {
    assert.deepEqual(listFiles(left), listFiles(right), `${label}: file sets differ`);
    for (const file of listFiles(left)) {
        assert.ok(fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file))), `${label}: ${file} differs`);
    }
}

/**
 * The candidate's own verification, run as candidate code in a child process.
 * It gets a fresh environment (no inherited GITHUB_OUTPUT, GITHUB_ENV,
 * GITHUB_PATH, GITHUB_STEP_SUMMARY, tokens, or secrets) holding only the
 * candidate's context, and prints `{ proofs, candidate }` as JSON.
 */
function runCandidateVerifier({ inputs, libraries, sourceRoot, imageDefinitionsRoot, proofsRoot, rawIndexFile }) {
    const env = {
        PATH: process.env.PATH || '', TMPDIR: process.env.TMPDIR || '',
        SOURCE_SHA: inputs.sourceSha, GITHUB_SHA: inputs.imageDefinitionsSha,
        GITHUB_RUN_ID: inputs.runId, GITHUB_RUN_ATTEMPT: inputs.runAttempt, ...libraries.env,
    };
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'candidate-verifier', JSON.stringify({
        sourceRoot: path.resolve(sourceRoot), imageDefinitionsRoot: path.resolve(imageDefinitionsRoot),
        proofsRoot: path.resolve(proofsRoot), rawIndexFile: path.resolve(rawIndexFile),
    })], { env, cwd: path.resolve(sourceRoot, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    assert.ok(!result.error && result.status === 0, `the candidate verifier rejected the candidate: ${String(result.stderr || result.error?.message || '').trim().slice(0, 1000)}`);
    let output;
    try { output = JSON.parse(result.stdout); } catch { assert.fail('the candidate verifier printed no JSON'); }
    assert.deepEqual(Object.keys(output).sort(), ['candidate', 'proofs'], 'the candidate verifier printed an unexpected result');
    return output;
}

/** Child entry point: import the candidate's verifier and print its result. */
async function candidateVerifierMain(configText) {
    const { sourceRoot, imageDefinitionsRoot, proofsRoot, rawIndexFile } = JSON.parse(configText);
    const { publicationContext, verifyCandidate, verifyNativeProofs } = await import(pathToFileURL(path.join(imageDefinitionsRoot, 'images/ploinky-box/verify-publication.mjs')));
    const context = await publicationContext(sourceRoot, process.env);
    const proofs = verifyNativeProofs(proofsRoot, context);
    const candidate = verifyCandidate(proofsRoot, rawIndexFile, context);
    process.stdout.write(JSON.stringify({ proofs, candidate }));
}

/**
 * Read the saved evidence into memory, once, before any candidate code runs, and
 * check it against the candidate identity, the index members, and the hashes it
 * records. Everything the promotion trusts afterwards comes from this snapshot,
 * never from a later read of the (shared, writable) evidence directory.
 */
function snapshotSavedEvidence({ proofsRoot, candidateDir, index, inputs }) {
    const candidateProofBytes = fs.readFileSync(path.join(candidateDir, 'candidate-proof.json'));
    const candidateProof = JSON.parse(candidateProofBytes);
    assert.equal(candidateProof.image?.digest, inputs.digest, 'the saved candidate proof names another index digest');
    const members = new Map(index.manifests.map((entry) => [`${entry.platform?.os}/${entry.platform?.architecture}`, entry.digest]));
    const nativeProofs = Object.fromEntries(ARCHITECTURES.map((arch) => {
        const directory = path.join(proofsRoot, `ploinky-box-native-${arch}`);
        const bytes = fs.readFileSync(path.join(directory, 'native-proof.json'));
        assert.equal(sha256(bytes), candidateProof.nativeProofSha256?.[arch], `native-proof.json for ${arch} does not match the candidate proof hash`);
        const proof = JSON.parse(bytes);
        assert.equal(proof.schema, 'ploinky.box.native-publication/v1', `${arch} native proof schema`);
        assert.equal(proof.sourceCommit, inputs.sourceSha, `${arch} native proof source commit`);
        assert.equal(proof.imageDefinitionsCommit, inputs.imageDefinitionsSha, `${arch} native proof image-definition commit`);
        assert.deepEqual(proof.workflow, { runId: inputs.runId, runAttempt: inputs.runAttempt }, `${arch} native proof run identity`);
        assert.equal(proof.image?.repository, IMAGE_REPOSITORY, `${arch} native proof repository`);
        assert.equal(proof.image.platform, `linux/${arch}`, `${arch} native proof platform`);
        assert.match(proof.image.configDigest, DIGEST, `${arch} native proof config digest`);
        assert.equal(proof.image.digest, members.get(`linux/${arch}`), `${arch} native proof digest is not the index member`);
        assert.equal(fs.readFileSync(path.join(directory, 'digest.txt'), 'utf8').trim(), proof.image.digest, `${arch} digest.txt`);
        assert.deepEqual(Object.keys(proof.evidenceSha256 || {}).sort(), [...RAW_FILES].sort(), `${arch} native proof evidence names`);
        const raw = {};
        for (const name of RAW_FILES) {
            raw[name] = fs.readFileSync(path.join(directory, name));
            assert.equal(sha256(raw[name]), proof.evidenceSha256[name], `${arch} raw evidence ${name} does not match its recorded hash`);
        }
        // The engine image ID in the hash-checked raw image-inspect evidence is the config digest.
        const [image] = JSON.parse(raw['image-inspect.json']);
        assert.equal(image?.Architecture, arch, `${arch} image-inspect evidence is for another architecture`);
        assert.equal(engineImageId(image), proof.image.configDigest, `${arch} config digest differs from the raw image-inspect Id`);
        return [arch, proof];
    }));
    return { candidateProof, nativeProofs };
}

/** A private copy of the evidence for the candidate verifier, removed by the caller. */
function privateEvidenceCopy({ proofsRoot, rawIndex }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-candidate-verify-'));
    fs.cpSync(proofsRoot, path.join(directory, 'proofs'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'raw-index.json'), rawIndex);
    return { directory, proofsRoot: path.join(directory, 'proofs'), rawIndexFile: path.join(directory, 'raw-index.json') };
}

/**
 * Verify the candidate and the acceptance receipt. Reads registry state only
 * through `exec`, and only the raw index of the immutable digest. Returns the
 * verification record, which it also writes to the evidence directory.
 */
export async function verifyCandidateForPromotion({ inputs, receiptText, evidenceDir, sourceRoot, imageDefinitionsRoot, exec = defaultExec, promotion }) {
    const layout = evidenceLayout(evidenceDir);
    const libraries = loadLibraryInputs(path.join(layout.libraryInputs, 'library-inputs.json'));
    const receipt = parseCanonicalReceipt(receiptText);

    const raw = fetchRawIndex(`${IMAGE_REPOSITORY}@${inputs.digest}`, exec);
    assert.equal(`sha256:${sha256(raw)}`, inputs.digest, 'the registry index bytes do not hash to candidate_digest');
    const rawIndexFile = path.join(evidenceDir, 'raw-index.json');
    fs.writeFileSync(rawIndexFile, raw);

    for (const name of ['candidate-index.json', 'immutable-index.json', 'confirmed-candidate-index.json']) {
        assert.ok(fs.readFileSync(path.join(layout.candidate, name)).equals(raw), `${name} of the candidate artifact differs from the registry index`);
    }
    assert.equal(fs.readFileSync(path.join(layout.candidate, 'digest.txt'), 'utf8').trim(), inputs.digest, 'digest.txt of the candidate artifact is another digest');
    assert.equal(fs.readFileSync(path.join(layout.candidate, 'candidate-ref.txt'), 'utf8').trim(),
        `${IMAGE_REPOSITORY}:runtime-candidate-${inputs.runId}-${inputs.runAttempt}`, 'candidate-ref.txt names another run-scoped candidate tag');
    // The two separately downloaded native sets are the candidate's own copy, byte for byte.
    const copy = path.join(layout.candidate, 'native-proofs');
    assert.deepEqual(fs.readdirSync(copy).sort(), ARCHITECTURES.map((arch) => `ploinky-box-native-${arch}`), 'candidate native-proofs is not exactly the two native sets');
    sameTree(copy, layout.proofs, 'candidate copy of native-proofs');

    // Snapshot and hash-check the saved evidence before any candidate code runs.
    const { candidateProof: saved, nativeProofs: proofs } = snapshotSavedEvidence({
        proofsRoot: layout.proofs, candidateDir: layout.candidate, index: JSON.parse(raw), inputs,
    });

    // The candidate's own verifier, from its own checkout, against the candidate's own context and a
    // private copy of the evidence. The promotion run's GITHUB_SHA and run ID are not used.
    const privateCopy = privateEvidenceCopy({ proofsRoot: layout.proofs, rawIndex: raw });
    let child;
    try {
        child = runCandidateVerifier({ inputs, libraries, sourceRoot, imageDefinitionsRoot, proofsRoot: privateCopy.proofsRoot, rawIndexFile: privateCopy.rawIndexFile });
    } finally {
        fs.rmSync(privateCopy.directory, { recursive: true, force: true });
    }
    // Compared only with the in-memory snapshot.
    assert.deepEqual(child.candidate, saved, 'the regenerated candidate proof differs from the saved candidate-proof.json');
    assert.deepEqual(child.proofs, proofs, 'the candidate verifier and the saved native proofs disagree');

    assert.equal(receipt.candidate.digest, inputs.digest, 'receipt candidate digest is not the promoted digest');
    assert.equal(receipt.revisions.ploinky, inputs.sourceSha, 'receipt Ploinky revision is not source_sha');
    assert.equal(receipt.revisions.achilles_agent_lib, libraries.commits.achillesAgentLib, 'receipt AgentLib commit is not the frozen library-input commit');
    assert.equal(receipt.revisions.mcp_sdk_commit, libraries.commits['mcp-sdk'], 'receipt MCP SDK commit is not the frozen library-input commit');
    for (const [arch, imageId] of Object.entries(receipt.engine_image_ids)) {
        assert.equal(imageId, proofs[arch].image.configDigest, `receipt engine image ID for ${arch} is not the verified ${arch} image config digest`);
    }

    const record = {
        schema: 'ploinky.box.promotion-verification/v1',
        candidate: {
            digest: inputs.digest, runId: inputs.runId, runAttempt: inputs.runAttempt, sourceSha: inputs.sourceSha,
            imageDefinitionsSha: inputs.imageDefinitionsSha, libraries: saved.libraries,
            platforms: saved.image.platforms, nativeProofSha256: saved.nativeProofSha256,
            verifierSha256: saved.verifierSha256,
        },
        index: { sha256: sha256(raw) },
        receipt: { sha256: sha256(Buffer.from(receiptText)), generation: receipt.generation },
        promotion: { runId: promotion.runId, runAttempt: promotion.attempt, sha: promotion.sha, ref: promotion.ref },
    };
    fs.writeFileSync(path.join(evidenceDir, 'acceptance-receipt.json'), receiptText);
    fs.writeFileSync(path.join(evidenceDir, 'promotion-verification.json'), `${JSON.stringify(record, null, 2)}\n`);
    return record;
}

/** Previous alias digests by raw index bytes; an alias that does not exist is null. */
export function readAliases(exec = defaultExec) {
    return Object.fromEntries(ALIASES.map((alias) => {
        try {
            return [alias, `sha256:${sha256(fetchRawIndex(`${IMAGE_REPOSITORY}:${alias}`, exec))}`];
        } catch (error) {
            if (NOT_FOUND.test(`${error.stderr ?? ''} ${error.message}`)) return [alias, null];
            throw error;
        }
    }));
}

/**
 * The explicit write plan. `create` is idempotent for one digest, so a retry of
 * a partial write simply completes it; when both aliases already resolve to the
 * accepted digest there is nothing to write.
 */
export function planAliasWrite(previous, digest) {
    assert.match(digest, DIGEST, 'the accepted digest must be an immutable sha256 digest');
    const current = ALIASES.filter((alias) => previous[alias] === digest).length;
    if (current === ALIASES.length) return 'current';
    return current > 0 ? 'complete-partial' : 'promote';
}

/** Fetch both aliases' raw indexes after the write and require them to be the accepted digest. */
export function confirmAliases({ digest, exec = defaultExec, summaryFile }) {
    assert.match(digest, DIGEST, 'the accepted digest must be an immutable sha256 digest');
    const aliases = readAliases(exec);
    const ok = ALIASES.every((alias) => aliases[alias] === digest);
    if (summaryFile) {
        const lines = [ok ? `Promotion confirmed: both aliases resolve to ${digest}` : `Promotion FAILED: both aliases must resolve to ${digest}; the exact current aliases are`,
            ...ALIASES.map((alias) => `- ${IMAGE_REPOSITORY}:${alias}: ${aliases[alias] ?? '(absent)'}`)];
        fs.appendFileSync(summaryFile, `${lines.join('\n')}\n`);
    }
    return { ok, aliases };
}

function parseJsonLines(text) {
    return String(text).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

const evidenceDirectory = (env) => env.PROMOTION_EVIDENCE || path.join(env.RUNNER_TEMP || '.', 'ploinky-box-promotion-evidence');
const promotionIdentity = (env) => ({ runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, sha: env.GITHUB_SHA, ref: env.GITHUB_REF });

async function main(argv = process.argv.slice(2), env = process.env, exec = defaultExec) {
    const [command] = argv;
    const evidenceDir = evidenceDirectory(env);
    if (command === 'pin') {
        const inputs = validateInputs(env);
        fs.mkdirSync(evidenceDir, { recursive: true });
        const run = JSON.parse(asBuffer(exec('gh', ['api', `repos/${CANDIDATE_REPOSITORY}/actions/runs/${inputs.runId}/attempts/${inputs.runAttempt}`])).toString('utf8'));
        pinCandidateRun(run, inputs);
        fs.writeFileSync(path.join(evidenceDir, 'candidate-run.json'), `${JSON.stringify(run, null, 2)}\n`);
        process.stdout.write(`Pinned ${CANDIDATE_REPOSITORY} run ${inputs.runId} attempt ${inputs.runAttempt} at ${inputs.imageDefinitionsSha}\n`);
    } else if (command === 'download') {
        const inputs = validateInputs(env);
        const listing = parseJsonLines(asBuffer(exec('gh', ['api', '--paginate', `repos/${CANDIDATE_REPOSITORY}/actions/runs/${inputs.runId}/artifacts`, '--jq', '.artifacts[]'])).toString('utf8'));
        checkArtifactListing(listing, inputs);
        downloadCandidateEvidence(inputs, evidenceDir, exec);
    } else if (command === 'verify') {
        const inputs = validateInputs(env);
        const record = await verifyCandidateForPromotion({
            inputs, receiptText: inputs.receiptText, evidenceDir, sourceRoot: env.SOURCE_ROOT || 'sources/ploinky',
            imageDefinitionsRoot: env.IMAGE_DEFINITIONS_ROOT || 'sources/image-definitions', exec, promotion: promotionIdentity(env),
        });
        process.stdout.write(`digest=${record.candidate.digest}\n`);
    } else if (command === 'aliases') {
        const inputs = validateInputs(env, { requireReceipt: false });
        assert.equal(env.ACCEPTED_DIGEST, inputs.digest, 'the accepted digest is not candidate_digest');
        const raw = fetchRawIndex(`${IMAGE_REPOSITORY}@${inputs.digest}`, exec);
        assert.equal(`sha256:${sha256(raw)}`, inputs.digest, 'the registry index bytes do not hash to the accepted digest');
        const previousAliases = readAliases(exec);
        const mode = planAliasWrite(previousAliases, inputs.digest);
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, 'previous-aliases.json'), `${JSON.stringify({ previousAliases, mode }, null, 2)}\n`);
        process.stdout.write(`mode=${mode}\n`);
    } else if (command === 'confirm') {
        const inputs = validateInputs(env, { requireReceipt: false });
        assert.equal(env.ACCEPTED_DIGEST, inputs.digest, 'the accepted digest is not candidate_digest');
        const before = readJson(path.join(evidenceDir, 'previous-aliases.json'));
        const confirmation = confirmAliases({ digest: inputs.digest, exec, summaryFile: env.GITHUB_STEP_SUMMARY });
        const promotion = promotionIdentity(env);
        fs.writeFileSync(path.join(evidenceDir, 'promotion-record.json'), `${JSON.stringify({
            schema: 'ploinky.box.promotion-record/v1',
            acceptedDigest: inputs.digest,
            candidate: { runId: inputs.runId, runAttempt: inputs.runAttempt, sourceSha: inputs.sourceSha, imageDefinitionsSha: inputs.imageDefinitionsSha },
            promotion: { runId: promotion.runId, runAttempt: promotion.attempt, sha: promotion.sha, ref: promotion.ref },
            previousAliases: before.previousAliases,
            mode: before.mode,
            confirmation,
        }, null, 2)}\n`);
        if (!confirmation.ok) throw new Error(`promotion not confirmed: latest=${confirmation.aliases.latest ?? '(absent)'} runtime=${confirmation.aliases.runtime ?? '(absent)'} accepted=${inputs.digest}`);
        process.stdout.write(`Confirmed latest and runtime at ${inputs.digest}\n`);
    } else if (command === 'candidate-verifier') {
        await candidateVerifierMain(argv[1]);
    } else {
        throw new Error('expected pin, download, verify, aliases, or confirm');
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
