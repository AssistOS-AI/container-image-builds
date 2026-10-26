// Promotion-only workflow for an already built and browser-accepted Ploinky Box
// candidate. Nothing here touches a registry or GitHub: registry and Actions
// commands go through a substituted executor (module level) or PATH stubs that
// run the workflow's own shell steps (workflow level).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { publicationContext, verifyCandidate, verifyNativeEvidence, verifyNativeProofs } from '../images/ploinky-box/verify-publication.mjs';
import { LIBRARIES } from '../images/ploinky-box/resolve-libraries.mjs';
import {
    ACHILLES_PACKAGE_NAME, ACHILLES_REQUIRED_ENTRIES, LIBRARY_METADATA_SCHEMA, MCP_SDK_MEMBERS,
    MCP_SDK_PACKAGE_NAME, SELF_TEST_CASES,
} from '../images/ploinky-box/smoke-libraries.mjs';
import {
    GATE_SELECTIONS, MAX_RECEIPT_BYTES, PHASES, RECEIPT_SCHEMA, RELEASE_GATES, REQUIRED_GATES,
    buildAcceptanceReceipt, canonicalReceiptText, parseCanonicalReceipt, summarizePlaywrightReport, validateAcceptanceReceipt,
} from '../images/ploinky-box/acceptance-receipt.mjs';
import {
    CANDIDATE_REPOSITORY, CANDIDATE_WORKFLOW_PATH, checkArtifactListing, confirmAliases, downloadCandidateEvidence,
    pinCandidateRun, planAliasWrite, readAliases, validateInputs, verifyCandidateForPromotion,
} from '../images/ploinky-box/verify-promotion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHES = ['amd64', 'arm64'];
const IMAGE = 'docker.io/assistos/ploinky-box';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const promotionWorkflow = read('.github/workflows/promote-ploinky-box-candidate.yml');
const publishWorkflow = read('.github/workflows/publish-ploinky-box-image.yml');

// Candidate identity. None of these may equal the promotion run's own identity.
const CANDIDATE = { runId: '4242', attempt: '2', sourceSha: 'a'.repeat(40), definitionsSha: 'b'.repeat(40) };
const PROMOTION = { runId: '9001', attempt: '1', sha: 'c'.repeat(40), ref: 'refs/heads/main' };
const SELECTIONS = {
    achillesAgentLib: { repository: LIBRARIES.achillesAgentLib.repository, branch: 'master', commit: '9'.repeat(40), packageVersion: '0.1.0' },
    'mcp-sdk': { repository: LIBRARIES['mcp-sdk'].repository, branch: null, commit: '7'.repeat(40), packageVersion: '1.19.1' },
};
const LIBRARY_ENV = {
    AGENTLIB_REPOSITORY: SELECTIONS.achillesAgentLib.repository, AGENTLIB_BRANCH: 'master', AGENTLIB_COMMIT: '9'.repeat(40),
    MCP_SDK_REPOSITORY: SELECTIONS['mcp-sdk'].repository, MCP_SDK_BRANCH: '', MCP_SDK_COMMIT: '7'.repeat(40),
};
const PACKAGE_NAMES = { achillesAgentLib: ACHILLES_PACKAGE_NAME, 'mcp-sdk': MCP_SDK_PACKAGE_NAME };
const ENGINE_ID = { amd64: `sha256:${'e'.repeat(64)}`, arm64: `sha256:${'f'.repeat(64)}` };

function libraryEvidence() {
    const provenance = Object.fromEntries(Object.entries(SELECTIONS).map(([library, selection]) => [library, {
        schema: LIBRARY_METADATA_SCHEMA, library, packageName: PACKAGE_NAMES[library],
        packageVersion: selection.packageVersion, repository: selection.repository, branch: selection.branch, commit: selection.commit,
    }]));
    const smoke = {
        schema: 'ploinky.box.library-smoke/v1', ok: true, protectedLayout: true,
        libraries: {
            achillesAgentLib: {
                packageName: ACHILLES_PACKAGE_NAME, packageVersion: '0.1.0', requiredEntries: [...ACHILLES_REQUIRED_ENTRIES],
                checks: ['imports', 'exports', 'isOptOutModel', 'jwt-round-trip'],
            },
            'mcp-sdk': {
                packageName: MCP_SDK_PACKAGE_NAME, packageVersion: '1.19.1', entry: './index.mjs',
                members: MCP_SDK_MEMBERS.map(({ member }) => member), checks: ['imports', 'exports', 'zod-schema', 'loopback-tool-call'],
            },
        },
    };
    const selfTest = {
        schema: 'ploinky.box.library-self-test/v1', ok: true, control: { accepted: true },
        cases: SELF_TEST_CASES.map(({ name, expected }) => ({ name, expected, rejected: true })),
    };
    return { provenance, smoke, selfTest };
}

// --- receipt v2 evidence ---------------------------------------------------------------------
//
// Three Box generations (cohorts) and six gate invocations, each with its own artifact directory:
// `profile-preflight_codex.json`, `test-results/results.json`, `profile-postflight_codex.json`, and for
// spec 06 also `codex-auth/parent-result.json`. Times are offsets from the cohort's Box start.
const MIN = 60_000;
const COHORTS = {
    'official-release': { containerId: '1'.repeat(64), startedAt: '2026-10-26T10:00:00.000Z' },
    'copilot-live-skills': { containerId: '2'.repeat(64), startedAt: '2026-10-26T09:00:00.000Z' },
    'optional-defaults-and-activation': { containerId: '3'.repeat(64), startedAt: '2026-10-26T08:00:00.000Z' },
};
const COHORT_OF = {
    'copilot-folder-launch': 'official-release', 'webmeet-public-room': 'official-release', 'webmeet-room-chat': 'official-release',
    'onlyoffice-confidential': 'official-release', 'copilot-live-skills': 'copilot-live-skills', 'optional-agents': 'optional-defaults-and-activation',
};
// Execution order of the official cohort is 05, 30-public, 30-media, 50; the receipt lists 05, 06, 03, 50, 30-public, 30-media.
const GATE_TIMES = {
    'copilot-folder-launch': { start: 2 * MIN, duration: 30_000 },
    'webmeet-public-room': { start: 6 * MIN, duration: 20_000 },
    'webmeet-room-chat': { start: 9 * MIN, duration: 25_000 },
    'onlyoffice-confidential': { start: 13 * MIN, duration: 3 * MIN },
    'copilot-live-skills': { start: 5 * MIN, duration: 15 * MIN },
    'optional-agents': { start: 3 * MIN, duration: 10 * MIN },
};
const OFFICIAL_ORDER = ['copilot-folder-launch', 'webmeet-public-room', 'webmeet-room-chat', 'onlyoffice-confidential'];
const SIX_GATES = ['copilot-folder-launch', 'copilot-live-skills', 'optional-agents', 'onlyoffice-confidential', 'webmeet-public-room', 'webmeet-room-chat'];
const CURRENT_SPEC_03_TITLE = 'OnlyOffice, Scribe, STT, and Umami start disabled and can be enabled through Marketplace';
const OLD_SPEC_03_TITLE = 'OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace';
const runIdOf = (gateId) => `run-${gateId}`;
const cohortStartMs = (gateId) => Date.parse(COHORTS[COHORT_OF[gateId]].startedAt);
const iso = (ms) => new Date(ms).toISOString();
const startOf = (gateId) => cohortStartMs(gateId) + GATE_TIMES[gateId].start;
const endOf = (gateId) => startOf(gateId) + GATE_TIMES[gateId].duration;

function playwrightReport(gateId, change = {}) {
    const { spec, test: title } = GATE_SELECTIONS[gateId];
    const file = path.posix.basename(spec);
    const startTime = change.startTime ?? iso(startOf(gateId));
    const result = { workerIndex: 0, parallelIndex: 0, status: 'passed', duration: 10, errors: [], stdout: [], stderr: [], retry: 0, startTime: '2026-10-02T10:00:00.000Z', attachments: [] };
    const report = {
        config: { projects: [{ id: 'chromium', name: 'chromium', retries: 0, testDir: '/x/specs' }], metadata: { runId: change.runId ?? runIdOf(gateId) } },
        suites: [{
            title: file, file, column: 0, line: 0, specs: [],
            suites: [{
                title: 'Describe', file, column: 0, line: 1,
                specs: [{
                    title, ok: true, tags: [], file, line: 2, column: 1, id: gateId,
                    tests: [{ expectedStatus: 'passed', projectName: 'chromium', projectId: 'chromium', timeout: 1, annotations: [], status: 'expected', results: [result] }],
                }],
            }],
        }],
        errors: [], stats: { startTime, duration: change.duration ?? GATE_TIMES[gateId].duration, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    };
    // Prerequisite phases may hold more than one test.
    for (const [index, extra] of (change.extraTitles || []).entries()) {
        const spec = structuredClone(report.suites[0].suites[0].specs[0]);
        spec.title = extra; spec.id = `${gateId}-extra-${index}`;
        report.suites[0].suites[0].specs.push(spec);
        report.stats.expected += 1;
    }
    change.mutate?.(report);
    return Buffer.from(JSON.stringify(report));
}

function reportSet(change = {}, extra = {}) {
    return Object.fromEntries(SIX_GATES.map((id) => [id, playwrightReport(id, { mutate: change[id], extraTitles: extra[id] })]));
}

function boxIdentity(gateId) {
    const { containerId, startedAt } = COHORTS[COHORT_OF[gateId]];
    return { containerId, startedAt, imageId: ENGINE_ID.arm64 };
}

function preflightFor(gateId, mutate) {
    const preflight = {
        imageAgePolicy: 'common-explicit-pins; common-image-age-disabled; generation<=30m; additional-profile-age-checks-retained',
        ledgerCoverage: 'selected-ledger-identities',
        generationMaxAgeMs: 30 * MIN,
        imageCreatedAt: '2026-10-25T00:00:00.000Z',
        box: { ...boxIdentity(gateId), name: 'ploinky-box-test' },
        repositories: {
            achillesAgentLib: { commit: SELECTIONS.achillesAgentLib.commit, ignored: true }, ploinky: { commit: CANDIDATE.sourceSha },
            achillesCLI: { commit: '1'.repeat(40) }, explorer: { commit: '2'.repeat(40) },
        },
        runId: runIdOf(gateId), spec: GATE_SELECTIONS[gateId].spec, grep: 'ignored by the receipt', capturedAt: iso(startOf(gateId) - 5000),
    };
    mutate?.(preflight);
    return Buffer.from(JSON.stringify(preflight, null, 2));
}

function postflightFor(gateId, mutate) {
    const postflight = { runId: runIdOf(gateId), box: boxIdentity(gateId), capturedAt: iso(endOf(gateId) + 2000), exitCode: 0 };
    mutate?.(postflight);
    return Buffer.from(JSON.stringify(postflight, null, 2));
}

function parentResultFor(gateId, mutate) {
    const parent = {
        runId: runIdOf(gateId), code: 'OK', leakScanCoverage: 'proven', leaks: 0, undecodable: [],
        cleanup: { credentialPersisted: true, credentialRemoved: true, linksRemoved: true, sourceUnregistered: true, robotDeleted: true, folderDeleted: true },
    };
    mutate?.(parent);
    return Buffer.from(JSON.stringify(parent));
}

// The evidence of one gate invocation. `change` mutates the parsed artifact before it is serialized.
function gateEvidence(gateId, change = {}) {
    const evidence = {
        report: playwrightReport(gateId, { mutate: change.report, extraTitles: change.extraTitles, runId: change.runId, startTime: change.startTime, duration: change.duration }),
        preflight: preflightFor(gateId, change.preflight),
        postflight: postflightFor(gateId, change.postflight),
    };
    if (gateId === 'copilot-live-skills') evidence.parentResult = parentResultFor(gateId, change.parent);
    return evidence;
}

function evidenceSet(change = {}, extra = {}) {
    return Object.fromEntries(SIX_GATES.map((id) => [id, gateEvidence(id, { ...change[id], extraTitles: extra[id] })]));
}

function releaseManifest() {
    return {
        repositories: {
            achillesAgentLib: { commit: SELECTIONS.achillesAgentLib.commit },
            ploinky: { commit: CANDIDATE.sourceSha },
            achillesCLI: { commit: '1'.repeat(40) },
            explorer: { commit: '2'.repeat(40) },
        },
        images: { ploinkyBox: { digest: ENGINE_ID.arm64 } },
    };
}

const imageInspect = (architecture = 'arm64') => [{ Id: ENGINE_ID[architecture], Os: 'linux', Architecture: architecture }];

const receiptInputs = (change = {}) => ({
    candidateDigest: `sha256:${'1'.repeat(64)}`, releaseManifest: releaseManifest(), imageInspect: imageInspect(), mcpSdkCommit: SELECTIONS['mcp-sdk'].commit,
    gates: evidenceSet(), ...change,
});

function receiptFor(candidateDigest, change = {}) {
    return buildAcceptanceReceipt({ ...receiptInputs({ candidateDigest }), gates: evidenceSet(change) });
}

// A complete candidate: both native evidence sets, the exact index, the
// candidate artifact, the frozen library inputs, and the layout the workflow
// downloads them into.
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-promotion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'sources/ploinky');
    const webtty = path.join(source, 'core-services/webtty');
    fs.mkdirSync(webtty, { recursive: true });
    fs.writeFileSync(path.join(webtty, 'native-probe.mjs'), '// Selected immutable source fixture.\n');
    fs.writeFileSync(path.join(webtty, 'package-lock.json'), '{}\n');
    fs.mkdirSync(path.join(source, 'agentlib'));
    fs.writeFileSync(path.join(source, 'agentlib/contract.mjs'),
        `export const AGENTLIB_REQUIRED_ENTRYPOINTS = Object.freeze(${JSON.stringify(ACHILLES_REQUIRED_ENTRIES)});\n`);
    fs.writeFileSync(path.join(webtty, 'native-runtime.mjs'), `
      import assert from 'node:assert/strict';
      export function validateNativeProbeResult(probe, expected) {
        assert.equal(probe.schema, 'ploinky.webtty.native/v1');
        for (const key of ['architecture', 'platform', 'uid', 'gid']) assert.equal(probe[key], expected[key]);
        for (const key of ['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity']) assert.equal(probe.pty[key], true);
      }
    `);
    const candidateEnv = {
        ...LIBRARY_ENV, SOURCE_SHA: CANDIDATE.sourceSha, GITHUB_SHA: CANDIDATE.definitionsSha,
        GITHUB_RUN_ID: CANDIDATE.runId, GITHUB_RUN_ATTEMPT: CANDIDATE.attempt,
    };
    const context = await publicationContext(source, candidateEnv);
    const evidence = path.join(root, 'evidence');
    const proofs = path.join(evidence, 'proofs');
    fs.mkdirSync(proofs, { recursive: true });
    const digests = { amd64: `sha256:${'c'.repeat(64)}`, arm64: `sha256:${'d'.repeat(64)}` };
    for (const arch of ARCHES) {
        const dir = path.join(proofs, `ploinky-box-native-${arch}`);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'digest.txt'), `${digests[arch]}\n`);
        writeJson(path.join(dir, 'image-inspect.json'), [{
            Os: 'linux', Architecture: arch, Id: ENGINE_ID[arch], RepoDigests: [`assistos/ploinky-box@${digests[arch]}`],
            Config: { User: 'podman', Entrypoint: ['/usr/local/bin/ploinky-box-entrypoint'], Labels: {} },
        }]);
        const probe = {
            schema: 'ploinky.webtty.native/v1', nodeMajor: 24, nodeAbi: '137', platform: 'linux', architecture: arch,
            nodePtyVersion: '1.0.0', packageLockSha256: context.packageLockSha256,
            nativeArtifactPath: '/usr/local/lib/ploinky/webtty/node_modules/node-pty/build/Release/pty.node',
            nativeArtifactSha256: '1'.repeat(64), sourceSha: context.sourceCommit, uid: 1000, gid: 1000,
            pty: Object.fromEntries(['import', 'input', 'output', 'resize', 'exit', 'reap', 'identity'].map((key) => [key, true])),
        };
        writeJson(path.join(dir, 'native-probe.json'), probe);
        writeJson(path.join(dir, 'immutable-webtty.json'), { probeSha256: context.probeSha256, contract: probe });
        const library = libraryEvidence();
        writeJson(path.join(dir, 'library-provenance.json'), library.provenance);
        writeJson(path.join(dir, 'library-smoke.json'), library.smoke);
        writeJson(path.join(dir, 'library-self-test.json'), library.selfTest);
        writeJson(path.join(dir, 'native-proof.json'), verifyNativeEvidence(dir, arch, digests[arch], context));
    }
    const index = {
        schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: ARCHES.map((arch) => ({ digest: digests[arch], platform: { os: 'linux', architecture: arch } })),
        annotations: Object.fromEntries(Object.entries({
            'workflow-run': CANDIDATE.runId, 'workflow-attempt': CANDIDATE.attempt, 'source-sha': CANDIDATE.sourceSha,
            'image-definitions-sha': CANDIDATE.definitionsSha, 'amd64-digest': digests.amd64, 'arm64-digest': digests.arm64,
        }).map(([key, value]) => [`io.assistos.ploinky.${key}`, value])),
    };
    const indexBytes = Buffer.from(JSON.stringify(index));
    const candidateDigest = `sha256:${hash(indexBytes)}`;
    const indexFile = path.join(root, 'index.json');
    fs.writeFileSync(indexFile, indexBytes);
    const candidate = path.join(evidence, 'candidate');
    fs.mkdirSync(candidate);
    for (const name of ['candidate-index.json', 'immutable-index.json', 'confirmed-candidate-index.json']) fs.writeFileSync(path.join(candidate, name), indexBytes);
    fs.writeFileSync(path.join(candidate, 'digest.txt'), `${candidateDigest}\n`);
    fs.writeFileSync(path.join(candidate, 'candidate-ref.txt'), `${IMAGE}:runtime-candidate-${CANDIDATE.runId}-${CANDIDATE.attempt}\n`);
    fs.cpSync(proofs, path.join(candidate, 'native-proofs'), { recursive: true });
    writeJson(path.join(candidate, 'candidate-proof.json'), verifyCandidate(proofs, indexFile, context));
    fs.mkdirSync(path.join(evidence, 'library-inputs'));
    writeJson(path.join(evidence, 'library-inputs/library-inputs.json'), {
        schema: 'ploinky.box.library-inputs/v1',
        libraries: Object.fromEntries(Object.entries(SELECTIONS).map(([name, s]) => [name, { repository: s.repository, branch: s.branch, commit: s.commit }])),
    });
    const f = { root, source, evidence, proofs, candidate, digests, index, indexBytes, indexFile, candidateDigest, context, calls: [] };
    f.env = {
        CANDIDATE_RUN_ID: CANDIDATE.runId, CANDIDATE_RUN_ATTEMPT: CANDIDATE.attempt, CANDIDATE_DIGEST: candidateDigest,
        SOURCE_SHA: CANDIDATE.sourceSha, IMAGE_DEFINITIONS_SHA: CANDIDATE.definitionsSha,
        ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(receiptFor(candidateDigest)),
    };
    f.run = runJson();
    f.aliases = { latest: Buffer.from('previous-latest'), runtime: Buffer.from('previous-runtime') };
    f.exec = (command, args) => {
        f.calls.push([command, ...args]);
        assert.equal(command, 'docker');
        assert.deepEqual(args.slice(0, 3), ['buildx', 'imagetools', 'inspect']);
        assert.equal(args[3], '--raw');
        const ref = args[4];
        if (ref === `${IMAGE}@${candidateDigest}`) return f.indexBytes;
        const alias = /^docker\.io\/assistos\/ploinky-box:(latest|runtime)$/.exec(ref)?.[1];
        if (alias && f.aliases[alias]) return f.aliases[alias];
        const error = new Error(`manifest unknown: ${ref}`); error.stderr = `ERROR: ${ref}: not found`;
        throw error;
    };
    f.verify = async (overrides = {}) => verifyCandidateForPromotion({
        inputs: validateInputs({ ...f.env, ...overrides.env }), receiptText: (overrides.env ?? f.env).ACCEPTANCE_RECEIPT_JSON ?? f.env.ACCEPTANCE_RECEIPT_JSON,
        evidenceDir: f.evidence, sourceRoot: f.source, imageDefinitionsRoot: overrides.imageDefinitionsRoot ?? ROOT, exec: overrides.exec ?? f.exec, promotion: PROMOTION,
    });
    return f;
}

