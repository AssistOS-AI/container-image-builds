// Resolve the two library inputs of one Box publication exactly once.
//
// The publication prerequisite job runs this before the native architecture
// jobs fan out. Every library that has no explicit commit input is resolved
// from its remote symbolic default branch in a single `git ls-remote --symref`
// query, and the exact result is frozen as job outputs. The architecture jobs
// only consume those outputs, so both builds package the same commit pair even
// if a default branch moves while they run.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIBRARIES = Object.freeze({
    achillesAgentLib: Object.freeze({
        slug: 'AssistOS-AI/AchillesAgentLib',
        repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
        outputPrefix: 'agentlib',
        commitInput: 'AGENTLIB_COMMIT',
    }),
    'mcp-sdk': Object.freeze({
        slug: 'AssistOS-AI/MCPSDK',
        repository: 'https://github.com/AssistOS-AI/MCPSDK.git',
        outputPrefix: 'mcp_sdk',
        commitInput: 'MCP_SDK_COMMIT',
    }),
});

const COMMIT = /^[0-9a-f]{40}$/;

function ensure(condition, message) {
    if (!condition) throw new Error(message);
}
// Conservative on purpose: the branch reaches workflow outputs and build
// arguments, so it must never carry whitespace, quoting, or line breaks.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Parse one `git ls-remote --symref <repository> HEAD` response.
 *
 * Exactly two lines are accepted: the symbolic default branch and the commit
 * that HEAD resolves to. A detached, missing, extra, or malformed line is an
 * error, so there is no fallback branch.
 */
export function parseSymbolicHead(output, repository = 'repository') {
    const lines = String(output ?? '').split('\n');
    if (lines.at(-1) === '') lines.pop();
    ensure(lines.length === 2, `${repository}: expected exactly one symbolic HEAD and one commit line`);
    const symbolic = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(lines[0]);
    ensure(symbolic, `${repository}: HEAD is not a symbolic reference to a branch`);
    const commit = /^([0-9a-f]{40})\tHEAD$/.exec(lines[1]);
    ensure(commit, `${repository}: HEAD commit line is malformed`);
    ensure(BRANCH.test(symbolic[1]), `${repository}: default branch name is not supported`);
    return { branch: symbolic[1], commit: commit[1] };
}

/**
 * The default runner. Credentials, when the workflow supplies them, travel in
 * Git's environment configuration and never in the process arguments. Git runs
 * outside any checkout, so no repository-local configuration (such as a
 * credential header another step persisted) is combined with this one.
 */
export function gitRunner(env = process.env) {
    return (args) => {
        const token = String(env.SOURCE_REPO_TOKEN || '');
        const auth = token
            ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
            : {};
        const result = spawnSync('git', args, {
            cwd: os.tmpdir(),
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, ...auth, GIT_TERMINAL_PROMPT: '0' },
        });
        const detail = String(result.stderr || '').trim().split('\n').filter(Boolean).join(' ').slice(0, 500);
        ensure(!result.error && result.status === 0,
            `git ${args[0]} failed${result.status === null ? '' : ` with status ${result.status}`}${detail ? `: ${detail}` : ''}`);
        return String(result.stdout);
    };
}

/**
 * Freeze both library selections.
 *
 * @param {object} inputs
 * @param {string} [inputs.agentlibCommit] exact commit; empty resolves the default branch
 * @param {string} [inputs.mcpSdkCommit] exact commit; empty resolves the default branch
 * @param {(args: string[]) => string} run injected command runner
 */
export function resolveLibraries({ agentlibCommit = '', mcpSdkCommit = '' } = {}, run = gitRunner()) {
    const explicit = { achillesAgentLib: agentlibCommit, 'mcp-sdk': mcpSdkCommit };
    // Reject an invalid explicit input before any remote is queried.
    const requested = Object.fromEntries(Object.entries(LIBRARIES).map(([library, definition]) => {
        const commit = String(explicit[library] ?? '').trim();
        ensure(commit === '' || COMMIT.test(commit), `${definition.commitInput} must be an exact 40-character lowercase commit`);
        return [library, commit];
    }));
    const selections = {};
    for (const [library, definition] of Object.entries(LIBRARIES)) {
        if (requested[library]) {
            selections[library] = { repository: definition.repository, branch: null, commit: requested[library] };
            continue;
        }
        const head = parseSymbolicHead(
            run(['ls-remote', '--symref', definition.repository, 'HEAD']),
            definition.repository,
        );
        selections[library] = { repository: definition.repository, branch: head.branch, commit: head.commit };
    }
    return Object.freeze(Object.fromEntries(Object.entries(selections)
        .map(([library, selection]) => [library, Object.freeze(selection)])));
}

/** Workflow output lines. A null branch is an empty value. */
export function formatOutputs(selections) {
    const lines = [];
    for (const [library, definition] of Object.entries(LIBRARIES)) {
        const selection = selections[library];
        lines.push(
            `${definition.outputPrefix}_repository=${definition.slug}`,
            `${definition.outputPrefix}_url=${selection.repository}`,
            `${definition.outputPrefix}_branch=${selection.branch ?? ''}`,
            `${definition.outputPrefix}_commit=${selection.commit}`,
        );
    }
    return `${lines.join('\n')}\n`;
}

function main() {
    const env = process.env;
    const selections = resolveLibraries({
        agentlibCommit: env.AGENTLIB_COMMIT,
        mcpSdkCommit: env.MCP_SDK_COMMIT,
    }, gitRunner(env));
    ensure(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
    fs.appendFileSync(env.GITHUB_OUTPUT, formatOutputs(selections));
    if (env.LIBRARY_INPUTS_FILE) {
        fs.writeFileSync(env.LIBRARY_INPUTS_FILE, `${JSON.stringify({
            schema: 'ploinky.box.library-inputs/v1',
            libraries: selections,
        }, null, 2)}\n`, { flag: 'wx' });
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
