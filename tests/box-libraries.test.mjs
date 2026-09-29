import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    LIBRARIES, formatOutputs, gitRunner, parseSymbolicHead, resolveLibraries,
} from '../images/ploinky-box/resolve-libraries.mjs';
import { parseArguments as parsePrepareArguments, prepareLibrary } from '../images/ploinky-box/prepare-libraries.mjs';
import {
    ACHILLES_MODULES, ACHILLES_REQUIRED_ENTRIES, MCP_SDK_MEMBERS, SELF_TEST_CASES, LibrarySmokeError,
    assertProtectedLayout, checkMcpSdk, inspectAchillesAgentLib, parseArguments, readProvenance,
    runSelfTest, runSmoke, smokeAchillesAgentLib, smokeMcpSdk,
} from '../images/ploinky-box/smoke-libraries.mjs';
import { commitAll, git, sdkEntry, writeAgentLibFixture, writeSdkFixture } from './fixtures/box-libraries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = path.join(ROOT, 'images/ploinky-box');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-ploinky-box-image.yml'), 'utf8');
const AGENTLIB_URL = LIBRARIES.achillesAgentLib.repository;
const MCP_SDK_URL = LIBRARIES['mcp-sdk'].repository;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function scratch(t, prefix = 'box-libraries-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const head = (branch, commit) => `ref: refs/heads/${branch}\tHEAD\n${commit}\tHEAD\n`;

function fakeRemote(responses) {
    const calls = [];
    return {
        calls,
        run(args) {
            calls.push(args);
            assert.ok(args[2] in responses, `unexpected remote ${args[2]}`);
            return responses[args[2]];
        },
    };
}

test('default-selected libraries are each resolved by exactly one symbolic HEAD query', () => {
    const remote = fakeRemote({ [AGENTLIB_URL]: head('master', A), [MCP_SDK_URL]: head('main', B) });
    const selections = resolveLibraries({}, remote.run);
    assert.deepEqual(remote.calls, [
        ['ls-remote', '--symref', AGENTLIB_URL, 'HEAD'],
        ['ls-remote', '--symref', MCP_SDK_URL, 'HEAD'],
    ]);
    // A default branch is whatever the remote reports; neither is assumed to be main.
    assert.deepEqual(selections, {
        achillesAgentLib: { repository: AGENTLIB_URL, branch: 'master', commit: A },
        'mcp-sdk': { repository: MCP_SDK_URL, branch: 'main', commit: B },
    });
    assert.ok(Object.isFrozen(selections) && Object.isFrozen(selections.achillesAgentLib));
});

test('an explicit commit skips resolution only for its own library and records no branch', () => {
    const onlySdk = fakeRemote({ [MCP_SDK_URL]: head('trunk', B) });
    assert.deepEqual(resolveLibraries({ agentlibCommit: A }, onlySdk.run), {
        achillesAgentLib: { repository: AGENTLIB_URL, branch: null, commit: A },
        'mcp-sdk': { repository: MCP_SDK_URL, branch: 'trunk', commit: B },
    });
    assert.deepEqual(onlySdk.calls, [['ls-remote', '--symref', MCP_SDK_URL, 'HEAD']]);

    const onlyAgentLib = fakeRemote({ [AGENTLIB_URL]: head('master', A) });
    assert.deepEqual(resolveLibraries({ mcpSdkCommit: B }, onlyAgentLib.run), {
        achillesAgentLib: { repository: AGENTLIB_URL, branch: 'master', commit: A },
        'mcp-sdk': { repository: MCP_SDK_URL, branch: null, commit: B },
    });
    assert.deepEqual(onlyAgentLib.calls, [['ls-remote', '--symref', AGENTLIB_URL, 'HEAD']]);

    const none = fakeRemote({});
    resolveLibraries({ agentlibCommit: A, mcpSdkCommit: B }, none.run);
    assert.deepEqual(none.calls, []);
    // The workflow passes an empty string for an omitted input.
    const blank = fakeRemote({ [AGENTLIB_URL]: head('master', A), [MCP_SDK_URL]: head('main', B) });
    resolveLibraries({ agentlibCommit: '', mcpSdkCommit: '  ' }, blank.run);
    assert.equal(blank.calls.length, 2);
});

test('an explicit commit input must be an exact lowercase 40-character commit', () => {
    for (const commit of ['main', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64), `${A}\ncommit=evil`]) {
        const remote = fakeRemote({});
        assert.throws(() => resolveLibraries({ agentlibCommit: commit }, remote.run), /AGENTLIB_COMMIT/, commit);
        assert.throws(() => resolveLibraries({ mcpSdkCommit: commit }, remote.run), /MCP_SDK_COMMIT/, commit);
        assert.deepEqual(remote.calls, []);
    }
});

test('a missing, detached, ambiguous, or malformed symbolic HEAD fails without a fallback branch', () => {
    const malformed = [
        '',
        `${A}\tHEAD\n`,
        `ref: refs/heads/main\tHEAD\n`,
        `ref: refs/tags/v1\tHEAD\n${A}\tHEAD\n`,
        `ref: refs/heads/main\tHEAD\n${A}\tHEAD\nref: refs/heads/other\tHEAD\n`,
        `ref: refs/heads/main\tHEAD\n${A}\tHEAD\n${B}\trefs/heads/main\n`,
        `ref: refs/heads/main\tHEAD\n${'a'.repeat(39)}\tHEAD\n`,
        `ref: refs/heads/main\tHEAD\n${A.toUpperCase()}\tHEAD\n`,
        `ref: refs/heads/main\tHEAD\n${A}\trefs/heads/main\n`,
        `${A}\tHEAD\nref: refs/heads/main\tHEAD\n`,
        `ref: refs/heads/ma in\tHEAD\n${A}\tHEAD\n`,
        `ref: refs/heads/main;evil\tHEAD\n${A}\tHEAD\n`,
        `ref: refs/heads/-main\tHEAD\n${A}\tHEAD\n`,
    ];
    for (const output of malformed) {
        assert.throws(() => parseSymbolicHead(output, 'example'), /example:/, JSON.stringify(output));
        const remote = fakeRemote({ [AGENTLIB_URL]: output, [MCP_SDK_URL]: head('main', B) });
        assert.throws(() => resolveLibraries({}, remote.run), JSON.stringify(output));
    }
    assert.deepEqual(parseSymbolicHead(head('release/2026.1', A)), { branch: 'release/2026.1', commit: A });
    const failing = () => { throw new Error('git ls-remote failed'); };
    assert.throws(() => resolveLibraries({}, failing), /git ls-remote failed/);
});

test('workflow outputs freeze repository, branch, and commit for both libraries', () => {
    const selections = resolveLibraries({ mcpSdkCommit: B }, fakeRemote({ [AGENTLIB_URL]: head('master', A) }).run);
    assert.equal(formatOutputs(selections), [
        'agentlib_repository=AssistOS-AI/AchillesAgentLib',
        `agentlib_url=${AGENTLIB_URL}`,
        'agentlib_branch=master',
        `agentlib_commit=${A}`,
        'mcp_sdk_repository=AssistOS-AI/MCPSDK',
        `mcp_sdk_url=${MCP_SDK_URL}`,
        'mcp_sdk_branch=',
        `mcp_sdk_commit=${B}`,
        '',
    ].join('\n'));
});