function runJson(change = {}) {
    return {
        id: Number(CANDIDATE.runId), run_attempt: Number(CANDIDATE.attempt), status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
        path: `.github/workflows/publish-ploinky-box-image.yml`, head_sha: CANDIDATE.definitionsSha,
        repository: { full_name: 'AssistOS-AI/container-image-builds' }, head_repository: { full_name: 'AssistOS-AI/container-image-builds' },
        ...change,
    };
}

function artifactNames() {
    return [`ploinky-box-candidate-${CANDIDATE.runId}-${CANDIDATE.attempt}`, 'ploinky-box-native-amd64', 'ploinky-box-native-arm64',
        `ploinky-box-library-inputs-${CANDIDATE.runId}-${CANDIDATE.attempt}`];
}

const artifactListing = () => artifactNames().map((name, index) => ({
    id: 100 + index, name, expired: false, workflow_run: { id: Number(CANDIDATE.runId), head_sha: CANDIDATE.definitionsSha },
}));

// Mutate one JSON evidence file, run the check, and restore it.
function rejectsAlteredFile(f, file, change, label) {
    const original = fs.readFileSync(file);
    const value = JSON.parse(original); change(value); writeJson(file, value);
    return Promise.resolve(f.verify()).then(
        () => assert.fail(`accepted ${label}`),
        () => fs.writeFileSync(file, original),
    );
}

// --- inputs -----------------------------------------------------------------------------------

test('inputs must be exact: a tag, a short digest, a symbolic revision, and a malformed run are rejected', async (t) => {
    const f = await fixture(t);
    assert.doesNotThrow(() => validateInputs(f.env));
    for (const change of [
        { CANDIDATE_DIGEST: 'latest' }, { CANDIDATE_DIGEST: 'runtime' }, { CANDIDATE_DIGEST: `${IMAGE}:latest` },
        { CANDIDATE_DIGEST: `${IMAGE}@${f.candidateDigest}` }, { CANDIDATE_DIGEST: `sha256:${'c'.repeat(63)}` },
        { CANDIDATE_DIGEST: f.candidateDigest.toUpperCase() }, { CANDIDATE_DIGEST: `sha256:${'g'.repeat(64)}` }, { CANDIDATE_DIGEST: '' },
        { CANDIDATE_RUN_ID: '0' }, { CANDIDATE_RUN_ID: 'latest' }, { CANDIDATE_RUN_ID: '12 34' },
        { CANDIDATE_RUN_ATTEMPT: '0' }, { CANDIDATE_RUN_ATTEMPT: '' }, { CANDIDATE_RUN_ATTEMPT: '2\n3' },
        { SOURCE_SHA: 'main' }, { SOURCE_SHA: 'a'.repeat(39) }, { IMAGE_DEFINITIONS_SHA: 'a'.repeat(64) }, { IMAGE_DEFINITIONS_SHA: '' },
        { ACCEPTANCE_RECEIPT_JSON: '' }, { ACCEPTANCE_RECEIPT_JSON: '{' }, { ACCEPTANCE_RECEIPT_JSON: '[]' },
        { ACCEPTANCE_RECEIPT_JSON: ' '.repeat(MAX_RECEIPT_BYTES + 1) },
        // Valid but not canonical: pretty-printed, trailing newline, reordered keys, or a duplicate key.
        { ACCEPTANCE_RECEIPT_JSON: JSON.stringify(JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON), null, 2) },
        { ACCEPTANCE_RECEIPT_JSON: `${f.env.ACCEPTANCE_RECEIPT_JSON}\n` },
        { ACCEPTANCE_RECEIPT_JSON: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON)).reverse())) },
        { ACCEPTANCE_RECEIPT_JSON: f.env.ACCEPTANCE_RECEIPT_JSON.replace('"cohorts":', '"cohorts":"shadowed","cohorts":') },
    ]) {
        assert.throws(() => validateInputs({ ...f.env, ...change }), JSON.stringify(change).slice(0, 80));
    }
});

// --- the pinned candidate run -----------------------------------------------------------------

test('the candidate run is pinned to the fixed repository, workflow, success, exact attempt, and image-definition head', async (t) => {
    const f = await fixture(t);
    const inputs = validateInputs(f.env);
    assert.equal(CANDIDATE_REPOSITORY, 'AssistOS-AI/container-image-builds');
    assert.equal(CANDIDATE_WORKFLOW_PATH, '.github/workflows/publish-ploinky-box-image.yml');
    assert.doesNotThrow(() => pinCandidateRun(runJson(), inputs));
    assert.doesNotThrow(() => pinCandidateRun(runJson({ path: `${CANDIDATE_WORKFLOW_PATH}@refs/heads/fix/ploinky-cleanup-integrated-20260925` }), inputs));
    for (const change of [
        { id: 4243 }, { run_attempt: 1 }, { run_attempt: 3 }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: null },
        { status: 'in_progress' }, { event: 'push' }, { head_sha: 'd'.repeat(40) },
        { repository: { full_name: 'someone/container-image-builds' } }, { head_repository: { full_name: 'fork/container-image-builds' } },
        { head_repository: null },
        { path: '.github/workflows/publish-ploinky-node-image.yml' }, { path: '.github/workflows/promote-ploinky-box-candidate.yml' },
        { path: '.github/workflows/evil/publish-ploinky-box-image.yml' }, { path: `${CANDIDATE_WORKFLOW_PATH}x` },
    ]) {
        assert.throws(() => pinCandidateRun(runJson(change), inputs), JSON.stringify(change));
    }
    assert.throws(() => pinCandidateRun({ ...runJson(), id: undefined }, inputs));
});

test('only the named candidate, both native sets, and the frozen library inputs of that run are accepted', async (t) => {
    const f = await fixture(t);
    const inputs = validateInputs(f.env);
    assert.deepEqual(checkArtifactListing(artifactListing(), inputs).map(({ name }) => name), artifactNames());
    assert.throws(() => checkArtifactListing(artifactListing().slice(0, 3), inputs), /library-inputs/);
    assert.throws(() => checkArtifactListing(artifactListing().filter(({ name }) => name !== 'ploinky-box-native-arm64'), inputs), /native-arm64/);
    assert.throws(() => checkArtifactListing([...artifactListing(), { ...artifactListing()[1], id: 999 }], inputs), /more than one/);
    assert.throws(() => checkArtifactListing(artifactListing().map((a, i) => (i === 0 ? { ...a, expired: true } : a)), inputs), /expired/);
    assert.throws(() => checkArtifactListing(artifactListing().map((a, i) => (i === 1 ? { ...a, workflow_run: { ...a.workflow_run, id: 1 } } : a)), inputs), /another run/);
    assert.throws(() => checkArtifactListing(artifactListing().map((a, i) => (i === 2 ? { ...a, workflow_run: { ...a.workflow_run, head_sha: 'e'.repeat(40) } } : a)), inputs), /image-definition/);
    // A stale attempt's candidate artifact name cannot satisfy the exact attempt.
    assert.throws(() => checkArtifactListing(artifactListing().map((a, i) => (i === 0 ? { ...a, name: `ploinky-box-candidate-${CANDIDATE.runId}-1` } : a)), inputs));
});

test('downloads are limited to the pinned run, one named artifact each, through the executor', async (t) => {
    const f = await fixture(t);
    const inputs = validateInputs(f.env);
    const calls = [];
    const destination = path.join(f.root, 'downloaded');
    downloadCandidateEvidence(inputs, destination, (command, args) => { calls.push([command, ...args]); return ''; });
    assert.deepEqual(calls.map((call) => call[call.indexOf('--name') + 1]), artifactNames());
    for (const call of calls) {
        assert.deepEqual(call.slice(0, 3), ['gh', 'run', 'download']);
        assert.equal(call[3], CANDIDATE.runId);
        assert.equal(call[call.indexOf('--repo') + 1], CANDIDATE_REPOSITORY);
        assert.ok(path.resolve(call[call.indexOf('--dir') + 1]).startsWith(`${path.resolve(destination)}${path.sep}`));
    }
    assert.ok(!calls.flat().some((arg) => /^(--pattern|-p)$/.test(arg)));
});

// --- verification of the candidate ------------------------------------------------------------

test('a complete candidate verifies from its own context and records the promotion identity separately', async (t) => {
    const f = await fixture(t);
    const record = await f.verify();
    assert.equal(record.candidate.digest, f.candidateDigest);
    assert.equal(record.candidate.runId, CANDIDATE.runId);
    assert.equal(record.candidate.runAttempt, CANDIDATE.attempt);
    assert.equal(record.candidate.sourceSha, CANDIDATE.sourceSha);
    assert.equal(record.candidate.imageDefinitionsSha, CANDIDATE.definitionsSha);
    assert.deepEqual(record.candidate.libraries.achillesAgentLib.commit, SELECTIONS.achillesAgentLib.commit);
    assert.deepEqual(record.promotion, { runId: PROMOTION.runId, runAttempt: PROMOTION.attempt, sha: PROMOTION.sha, ref: PROMOTION.ref });
    assert.notEqual(record.promotion.runId, record.candidate.runId);
    assert.notEqual(record.promotion.sha, record.candidate.imageDefinitionsSha);
    assert.equal(record.receipt.sha256, hash(f.env.ACCEPTANCE_RECEIPT_JSON));
    assert.equal(record.index.sha256, hash(f.indexBytes));
    // Registry access is read-only: one raw inspect of the immutable digest, nothing else.
    assert.deepEqual(f.calls, [['docker', 'buildx', 'imagetools', 'inspect', '--raw', `${IMAGE}@${f.candidateDigest}`]]);
    assert.ok(fs.existsSync(path.join(f.evidence, 'raw-index.json')));
});

test('the raw index fetched by digest must hash to the input digest and equal the candidate artifact', async (t) => {
    const f = await fixture(t);
    const other = Buffer.from(JSON.stringify({ ...f.index, annotations: { ...f.index.annotations, extra: 'x' } }));
    await assert.rejects(f.verify({ exec: () => other }), /digest|hash/i);
    await assert.rejects(f.verify({ exec: () => { throw new Error('registry unavailable'); } }), /registry unavailable/);
    // The input digest and the candidate artifact must agree on one index.
    const file = path.join(f.candidate, 'candidate-index.json');
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    await assert.rejects(f.verify(), /candidate-index/);
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(f.candidate, 'digest.txt'), `sha256:${'0'.repeat(64)}\n`);
    await assert.rejects(f.verify(), /digest\.txt/);
    fs.writeFileSync(path.join(f.candidate, 'digest.txt'), `${f.candidateDigest}\n`);
    fs.writeFileSync(path.join(f.candidate, 'candidate-ref.txt'), `${IMAGE}:runtime-candidate-${CANDIDATE.runId}-1\n`);
    await assert.rejects(f.verify(), /candidate-ref/);
});

