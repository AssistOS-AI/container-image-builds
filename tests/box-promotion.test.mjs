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

// --- frozen source inventories and explorer-release-bundle manifests -----------------------------
//
// Workspace W hosts the official and spec 06 cohorts; WO hosts the spec 03 cohort. Their inventories list the
// same sources (the same names, commits and roles) under different roots. Explorer and the other workspace
// checkouts are deployed sources inside the workspace; Ploinky is a deployed source outside it; the sources the
// Box image supplies are provenance references outside it. AchillesCLI is never listed.
const WORKSPACES = {
    W: { root: '/work/W', inventoryPath: '/ev/inventory/W.json' },
    WO: { root: '/work/WO', inventoryPath: '/ev/inventory/WO.json' },
};
// The directory of the sources outside every workspace (Ploinky and the sources the image supplies).
const SOURCE_ROOT = { value: '/src' };
const WORKSPACE_OF = { 'official-release': 'W', 'copilot-live-skills': 'W', 'optional-defaults-and-activation': 'WO' };
const SOURCE_PROVENANCE = ['achillesAgentLib', 'mcp-sdk', 'Ploinky-Worker'];

function inventoryFor(workspace, mutate) {
    const { root } = WORKSPACES[workspace];
    const inside = (name, digit) => [name, { root: `${root}/${name}`, commit: digit.repeat(40), role: 'deployed-source' }];
    const inventory = {
        schemaVersion: 1, kind: 'explorer-source-inventory', roboTeam: { repository: 'explorer', path: 'roboTeamAgent' },
        repositories: Object.fromEntries([
            ['explorer', { root: `${root}/AssistOSExplorer`, commit: '2'.repeat(40), role: 'deployed-source' }],
            inside('copilot-agents', '3'), inside('webmeet', '4'), inside('OnlyOfficeAgent', '5'), inside('UmamiAgent', '6'),
            inside('local-llms', '8'), inside('AdvancedLanguageAgent', 'c'), inside('DocumentationSkills', 'd'),
            ['ploinky', { root: `${SOURCE_ROOT.value}/ploinky`, commit: CANDIDATE.sourceSha, role: 'deployed-source' }],
            ['achillesAgentLib', { root: `${SOURCE_ROOT.value}/achillesAgentLib`, commit: SELECTIONS.achillesAgentLib.commit, role: 'provenance-reference' }],
            ['mcp-sdk', { root: `${SOURCE_ROOT.value}/MCPSDK`, commit: SELECTIONS['mcp-sdk'].commit, role: 'provenance-reference' }],
            ['Ploinky-Worker', { root: `${SOURCE_ROOT.value}/Ploinky-Worker`, commit: 'e'.repeat(40), role: 'provenance-reference' }],
        ]),
    };
    mutate?.(inventory);
    return inventory;
}

const inventoryBytesFor = (workspace, mutate) => Buffer.from(JSON.stringify(inventoryFor(workspace, mutate), null, 2));

// The explorer-release-bundle manifest that pins an inventory file by canonical path and SHA-256.
function manifestFor(inventoryBytes, inventoryPath, digest = ENGINE_ID.arm64) {
    return {
        schemaVersion: 1, kind: 'explorer-release-bundle',
        sourceInventory: { path: inventoryPath, sha256: hash(inventoryBytes) },
        images: { ploinkyBox: { digest } },
    };
}

// The three cohorts' manifest and inventory inputs. `change[cohort]` may hold:
//   inventory(inv)  edits the inventory object before it is hashed, so manifest and bytes agree;
//   raw             replaces the inventory bytes before they are hashed, so manifest and bytes agree;
//   tamper(bytes)   changes the bytes handed to the producer after the manifest pinned the originals;
//   realpath        the canonical path handed to the producer (the manifest keeps the default path);
//   manifest(m)     edits the manifest, or returns a replacement manifest.
function cohortInputsSet(change = {}) {
    return Object.fromEntries(Object.keys(COHORTS).map((cohort) => {
        const workspace = WORKSPACE_OF[cohort];
        const edit = change[cohort] || {};
        const pinned = edit.raw ?? inventoryBytesFor(workspace, edit.inventory);
        const defaultPath = WORKSPACES[workspace].inventoryPath;
        const manifest = manifestFor(pinned, defaultPath);
        return [cohort, {
            manifest: edit.manifest?.(manifest) ?? manifest,
            inventoryBytes: edit.tamper ? edit.tamper(pinned) : pinned,
            inventoryRealpath: edit.realpath ?? defaultPath,
        }];
    }));
}

// The CLI refuses an inventory root that is not its canonical real path, so CLI tests need real directories. This points
// the fixtures at real, canonical roots under `directory` (the workspace roots, every repository and the outside sources),
// and restores the fake roots when the test ends. Tests of one file run one after the other.
function useRealRoots(t, directory) {
    const saved = { W: WORKSPACES.W.root, WO: WORKSPACES.WO.root, source: SOURCE_ROOT.value };
    WORKSPACES.W.root = path.join(directory, 'work/W');
    WORKSPACES.WO.root = path.join(directory, 'work/WO');
    SOURCE_ROOT.value = path.join(directory, 'src');
    t.after(() => { WORKSPACES.W.root = saved.W; WORKSPACES.WO.root = saved.WO; SOURCE_ROOT.value = saved.source; });
    for (const workspace of Object.keys(WORKSPACES)) {
        fs.mkdirSync(WORKSPACES[workspace].root, { recursive: true });
        for (const entry of Object.values(inventoryFor(workspace).repositories)) fs.mkdirSync(entry.root, { recursive: true });
    }
}

// The preflight and postflight source keys for an inventory that `mutate` edited (for cohorts built on that inventory).
function sourceEvidenceForInventory(workspace, mutate) {
    const inventory = inventoryFor(workspace, mutate);
    return {
        releaseBundle: { schemaVersion: 1, kind: 'explorer-release-bundle', sourceInventorySha256: hash(Buffer.from(JSON.stringify(inventory, null, 2))) },
        repositories: Object.fromEntries(Object.entries(inventory.repositories).map(([name, entry]) => [name,
            { name, repositoryPath: entry.root, commit: entry.commit, role: entry.role }])),
    };
}

// What the runner's verifier returns for a cohort's inventory and what both preflight and postflight record.
function sourceEvidenceFor(gateId) {
    const workspace = WORKSPACE_OF[COHORT_OF[gateId]];
    const inventory = inventoryFor(workspace);
    return {
        releaseBundle: { schemaVersion: 1, kind: 'explorer-release-bundle', sourceInventorySha256: hash(inventoryBytesFor(workspace)) },
        repositories: Object.fromEntries(Object.entries(inventory.repositories).map(([name, entry]) => [name,
            { name, repositoryPath: entry.root, commit: entry.commit, role: entry.role, ...(name === 'webmeet' ? { ignored: true } : {}) }])),
        workspaceSourceMount: { source: WORKSPACES[workspace].root },
    };
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
        ...sourceEvidenceFor(gateId),
        runId: runIdOf(gateId), spec: GATE_SELECTIONS[gateId].spec, grep: 'ignored by the receipt', capturedAt: iso(startOf(gateId) - 5000),
    };
    mutate?.(preflight);
    return Buffer.from(JSON.stringify(preflight, null, 2));
}