function fakeGit(t, responses) {
    const root = scratch(t, 'box-resolve-');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.GIT_LOG, JSON.stringify({ args, header: process.env.GIT_CONFIG_VALUE_0 || null, cwd: process.cwd() }) + '\\n');
      const response = JSON.parse(process.env.GIT_RESPONSES)[args[2]];
      if (response === undefined) {
        process.stderr.write('fatal: repository ' + args[2] + ' not found\\n');
        process.exit(2);
      }
      process.stdout.write(response);
    `, { mode: 0o755 });
    const env = {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_LOG: path.join(root, 'git.jsonl'),
        GIT_RESPONSES: JSON.stringify(responses), GITHUB_OUTPUT: path.join(root, 'output'),
        LIBRARY_INPUTS_FILE: path.join(root, 'library-inputs.json'),
    };
    delete env.SOURCE_REPO_TOKEN;
    delete env.AGENTLIB_COMMIT;
    delete env.MCP_SDK_COMMIT;
    const run = (extra = {}) => spawnSync(process.execPath, [path.join(IMAGE, 'resolve-libraries.mjs')], {
        env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000,
    });
    const calls = () => (fs.existsSync(env.GIT_LOG) ? fs.readFileSync(env.GIT_LOG, 'utf8').trim().split('\n').map(JSON.parse) : []);
    return { root, env, run, calls };
}

test('the resolver command line writes the frozen outputs and evidence once', (t) => {
    const f = fakeGit(t, { [AGENTLIB_URL]: head('master', A), [MCP_SDK_URL]: head('main', B) });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().length, 2);
    assert.match(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`agentlib_branch=master\\nagentlib_commit=${A}\\n`));
    const evidence = JSON.parse(fs.readFileSync(f.env.LIBRARY_INPUTS_FILE, 'utf8'));
    assert.deepEqual(evidence, {
        schema: 'ploinky.box.library-inputs/v1',
        libraries: {
            achillesAgentLib: { repository: AGENTLIB_URL, branch: 'master', commit: A },
            'mcp-sdk': { repository: MCP_SDK_URL, branch: 'main', commit: B },
        },
    });
});

test('the resolver fails closed and publishes no output for a malformed response or invalid input', (t) => {
    const f = fakeGit(t, { [AGENTLIB_URL]: `${A}\tHEAD\n`, [MCP_SDK_URL]: head('main', B) });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a symbolic reference|expected exactly one/);
    assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
    const invalid = fakeGit(t, {}).run({ AGENTLIB_COMMIT: 'master' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /AGENTLIB_COMMIT/);
});

test('a failing remote query is reported with Git\'s own reason and publishes no output', (t) => {
    const f = fakeGit(t, { [AGENTLIB_URL]: head('master', A) });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /git ls-remote failed with status 2: fatal: repository https:\/\/github\.com\/AssistOS-AI\/MCPSDK\.git not found/);
    assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
});

test('repository credentials reach Git only through its environment, never its arguments', (t) => {
    const token = 'secret-token-value';
    const f = fakeGit(t, { [AGENTLIB_URL]: head('master', A), [MCP_SDK_URL]: head('main', B) });
    assert.equal(f.run({ SOURCE_REPO_TOKEN: token }).status, 0);
    for (const call of f.calls()) {
        assert.equal(call.args.join(' ').includes(token), false);
        assert.equal(Buffer.from(call.header.split('basic ')[1], 'base64').toString(), `x-access-token:${token}`);
        // Outside any checkout, so a header another step persisted in a repository's
        // local configuration can never be sent alongside this one.
        assert.equal(call.cwd, fs.realpathSync(os.tmpdir()));
        assert.equal(call.cwd.startsWith(fs.realpathSync(ROOT)), false);
    }
    fs.rmSync(f.env.GIT_LOG);
    fs.rmSync(f.env.GITHUB_OUTPUT);
    fs.rmSync(f.env.LIBRARY_INPUTS_FILE);
    assert.equal(f.run().status, 0);
    assert.ok(f.calls().every((call) => call.header === null));
    assert.equal(typeof gitRunner({}), 'function');
});

// ---------------------------------------------------------------------------
// Workflow shape
// ---------------------------------------------------------------------------

const jobOf = (name, next) => workflow.match(new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  ${next}:|$)`))?.[0] || '';
const resolveJob = jobOf('resolve-source', 'build');
const buildJob = jobOf('build', 'merge');
const mergeJob = jobOf('merge', 'promote');

