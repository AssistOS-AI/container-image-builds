// Image-owned preparation of the two library sources bundled in the Box image.
//
// Runs only inside the image builder stages. It checks that the checkout is
// exactly the selected commit and clean, that the package has the shape the
// image can ship without an install step, and that every entry Ploinky
// consumes is present. It then strips Git metadata, keeps every license and
// notice file, and writes the build-generated provenance record. It never
// hashes library bytes and depends on no Ploinky selection or fingerprint code.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIBRARIES } from './resolve-libraries.mjs';
import {
    ACHILLES_PACKAGE_NAME,
    ACHILLES_REQUIRED_ENTRIES,
    LIBRARY_METADATA_SCHEMA,
    MCP_SDK_METADATA_NAME,
    MCP_SDK_PACKAGE_NAME,
    mcpSdkEntry,
} from './smoke-libraries.mjs';

const COMMIT = /^[0-9a-f]{40}$/;

function ensure(condition, message) {
    if (!condition) throw new Error(message);
}
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const LICENSE_FILE = /(?:^|\/)(?:LICEN[CS]E|COPYING|NOTICE)(?:[.-][^/]*)?$/i;

const DEFINITIONS = Object.freeze({
    achillesAgentLib: Object.freeze({
        packageName: ACHILLES_PACKAGE_NAME,
        requiredEntries: () => [...ACHILLES_REQUIRED_ENTRIES],
        allowInternalSymlinks: true,
    }),
    'mcp-sdk': Object.freeze({
        packageName: MCP_SDK_PACKAGE_NAME,
        requiredEntries: (pkg) => ['package.json', mcpSdkEntry(pkg).slice(2)],
        allowInternalSymlinks: false,
    }),
});

function defaultGit(args, { cwd, env } = {}) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    ensure(!result.error && result.status === 0,
        `git ${args[0]} failed while preparing a library${result.stderr ? `: ${String(result.stderr).trim()}` : ''}`);
    return String(result.stdout);
}

function readPackage(root, definition, library) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    ensure(pkg?.name === definition.packageName, `${library} package must be ${definition.packageName}`);
    ensure(typeof pkg.version === 'string' && pkg.version.trim(), `${library} package declares no version`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const declared = pkg[field];
        ensure(declared === undefined
            || (declared && typeof declared === 'object' && !Array.isArray(declared) && Object.keys(declared).length === 0),
        `${library} declares ${field}; prepare its dependencies with the package's own tooling in the image build before packaging`);
    }
    return pkg;
}

function assertTreeShape(root, { allowInternalSymlinks }, library) {
    const realRoot = fs.realpathSync(root);
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (directory === realRoot && entry.name === '.git') continue;
            const relative = path.relative(realRoot, absolute);
            if (entry.isSymbolicLink()) {
                ensure(allowInternalSymlinks, `${library} must not contain symlinks: ${relative}`);
                const literal = path.resolve(path.dirname(absolute), fs.readlinkSync(absolute));
                let real = literal;
                try { real = fs.realpathSync(absolute); } catch (_) { /* dangling: the literal target still counts */ }
                for (const target of [literal, real]) {
                    ensure(target === realRoot || target.startsWith(`${realRoot}${path.sep}`),
                        `${library} contains a symlink escaping the package: ${relative}`);
                }
            } else if (entry.isDirectory()) {
                walk(absolute);
            } else {
                ensure(entry.isFile(), `${library} contains an unsupported entry type: ${relative}`);
            }
        }
    };
    walk(realRoot);
}

/**
 * Prepare one library checkout in place and write its provenance record.
 *
 * @param {object} options
 * @param {'achillesAgentLib'|'mcp-sdk'} options.library
 * @param {string} options.source checkout directory, sealed in place
 * @param {string} options.metadata provenance file to create
 * @param {string} options.repository selected repository URL
 * @param {string|null} options.branch resolved default branch, or null for an explicit commit
 * @param {string} options.commit exact selected commit
 */