test('altered raw evidence, a changed proof, or a divergent candidate copy is rejected', async (t) => {
    const f = await fixture(t);
    const dir = path.join(f.proofs, 'ploinky-box-native-amd64');
    await rejectsAlteredFile(f, path.join(dir, 'native-probe.json'), (v) => { v.sourceSha = '0'.repeat(40); }, 'altered native probe');
    await rejectsAlteredFile(f, path.join(dir, 'image-inspect.json'), (v) => { v[0].Id = `sha256:${'0'.repeat(64)}`; }, 'altered image id');
    await rejectsAlteredFile(f, path.join(dir, 'library-smoke.json'), (v) => { v.ok = false; }, 'failed smoke');
    await rejectsAlteredFile(f, path.join(dir, 'library-self-test.json'), (v) => { v.control.accepted = false; }, 'failed self-test');
    await rejectsAlteredFile(f, path.join(dir, 'native-proof.json'), (v) => { v.workflow.runAttempt = '1'; }, 'stale-attempt native proof');
    await rejectsAlteredFile(f, path.join(f.candidate, 'candidate-proof.json'), (v) => { v.verifierSha256 = '0'.repeat(64); }, 'altered candidate proof');
    await rejectsAlteredFile(f, path.join(f.candidate, 'candidate-proof.json'), (v) => { v.nativeProofSha256.arm64 = '0'.repeat(64); }, 'altered native proof hash');
    // The candidate artifact's copy of the native evidence must equal the separately downloaded set, byte for byte.
    const copy = path.join(f.candidate, 'native-proofs/ploinky-box-native-arm64/native-probe.json');
    const original = fs.readFileSync(copy);
    fs.appendFileSync(copy, '\n');
    await assert.rejects(f.verify(), /native-proofs|candidate copy/);
    fs.writeFileSync(copy, original);
    fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'extra');
    await assert.rejects(f.verify(), /native-proofs|unexpected/);
    fs.rmSync(path.join(dir, 'unexpected.txt'));
    await f.verify();
});

test('an incomplete architecture set or a one-member index is rejected', async (t) => {
    const f = await fixture(t);
    fs.rmSync(path.join(f.proofs, 'ploinky-box-native-arm64'), { recursive: true });
    await assert.rejects(f.verify());
    fs.cpSync(path.join(f.candidate, 'native-proofs/ploinky-box-native-arm64'), path.join(f.proofs, 'ploinky-box-native-arm64'), { recursive: true });
    await f.verify();
    // An index with one member whose bytes match the claimed digest still fails closed.
    const single = { ...f.index, manifests: f.index.manifests.slice(0, 1) };
    const bytes = Buffer.from(JSON.stringify(single));
    const digest = `sha256:${hash(bytes)}`;
    for (const name of ['candidate-index.json', 'immutable-index.json', 'confirmed-candidate-index.json']) fs.writeFileSync(path.join(f.candidate, name), bytes);
    fs.writeFileSync(path.join(f.candidate, 'digest.txt'), `${digest}\n`);
    await assert.rejects(f.verify({ env: { ...f.env, CANDIDATE_DIGEST: digest }, exec: () => bytes }), /two|member|another index digest/);
});

test('library, source, or image-definition identities that differ from the candidate are rejected', async (t) => {
    const f = await fixture(t);
    const inputs = path.join(f.evidence, 'library-inputs/library-inputs.json');
    await rejectsAlteredFile(f, inputs, (v) => { v.libraries.achillesAgentLib.commit = 'f'.repeat(40); }, 'different AgentLib commit');
    await rejectsAlteredFile(f, inputs, (v) => { v.libraries['mcp-sdk'].commit = 'f'.repeat(40); }, 'different MCP SDK commit');
    await rejectsAlteredFile(f, inputs, (v) => { v.libraries.achillesAgentLib.branch = 'main'; }, 'different branch');
    await rejectsAlteredFile(f, inputs, (v) => { v.libraries['mcp-sdk'].repository = LIBRARIES.achillesAgentLib.repository; }, 'wrong repository');
    await rejectsAlteredFile(f, inputs, (v) => { v.schema = 'ploinky.box.library-inputs/v2'; }, 'wrong schema');
    await rejectsAlteredFile(f, inputs, (v) => { v.extra = true; }, 'extra key');
    await rejectsAlteredFile(f, inputs, (v) => { delete v.libraries['mcp-sdk']; }, 'missing library');
    await assert.rejects(f.verify({ env: { ...f.env, SOURCE_SHA: 'd'.repeat(40) } }));
    await assert.rejects(f.verify({ env: { ...f.env, IMAGE_DEFINITIONS_SHA: 'd'.repeat(40) } }));
    await assert.rejects(f.verify({ env: { ...f.env, CANDIDATE_RUN_ID: '4243' } }));
    await assert.rejects(f.verify({ env: { ...f.env, CANDIDATE_RUN_ATTEMPT: '1' } }));
    await f.verify();
});

// --- acceptance receipt (v2) ------------------------------------------------------------------

const withTimes = (startMs, durationMs, { captured = startMs - 1000, finished = startMs + durationMs + 1000 } = {}) => ({
    startTime: iso(startMs), duration: durationMs,
    preflight: (p) => { p.capturedAt = typeof captured === 'string' ? captured : iso(captured); },
    postflight: (p) => { p.capturedAt = typeof finished === 'string' ? finished : iso(finished); },
});
const buildWith = (id, change) => buildAcceptanceReceipt(receiptInputs({ gates: { ...evidenceSet(), [id]: gateEvidence(id, change) } }));
const withGate = (id, edit) => { const gates = evidenceSet(); edit(gates[id]); return buildAcceptanceReceipt(receiptInputs({ gates })); };

test('the receipt producer builds the bounded data-only v2 receipt from reports, preflights, postflights, manifest, and image evidence', async (t) => {
    const f = await fixture(t);
    const receipt = receiptFor(f.candidateDigest);
    assert.equal(RECEIPT_SCHEMA, 'ploinky.box.acceptance-receipt/v2');
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.deepEqual(Object.keys(receipt).sort(), ['candidate', 'cohorts', 'engine_image_ids', 'gates', 'revisions', 'schema']);
    assert.equal(canonicalReceiptText(receipt), canonicalReceiptText(JSON.parse(canonicalReceiptText(receipt))));
    assert.doesNotThrow(() => parseCanonicalReceipt(canonicalReceiptText(receipt)));
    assert.deepEqual(receipt.candidate, { digest: f.candidateDigest });
    assert.deepEqual(receipt.revisions, {
        achilles_agent_lib: SELECTIONS.achillesAgentLib.commit, achilles_cli: '1'.repeat(40), explorer: '2'.repeat(40),
        mcp_sdk_commit: SELECTIONS['mcp-sdk'].commit, ploinky: CANDIDATE.sourceSha,
    });
    assert.deepEqual(receipt.engine_image_ids, { arm64: ENGINE_ID.arm64 });
    // Three cohorts named like the acceptance ledger, with the Box generation observed in the preflights.
    assert.deepEqual(receipt.cohorts, Object.fromEntries(Object.entries(COHORTS).map(([id, c]) => [id, { container_id: c.containerId, started_at: c.startedAt }])));
    // Six gates in the recording order 05, 06, 03, 50, 30-public, 30-media (not the execution order).
    assert.deepEqual(receipt.gates.map(({ id }) => id), SIX_GATES);
    assert.deepEqual([...PHASES], SIX_GATES);
    assert.deepEqual([...REQUIRED_GATES], SIX_GATES);
    assert.deepEqual([...RELEASE_GATES], ['copilot-folder-launch', 'onlyoffice-confidential', 'webmeet-public-room', 'webmeet-room-chat']);
    const evidence = evidenceSet();
    for (const gate of receipt.gates) {
        assert.deepEqual({ passed: gate.passed, failed: gate.failed, skipped: gate.skipped, retried: gate.retried, flaky: gate.flaky },
            { passed: 1, failed: 0, skipped: 0, retried: 0, flaky: 0 });
        assert.equal(gate.spec, GATE_SELECTIONS[gate.id].spec);
        assert.equal(gate.cohort, COHORT_OF[gate.id]);
        assert.equal(gate.cohort, GATE_SELECTIONS[gate.id].cohort);
        assert.deepEqual(gate.tests, [GATE_SELECTIONS[gate.id].test]);
        assert.equal(gate.report_sha256, hash(evidence[gate.id].report));
        assert.equal(gate.preflight_sha256, hash(evidence[gate.id].preflight));
        assert.equal(gate.postflight_sha256, hash(evidence[gate.id].postflight));
        // The parent result is recorded for spec 06 only.
        assert.deepEqual(Object.keys(gate).sort(), [
            'cohort', 'failed', 'finished_at', 'flaky', 'id', 'passed', 'postflight_sha256', 'preflight_sha256', 'report_sha256', 'retried', 'skipped',
            'spec', 'started_at', 'tests', ...(gate.id === 'copilot-live-skills' ? ['parent_result_sha256'] : [])].sort());
        // started_at is the report's start; finished_at is the postflight's capture time.
        assert.equal(gate.started_at, iso(startOf(gate.id)));
        assert.equal(gate.finished_at, iso(endOf(gate.id) + 2000));
    }
    assert.equal(receipt.gates.find(({ id }) => id === 'copilot-live-skills').parent_result_sha256, hash(evidence['copilot-live-skills'].parentResult));
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < MAX_RECEIPT_BYTES);
    assert.deepEqual(validateAcceptanceReceipt(receipt), receipt);
    assert.deepEqual(GATE_SELECTIONS['copilot-folder-launch'].spec, 'specs/05-copilot-folder-launch.spec.mjs');
    assert.match(GATE_SELECTIONS['onlyoffice-confidential'].test, /Confidential document saves through callback, drains, and reopens after targeted restart/);
    assert.match(GATE_SELECTIONS['webmeet-room-chat'].test, /two Explorer accounts can join one room and exchange chat/);
    assert.equal(GATE_SELECTIONS['webmeet-public-room'].test, 'standalone loader serves the authenticated dashboard and a guest invitation');
    assert.equal(GATE_SELECTIONS['webmeet-public-room'].spec, 'specs/30-webmeet-room-chat.spec.mjs');
});

test('Podman and Docker image evidence both produce the same receipt, with the engine image ID normalized', () => {
    const bare = ENGINE_ID.arm64.slice('sha256:'.length);
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, releaseManifest: releaseManifest(), mcpSdkCommit: '7'.repeat(40), gates: evidenceSet() };
    // Podman reports the bare 64-hex ID next to Digest, RepoDigests, and History.
    const podman = [{
        Id: bare, Digest: `sha256:${'d'.repeat(64)}`, RepoDigests: [`${IMAGE}@sha256:${'d'.repeat(64)}`],
        History: [{ created: '2026-10-01T00:00:00Z', created_by: 'ADD file' }], Os: 'linux', Architecture: 'arm64',
    }];
    const docker = buildAcceptanceReceipt({ ...base, imageInspect: imageInspect() });
    const fromPodman = buildAcceptanceReceipt({ ...base, imageInspect: podman });
    assert.deepEqual(fromPodman, docker);
    assert.deepEqual(fromPodman.engine_image_ids, { arm64: ENGINE_ID.arm64 });
    assert.deepEqual(buildAcceptanceReceipt({ ...base, imageInspect: [{ ID: bare, Os: 'linux', Architecture: 'arm64' }] }), docker);
    // An ID that is neither form, or a record whose two ID fields disagree, is rejected.
    for (const record of [{ Id: 'abc' }, { Id: bare.toUpperCase() }, { Id: `sha256:${bare.slice(1)}` }, { Id: '' }, { Id: bare, ID: `sha256:${'0'.repeat(64)}` }, { Id: `sha512:${bare}` }]) {
        assert.throws(() => buildAcceptanceReceipt({ ...base, imageInspect: [{ ...podman[0], ...record }] }), JSON.stringify(record).slice(0, 60));
    }
    // The normalized ID must still equal the release manifest's Box digest.
    assert.throws(() => buildAcceptanceReceipt({ ...base, imageInspect: [{ ...podman[0], Id: '0'.repeat(64) }] }), /manifest/);
});

test('a failed, skipped, retried, flaky, missing, duplicated, or mis-selected gate cannot produce a receipt', () => {
    const id = 'copilot-folder-launch';
    const bad = {
        failed: (r) => { const t = r.suites[0].suites[0].specs[0].tests[0]; t.status = 'unexpected'; t.results[0].status = 'failed'; r.stats.expected = 0; r.stats.unexpected = 1; },
        skipped: (r) => { const t = r.suites[0].suites[0].specs[0].tests[0]; t.status = 'skipped'; t.results[0].status = 'skipped'; r.stats.expected = 0; r.stats.skipped = 1; },
        retried: (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].retry = 1; },
        'two attempts': (r) => { const t = r.suites[0].suites[0].specs[0].tests[0]; t.results.push({ ...t.results[0], retry: 1 }); },
        flaky: (r) => { const t = r.suites[0].suites[0].specs[0].tests[0]; t.status = 'flaky'; r.stats.expected = 0; r.stats.flaky = 1; },
        'status mismatch': (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].status = 'failed'; },
        'zero tests': (r) => { r.suites[0].suites[0].specs = []; r.stats.expected = 0; },
        'two tests': (r) => { const s = r.suites[0].suites[0].specs; s.push(structuredClone(s[0])); r.stats.expected = 2; },
        'stats count': (r) => { r.stats.expected = 2; },
        'stats skipped': (r) => { r.stats.skipped = 1; },
        'top-level errors': (r) => { r.errors = [{ message: 'browser console error' }]; },
        'result errors': (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].errors = [{ message: 'x' }]; },
        'wrong project': (r) => { r.suites[0].suites[0].specs[0].tests[0].projectName = 'firefox'; },
        'wrong title': (r) => { r.suites[0].suites[0].specs[0].title = 'another test'; },
        'wrong spec': (r) => { r.suites[0].suites[0].specs[0].file = '06-copilot-live-skills.spec.mjs'; },
        'not ok': (r) => { r.suites[0].suites[0].specs[0].ok = false; },
        'expected failure': (r) => { r.suites[0].suites[0].specs[0].tests[0].expectedStatus = 'failed'; },
    };
    for (const [label, mutate] of Object.entries(bad)) {
        assert.throws(() => summarizePlaywrightReport(playwrightReport(id, { mutate }), id), label);
        assert.throws(() => buildAcceptanceReceipt({
            candidateDigest: `sha256:${'1'.repeat(64)}`, releaseManifest: releaseManifest(), imageInspect: imageInspect(), mcpSdkCommit: '7'.repeat(40),
            gates: { ...evidenceSet(), [id]: gateEvidence(id, { report: mutate }) },
        }), label);
    }
    assert.throws(() => summarizePlaywrightReport(Buffer.from('{'), id));
    // A report for another gate's selection cannot stand in for this gate.
    assert.throws(() => summarizePlaywrightReport(playwrightReport('webmeet-room-chat'), id));
    const gates = evidenceSet();
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, releaseManifest: releaseManifest(), imageInspect: imageInspect(), mcpSdkCommit: '7'.repeat(40) };
    for (const gate of SIX_GATES) {
        const { [gate]: _omitted, ...rest } = gates;
        assert.throws(() => buildAcceptanceReceipt({ ...base, gates: rest }), new RegExp(gate));
    }
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: { ...gates, 'copilot-folder-launch': gates['webmeet-room-chat'] } }));
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: { ...gates, unknown: gates['webmeet-room-chat'] } }));
});