function postflightFor(gateId, mutate) {
    const { releaseBundle, repositories } = sourceEvidenceFor(gateId);
    const postflight = { runId: runIdOf(gateId), box: boxIdentity(gateId), releaseBundle, repositories, capturedAt: iso(endOf(gateId) + 2000), exitCode: 0 };
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

const imageInspect = (architecture = 'arm64') => [{ Id: ENGINE_ID[architecture], Os: 'linux', Architecture: architecture }];

const receiptInputs = (change = {}) => ({
    candidateDigest: `sha256:${'1'.repeat(64)}`, cohortInputs: cohortInputsSet(), imageInspect: imageInspect(),
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
    // The verification record is schema v2: it records the receipt's hash and its observed cohorts, not a typed generation.
    assert.equal(record.schema, 'ploinky.box.promotion-verification/v2');
    assert.deepEqual(record.receipt, { sha256: hash(f.env.ACCEPTANCE_RECEIPT_JSON), cohorts: JSON.parse(f.env.ACCEPTANCE_RECEIPT_JSON).cohorts });
    assert.deepEqual(Object.keys(record.receipt.cohorts).sort(), ['copilot-live-skills', 'official-release', 'optional-defaults-and-activation']);
    assert.equal(readJson(path.join(f.evidence, 'promotion-verification.json')).schema, 'ploinky.box.promotion-verification/v2');
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

test('the receipt producer builds the bounded data-only v2 receipt from reports, preflights, postflights, manifests, source inventories, and image evidence', async (t) => {
    const f = await fixture(t);
    const receipt = receiptFor(f.candidateDigest);
    assert.equal(RECEIPT_SCHEMA, 'ploinky.box.acceptance-receipt/v2');
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.deepEqual(Object.keys(receipt).sort(), ['candidate', 'cohorts', 'engine_image_ids', 'gates', 'revisions', 'schema', 'sources']);
    assert.equal(canonicalReceiptText(receipt), canonicalReceiptText(JSON.parse(canonicalReceiptText(receipt))));
    assert.doesNotThrow(() => parseCanonicalReceipt(canonicalReceiptText(receipt)));
    assert.deepEqual(receipt.candidate, { digest: f.candidateDigest });
    // No revision is typed: the three revisions are the commits of their inventoried sources.
    assert.deepEqual(receipt.revisions, {
        achilles_agent_lib: SELECTIONS.achillesAgentLib.commit, mcp_sdk_commit: SELECTIONS['mcp-sdk'].commit, ploinky: CANDIDATE.sourceSha,
    });
    // `sources` is the complete root-free map of the inventory: eleven entries, no root, no AchillesCLI.
    assert.deepEqual(Object.keys(receipt.sources).sort(), Object.keys(inventoryFor('W').repositories).sort());
    assert.equal(Object.keys(receipt.sources).length, 12);
    assert.deepEqual(receipt.sources.ploinky, { commit: CANDIDATE.sourceSha, role: 'deployed-source' });
    assert.deepEqual(receipt.sources.explorer, { commit: '2'.repeat(40), role: 'deployed-source' });
    for (const name of SOURCE_PROVENANCE) assert.equal(receipt.sources[name].role, 'provenance-reference', name);
    for (const entry of Object.values(receipt.sources)) assert.deepEqual(Object.keys(entry).sort(), ['commit', 'role']);
    assert.ok(!/\/work\/|\/src\/|achilles-?cli/i.test(canonicalReceiptText(receipt)), 'the receipt holds no root and no AchillesCLI source');
    assert.deepEqual(receipt.engine_image_ids, { arm64: ENGINE_ID.arm64 });
    // Three cohorts named like the acceptance ledger, with the Box generation observed in the preflights.
    // Each cohort also records the SHA-256 of the frozen inventory it ran against (W for the official and spec 06 cohorts, WO for spec 03).
    assert.deepEqual(receipt.cohorts, Object.fromEntries(Object.entries(COHORTS).map(([id, c]) => [id, {
        container_id: c.containerId, started_at: c.startedAt, source_inventory_sha256: hash(inventoryBytesFor(WORKSPACE_OF[id])),
    }])));
    assert.notEqual(receipt.cohorts['official-release'].source_inventory_sha256, receipt.cohorts['optional-defaults-and-activation'].source_inventory_sha256);
    assert.equal(receipt.cohorts['official-release'].source_inventory_sha256, receipt.cohorts['copilot-live-skills'].source_inventory_sha256);
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
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, cohortInputs: cohortInputsSet(), gates: evidenceSet() };
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
            candidateDigest: `sha256:${'1'.repeat(64)}`, cohortInputs: cohortInputsSet(), imageInspect: imageInspect(),
            gates: { ...evidenceSet(), [id]: gateEvidence(id, { report: mutate }) },
        }), label);
    }
    assert.throws(() => summarizePlaywrightReport(Buffer.from('{'), id));
    // A report for another gate's selection cannot stand in for this gate.
    assert.throws(() => summarizePlaywrightReport(playwrightReport('webmeet-room-chat'), id));
    const gates = evidenceSet();
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, cohortInputs: cohortInputsSet(), imageInspect: imageInspect() };
    for (const gate of SIX_GATES) {
        const { [gate]: _omitted, ...rest } = gates;
        assert.throws(() => buildAcceptanceReceipt({ ...base, gates: rest }), new RegExp(gate));
    }
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: { ...gates, 'copilot-folder-launch': gates['webmeet-room-chat'] } }));
    assert.throws(() => buildAcceptanceReceipt({ ...base, gates: { ...gates, unknown: gates['webmeet-room-chat'] } }));
});