test('exact library commits are optional inputs and the prerequisite job freezes both selections', () => {
    for (const input of ['agentlib_commit', 'mcp_sdk_commit']) {
        assert.match(workflow, new RegExp(`\\n      ${input}:\\n        description: [^\\n]+\\n        required: false\\n        type: string\\n        default: ''`));
    }
    assert.match(resolveJob, /AGENTLIB_COMMIT: \$\{\{ inputs\.agentlib_commit \}\}/);
    assert.match(resolveJob, /MCP_SDK_COMMIT: \$\{\{ inputs\.mcp_sdk_commit \}\}/);
    assert.equal(resolveJob.match(/node images\/ploinky-box\/resolve-libraries\.mjs/g)?.length, 1);
    for (const name of [
        'source_sha', 'agentlib_repository', 'agentlib_url', 'agentlib_branch', 'agentlib_commit',
        'mcp_sdk_repository', 'mcp_sdk_url', 'mcp_sdk_branch', 'mcp_sdk_commit',
    ]) {
        const producer = name === 'source_sha' ? 'input' : 'libraries';
        assert.ok(resolveJob.includes(`      ${name}: \${{ steps.${producer}.outputs.${name} }}`), `missing output ${name}`);
    }
    assert.match(resolveJob, /ploinky-box-library-inputs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    // The resolver sends its own repository credential; the checkout must not persist a second one.
    assert.match(resolveJob, /- name: Checkout image definitions\n\s+uses: actions\/checkout@[0-9a-f]{40} # v4\n\s+with:\n\s+persist-credentials: false\n/);
});

test('build and merge jobs never resolve a library: they consume only the frozen 40-hex outputs', () => {
    assert.doesNotMatch(workflow, /ls-remote|--symref/);
    assert.equal(workflow.match(/resolve-libraries/g)?.length, 1, 'the resolver runs only in the prerequisite job');
    for (const job of [buildJob, mergeJob]) {
        assert.doesNotMatch(job, /resolve-libraries|ls-remote|git (?:fetch|pull|clone)|--symref/);
    }
    // Every checkout revision is an exact, prerequisite-frozen commit output.
    const refs = [...workflow.matchAll(/\n\s+ref: (.+)/g)].map((match) => match[1]);
    assert.ok(refs.length >= 4);
    for (const ref of refs) {
        assert.match(ref, /^\$\{\{ needs\.resolve-source\.outputs\.(?:source_sha|agentlib_commit|mcp_sdk_commit) \}\}$/);
    }
    // Both architecture entries share the one job definition and therefore the same outputs.
    assert.match(buildJob, /matrix:\n\s+include:\n\s+- arch: amd64[\s\S]*?- arch: arm64/);
    for (const line of buildJob.split('\n').filter((entry) => /agentlib|mcp_sdk|AGENTLIB|MCP_SDK/.test(entry))) {
        assert.doesNotMatch(line, /matrix\./, line);
    }
    for (const variable of ['SOURCE_SHA', 'MCP_SDK_SHA', 'AGENTLIB_SHA']) {
        assert.ok(buildJob.includes(`[[ "$${variable}" =~ ^[0-9a-f]{40}$ ]]`), `${variable} is not required to be a commit`);
    }
    assert.match(buildJob, /repository: \$\{\{ needs\.resolve-source\.outputs\.agentlib_repository \}\}/);
    assert.match(buildJob, /repository: \$\{\{ needs\.resolve-source\.outputs\.mcp_sdk_repository \}\}/);
});

test('library provenance enters the build as arguments and evidence, never as image labels', () => {
    for (const name of ['AGENTLIB_REPOSITORY', 'AGENTLIB_BRANCH', 'AGENTLIB_COMMIT', 'MCP_SDK_REPOSITORY', 'MCP_SDK_BRANCH', 'MCP_SDK_COMMIT']) {
        assert.match(buildJob, new RegExp(`\\n\\s+${name}=\\$\\{\\{ needs\\.resolve-source\\.outputs\\.[a-z_]+ \\}\\}`));
        assert.match(mergeJob, new RegExp(`\\n\\s+${name}: \\$\\{\\{ needs\\.resolve-source\\.outputs\\.[a-z_]+ \\}\\}`));
    }
    assert.doesNotMatch(buildJob, /\blabels:|--label/);
    assert.doesNotMatch(fs.readFileSync(path.join(IMAGE, 'Dockerfile'), 'utf8'), /^LABEL\s/m);
    for (const file of ['library-smoke.json', 'library-self-test.json', 'library-provenance.json']) {
        assert.ok(buildJob.includes(`"$evidence/${file}"`), `${file} is not collected`);
    }
});

function runScripts() {
    // Every multi-line shell step of the workflow, as the runner would receive it.
    return workflow.split('\n      - name: ').slice(1).flatMap((chunk) => {
        const name = chunk.split('\n')[0];
        const body = chunk.split('        run: |\n')[1];
        if (body === undefined) return [];
        const lines = [];
        for (const line of body.split('\n')) {
            if (line !== '' && !line.startsWith('          ')) break;
            lines.push(line.startsWith('          ') ? line.slice(10) : line);
        }
        return [{ name, script: lines.join('\n') }];
    });
}

test('every shell step of the workflow is syntactically valid', () => {
    const scripts = runScripts();
    assert.ok(scripts.length >= 8);
    for (const { name, script } of scripts) {
        const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
});

test('the native evidence step collects the smoke, the self-test, and both provenance records', (t) => {
    const native = runScripts().find(({ name }) => name === 'Verify immutable native WebTTY runtime').script;
    assert.match(native, /smoke-libraries\.mjs smoke \\\n\s+> "\$evidence\/library-smoke\.json"/);
    assert.match(native, /smoke-libraries\.mjs self-test \\\n\s+> "\$evidence\/library-self-test\.json"/);
    // Run the provenance collector against fixture files at the image paths it reads.
    const snippet = native.match(/"\$\{runtime\[@\]\}" "\$image" --input-type=module -e '\n([\s\S]*?)\n' > "\$evidence\/library-provenance\.json"/)[1];
    const root = scratch(t);
    const agentlib = path.join(root, 'agentlib.json');
    const sdk = path.join(root, 'sdk.json');
    fs.writeFileSync(agentlib, JSON.stringify({ library: 'achillesAgentLib' }));
    fs.writeFileSync(sdk, JSON.stringify({ library: 'mcp-sdk' }));
    const source = snippet.replace('/usr/local/share/ploinky/agentlib/runtime-contract.json', agentlib)
        .replace('/usr/local/lib/ploinky/mcp-sdk/.ploinky-box-mcp-sdk.json', sdk);
    assert.notEqual(source, snippet);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { achillesAgentLib: { library: 'achillesAgentLib' }, 'mcp-sdk': { library: 'mcp-sdk' } });
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

function agentLibRepo(t, options = {}) {
    const root = scratch(t, 'box-agentlib-');
    const source = path.join(root, 'source');
    writeAgentLibFixture(source, options);
    if (options.extra) options.extra(source);
    const commit = commitAll(source);
    return { root, source, commit, metadata: path.join(root, 'metadata/runtime-contract.json') };
}

const prepareAgentLib = (f, overrides = {}) => prepareLibrary({
    library: 'achillesAgentLib', source: f.source, metadata: f.metadata, repository: AGENTLIB_URL,
    branch: 'master', commit: f.commit, ...overrides,
});

const listFiles = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !`${entry.parentPath}`.includes(`${path.sep}.git`))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort();

test('AgentLib preparation seals the exact clean checkout and writes generated provenance', (t) => {
    const f = agentLibRepo(t);
    const before = listFiles(f.source);
    const record = prepareAgentLib(f);
    assert.deepEqual(record, {
        schema: 'ploinky.box.library/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3', repository: AGENTLIB_URL, branch: 'master', commit: f.commit,
    });
    assert.equal(fs.readFileSync(f.metadata, 'utf8'), `${JSON.stringify(record, null, 2)}\n`);
    assert.equal(fs.statSync(f.metadata).mode & 0o777, 0o644 & ~process.umask());
    assert.equal(fs.existsSync(path.join(f.source, '.git')), false);
    assert.deepEqual(listFiles(f.source), before.filter((name) => !name.startsWith('.git')), 'no source file changed');
    assert.equal(fs.readFileSync(path.join(f.source, 'LICENSE'), 'utf8'), 'MIT License fixture\n');
    assert.equal(fs.existsSync(path.join(f.source, 'runtime-contract.json')), false, 'provenance stays outside the package');
    assert.throws(() => prepareAgentLib(f), /checkout|git/, 'a prepared tree cannot be prepared again');
});

test('an explicit-commit selection records a null branch', (t) => {
    const f = agentLibRepo(t);
    assert.equal(prepareAgentLib(f, { branch: '' }).branch, null);
    const g = agentLibRepo(t);
    assert.equal(prepareAgentLib(g, { branch: null }).branch, null);
});

test('preparation refuses a checkout that is not exactly the selected clean commit', (t) => {
    const f = agentLibRepo(t);
    assert.throws(() => prepareAgentLib(f, { commit: 'c'.repeat(40) }), /expected c{40}/);
    fs.appendFileSync(path.join(f.source, 'README.md'), 'edited\n');
    assert.throws(() => prepareAgentLib(f), /not clean/);
    git(f.source, 'checkout', '--', 'README.md');
    fs.writeFileSync(path.join(f.source, 'stray.txt'), 'untracked\n');
    assert.throws(() => prepareAgentLib(f), /not clean/);
    fs.rmSync(path.join(f.source, 'stray.txt'));
    fs.writeFileSync(path.join(f.source, '.gitignore'), 'ignored.txt\n');
    git(f.source, 'add', '.gitignore');
    git(f.source, 'commit', '-q', '-m', 'ignore');
    fs.writeFileSync(path.join(f.source, 'ignored.txt'), 'ignored\n');
    assert.throws(() => prepareAgentLib(f, { commit: git(f.source, 'rev-parse', 'HEAD') }), /not clean/);
    assert.equal(fs.existsSync(f.metadata), false);
    assert.equal(fs.existsSync(path.join(f.source, '.git')), true, 'a failed preparation leaves the checkout inspectable');
});

test('preparation validates the selected repository, branch, and provenance location', (t) => {
    const f = agentLibRepo(t);
    assert.throws(() => prepareAgentLib(f, { repository: MCP_SDK_URL }), /not the selected repository/);
    assert.throws(() => prepareAgentLib(f, { repository: 'https://token@github.com/AssistOS-AI/AchillesAgentLib.git' }), /repository/);
    assert.throws(() => prepareAgentLib(f, { branch: 'a b' }), /branch/);
    assert.throws(() => prepareAgentLib(f, { branch: 'main\ncommit=evil' }), /branch/);
    assert.throws(() => prepareAgentLib(f, { commit: 'main' }), /40-character commit/);
    assert.throws(() => prepareAgentLib(f, { metadata: path.join(f.source, 'runtime-contract.json') }), /outside the package/);
    assert.equal(fs.existsSync(path.join(f.source, '.git')), true);
});

test('AgentLib preparation requires every entry Ploinky consumes and a dependency-free package', (t) => {
    for (const entry of ACHILLES_REQUIRED_ENTRIES.filter((name) => name !== 'package.json')) {
        const f = agentLibRepo(t, { omit: [entry] });
        assert.throws(() => prepareAgentLib(f), new RegExp(`missing required entry ${entry.replaceAll('.', '\\.')}`), entry);
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const f = agentLibRepo(t, { packageJson: { [field]: { left: '1.0.0' } } });
        assert.throws(() => prepareAgentLib(f), new RegExp(`declares ${field}`));
    }
    assert.throws(() => prepareAgentLib(agentLibRepo(t, { packageJson: { name: 'other' } })), /must be ploinky-agent-lib/);
    assert.throws(() => prepareAgentLib(agentLibRepo(t, { packageJson: { version: '' } })), /no version/);
});

test('preparation preserves license files and refuses to drop a declared license', (t) => {
    const withNotice = agentLibRepo(t, { override: { 'NOTICE.md': 'notice\n', 'docs/LICENSE-third-party': 'third party\n' } });
    prepareAgentLib(withNotice);
    for (const name of ['LICENSE', 'NOTICE.md', 'docs/LICENSE-third-party']) {
        assert.equal(fs.existsSync(path.join(withNotice.source, name)), true, name);
    }
    const missing = agentLibRepo(t, { omit: ['LICENSE'] });
    assert.throws(() => prepareAgentLib(missing), /declares license MIT but ships no license file/);
    const undeclared = agentLibRepo(t, { license: false });
    assert.doesNotThrow(() => prepareAgentLib(undeclared));
});

test('symlinks that escape the AgentLib package are rejected and internal ones are kept', (t) => {
    const escaping = agentLibRepo(t, { extra: (source) => fs.symlinkSync('../outside', path.join(source, 'escape')) });
    assert.throws(() => prepareAgentLib(escaping), /symlink escaping the package: escape/);
    const internal = agentLibRepo(t, { extra: (source) => fs.symlinkSync('README.md', path.join(source, 'readme-link')) });
    assert.doesNotThrow(() => prepareAgentLib(internal));
    assert.equal(fs.readlinkSync(path.join(internal.source, 'readme-link')), 'README.md');
});

function sdkRepo(t, options = {}) {
    const root = scratch(t, 'box-sdk-');
    const source = path.join(root, 'source');
    writeSdkFixture(source, options);
    if (options.extra) options.extra(source);
    return { root, source, commit: commitAll(source), metadata: path.join(source, '.ploinky-box-mcp-sdk.json') };
}

const prepareSdk = (f, overrides = {}) => prepareLibrary({
    library: 'mcp-sdk', source: f.source, metadata: f.metadata, repository: MCP_SDK_URL, branch: '', commit: f.commit, ...overrides,
});

test('MCP SDK preparation records provenance beside the package and ships no runtime dependency', (t) => {
    const f = sdkRepo(t);
    const record = prepareSdk(f);
    assert.deepEqual(record, {
        schema: 'ploinky.box.library/v1', library: 'mcp-sdk', packageName: '@modelcontextprotocol/sdk',
        packageVersion: '1.19.1', repository: MCP_SDK_URL, branch: null, commit: f.commit,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.metadata, 'utf8')), record);
    assert.equal(fs.existsSync(path.join(f.source, '.git')), false);
    assert.throws(() => prepareSdk(sdkRepo(t), { metadata: path.join(os.tmpdir(), 'sdk-provenance.json') }), /\.ploinky-box-mcp-sdk\.json in the package root/);
    assert.throws(() => prepareSdk(sdkRepo(t, { name: 'mcp-sdk' })), /must be @modelcontextprotocol\/sdk/);
    assert.throws(() => prepareSdk(sdkRepo(t, { exportsMap: {} })), /exports\["\."\]/);
    assert.throws(() => prepareSdk(sdkRepo(t, { exportsMap: { '.': './missing.mjs' } })), /missing required entry missing\.mjs/);
    assert.throws(() => prepareSdk(sdkRepo(t, { extra: (source) => fs.symlinkSync('index.mjs', path.join(source, 'alias.mjs')) })), /must not contain symlinks/);
});

test('the preparation command line prepares a library and rejects incomplete arguments', (t) => {
    const f = sdkRepo(t);
    const script = path.join(IMAGE, 'prepare-libraries.mjs');
    const args = ['prepare', 'mcp-sdk', '--source', f.source, '--metadata', f.metadata,
        '--repository', MCP_SDK_URL, '--branch', '', '--commit', f.commit];
    const ok = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).commit, f.commit);
    for (const broken of [args.slice(0, -2), ['prepare', 'other', ...args.slice(2)], ['verify', ...args.slice(1)]]) {
        const result = spawnSync(process.execPath, [script, ...broken], { encoding: 'utf8', timeout: 30000 });
        assert.notEqual(result.status, 0);
    }
    assert.deepEqual(parsePrepareArguments(args), {
        library: 'mcp-sdk', source: f.source, metadata: f.metadata, repository: MCP_SDK_URL, branch: '', commit: f.commit,
    });
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

async function assertRejects(promise, name) {
    await assert.rejects(promise, (error) => error instanceof LibrarySmokeError && error.message.includes(name), name);
}

const exportStub = (name, kind) => (kind === 'number' ? `export const ${name} = 1;\n` : `export function ${name}() {}\n`);

test('the AgentLib smoke exercises every consumed module, export, and the offline JWT round trip', async (t) => {
    const root = writeAgentLibFixture(path.join(scratch(t), 'agentlib'));
    const result = await smokeAchillesAgentLib(root);
    assert.deepEqual(result, {
        packageName: 'ploinky-agent-lib', packageVersion: '1.2.3', requiredEntries: [...ACHILLES_REQUIRED_ENTRIES],
        checks: ['imports', 'exports', 'isOptOutModel', 'jwt-round-trip'],
    });
    // The responder module is a required entry, alongside the modules the index does not re-export.
    assert.ok(ACHILLES_REQUIRED_ENTRIES.includes('LLMAgents/openAiAgenticResponder.mjs'));
    assert.deepEqual(ACHILLES_MODULES.find((entry) => entry.subpath === 'LLMAgents/openAiAgenticResponder.mjs').exports,
        { isOptOutModel: 'function', runOpenAiAgenticResponse: 'function' });
});

test('the AgentLib smoke rejects every missing module and every missing or mistyped export by name', async (t) => {
    for (const entry of ACHILLES_REQUIRED_ENTRIES) {
        const root = writeAgentLibFixture(path.join(scratch(t), 'agentlib'), { omit: [entry] });
        await assertRejects(smokeAchillesAgentLib(root), entry);
    }
    for (const { subpath, exports } of ACHILLES_MODULES) {
        for (const missing of Object.keys(exports)) {
            const content = Object.entries(exports).filter(([name]) => name !== missing)
                .map(([name, kind]) => exportStub(name, kind)).join('');
            const root = writeAgentLibFixture(path.join(scratch(t), 'agentlib'), { override: { [subpath]: content } });
            await assertRejects(smokeAchillesAgentLib(root), `'${missing}'`);
            const wrongKind = writeAgentLibFixture(path.join(scratch(t), 'agentlib'), {
                override: { [subpath]: Object.entries(exports).map(([name, kind]) => (name === missing
                    ? `export const ${name} = ${kind === 'number' ? '"x"' : '"x"'};\n` : exportStub(name, kind))).join('') },
            });
            await assertRejects(smokeAchillesAgentLib(wrongKind), `'${missing}'`);
        }
    }
    const unloadable = writeAgentLibFixture(path.join(scratch(t), 'agentlib'), { override: { 'utils/LLMClient.mjs': 'throw new Error("init");\n' } });
    await assertRejects(smokeAchillesAgentLib(unloadable), 'utils/LLMClient.mjs');
});

test('the AgentLib smoke rejects a wrong package identity, a non-boolean opt-out, and lax JWT verification', async (t) => {
    await assertRejects(smokeAchillesAgentLib(writeAgentLibFixture(path.join(scratch(t), 'a'), { packageJson: { name: 'other' } })), 'other');
    await assertRejects(smokeAchillesAgentLib(writeAgentLibFixture(path.join(scratch(t), 'a'), { packageJson: { version: undefined } })), 'no version');
    const optOut = 'export function isOptOutModel() { return "yes"; }\nexport async function runOpenAiAgenticResponse() {}\n';
    await assertRejects(smokeAchillesAgentLib(writeAgentLibFixture(path.join(scratch(t), 'a'), {
        override: { 'LLMAgents/openAiAgenticResponder.mjs': optOut },
    })), 'did not return a boolean');
    // A verifier that accepts everything must be caught by the replay and wrong-secret checks.
    const accepting = `export const MAX_TTL_SECONDS = 1;
export const DEFAULT_CLOCK_SKEW_SECONDS = 1;
export function canonicalJson() {}
export function bodyHashForRequest() {}
export function verifyJws() {}
export function createMemoryReplayCache() {}
export function verifyInvocationToken() {}
`;
    await assertRejects(smokeAchillesAgentLib(writeAgentLibFixture(path.join(scratch(t), 'a'), {
        override: { 'jwt/jwtVerify.mjs': accepting },
    })), 'accepted a replayed token');
});

test('provenance is diagnostic: inspect reports it when valid and never fails without it', async (t) => {
    const root = scratch(t);
    const library = writeAgentLibFixture(path.join(root, 'agentlib'));
    const metadata = path.join(root, 'runtime-contract.json');
    const record = {
        schema: 'ploinky.box.library/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3', repository: AGENTLIB_URL, branch: null, commit: A,
    };
    fs.writeFileSync(metadata, JSON.stringify(record));
    const inspected = await inspectAchillesAgentLib({ agentlibRoot: library, agentlibMetadata: metadata, protectedLayout: false });
    assert.deepEqual(inspected, {
        schema: 'ploinky.box.library-inspect/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3', provenance: record,
    });
    for (const broken of [
        undefined, '{', '[]', JSON.stringify({ ...record, schema: 'ploinky.box.library/v0' }),
        JSON.stringify({ ...record, commit: 'main' }), JSON.stringify({ ...record, branch: '' }),
        JSON.stringify({ ...record, library: 'mcp-sdk' }), JSON.stringify({ ...record, packageVersion: '' }),
        JSON.stringify({ ...record, fingerprint: '0'.repeat(64) }).replace('"commit"', '"commit_"'),
    ]) {
        if (broken === undefined) fs.rmSync(metadata, { force: true }); else fs.writeFileSync(metadata, broken);
        const result = await inspectAchillesAgentLib({ agentlibRoot: library, agentlibMetadata: metadata, protectedLayout: false });
        assert.equal(result.provenance, null, String(broken));
        assert.match(result.provenanceProblem, /provenance record/);
        assert.equal(result.packageVersion, '1.2.3', 'a usable package is reported without provenance');
    }
    // Extra provenance fields never become a requirement or a reported identity.
    fs.writeFileSync(metadata, JSON.stringify({ ...record, note: 'x', fingerprint: '0'.repeat(64) }));
    assert.deepEqual(readProvenance(metadata, 'achillesAgentLib', 'ploinky-agent-lib').record, record);
    // The package itself still has to be usable.
    fs.rmSync(path.join(library, 'jwt/jwtSign.mjs'));
    await assertRejects(inspectAchillesAgentLib({ agentlibRoot: library, agentlibMetadata: metadata, protectedLayout: false }), 'jwt/jwtSign.mjs');
});

test('the MCP SDK smoke checks every member, a zod schema, and a loopback tool call', async (t) => {
    const root = writeSdkFixture(path.join(scratch(t), 'sdk'));
    const result = await smokeMcpSdk(root);
    assert.deepEqual(result.members, MCP_SDK_MEMBERS.map(({ member }) => member));
    assert.deepEqual(result.checks, ['imports', 'exports', 'zod-schema', 'loopback-tool-call']);
    assert.equal(result.entry, './index.mjs');
    assert.deepEqual(MCP_SDK_MEMBERS.map(({ member }) => member).filter((member) => member.startsWith('zod.z.')).map((member) => member.slice(6)),
        ['object', 'array', 'string', 'number', 'boolean', 'null', 'literal', 'union', 'any', 'unknown']);
});

test('the MCP SDK smoke rejects each missing member and a broken package by name', async (t) => {
    for (const { member } of MCP_SDK_MEMBERS) {
        const root = writeSdkFixture(path.join(scratch(t), 'sdk'), { without: member });
        await assertRejects(checkMcpSdk(root), member);
    }
    await assertRejects(checkMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { name: 'mcp-sdk' })), "'mcp-sdk'");
    await assertRejects(checkMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { exportsMap: {} })), 'exports["."]');
    await assertRejects(checkMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { exportsMap: { '.': './gone.mjs' } })), './gone.mjs'.slice(2));
    await assertRejects(checkMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { entry: 'throw new Error("boom");\n' })), './index.mjs');
    const wrongResult = sdkEntry().replace('send(await this.server.tools.get(body.params.name).callback(body.params.arguments));',
        "send({ content: [{ type: 'text', text: 'wrong' }] });");
    assert.notEqual(wrongResult, sdkEntry());
    await assertRejects(smokeMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { entry: wrongResult })), 'wrong result');
    const noTool = sdkEntry().replace("send({ tools: [...this.server.tools.keys()].map((name) => ({ name })) });", 'send({ tools: [] });');
    assert.notEqual(noTool, sdkEntry());
    await assertRejects(smokeMcpSdk(writeSdkFixture(path.join(scratch(t), 'sdk'), { entry: noTool })), 'did not list the tool');
});