test('all six gates are required; the prerequisite phases may hold several passed tests', () => {
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, releaseManifest: releaseManifest(), imageInspect: imageInspect(), mcpSdkCommit: '7'.repeat(40) };
    // Omitting any of the six gates, including 06 and each spec-30 gate, is refused and names the gate.
    for (const phase of ['copilot-folder-launch', 'copilot-live-skills', 'optional-agents', 'onlyoffice-confidential', 'webmeet-public-room', 'webmeet-room-chat']) {
        const { [phase]: _omitted, ...rest } = evidenceSet();
        assert.throws(() => buildAcceptanceReceipt({ ...base, gates: rest }), new RegExp(`required gate ${phase} has no evidence`), `${phase} is optional`);
    }
    assert.doesNotThrow(() => buildAcceptanceReceipt({ ...base, gates: evidenceSet() }));
    const receipt = buildAcceptanceReceipt({ ...base, gates: evidenceSet({}, { 'optional-agents': ['Scribe also enables', 'STT also enables'] }) });
    const gate = receipt.gates.find(({ id }) => id === 'optional-agents');
    assert.equal(gate.passed, 3);
    assert.deepEqual(gate.tests, [GATE_SELECTIONS['optional-agents'].test, 'STT also enables', 'Scribe also enables'].sort());
    assert.doesNotThrow(() => parseCanonicalReceipt(canonicalReceiptText(receipt)));
    // Every selected test of a prerequisite phase must pass, and the pinned one must be among them.
    const skipSecond = (r) => { const t = r.suites[0].suites[0].specs[1].tests[0]; t.status = 'skipped'; t.results[0].status = 'skipped'; r.stats.expected -= 1; r.stats.skipped += 1; };
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: evidenceSet({ 'optional-agents': { report: skipSecond } }, { 'optional-agents': ['Scribe also enables'] }) }), /optional-agents/);
    const dropPinned = (r) => { r.suites[0].suites[0].specs.shift(); r.stats.expected -= 1; };
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: evidenceSet({ 'optional-agents': { report: dropPinned } }, { 'optional-agents': ['Scribe also enables'] }) }), /pinned test/);
    // A repeated title, another spec file, or a retry inside a prerequisite phase is rejected.
    assert.throws(() => summarizePlaywrightReport(playwrightReport('optional-agents', { extraTitles: [GATE_SELECTIONS['optional-agents'].test] }), 'optional-agents'), /repeats/);
    assert.throws(() => summarizePlaywrightReport(playwrightReport('optional-agents', { extraTitles: ['x'], mutate: (r) => { r.suites[0].suites[0].specs[1].file = '04-marketplace-lifecycle.spec.mjs'; } }), 'optional-agents'), /another spec file/);
    assert.throws(() => summarizePlaywrightReport(playwrightReport('copilot-live-skills', { mutate: (r) => { r.suites[0].suites[0].specs[0].tests[0].results[0].retry = 1; } }), 'copilot-live-skills'), /retried/);
    // The four release gates stay one-test selections even when a report holds more.
    assert.throws(() => summarizePlaywrightReport(playwrightReport('webmeet-room-chat', { extraTitles: ['another'] }), 'webmeet-room-chat'));
    assert.throws(() => summarizePlaywrightReport(playwrightReport('webmeet-public-room', { extraTitles: ['another'] }), 'webmeet-public-room'));
});

test('a spec 03 report with the current title is accepted as the pinned test', () => {
    const rename = (title) => (r) => { r.suites[0].suites[0].specs[0].title = title; };
    const current = summarizePlaywrightReport(playwrightReport('optional-agents', { mutate: rename(CURRENT_SPEC_03_TITLE) }), 'optional-agents');
    assert.deepEqual(current.tests, [CURRENT_SPEC_03_TITLE]);
    assert.equal(GATE_SELECTIONS['optional-agents'].test, CURRENT_SPEC_03_TITLE);
    assert.doesNotThrow(() => buildWith('optional-agents', { report: rename(CURRENT_SPEC_03_TITLE) }));
});

test('the old spec 03 title is not the pinned test', () => {
    const rename = (title) => (r) => { r.suites[0].suites[0].specs[0].title = title; };
    assert.throws(() => summarizePlaywrightReport(playwrightReport('optional-agents', { mutate: rename(OLD_SPEC_03_TITLE) }), 'optional-agents'), /pinned test/);
    assert.throws(() => buildWith('optional-agents', { report: rename(OLD_SPEC_03_TITLE) }), /pinned test/);
    // The old title cannot stand in even next to extra tests.
    assert.throws(() => summarizePlaywrightReport(playwrightReport('optional-agents', { extraTitles: ['Scribe also enables'], mutate: rename(OLD_SPEC_03_TITLE) }), 'optional-agents'), /pinned test/);
});

test('the producer rejects a manifest, image evidence, or revision that does not fit together', () => {
    const base = receiptInputs({ candidateDigest: `sha256:${'1'.repeat(64)}`, mcpSdkCommit: '7'.repeat(40) });
    assert.doesNotThrow(() => buildAcceptanceReceipt(base));
    const manifest = (change) => { const m = releaseManifest(); change(m); return m; };
    for (const change of [
        { releaseManifest: manifest((m) => { m.images.ploinkyBox.digest = `sha256:${'0'.repeat(64)}`; }) },
        { releaseManifest: manifest((m) => { m.repositories.explorer.commit = 'main'; }) },
        { releaseManifest: manifest((m) => { delete m.repositories.achillesCLI; }) },
        { releaseManifest: manifest((m) => { m.extra = 1; }) },
        { releaseManifest: manifest((m) => { m.images.other = { digest: 'x' }; }) },
        { imageInspect: [] }, { imageInspect: [...imageInspect(), ...imageInspect()] },
        { imageInspect: [{ ...imageInspect()[0], Architecture: 's390x' }] }, { imageInspect: [{ ...imageInspect()[0], Os: 'windows' }] },
        { imageInspect: [{ ...imageInspect()[0], Id: 'latest' }] },
        { mcpSdkCommit: 'main' }, { mcpSdkCommit: '' }, { gates: null }, { gates: {} },
        { candidateDigest: 'latest' }, { candidateDigest: `${IMAGE}:latest` },
    ]) {
        assert.throws(() => buildAcceptanceReceipt({ ...base, ...change }), JSON.stringify(change).slice(0, 80));
    }
    // The retired v1 input is not accepted in place of the per-gate evidence.
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: undefined, generation: 'g1', reports: reportSet() }), /gate evidence/);
});