test('all six gates are required; the prerequisite phases may hold several passed tests', () => {
    const base = { candidateDigest: `sha256:${'1'.repeat(64)}`, cohortInputs: cohortInputsSet(), imageInspect: imageInspect() };
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

test('the producer rejects a manifest, image evidence, or retired input that does not fit together', () => {
    const base = receiptInputs({ candidateDigest: `sha256:${'1'.repeat(64)}` });
    assert.doesNotThrow(() => buildAcceptanceReceipt(base));
    const withoutSpec06 = Object.fromEntries(Object.entries(cohortInputsSet()).filter(([cohort]) => cohort !== 'copilot-live-skills'));
    for (const [label, change, expected] of [
        ['a manifest digest that is not the engine image', { cohortInputs: cohortInputsSet({ 'official-release': { manifest: (m) => { m.images.ploinkyBox.digest = `sha256:${'0'.repeat(64)}`; } } }) }, /cohort official-release: the engine image ID differs from the release manifest Box digest/],
        ['an extra image in a manifest', { cohortInputs: cohortInputsSet({ 'optional-defaults-and-activation': { manifest: (m) => { m.images.other = { digest: 'x' }; } } }) }, /cohort optional-defaults-and-activation: release manifest images must contain exactly ploinkyBox/],
        ['an extra manifest key', { cohortInputs: cohortInputsSet({ 'copilot-live-skills': { manifest: (m) => { m.extra = 1; } } }) }, /cohort copilot-live-skills: release manifest must contain exactly images, kind, schemaVersion, sourceInventory/],
        ['no cohort inputs', { cohortInputs: {} }, /cohort official-release: the release manifest and the source inventory are required/],
        ['null cohort inputs', { cohortInputs: null }, /cohort manifests and source inventories are required/],
        ['a cohort without inputs', { cohortInputs: withoutSpec06 }, /cohort copilot-live-skills: the release manifest and the source inventory are required/],
        ['an unknown cohort', { cohortInputs: { ...cohortInputsSet(), 'another-cohort': cohortInputsSet()['official-release'] } }, /unknown cohort another-cohort/],
        ['no image evidence', { imageInspect: [] }, /image evidence must hold exactly one image/],
        ['two images', { imageInspect: [...imageInspect(), ...imageInspect()] }, /image evidence must hold exactly one image/],
        ['an unsupported architecture', { imageInspect: [{ ...imageInspect()[0], Architecture: 's390x' }] }, /the engine image has an unsupported architecture/],
        ['a windows image', { imageInspect: [{ ...imageInspect()[0], Os: 'windows' }] }, /the engine image is not a linux image/],
        ['an image ID that is not a digest', { imageInspect: [{ ...imageInspect()[0], Id: 'latest' }] }, /the engine image ID must be a sha256 image ID/],
        ['no gate evidence', { gates: null }, /gate evidence is required/],
        ['empty gate evidence', { gates: {} }, /required gate copilot-folder-launch has no evidence/],
        ['a tag as the candidate', { candidateDigest: 'latest' }, /the candidate must be an immutable sha256 digest, not a tag/],
        ['a tagged reference as the candidate', { candidateDigest: `${IMAGE}:latest` }, /the candidate must be an immutable sha256 digest, not a tag/],
    ]) {
        assert.throws(() => buildAcceptanceReceipt({ ...base, ...change }), expected, label);
    }
    // The inputs of earlier receipt versions are retired: a typed commit, a single manifest, a generation or loose reports.
    for (const retired of [{ mcpSdkCommit: SELECTIONS['mcp-sdk'].commit }, { releaseManifest: {} }, { generation: 'g1' }, { reports: reportSet() }]) {
        assert.throws(() => buildAcceptanceReceipt({ ...base, ...retired }), new RegExp(`does not take ${Object.keys(retired)[0]}`), JSON.stringify(Object.keys(retired)));
    }
});

// --- frozen source inventory (receipt amendment) ----------------------------------------------

const buildWithInputs = (change) => buildAcceptanceReceipt(receiptInputs({ cohortInputs: cohortInputsSet(change) }));
const officialCohort = (edit) => ({ 'official-release': edit });
const everyCohort = (edit) => Object.fromEntries(Object.keys(COHORTS).map((cohort) => [cohort, edit]));
const legacy421Manifest = () => ({
    repositories: {
        achillesAgentLib: { commit: SELECTIONS.achillesAgentLib.commit }, ploinky: { commit: CANDIDATE.sourceSha },
        achillesCLI: { commit: '1'.repeat(40) }, explorer: { commit: '2'.repeat(40) },
    },
    images: { ploinkyBox: { digest: ENGINE_ID.arm64 } },
});

test('(k) the release manifest of every cohort is an explorer-release-bundle manifest whose digest is the engine image', () => {
    // Control: the explorer-release-bundle manifests build.
    assert.doesNotThrow(() => buildWithInputs({}));
    const refused = {
        'a 421-shape manifest': [() => buildWithInputs(officialCohort({ manifest: legacy421Manifest })), /versionless legacy release manifest is not accepted/],
        'a 421-shape manifest in the optional cohort': [() => buildWithInputs({ 'optional-defaults-and-activation': { manifest: legacy421Manifest } }), /cohort optional-defaults-and-activation: a versionless legacy release manifest/],
        'schemaVersion 2': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.schemaVersion = 2; } })), /unsupported release manifest schemaVersion/],
        'schemaVersion as text': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.schemaVersion = '1'; } })), /unsupported release manifest schemaVersion/],
        'another kind': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.kind = 'copilot-421-bundle'; } })), /release manifest kind must be explorer-release-bundle/],
        'an extra manifest key': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.extra = 1; } })), /release manifest must contain exactly images, kind, schemaVersion, sourceInventory/],
        'an extra sourceInventory key': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.sourceInventory.note = 'x'; } })), /release manifest sourceInventory must contain exactly path, sha256/],
        'a relative inventory path': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.sourceInventory.path = 'inventory/W.json'; } })), /source inventory path must be an absolute, normalized path/],
        'a non-normalized inventory path': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.sourceInventory.path = '/ev/inventory/../inventory/W.json'; } })), /source inventory path must be an absolute, normalized path/],
        'an uppercase inventory hash': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.sourceInventory.sha256 = 'A'.repeat(64); } })), /source inventory sha256 must be a lowercase 64-hex SHA-256/],
        'an image digest that is not the engine image': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.images.ploinkyBox.digest = ENGINE_ID.amd64; } })), /the engine image ID differs from the release manifest Box digest/],
        'a mutable image reference': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.images.ploinkyBox.digest = 'latest'; } })), /release manifest image digest must be an immutable sha256 digest/],
        'an extra image': [() => buildWithInputs(officialCohort({ manifest: (m) => { m.images.other = { digest: ENGINE_ID.arm64 }; } })), /release manifest images must contain exactly ploinkyBox/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(l) the inventory is the file its manifest pins, by SHA-256 and by canonical path', () => {
    assert.doesNotThrow(() => buildWithInputs({}));
    const refused = {
        'bytes that differ from the pinned hash': [() => buildWithInputs(officialCohort({ tamper: (bytes) => Buffer.concat([bytes, Buffer.from('\n')]) })), /cohort official-release: the source inventory bytes do not match the release manifest sourceInventory\.sha256/],
        'one changed character': [() => buildWithInputs(officialCohort({ tamper: (bytes) => Buffer.from(bytes.toString('utf8').replace('"explorer"', '"explorex"')) })), /bytes do not match the release manifest sourceInventory\.sha256/],
        'bytes that differ in the optional cohort': [() => buildWithInputs({ 'optional-defaults-and-activation': { tamper: (bytes) => Buffer.concat([bytes, Buffer.from(' ')]) } }), /cohort optional-defaults-and-activation: the source inventory bytes do not match/],
        'a canonical path that differs from the pinned path': [() => buildWithInputs(officialCohort({ realpath: '/ev/inventory/other.json' })), /cohort official-release: the source inventory path differs from the release manifest sourceInventory\.path/],
        'a path that is only a spelling of the pinned path': [() => buildWithInputs(officialCohort({ realpath: '/ev/inventory//W.json' })), /the source inventory path differs from the release manifest sourceInventory\.path/],
        'an inventory that is not JSON': [() => buildWithInputs(officialCohort({ raw: Buffer.from('not json') })), /the source inventory is not JSON/],
        'an empty inventory': [() => buildWithInputs(officialCohort({ raw: Buffer.alloc(0) })), /the source inventory is required/],
        'an oversized inventory': [() => buildWithInputs(officialCohort({ raw: Buffer.alloc(1024 * 1024 + 1, 0x20) })), /the source inventory is required/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(m) an inventory naming AchillesCLI under any spelling is refused, and a lookalike is not mistaken for it', () => {
    const named = (name) => ({ inventory: (inventory) => { inventory.repositories[name] = { root: '/work/W/cli-checkout', commit: 'f'.repeat(40), role: 'deployed-source' }; } });
    for (const name of ['AchillesCLI', 'achillesCLI', 'achilles-cli', 'Achilles_CLI', 'ACHILLES.CLI']) {
        assert.throws(() => buildWithInputs(officialCohort(named(name))), /source inventory must not name an AchillesCLI repository; RoboTeam is owned by explorer\/roboTeamAgent/, name);
    }
    // AchillesIDE is another repository: it passes the inventory rules in every cohort and is refused later, because
    // the preflights were captured against the inventory without it.
    assert.throws(() => buildWithInputs(everyCohort(named('AchillesIDE'))),
        (error) => !/AchillesCLI/.test(error.message) && /releaseBundle\.sourceInventorySha256 differs from its cohort's source inventory/.test(error.message));
});

test('the inventory passes the strict rules of the release verifier, and the sources the image supplies are provenance references', () => {
    assert.doesNotThrow(() => buildWithInputs({}));
    const edit = (change) => officialCohort({ inventory: change });
    const refused = {
        'a missing explorer': [(inv) => { delete inv.repositories.explorer; }, /source inventory must include the core repository explorer/],
        'a missing ploinky': [(inv) => { delete inv.repositories.ploinky; }, /source inventory must include the core repository ploinky/],
        'a missing achillesAgentLib': [(inv) => { delete inv.repositories.achillesAgentLib; }, /source inventory must include the core repository achillesAgentLib/],
        'ploinky as a provenance reference': [(inv) => { inv.repositories.ploinky.role = 'provenance-reference'; }, /ploinky must be a deployed-source/],
        'explorer as a provenance reference': [(inv) => { inv.repositories.explorer.role = 'provenance-reference'; }, /explorer must be a deployed-source/],
        'achillesAgentLib as a deployed source': [(inv) => { inv.repositories.achillesAgentLib.role = 'deployed-source'; }, /achillesAgentLib must be a provenance-reference/],
        'a missing mcp-sdk': [(inv) => { delete inv.repositories['mcp-sdk']; }, /source inventory must include mcp-sdk/],
        'mcp-sdk as a deployed source': [(inv) => { inv.repositories['mcp-sdk'].role = 'deployed-source'; }, /mcp-sdk must be a provenance-reference/],
        'a missing Ploinky-Worker': [(inv) => { delete inv.repositories['Ploinky-Worker']; }, /source inventory must include Ploinky-Worker/],
        'Ploinky-Worker as a deployed source': [(inv) => { inv.repositories['Ploinky-Worker'].role = 'deployed-source'; }, /Ploinky-Worker must be a provenance-reference/],
        'a repeated root': [(inv) => { inv.repositories.webmeet.root = inv.repositories.UmamiAgent.root; }, /source inventory repeats the root of webmeet/],
        'a relative root': [(inv) => { inv.repositories.webmeet.root = 'work/W/webmeet'; }, /webmeet root must be an absolute, normalized path/],
        'a non-normalized root': [(inv) => { inv.repositories.webmeet.root = '/work/W/./webmeet'; }, /webmeet root must be an absolute, normalized path/],
        'a short commit': [(inv) => { inv.repositories.webmeet.commit = 'abc123'; }, /webmeet commit must be an exact lowercase 40-hex commit/],
        'an uppercase commit': [(inv) => { inv.repositories.webmeet.commit = 'A'.repeat(40); }, /webmeet commit must be an exact lowercase 40-hex commit/],
        'a symbolic commit': [(inv) => { inv.repositories.webmeet.commit = 'main'; }, /webmeet commit must be an exact lowercase 40-hex commit/],
        'an unknown role': [(inv) => { inv.repositories.webmeet.role = 'mirror'; }, /webmeet role must be one of deployed-source, provenance-reference/],
        'an extra entry key': [(inv) => { inv.repositories.webmeet.note = 'x'; }, /source inventory repository webmeet must contain exactly commit, role, root/],
        'a missing entry key': [(inv) => { delete inv.repositories.webmeet.root; }, /source inventory repository webmeet must contain exactly commit, role, root/],
        'a repository name that is not an identity': [(inv) => { inv.repositories['-bad'] = { root: '/work/W/bad', commit: 'f'.repeat(40), role: 'deployed-source' }; }, /is not a valid identity/],
        'a RoboTeam owner that is not explorer/roboTeamAgent': [(inv) => { inv.roboTeam.repository = 'roboTeamAgent'; }, /RoboTeam is owned by explorer\/roboTeamAgent/],
        'an extra inventory key': [(inv) => { inv.note = 'x'; }, /source inventory must contain exactly kind, repositories, roboTeam, schemaVersion/],
        'schemaVersion 2': [(inv) => { inv.schemaVersion = 2; }, /unsupported source inventory schemaVersion/],
        'another kind': [(inv) => { inv.kind = 'explorer-release-bundle'; }, /source inventory kind must be explorer-source-inventory/],
        'more than 64 repositories': [(inv) => { for (let i = 0; i < 53; i += 1) inv.repositories[`extra-${i}`] = { root: `/work/W/extra-${i}`, commit: 'f'.repeat(40), role: 'deployed-source' }; }, /source inventory exceeds 64 repositories/],
    };
    for (const [label, [change, expected]] of Object.entries(refused)) assert.throws(() => buildWithInputs(edit(change)), expected, label);
});

test('(n) a preflight lists exactly the repositories of its cohort inventory', () => {
    const id = 'onlyoffice-confidential';
    assert.doesNotThrow(() => buildWith(id, {}));
    const extra = { name: 'extra', repositoryPath: '/work/W/extra', commit: 'f'.repeat(40), role: 'deployed-source' };
    const refused = {
        'a changed commit': [() => buildWith(id, { preflight: (p) => { p.repositories.webmeet.commit = '1'.repeat(40); } }), /the preflight repository webmeet commit differs from the source inventory/],
        'a changed role': [() => buildWith(id, { preflight: (p) => { p.repositories.webmeet.role = 'provenance-reference'; } }), /the preflight repository webmeet role differs from the source inventory/],
        'a changed path': [() => buildWith(id, { preflight: (p) => { p.repositories.webmeet.repositoryPath = '/work/W/elsewhere'; } }), /the preflight repository webmeet path differs from the source inventory root/],
        'a name that is not its key': [() => buildWith(id, { preflight: (p) => { p.repositories.webmeet.name = 'webmeet-2'; } }), /the preflight repository webmeet names another repository/],
        'an extra entry': [() => buildWith(id, { preflight: (p) => { p.repositories.extra = extra; } }), /the preflight repositories hold extra, which the source inventory does not list/],
        'an extra AchillesCLI entry': [() => buildWith(id, { preflight: (p) => { p.repositories.achillesCLI = { ...extra, name: 'achillesCLI' }; } }), /hold achillesCLI, which the source inventory does not list/],
        'a missing entry': [() => buildWith(id, { preflight: (p) => { delete p.repositories['copilot-agents']; } }), /the preflight repositories lack copilot-agents, which the source inventory lists/],
        'an entry that is not an object': [() => buildWith(id, { preflight: (p) => { p.repositories.webmeet = 'webmeet'; } }), /the preflight repositories lack webmeet/],
        'a list instead of a map': [() => buildWith(id, { preflight: (p) => { p.repositories = []; } }), /the preflight has no repositories/],
        'the other workspace\'s map': [() => buildWith('optional-agents', { preflight: (p) => { p.repositories = sourceEvidenceFor(id).repositories; } }), /the preflight repository .* path differs from the source inventory root/],
        // The postflight repeats what the preflight observed.
        'a postflight commit that changed': [() => buildWith(id, { postflight: (p) => { p.repositories.webmeet.commit = '1'.repeat(40); } }), /the postflight repositories differ from the preflight/],
        'a postflight entry that was added': [() => buildWith(id, { postflight: (p) => { p.repositories.extra = extra; } }), /the postflight repositories differ from the preflight/],
        'a postflight entry that was removed': [() => buildWith(id, { postflight: (p) => { delete p.repositories.UmamiAgent; } }), /the postflight repositories differ from the preflight/],
        'a postflight without repositories': [() => buildWith(id, { postflight: (p) => { delete p.repositories; } }), /the postflight has no repositories/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(o) the release bundle hash of a preflight and a postflight is the hash of its cohort inventory', () => {
    const id = 'onlyoffice-confidential';
    assert.doesNotThrow(() => buildWith(id, {}));
    const other = 'f'.repeat(64);
    const refused = {
        'a preflight hash that differs': [() => buildWith(id, { preflight: (p) => { p.releaseBundle.sourceInventorySha256 = other; } }), /the preflight releaseBundle\.sourceInventorySha256 differs from its cohort's source inventory/],
        'a preflight without a release bundle': [() => buildWith(id, { preflight: (p) => { delete p.releaseBundle; } }), /the preflight has no releaseBundle/],
        'the hash of the other workspace': [() => buildWith('optional-agents', { preflight: (p) => { p.releaseBundle.sourceInventorySha256 = hash(inventoryBytesFor('W')); } }), /the preflight releaseBundle\.sourceInventorySha256 differs from its cohort's source inventory/],
        'a postflight hash that differs': [() => buildWith(id, { postflight: (p) => { p.releaseBundle.sourceInventorySha256 = other; } }), /the postflight releaseBundle\.sourceInventorySha256 differs from its cohort's source inventory/],
        'a postflight without a release bundle': [() => buildWith(id, { postflight: (p) => { delete p.releaseBundle; } }), /the postflight has no releaseBundle/],
        'a postflight release bundle of another kind': [() => buildWith(id, { postflight: (p) => { p.releaseBundle.kind = 'other'; } }), /the postflight releaseBundle differs from the preflight/],
        'a postflight release bundle with an extra key': [() => buildWith(id, { postflight: (p) => { p.releaseBundle.extra = true; } }), /the postflight releaseBundle differs from the preflight/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(p) the roles of the sources fix where they lie: deployed sources under the workspace mount, references outside it', () => {
    const id = 'onlyoffice-confidential';
    const refused = {
        'a mount that holds no deployed source': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/work/other'; } }), /deployed-source AdvancedLanguageAgent is not under the workspace source mount/],
        'the sibling workspace as the mount': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/work/WO'; } }), /deployed-source .* is not under the workspace source mount/],
        'a mount that holds a provenance reference': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/'; } }), /provenance-reference Ploinky-Worker is inside the workspace source mount/],
        'a mount that holds only the sources outside the workspace': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/src'; } }), /deployed-source .* is not under the workspace source mount/],
        'a preflight without a mount': [() => buildWith(id, { preflight: (p) => { delete p.workspaceSourceMount; } }), /the preflight has no workspaceSourceMount\.source/],
        'a relative mount': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = 'work/W'; } }), /the preflight has no workspaceSourceMount\.source/],
        'a mount equal to a deployed source': [() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/work/W/webmeet'; } }), /deployed-source .* is not under the workspace source mount/],
    };
    // Control: the default mount (W for the official and spec 06 cohorts, WO for spec 03) builds, and Ploinky lies outside both.
    assert.doesNotThrow(() => buildWith(id, {}));
    assert.doesNotThrow(() => buildWith('optional-agents', {}));
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(p) source locations compare whole path components: a sibling that only shares a prefix is not under the mount', () => {
    const id = 'optional-agents';
    // Control: the spec 03 cohort runs in WO, whose deployed sources lie under /work/WO.
    assert.doesNotThrow(() => buildWith(id, {}));
    // /work/WO/... starts with the text /work/W but is not under /work/W.
    assert.throws(() => buildWith(id, { preflight: (p) => { p.workspaceSourceMount.source = '/work/W'; } }), /deployed-source .* is not under the workspace source mount/);
    // The same with inventories that were edited, with their evidence, so only the location rule can refuse them.
    const buildOptional = (edit) => {
        const evidence = sourceEvidenceForInventory('WO', edit);
        const repeat = (p) => { p.releaseBundle = structuredClone(evidence.releaseBundle); p.repositories = structuredClone(evidence.repositories); };
        const receipt = buildAcceptanceReceipt(receiptInputs({
            cohortInputs: cohortInputsSet({ 'optional-defaults-and-activation': { inventory: edit } }),
            gates: { ...evidenceSet(), [id]: gateEvidence(id, { preflight: repeat, postflight: repeat }) },
        }));
        assert.equal(receipt.cohorts['optional-defaults-and-activation'].source_inventory_sha256, evidence.releaseBundle.sourceInventorySha256);
        return receipt;
    };
    // A provenance reference in /work/WOx is outside /work/WO even though its path starts with the mount's text.
    assert.doesNotThrow(() => buildOptional((inv) => { inv.repositories['Ploinky-Worker'].root = '/work/WOx/Ploinky-Worker'; }));
    // A deployed source in /work/WOx is not under /work/WO.
    assert.throws(() => buildOptional((inv) => { inv.repositories.webmeet.root = '/work/WOx/webmeet'; }), /deployed-source webmeet is not under the workspace source mount/);
    // A provenance reference below the mount is refused, and so is one that is the mount itself.
    assert.throws(() => buildOptional((inv) => { inv.repositories['Ploinky-Worker'].root = '/work/WO/Ploinky-Worker'; }), /provenance-reference Ploinky-Worker is inside the workspace source mount/);
    assert.throws(() => buildOptional((inv) => { inv.repositories['Ploinky-Worker'].root = '/work/WO'; }), /provenance-reference Ploinky-Worker is inside the workspace source mount/);
    // A deployed source that is the mount itself is not under it.
    assert.throws(() => buildOptional((inv) => { inv.repositories.webmeet.root = '/work/WO'; }), /deployed-source webmeet is not under the workspace source mount/);
});

test('(q) the three cohorts list the same sources, though their roots may differ', () => {
    // Control: W and WO have different roots and different inventory hashes, and build.
    const receipt = buildWithInputs({});
    assert.notEqual(receipt.cohorts['official-release'].source_inventory_sha256, receipt.cohorts['optional-defaults-and-activation'].source_inventory_sha256);
    const optional = (inventory) => ({ 'optional-defaults-and-activation': { inventory } });
    const different = /cohorts official-release and optional-defaults-and-activation list different sources/;
    const refused = {
        'a commit that differs': [() => buildWithInputs(optional((inv) => { inv.repositories.webmeet.commit = '1'.repeat(40); })), different],
        'a role that differs': [() => buildWithInputs(optional((inv) => { inv.repositories.webmeet.role = 'provenance-reference'; })), different],
        'a source that is missing': [() => buildWithInputs(optional((inv) => { delete inv.repositories.webmeet; })), different],
        'a source that is added': [() => buildWithInputs(optional((inv) => { inv.repositories.AchillesIDE = { root: '/work/WO/AchillesIDE', commit: 'f'.repeat(40), role: 'deployed-source' }; })), different],
        'the spec 06 cohort differing from the official one': [() => buildWithInputs({ 'copilot-live-skills': { inventory: (inv) => { delete inv.repositories['local-llms']; } } }), /cohorts official-release and copilot-live-skills list different sources/],
    };
    for (const [label, [attempt, expected]] of Object.entries(refused)) assert.throws(attempt, expected, label);
});

test('(r) no revision is typed: the retired inputs are refused by the producer and by the CLI', async (t) => {
    const base = receiptInputs();
    assert.throws(() => buildAcceptanceReceipt({ ...base, mcpSdkCommit: SELECTIONS['mcp-sdk'].commit }), /does not take mcpSdkCommit: every commit comes from the hash-pinned source inventory/);
    assert.throws(() => buildAcceptanceReceipt({ ...base, releaseManifest: {} }), /does not take releaseManifest/);
    const f = await fixture(t);
    const { dir, base: cliBase } = cliFixture(f, t);
    const args = evidenceArgs(artifactDirectories(dir));
    const control = receiptCli(...cliBase, ...args);
    assert.equal(control.status, 0, control.stderr);
    const typed = receiptCli(...cliBase, ...args, '--mcp-sdk-commit', SELECTIONS['mcp-sdk'].commit);
    assert.notEqual(typed.status, 0);
    assert.match(typed.stderr, /--mcp-sdk-commit was removed in receipt v2: every revision comes from the hash-pinned source inventory/);
    assert.equal(typed.stdout, '');
});

test('(s) revisions are derived from sources, and the producer holds no AchillesCLI revision', () => {
    const receipt = buildAcceptanceReceipt(receiptInputs());
    assert.doesNotThrow(() => validateAcceptanceReceipt(receipt));
    for (const [key, name] of [['ploinky', 'ploinky'], ['achilles_agent_lib', 'achillesAgentLib'], ['mcp_sdk_commit', 'mcp-sdk']]) {
        assert.equal(receipt.revisions[key], receipt.sources[name].commit, key);
        const forged = structuredClone(receipt);
        forged.revisions[key] = 'd'.repeat(40);
        assert.throws(() => validateAcceptanceReceipt(forged), new RegExp(`receipt revision ${key} differs from its sources entry ${name}`), key);
        assert.throws(() => parseCanonicalReceipt(canonicalReceiptText(forged)), new RegExp(`receipt revision ${key} differs`), key);
    }
    // The producer source names no AchillesCLI revision (the static form of `! rg -q achilles_cli images/ploinky-box/acceptance-receipt.mjs`).
    assert.ok(!read('images/ploinky-box/acceptance-receipt.mjs').includes('achilles_cli'));
    assert.deepEqual(Object.keys(receipt.revisions).sort(), ['achilles_agent_lib', 'mcp_sdk_commit', 'ploinky']);
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
        'missing postflight': [() => withGate(id, (g) => { delete g.postflight; }), { message: `gate ${id}: the postflight (profile-postflight_codex.json) is required` }],
        'missing preflight': [() => withGate(id, (g) => { delete g.preflight; }), { message: `gate ${id}: the preflight (profile-preflight_codex.json) is required` }],
        'missing report': [() => withGate(id, (g) => { delete g.report; }), { message: `gate ${id}: the report is required` }],
        'postflight set to null': [() => withGate(id, (g) => { g.postflight = null; }), { message: `gate ${id}: the postflight (profile-postflight_codex.json) is required` }],
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
        'preflight explorer commit differs from the inventory': [() => buildWith(id, { preflight: (p) => { p.repositories.explorer.commit = '5'.repeat(40); } }), /repository explorer commit differs from the source inventory/],
        'preflight ploinky commit differs from the inventory': [() => buildWith(id, { preflight: (p) => { p.repositories.ploinky.commit = '5'.repeat(40); } }), /repository ploinky commit differs from the source inventory/],
        'preflight agentlib commit differs from the inventory': [() => buildWith(id, { preflight: (p) => { p.repositories.achillesAgentLib.commit = '5'.repeat(40); } }), /repository achillesAgentLib commit differs from the source inventory/],
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
        'missing parent result': [() => withGate(id, (g) => { delete g.parentResult; }), { message: `gate ${id}: the parent result (codex-auth/parent-result.json) is required` }],
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
        'one cleanup key deleted': [() => buildWith(id, { parent: (p) => { delete p.cleanup.linksRemoved; } }), /cleanup must hold exactly the flags credentialPersisted, credentialRemoved, linksRemoved, sourceUnregistered, robotDeleted, folderDeleted, all true/],
        'one extra cleanup key': [() => buildWith(id, { parent: (p) => { p.cleanup.extraFlag = true; } }), /cleanup must hold exactly the flags/],
        'one cleanup key false': [() => buildWith(id, { parent: (p) => { p.cleanup.sourceUnregistered = false; } }), /cleanup must hold exactly the flags/],
        'a cleanup key renamed': [() => buildWith(id, { parent: (p) => { p.cleanup.linkRemoved = p.cleanup.linksRemoved; delete p.cleanup.linksRemoved; } }), /cleanup must hold exactly the flags/],
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

test('timestamps round in the conservative direction and the generation cap must be positive', () => {
    const id = 'onlyoffice-confidential';
    const setStartedAt = (value) => (p) => { p.box.startedAt = value; };
    // A fractional duration rounds up: the report ran until start + ceil(1000.4 ms) = start + 1001 ms.
    const fractional = (finished) => buildWith(id, { duration: 1000.4, postflight: (p) => { p.capturedAt = iso(startOf(id) + finished); } });
    assert.throws(() => fractional(1000), /before the report finished/);
    assert.doesNotThrow(() => fractional(1001));
    assert.doesNotThrow(() => buildWith(id, { duration: 1000, postflight: (p) => { p.capturedAt = iso(startOf(id) + 1000); } }));
    // stats.startTime rounds down, so started_at is never later than the report's start.
    const started = buildWith(id, { startTime: `${iso(startOf(id)).slice(0, -1)}9999Z` });
    assert.equal(started.gates.find((gate) => gate.id === id).started_at, iso(startOf(id)));
    // box.startedAt rounds down, so the cohort window never opens later than the Box started.
    const boxStart = `${COHORTS['copilot-live-skills'].startedAt.slice(0, -1)}0009Z`;
    const cohort = buildWith('copilot-live-skills', { preflight: setStartedAt(boxStart), postflight: setStartedAt(boxStart) });
    assert.equal(cohort.cohorts['copilot-live-skills'].started_at, COHORTS['copilot-live-skills'].startedAt);
    // The preflight capturedAt rounds up: 0.1 ms after the test started is 1 ms after it, and is refused.
    const capturedAt = (value) => buildWith(id, { preflight: (p) => { p.capturedAt = value; } });
    assert.throws(() => capturedAt(`${iso(startOf(id)).slice(0, -1)}0001Z`), /preflight was captured after the test started/);
    assert.doesNotThrow(() => capturedAt(iso(startOf(id))));
    assert.doesNotThrow(() => capturedAt(`${iso(startOf(id) - 1).slice(0, -1)}9999Z`));
    // The generation cap is a positive integer: zero and negative values are refused, not read as "no cap".
    const cap = (value) => buildWith(id, { preflight: (p) => { p.generationMaxAgeMs = value; } });
    for (const value of [0, -1, -1_800_000, 1.5]) assert.throws(() => cap(value), /the preflight generationMaxAgeMs must be a positive integer/, String(value));
    assert.doesNotThrow(() => cap(1));
    assert.doesNotThrow(() => cap(1_800_000));
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
        'symbolic revision': mutate((r) => { r.revisions.ploinky = 'main'; }),
        'the retired explorer revision': mutate((r) => { r.revisions.explorer = '2'.repeat(40); }),
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
        'a missing sources map': [(r) => { delete r.sources; }, /exactly.*sources/],
        'a sources entry with a root': [(r) => { r.sources.ploinky.root = '/src/ploinky'; }, /receipt source ploinky must contain exactly commit, role/],
        'a sources entry with a bad role': [(r) => { r.sources.webmeet.role = 'mirror'; }, /receipt source webmeet role must be one of/],
        'a sources commit that is not exact': [(r) => { r.sources.webmeet.commit = 'main'; }, /receipt source webmeet commit must be an exact commit/],
        'ploinky as a provenance reference': [(r) => { r.sources.ploinky.role = 'provenance-reference'; }, /receipt source ploinky must be a deployed-source/],
        'explorer as a provenance reference': [(r) => { r.sources.explorer.role = 'provenance-reference'; }, /receipt source explorer must be a deployed-source/],
        'a missing explorer source': [(r) => { delete r.sources.explorer; }, /receipt sources must include the core repository explorer/],
        'a missing agentlib source': [(r) => { delete r.sources.achillesAgentLib; }, /receipt sources must include the core repository achillesAgentLib/],
        'a missing mcp-sdk source': [(r) => { delete r.sources['mcp-sdk']; }, /receipt sources must include mcp-sdk/],
        'a missing Ploinky-Worker source': [(r) => { delete r.sources['Ploinky-Worker']; }, /receipt sources must include Ploinky-Worker/],
        'agentlib as a deployed source': [(r) => { r.sources.achillesAgentLib.role = 'deployed-source'; }, /receipt source achillesAgentLib must be a provenance-reference/],
        'mcp-sdk as a deployed source': [(r) => { r.sources['mcp-sdk'].role = 'deployed-source'; }, /receipt source mcp-sdk must be a provenance-reference/],
        'an AchillesCLI source': [(r) => { r.sources.AchillesCLI = { commit: 'f'.repeat(40), role: 'deployed-source' }; }, /receipt sources must not name an AchillesCLI repository/],
        'an achillesCLI source': [(r) => { r.sources.achillesCLI = { commit: 'f'.repeat(40), role: 'deployed-source' }; }, /receipt sources must not name an AchillesCLI repository/],
        'an achilles-cli source': [(r) => { r.sources['achilles-cli'] = { commit: 'f'.repeat(40), role: 'provenance-reference' }; }, /receipt sources must not name an AchillesCLI repository/],
        'an Achilles_CLI source': [(r) => { r.sources.Achilles_CLI = { commit: 'f'.repeat(40), role: 'provenance-reference' }; }, /receipt sources must not name an AchillesCLI repository/],
        'a source name that is not an identity': [(r) => { r.sources['../x'] = { commit: 'f'.repeat(40), role: 'deployed-source' }; }, /is not a valid identity/],
        'more than 64 sources': [(r) => { for (let i = 0; i < 53; i += 1) r.sources[`extra-${i}`] = { commit: 'f'.repeat(40), role: 'deployed-source' }; }, /receipt sources exceed 64 repositories/],
        'ploinky revision that differs from its source': [(r) => { r.revisions.ploinky = 'd'.repeat(40); }, /receipt revision ploinky differs from its sources entry ploinky/],
        'agentlib revision that differs from its source': [(r) => { r.revisions.achilles_agent_lib = 'd'.repeat(40); }, /receipt revision achilles_agent_lib differs from its sources entry achillesAgentLib/],
        'mcp sdk revision that differs from its source': [(r) => { r.revisions.mcp_sdk_commit = 'd'.repeat(40); }, /receipt revision mcp_sdk_commit differs from its sources entry mcp-sdk/],
        'a cohort without its inventory hash': [(r) => { delete r.cohorts['official-release'].source_inventory_sha256; }, /receipt cohort official-release must contain exactly/],
        'a malformed inventory hash': [(r) => { r.cohorts['copilot-live-skills'].source_inventory_sha256 = 'abc'; }, /cohort copilot-live-skills: source_inventory_sha256 is malformed/],
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
        // revisions and their sources entry change together, so the receipt is valid and the promotion binding is what refuses it.
        'ploinky revision': withReceipt((r) => { r.revisions.ploinky = 'd'.repeat(40); r.sources.ploinky.commit = 'd'.repeat(40); }),
        'agentlib commit': withReceipt((r) => { r.revisions.achilles_agent_lib = 'd'.repeat(40); r.sources.achillesAgentLib.commit = 'd'.repeat(40); }),
        'mcp sdk commit': withReceipt((r) => { r.revisions.mcp_sdk_commit = 'd'.repeat(40); r.sources['mcp-sdk'].commit = 'd'.repeat(40); }),
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
    // The receipt input is described as the v2 receipt, not the retired v1.
    const receiptInput = inputs.match(/acceptance_receipt_json:\n {8}description: (.*)\n/)?.[1] || '';
    assert.match(receiptInput, /ploinky\.box\.acceptance-receipt\/v2/);
    assert.match(receiptInput, /six gates in three cohorts/);
    assert.doesNotMatch(receiptInput, /receipt\/v1/);
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

const exactLine = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`);
const receiptCli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'images/ploinky-box/acceptance-receipt.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });

// The CLI inputs: the image evidence, and for each cohort a manifest file that pins its inventory file by canonical path.
function cliFixture(f, t) {
    fs.mkdirSync(path.join(f.root, 'cli'));
    const dir = fs.realpathSync(path.join(f.root, 'cli'));
    useRealRoots(t, dir);
    writeJson(path.join(dir, 'inspect.json'), imageInspect());
    const manifestFiles = {};
    const inventoryFiles = {};
    for (const cohort of Object.keys(COHORTS)) {
        const workspace = WORKSPACE_OF[cohort];
        inventoryFiles[cohort] = path.join(dir, `inventory-${workspace}.json`);
        manifestFiles[cohort] = path.join(dir, `manifest-${cohort}.json`);
        const bytes = inventoryBytesFor(workspace);
        fs.writeFileSync(inventoryFiles[cohort], bytes);
        writeJson(manifestFiles[cohort], manifestFor(bytes, inventoryFiles[cohort]));
    }
    const cohortArgs = Object.keys(COHORTS).flatMap((cohort) => ['--release-manifest', `${cohort}=${manifestFiles[cohort]}`, '--source-inventory', `${cohort}=${inventoryFiles[cohort]}`]);
    const base = ['build', '--candidate-digest', f.candidateDigest, '--image-inspect', path.join(dir, 'inspect.json'), ...cohortArgs];
    return { dir, base, cohortArgs, manifestFiles, inventoryFiles };
}

test('the receipt producer CLI output is accepted as written by validate and by the workflow inputs', async (t) => {
    const f = await fixture(t);
    const { dir, base } = cliFixture(f, t);
    const built = receiptCli(...base, ...evidenceArgs(artifactDirectories(dir)));
    assert.equal(built.status, 0, built.stderr);
    // The exact bytes of the output file, as a structured process argument or a validated file.
    const file = path.join(dir, 'acceptance-receipt.json');
    fs.writeFileSync(file, built.stdout);
    assert.equal(receiptCli('validate', file).status, 0);
    assert.match(receiptCli('validate', file).stdout, /receipt is well formed and canonical/);
    assert.doesNotThrow(() => validateInputs({ ...f.env, ACCEPTANCE_RECEIPT_JSON: fs.readFileSync(file, 'utf8') }));
    // The same receipt as the producer builds from the same evidence (the fixtures now sit on the CLI's real roots, so their
    // inventory hashes are those of the CLI's inventory files, not of the fake-root receipt in f.env).
    assert.equal(fs.readFileSync(file, 'utf8'), canonicalReceiptText(receiptFor(f.candidateDigest)));
    await f.verify({ env: { ...f.env, ACCEPTANCE_RECEIPT_JSON: fs.readFileSync(file, 'utf8') } });
    // One rule everywhere: no trailing newline is emitted, and none is accepted by either path.
    assert.ok(!built.stdout.endsWith('\n'));
    fs.writeFileSync(file, `${built.stdout}\n`);
    assert.notEqual(receiptCli('validate', file).status, 0);
    assert.throws(() => validateInputs({ ...f.env, ACCEPTANCE_RECEIPT_JSON: `${built.stdout}\n` }), /canonical/);
});

test('the receipt producer CLI binds each gate to one artifact directory and refuses missing or foreign evidence', async (t) => {
    const f = await fixture(t);
    const { dir, base } = cliFixture(f, t);
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
    refused('--generation', [...args, '--generation', 'generation-20261002-1'], /--generation was removed/);
    refused('--mcp-sdk-commit', [...args, '--mcp-sdk-commit', SELECTIONS['mcp-sdk'].commit], /--mcp-sdk-commit was removed in receipt v2/);
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
    refused('missing postflight', args, exactLine('gate onlyoffice-confidential: the postflight (profile-postflight_codex.json) is required'));
    fs.writeFileSync(postflight, kept);
    const parent = path.join(directories['copilot-live-skills'], 'codex-auth/parent-result.json');
    const parentBytes = fs.readFileSync(parent);
    fs.rmSync(parent);
    refused('missing parent result', args, exactLine('gate copilot-live-skills: the parent result (codex-auth/parent-result.json) is required'));
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

test('the receipt producer CLI takes one release manifest and one source inventory for each cohort', async (t) => {
    const f = await fixture(t);
    const { dir, base, cohortArgs, manifestFiles, inventoryFiles } = cliFixture(f, t);
    const head = base.slice(0, base.length - cohortArgs.length);
    const args = evidenceArgs(artifactDirectories(dir));
    const refused = (label, cohortOptions, expected) => {
        const result = receiptCli(...head, ...cohortOptions, ...args);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(result.stdout, '', `${label} must write no receipt`);
    };
    const without = (flag, cohort) => cohortArgs.filter((value, index, all) => !(value.startsWith(`${cohort}=`) && all[index - 1] === flag) && !(value === flag && all[index + 1].startsWith(`${cohort}=`)));
    assert.equal(receiptCli(...head, ...cohortArgs, ...args).status, 0, 'the control build must pass');
    // One of each, for each cohort.
    refused('no inventory for the optional cohort', without('--source-inventory', 'optional-defaults-and-activation'), /--source-inventory is required for cohort optional-defaults-and-activation/);
    refused('no manifest for spec 06', without('--release-manifest', 'copilot-live-skills'), /--release-manifest is required for cohort copilot-live-skills/);
    refused('a second manifest for a cohort', [...cohortArgs, '--release-manifest', `official-release=${manifestFiles['official-release']}`], /--release-manifest must be <cohort>=<path>, once per cohort/);
    refused('a second inventory for a cohort', [...cohortArgs, '--source-inventory', `official-release=${inventoryFiles['official-release']}`], /--source-inventory must be <cohort>=<path>, once per cohort/);
    refused('an unknown cohort', [...cohortArgs, '--source-inventory', `elsewhere=${inventoryFiles['official-release']}`], /unknown cohort elsewhere/);
    refused('the old single manifest', [...without('--release-manifest', 'official-release'), '--release-manifest', manifestFiles['official-release']], /--release-manifest must be <cohort>=<path>, once per cohort/);
    // The inventory must be the file the manifest pins, by canonical path and by bytes.
    const copy = path.join(dir, 'inventory-copy.json');
    fs.copyFileSync(inventoryFiles['official-release'], copy);
    refused('a copy of the pinned inventory', cohortArgs.map((value) => (value === `official-release=${inventoryFiles['official-release']}` ? `official-release=${copy}` : value)),
        /cohort official-release: the source inventory path differs from the release manifest sourceInventory\.path/);
    const pinned = fs.readFileSync(inventoryFiles['optional-defaults-and-activation']);
    fs.appendFileSync(inventoryFiles['optional-defaults-and-activation'], '\n');
    refused('an inventory edited after it was pinned', cohortArgs, /cohort optional-defaults-and-activation: the source inventory bytes do not match the release manifest sourceInventory\.sha256/);
    fs.writeFileSync(inventoryFiles['optional-defaults-and-activation'], pinned);
    // A symbolic link is not the pinned file, and a manifest must be JSON.
    const linked = path.join(dir, 'inventory-link.json');
    fs.symlinkSync(inventoryFiles['official-release'], linked);
    refused('a symlinked inventory', cohortArgs.map((value) => (value === `official-release=${inventoryFiles['official-release']}` ? `official-release=${linked}` : value)), /regular file/);
    const manifest = fs.readFileSync(manifestFiles['copilot-live-skills']);
    fs.writeFileSync(manifestFiles['copilot-live-skills'], 'not json');
    refused('a manifest that is not JSON', cohortArgs, /cohort copilot-live-skills: the release manifest is not JSON/);
    fs.writeFileSync(manifestFiles['copilot-live-skills'], JSON.stringify(legacy421Manifest()));
    refused('a 421-shape manifest file', cohortArgs, /cohort copilot-live-skills: a versionless legacy release manifest is not accepted/);
    fs.writeFileSync(manifestFiles['copilot-live-skills'], manifest);
    assert.equal(receiptCli(...head, ...cohortArgs, ...args).status, 0, 'the restored inputs build again');
});

test('the receipt producer CLI refuses an inventory root that is not its canonical real path', async (t) => {
    const f = await fixture(t);
    const { dir, base, cohortArgs, manifestFiles, inventoryFiles } = cliFixture(f, t);
    const head = base.slice(0, base.length - cohortArgs.length);
    const args = evidenceArgs(artifactDirectories(dir));
    const control = receiptCli(...head, ...cohortArgs, ...args);
    assert.equal(control.status, 0, control.stderr);
    const original = { inventory: fs.readFileSync(inventoryFiles['official-release']), manifest: fs.readFileSync(manifestFiles['official-release']) };
    // Pin an edited inventory with a new manifest, so the only thing wrong with it is the root.
    const refused = (label, edit, expected) => {
        const bytes = inventoryBytesFor('W', edit);
        fs.writeFileSync(inventoryFiles['official-release'], bytes);
        writeJson(manifestFiles['official-release'], manifestFor(bytes, inventoryFiles['official-release']));
        const result = receiptCli(...head, ...cohortArgs, ...args);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(result.stdout, '', `${label} must write no receipt`);
    };
    const notCanonical = /cohort official-release: the root of webmeet is not its canonical real path/;
    const leaf = path.join(dir, 'link-to-webmeet');
    fs.symlinkSync(path.join(WORKSPACES.W.root, 'webmeet'), leaf);
    refused('a root that is a symbolic link', (inv) => { inv.repositories.webmeet.root = leaf; }, notCanonical);
    const linkedWorkspace = path.join(dir, 'linked-workspace');
    fs.symlinkSync(WORKSPACES.W.root, linkedWorkspace);
    refused('a root below a symbolic link', (inv) => { inv.repositories.webmeet.root = path.join(linkedWorkspace, 'webmeet'); }, notCanonical);
    refused('a root that is not normalized', (inv) => { inv.repositories.webmeet.root = `${WORKSPACES.W.root}/./webmeet`; }, notCanonical);
    refused('a root that does not exist', (inv) => { inv.repositories.webmeet.root = path.join(WORKSPACES.W.root, 'missing'); }, /cohort official-release: the root of webmeet cannot be resolved on this host/);
    // The restored inventory builds again, so each refusal above came from its root alone.
    fs.writeFileSync(inventoryFiles['official-release'], original.inventory);
    fs.writeFileSync(manifestFiles['official-release'], original.manifest);
    assert.equal(receiptCli(...head, ...cohortArgs, ...args).status, 0, 'the restored inventory builds again');
});

test('the receipt producer CLI reads the parent result only from a real codex-auth directory', async (t) => {
    const f = await fixture(t);
    const { dir, base } = cliFixture(f, t);
    const directories = artifactDirectories(dir);
    const args = evidenceArgs(directories);
    const auth = path.join(directories['copilot-live-skills'], 'codex-auth');
    assert.equal(receiptCli(...base, ...args).status, 0, 'the control build must pass');
    const refused = (label, expected) => {
        const result = receiptCli(...base, ...args);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(result.stdout, '', `${label} must write no receipt`);
    };
    // A symbolic link in place of the directory could supply a result from anywhere, even a valid one.
    const moved = path.join(dir, 'moved-codex-auth');
    fs.renameSync(auth, moved);
    fs.symlinkSync(moved, auth);
    assert.ok(fs.existsSync(path.join(auth, 'parent-result.json')), 'the linked directory holds a valid parent result');
    refused('symlinked codex-auth', exactLine('gate copilot-live-skills: codex-auth must be a real directory, not a symbolic link or a file'));
    fs.rmSync(auth);
    // A file in place of the directory.
    fs.writeFileSync(auth, 'not a directory');
    refused('codex-auth as a file', exactLine('gate copilot-live-skills: codex-auth must be a real directory, not a symbolic link or a file'));
    fs.rmSync(auth);
    // An absent directory is a missing parent result.
    refused('absent codex-auth', exactLine('gate copilot-live-skills: the parent result (codex-auth/parent-result.json) is required'));
    fs.renameSync(moved, auth);
    assert.equal(receiptCli(...base, ...args).status, 0, 'the restored directory builds again');
    // A symbolic parent-result.json inside a real directory is refused as before.
    const real = path.join(auth, 'parent-result.json');
    const bytes = fs.readFileSync(real);
    fs.rmSync(real);
    fs.writeFileSync(path.join(dir, 'other-parent.json'), bytes);
    fs.symlinkSync(path.join(dir, 'other-parent.json'), real);
    refused('symlinked parent result', /regular file/);
});

test('the repository publication instructions describe the promotion path and its limits', () => {
    const readme = read('README.md');
    assert.match(readme, /promote-ploinky-box-candidate\.yml/);
    assert.match(readme, /acceptance-receipt\.mjs/);
    assert.match(readme, /ploinky\.box\.acceptance-receipt\/v2/);
    assert.match(readme, /cannot (independently )?prove/i);
    assert.match(readme, /candidate_run_id/);
    assert.match(readme, /no build/i);
    // The receipt step accepts the evidence of either engine, the six gates in three cohorts, and the process boundary.
    assert.match(readme, /Podman/);
    assert.match(readme, /bare 64-hex/);
    assert.match(readme, /six gates/);
    assert.match(readme, /three cohorts/);
    assert.match(readme, /profile-preflight_codex\.json/);
    assert.match(readme, /--source-inventory/);
    assert.match(readme, /sourceInventorySha256/);
    assert.match(readme, /no revision is typed by the operator/i);
    assert.match(readme, /explorer-release-bundle/);
    assert.match(readme, /Every\s+inventory root is a canonical real path/);
    assert.match(readme, /re-checks `realpath\(root\) === root`/);
    assert.match(readme, /refs\/heads\/main/);
    assert.match(readme, /child process/);
    assert.match(readme, /canonical/);
});
