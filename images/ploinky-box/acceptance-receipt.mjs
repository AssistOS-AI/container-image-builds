// Producer and validator of the bounded browser-acceptance receipt that the
// promotion-only workflow takes as its operator attestation.
//
// The receipt is a small, data-only JSON document in canonical form (sorted keys,
// no whitespace). The producer builds it from three saved inputs of one local
// acceptance run: the Playwright JSON reports of the five acceptance phases, the
// release manifest, and the engine's `image inspect` (Docker or Podman) of the Box
// image that run deployed. It refuses to produce a receipt unless every phase
// report shows only passed tests: exactly one for each of the three release gates,
// at least one for the two prerequisite phases, and in every case no failed,
// skipped, retried, or flaky test.
//
// What this does NOT do: neither the producer nor the validator can prove that
// the saved reports describe a real browser run, or that the receipt was built
// from them. The workflow validates the receipt's identity, counts, and
// selections and binds it to the candidate (digest, revisions, per-architecture
// engine image). Its truth rests on the authorized operator who retained and
// inspected the raw reports (their SHA-256 digests are recorded here) before
// dispatching the promotion.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_SCHEMA = 'ploinky.box.acceptance-receipt/v1';
export const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARCHITECTURES = ['amd64', 'arm64'];
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_KEYS = ['achilles_agent_lib', 'achilles_cli', 'explorer', 'mcp_sdk_commit', 'ploinky'];
const GATE_KEYS = ['failed', 'flaky', 'id', 'passed', 'report_sha256', 'retried', 'skipped', 'spec', 'tests'];
const MAX_PREREQUISITE_TESTS = 20;
const MAX_TITLE_LENGTH = 300;
// The manifest component names are the ones the Ploinky release verifier accepts.
const MANIFEST_REVISIONS = {
    achillesAgentLib: 'achilles_agent_lib', achillesCLI: 'achilles_cli', explorer: 'explorer', ploinky: 'ploinky',
};