test('every gate binds its preflight, report and postflight to one run, one Box identity and the 30-minute generation window', () => {
    // Control: the unmutated evidence builds, so each refusal below comes from its one mutation.
    assert.doesNotThrow(() => buildAcceptanceReceipt(receiptInputs()));
    const id = 'onlyoffice-confidential';
    const cohortEnd = cohortStartMs(id) + 30 * MIN;
    const wrong = (p) => { p.runId = 'run-another'; };
    const refused = {
        // A preflight (or postflight) of another invocation is a different run.
        'swapped preflight': [() => withGate(id, (g) => { g.preflight = evidenceSet()['copilot-folder-launch'].preflight; }), /one run id/],
        'swapped postflight': [() => withGate(id, (g) => { g.postflight = evidenceSet()['copilot-folder-launch'].postflight; }), /one run id/],
        'preflight run id differs from the report': [() => buildWith(id, { preflight: wrong }), /one run id/],
        'postflight run id differs from the report': [() => buildWith(id, { postflight: wrong }), /one run id/],
        'report run id differs': [() => buildWith(id, { runId: 'run-another' }), /one run id/],
        'report without a run id': [() => buildWith(id, { report: (r) => { delete r.config.metadata; } }), /run id/],
        'preflight without a run id': [() => buildWith(id, { preflight: (p) => { delete p.runId; } }), /run id/],
        'postflight without a run id': [() => buildWith(id, { postflight: (p) => { delete p.runId; } }), /run id/],
        'a run id shared by two gates': [() => buildWith('webmeet-room-chat', { runId: runIdOf('webmeet-public-room'), preflight: (p) => { p.runId = runIdOf('webmeet-public-room'); }, postflight: (p) => { p.runId = runIdOf('webmeet-public-room'); } }), /distinct run id/],
        // The postflight is the terminal verdict.
        'missing postflight': [() => withGate(id, (g) => { delete g.postflight; }), new RegExp(`gate ${id}: .*postflight`)],
        'missing preflight': [() => withGate(id, (g) => { delete g.preflight; }), new RegExp(`gate ${id}: .*preflight`)],
        'missing report': [() => withGate(id, (g) => { delete g.report; }), new RegExp(`gate ${id}: .*report`)],
        'postflight exit code 1': [() => buildWith(id, { postflight: (p) => { p.exitCode = 1; } }), /exitCode/],
        'postflight exit code as text': [() => buildWith(id, { postflight: (p) => { p.exitCode = '0'; } }), /exitCode/],
        'postflight without an exit code': [() => buildWith(id, { postflight: (p) => { delete p.exitCode; } }), /exitCode/],
        'postflight before the report finished': [() => buildWith(id, { postflight: (p) => { p.capturedAt = iso(endOf(id) - 1); } }), /before the report finished/],
        'late postflight, 1 ms past 30 minutes': [() => buildWith(id, { postflight: (p) => { p.capturedAt = iso(cohortEnd + 1); } }), /within 30 minutes/],
        'late postflight, a fraction of a millisecond past 30 minutes': [() => buildWith(id, { postflight: (p) => { p.capturedAt = `${iso(cohortEnd).slice(0, -1)}0001Z`; } }), /within 30 minutes/],
        'preflight captured after the test started': [() => buildWith(id, { preflight: (p) => { p.capturedAt = iso(startOf(id) + 1); } }), /preflight was captured after/],
        // The Box must not change between the preflight and the postflight.
        'postflight container': [() => buildWith(id, { postflight: (p) => { p.box.containerId = '9'.repeat(64); } }), /Box identity/],
        'postflight start time': [() => buildWith(id, { postflight: (p) => { p.box.startedAt = '2026-10-26T10:00:00.001Z'; } }), /Box identity/],
        'postflight image': [() => buildWith(id, { postflight: (p) => { p.box.imageId = ENGINE_ID.amd64; } }), /Box identity/],
        'postflight without a Box': [() => buildWith(id, { postflight: (p) => { delete p.box; } }), /Box identity/],
        // The preflight must describe this candidate under the 30-minute cap.
        'preflight image differs from the engine image': [() => buildWith(id, { preflight: (p) => { p.box.imageId = ENGINE_ID.amd64; } }), /engine image/],
        'preflight explorer commit differs from the manifest': [() => buildWith(id, { preflight: (p) => { p.repositories.explorer.commit = '5'.repeat(40); } }), /explorer.*manifest/],
        'preflight ploinky commit differs from the manifest': [() => buildWith(id, { preflight: (p) => { p.repositories.ploinky.commit = '5'.repeat(40); } }), /ploinky.*manifest/],
        'preflight agentlib commit differs from the manifest': [() => buildWith(id, { preflight: (p) => { p.repositories.achillesAgentLib.commit = '5'.repeat(40); } }), /achillesAgentLib.*manifest/],
        'preflight achillesCLI commit differs from the manifest': [() => buildWith(id, { preflight: (p) => { p.repositories.achillesCLI.commit = '5'.repeat(40); } }), /achillesCLI.*manifest/],
        'preflight without repositories': [() => buildWith(id, { preflight: (p) => { delete p.repositories; } }), /repositories/],
        'separate screen profile': [() => buildWith(id, { preflight: (p) => { p.ledgerCoverage = 'separate-screen-profile-no-ledger-acceptance'; } }), /ledgerCoverage/],
        'separate QA profile': [() => buildWith(id, { preflight: (p) => { p.ledgerCoverage = 'separate-qa-profile-no-local-box-acceptance'; } }), /ledgerCoverage/],
        'generation cap 1 800 001': [() => buildWith(id, { preflight: (p) => { p.generationMaxAgeMs = 1_800_001; } }), /generationMaxAgeMs/],
        'generation cap as text': [() => buildWith(id, { preflight: (p) => { p.generationMaxAgeMs = '1800000'; } }), /generationMaxAgeMs/],
        'preflight container id malformed': [() => buildWith(id, { preflight: (p) => { p.box.containerId = 'abc'; } }), /containerId/],
        'preflight Box start malformed': [() => buildWith(id, { preflight: (p) => { p.box.startedAt = 'yesterday'; } }), /startedAt/],
        'preflight is not JSON': [() => withGate(id, (g) => { g.preflight = Buffer.from('{'); }), /preflight.*JSON/],
        'unexpected parent result on another gate': [() => withGate(id, (g) => { g.parentResult = parentResultFor(id); }), /parent result/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
    // The boundary: exactly 30 minutes after the cohort start passes, with the postflight as the finish.
    const exact = buildWith(id, { postflight: (p) => { p.capturedAt = iso(cohortEnd); } });
    assert.equal(exact.gates.find((gate) => gate.id === id).finished_at, iso(cohortEnd));
    assert.equal(buildWith(id, { preflight: (p) => { p.generationMaxAgeMs = 1_800_000; } }).gates.length, 6);
    // finished_at rounds a fractional capture time up: 30:00.0000 + 0.1 ms is 30:00.001 and is refused; 29:59.9999 rounds to 30:00.000 and passes.
    const justUnder = `${iso(cohortEnd - 1).slice(0, -1)}9999Z`;
    assert.equal(buildWith(id, { postflight: (p) => { p.capturedAt = justUnder; } }).gates.find((gate) => gate.id === id).finished_at, iso(cohortEnd));
    // Without the rounding a fractional capture time would parse (and be recorded) earlier than it happened.
    assert.equal(buildWith(id, { postflight: (p) => { p.capturedAt = `${iso(endOf(id) + 2000).slice(0, -1)}0001Z`; } }).gates.find((gate) => gate.id === id).finished_at, iso(endOf(id) + 2001));
});

test('spec 06 also needs a parent result that proves the leak scan and complete cleanup for the same run', () => {
    const id = 'copilot-live-skills';
    assert.doesNotThrow(() => buildWith(id, {}));
    const refused = {
        'missing parent result': [() => withGate(id, (g) => { delete g.parentResult; }), /parent result/],
        'parent result is not JSON': [() => withGate(id, (g) => { g.parentResult = Buffer.from('not json'); }), /parent result.*JSON/],
        'failed parent result': [() => buildWith(id, { parent: (p) => { p.code = 'CLEANUP_INCOMPLETE'; } }), /code/],
        'parent result without a code': [() => buildWith(id, { parent: (p) => { delete p.code; } }), /code/],
        'unproven leak scan coverage': [() => buildWith(id, { parent: (p) => { p.leakScanCoverage = 'unproven'; } }), /leakScanCoverage/],
        'missing leak scan coverage': [() => buildWith(id, { parent: (p) => { delete p.leakScanCoverage; } }), /leakScanCoverage/],
        'a leak': [() => buildWith(id, { parent: (p) => { p.leaks = 1; } }), /leaks/],
        'leaks as a list': [() => buildWith(id, { parent: (p) => { p.leaks = ['ACCESS_TOKEN']; } }), /leaks/],
        'missing leak count': [() => buildWith(id, { parent: (p) => { delete p.leaks; } }), /leaks/],
        'an undecodable file': [() => buildWith(id, { parent: (p) => { p.undecodable = ['results.json']; } }), /undecodable/],
        'undecodable count': [() => buildWith(id, { parent: (p) => { p.undecodable = 2; } }), /undecodable/],
        'missing undecodable list': [() => buildWith(id, { parent: (p) => { delete p.undecodable; } }), /undecodable/],
        'a cleanup flag false': [() => buildWith(id, { parent: (p) => { p.cleanup.robotDeleted = false; } }), /cleanup/],
        'a cleanup flag not boolean': [() => buildWith(id, { parent: (p) => { p.cleanup.folderDeleted = 'true'; } }), /cleanup/],
        'no cleanup flags': [() => buildWith(id, { parent: (p) => { p.cleanup = {}; } }), /cleanup/],
        'cleanup as a summary string': [() => buildWith(id, { parent: (p) => { p.cleanup = 'complete'; } }), /cleanup/],
        'missing cleanup': [() => buildWith(id, { parent: (p) => { delete p.cleanup; } }), /cleanup/],
        'parent result of another run': [() => buildWith(id, { parent: (p) => { p.runId = 'run-another'; } }), /one run id/],
        'parent result without a run id': [() => buildWith(id, { parent: (p) => { delete p.runId; } }), /run id/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
    // Extra keys of the parent line are tolerated; only the named keys are read.
    assert.doesNotThrow(() => buildWith(id, { parent: (p) => { p.command = 'run'; p.exitCode = 0; p.artifactDirectory = '/x'; } }));
});

test('the cohorts are read from the preflights: one generation per cohort, a different one for each cohort', () => {
    // Two official gates on different Box generations are refused.
    const other = (p) => { p.box.containerId = '4'.repeat(64); };
    assert.throws(() => buildWith('webmeet-room-chat', { preflight: other, postflight: other }), /cohort official-release.*same Box generation/);
    const later = (p) => { p.box.startedAt = '2026-10-26T10:00:00.001Z'; };
    assert.throws(() => buildWith('webmeet-room-chat', { preflight: later, postflight: later }), /cohort official-release.*same Box generation/);
    // Cohorts that share a Box container are refused.
    const shared = (p) => { p.box.containerId = COHORTS['official-release'].containerId; };
    for (const id of ['copilot-live-skills', 'optional-agents']) {
        assert.throws(() => buildWith(id, { preflight: shared, postflight: shared }), /cohorts .* share|distinct Box/);
    }
    // 06 and 03 on one generation are refused.
    const as03 = (p) => { p.box.containerId = COHORTS['optional-defaults-and-activation'].containerId; };
    assert.throws(() => buildWith('copilot-live-skills', { preflight: as03, postflight: as03 }), /distinct Box|share/);
    // Each cohort ID is the ledger's.
    const receipt = receiptFor(`sha256:${'1'.repeat(64)}`);
    assert.deepEqual(Object.keys(receipt.cohorts).sort(), ['copilot-live-skills', 'official-release', 'optional-defaults-and-activation']);
});

test('the official cohort runs 05, 30-public, 30-media, 50 in that order without overlap', () => {
    const [first, second, third, fourth] = OFFICIAL_ORDER;
    // Control: the default timing is the canonical order.
    assert.deepEqual(OFFICIAL_ORDER.map((id) => startOf(id)), [...OFFICIAL_ORDER.map((id) => startOf(id))].sort((a, b) => a - b));
    assert.doesNotThrow(() => buildAcceptanceReceipt(receiptInputs()));
    // 30-public starts before 05 has finished.
    assert.throws(() => buildWith(second, withTimes(endOf(first) - 1000, 20_000)), /without overlap/);
    // 50 runs before 30-media: the recording order of the receipt is not the execution order.
    assert.throws(() => buildWith(fourth, withTimes(startOf(third) - 60_000, 30_000)), /without overlap/);
    // 30-media before 30-public.
    assert.throws(() => buildWith(third, withTimes(startOf(first) + 30_000, 10_000)), /without overlap/);
    // Touching is not overlapping: a gate may start exactly when the previous finished.
    const previous = buildAcceptanceReceipt(receiptInputs()).gates.find((gate) => gate.id === first).finished_at;
    assert.doesNotThrow(() => buildWith(second, withTimes(Date.parse(previous), 20_000)));
    // 06 and 03 are in their own cohorts, so their timing does not interact with the official sequence.
    assert.doesNotThrow(() => buildWith('copilot-live-skills', withTimes(cohortStartMs('copilot-live-skills') + MIN, 5 * MIN)));
});

test('the receipt validator enforces exact keys, counts, selections, cohorts, timing, and distinct evidence', () => {
    const digest = `sha256:${'1'.repeat(64)}`;
    const good = receiptFor(digest);
    assert.doesNotThrow(() => validateAcceptanceReceipt(good));
    const mutate = (change) => { const r = structuredClone(good); change(r); return r; };
    for (const [label, receipt] of Object.entries({
        'schema v1': mutate((r) => { r.schema = 'ploinky.box.acceptance-receipt/v1'; }),
        'extra key': mutate((r) => { r.note = 'trust me'; }),
        'v1 generation key': mutate((r) => { r.generation = 'generation-20261002-1'; }),
        'extra gate key': mutate((r) => { r.gates[0].screenshots = []; }),
        'extra revision': mutate((r) => { r.revisions.other = 'a'.repeat(40); }),
        'missing mcp_sdk_commit': mutate((r) => { delete r.revisions.mcp_sdk_commit; }),
        'symbolic revision': mutate((r) => { r.revisions.explorer = 'main'; }),
        'tag digest': mutate((r) => { r.candidate.digest = 'latest'; }),
        'passed 2': mutate((r) => { r.gates[0].passed = 2; }),
        'passed 0': mutate((r) => { r.gates[0].passed = 0; }),
        failed: mutate((r) => { r.gates[1].failed = 1; }),
        skipped: mutate((r) => { r.gates[1].skipped = 1; }),
        retried: mutate((r) => { r.gates[2].retried = 1; }),
        flaky: mutate((r) => { r.gates[2].flaky = 1; }),
        'string count': mutate((r) => { r.gates[0].passed = '1'; }),
        'missing gate': mutate((r) => { r.gates.pop(); }),
        'duplicate gate': mutate((r) => { r.gates.push(structuredClone(r.gates[0])); }),
        'unknown gate': mutate((r) => { r.gates[0].id = 'anything'; }),
        'wrong selection': mutate((r) => { r.gates[0].tests = ['another test']; }),
        'release gate with two tests': mutate((r) => { r.gates[0].tests.push('second'); r.gates[0].passed = 2; }),
        'prerequisite without its pinned test': mutate((r) => { r.gates[1].tests = ['something else']; }),
        'prerequisite count mismatch': mutate((r) => { r.gates[2].tests.push('another marketplace test'); }),
        'prerequisite with no passed test': mutate((r) => { r.gates[2].passed = 0; }),
        'prerequisite duplicate titles': mutate((r) => { r.gates[2].tests.push(r.gates[2].tests[0]); r.gates[2].passed = 2; }),
        'prerequisite failed': mutate((r) => { r.gates[1].failed = 1; }),
        'prerequisite skipped': mutate((r) => { r.gates[2].skipped = 1; }),
        'phase order': mutate((r) => { [r.gates[1], r.gates[2]] = [r.gates[2], r.gates[1]]; }),
        'missing prerequisite phase': mutate((r) => { r.gates.splice(1, 1); }),
        'missing optional-agents phase': mutate((r) => { r.gates.splice(2, 1); }),
        'old single test field': mutate((r) => { r.gates[0].test = r.gates[0].tests[0]; delete r.gates[0].tests; }),
        'wrong spec': mutate((r) => { r.gates[0].spec = 'specs/99-other.spec.mjs'; }),
        'bad report hash': mutate((r) => { r.gates[0].report_sha256 = 'abc'; }),
        'reused report': mutate((r) => { r.gates[1].report_sha256 = r.gates[0].report_sha256; }),
        'no engine id': mutate((r) => { r.engine_image_ids = {}; }),
        'unknown arch': mutate((r) => { r.engine_image_ids = { s390x: `sha256:${'1'.repeat(64)}` }; }),
        'bad engine id': mutate((r) => { r.engine_image_ids.arm64 = 'sha256:abc'; }),
    })) {
        assert.throws(() => validateAcceptanceReceipt(receipt), label);
    }
    const refused = {
        'missing cohorts': [(r) => { delete r.cohorts; }, /cohorts/],
        'a missing cohort': [(r) => { delete r.cohorts['optional-defaults-and-activation']; }, /cohorts/],
        'an extra cohort': [(r) => { r.cohorts.extra = structuredClone(r.cohorts['official-release']); r.cohorts.extra.container_id = '8'.repeat(64); }, /cohorts/],
        'the retired optional-agents cohort id': [(r) => { r.cohorts['optional-agents'] = r.cohorts['optional-defaults-and-activation']; delete r.cohorts['optional-defaults-and-activation']; }, /cohorts/],
        'cohorts sharing a container': [(r) => { r.cohorts['copilot-live-skills'].container_id = r.cohorts['official-release'].container_id; }, /distinct/],
        'a malformed container id': [(r) => { r.cohorts['official-release'].container_id = 'abc'; }, /container_id/],
        'a cohort start that does not round-trip': [(r) => { r.cohorts['official-release'].started_at = '2026-10-26T10:00:00Z'; }, /started_at/],
        'a gate in the wrong cohort': [(r) => { r.gates[0].cohort = 'copilot-live-skills'; }, /cohort/],
        'a gate without a cohort': [(r) => { delete r.gates[0].cohort; }, /exactly/],
        'a gate timestamp that does not round-trip': [(r) => { r.gates[0].started_at = '2026-10-26 10:02:00'; }, /started_at/],
        'a gate that starts before its cohort': [(r) => { r.gates[0].started_at = '2026-10-26T09:59:59.999Z'; }, /before its cohort/],
        'a gate that finishes before it starts': [(r) => { r.gates[0].finished_at = '2026-10-26T10:01:59.999Z'; }, /before it started/],
        'a release gate finishing 30 minutes and 1 ms after its cohort': [(r) => { r.gates[3].finished_at = '2026-10-26T10:30:00.001Z'; }, /within 30 minutes/],
        'a prerequisite gate finishing 30 minutes and 1 ms after its cohort': [(r) => { r.gates[1].finished_at = '2026-10-26T09:30:00.001Z'; }, /within 30 minutes/],
        'a missing preflight hash': [(r) => { delete r.gates[0].preflight_sha256; }, /exactly/],
        'a malformed preflight hash': [(r) => { r.gates[0].preflight_sha256 = 'abc'; }, /preflight digest/],
        'a reused preflight': [(r) => { r.gates[1].preflight_sha256 = r.gates[0].preflight_sha256; }, /preflight digest is shared/],
        'a missing postflight hash': [(r) => { delete r.gates[0].postflight_sha256; }, /exactly/],
        'a reused postflight': [(r) => { r.gates[1].postflight_sha256 = r.gates[0].postflight_sha256; }, /postflight digest is shared/],
        'spec 06 without its parent result hash': [(r) => { delete r.gates[1].parent_result_sha256; }, /exactly/],
        'a malformed parent result hash': [(r) => { r.gates[1].parent_result_sha256 = 'abc'; }, /parent result digest/],
        'a parent result hash on another gate': [(r) => { r.gates[0].parent_result_sha256 = 'a'.repeat(64); }, /exactly/],
        'official gates that overlap': [(r) => { r.gates[4].started_at = '2026-10-26T10:02:30.000Z'; }, /without overlap/],
        'official gates out of execution order': [(r) => { [r.gates[3].started_at, r.gates[3].finished_at] = ['2026-10-26T10:07:00.000Z', '2026-10-26T10:08:00.000Z']; }, /without overlap/],
    };
    for (const [label, [change, expected]] of Object.entries(refused)) assert.throws(() => validateAcceptanceReceipt(mutate(change)), expected, label);
    // Exactly 30 minutes passes at the validator as well; a prerequisite cohort is checked like the official one.
    assert.doesNotThrow(() => validateAcceptanceReceipt(mutate((r) => { r.gates[3].finished_at = '2026-10-26T10:30:00.000Z'; })));
    assert.doesNotThrow(() => validateAcceptanceReceipt(mutate((r) => { r.gates[1].finished_at = '2026-10-26T09:30:00.000Z'; })));
    assert.throws(() => validateAcceptanceReceipt(null));
    assert.throws(() => validateAcceptanceReceipt([]));
});

test('a v1 receipt is refused by the validator, the canonical parser and the workflow inputs', async (t) => {
    const f = await fixture(t);
    const v2 = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    // The v1 shape: one generation string, five gates without cohorts or timing evidence.
    const v1 = {
        schema: 'ploinky.box.acceptance-receipt/v1', candidate: v2.candidate, revisions: v2.revisions, generation: 'generation-20261002-1',
        engine_image_ids: v2.engine_image_ids,
        gates: v2.gates.filter(({ id }) => id !== 'webmeet-public-room').map(({ id, spec, tests, passed, failed, skipped, retried, flaky, report_sha256 }) => ({ id, spec, tests, passed, failed, skipped, retried, flaky, report_sha256 })),
    };
    const text = canonicalReceiptText(v1);
    assert.throws(() => validateAcceptanceReceipt(v1), /schema/);
    assert.throws(() => parseCanonicalReceipt(text), /schema/);
    assert.throws(() => validateInputs({ ...f.env, ACCEPTANCE_RECEIPT_JSON: text }), /schema/);
    // The v1 schema string alone on an otherwise v2 receipt is refused too.
    assert.throws(() => validateAcceptanceReceipt({ ...v2, schema: 'ploinky.box.acceptance-receipt/v1' }), /schema/);
    // Control: the v2 receipt is accepted.
    assert.doesNotThrow(() => validateInputs(f.env));
});

test('the receipt is bound to the candidate digest, source, libraries, and per-architecture engine image', async (t) => {
    const f = await fixture(t);
    const good = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    const withReceipt = (change) => { const r = structuredClone(good); change(r); return { ...f.env, ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(r) }; };
    const other = `sha256:${'0'.repeat(64)}`;
    for (const [label, env] of Object.entries({
        'candidate digest': withReceipt((r) => { r.candidate.digest = other; }),
        'ploinky revision': withReceipt((r) => { r.revisions.ploinky = 'd'.repeat(40); }),
        'agentlib commit': withReceipt((r) => { r.revisions.achilles_agent_lib = 'd'.repeat(40); }),
        'mcp sdk commit': withReceipt((r) => { r.revisions.mcp_sdk_commit = 'd'.repeat(40); }),
        'engine image id': withReceipt((r) => { r.engine_image_ids.arm64 = other; }),
        'engine image id of the other architecture': withReceipt((r) => { r.engine_image_ids = { amd64: ENGINE_ID.arm64 }; }),
        'failed gate': withReceipt((r) => { r.gates[0].failed = 1; }),
        'missing gate': withReceipt((r) => { r.gates.pop(); }),
        'skipped gate': withReceipt((r) => { r.gates[1].skipped = 1; }),
        'retried gate': withReceipt((r) => { r.gates[2].retried = 1; }),
    })) {
        await assert.rejects(f.verify({ env }), new RegExp(label.split(' ')[0], 'i'), label);
    }
    // The receipt for amd64 evidence is accepted when it names the amd64 engine image.
    const amd64 = withReceipt((r) => { r.engine_image_ids = { amd64: ENGINE_ID.amd64 }; });
    await f.verify({ env: amd64 });
    const both = withReceipt((r) => { r.engine_image_ids = { ...ENGINE_ID }; });
    await f.verify({ env: both });
    // The explicit AgentLib and MCP SDK commits are the frozen library-input commits.
    assert.equal(good.revisions.achilles_agent_lib, readJson(path.join(f.evidence, 'library-inputs/library-inputs.json')).libraries.achillesAgentLib.commit);
    assert.equal(good.revisions.mcp_sdk_commit, readJson(path.join(f.evidence, 'library-inputs/library-inputs.json')).libraries['mcp-sdk'].commit);
});

// --- aliases and confirmation -----------------------------------------------------------------

test('previous aliases are read by raw index bytes, an absent alias is recorded, and the write plan is explicit', async (t) => {
    const f = await fixture(t);
    const previous = readAliases(f.exec);
    assert.deepEqual(previous, { latest: `sha256:${hash('previous-latest')}`, runtime: `sha256:${hash('previous-runtime')}` });
    delete f.aliases.runtime;
    assert.deepEqual(readAliases(f.exec), { latest: `sha256:${hash('previous-latest')}`, runtime: null });
    // Any failure other than "not found" is not an absent alias.
    assert.throws(() => readAliases(() => { throw Object.assign(new Error('timeout'), { stderr: 'i/o timeout' }); }), /timeout/);
    const d = f.candidateDigest;
    assert.equal(planAliasWrite({ latest: 'sha256:1', runtime: 'sha256:2' }, d), 'promote');
    assert.equal(planAliasWrite({ latest: null, runtime: null }, d), 'promote');
    assert.equal(planAliasWrite({ latest: d, runtime: d }, d), 'current');
    assert.equal(planAliasWrite({ latest: d, runtime: 'sha256:2' }, d), 'complete-partial');
    assert.equal(planAliasWrite({ latest: 'sha256:1', runtime: d }, d), 'complete-partial');
    assert.equal(planAliasWrite({ latest: d, runtime: null }, d), 'complete-partial');
});

test('confirmation requires both aliases to hash to the accepted digest and reports the exact current aliases otherwise', async (t) => {
    const f = await fixture(t);
    const summary = path.join(f.root, 'summary.md');
    f.aliases = { latest: f.indexBytes, runtime: f.indexBytes };
    const ok = confirmAliases({ digest: f.candidateDigest, exec: f.exec, summaryFile: summary });
    assert.deepEqual(ok, { ok: true, aliases: { latest: f.candidateDigest, runtime: f.candidateDigest } });
    assert.match(fs.readFileSync(summary, 'utf8'), new RegExp(`${f.candidateDigest}`));
    // A partial write: latest moved, runtime did not.
    f.aliases = { latest: f.indexBytes, runtime: Buffer.from('previous-runtime') };
    fs.rmSync(summary);
    const result = confirmAliases({ digest: f.candidateDigest, exec: f.exec, summaryFile: summary });
    assert.equal(result.ok, false);
    assert.deepEqual(result.aliases, { latest: f.candidateDigest, runtime: `sha256:${hash('previous-runtime')}` });
    const text = fs.readFileSync(summary, 'utf8');
    assert.match(text, /FAILED/);
    assert.ok(text.includes(`${IMAGE}:runtime`) && text.includes(`sha256:${hash('previous-runtime')}`));
    assert.ok(text.includes(`${IMAGE}:latest`));
    // An absent alias, and an unreadable one, are both a failed confirmation.
    delete f.aliases.runtime;
    assert.equal(confirmAliases({ digest: f.candidateDigest, exec: f.exec, summaryFile: summary }).aliases.runtime, null);
    assert.throws(() => confirmAliases({ digest: f.candidateDigest, exec: () => { throw new Error('registry unavailable'); }, summaryFile: summary }), /registry unavailable/);
    assert.throws(() => confirmAliases({ digest: 'latest', exec: f.exec, summaryFile: summary }));
});

// --- workflow text ----------------------------------------------------------------------------

const jobBody = (text, job) => text.match(new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z-]+:\\n|$)`))?.[0] || '';
const verifyJob = jobBody(promotionWorkflow, 'verify');
const promoteJob = jobBody(promotionWorkflow, 'promote');

function stepBody(job, name) {
    const marker = `      - name: ${name}\n`;
    const start = job.indexOf(marker);
    assert.notEqual(start, -1, name);
    const end = job.indexOf('\n      - name:', start + marker.length);
    const step = job.slice(start, end < 0 ? undefined : end);
    return step.split('        run: |\n')[1].split('\n').map((line) => (line.startsWith('          ') ? line.slice(10) : line)).join('\n').trim();
}

const stepNames = (job) => [...job.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
const runBodies = (text) => [...text.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)].map((m) => m[1]);

test('the promotion workflow shares the publish concurrency group and cannot build or push a new image', () => {
    for (const workflow of [promotionWorkflow, publishWorkflow]) {
        assert.match(workflow, /^concurrency:\n  group: publish-ploinky-box-image\n  cancel-in-progress: false\n/m);
    }
    assert.match(promotionWorkflow, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(promotionWorkflow, /^\s+(push|pull_request|pull_request_target|workflow_run|schedule|workflow_call):/m);
    assert.match(promotionWorkflow, /^permissions:\n  contents: read\n  actions: read\n\n/m);
    assert.doesNotMatch(promotionWorkflow, /build-push-action|docker\/build|buildx build|docker build(?!x)|setup-buildx-action|docker push|docker pull|Dockerfile|setup-qemu|docker commit|docker tag|imagetools create[^\n]*--annotation/);
    assert.doesNotMatch(promotionWorkflow, /\bpackages: write|\bid-token:|\bcontents: write|\bactions: write/);
    for (const use of promotionWorkflow.matchAll(/^\s*(?:- )?uses:\s*[^@\s]+@([^\s#]+)/gm)) assert.match(use[1], /^[0-9a-f]{40}$/);
    // The same pinned action revisions the publish workflow already uses.
    for (const use of promotionWorkflow.matchAll(/uses:\s*([^\s@]+)@([0-9a-f]{40})/g)) {
        assert.ok(publishWorkflow.includes(`${use[1]}@${use[2]}`), `${use[1]} is not pinned like the publish workflow`);
    }
    const inputs = promotionWorkflow.match(/workflow_dispatch:\n    inputs:\n([\s\S]*?)\n\npermissions:/)?.[1] || '';
    assert.deepEqual([...inputs.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]),
        ['candidate_run_id', 'candidate_run_attempt', 'candidate_digest', 'source_sha', 'image_definitions_sha', 'acceptance_receipt_json']);
    assert.equal([...inputs.matchAll(/required: true/g)].length, 6);
    assert.doesNotMatch(inputs, /default:/);
});

test('every dispatch input, including the receipt, reaches shell only through env', () => {
    for (const body of runBodies(promotionWorkflow)) assert.doesNotMatch(body, /\$\{\{/);
    assert.doesNotMatch(promotionWorkflow, /github\.event\.inputs/);
    const receiptUses = [...promotionWorkflow.matchAll(/^.*inputs\.acceptance_receipt_json.*$/gm)].map((m) => m[0].trim());
    assert.deepEqual(receiptUses.filter((line) => !/^ACCEPTANCE_RECEIPT_JSON: \$\{\{ inputs\.acceptance_receipt_json \}\}$/.test(line)).filter((line) => !/^description:/.test(line)), []);
    assert.ok(receiptUses.length >= 1);
});

test('no registry write or Docker Hub credential exists before every proof is validated', () => {
    assert.match(verifyJob, /runs-on: ubuntu-24\.04\n/);
    assert.doesNotMatch(verifyJob, /DOCKERHUB_TOKEN|docker\/login-action|imagetools create|docker login/);
    assert.match(promoteJob, /\n    needs: verify\n/);
    assert.match(promoteJob, /ACCEPTED_DIGEST: \$\{\{ needs\.verify\.outputs\.digest \}\}/);
    assert.equal([...promotionWorkflow.matchAll(/imagetools create/g)].length, 1);
    assert.equal([...promotionWorkflow.matchAll(/docker\/login-action/g)].length, 1);
    assert.equal([...promotionWorkflow.matchAll(/secrets\.DOCKERHUB_TOKEN/g)].length, 1);
    const names = stepNames(promoteJob);
    const login = names.indexOf('Log in to Docker Hub');
    const move = names.indexOf('Move latest and runtime to the exact accepted digest');
    assert.equal(names[0], 'Require dispatch from the main branch');
    assert.equal(stepNames(verifyJob)[0], 'Require dispatch from the main branch');
    assert.ok(names.indexOf('Record the previous aliases and the alias write plan') !== -1);
    assert.ok(names.indexOf('Record the previous aliases and the alias write plan') < login);
    assert.ok(login !== -1 && login < move);
    assert.ok(move < names.indexOf('Confirm both aliases by raw index bytes'));
    // The verify job pins the run, downloads, then checks out, then verifies, in that order.
    const order = ['Validate inputs and pin the candidate run', 'Download candidate evidence from the pinned run',
        'Checkout recorded image definitions', 'Checkout recorded Ploinky source', 'Verify exact clean recorded checkouts',
        'Verify the candidate, evidence and acceptance receipt before any registry write'].map((name) => stepNames(verifyJob).indexOf(name));
    assert.ok(order.every((index) => index !== -1), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(verifyJob, /outputs:\n      digest: \$\{\{ steps\.verify\.outputs\.digest \}\}/);
    assert.equal([...promotionWorkflow.matchAll(/persist-credentials: false/g)].length, [...promotionWorkflow.matchAll(/actions\/checkout@/g)].length);
    assert.match(verifyJob, /ref: \$\{\{ inputs\.image_definitions_sha \}\}\n\s+path: sources\/image-definitions/);
    assert.match(verifyJob, /ref: \$\{\{ inputs\.source_sha \}\}\n\s+path: sources\/ploinky/);
    assert.match(promotionWorkflow, /confirm[\s\S]*?if: \$\{\{ always\(\) && steps\.previous\.outcome == 'success' \}\}/);
    assert.doesNotMatch(promotionWorkflow, /GITHUB_SHA.*SOURCE_SHA|SOURCE_SHA.*\$GITHUB_SHA/);
});

// --- the workflow's own shell, with stubbed gh and docker -------------------------------------

const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify([tool, ...args]) + '\\n');
const sha = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
if (tool === 'gh') {
  if (args[0] === 'api' && /\\/attempts\\//.test(args.join(' '))) process.stdout.write(JSON.stringify(state.run));
  else if (args[0] === 'api') process.stdout.write(state.artifacts.map((a) => JSON.stringify(a)).join('\\n') + '\\n');
  else if (args[0] === 'run' && args[1] === 'download') {
    const name = args[args.indexOf('--name') + 1];
    const dir = args[args.indexOf('--dir') + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(state.downloads, name), dir, { recursive: true });
  } else process.exit(2);
} else if (tool === 'docker') {
  if (args[2] === 'inspect') {
    const ref = args[4];
    const alias = /:(latest|runtime)$/.exec(ref)?.[1];
    if (alias) {
      if (state.aliases[alias] === null) { process.stderr.write('ERROR: ' + ref + ': not found\\n'); process.exit(1); }
      process.stdout.write(Buffer.from(state.aliases[alias], 'base64'));
    } else if (ref === state.imageRef) process.stdout.write(Buffer.from(state.index, 'base64'));
    else { process.stderr.write('ERROR: ' + ref + ': not found\\n'); process.exit(1); }
  } else if (args[2] === 'create') {
    const tags = args.flatMap((a, i) => (args[i - 1] === '--tag' ? [a] : []));
    const source = args[args.length - 1];
    if (source !== state.imageRef) process.exit(3);
    for (const tag of tags) {
      const alias = /:(latest|runtime)$/.exec(tag)[1];
      if (state.failAfterFirstTag && tag !== tags[0]) continue;
      state.aliases[alias] = state.index;
    }
    save();
    if (state.failAfterFirstTag) process.exit(1);
  } else process.exit(2);
} else process.exit(2);
`;

async function shellFixture(t) {
    const f = await fixture(t);
    const work = path.join(f.root, 'workspace');
    fs.mkdirSync(path.join(work, 'sources'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'images'), path.join(work, 'images'));
    fs.symlinkSync(f.source, path.join(work, 'sources/ploinky'));
    fs.mkdirSync(path.join(work, 'sources/image-definitions'));
    fs.symlinkSync(path.join(ROOT, 'images'), path.join(work, 'sources/image-definitions/images'));
    const downloads = path.join(f.root, 'artifact-store');
    for (const [name, from] of [[artifactNames()[0], f.candidate], ['ploinky-box-native-amd64', path.join(f.proofs, 'ploinky-box-native-amd64')],
        ['ploinky-box-native-arm64', path.join(f.proofs, 'ploinky-box-native-arm64')], [artifactNames()[3], path.join(f.evidence, 'library-inputs')]]) {
        fs.cpSync(from, path.join(downloads, name), { recursive: true });
    }
    fs.rmSync(f.evidence, { recursive: true });
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['gh', 'docker']) fs.writeFileSync(path.join(bin, tool), STUB, { mode: 0o755 });
    const b64 = (value) => Buffer.from(value).toString('base64');
    f.shell = {
        work, bin, downloads, stateFile: path.join(f.root, 'state.json'), log: path.join(f.root, 'stub.jsonl'),
        state: {
            run: f.run, artifacts: artifactListing(), downloads, imageRef: `${IMAGE}@${f.candidateDigest}`, index: b64(f.indexBytes),
            aliases: { latest: b64('previous-latest'), runtime: b64('previous-runtime') },
        },
    };
    f.save = () => fs.writeFileSync(f.shell.stateFile, JSON.stringify(f.shell.state));
    f.save();
    fs.writeFileSync(f.shell.log, '');
    f.stub = () => fs.readFileSync(f.shell.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    f.state = () => readJson(f.shell.stateFile);
    f.step = (job, name, extra = {}) => {
        const runner = path.join(f.root, 'runner'); fs.mkdirSync(runner, { recursive: true });
        const env = {
            PATH: `${bin}:${process.env.PATH}`, HOME: f.root, RUNNER_TEMP: runner, STUB_STATE: f.shell.stateFile, STUB_LOG: f.shell.log,
            GH_TOKEN: 'stub', IMAGE_NAME: 'assistos/ploinky-box', IMAGE_TAG: 'latest', COMPATIBILITY_IMAGE_TAG: 'runtime',
            CANDIDATE_REPOSITORY: CANDIDATE_REPOSITORY, CANDIDATE_WORKFLOW: 'publish-ploinky-box-image.yml',
            ...f.env, ACCEPTED_DIGEST: f.candidateDigest, GITHUB_RUN_ID: PROMOTION.runId, GITHUB_RUN_ATTEMPT: PROMOTION.attempt,
            GITHUB_SHA: PROMOTION.sha, GITHUB_REF: PROMOTION.ref, GITHUB_OUTPUT: path.join(f.root, 'output'), GITHUB_STEP_SUMMARY: path.join(f.root, 'summary'),
            ...extra,
        };
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', stepBody(job, name)], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
        return result;
    };
    return f;
}

const VERIFY_STEPS = ['Validate inputs and pin the candidate run', 'Download candidate evidence from the pinned run',
    'Verify the candidate, evidence and acceptance receipt before any registry write'];
const writes = (f) => f.stub().filter((call) => call[0] === 'docker' && call[3] === 'create');

function runVerifyJob(f, extra = {}) {
    const results = [];
    for (const name of VERIFY_STEPS) {
        const result = f.step(verifyJob, name, extra);
        results.push(result);
        if (result.status !== 0) break;
    }
    return results;
}

test('the verify job shell accepts a complete candidate and never writes to a registry', async (t) => {
    const f = await shellFixture(t);
    const results = runVerifyJob(f);
    assert.deepEqual(results.map((r) => r.status), [0, 0, 0], results.map((r) => r.stderr).join('\n'));
    assert.match(fs.readFileSync(path.join(f.root, 'output'), 'utf8'), new RegExp(`^digest=${f.candidateDigest}$`, 'm'));
    assert.deepEqual(writes(f), []);
    const calls = f.stub();
    assert.equal(calls.filter((c) => c[0] === 'gh' && c[1] === 'run').length, 4);
    const evidence = path.join(f.root, 'runner/ploinky-box-promotion-evidence');
    assert.equal(readJson(path.join(evidence, 'promotion-verification.json')).promotion.runId, PROMOTION.runId);
    assert.equal(fs.readFileSync(path.join(evidence, 'acceptance-receipt.json'), 'utf8'), f.env.ACCEPTANCE_RECEIPT_JSON);
});

test('every rejected scenario stops the verify job before any registry write or later step', async (t) => {
    const scenarios = {
        tag: (f) => ({ extra: { CANDIDATE_DIGEST: 'latest' }, failing: 0 }),
        'wrong attempt': (f) => { f.shell.state.run = runJson({ run_attempt: 1 }); f.save(); return { failing: 0 }; },
        'wrong repository': (f) => { f.shell.state.run = runJson({ repository: { full_name: 'x/y' } }); f.save(); return { failing: 0 }; },
        'wrong workflow': (f) => { f.shell.state.run = runJson({ path: '.github/workflows/publish-ploinky-node-image.yml' }); f.save(); return { failing: 0 }; },
        'failed run': (f) => { f.shell.state.run = runJson({ conclusion: 'failure' }); f.save(); return { failing: 0 }; },
        'moved head': (f) => { f.shell.state.run = runJson({ head_sha: 'd'.repeat(40) }); f.save(); return { failing: 0 }; },
        'missing artifact': (f) => { f.shell.state.artifacts = f.shell.state.artifacts.slice(0, 2); f.save(); return { failing: 1 }; },
        'altered raw evidence': (f) => { fs.appendFileSync(path.join(f.shell.downloads, 'ploinky-box-native-amd64/native-probe.json'), '\n'); return { failing: 2 }; },
        'incomplete architecture set': (f) => { fs.rmSync(path.join(f.shell.downloads, 'ploinky-box-native-arm64'), { recursive: true }); fs.rmSync(path.join(f.shell.downloads, artifactNames()[0], 'native-proofs/ploinky-box-native-arm64'), { recursive: true }); return { failing: 1 }; },
        'source mismatch': (f) => ({ extra: { SOURCE_SHA: 'd'.repeat(40) }, failing: 2 }),
        'library mismatch': (f) => { const file = path.join(f.shell.downloads, artifactNames()[3], 'library-inputs.json'); const v = readJson(file); v.libraries['mcp-sdk'].commit = 'd'.repeat(40); writeJson(file, v); return { failing: 2 }; },
        'receipt mismatch': (f) => { const r = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON); r.engine_image_ids.arm64 = `sha256:${'0'.repeat(64)}`; return { extra: { ACCEPTANCE_RECEIPT_JSON: JSON.stringify(r) }, failing: 2 }; },
        'skipped gate': (f) => { const r = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON); r.gates[0].skipped = 1; r.gates[0].passed = 0; return { extra: { ACCEPTANCE_RECEIPT_JSON: JSON.stringify(r) }, failing: 0 }; },
        'registry index differs': (f) => { f.shell.state.index = Buffer.from('{}').toString('base64'); f.save(); return { failing: 2 }; },
    };
    for (const [label, prepare] of Object.entries(scenarios)) {
        const f = await shellFixture(t);
        const { extra = {}, failing } = prepare(f);
        const results = runVerifyJob(f, extra);
        const failed = results.findIndex((r) => r.status !== 0);
        assert.equal(failed, failing, `${label}: failed at step ${failed}: ${results.map((r) => r.stderr).join(' | ').slice(0, 400)}`);
        assert.deepEqual(writes(f), [], label);
        assert.ok(!fs.existsSync(path.join(f.root, 'output')) || !/^digest=/m.test(fs.readFileSync(path.join(f.root, 'output'), 'utf8')), `${label} produced a promotable digest`);
        // The pin runs first: a wrong run never reaches an artifact download.
        if (failing === 0) assert.equal(f.stub().filter((c) => c[0] === 'gh' && c[1] === 'run').length, 0, label);
    }
});

const PROMOTE_STEPS = { previous: 'Record the previous aliases and the alias write plan', move: 'Move latest and runtime to the exact accepted digest', confirm: 'Confirm both aliases by raw index bytes' };

test('a successful same-digest promotion moves both aliases once and confirms the raw bytes', async (t) => {
    const f = await shellFixture(t);
    const previous = f.step(promoteJob, PROMOTE_STEPS.previous);
    assert.equal(previous.status, 0, previous.stderr);
    assert.match(fs.readFileSync(path.join(f.root, 'output'), 'utf8'), /^mode=promote$/m);
    assert.deepEqual(writes(f), []);
    const move = f.step(promoteJob, PROMOTE_STEPS.move, { MODE: 'promote' });
    assert.equal(move.status, 0, move.stderr);
    const [create] = writes(f);
    assert.deepEqual(create, ['docker', 'buildx', 'imagetools', 'create', '--tag', `${IMAGE}:latest`, '--tag', `${IMAGE}:runtime`, `${IMAGE}@${f.candidateDigest}`]);
    assert.equal(writes(f).length, 1);
    const confirm = f.step(promoteJob, PROMOTE_STEPS.confirm);
    assert.equal(confirm.status, 0, confirm.stderr);
    const record = readJson(path.join(f.root, 'runner/ploinky-box-promotion-evidence/promotion-record.json'));
    assert.equal(record.acceptedDigest, f.candidateDigest);
    assert.deepEqual(record.previousAliases, { latest: `sha256:${hash('previous-latest')}`, runtime: `sha256:${hash('previous-runtime')}` });
    assert.deepEqual(record.candidate, { runId: CANDIDATE.runId, runAttempt: CANDIDATE.attempt, sourceSha: CANDIDATE.sourceSha, imageDefinitionsSha: CANDIDATE.definitionsSha });
    assert.deepEqual(record.promotion, { runId: PROMOTION.runId, runAttempt: PROMOTION.attempt, sha: PROMOTION.sha, ref: PROMOTION.ref });
    assert.equal(record.mode, 'promote');
    assert.deepEqual(record.confirmation, { ok: true, aliases: { latest: f.candidateDigest, runtime: f.candidateDigest } });
});

test('a post-promotion alias mismatch is a failed release that reports the exact current aliases, and a retry completes it', async (t) => {
    const f = await shellFixture(t);
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.previous).status, 0);
    // The registry write is not atomic: latest moves, the command then fails before runtime.
    f.shell.state.failAfterFirstTag = true; f.save();
    const move = f.step(promoteJob, PROMOTE_STEPS.move, { MODE: 'promote' });
    assert.notEqual(move.status, 0);
    const confirm = f.step(promoteJob, PROMOTE_STEPS.confirm);
    assert.notEqual(confirm.status, 0, 'a mismatch must fail the release');
    const summary = fs.readFileSync(path.join(f.root, 'summary'), 'utf8');
    assert.ok(summary.includes(`${IMAGE}:latest: ${f.candidateDigest}`), summary);
    assert.ok(summary.includes(`${IMAGE}:runtime: sha256:${hash('previous-runtime')}`), summary);
    const record = readJson(path.join(f.root, 'runner/ploinky-box-promotion-evidence/promotion-record.json'));
    assert.equal(record.confirmation.ok, false);
    // Retry with the same inputs: the plan sees the partial write and completes it; nothing else changes.
    fs.rmSync(path.join(f.root, 'output'));
    const stored = f.state(); stored.failAfterFirstTag = false; fs.writeFileSync(f.shell.stateFile, JSON.stringify(stored));
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.previous).status, 0);
    assert.match(fs.readFileSync(path.join(f.root, 'output'), 'utf8'), /^mode=complete-partial$/m);
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.move, { MODE: 'complete-partial' }).status, 0);
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.confirm).status, 0);
    assert.deepEqual(f.state().aliases, { latest: f.shell.state.index, runtime: f.shell.state.index });
});