test('a protected layout is enforced on the packaged trees and can be relaxed only explicitly', async (t) => {
    const root = scratch(t);
    const agentlibRoot = writeAgentLibFixture(path.join(root, 'agentlib'));
    const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
    if (process.getuid() !== 0) {
        assert.throws(() => assertProtectedLayout(agentlibRoot, 'achillesAgentLib package'), /owned by root/);
        await assert.rejects(runSmoke({ agentlibRoot, mcpSdkRoot }), /owned by root/);
    }
    const result = await runSmoke({ agentlibRoot, mcpSdkRoot, protectedLayout: false });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.libraries), ['achillesAgentLib', 'mcp-sdk']);
    assert.equal(result.schema, 'ploinky.box.library-smoke/v1');
    // The relaxation is recorded, so publication evidence cannot pass it off as a protected run.
    assert.equal(result.protectedLayout, false);
    const layout = { owner: process.getuid(), boundary: root };
    assert.equal((await runSmoke({ agentlibRoot, mcpSdkRoot, layout })).protectedLayout, true);
});

// ---------------------------------------------------------------------------
// The protected layout and the structure come before any library code runs
// ---------------------------------------------------------------------------

const MARKER = 'BOX_LIBRARIES_MARKER';
const SMOKE_SCRIPT = path.join(IMAGE, 'smoke-libraries.mjs');
// Fixtures belong to the test user, so the layout check names that user instead of root.
const ownLayout = (root) => ({ owner: process.getuid(), boundary: root });

