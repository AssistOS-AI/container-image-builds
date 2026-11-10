import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { rewriteLoginForm, target } from './patch-login-query-cache.mjs';

const [directory, lockPath, queryCoreDirectory] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const patch = lock.umami.sourcePatches[0];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const patched = fs.readFileSync(path.join(directory, target), 'utf8');
assert.equal(sha(patched), patch.patchedSha256);
const original = rewriteLoginForm(patched, true);
assert.equal(sha(original), patch.originalSha256);
const require = queryCoreDirectory ? null
    : createRequire(fs.realpathSync(path.join(directory, 'node_modules/@tanstack/react-query/package.json')));
const corePackage = queryCoreDirectory
    ? path.join(queryCoreDirectory, 'package.json')
    : require.resolve('@tanstack/query-core/package.json');
assert.equal(JSON.parse(fs.readFileSync(corePackage)).version, '5.102.8');
const { QueryClient, QueryObserver } = queryCoreDirectory
    ? await import(pathToFileURL(path.join(queryCoreDirectory, 'build/modern/index.js')))
    : require('@tanstack/query-core');

function submitHandler(source, bindings) {
    const start = source.indexOf('  const handleSubmit = async ');
    const end = source.indexOf('\n\n  return (', start);
    assert.ok(start !== -1 && end > start, 'actual LoginForm submit handler');
    const declaration = stripTypeScriptTypes(source.slice(start, end));
    return vm.runInNewContext(declaration + '\nhandleSubmit;', bindings);
}

async function check(source, pendingVerify) {
    const client = new QueryClient({ defaultOptions: { queries: {
        retry: false, refetchOnWindowFocus: false, staleTime: 60000,
    } } });
    const unauthorized = Object.assign(new Error('fixture verification rejected'), { status: 401 });
    const user = { id: 'fixture-user', username: 'fixture', role: 'admin', createdAt: '2026-01-01', isAdmin: true, teams: [] };
    let rejectVerify;
    let finishOther;
    const queryFn = () => pendingVerify ? new Promise((_, reject) => { rejectVerify = reject; }) : Promise.reject(unauthorized);
    const verify = client.fetchQuery({ queryKey: ['login'], queryFn }).catch(() => {});
    if (!pendingVerify) await verify;
    const unrelated = client.fetchQuery({ queryKey: ['login', 'unrelated'], queryFn: () => new Promise(resolve => { finishOther = resolve; }) });
    let storedToken;
    let principal;
    const navigations = [];
    try {
        const submit = submitHandler(source, {
            queryClient: client,
            mutateAsync: async (credentials, options) => {
                assert.deepEqual(credentials, { username: 'fixture', password: 'fixture-only' });
                await options.onSuccess({ token: 'fixture-token', user });
            },
            consumeReturnUrl: () => null,
            sessionStorage: { setItem: () => assert.fail('the password path must not stage a two-factor token') },
            setClientAuthToken: value => { storedToken = value; },
            setUser: value => { assert.equal(storedToken, 'fixture-token'); principal = value; },
            router: { push: destination => {
                assert.equal(storedToken, 'fixture-token');
                assert.equal(principal, user);
                navigations.push({ destination, error: client.getQueryState(['login']).error });
            } },
        });
        await submit({ username: 'fixture', password: 'fixture-only' });
        if (pendingVerify) {
            rejectVerify(unauthorized);
            await verify;
            await new Promise(setImmediate);
        }
        assert.equal(client.getQueryState(['login', 'unrelated']).fetchStatus, 'fetching', 'cancellation must be exact');
        const observer = new QueryObserver(client, { queryKey: ['login'], queryFn, enabled: false });
        const result = observer.getCurrentResult();
        observer.destroy();
        assert.equal(navigations.length, 1);
        assert.equal(navigations[0].destination, '/');
        return { error: result.error, data: result.data, status: result.status, navigationError: navigations[0].error, user };
    } finally {
        finishOther('unrelated result');
        await unrelated;
        client.clear();
    }
}

async function checkTwoFactor(source) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
    const unauthorized = Object.assign(new Error('fixture verification rejected'), { status: 401 });
    await client.fetchQuery({ queryKey: ['login'], queryFn: () => Promise.reject(unauthorized) }).catch(() => {});
    const staged = [];
    const navigations = [];
    try {
        const submit = submitHandler(source, {
            queryClient: client,
            mutateAsync: async (credentials, options) => { await options.onSuccess({ requiresTwoFactor: true, partialToken: 'fixture-partial' }); },
            consumeReturnUrl: () => assert.fail('the two-factor branch must not consume the return URL'),
            sessionStorage: { setItem: (key, value) => staged.push([key, value]) },
            setClientAuthToken: () => assert.fail('the two-factor branch must not store a session token'),
            setUser: () => assert.fail('the two-factor branch must not publish a user'),
            router: { push: destination => navigations.push(destination) },
        });
        await submit({ username: 'fixture', password: 'fixture-only' });
        assert.deepEqual(staged, [['umami.partial-token', 'fixture-partial']]);
        assert.deepEqual(navigations, ['/login/two-factor']);
        assert.equal(client.getQueryState(['login']).error?.status, 401, 'the two-factor branch must leave the login query untouched');
    } finally {
        client.clear();
    }
}

for (const pending of [false, true]) {
    const baseline = await check(original, pending);
    assert.equal(baseline.error?.status, 401, 'upstream behavior must reproduce the retained/late verification error');
    const fixed = await check(patched, pending);
    assert.equal(fixed.error, null);
    assert.equal(fixed.navigationError, null, 'cache must be authoritative before navigation');
    assert.equal(fixed.status, 'success');
    assert.deepEqual(fixed.data, fixed.user, 'cache stores the user, not the login response envelope');
}
await checkTwoFactor(original);
await checkTwoFactor(patched);
console.log(JSON.stringify({ schema: 'ploinky.umami-login-cache-regression/v1', passed: true,
    queryCoreVersion: '5.102.8', initialErrorReproduced: true, pendingErrorReproduced: true,
    authoritativeLoginCache: true, lateVerificationCannotOverwrite: true, unrelatedQueryPreserved: true, twoFactorBranchUntouched: true }));
