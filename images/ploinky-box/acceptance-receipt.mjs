// Producer and validator of the bounded browser-acceptance receipt that the
// promotion-only workflow takes as its operator attestation.
//
// The receipt (schema v2) is a small, data-only JSON document in canonical form
// (sorted keys, no whitespace). The producer builds it from the saved evidence of
// six gate invocations, the release manifest, and the engine's `image inspect`
// (Docker or Podman) of the Box image those runs deployed. Each invocation leaves
// one artifact directory holding `profile-preflight_codex.json` (written before
// the browser starts), `test-results/results.json` (the Playwright JSON report),
// `profile-postflight_codex.json` (written as the runner's last action, and only
// after a fully successful run) and, for spec 06, `codex-auth/parent-result.json`
// (the C5 parent's verdict). The producer refuses to produce a receipt unless every
// report shows only passed tests (exactly one for each of the four release gates,
// at least one for the two prerequisite gates, and in every case no failed,
// skipped, retried, or flaky test) and unless the preflight, report and
// postflight of every gate share one run id and one Box identity.
//
// The Box generation is observed, not typed: each cohort's container ID and start
// time come from its preflights. The six gates fall into three cohorts, which use
// the acceptance ledger's cohort IDs: `official-release` (05, 30-public, 30-media
// and 50, executed in that order without overlap on one generation),
// `copilot-live-skills` (06) and `optional-defaults-and-activation` (03). Every
// cohort is its own fresh Box generation, and every gate finishes within 30
// minutes of its cohort's Box start.
//
// What this does NOT do: neither the producer nor the validator can prove that
// the saved reports describe a real browser run, or that the receipt was built
// from them. The workflow validates the receipt's identity, counts, selections,
// cohorts and timing and binds it to the candidate (digest, revisions,
// per-architecture engine image). Its truth rests on the authorized operator who
// retained and inspected the raw evidence (their SHA-256 digests are recorded
// here) before dispatching the promotion.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_SCHEMA = 'ploinky.box.acceptance-receipt/v2';
export const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARCHITECTURES = ['amd64', 'arm64'];
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
const REVISION_KEYS = ['achilles_agent_lib', 'achilles_cli', 'explorer', 'mcp_sdk_commit', 'ploinky'];
const GATE_KEYS = ['cohort', 'failed', 'finished_at', 'flaky', 'id', 'passed', 'postflight_sha256', 'preflight_sha256', 'report_sha256', 'retried', 'skipped', 'spec', 'started_at', 'tests'];
const PARENT_RESULT_KEY = 'parent_result_sha256';
// The C5 parent's cleanup flags: exactly these six keys, each true. None may be missing, and none may be added.
const PARENT_CLEANUP_FLAGS = Object.freeze(['credentialPersisted', 'credentialRemoved', 'linksRemoved', 'sourceUnregistered', 'robotDeleted', 'folderDeleted']);
const COHORT_KEYS = ['container_id', 'started_at'];
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_GENERATION_AGE_MS = 1_800_000;
const MAX_PREREQUISITE_TESTS = 20;
const MAX_TITLE_LENGTH = 300;
// The manifest component names are the ones the Ploinky release verifier accepts.
const MANIFEST_REVISIONS = {
    achillesAgentLib: 'achilles_agent_lib', achillesCLI: 'achilles_cli', explorer: 'explorer', ploinky: 'ploinky',
};

// Each gate is one spec file, the exact title of its test and the cohort (Box
// generation) it runs in. The four release gates (05, 50, 30-public, 30-media) are
// one-test selections. The two prerequisite gates (06 live skills, 03 Marketplace
// activation) may hold more than one test; their receipt records every selected
// title and the count. Cohort IDs are the acceptance ledger's.
export const COHORT_IDS = Object.freeze(['official-release', 'copilot-live-skills', 'optional-defaults-and-activation']);
export const GATE_SELECTIONS = Object.freeze({
    'copilot-folder-launch': Object.freeze({
        kind: 'release', cohort: 'official-release', spec: 'specs/05-copilot-folder-launch.spec.mjs', test: 'opens a working Copilot from a newly created folder',
    }),
    'copilot-live-skills': Object.freeze({
        kind: 'prerequisite', cohort: 'copilot-live-skills', spec: 'specs/06-copilot-live-skills.spec.mjs',
        test: 'one native conversation consumes local edits, additions, disable, re-enable and deletion',
    }),
    'optional-agents': Object.freeze({
        kind: 'prerequisite', cohort: 'optional-defaults-and-activation', spec: 'specs/03-optional-agents.spec.mjs',
        test: 'OnlyOffice, Scribe, STT, and Umami start disabled and can be enabled through Marketplace',
    }),
    'onlyoffice-confidential': Object.freeze({
        kind: 'release', cohort: 'official-release', spec: 'specs/50-onlyoffice-dpu.spec.mjs',
        test: 'Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart',
    }),
    'webmeet-public-room': Object.freeze({
        kind: 'release', cohort: 'official-release', spec: 'specs/30-webmeet-room-chat.spec.mjs',
        test: 'standalone loader serves the authenticated dashboard and a guest invitation',
    }),
    'webmeet-room-chat': Object.freeze({
        kind: 'release', cohort: 'official-release', spec: 'specs/30-webmeet-room-chat.spec.mjs', test: 'two Explorer accounts can join one room and exchange chat',
    }),
});
// PHASES is the order the receipt records its gates in: 05, 06, 03, 50, 30-public, 30-media. It is a
// recording order, not the execution order. The official cohort runs 05, 30-public, 30-media, 50 on one
// Box generation, one gate after the other without overlap (OFFICIAL_EXECUTION_ORDER); 06 and 03 each
// run on their own fresh generation.
export const PHASES = Object.freeze(['copilot-folder-launch', 'copilot-live-skills', 'optional-agents', 'onlyoffice-confidential', 'webmeet-public-room', 'webmeet-room-chat']);
export const OFFICIAL_EXECUTION_ORDER = Object.freeze(['copilot-folder-launch', 'webmeet-public-room', 'webmeet-room-chat', 'onlyoffice-confidential']);
export const REQUIRED_GATES = PHASES;
export const RELEASE_GATES = Object.freeze(PHASES.filter((id) => GATE_SELECTIONS[id].kind === 'release'));
// Every gate must finish within this long of its cohort's Box start (the generation cap of the acceptance profile).
export const COHORT_WINDOW_MS = 30 * 60_000;
const OFFICIAL_COHORT = 'official-release';
const PARENT_RESULT_GATE = 'copilot-live-skills';