/** An AgentLib package whose modules each record that they ran, so a test can prove none did. */
function tracedAgentLib(directory, options = {}) {
    writeAgentLibFixture(directory, options);
    for (const { subpath } of ACHILLES_MODULES) {
        const file = path.join(directory, subpath);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
        const trace = `import { appendFileSync as ranTrace } from 'node:fs';\n`
            + `if (process.env.${MARKER}) ranTrace(process.env.${MARKER}, ${JSON.stringify(`${subpath}\n`)});\n`;
        fs.writeFileSync(file, trace + fs.readFileSync(file, 'utf8'));
    }
    return directory;
}

function runLibraryCommand(t, args) {
    const marker = path.join(scratch(t, 'box-marker-'), 'ran.txt');
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT, ...args], {
        encoding: 'utf8', timeout: 60000, env: { ...process.env, [MARKER]: marker },
    });
    return { result, ran: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [] };
}

const commandArguments = (command, agentlibRoot, mcpSdkRoot, extra = []) => (command === 'inspect'
    ? ['inspect', 'achillesAgentLib', '--agentlib-root', agentlibRoot, '--agentlib-metadata', path.join(path.dirname(agentlibRoot), 'absent.json'), ...extra]
    : ['smoke', '--agentlib-root', agentlibRoot, '--mcp-sdk-root', mcpSdkRoot, ...extra]);