test('re-dispatching an already completed promotion writes nothing and still confirms', async (t) => {
    const f = await shellFixture(t);
    f.shell.state.aliases = { latest: f.shell.state.index, runtime: f.shell.state.index }; f.save();
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.previous).status, 0);
    assert.match(fs.readFileSync(path.join(f.root, 'output'), 'utf8'), /^mode=current$/m);
    const move = f.step(promoteJob, PROMOTE_STEPS.move, { MODE: 'current' });
    assert.equal(move.status, 0, move.stderr);
    assert.deepEqual(writes(f), []);
    assert.equal(f.step(promoteJob, PROMOTE_STEPS.confirm).status, 0);
});

test('the promote job refuses a non-digest accepted value and an index that does not hash to it', async (t) => {
    const f = await shellFixture(t);
    for (const bad of ['latest', 'runtime', `${IMAGE}:latest`, '', `sha256:${'a'.repeat(63)}`]) {
        const result = f.step(promoteJob, PROMOTE_STEPS.previous, { ACCEPTED_DIGEST: bad });
        assert.notEqual(result.status, 0, bad);
    }
    f.shell.state.index = Buffer.from('tampered').toString('base64'); f.save();
    assert.notEqual(f.step(promoteJob, PROMOTE_STEPS.previous).status, 0);
    assert.deepEqual(writes(f), []);
    assert.throws(() => planAliasWrite({ latest: null, runtime: null }, 'latest'));
});