// File names inside the artifact directory of one gate invocation.
export const PREFLIGHT_FILE = 'profile-preflight_codex.json';
export const POSTFLIGHT_FILE = 'profile-postflight_codex.json';
export const REPORT_FILE = 'test-results/results.json';
export const PARENT_RESULT_FILE = 'codex-auth/parent-result.json';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys, label) {
    assert.ok(isPlainObject(value), `${label} must be an object`);
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must contain exactly ${[...keys].sort().join(', ')}`);
}

/**
 * Milliseconds since the epoch of an ISO-8601 UTC instant with at most nine fractional digits. Digits
 * beyond the millisecond are rounded `up` (a capture or finish time must never be recorded earlier than
 * it happened) or `down` (a start time must never be recorded later).
 */
function instantMs(text, label, rounding) {
    const match = typeof text === 'string' ? ISO_INSTANT.exec(text) : null;
    assert.ok(match, `${label} is not an ISO-8601 UTC timestamp`);
    const fraction = (match[2] ?? '').padEnd(9, '0');
    const whole = `${match[1]}.${fraction.slice(0, 3)}Z`;
    const milliseconds = Date.parse(whole);
    assert.ok(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === whole, `${label} is not a valid timestamp`);
    return milliseconds + (rounding === 'up' && /[1-9]/.test(fraction.slice(3)) ? 1 : 0);
}

/** A receipt timestamp: milliseconds, `Z`, and exactly the text `Date` would print. */
function canonicalInstantMs(text, label) {
    assert.ok(typeof text === 'string' && CANONICAL_INSTANT.test(text), `${label} is not a canonical ISO timestamp`);
    const milliseconds = Date.parse(text);
    assert.ok(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text, `${label} is not a canonical ISO timestamp`);
    return milliseconds;
}

/**
 * Count the outcomes of one Playwright JSON report (`--reporter=json`).
 *
 * A release gate must hold exactly its one selected test, passed once. A
 * prerequisite phase must hold one or more tests of its spec file, including
 * its pinned title, all passed. Neither may hold a failed, skipped, retried, or
 * flaky test, a top-level error, or a result error.
 *
 * @param {Buffer|string} report raw report bytes
 * @param {string} gateId key of GATE_SELECTIONS
 */
export function summarizePlaywrightReport(report, gateId) {
    const selection = GATE_SELECTIONS[gateId];
    assert.ok(selection, `unknown gate ${gateId}`);
    const bytes = Buffer.isBuffer(report) ? report : Buffer.from(String(report));
    assert.ok(bytes.length > 0 && bytes.length <= MAX_INPUT_BYTES, `gate ${gateId}: report size is out of bounds`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { assert.fail(`gate ${gateId}: report is not JSON`); }
    assert.ok(isPlainObject(parsed) && Array.isArray(parsed.suites), `gate ${gateId}: not a Playwright JSON report`);
    assert.ok(Array.isArray(parsed.errors) && parsed.errors.length === 0, `gate ${gateId}: the report records top-level errors`);
    const specs = [];
    const walk = (suite) => { specs.push(...(suite.specs || [])); (suite.suites || []).forEach(walk); };
    parsed.suites.forEach(walk);
    const release = selection.kind === 'release';
    if (release) assert.equal(specs.length, 1, `gate ${gateId}: the report must hold exactly one spec, found ${specs.length}`);
    else assert.ok(specs.length >= 1 && specs.length <= MAX_PREREQUISITE_TESTS, `gate ${gateId}: the report holds ${specs.length} specs`);
    const counts = { passed: 0, failed: 0, skipped: 0, retried: 0, flaky: 0 };
    const titles = [];
    for (const spec of specs) {
        assert.ok(typeof spec.title === 'string' && spec.title.length > 0 && spec.title.length <= MAX_TITLE_LENGTH, `gate ${gateId}: a spec title is malformed`);
        assert.equal(path.posix.basename(String(spec.file)), path.posix.basename(selection.spec), `gate ${gateId}: the report ran another spec file`);
        assert.ok(Array.isArray(spec.tests) && spec.tests.length === 1, `gate ${gateId}: each spec must hold exactly one test`);
        const [testCase] = spec.tests;
        const results = Array.isArray(testCase.results) ? testCase.results : [];
        if (testCase.status === 'expected' && results.length === 1 && results[0].status === 'passed') counts.passed += 1;
        else if (testCase.status === 'skipped') counts.skipped += 1;
        else if (testCase.status === 'flaky') counts.flaky += 1;
        else counts.failed += 1;
        counts.retried += results.filter((result) => Number(result.retry) > 0).length + (results.length > 1 ? 1 : 0);
        assert.equal(testCase.projectName, 'chromium', `gate ${gateId}: a test did not run in the chromium project`);
        assert.equal(testCase.expectedStatus, 'passed', `gate ${gateId}: a test is not expected to pass`);
        assert.equal(spec.ok, true, `gate ${gateId}: a spec did not finish ok`);
        assert.ok(results.every((result) => Array.isArray(result.errors) && result.errors.length === 0), `gate ${gateId}: a result records errors`);
        titles.push(spec.title);
    }
    assert.equal(new Set(titles).size, titles.length, `gate ${gateId}: the report repeats a test title`);
    assert.ok(titles.includes(selection.test), `gate ${gateId}: the report did not run the pinned test`);
    if (release) assert.deepEqual(titles, [selection.test], `gate ${gateId}: the report ran another test`);
    const stats = parsed.stats;
    assert.ok(isPlainObject(stats), `gate ${gateId}: the report has no stats`);
    assert.deepEqual({ expected: stats.expected, unexpected: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped },
        { expected: titles.length, unexpected: 0, flaky: 0, skipped: 0 }, `gate ${gateId}: report stats do not match the passed tests`);
    assert.deepEqual(counts, { passed: titles.length, failed: 0, skipped: 0, retried: 0, flaky: 0 },
        `gate ${gateId}: every selected test must pass, with no failed, skipped, retried, or flaky test`);
    // The run this report belongs to and when it ran: Playwright's `config.metadata.runId` (set from SMOKE_RUN_ID)
    // and its `stats.startTime` and `stats.duration`. A fractional duration rounds up to the next millisecond.
    const runId = parsed.config?.metadata?.runId;
    assert.ok(typeof runId === 'string' && RUN_ID.test(runId), `gate ${gateId}: the report has no run id (config.metadata.runId)`);
    const startMs = instantMs(stats.startTime, `gate ${gateId}: the report stats.startTime`, 'down');
    assert.ok(typeof stats.duration === 'number' && Number.isFinite(stats.duration) && stats.duration >= 0, `gate ${gateId}: the report stats.duration is malformed`);
    return { ...counts, spec: selection.spec, tests: [...titles].sort(), runId, startMs, endMs: startMs + Math.ceil(stats.duration) };
}

function validateManifest(manifest) {
    exactKeys(manifest, ['images', 'repositories'], 'release manifest');
    exactKeys(manifest.repositories, Object.keys(MANIFEST_REVISIONS), 'release manifest repositories');
    exactKeys(manifest.images, ['ploinkyBox'], 'release manifest images');
    exactKeys(manifest.images.ploinkyBox, ['digest'], 'release manifest image ploinkyBox');
    const revisions = {};
    for (const [name, key] of Object.entries(MANIFEST_REVISIONS)) {
        exactKeys(manifest.repositories[name], ['commit'], `release manifest repository ${name}`);
        assert.match(manifest.repositories[name].commit, COMMIT, `release manifest ${name} commit must be an exact commit`);
        revisions[key] = manifest.repositories[name].commit;
    }
    assert.match(manifest.images.ploinkyBox.digest, DIGEST, 'release manifest image digest must be an immutable sha256 digest');
    return { revisions, engineImageId: manifest.images.ploinkyBox.digest };
}

/**
 * The engine image ID of one `image inspect` record, in `sha256:<hex>` form.
 * Docker reports `sha256:<hex>`; Podman reports the bare 64-hex ID. This is the
 * same normalization Ploinky applies (`normalizeImageId`). When a record carries
 * both `Id` and `ID` they must name the same image. The promotion verifier also
 * uses it on the raw engine evidence of a native proof.
 */
export function engineImageId(image) {
    const normalize = (value) => {
        const id = String(value ?? '');
        return id && !id.startsWith('sha256:') ? `sha256:${id}` : id;
    };
    const ids = [image.Id, image.ID].filter((value) => value !== undefined).map(normalize);
    assert.ok(ids.length > 0, 'the engine image has no ID');
    for (const id of ids) assert.match(id, DIGEST, 'the engine image ID must be a sha256 image ID (Docker sha256:<hex> or Podman bare hex)');
    assert.ok(ids.every((id) => id === ids[0]), 'the engine image Id and ID fields differ');
    return ids[0];
}

const toBytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value)));

/** One of the small JSON artifacts of a gate invocation, parsed as a plain object. */
function parseEvidence(value, gateId, label) {
    assert.ok(value !== undefined && value !== null, `gate ${gateId}: the ${label} is required`);
    const bytes = toBytes(value);
    assert.ok(bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES, `gate ${gateId}: the ${label} size is out of bounds`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { assert.fail(`gate ${gateId}: the ${label} is not JSON`); }
    assert.ok(isPlainObject(parsed), `gate ${gateId}: the ${label} must be a JSON object`);
    return { bytes, value: parsed };
}

function runIdOf(evidence, gateId, label) {
    assert.ok(typeof evidence.runId === 'string' && RUN_ID.test(evidence.runId), `gate ${gateId}: the ${label} has no run id (runId)`);
    return evidence.runId;
}

/** The Box generation a preflight or postflight observed: `box.containerId`, `box.startedAt` and `box.imageId`. */
function readBox(evidence, gateId, label) {
    assert.ok(isPlainObject(evidence.box), `gate ${gateId}: the ${label} has no Box identity (box)`);
    const { containerId, startedAt, imageId } = evidence.box;
    assert.ok(typeof containerId === 'string' && HEX64.test(containerId), `gate ${gateId}: the ${label} box.containerId is malformed`);
    const startedAtMs = instantMs(startedAt, `gate ${gateId}: the ${label} box.startedAt`, 'down');
    assert.ok(typeof imageId === 'string', `gate ${gateId}: the ${label} box.imageId is malformed`);
    return { containerId, startedAtMs, imageId: engineImageId({ Id: imageId }) };
}

/** The preflight must describe this candidate under the 30-minute generation cap; it returns the Box it observed. */
function checkPreflight(preflight, gateId, manifest, imageId) {
    assert.equal(preflight.ledgerCoverage, 'selected-ledger-identities', `gate ${gateId}: the preflight ledgerCoverage is not selected-ledger-identities`);
    assert.ok(Number.isInteger(preflight.generationMaxAgeMs) && preflight.generationMaxAgeMs > 0, `gate ${gateId}: the preflight generationMaxAgeMs must be a positive integer`);
    assert.ok(preflight.generationMaxAgeMs <= MAX_GENERATION_AGE_MS, `gate ${gateId}: the preflight generationMaxAgeMs exceeds the ${MAX_GENERATION_AGE_MS} ms generation cap`);
    const box = readBox(preflight, gateId, 'preflight');
    assert.equal(box.imageId, imageId, `gate ${gateId}: the preflight Box image is not the engine image`);
    assert.ok(isPlainObject(preflight.repositories), `gate ${gateId}: the preflight has no repositories`);
    for (const name of Object.keys(MANIFEST_REVISIONS)) {
        const commit = preflight.repositories[name]?.commit;
        assert.ok(typeof commit === 'string' && COMMIT.test(commit), `gate ${gateId}: the preflight has no ${name} commit`);
        assert.equal(commit, manifest.revisions[MANIFEST_REVISIONS[name]], `gate ${gateId}: the preflight ${name} commit differs from the release manifest`);
    }
    return box;
}

/**
 * The C5 parent's verdict for spec 06: code OK, a proven leak scan with no leaks and no undecodable files,
 * and exactly the six cleanup flags, each true. `leaks` and `undecodable` may be a count or a list; only zero or empty passes.
 */
function checkParentResult(parent, gateId) {
    const none = (value) => value === 0 || (Array.isArray(value) && value.length === 0);
    assert.equal(parent.code, 'OK', `gate ${gateId}: the parent result code is not OK`);
    assert.equal(parent.leakScanCoverage, 'proven', `gate ${gateId}: the parent result leakScanCoverage is not proven`);
    assert.ok(none(parent.leaks), `gate ${gateId}: the parent result does not report zero leaks`);
    assert.ok(none(parent.undecodable), `gate ${gateId}: the parent result does not report zero undecodable files`);
    assert.ok(isPlainObject(parent.cleanup)
        && JSON.stringify(Object.keys(parent.cleanup).sort()) === JSON.stringify([...PARENT_CLEANUP_FLAGS].sort())
        && PARENT_CLEANUP_FLAGS.every((flag) => parent.cleanup[flag] === true),
        `gate ${gateId}: the parent result cleanup must hold exactly the flags ${PARENT_CLEANUP_FLAGS.join(', ')}, all true`);
}

/**
 * Build the receipt for one acceptance run.
 *
 * `gates` holds, for each of the six gates, the raw bytes of the Playwright JSON `report`, the `preflight`
 * (`profile-preflight_codex.json`), the `postflight` (`profile-postflight_codex.json`) and, for spec 06 only,
 * the `parentResult` (`codex-auth/parent-result.json`). Per gate the producer requires one run id across all of
 * them, a postflight with `exitCode` 0 on the Box the preflight observed, a preflight captured before the
 * test started and a postflight captured after the report finished. `finished_at` is the postflight's capture
 * time (rounded up to the millisecond). Gates of one cohort must share one Box generation, and cohorts must
 * use different generations.
 *
 * `imageInspect` is the engine's `image inspect` array for the Box image the
 * acceptance fixture deployed; its image ID must be the release manifest's Box
 * digest. That is the engine-observed image ID of one architecture, never the
 * registry index digest.
 */
export function buildAcceptanceReceipt({ candidateDigest, releaseManifest, imageInspect, mcpSdkCommit, gates }) {
    assert.match(candidateDigest, DIGEST, 'the candidate must be an immutable sha256 digest, not a tag');
    const manifest = validateManifest(releaseManifest);
    assert.ok(Array.isArray(imageInspect) && imageInspect.length === 1, 'image evidence must hold exactly one image');
    const [image] = imageInspect;
    assert.equal(image.Os, 'linux', 'the engine image is not a linux image');
    assert.ok(ARCHITECTURES.includes(image.Architecture), 'the engine image has an unsupported architecture');
    const imageId = engineImageId(image);
    assert.equal(imageId, manifest.engineImageId, 'the engine image ID differs from the release manifest Box digest');
    assert.match(mcpSdkCommit, COMMIT, 'mcp_sdk_commit must be an exact commit');
    assert.ok(isPlainObject(gates), 'gate evidence is required');
    for (const id of Object.keys(gates)) assert.ok(GATE_SELECTIONS[id], `unknown gate ${id}`);
    for (const id of REQUIRED_GATES) assert.ok(isPlainObject(gates[id]), `required gate ${id} has no evidence`);
    const observed = PHASES.map((id) => {
        const evidence = gates[id];
        assert.ok(evidence.report !== undefined && evidence.report !== null, `gate ${id}: the report is required`);
        const reportBytes = toBytes(evidence.report);
        const { passed, failed, skipped, retried, flaky, spec, tests, runId, startMs, endMs } = summarizePlaywrightReport(reportBytes, id);
        const preflight = parseEvidence(evidence.preflight, id, `preflight (${PREFLIGHT_FILE})`);
        const postflight = parseEvidence(evidence.postflight, id, `postflight (${POSTFLIGHT_FILE})`);
        const needsParent = id === PARENT_RESULT_GATE;
        assert.ok(needsParent || evidence.parentResult === undefined, `gate ${id}: a parent result belongs to spec 06 only`);
        const parent = needsParent ? parseEvidence(evidence.parentResult, id, `parent result (${PARENT_RESULT_FILE})`) : null;
        // One run: the report, preflight, postflight (and parent result) name the same run id.
        const runIds = [runId, runIdOf(preflight.value, id, 'preflight'), runIdOf(postflight.value, id, 'postflight'), ...(parent ? [runIdOf(parent.value, id, 'parent result')] : [])];
        assert.ok(runIds.every((value) => value === runIds[0]),
            `gate ${id}: the report, preflight, postflight${parent ? ' and parent result' : ''} do not share one run id`);
        const box = checkPreflight(preflight.value, id, manifest, imageId);
        // The terminal verdict: the runner writes the postflight last, and only after exit code 0.
        assert.strictEqual(postflight.value.exitCode, 0, `gate ${id}: the postflight exitCode is not 0`);
        const after = readBox(postflight.value, id, 'postflight');
        assert.ok(after.containerId === box.containerId && after.startedAtMs === box.startedAtMs && after.imageId === box.imageId,
            `gate ${id}: the postflight Box identity differs from the preflight`);
        assert.ok(instantMs(preflight.value.capturedAt, `gate ${id}: the preflight capturedAt`, 'up') <= startMs, `gate ${id}: the preflight was captured after the test started`);
        const finishedMs = instantMs(postflight.value.capturedAt, `gate ${id}: the postflight capturedAt`, 'up');
        assert.ok(finishedMs >= endMs, `gate ${id}: the postflight was captured before the report finished`);
        if (parent) checkParentResult(parent.value, id);
        const entry = {
            id, cohort: GATE_SELECTIONS[id].cohort, spec, tests, passed, failed, skipped, retried, flaky, report_sha256: sha256(reportBytes),
            preflight_sha256: sha256(preflight.bytes), postflight_sha256: sha256(postflight.bytes),
            started_at: new Date(startMs).toISOString(), finished_at: new Date(finishedMs).toISOString(),
            ...(parent ? { [PARENT_RESULT_KEY]: sha256(parent.bytes) } : {}),
        };
        return { entry, box, runId };
    });
    // Every invocation is its own run.
    for (const [index, { runId }] of observed.entries()) {
        const other = observed.findIndex((candidate, at) => at > index && candidate.runId === runId);
        assert.ok(other < 0, `gates ${PHASES[index]} and ${PHASES[other]} share one run id; every invocation needs a distinct run id`);
    }
    // Every cohort is one Box generation, read from its gates' preflights.
    const cohorts = {};
    for (const cohort of COHORT_IDS) {
        const members = observed.filter(({ entry }) => entry.cohort === cohort);
        const [first] = members;
        assert.ok(members.every(({ box }) => box.containerId === first.box.containerId && box.startedAtMs === first.box.startedAtMs),
            `cohort ${cohort}: its gates were not observed on the same Box generation (container and start time)`);
        cohorts[cohort] = { container_id: first.box.containerId, started_at: new Date(first.box.startedAtMs).toISOString() };
    }
    return validateAcceptanceReceipt({
        schema: RECEIPT_SCHEMA,
        candidate: { digest: candidateDigest },
        revisions: { ...manifest.revisions, mcp_sdk_commit: mcpSdkCommit },
        cohorts,
        engine_image_ids: { [image.Architecture]: imageId },
        gates: observed.map(({ entry }) => entry),
    });
}

/**
 * Validate a receipt's own shape, counts, gate selections, cohorts and timing. The checks that
 * bind it to a candidate (digest, revisions, engine image IDs) are made by the
 * promotion verifier against the candidate's evidence.
 */
export function validateAcceptanceReceipt(receipt) {
    assert.ok(isPlainObject(receipt), 'receipt must be an object');
    assert.equal(receipt.schema, RECEIPT_SCHEMA, `receipt schema is not supported: only ${RECEIPT_SCHEMA} is accepted, and a v1 receipt must be rebuilt from the per-gate evidence`);
    exactKeys(receipt, ['candidate', 'cohorts', 'engine_image_ids', 'gates', 'revisions', 'schema'], 'receipt');
    exactKeys(receipt.candidate, ['digest'], 'receipt candidate');
    assert.match(receipt.candidate.digest, DIGEST, 'receipt candidate must be an immutable sha256 digest');
    exactKeys(receipt.revisions, REVISION_KEYS, 'receipt revisions');
    for (const key of REVISION_KEYS) assert.match(receipt.revisions[key], COMMIT, `receipt revision ${key} must be an exact commit`);
    assert.ok(isPlainObject(receipt.engine_image_ids), 'receipt engine_image_ids must be an object');
    const architectures = Object.keys(receipt.engine_image_ids);
    assert.ok(architectures.length > 0 && architectures.every((arch) => ARCHITECTURES.includes(arch)), 'receipt engine image IDs must name amd64 and/or arm64');
    for (const arch of architectures) assert.match(receipt.engine_image_ids[arch], DIGEST, `receipt engine image ID for ${arch} is malformed`);
    // Exactly the three cohorts, each a distinct Box generation with a canonical start time.
    exactKeys(receipt.cohorts, COHORT_IDS, 'receipt cohorts');
    const cohortStart = {};
    for (const cohort of COHORT_IDS) {
        exactKeys(receipt.cohorts[cohort], COHORT_KEYS, `receipt cohort ${cohort}`);
        assert.match(receipt.cohorts[cohort].container_id, HEX64, `cohort ${cohort}: container_id is malformed`);
        cohortStart[cohort] = canonicalInstantMs(receipt.cohorts[cohort].started_at, `cohort ${cohort}: started_at`);
    }
    for (const [index, cohort] of COHORT_IDS.entries()) {
        for (const other of COHORT_IDS.slice(index + 1)) {
            assert.notEqual(receipt.cohorts[cohort].container_id, receipt.cohorts[other].container_id,
                `cohorts ${cohort} and ${other} share one Box container; every cohort needs its own distinct Box generation`);
        }
    }
    assert.ok(Array.isArray(receipt.gates) && receipt.gates.length <= PHASES.length, 'receipt gates are malformed');
    const seen = new Set();
    const hashes = { report_sha256: new Set(), preflight_sha256: new Set(), postflight_sha256: new Set() };
    const timing = {};
    for (const gate of receipt.gates) {
        assert.ok(isPlainObject(gate), 'receipt gate must be an object');
        const selection = GATE_SELECTIONS[gate.id];
        assert.ok(selection, `receipt names an unknown gate ${gate.id}`);
        // Spec 06 alone records the parent result's digest.
        exactKeys(gate, gate.id === PARENT_RESULT_GATE ? [...GATE_KEYS, PARENT_RESULT_KEY] : GATE_KEYS, 'receipt gate');
        assert.ok(!seen.has(gate.id), `receipt names gate ${gate.id} twice`);
        seen.add(gate.id);
        assert.equal(gate.spec, selection.spec, `gate ${gate.id}: spec is not the required selection`);
        assert.equal(gate.cohort, selection.cohort, `gate ${gate.id}: cohort is not the required selection`);
        assert.ok(Array.isArray(gate.tests) && gate.tests.length >= 1 && gate.tests.length <= MAX_PREREQUISITE_TESTS
            && gate.tests.every((title) => typeof title === 'string' && title.length > 0 && title.length <= MAX_TITLE_LENGTH)
            && new Set(gate.tests).size === gate.tests.length, `gate ${gate.id}: tests are malformed`);
        assert.ok(gate.tests.includes(selection.test), `gate ${gate.id}: tests do not include the required selection`);
        if (selection.kind === 'release') assert.deepEqual(gate.tests, [selection.test], `gate ${gate.id}: a release gate must select exactly its one test`);
        // A release gate passes exactly once; a prerequisite phase passes every selected test.
        const passed = selection.kind === 'release' ? 1 : gate.tests.length;
        for (const [field, expected] of [['passed', passed], ['failed', 0], ['skipped', 0], ['retried', 0], ['flaky', 0]]) {
            assert.ok(Number.isInteger(gate[field]) && gate[field] === expected, `gate ${gate.id}: ${field} must be exactly ${expected}`);
        }
        for (const [field, label] of [['report_sha256', 'report'], ['preflight_sha256', 'preflight'], ['postflight_sha256', 'postflight']]) {
            assert.match(gate[field], HEX64, `gate ${gate.id}: ${label} digest is malformed`);
            assert.ok(!hashes[field].has(gate[field]), `gate ${gate.id}: ${label} digest is shared with another gate`);
            hashes[field].add(gate[field]);
        }
        if (gate.id === PARENT_RESULT_GATE) assert.match(gate[PARENT_RESULT_KEY], HEX64, `gate ${gate.id}: parent result digest is malformed`);
        // The gate ran inside its cohort's 30-minute window, measured from the Box start.
        const startedMs = canonicalInstantMs(gate.started_at, `gate ${gate.id}: started_at`);
        const finishedMs = canonicalInstantMs(gate.finished_at, `gate ${gate.id}: finished_at`);
        const windowStart = cohortStart[selection.cohort];
        assert.ok(startedMs >= windowStart, `gate ${gate.id}: started_at is before its cohort started`);
        assert.ok(finishedMs >= startedMs, `gate ${gate.id}: finished_at is before it started`);
        assert.ok(finishedMs <= windowStart + COHORT_WINDOW_MS, `gate ${gate.id}: finished_at is not within 30 minutes of its cohort start`);
        timing[gate.id] = { startedMs, finishedMs };
    }
    for (const id of REQUIRED_GATES) assert.ok(seen.has(id), `required gate ${id} is missing`);
    assert.deepEqual(receipt.gates.map(({ id }) => id), [...PHASES], 'receipt gates are not in the mandatory phase order');
    // The official cohort executes 05, 30-public, 30-media, 50 one after the other: each starts when, or after, the previous finished.
    for (const [index, id] of OFFICIAL_EXECUTION_ORDER.slice(1).entries()) {
        const previous = OFFICIAL_EXECUTION_ORDER[index];
        assert.ok(timing[id].startedMs >= timing[previous].finishedMs,
            `${OFFICIAL_COHORT} gate ${id} starts before gate ${previous} finished; the gates must run in the order ${OFFICIAL_EXECUTION_ORDER.join(', ')} without overlap`);
    }
    return receipt;
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
    return value;
}

/** The one text form of a receipt: keys sorted at every level, no whitespace. */
export const canonicalReceiptText = (receipt) => JSON.stringify(sortKeys(receipt));

/**
 * Parse receipt text and require it to be valid AND canonical, so the text that
 * is stored as evidence is exactly the value that was validated. A duplicate key,
 * reordered keys, or any whitespace make the text differ from its canonical form.
 */
export function parseCanonicalReceipt(text) {
    assert.ok(typeof text === 'string' && text.length > 0, 'acceptance receipt is required');
    assert.ok(Buffer.byteLength(text) <= MAX_RECEIPT_BYTES, `acceptance receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
    let receipt;
    try { receipt = JSON.parse(text); } catch { assert.fail('acceptance receipt is not JSON'); }
    validateAcceptanceReceipt(receipt);
    assert.equal(text, canonicalReceiptText(receipt), 'acceptance receipt is not canonical (sorted keys, no whitespace, no duplicate keys); regenerate it with acceptance-receipt.mjs build, which writes the canonical text with no trailing newline');
    return receipt;
}