test('confined internal AgentLib symlinks survive packaging, the protected layout check, and the smoke', async (t) => {
    const f = agentLibRepo(t, {
        extra: (source) => {
            fs.symlinkSync('README.md', path.join(source, 'readme-link'));
            fs.symlinkSync('openAiAgenticResponder.mjs', path.join(source, 'LLMAgents/responder-link.mjs'));
            fs.symlinkSync('jwt', path.join(source, 'jwt-alias'));
            fs.symlinkSync('../LICENSE', path.join(source, 'jwt/license-link'));
        },
    });
    const mcpSdkRoot = writeSdkFixture(path.join(f.root, 'sdk'));
    const layout = ownLayout(f.root);
    const record = prepareAgentLib(f);
    assert.equal(fs.readlinkSync(path.join(f.source, 'readme-link')), 'README.md');
    assert.equal(fs.readlinkSync(path.join(f.source, 'jwt-alias')), 'jwt');
    assert.doesNotThrow(() => assertProtectedLayout(f.source, 'achillesAgentLib package', { ...layout, allowSymlinks: true }));
    const smoke = await runSmoke({ agentlibRoot: f.source, mcpSdkRoot, layout });
    assert.equal(smoke.ok, true);
    const inspected = await inspectAchillesAgentLib({ agentlibRoot: f.source, agentlibMetadata: f.metadata, layout });
    assert.deepEqual(inspected.provenance, record);
    // Symlinks are an AchillesAgentLib allowance: the same tree under the default rule is refused.
    assert.throws(() => assertProtectedLayout(f.source, 'package', layout), /must not contain symlinks/);
});

test('the MCP SDK keeps its no-symlink rule in the protected layout', async (t) => {
    const root = scratch(t);
    const agentlibRoot = writeAgentLibFixture(path.join(root, 'agentlib'));
    const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
    const layout = ownLayout(root);
    assert.equal((await runSmoke({ agentlibRoot, mcpSdkRoot, layout })).ok, true);
    fs.symlinkSync('index.mjs', path.join(mcpSdkRoot, 'alias.mjs'));
    await assert.rejects(runSmoke({ agentlibRoot, mcpSdkRoot, layout }), /mcp-sdk package must not contain symlinks/);
    // A caller-supplied layout can never re-enable symlinks for the SDK.
    await assert.rejects(runSmoke({ agentlibRoot, mcpSdkRoot, layout: { ...layout, allowSymlinks: true } }), /must not contain symlinks/);
});

test('escaping, absolute, dangling-outside, directory, and chained symlinks are rejected before any module runs', async (t) => {
    const links = {
        'relative-escape': (root) => ['../outside/secret.txt'],
        'absolute-escape': (root) => [path.join(root, 'outside/secret.txt')],
        'dangling-outside': () => ['../outside/missing'],
        'directory-escape': () => ['../outside'],
        'parent-of-package': () => ['..'],
        'chain-escape': (root, agentlib) => {
            fs.symlinkSync('../outside/secret.txt', path.join(agentlib, 'hop-two'));
            return ['hop-two'];
        },
    };
    for (const [name, target] of Object.entries(links)) {
        const root = scratch(t);
        fs.mkdirSync(path.join(root, 'outside'));
        fs.writeFileSync(path.join(root, 'outside/secret.txt'), 'outside\n');
        const agentlibRoot = tracedAgentLib(path.join(root, 'agentlib'));
        const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
        fs.symlinkSync(target(root, agentlibRoot)[0], path.join(agentlibRoot, name));
        const marker = path.join(root, 'ran.txt');
        process.env[MARKER] = marker;
        try {
            const expected = new RegExp(`symlink escaping the package: ${name === 'chain-escape' ? 'hop-two|chain-escape' : name}`);
            await assert.rejects(runSmoke({ agentlibRoot, mcpSdkRoot, layout: ownLayout(root) }), expected, name);
            await assert.rejects(inspectAchillesAgentLib({ agentlibRoot, layout: ownLayout(root) }), expected, name);
        } finally {
            delete process.env[MARKER];
        }
        assert.equal(fs.existsSync(marker), false, `${name}: library code ran`);
    }
});