test('the promote step refuses an unknown plan mode before any write', async (t) => {
    const f = await shellFixture(t);
    for (const mode of ['', 'force', 'promote; true']) {
        assert.notEqual(f.step(promoteJob, PROMOTE_STEPS.move, { MODE: mode }).status, 0, mode);
    }
    assert.deepEqual(writes(f), []);
});

test('both jobs refuse a dispatch from any ref other than main before any other step, and no builder is set up', async (t) => {
    const f = await shellFixture(t);
    const guard = 'Require dispatch from the main branch';
    for (const job of [verifyJob, promoteJob]) {
        assert.equal(f.step(job, guard, { GITHUB_REF: 'refs/heads/main' }).status, 0);
        for (const ref of ['refs/heads/fix/ploinky-cleanup-integrated-20260925', 'refs/heads/main2', 'refs/heads/mainx', 'refs/tags/main', 'refs/pull/1/merge', '']) {
            assert.notEqual(f.step(job, guard, { GITHUB_REF: ref }).status, 0, ref);
        }
    }
    assert.doesNotMatch(promotionWorkflow, /setup-buildx-action|setup-qemu/);
    // GitHub drops an older pending run when a newer one queues; that is documented, and fails safe.
    assert.match(promotionWorkflow, /pending run/);
    assert.match(read('README.md'), /pending run/);
});