export function prepareLibrary({ library, source, metadata, repository, branch = null, commit, git = defaultGit }) {
    const definition = DEFINITIONS[library];
    ensure(definition, `unsupported library ${library}`);
    ensure(repository === LIBRARIES[library].repository, `${library} repository is not the selected repository`);
    ensure(COMMIT.test(String(commit)), `${library} requires an exact 40-character commit`);
    const selectedBranch = branch === '' ? null : branch;
    ensure(selectedBranch === null || BRANCH.test(String(selectedBranch)), `${library} branch is not supported`);

    const root = path.resolve(source);
    const stat = fs.lstatSync(root);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), `${library} source must be a real directory`);
    const metadataPath = path.resolve(metadata);
    const relativeMetadata = path.relative(root, metadataPath);
    const insideSource = relativeMetadata !== '' && !relativeMetadata.startsWith('..') && !path.isAbsolute(relativeMetadata);
    if (library === 'mcp-sdk') {
        ensure(relativeMetadata === MCP_SDK_METADATA_NAME, `${library} provenance must be ${MCP_SDK_METADATA_NAME} in the package root`);
    } else {
        ensure(!insideSource && relativeMetadata !== '', `${library} provenance must be outside the package tree`);
    }

    const environment = {
        PATH: String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
        HOME: String(process.env.HOME || '/tmp'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
    };
    const run = (...args) => git(['-C', root, ...args], { cwd: root, env: environment });
    const head = run('rev-parse', 'HEAD').trim();
    ensure(head === commit, `${library} checkout is ${head || 'without a HEAD'}; expected ${commit}`);
    ensure(run('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching').trim() === '',
        `${library} checkout is not clean`);

    const pkg = readPackage(root, definition, library);
    for (const entry of definition.requiredEntries(pkg)) {
        const file = path.join(root, entry);
        ensure(fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(), `${library} is missing required entry ${entry}`);
    }
    assertTreeShape(root, definition, library);

    const licenseFiles = run('ls-files', '-z').split('\0').filter((name) => name && LICENSE_FILE.test(name));
    if (typeof pkg.license === 'string' && pkg.license.trim()) {
        ensure(licenseFiles.length > 0, `${library} declares license ${pkg.license} but ships no license file`);
    }

    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    ensure(!fs.existsSync(path.join(root, '.git')), `${library} Git metadata was not removed`);
    for (const name of licenseFiles) {
        // A tracked license entry may itself be a confined symlink; it only has to still exist.
        ensure(fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }),
            `${library} license file was not preserved: ${name}`);
    }

    const record = {
        schema: LIBRARY_METADATA_SCHEMA,
        library,
        packageName: pkg.name,
        packageVersion: pkg.version,
        repository,
        branch: selectedBranch,
        commit,
    };
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    return record;
}

const FLAGS = Object.freeze({
    '--source': 'source', '--metadata': 'metadata', '--repository': 'repository',
    '--branch': 'branch', '--commit': 'commit',
});

export function parseArguments(argv) {
    const [operation, library, ...rest] = argv;
    ensure(operation === 'prepare' && DEFINITIONS[library],
        'Usage: prepare-libraries.mjs prepare <achillesAgentLib|mcp-sdk> --source DIR --metadata FILE '
        + '--repository URL --branch NAME --commit SHA');
    const options = { library };
    for (let index = 0; index < rest.length; index += 2) {
        const key = FLAGS[rest[index]];
        ensure(key && rest[index + 1] !== undefined && !(key in options), `Invalid argument ${rest[index]}`);
        options[key] = rest[index + 1];
    }
    for (const key of Object.values(FLAGS)) ensure(key in options, `Missing --${key}`);
    return options;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try {
        process.stdout.write(`${JSON.stringify(prepareLibrary(parseArguments(process.argv.slice(2))))}\n`);
    } catch (error) {
        process.stderr.write(`ploinky-box library preparation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