// Each gate is one spec file and the exact title of its release test. The three
// release gates (05, 50, 30) are one-test selections. The two prerequisite phases
// (06 live skills, 03 Marketplace activation) run before them and may hold more
// than one test; their receipt records every selected title and the count.
// PHASES is the mandatory order of the five-phase acceptance sequence.
export const GATE_SELECTIONS = Object.freeze({
    'copilot-folder-launch': Object.freeze({
        kind: 'release', spec: 'specs/05-copilot-folder-launch.spec.mjs', test: 'opens a working Copilot from a newly created folder',
    }),
    'copilot-live-skills': Object.freeze({
        kind: 'prerequisite', spec: 'specs/06-copilot-live-skills.spec.mjs',
        test: 'one native conversation consumes local edits, additions, disable, re-enable and deletion',
    }),
    'optional-agents': Object.freeze({
        kind: 'prerequisite', spec: 'specs/03-optional-agents.spec.mjs',
        test: 'OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace',
    }),
    'onlyoffice-confidential': Object.freeze({
        kind: 'release', spec: 'specs/50-onlyoffice-dpu.spec.mjs',
        test: 'Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart',
    }),
    'webmeet-room-chat': Object.freeze({
        kind: 'release', spec: 'specs/30-webmeet-room-chat.spec.mjs', test: 'two Explorer accounts can join one room and exchange chat',
    }),
});
export const PHASES = Object.freeze(['copilot-folder-launch', 'copilot-live-skills', 'optional-agents', 'onlyoffice-confidential', 'webmeet-room-chat']);
export const REQUIRED_GATES = PHASES;
export const RELEASE_GATES = Object.freeze(PHASES.filter((id) => GATE_SELECTIONS[id].kind === 'release'));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys, label) {
    assert.ok(isPlainObject(value), `${label} must be an object`);
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must contain exactly ${[...keys].sort().join(', ')}`);
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
    return { ...counts, spec: selection.spec, tests: [...titles].sort() };
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

/**
 * Build the receipt for one acceptance run.
 *
 * `imageInspect` is the engine's `image inspect` array for the Box image the
 * acceptance fixture deployed; its image ID must be the release manifest's Box
 * digest. That is the engine-observed image ID of one architecture, never the
 * registry index digest.
 */
export function buildAcceptanceReceipt({ candidateDigest, releaseManifest, imageInspect, mcpSdkCommit, generation, reports }) {
    assert.match(candidateDigest, DIGEST, 'the candidate must be an immutable sha256 digest, not a tag');
    const manifest = validateManifest(releaseManifest);
    assert.ok(Array.isArray(imageInspect) && imageInspect.length === 1, 'image evidence must hold exactly one image');
    const [image] = imageInspect;
    assert.equal(image.Os, 'linux', 'the engine image is not a linux image');
    assert.ok(ARCHITECTURES.includes(image.Architecture), 'the engine image has an unsupported architecture');
    const imageId = engineImageId(image);
    assert.equal(imageId, manifest.engineImageId, 'the engine image ID differs from the release manifest Box digest');
    assert.match(mcpSdkCommit, COMMIT, 'mcp_sdk_commit must be an exact commit');
    assert.match(generation, GENERATION, 'the generation identifier is malformed');
    assert.ok(isPlainObject(reports), 'gate reports are required');
    for (const id of Object.keys(reports)) assert.ok(GATE_SELECTIONS[id], `unknown gate ${id}`);
    for (const id of REQUIRED_GATES) assert.ok(reports[id], `required gate ${id} has no report`);
    const gates = PHASES.map((id) => {
        const bytes = Buffer.isBuffer(reports[id]) ? reports[id] : Buffer.from(String(reports[id]));
        const { passed, failed, skipped, retried, flaky, spec, tests } = summarizePlaywrightReport(bytes, id);
        return { id, spec, tests, passed, failed, skipped, retried, flaky, report_sha256: sha256(bytes) };
    });
    return validateAcceptanceReceipt({
        schema: RECEIPT_SCHEMA,
        candidate: { digest: candidateDigest },
        revisions: { ...manifest.revisions, mcp_sdk_commit: mcpSdkCommit },
        generation,
        engine_image_ids: { [image.Architecture]: imageId },
        gates,
    });
}

/**
 * Validate a receipt's own shape, counts, and gate selections. The checks that
 * bind it to a candidate (digest, revisions, engine image IDs) are made by the
 * promotion verifier against the candidate's evidence.
 */
export function validateAcceptanceReceipt(receipt) {
    exactKeys(receipt, ['candidate', 'engine_image_ids', 'gates', 'generation', 'revisions', 'schema'], 'receipt');
    assert.equal(receipt.schema, RECEIPT_SCHEMA, 'receipt schema is not supported');
    exactKeys(receipt.candidate, ['digest'], 'receipt candidate');
    assert.match(receipt.candidate.digest, DIGEST, 'receipt candidate must be an immutable sha256 digest');
    exactKeys(receipt.revisions, REVISION_KEYS, 'receipt revisions');
    for (const key of REVISION_KEYS) assert.match(receipt.revisions[key], COMMIT, `receipt revision ${key} must be an exact commit`);
    assert.ok(typeof receipt.generation === 'string' && GENERATION.test(receipt.generation), 'receipt generation is malformed');
    assert.ok(isPlainObject(receipt.engine_image_ids), 'receipt engine_image_ids must be an object');
    const architectures = Object.keys(receipt.engine_image_ids);
    assert.ok(architectures.length > 0 && architectures.every((arch) => ARCHITECTURES.includes(arch)), 'receipt engine image IDs must name amd64 and/or arm64');
    for (const arch of architectures) assert.match(receipt.engine_image_ids[arch], DIGEST, `receipt engine image ID for ${arch} is malformed`);
    assert.ok(Array.isArray(receipt.gates) && receipt.gates.length <= PHASES.length, 'receipt gates are malformed');
    const seen = new Set();
    const reportHashes = new Set();
    for (const gate of receipt.gates) {
        exactKeys(gate, GATE_KEYS, 'receipt gate');
        const selection = GATE_SELECTIONS[gate.id];
        assert.ok(selection, `receipt names an unknown gate ${gate.id}`);
        assert.ok(!seen.has(gate.id), `receipt names gate ${gate.id} twice`);
        seen.add(gate.id);
        assert.equal(gate.spec, selection.spec, `gate ${gate.id}: spec is not the required selection`);
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
        assert.match(gate.report_sha256, HEX64, `gate ${gate.id}: report digest is malformed`);
        assert.ok(!reportHashes.has(gate.report_sha256), `gate ${gate.id}: report digest is shared with another gate`);
        reportHashes.add(gate.report_sha256);
    }
    for (const id of REQUIRED_GATES) assert.ok(seen.has(id), `required gate ${id} is missing`);
    assert.deepEqual(receipt.gates.map(({ id }) => id), [...PHASES], 'receipt gates are not in the mandatory phase order');
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

function option(args, name, { multiple = false } = {}) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) if (args[i] === name) values.push(args[i + 1]);
    assert.ok(multiple ? values.length > 0 : values.length === 1, `${name} is required${multiple ? '' : ' exactly once'}`);
    return multiple ? values : values[0];
}

function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'build') {
        const reports = {};
        for (const entry of option(args, '--report', { multiple: true })) {
            const [id, file] = entry.split(/=(.*)/s);
            assert.ok(id && file && !(id in reports), `--report must be <gate-id>=<path>, once per gate: ${entry}`);
            reports[id] = readBounded(file, MAX_INPUT_BYTES, `report ${id}`);
        }
        const receipt = buildAcceptanceReceipt({
            candidateDigest: option(args, '--candidate-digest'),
            releaseManifest: JSON.parse(readBounded(option(args, '--release-manifest'), MAX_MANIFEST_BYTES, 'release manifest')),
            imageInspect: JSON.parse(readBounded(option(args, '--image-inspect'), MAX_MANIFEST_BYTES, 'image evidence')),
            mcpSdkCommit: option(args, '--mcp-sdk-commit'),
            generation: option(args, '--generation'),
            reports,
        });
        const text = canonicalReceiptText(receipt);
        assert.ok(Buffer.byteLength(text) <= MAX_RECEIPT_BYTES, 'receipt exceeds its size bound');
        // No trailing newline: the output file is exactly the canonical text the workflow accepts.
        process.stdout.write(text);
    } else if (command === 'validate') {
        parseCanonicalReceipt(readBounded(args[0], MAX_RECEIPT_BYTES, 'receipt').toString('utf8'));
        process.stdout.write('receipt is well formed and canonical\n');
    } else {
        throw new Error('usage: acceptance-receipt.mjs build --candidate-digest <sha256:..> --release-manifest <file> --image-inspect <file> --mcp-sdk-commit <sha> --generation <id> --report <gate-id>=<playwright-json> ... | validate <file>');
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