// A copy of the candidate verifier that neutralizes `assert` in its own process, as a
// hostile candidate could. It is active in the verifier child, or in this process when
// the test asks for it, so an in-process import would have disabled the parent's checks.
async function tamperedCandidate(f, { forge = false } = {}) {
    const definitions = path.join(f.root, forge ? 'forging-definitions' : 'tampered-definitions');
    fs.cpSync(path.join(ROOT, 'images'), path.join(definitions, 'images'), { recursive: true });
    const file = path.join(definitions, 'images/ploinky-box/verify-publication.mjs');
    const marker = path.join(definitions, 'tamper-ran');
    const envMarker = path.join(definitions, 'tamper-env.json');
    const rootMarker = path.join(definitions, 'tamper-root.txt');
    const original = fs.readFileSync(file, 'utf8');
    // A forging verifier also rewrites the saved evidence, in the directory it is given and in the originals.
    const forging = `
const __FORGED = 'sha256:' + '5'.repeat(64);
const __sha = (bytes) => __crypto.createHash('sha256').update(bytes).digest('hex');
export function verifyNativeProofs(root, context) {
  if (process.argv[2] !== 'candidate-verifier') return __verifyNativeProofs(root, context);
  __fs.writeFileSync(${JSON.stringify(rootMarker)}, root);
  const out = {};
  for (const a of ['amd64', 'arm64']) {
    const proof = JSON.parse(__fs.readFileSync(root + '/ploinky-box-native-' + a + '/native-proof.json', 'utf8'));
    if (a === 'arm64') {
      proof.image.configDigest = __FORGED;
      for (const dir of [root, ${JSON.stringify(f.proofs)}]) __fs.writeFileSync(dir + '/ploinky-box-native-arm64/native-proof.json', JSON.stringify(proof));
    }
    out[a] = proof;
  }
  return out;
}
export function verifyCandidate(root, indexFile, context) {
  if (process.argv[2] !== 'candidate-verifier') return __verifyCandidate(root, indexFile, context);
  const file = ${JSON.stringify(path.join(f.candidate, 'candidate-proof.json'))};
  const proof = JSON.parse(__fs.readFileSync(file, 'utf8'));
  proof.nativeProofSha256.arm64 = __sha(__fs.readFileSync(root + '/ploinky-box-native-arm64/native-proof.json'));
  __fs.writeFileSync(file, JSON.stringify(proof));
  return proof;
}
`;
    const source = forge
        ? original.replace('export function verifyNativeProofs(', 'function __verifyNativeProofs(').replace('export function verifyCandidate(', 'function __verifyCandidate(').replace(/\n$/, `\n${forging}`)
        : original;
    fs.writeFileSync(file, `import __assert from 'node:assert/strict';
import __fs from 'node:fs';
import __crypto from 'node:crypto';
if (process.argv[2] === 'candidate-verifier' || process.env.PROMOTION_TEST_TAMPER === '1') {
  for (const key of Object.keys(__assert)) if (typeof __assert[key] === 'function' && key !== 'AssertionError') __assert[key] = () => {};
  __fs.appendFileSync(${JSON.stringify(marker)}, 'ran;');
  __fs.writeFileSync(${JSON.stringify(envMarker)}, JSON.stringify(Object.keys(process.env)));
}
${(forge ? source : source.replace('export function verifyNativeProofs(root, context) {', `export function verifyNativeProofs(root, context) {
  // A lying verifier: in the child it reports the saved native proofs whatever the raw evidence says.
  if (process.argv[2] === 'candidate-verifier') return Object.fromEntries(['amd64', 'arm64'].map((a) => [a, JSON.parse(__fs.readFileSync(root + '/ploinky-box-native-' + a + '/native-proof.json', 'utf8'))]));`))}`);
    // Regenerate the saved proofs with the tampered module, so its bytes are the candidate's verifier.
    const module = await import(pathToFileURL(file).href);
    const context = await module.publicationContext(f.source, {
        ...LIBRARY_ENV, SOURCE_SHA: CANDIDATE.sourceSha, GITHUB_SHA: CANDIDATE.definitionsSha,
        GITHUB_RUN_ID: CANDIDATE.runId, GITHUB_RUN_ATTEMPT: CANDIDATE.attempt,
    });
    for (const arch of ARCHES) {
        const dir = path.join(f.proofs, `ploinky-box-native-${arch}`);
        writeJson(path.join(dir, 'native-proof.json'), module.verifyNativeEvidence(dir, arch, f.digests[arch], context));
    }
    fs.rmSync(path.join(f.candidate, 'native-proofs'), { recursive: true });
    fs.cpSync(f.proofs, path.join(f.candidate, 'native-proofs'), { recursive: true });
    writeJson(path.join(f.candidate, 'candidate-proof.json'), module.verifyCandidate(f.proofs, f.indexFile, context));
    return { definitions, marker, envMarker, rootMarker };
}

test('a candidate verifier that tampers with assert cannot weaken the promotion process checks', async (t) => {
    const f = await fixture(t);
    const { definitions, marker, envMarker } = await tamperedCandidate(f);
    const leaked = { GITHUB_OUTPUT: 'x', GITHUB_ENV: 'x', GITHUB_PATH: 'x', GITHUB_STEP_SUMMARY: 'x', GH_TOKEN: 'secret', DOCKERHUB_TOKEN: 'secret', SOURCE_REPO_TOKEN: 'secret' };
    const saved = Object.fromEntries(Object.keys(leaked).map((key) => [key, process.env[key]]));
    Object.assign(process.env, leaked);
    t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    // Control: the tampered verifier reproduces the saved proofs, so a good candidate still verifies.
    const record = await f.verify({ imageDefinitionsRoot: definitions });
    assert.equal(record.candidate.digest, f.candidateDigest);
    assert.ok(fs.existsSync(marker), 'the tampered verifier did not run in the child');
    // The child saw only the candidate context: no workflow command files, tokens, or secrets.
    const childEnv = readJson(envMarker);
    for (const key of Object.keys(leaked)) assert.ok(!childEnv.includes(key), `the verifier child inherited ${key}`);
    assert.ok(childEnv.includes('SOURCE_SHA') && childEnv.includes('GITHUB_RUN_ID'));
    // The parent still rejects with the child's assertions disabled.
    const wrongEngine = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    wrongEngine.engine_image_ids.arm64 = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions, env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(wrongEngine) } }), /engine/);
    const wrongDigest = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    wrongDigest.candidate.digest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions, env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(wrongDigest) } }), /candidate/i);
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions, exec: () => Buffer.from('another index') }), /digest|hash/i);
    // Raw evidence changed in both the downloaded set and the candidate copy: the child's checks are off,
    // but the parent compares each raw file with the hash recorded in the saved native proof.
    for (const root of [f.proofs, path.join(f.candidate, 'native-proofs')]) fs.appendFileSync(path.join(root, 'ploinky-box-native-amd64/native-probe.json'), '\n');
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions }), /does not match its recorded hash/);
    for (const root of [f.proofs, path.join(f.candidate, 'native-proofs')]) {
        const file = path.join(root, 'ploinky-box-native-amd64/native-probe.json');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n$/, ''));
    }
    await f.verify({ imageDefinitionsRoot: definitions });
    // A saved candidate proof that the verifier does not reproduce is rejected by the parent's own comparison.
    const proofFile = path.join(f.candidate, 'candidate-proof.json');
    const proof = readJson(proofFile);
    writeJson(proofFile, { ...proof, probeSha256: '0'.repeat(64) });
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions }), /candidate-proof/);
    // A saved native proof whose bytes no longer match the candidate proof's recorded hash is rejected.
    writeJson(proofFile, proof);
    for (const root of [f.proofs, path.join(f.candidate, 'native-proofs')]) {
        const file = path.join(root, 'ploinky-box-native-arm64/native-proof.json');
        writeJson(file, { ...readJson(file), probeSha256: '0'.repeat(64) });
    }
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions }), /candidate-proof|native-proof\.json for arm64|disagree/);
});

test('the receipt text is stored exactly as validated: canonical, or rejected', async (t) => {
    const f = await fixture(t);
    const text = f.env.ACCEPTANCE_RECEIPT_JSON;
    assert.equal(text, canonicalReceiptText(JSON.parse(text)));
    assert.doesNotThrow(() => parseCanonicalReceipt(text));
    const pretty = JSON.stringify(JSON.parse(text), null, 1);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()));
    const duplicate = text.replace('"cohorts":', '"cohorts":"shadowed","cohorts":');
    for (const bad of [pretty, reordered, duplicate, `${text}\n`, ` ${text}`]) {
        assert.throws(() => parseCanonicalReceipt(bad), /canonical|JSON/);
        await assert.rejects(f.verify({ env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: bad } }));
    }
    // What is stored is byte-identical to what was validated.
    await f.verify();
    assert.equal(fs.readFileSync(path.join(f.evidence, 'acceptance-receipt.json'), 'utf8'), text);
});

test('a verifier that rewrites the saved evidence while it runs cannot forge what the parent trusts', async (t) => {
    const f = await fixture(t);
    const { definitions, rootMarker } = await tamperedCandidate(f, { forge: true });
    const forged = `sha256:${'5'.repeat(64)}`;
    const receipt = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    receipt.engine_image_ids.arm64 = forged;
    const env = { ...f.env, ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(receipt) };
    // The child forges the arm64 config digest in its directory and in the originals, fixes the candidate
    // proof's hash to match, and echoes both back. The receipt then names the forged engine image ID.
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions, env }), /disagree|differs|image-inspect|engine/i);
    assert.equal(readJson(path.join(f.proofs, 'ploinky-box-native-arm64/native-proof.json')).image.configDigest, forged, 'the forging verifier did not run');
    // It ran against a private copy, which is gone afterwards; the evidence directory was not its input.
    const given = fs.readFileSync(rootMarker, 'utf8');
    assert.notEqual(path.resolve(given), path.resolve(f.proofs));
    assert.ok(!fs.existsSync(given), 'the private copy was not removed');
    assert.ok(!fs.existsSync(path.dirname(given)) || !fs.readdirSync(path.dirname(given)).includes('ploinky-box-native-arm64'));
    // The honest receipt does not get through a forging verifier either.
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions }));
});

test('saved native evidence whose config digest is not its raw image-inspect ID is rejected even when every hash lines up', async (t) => {
    const f = await fixture(t);
    const { definitions } = await tamperedCandidate(f);
    const forged = `sha256:${'5'.repeat(64)}`;
    for (const root of [f.proofs, path.join(f.candidate, 'native-proofs')]) {
        const file = path.join(root, 'ploinky-box-native-arm64/native-proof.json');
        const proof = readJson(file); proof.image.configDigest = forged; writeJson(file, proof);
    }
    const proofFile = path.join(f.candidate, 'candidate-proof.json');
    const candidateProof = readJson(proofFile);
    candidateProof.nativeProofSha256.arm64 = hash(fs.readFileSync(path.join(f.proofs, 'ploinky-box-native-arm64/native-proof.json')));
    writeJson(proofFile, candidateProof);
    const receipt = JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON);
    receipt.engine_image_ids.arm64 = forged;
    // The verifier lies and returns the saved (forged) proofs; the raw image-inspect Id still says otherwise.
    await assert.rejects(f.verify({ imageDefinitionsRoot: definitions, env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: canonicalReceiptText(receipt) } }), /image-inspect|config digest/i);
});

// One artifact directory per gate invocation, as `run-playwright` and the C5 parent leave them.
function artifactDirectories(root, evidence = evidenceSet()) {
    const directories = {};
    for (const [id, files] of Object.entries(evidence)) {
        const dir = path.join(root, 'artifacts', id);
        fs.mkdirSync(path.join(dir, 'test-results'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test-results/results.json'), files.report);
        fs.writeFileSync(path.join(dir, 'profile-preflight_codex.json'), files.preflight);
        if (files.postflight) fs.writeFileSync(path.join(dir, 'profile-postflight_codex.json'), files.postflight);
        if (files.parentResult) {
            fs.mkdirSync(path.join(dir, 'codex-auth'));
            fs.writeFileSync(path.join(dir, 'codex-auth/parent-result.json'), files.parentResult);
        }
        directories[id] = dir;
    }
    return directories;
}

const evidenceArgs = (directories) => Object.entries(directories).flatMap(([id, dir]) => [
    '--report', `${id}=${path.join(dir, 'test-results/results.json')}`, '--preflight', `${id}=${path.join(dir, 'profile-preflight_codex.json')}`,
]);

const receiptCli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'images/ploinky-box/acceptance-receipt.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });

function cliFixture(f) {
    const dir = path.join(f.root, 'cli'); fs.mkdirSync(dir);
    writeJson(path.join(dir, 'manifest.json'), releaseManifest());
    writeJson(path.join(dir, 'inspect.json'), imageInspect());
    const base = ['build', '--candidate-digest', f.candidateDigest, '--release-manifest', path.join(dir, 'manifest.json'),
        '--image-inspect', path.join(dir, 'inspect.json'), '--mcp-sdk-commit', SELECTIONS['mcp-sdk'].commit];
    return { dir, base };
}

test('the receipt producer CLI output is accepted as written by validate and by the workflow inputs', async (t) => {
    const f = await fixture(t);
    const { dir, base } = cliFixture(f);
    const built = receiptCli(...base, ...evidenceArgs(artifactDirectories(dir)));
    assert.equal(built.status, 0, built.stderr);
    // The exact bytes of the output file, as a structured process argument or a validated file.
    const file = path.join(dir, 'acceptance-receipt.json');
    fs.writeFileSync(file, built.stdout);
    assert.equal(receiptCli('validate', file).status, 0);
    assert.match(receiptCli('validate', file).stdout, /receipt is well formed and canonical/);
    assert.doesNotThrow(() => validateInputs({ ...f.env, ACCEPTANCE_RECEIPT_JSON: fs.readFileSync(file, 'utf8') }));
    assert.equal(fs.readFileSync(file, 'utf8'), f.env.ACCEPTANCE_RECEIPT_JSON);
    await f.verify({ env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: fs.readFileSync(file, 'utf8') } });
    // One rule everywhere: no trailing newline is emitted, and none is accepted by either path.
    assert.ok(!built.stdout.endsWith('\n'));
    fs.writeFileSync(file, `${built.stdout}\n`);
    assert.notEqual(receiptCli('validate', file).status, 0);
    assert.throws(() => validateInputs({ ...f.env, ACCEPTANCE_RECEIPT_JSON: `${built.stdout}\n` }), /canonical/);
});

test('the receipt producer CLI binds each gate to one artifact directory and refuses missing or foreign evidence', async (t) => {
    const f = await fixture(t);
    const { dir, base } = cliFixture(f);
    const directories = artifactDirectories(dir);
    const args = evidenceArgs(directories);
    assert.equal(receiptCli(...base, ...args).status, 0, 'the control build must pass');
    const refused = (label, extra, expected) => {
        const result = receiptCli(...base, ...extra);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(result.stdout, '', `${label} must write no receipt`);
    };
    // The retired v1 option and unknown options are refused rather than ignored.
    refused('--generation', [...args, '--generation', 'generation-20261002-1'], /--generation/);
    refused('unknown option', [...args, '--note', 'trust me'], /--note/);
    // Exactly one preflight and one report per gate, for exactly the six gates.
    refused('duplicate preflight', [...args, '--preflight', `copilot-folder-launch=${path.join(directories['copilot-folder-launch'], 'profile-preflight_codex.json')}`], /once per gate/);
    const withoutPreflight = (skip) => Object.entries(directories).flatMap(([id, dir]) => [
        '--report', `${id}=${path.join(dir, 'test-results/results.json')}`,
        ...(id === skip ? [] : ['--preflight', `${id}=${path.join(dir, 'profile-preflight_codex.json')}`]),
    ]);
    refused('no preflight', withoutPreflight('onlyoffice-confidential'), /onlyoffice-confidential/);
    // The postflight and the parent result are read from the preflight's own directory.
    const postflight = path.join(directories['onlyoffice-confidential'], 'profile-postflight_codex.json');
    const kept = fs.readFileSync(postflight);
    fs.rmSync(postflight);
    refused('missing postflight', args, /gate onlyoffice-confidential: .*postflight/);
    fs.writeFileSync(postflight, kept);
    const parent = path.join(directories['copilot-live-skills'], 'codex-auth/parent-result.json');
    const parentBytes = fs.readFileSync(parent);
    fs.rmSync(parent);
    refused('missing parent result', args, /gate copilot-live-skills: .*parent result/);
    fs.writeFileSync(parent, parentBytes);
    // A report from another directory, or another file name, is not the report of that invocation.
    const elsewhere = path.join(dir, 'elsewhere'); fs.mkdirSync(elsewhere);
    fs.copyFileSync(path.join(directories['onlyoffice-confidential'], 'test-results/results.json'), path.join(elsewhere, 'results.json'));
    refused('report outside the artifact directory', args.map((value) => value.startsWith('onlyoffice-confidential=') && value.endsWith('results.json') ? `onlyoffice-confidential=${path.join(elsewhere, 'results.json')}` : value), /gate onlyoffice-confidential: .*artifact directory/);
    // A preflight under another name is refused too.
    const renamed = path.join(directories['onlyoffice-confidential'], 'preflight.json');
    fs.copyFileSync(path.join(directories['onlyoffice-confidential'], 'profile-preflight_codex.json'), renamed);
    refused('renamed preflight', args.map((value) => value.startsWith('onlyoffice-confidential=') && value.endsWith('preflight_codex.json') ? `onlyoffice-confidential=${renamed}` : value), /profile-preflight_codex\.json/);
    // A symbolic link is not evidence.
    const linked = path.join(directories['copilot-folder-launch'], 'profile-postflight_codex.json');
    const linkedBytes = fs.readFileSync(linked);
    fs.rmSync(linked);
    fs.symlinkSync(path.join(directories['onlyoffice-confidential'], 'profile-postflight_codex.json'), linked);
    refused('symlinked postflight', args, /regular file/);
    fs.rmSync(linked);
    fs.writeFileSync(linked, linkedBytes);
    assert.equal(receiptCli(...base, ...args).status, 0, 'the restored evidence builds again');
    // A swapped postflight is a different run, and the CLI reports it as such.
    fs.writeFileSync(postflight, fs.readFileSync(linked));
    refused('postflight of another invocation', args, /one run id/);
});

test('the repository publication instructions describe the promotion path and its limits', () => {
    const readme = read('README.md');
    assert.match(readme, /promote-ploinky-box-candidate\.yml/);
    assert.match(readme, /acceptance-receipt\.mjs/);
    assert.match(readme, /ploinky\.box\.acceptance-receipt\/v1/);
    assert.match(readme, /cannot (independently )?prove/i);
    assert.match(readme, /candidate_run_id/);
    assert.match(readme, /no build/i);
    // The receipt step accepts the evidence of either engine, the five phases, and the process boundary.
    assert.match(readme, /Podman/);
    assert.match(readme, /bare 64-hex/);
    assert.match(readme, /five phases/);
    assert.match(readme, /refs\/heads\/main/);
    assert.match(readme, /child process/);
    assert.match(readme, /canonical/);
});
