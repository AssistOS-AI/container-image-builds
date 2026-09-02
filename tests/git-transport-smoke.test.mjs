import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeEnvironment, assertAnonymousHttp2, assertNoLoaderOverrides, traceSummary } from '../scripts/smoke-git-transport.mjs';

test('public probe ignores inherited Git transport and credential configuration for a real Git child', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-probe-env-test-'));
    try {
        const inheritedHome = path.join(directory, 'inherited');
        fs.mkdirSync(inheritedHome);
        const config = '[http]\nversion = HTTP/1.1\n[credential]\nhelper = inherited-secret-helper\n';
        const globalConfig = path.join(inheritedHome, '.gitconfig');
        fs.writeFileSync(globalConfig, config);
        const inherited = Object.freeze({
            ...process.env,
            HOME: inheritedHome,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_SYSTEM: globalConfig,
            GIT_CONFIG_PARAMETERS: "'http.version=HTTP/1.1'",
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: 'secret-helper',
            GIT_ASKPASS: '/missing/askpass',
            GIT_SSL_NO_VERIFY: 'true',
            SSH_AUTH_SOCK: '/missing/ssh-agent',
            npm_config_userconfig: '/missing/npmrc',
            NPM_CONFIG_PROXY: 'https://private.example.invalid',
            NODE_OPTIONS: '--require /missing/inject.js',
            HTTPS_PROXY: 'https://credential:secret@private.example.invalid',
            https_proxy: 'https://credential:secret@private.example.invalid',
            ALL_PROXY: 'https://private.example.invalid',
            LD_PRELOAD: '/missing/hook.so',
            LD_LIBRARY_PATH: '/missing/alternate-libraries',
        });
        const env = probeEnvironment(inherited, directory);
        fs.mkdirSync(env.HOME);
        fs.mkdirSync(env.XDG_CONFIG_HOME);
        for (const key of ['http.version', 'credential.helper']) {
            const result = spawnSync('git', ['config', '--get', key], { env, cwd: directory, encoding: 'utf8' });
            assert.equal(result.status, 1, result.stderr);
            assert.equal(result.stdout, '');
        }
        const forced = spawnSync('git', ['config', '--get', 'http.version'], {
            cwd: directory, encoding: 'utf8', env: {
                ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.version', GIT_CONFIG_VALUE_0: 'HTTP/2',
            },
        });
        assert.equal(forced.status, 0, forced.stderr);
        assert.equal(forced.stdout.trim(), 'HTTP/2');
        assert.equal(env.GIT_SSL_NO_VERIFY, undefined);
        assert.equal(env.GIT_ASKPASS, undefined);
        assert.equal(env.SSH_AUTH_SOCK, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
        assert.equal(env.NPM_CONFIG_PROXY, undefined);
        assert.equal(env.HTTPS_PROXY, undefined);
        assert.equal(env.https_proxy, undefined);
        assert.equal(env.ALL_PROXY, undefined);
        assert.equal(env.LD_PRELOAD, undefined);
        assert.equal(env.LD_LIBRARY_PATH, undefined);
        assert.equal(env.npm_config_userconfig, '/dev/null');
        assert.equal(env.npm_config_globalconfig, path.join(directory, 'empty-global.npmrc'));
        const npm = spawnSync('npm', ['--version'], { env, cwd: directory, encoding: 'utf8' });
        assert.equal(npm.status, 0, npm.stderr);
        assert.match(npm.stdout.trim(), /^[0-9]+\.[0-9]+\.[0-9]+$/);
        assert.equal(fs.readFileSync(globalConfig, 'utf8'), config);
        assert.equal(inherited.GIT_CONFIG_PARAMETERS, "'http.version=HTTP/1.1'");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

const successfulTrace = [
    '== Info: ALPN: server accepted h2',
    '== Info: using HTTP/2',
    '=> Send header: GET /AssistOS-AI/soplang.git/info/refs?service=git-upload-pack HTTP/2',
    '<= Recv header: HTTP/2 200',
].join('\n');

test('HTTP2 gate accepts a real negotiation and rejects HTTP1 fallback or HTTP2 authentication failure', () => {
    assert.doesNotThrow(() => assertAnonymousHttp2(successfulTrace));
    assert.throws(() => assertAnonymousHttp2(''), /negotiate HTTP\/2/);
    assert.throws(() => assertAnonymousHttp2(successfulTrace.replaceAll('HTTP/2', 'HTTP/1.1').replace('accepted h2', 'accepted http/1.1')));
    assert.throws(() => assertAnonymousHttp2(successfulTrace.replace('HTTP/2 200', 'HTTP/2 401')), /successful HTTP\/2/);
    assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n=> Send header: POST /git-upload-pack HTTP/1.1`), /fall back/);
    assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n== Info: using HTTP/1.1\n<= Recv header: HTTP/1.1 200`), /fall back/);
    assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n<= Recv header: HTTP/2 401`), /HTTP errors/);
    assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n<= Recv header: HTTP/2 503`), /HTTP errors/);
});

test('public Git probe rejects credentials even when the server succeeds', () => {
    for (const header of ['Authorization: Basic <redacted>', 'Proxy-Authorization: Bearer <redacted>', 'Cookie: session=redacted']) {
        assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n=> Send header: ${header}`), /must not send credentials/);
        assert.throws(() => assertAnonymousHttp2(`${successfulTrace}\n== Info: [HTTP/2] [1] [${header}]`), /must not send credentials/);
    }
    assert.doesNotThrow(() => assertAnonymousHttp2(`${successfulTrace}\n<= Recv header: Set-Cookie: anonymous=1`));
});

test('loader overrides fail before invoking tools, and failure evidence excludes request headers', () => {
    assert.doesNotThrow(() => assertNoLoaderOverrides({}));
    for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) {
        assert.throws(() => assertNoLoaderOverrides({ [key]: '/private/location' }), new RegExp(key));
    }
    const result = spawnSync(process.execPath, ['scripts/smoke-git-transport.mjs'], {
        encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: '/missing/test-only-path' },
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
        ok: false, error: 'Git runtime proof cannot start with LD_LIBRARY_PATH set',
    });
    assert.deepEqual(traceSummary(`${successfulTrace}\n=> Send header: Authorization: secret\n<= Recv header: HTTP/2 401`), [
        '== Info: ALPN: server accepted h2',
        '== Info: using HTTP/2',
        '<= Recv header: HTTP/2 200',
        '<= Recv header: HTTP/2 401',
    ]);
});