function readBounded(file, limit, label) {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
    assert.ok(stat.size <= limit, `${label} exceeds ${limit} bytes`);
    return fs.readFileSync(file);
}

/** A file the artifact directory may lack: absent is `undefined`, anything else must be a bounded regular file. */
function readOptional(file, limit, label) {
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    return readBounded(file, limit, label);
}

/**
 * Read one gate's evidence from its artifact directory. The preflight names the directory; the report must be
 * `test-results/results.json` in the same directory, and the postflight (and for spec 06 the parent result) are
 * read from it too. A missing postflight or parent result is left out so that the producer refuses the gate.
 */
export function readGateEvidence(id, { reportPath, preflightPath }) {
    assert.ok(GATE_SELECTIONS[id], `unknown gate ${id}`);
    assert.equal(path.basename(preflightPath), PREFLIGHT_FILE, `gate ${id}: the preflight must be named ${PREFLIGHT_FILE}`);
    const directory = fs.realpathSync(path.dirname(preflightPath));
    assert.ok(path.basename(reportPath) === path.basename(REPORT_FILE) && fs.realpathSync(path.dirname(reportPath)) === path.join(directory, path.dirname(REPORT_FILE)),
        `gate ${id}: the report must be ${REPORT_FILE} in the artifact directory of its preflight`);
    // The parent result sits in `codex-auth`; that directory itself must be a real directory, not a symbolic link
    // (which would let the file come from elsewhere) and not a file. An absent directory leaves the result missing.
    let parentResult;
    if (id === PARENT_RESULT_GATE) {
        const authDirectory = path.join(directory, path.dirname(PARENT_RESULT_FILE));
        let stat;
        try { stat = fs.lstatSync(authDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat) {
            assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `gate ${id}: ${path.dirname(PARENT_RESULT_FILE)} must be a real directory, not a symbolic link or a file`);
            parentResult = readOptional(path.join(directory, PARENT_RESULT_FILE), MAX_EVIDENCE_BYTES, `gate ${id}: parent result`);
        }
    }
    return {
        report: readBounded(reportPath, MAX_INPUT_BYTES, `gate ${id}: report`),
        preflight: readBounded(path.join(directory, PREFLIGHT_FILE), MAX_EVIDENCE_BYTES, `gate ${id}: preflight`),
        postflight: readOptional(path.join(directory, POSTFLIGHT_FILE), MAX_EVIDENCE_BYTES, `gate ${id}: postflight`),
        ...(id === PARENT_RESULT_GATE ? { parentResult } : {}),
    };
}

