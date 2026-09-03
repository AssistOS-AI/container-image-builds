#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositories = [
    'https://github.com/AssistOS-AI/soplang.git',
    'https://github.com/assafelovic/gpt-researcher.git',
];
// This dependency-free public fixture exercises npm's Git ref resolution. The
// installed lock must resolve the tag to this reviewed commit, not a tarball.
const npmFixture = {
    spec: 'git+https://github.com/isaacs/isexe.git#v2.0.0',
    commit: '10f8be491aab2e158c7e20df64a7f90ab5b5475c',
};

export function probeEnvironment(inherited, directory) {
    const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
        !/^(?:GIT_|NPM_CONFIG_|CURL_)/i.test(key)
        && !/^(?:https?|all|no)_proxy$/i.test(key)
        && !['SSH_ASKPASS', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'NODE_PATH',
            'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)));
    return {
        ...env,
        HOME: path.join(directory, 'home'),
        XDG_CONFIG_HOME: path.join(directory, 'config'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_TRACE_CURL_NO_DATA: '1',
        GIT_TRACE_REDACT: '1',
        npm_config_userconfig: '/dev/null',
        // npm rejects loading the same file for both user and global config.
        npm_config_globalconfig: path.join(directory, 'empty-global.npmrc'),
        npm_config_cache: path.join(directory, 'npm-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        LC_ALL: 'C',
    };
}

export function assertAnonymousHttp2(trace) {
    assert.doesNotMatch(trace, /(?:=> Send header: |\[)(?:authorization|proxy-authorization|cookie):/i,
        'public Git probes must not send credentials');
    assert.match(trace, /(?:ALPN[^\n]*server accepted (?:to use )?h2|using HTTP\/2)/i,
        'Git must negotiate HTTP/2');
    assert.match(trace, /<= Recv header: HTTP\/2 200\b/i,
        'Git must receive a successful HTTP/2 response');
    assert.doesNotMatch(trace, /(?:<= Recv header: HTTP\/1\.[01]\b|=> Send header: (?:GET|POST) \S+ HTTP\/1\.[01]\b)/i,
        'Git requests must not fall back to HTTP/1');
    assert.doesNotMatch(trace, /<= Recv header: HTTP\/\S+ [45][0-9]{2}\b/i,
        'Git responses must not contain HTTP errors');
}

export function assertNoLoaderOverrides(env) {
    for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) {
        assert.ok(!env[key], `Git runtime proof cannot start with ${key} set`);
    }
}

export function traceSummary(trace) {
    return trace.split('\n')
        .filter(line => /== Info: (?:ALPN|using HTTP)|<= Recv header: HTTP\//i.test(line))
        .map(line => line.replace(/^.*?(?=== Info:|<= Recv header:)/, '').slice(0, 200))
        .slice(-40);
}

function execute(command, args, env, cwd, timeout = 180_000) {
    const result = spawnSync(command, args, {
        env, cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`${command} ${args[0] || ''} failed: ${result.error?.code || `exit ${result.status}`}`);
    }
    return result.stdout.trim();
}

export function runTransportSmoke() {
    // A loader hook could already have altered this Node process. Clearing its
    // environment for children alone cannot establish the image's behavior.
    assertNoLoaderOverrides(process.env);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-transport-smoke-'));
    const env = probeEnvironment(process.env, directory);
    const evidence = { ok: false, platform: `${process.platform}/${process.arch}`, inventory: {}, probes: [] };
    try {
        fs.mkdirSync(env.HOME);
        fs.mkdirSync(env.XDG_CONFIG_HOME);
        const gitExecPath = execute('git', ['--exec-path'], env, directory);
        const httpsHelper = path.join(gitExecPath, 'git-remote-https');
        const linkage = execute('ldd', [httpsHelper], env, directory);
        assert.match(linkage, /libcurl[^\s]*\.so/, 'inspect the libcurl used by Git HTTPS');
        assert.doesNotMatch(linkage, /not found/, 'Git HTTPS libraries must resolve');
        evidence.inventory = {
            git: execute('git', ['--version'], env, directory),
            httpsHelper: fs.realpathSync(httpsHelper),
            httpsHelperLibraries: linkage,
            curlExecutable: execute('curl', ['--version'], env, directory),
            packages: execute('dpkg-query', ['-W', '-f=${binary:Package} ${Version}\n'], env, directory)
                .split('\n').filter(line => /^(?:git |libcurl|libgnutls|libssl)/.test(line)),
            node: process.version,
            npm: execute('npm', ['--version'], env, directory),
        };
        for (const mode of ['default', 'http2']) {
            const modeEnv = { ...env };
            if (mode === 'http2') {
                modeEnv.GIT_CONFIG_COUNT = '1';
                modeEnv.GIT_CONFIG_KEY_0 = 'http.version';
                modeEnv.GIT_CONFIG_VALUE_0 = 'HTTP/2';
            }
            const runProbe = (operation, repository, command, args, cwd = directory) => {
                const trace = path.join(directory, `trace-${evidence.probes.length}.log`);
                const started = Date.now();
                const record = { mode, operation, repository, ok: false };
                evidence.probes.push(record);
                try {
                    const output = execute(command, args, { ...modeEnv, GIT_TRACE_CURL: trace }, cwd, 300_000);
                    assertAnonymousHttp2(fs.readFileSync(trace, 'utf8'));
                    record.ok = true;
                    record.http = 'HTTP/2';
                    return output;
                } finally {
                    const content = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
                    record.transport = traceSummary(content);
                    record.credentialsDetected = /(?:=> Send header: |\[)(?:authorization|proxy-authorization|cookie):/i.test(content);
                    record.milliseconds = Date.now() - started;
                }
            };
            for (const [index, repository] of repositories.entries()) {
                const head = runProbe('ls-remote', repository, 'git', ['ls-remote', repository, 'HEAD']).split(/\s/)[0];
                assert.match(head, /^[0-9a-f]{40}$/);
                const checkout = path.join(directory, `${mode}-${index}`);
                runProbe('clone', repository, 'git', ['clone', '--depth=1', '--no-checkout', repository, checkout]);
                runProbe('fetch', repository, 'git', ['fetch', '--depth=1', 'origin', head], checkout);
                assert.equal(execute('git', ['rev-parse', 'FETCH_HEAD'], modeEnv, checkout), head);
            }
            const npmDirectory = path.join(directory, `npm-${mode}`);
            fs.mkdirSync(npmDirectory);
            fs.writeFileSync(path.join(npmDirectory, 'package.json'), JSON.stringify({
                name: 'public-git-transport-smoke', private: true, dependencies: { isexe: npmFixture.spec },
            }));
            // Use a cold npm cache in each mode so a previous transport success
            // cannot hide npm's next Git request. No SDK package is involved.
            modeEnv.npm_config_cache = path.join(directory, `npm-cache-${mode}`);
            runProbe('npm-install', npmFixture.spec, 'npm',
                ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], npmDirectory);
            const lock = JSON.parse(fs.readFileSync(path.join(npmDirectory, 'package-lock.json')));
            // npm normalizes hosted Git lock URLs to SSH even when the actual
            // ref lookup and clone used HTTPS, as required by the trace above.
            assert.ok([
                `git+https://github.com/isaacs/isexe.git#${npmFixture.commit}`,
                `git+ssh://git@github.com/isaacs/isexe.git#${npmFixture.commit}`,
            ].includes(lock.packages['node_modules/isexe'].resolved),
            'npm Git fixture resolved an unexpected repository or commit');
            assert.equal(lock.packages['node_modules/isexe'].version, '2.0.0');
            assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/isexe']);
            execute('node', ['-e', "if (!require('isexe').sync(process.execPath)) process.exit(1)"], modeEnv, npmDirectory);
        }
        evidence.ok = true;
        return evidence;
    } catch (error) {
        error.evidence = { ...evidence, error: String(error.message).split('\n')[0] };
        throw error;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(`${JSON.stringify(runTransportSmoke(), null, 2)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify(error.evidence || { ok: false, error: String(error.message).split('\n')[0] }, null, 2)}\n`);
        process.exitCode = 1;
    }
}