test('the layout still rejects a foreign owner, a writable entry or parent, and Git metadata beside symlinks', (t) => {
    const root = scratch(t);
    const source = writeAgentLibFixture(path.join(root, 'agentlib'));
    fs.symlinkSync('README.md', path.join(source, 'readme-link'));
    const options = { ...ownLayout(root), allowSymlinks: true };
    const check = (overrides = {}) => assertProtectedLayout(source, 'achillesAgentLib package', { ...options, ...overrides });
    assert.doesNotThrow(() => check());
    assert.throws(() => check({ owner: process.getuid() + 1 }), /owned by root/);
    const guarded = (target, modes, message) => {
        const original = fs.statSync(target).mode & 0o777;
        try {
            for (const mode of modes) {
                fs.chmodSync(target, mode);
                assert.throws(() => check(), message, `${target} ${mode.toString(8)}`);
            }
        } finally {
            fs.chmodSync(target, original);
        }
    };
    guarded(path.join(source, 'README.md'), [0o664, 0o646, 0o666], /not writable/);
    guarded(path.join(source, 'jwt'), [0o775, 0o757], /not writable/);
    guarded(source, [0o775], /not writable/);
    guarded(root, [0o775], /not writable/);
    fs.mkdirSync(path.join(source, '.git'));
    assert.throws(() => check(), /must not contain Git metadata/);
    fs.rmSync(path.join(source, '.git'), { recursive: true });
    assert.doesNotThrow(() => check());
    // Without an owner override the layout is root-owned only; a test user's files are refused.
    if (process.getuid() !== 0) assert.throws(() => assertProtectedLayout(source, 'achillesAgentLib package', { allowSymlinks: true }), /owned by root/);
});

test('inspect keeps its exact JSON shape on a valid protected package', async (t) => {
    const root = scratch(t);
    const agentlibRoot = writeAgentLibFixture(path.join(root, 'agentlib'));
    const metadata = path.join(root, 'runtime-contract.json');
    const record = {
        schema: 'ploinky.box.library/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3', repository: AGENTLIB_URL, branch: 'master', commit: A,
    };
    fs.writeFileSync(metadata, JSON.stringify(record));
    const layout = ownLayout(root);
    const withProvenance = await inspectAchillesAgentLib({ agentlibRoot, agentlibMetadata: metadata, layout });
    assert.deepEqual(Object.keys(withProvenance), ['schema', 'library', 'packageName', 'packageVersion', 'provenance']);
    assert.deepEqual(withProvenance, {
        schema: 'ploinky.box.library-inspect/v1', library: 'achillesAgentLib', packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3', provenance: record,
    });
    fs.rmSync(metadata);
    const without = await inspectAchillesAgentLib({ agentlibRoot, agentlibMetadata: metadata, layout });
    assert.deepEqual(Object.keys(without), ['schema', 'library', 'packageName', 'packageVersion', 'provenance', 'provenanceProblem']);
    assert.equal(without.provenance, null);
    assert.equal(without.packageVersion, '1.2.3', 'provenance stays optional and never blocks a usable package');
});

test('inspect and smoke run no library code when the protected layout is invalid', (t) => {
    for (const command of ['inspect', 'smoke']) {
        const root = scratch(t);
        const agentlibRoot = tracedAgentLib(path.join(root, 'agentlib'));
        const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
        // A module writable by everyone makes the layout invalid for any owner, root included.
        fs.chmodSync(path.join(agentlibRoot, 'LLMAgents/index.mjs'), 0o666);
        const { result, ran } = runLibraryCommand(t, commandArguments(command, agentlibRoot, mcpSdkRoot));
        assert.equal(result.status, 1, command);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /must be owned by root and not writable/);
        assert.deepEqual(ran, [], `${command}: library code ran`);
    }
});

test('inspect and smoke run no library code when a required entry or the package identity is wrong', (t) => {
    const responder = 'LLMAgents/openAiAgenticResponder.mjs';
    const defects = [
        ['a missing responder module', responder, (root) => fs.rmSync(path.join(root, responder))],
        ['a missing JWT verifier', 'jwt/jwtVerify.mjs', (root) => fs.rmSync(path.join(root, 'jwt/jwtVerify.mjs'))],
        ['a required entry that is a directory', 'jwt/jwtSign.mjs', (root) => {
            fs.rmSync(path.join(root, 'jwt/jwtSign.mjs'));
            fs.mkdirSync(path.join(root, 'jwt/jwtSign.mjs'));
        }],
        ['a required entry that resolves outside the package', 'jwt/jwtSign.mjs', (root) => {
            fs.rmSync(path.join(root, 'jwt/jwtSign.mjs'));
            fs.writeFileSync(path.join(path.dirname(root), 'outside.mjs'), 'export {};\n');
            fs.symlinkSync('../outside.mjs', path.join(root, 'jwt/jwtSign.mjs'));
        }],
        ['another package name', 'ploinky-agent-lib', (root) => fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ name: 'other', version: '1.0.0' }))],
        ['no package version', 'no version', (root) => fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ name: 'ploinky-agent-lib' }))],
    ];
    for (const command of ['inspect', 'smoke']) {
        for (const [description, named, damage] of defects) {
            const root = scratch(t);
            // An import-time failure would win if any module were loaded before the structure is proven.
            const agentlibRoot = tracedAgentLib(path.join(root, 'agentlib'), {
                override: { 'LLMAgents/index.mjs': 'throw new Error("import-time failure");\n' },
            });
            const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
            damage(agentlibRoot);
            const { result, ran } = runLibraryCommand(t, commandArguments(command, agentlibRoot, mcpSdkRoot, ['--allow-unprotected-layout']));
            assert.equal(result.status, 1, `${command}: ${description}`);
            assert.equal(result.stdout, '');
            assert.ok(result.stderr.includes(named), `${command}: ${description}: ${result.stderr}`);
            assert.doesNotMatch(result.stderr, /import-time failure/, `${command}: ${description}`);
            assert.deepEqual(ran, [], `${command}: ${description}: library code ran`);
        }
    }
});

test('the marker fixture proves library code does run once the layout and structure are valid', (t) => {
    const root = scratch(t);
    const agentlibRoot = tracedAgentLib(path.join(root, 'agentlib'));
    const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
    for (const command of ['inspect', 'smoke']) {
        const { result, ran } = runLibraryCommand(t, commandArguments(command, agentlibRoot, mcpSdkRoot, ['--allow-unprotected-layout']));
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(new Set(ran), new Set(ACHILLES_MODULES.map(({ subpath }) => subpath)), command);
    }
});