const BUILD_OPTIONS = ['--candidate-digest', '--release-manifest', '--image-inspect', '--mcp-sdk-commit', '--report', '--preflight'];

/** Option/value pairs only: an unknown option, including the retired `--generation`, is an error, never ignored. */
function buildOptions(args) {
    const values = new Map(BUILD_OPTIONS.map((name) => [name, []]));
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        assert.ok(name !== '--generation', '--generation was removed in receipt v2: the Box generation of each cohort is read from the --preflight evidence');
        assert.ok(values.has(name), `unknown option ${name}`);
        assert.ok(i + 1 < args.length, `${name} needs a value`);
        values.get(name).push(args[i + 1]);
    }
    return values;
}

function gateFiles(entries, name) {
    const files = {};
    for (const entry of entries) {
        const [id, file] = entry.split(/=(.*)/s);
        assert.ok(id && file && !(id in files), `${name} must be <gate-id>=<path>, once per gate: ${entry}`);
        assert.ok(GATE_SELECTIONS[id], `unknown gate ${id}`);
        files[id] = file;
    }
    return files;
}

function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'build') {
        const options = buildOptions(args);
        const single = (name) => {
            assert.ok(options.get(name).length === 1, `${name} is required exactly once`);
            return options.get(name)[0];
        };
        const reports = gateFiles(options.get('--report'), '--report');
        const preflights = gateFiles(options.get('--preflight'), '--preflight');
        const gates = {};
        for (const id of REQUIRED_GATES) {
            assert.ok(reports[id], `required gate ${id} has no --report`);
            assert.ok(preflights[id], `required gate ${id} has no --preflight`);
            gates[id] = readGateEvidence(id, { reportPath: reports[id], preflightPath: preflights[id] });
        }
        const receipt = buildAcceptanceReceipt({
            candidateDigest: single('--candidate-digest'),
            releaseManifest: JSON.parse(readBounded(single('--release-manifest'), MAX_MANIFEST_BYTES, 'release manifest')),
            imageInspect: JSON.parse(readBounded(single('--image-inspect'), MAX_MANIFEST_BYTES, 'image evidence')),
            mcpSdkCommit: single('--mcp-sdk-commit'),
            gates,
        });
        const text = canonicalReceiptText(receipt);
        assert.ok(Buffer.byteLength(text) <= MAX_RECEIPT_BYTES, 'receipt exceeds its size bound');
        // No trailing newline: the output file is exactly the canonical text the workflow accepts.
        process.stdout.write(text);
    } else if (command === 'validate') {
        parseCanonicalReceipt(readBounded(args[0], MAX_RECEIPT_BYTES, 'receipt').toString('utf8'));
        process.stdout.write('receipt is well formed and canonical\n');
    } else {
        throw new Error('usage: acceptance-receipt.mjs build --candidate-digest <sha256:..> --release-manifest <file> --image-inspect <file> --mcp-sdk-commit <sha> --report <gate-id>=<artifact-dir>/test-results/results.json --preflight <gate-id>=<artifact-dir>/profile-preflight_codex.json ... (once per gate, six gates) | validate <file>');
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