test('self-test proves smoke rejects every negative fixture and requires an intact control', async (t) => {
    const root = scratch(t);
    const agentlibRoot = writeAgentLibFixture(path.join(root, 'agentlib'));
    const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
    const temporary = scratch(t, 'box-self-test-tmp-');
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    let result;
    try {
        result = await runSelfTest({ agentlibRoot, mcpSdkRoot });
    } finally {
        if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
    assert.deepEqual(fs.readdirSync(temporary), [], 'the disposable fixtures are removed');
    assert.deepEqual(result, {
        schema: 'ploinky.box.library-self-test/v1', ok: true, control: { accepted: true },
        cases: SELF_TEST_CASES.map(({ name, expected }) => ({ name, expected, rejected: true })),
    });
    assert.deepEqual(SELF_TEST_CASES.map(({ expected }) => expected), [
        'LLMAgents/openAiAgenticResponder.mjs', 'isOptOutModel', 'runOpenAiAgenticResponse', 'StreamableHTTPClientTransport',
    ]);
    // A smoke that accepts a broken fixture, rejects without naming it, or fails its control fails the self-test.
    const outcomes = (behaviour) => (roots) => behaviour(roots);
    await assert.rejects(runSelfTest({ agentlibRoot, mcpSdkRoot, run: outcomes(() => ({ status: 0, stderr: '' })) }), /was accepted by smoke/);
    await assert.rejects(runSelfTest({ agentlibRoot, mcpSdkRoot, run: outcomes(() => ({ status: 1, stderr: 'failed' })) }), /control failed/);
    let calls = 0;
    await assert.rejects(runSelfTest({
        agentlibRoot, mcpSdkRoot,
        run: outcomes(() => (++calls === 1 ? { status: 0, stderr: '' } : { status: 1, stderr: 'unrelated failure' })),
    }), /without naming LLMAgents\/openAiAgenticResponder\.mjs as missing/);
    // A rejection for another cause that merely mentions the name (here an import error) is not the named rejection.
    calls = 0;
    await assert.rejects(runSelfTest({
        agentlibRoot, mcpSdkRoot,
        run: outcomes(() => (++calls === 1 ? { status: 0, stderr: '' } : {
            status: 1,
            stderr: "ploinky-box library check failed: achillesAgentLib entry LLMAgents/openAiAgenticResponder.mjs does not import: "
                + "Cannot find module '/x/LLMAgents/openAiAgenticResponder.mjs'\n",
        })),
    }), /without naming LLMAgents\/openAiAgenticResponder\.mjs as missing/);
    for (const { name, expected, reason } of SELF_TEST_CASES) {
        assert.ok(reason.includes(expected), `${name}: the exact rejection names ${expected}`);
    }
});

test('the smoke command line prints one JSON result, or fails naming what is missing', (t) => {
    const root = scratch(t);
    const agentlibRoot = writeAgentLibFixture(path.join(root, 'agentlib'));
    const mcpSdkRoot = writeSdkFixture(path.join(root, 'sdk'));
    const script = path.join(IMAGE, 'smoke-libraries.mjs');
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
    const smoke = run('smoke', '--agentlib-root', agentlibRoot, '--mcp-sdk-root', mcpSdkRoot, '--allow-unprotected-layout');
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(JSON.parse(smoke.stdout).ok, true);
    const inspect = run('inspect', 'achillesAgentLib', '--agentlib-root', agentlibRoot, '--agentlib-metadata', path.join(root, 'absent.json'), '--allow-unprotected-layout');
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).provenance, null);
    fs.rmSync(path.join(agentlibRoot, 'LLMAgents/openAiAgenticResponder.mjs'));
    const broken = run('smoke', '--agentlib-root', agentlibRoot, '--mcp-sdk-root', mcpSdkRoot, '--allow-unprotected-layout');
    assert.equal(broken.status, 1);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /LLMAgents\/openAiAgenticResponder\.mjs/);
    for (const invalid of [[], ['other'], ['inspect'], ['inspect', 'mcp-sdk'], ['smoke', '--unknown', 'x'], ['smoke', '--agentlib-root']]) {
        assert.equal(run(...invalid).status, 1, invalid.join(' '));
    }
    assert.deepEqual(parseArguments(['smoke', '--allow-unprotected-layout']), { command: 'smoke', options: { protectedLayout: false } });
    assert.throws(() => parseArguments(['smoke', '--agentlib-root', 'a', '--agentlib-root', 'b']), /Invalid argument/);
});

// ---------------------------------------------------------------------------
// The real libraries, when a test source is supplied
// ---------------------------------------------------------------------------

const REAL_AGENTLIB = process.env.BOX_LIBRARIES_TEST_AGENTLIB_DIR || process.env.PLOINKY_TEST_AGENTLIB_DIR;
const REAL_SDK = process.env.BOX_LIBRARIES_TEST_MCP_SDK_DIR;
const realSkip = !(REAL_AGENTLIB && REAL_SDK)
    && 'set BOX_LIBRARIES_TEST_AGENTLIB_DIR (or PLOINKY_TEST_AGENTLIB_DIR) and BOX_LIBRARIES_TEST_MCP_SDK_DIR to exercise the real libraries';

test('the real libraries pass the smoke and its negative self-test', { skip: realSkip }, async () => {
    const result = await runSmoke({ agentlibRoot: REAL_AGENTLIB, mcpSdkRoot: REAL_SDK, protectedLayout: false });
    assert.equal(result.ok, true);
    assert.equal(result.libraries['mcp-sdk'].packageName, '@modelcontextprotocol/sdk');
    const selfTest = await runSelfTest({ agentlibRoot: REAL_AGENTLIB, mcpSdkRoot: REAL_SDK });
    assert.equal(selfTest.ok, true);
    assert.equal(selfTest.cases.length, SELF_TEST_CASES.length);
});

test('a real AgentLib checkout is prepared, sealed, and still passes the smoke', { skip: !REAL_AGENTLIB && 'no real AgentLib source supplied' }, (t) => {
    const status = spawnSync('git', ['-C', REAL_AGENTLIB, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], { encoding: 'utf8' });
    if (status.status !== 0 || status.stdout.trim()) {
        t.skip('the supplied AgentLib source is not a clean Git checkout');
        return;
    }
    const copy = path.join(scratch(t), 'agentlib');
    fs.cpSync(REAL_AGENTLIB, copy, { recursive: true, verbatimSymlinks: true });
    const commit = git(copy, 'rev-parse', 'HEAD');
    const record = prepareLibrary({
        library: 'achillesAgentLib', source: copy, metadata: path.join(path.dirname(copy), 'runtime-contract.json'),
        repository: AGENTLIB_URL, branch: 'master', commit,
    });
    assert.equal(record.commit, commit);
    assert.equal(fs.existsSync(path.join(copy, '.git')), false);
    return smokeAchillesAgentLib(copy).then((result) => assert.equal(result.packageName, 'ploinky-agent-lib'));
});
