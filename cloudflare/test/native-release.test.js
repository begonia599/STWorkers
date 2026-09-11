import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeConfig, validateNativeConfig, nativeContext, inspectNativeBindings,
    buildEnvironment, NATIVE_DATABASE_PLACEHOLDER } from '../scripts/native-profile.mjs';
import { initializeAndDeploy, previousNativePlugins, nativeClient, nativeToken, deployNativeRelease } from '../scripts/native-release.mjs';
import { mergePluginHistory } from '../scripts/actions-release.mjs';
import { PLUGIN_BASELINES, digest } from '../scripts/plugin-package.mjs';
import { parsePluginList } from '../scripts/plugin-list.mjs';

const config = createNativeConfig({ databaseId: '11111111-1111-4111-8111-111111111111' });
const env = { WORKERS_CI: '1', CI: 'true', WORKERS_CI_BRANCH: 'main', WORKERS_CI_COMMIT_SHA: 'a'.repeat(40),
    WORKERS_CI_BUILD_UUID: '22222222-2222-4222-8222-222222222222', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) };
const context = nativeContext(config, env);
const lock = { schema: 1, plugins: PLUGIN_BASELINES.map(item => ({ ...item, ref: 'HEAD', layout: 'legacy' })) };
const freshBindings = () => [
    { name: 'AUTH_PASSWORD', type: 'secret_text' },
    { name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
    { name: 'FILES', type: 'r2_bucket', bucket_name: config.r2_buckets[0].bucket_name },
];
const migrations = await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));

function fixture(t, { initialized = false, documents = false } = {}) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const events = [];
    const bindings = freshBindings();
    if (initialized) bindings.push({ name: 'ASSETS', type: 'assets' }, { name: 'DATA_KEY', type: 'secret_text' });
    if (documents) {
        db.exec(migrations[0]);
        db.prepare('INSERT INTO documents(kind,id,payload) VALUES(?,?,?)').run('settings', 'owner', '{"keep":{"unknown":[0,false,"value"]}}');
    }
    const keys = [];
    const client = {
        async database() { return { name: config.d1_databases[0].database_name }; },
        async bucket() { return { name: config.r2_buckets[0].bucket_name }; },
        async settings() { return { bindings: structuredClone(bindings) }; },
        async query(sql, params = []) {
            events.push(sql.trim().split(/\s+/)[0]);
            return db.prepare(sql).all(...params).map(row => ({ ...row }));
        },
        async createDataKey(key) {
            events.push('key');
            keys.push(key);
            assert.equal(bindings.some(item => item.name === 'DATA_KEY'), false);
            bindings.push({ name: 'DATA_KEY', type: 'secret_text' });
        },
    };
    const hooks = {
        async migrate() { events.push('migrate'); for (const sql of migrations) db.exec(sql); },
        async upload() {
            events.push('upload');
            if (!bindings.some(item => item.name === 'ASSETS')) bindings.push({ name: 'ASSETS', type: 'assets' });
        },
    };
    return { db, events, bindings, keys, client, hooks };
}

test('root button profile uses protected assets, required secrets, and no real account or database identifier', async () => {
    const actual = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.deepEqual(actual, createNativeConfig());
    validateNativeConfig(actual);
    assert.equal(actual.d1_databases[0].database_id, NATIVE_DATABASE_PLACEHOLDER);
    assert.equal(actual.account_id, undefined);
    assert.equal(actual.build, undefined);
    assert.equal(actual.preview_urls, false);
    assert.throws(() => validateNativeConfig(actual, { provisioned: true }));
    const example = await readFile(new URL('../../.dev.vars.example', import.meta.url), 'utf8');
    assert.deepEqual(example.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')), ['AUTH_PASSWORD=']);
});

test('native profile rejects authentication bypasses, extra bindings, paid service declarations and redirected paths', () => {
    for (const changed of [
        { ...config, assets: { ...config.assets, run_worker_first: false } },
        { ...config, main: '../server.js' }, { ...config, vars: { AUTH_PASSWORD: 'public-password' } },
        { ...config, secrets: { required: ['AUTH_PASSWORD'] } }, { ...config, preview_urls: true },
        { ...config, containers: [{}] }, { ...config, r2_buckets: [...config.r2_buckets, { binding: 'OTHER', bucket_name: 'other' }] },
    ]) assert.throws(() => validateNativeConfig(changed));
    for (const name of ['../../escape', 'ab', 'bad space', 'UPPER']) assert.throws(() => createNativeConfig({ name }));
});

test('native profile accepts the deploy button preview bucket alias without mutating the configuration', () => {
    const actual = createNativeConfig({ name: 'button-worker', databaseName: 'button-db',
        databaseId: config.d1_databases[0].database_id, bucketName: 'button-files', accountId: env.CLOUDFLARE_ACCOUNT_ID });
    actual.r2_buckets[0].preview_bucket_name = actual.r2_buckets[0].bucket_name;
    const bytes = JSON.stringify(actual);
    Object.freeze(actual.r2_buckets[0]);
    Object.freeze(actual.r2_buckets);
    Object.freeze(actual);
    assert.equal(validateNativeConfig(actual, { provisioned: true }), actual);
    assert.equal(nativeContext(actual, env).name, 'button-worker');
    assert.equal(JSON.stringify(actual), bytes);
    const placeholder = createNativeConfig();
    placeholder.r2_buckets[0].preview_bucket_name = placeholder.r2_buckets[0].bucket_name;
    validateNativeConfig(placeholder);
    assert.throws(() => validateNativeConfig(placeholder, { provisioned: true }), /must provision D1/);
});

test('native profile rejects another or malformed preview bucket without ignoring the field', () => {
    for (const value of ['another-bucket', '../escape', '', null, undefined, false, 1, [], {}]) {
        const actual = structuredClone(config);
        actual.r2_buckets[0].preview_bucket_name = value;
        assert.throws(() => validateNativeConfig(actual), /protected template/);
        assert.equal(actual.r2_buckets[0].preview_bucket_name, value);
    }
});

test('a matching preview bucket does not relax authentication, binding or production guards', () => {
    const actual = structuredClone(config);
    actual.r2_buckets[0].preview_bucket_name = actual.r2_buckets[0].bucket_name;
    for (const changed of [
        { ...actual, assets: { ...actual.assets, run_worker_first: false } },
        { ...actual, preview_urls: true }, { ...actual, secrets: { required: ['AUTH_PASSWORD'] } },
        { ...actual, r2_buckets: [{ ...actual.r2_buckets[0], binding: 'OTHER' }] },
        { ...actual, r2_buckets: [{ ...actual.r2_buckets[0], unexpected: true }] },
        { ...actual, r2_buckets: [...actual.r2_buckets, { binding: 'OTHER', bucket_name: 'other' }] },
    ]) assert.throws(() => validateNativeConfig(changed), /protected template/);
    assert.throws(() => nativeContext(actual, { ...env, WORKERS_CI_BRANCH: 'preview' }));
});

test('native deployment requires platform production context and rejects an ambiguous account', () => {
    for (const change of [
        { WORKERS_CI: '' }, { CI: '' }, { WORKERS_CI_BRANCH: 'preview' },
        { WORKERS_CI_COMMIT_SHA: '' }, { WORKERS_CI_BUILD_UUID: '' }, { CLOUDFLARE_ACCOUNT_ID: '' },
        { WRANGLER_CI_OVERRIDE_NAME: '../other' },
    ]) assert.throws(() => nativeContext(config, { ...env, ...change }));
    assert.equal(nativeContext(config, { ...env, WRANGLER_CI_OVERRIDE_NAME: 'my-tavern' }).name, 'my-tavern');
    assert.throws(() => nativeContext({ ...config, account_id: 'c'.repeat(32) }, env));
});

test('plugin build child receives only tool/runtime environment, not arbitrary build secrets', () => {
    const clean = buildEnvironment({ PATH: 'synthetic-path', HOME: '/tmp/test', WORKERS_CI: '1', ...env,
        CLOUDFLARE_API_TOKEN: 'never-share', GITHUB_TOKEN: 'never-share', DATA_KEY: 'never-share',
        AUTH_PASSWORD: 'never-share', CUSTOM_PRIVATE_CREDENTIAL: 'never-share', NODE_OPTIONS: '--require malicious.js' });
    assert.equal(clean.PATH, 'synthetic-path');
    assert.equal(clean.CI, 'true');
    assert.equal(clean.WORKERS_CI, undefined);
    assert.ok(!JSON.stringify(clean).includes('never-share'));
    assert.equal(clean.NODE_OPTIONS, undefined);
});

test('native binding inspection allows a fresh platform placeholder but rejects replacement of existing resources', () => {
    assert.deepEqual(inspectNativeBindings(config, freshBindings()), { hasDataKey: false });
    assert.throws(() => inspectNativeBindings(config, freshBindings(), { complete: true }));
    for (const changed of [
        freshBindings().filter(item => item.name !== 'AUTH_PASSWORD'),
        [...freshBindings(), { name: 'AUTH_PASSWORD', type: 'secret_text' }],
        [...freshBindings(), { name: 'EXTRA', type: 'plain_text', text: 'private' }],
        freshBindings().map(item => item.name === 'DB' ? { ...item, id: 'different' } : item),
        freshBindings().map(item => item.name === 'FILES' ? { ...item, bucket_name: 'different' } : item),
        freshBindings().map(item => item.name === 'AUTH_PASSWORD' ? { ...item, type: 'plain_text' } : item),
    ]) assert.throws(() => inspectNativeBindings(config, changed));
});

test('first initialization migrates, claims the empty database, persists one key before upload and saves plugin history', async t => {
    const f = fixture(t);
    const result = await initializeAndDeploy(config, context, lock, f.client, f.hooks);
    assert.equal(result.initializedKey, true);
    assert.equal(result.runtimeVerified, false);
    assert.equal(f.keys.length, 1);
    assert.equal(Buffer.from(f.keys[0], 'base64').length, 32);
    assert.ok(f.events.indexOf('migrate') < f.events.indexOf('key'));
    assert.ok(f.events.indexOf('key') < f.events.indexOf('upload'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents').get().n, 0);
    assert.deepEqual(await previousNativePlugins(f.client), lock);
    assert.equal(JSON.parse(f.db.prepare("SELECT payload FROM stworkers_deployment_state WHERE id='initialization'").get().payload).status, 'ready');
});

test('a normal update preserves document bytes and never generates or writes another encryption key', async t => {
    const f = fixture(t, { initialized: true, documents: true });
    const saved = f.db.prepare('SELECT * FROM documents').all();
    const result = await initializeAndDeploy(config, context, lock, f.client, {
        ...f.hooks, randomKey() { throw new Error('Must never generate'); },
    });
    assert.equal(result.existingKeyInherited, true);
    assert.deepEqual(f.db.prepare('SELECT * FROM documents').all(), saved);
    assert.deepEqual(f.keys, []);
});

test('missing encryption key with existing documents is rejected before migrations or upload', async t => {
    const f = fixture(t, { documents: true });
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, f.hooks), /Restore the original key/);
    assert.ok(!f.events.includes('migrate') && !f.events.includes('key') && !f.events.includes('upload'));
});

test('native upgrades recognize account tables and never replace a missing key for an existing owner', async t => {
    const f = fixture(t, { initialized: true });
    await f.hooks.migrate();
    f.db.prepare(`INSERT INTO stworkers_accounts
        (handle,name,avatar,password_hash,salt,bootstrap_hash,version,created)
        VALUES ('owner','Retained','','hash','salt','bootstrap',3,1)`).run();
    const account = f.db.prepare('SELECT * FROM stworkers_accounts').get();
    await initializeAndDeploy(config, context, lock, f.client, f.hooks);
    assert.deepEqual(f.db.prepare('SELECT * FROM stworkers_accounts').get(), account);
    f.bindings.splice(f.bindings.findIndex(binding => binding.name === 'DATA_KEY'), 1);
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, f.hooks), /Restore the original key/);
    assert.deepEqual(f.keys, []);
});

test('missing owner secret, wrong resource names, and unrelated database tables cannot trigger initialization', async t => {
    for (const mutate of [
        f => f.bindings.shift(),
        f => { f.client.database = async () => ({ name: 'different-db' }); },
        f => { f.client.bucket = async () => ({ name: 'different-bucket' }); },
        f => f.db.exec('CREATE TABLE unrelated (id INTEGER)'),
    ]) {
        const f = fixture(t);
        mutate(f);
        await assert.rejects(initializeAndDeploy(config, context, lock, f.client, f.hooks));
        assert.ok(!f.events.includes('migrate') && !f.events.includes('key') && !f.events.includes('upload'));
    }
});

test('migration failure cannot write a key, upload code, or record a successful plugin lock', async t => {
    const f = fixture(t);
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, {
        ...f.hooks, async migrate() { throw new Error('Synthetic failed migration'); },
    }));
    assert.deepEqual(f.keys, []);
    assert.ok(!f.events.includes('upload'));
});

test('asset-upload failure preserves the initialized key and retry inherits it', async t => {
    const f = fixture(t);
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, {
        ...f.hooks, async upload() { throw new Error('Synthetic upload interruption'); },
    }));
    assert.equal(f.keys.length, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM stworkers_deployment_state WHERE id='plugins'").get().n, 0);
    const result = await initializeAndDeploy(config, context, lock, f.client, f.hooks);
    assert.equal(result.existingKeyInherited, true);
    assert.equal(f.keys.length, 1);
});

test('uncertain secret creation retains its claim and cannot silently generate a replacement on retry', async t => {
    const f = fixture(t);
    f.client.createDataKey = async () => { throw new Error('Synthetic network interruption'); };
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, f.hooks));
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, f.hooks), /Restore the original key/);
    assert.ok(!f.events.includes('upload'));
});

test('concurrent first initialization has one winner and cannot replace its secret', async t => {
    const f = fixture(t);
    const outcomes = await Promise.allSettled([
        initializeAndDeploy(config, context, lock, f.client, f.hooks),
        initializeAndDeploy(config, { ...context, buildId: '33333333-3333-4333-8333-333333333333' }, lock, f.client, f.hooks),
    ]);
    assert.equal(f.keys.length, 1);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
});

test('post-upload binding verification failure does not save a success marker or plugin lock', async t => {
    const f = fixture(t);
    await assert.rejects(initializeAndDeploy(config, context, lock, f.client, {
        ...f.hooks, async upload() { f.bindings.splice(0, 1); },
    }));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM stworkers_deployment_state WHERE id='plugins'").get().n, 0);
    assert.equal(JSON.parse(f.db.prepare("SELECT payload FROM stworkers_deployment_state WHERE id='initialization'").get().payload).status, 'pending');
});

test('existing source pins win, added plugin pins survive native rebuilds, and removed plugins stay removed', () => {
    const first = lock.plugins[0], second = lock.plugins[1];
    const prior = { schema: 1, plugins: [{ ...first, commit: 'f'.repeat(40) }, second] };
    const source = { schema: 1, plugins: [first] };
    const specs = parsePluginList(lock.plugins.map(item => `https://github.com/${item.repository}`).join('\n'));
    assert.deepEqual(mergePluginHistory(specs, source, prior), lock);
    assert.deepEqual(mergePluginHistory(specs.slice(0, 1), source, prior), source);
    assert.deepEqual(mergePluginHistory([], source, prior), { schema: 1, plugins: [] });
    assert.throws(() => mergePluginHistory(specs, source, { schema: 1, plugins: [{ token: 'not-a-plugin' }] }));
});

test('empty database has no prior plugin history; corrupt saved history is not ignored', async t => {
    const f = fixture(t);
    assert.deepEqual(await previousNativePlugins(f.client), { schema: 1, plugins: [] });
    await f.hooks.migrate();
    f.db.prepare("INSERT INTO stworkers_deployment_state(id,payload) VALUES('plugins','{}')").run();
    await assert.rejects(previousNativePlugins(f.client), /Invalid plugins.lock/);
});

test('control-plane requests remain on the selected Cloudflare account without redirects or cookie forwarding', async () => {
    const requests = [], token = 'synthetic-native-token-never-log';
    const client = nativeClient(config, context, token, { fetchImpl: async (url, options) => {
        requests.push({ url, options });
        assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${context.accountId}/`));
        assert.equal(options.redirect, 'manual');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.headers.Cookie, undefined);
        if (url.endsWith('/query')) return Response.json({ success: true, result: [{ success: true, results: [] }] });
        return Response.json({ success: true, result: {} });
    } });
    await client.settings();
    await client.database();
    await client.bucket();
    await client.query('SELECT 1');
    await client.createDataKey('a'.repeat(43) + '=');
    assert.equal(requests.length, 5);
    assert.equal(JSON.parse(requests[4].options.body).name, 'DATA_KEY');
    assert.equal(requests[4].options.method, 'PUT');
});

test('API permission, redirect, parse and network errors do not disclose response bodies or credentials', async () => {
    for (const response of [
        new Response('private-response', { status: 403 }),
        new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/private-response' } }),
        new Response('private-response'), Response.json({ success: false, result: {}, errors: ['private-response'] }),
    ]) {
        const client = nativeClient(config, context, 'private-token', { fetchImpl: async () => response });
        await assert.rejects(client.settings(), error => error.message.includes('Cloudflare')
            && !error.message.includes('private-response') && !error.message.includes('private-token'));
    }
    const client = nativeClient(config, context, 'private-token', { fetchImpl: async () => { throw new Error('private-response'); } });
    await assert.rejects(client.settings(), /HTTP unavailable/);
});

test('credential capture is private and child-process failures never leak captured token output', () => {
    const token = 'synthetic-native-token-never-log';
    assert.equal(nativeToken('/synthetic', { CLOUDFLARE_API_TOKEN: token }, () => { throw new Error(); }), token);
    assert.equal(nativeToken('/synthetic', {}, (root, args, env, capture) => {
        assert.equal(capture, true);
        assert.ok(args.includes('token') && args.includes('--json'));
        return JSON.stringify({ type: 'api_token', token });
    }), token);
    assert.throws(() => nativeToken('/synthetic', {}, () => { throw new Error(token); }),
        error => !error.message.includes(token));
});

async function releaseFixture(t, selectedConfig = config) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stworkers-native-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const worker = path.join(root, 'cloudflare'), build = path.join(worker, '.build');
    const actions = path.join(build, 'actions'), native = path.join(build, 'native'), assets = path.join(build, 'assets-p3');
    for (const dir of [actions, native, path.join(assets, '__stworks')]) await mkdir(dir, { recursive: true });
    const empty = { schema: 1, plugins: [] };
    const put = async (file, value) => writeFile(file, JSON.stringify(value));
    await put(path.join(root, 'wrangler.jsonc'), selectedConfig);
    await writeFile(path.join(root, 'plugins.txt'), '');
    await put(path.join(root, 'plugins.lock.json'), empty);
    await put(path.join(actions, 'plugins.lock.json'), empty);
    const bootstrap = JSON.stringify({ stworks: { extensions: [{ name: 'regex' }, { name: 'quick-reply' }] } });
    await writeFile(path.join(assets, '__stworks/bootstrap.json'), bootstrap);
    await writeFile(path.join(assets, 'index.html'), 'synthetic');
    const manifest = { extensionsBundled: [], extensionsDiscovered: ['regex', 'quick-reply'],
        totalAssetFiles: 2, totalAssetBytes: Buffer.byteLength(bootstrap) + 9 };
    await put(path.join(build, 'build-manifest-p3.json'), manifest);
    const receipt = { schema: 1, validation: 'local-build-and-dry-run-only',
        inputListSha256: digest(Buffer.from('')), inputLockSha256: digest(Buffer.from(JSON.stringify(empty))),
        pluginLockSha256: digest(Buffer.from(JSON.stringify(empty))),
        manifestSha256: digest(Buffer.from(JSON.stringify(manifest))), lockChanged: false };
    await put(path.join(actions, 'release.json'), receipt);
    await put(path.join(native, 'release.json'), { passed: true, stage: 'build-and-dry-run-only',
        revision: env.WORKERS_CI_COMMIT_SHA, configSha256: digest(Buffer.from(JSON.stringify(selectedConfig))),
        receiptSha256: digest(Buffer.from(JSON.stringify(receipt))) });
    const f = fixture(t), commands = [], requests = [];
    const options = {
        run(cwd, args) {
            assert.equal(cwd, root);
            commands.push(args);
            if (args[1] === 'd1') return f.hooks.migrate();
            if (args[1] === 'deploy') return f.hooks.upload();
            throw new Error('Unexpected command.');
        },
        async fetchImpl(url, request) {
            requests.push({ url, method: request.method });
            let result;
            if (url.endsWith('/settings')) result = await f.client.settings();
            else if (url.endsWith('/query')) {
                const body = JSON.parse(request.body);
                result = [{ success: true, results: await f.client.query(body.sql, body.params) }];
            } else if (url.endsWith('/secrets')) {
                await f.client.createDataKey(JSON.parse(request.body).text);
                result = {};
            } else if (url.includes('/d1/database/')) result = await f.client.database();
            else if (url.includes('/r2/buckets/')) result = await f.client.bucket();
            else throw new Error('Unexpected endpoint.');
            return Response.json({ success: true, result });
        },
    };
    return { root, native, assets, actions, commands, requests, options, ...f };
}

test('native deploy wrapper binds migrations to DB, inherits secrets on upload and records a verified result', async t => {
    const f = await releaseFixture(t);
    const result = await deployNativeRelease(f.root, { ...env, CLOUDFLARE_API_TOKEN: 'synthetic-native-api-token' }, f.options);
    assert.equal(result.uploadCompleted, true);
    assert.equal(f.commands.length, 2);
    assert.deepEqual(f.commands[0].slice(1, 6), ['d1', 'migrations', 'apply', 'DB', '--remote']);
    assert.ok(f.commands[1].includes('--x-auto-create=false') && f.commands[1].includes('--no-x-provision'));
    assert.ok(!f.commands[1].includes('--secrets-file'));
    const recorded = JSON.parse(await readFile(path.join(f.native, 'deployment.json'), 'utf8'));
    assert.equal(recorded.bindingsVerified, true);
    assert.equal(f.keys.length, 1);
});

test('native deploy preserves the platform preview bucket and the exact configuration receipt', async t => {
    const selected = structuredClone(config);
    selected.r2_buckets[0].preview_bucket_name = selected.r2_buckets[0].bucket_name;
    const f = await releaseFixture(t, selected);
    const configFile = path.join(f.root, 'wrangler.jsonc');
    const before = await readFile(configFile);
    const result = await deployNativeRelease(f.root, { ...env, CLOUDFLARE_API_TOKEN: 'synthetic-native-api-token' }, f.options);
    assert.equal(result.uploadCompleted, true);
    assert.equal(result.bindingsVerified, true);
    assert.deepEqual(await readFile(configFile), before);
    assert.equal(f.commands.length, 2);
    assert.ok(f.events.indexOf('migrate') < f.events.indexOf('key'));
    assert.ok(f.events.indexOf('key') < f.events.indexOf('upload'));
    assert.equal(f.keys.length, 1);
});

test('native deploy rejects local/preview context, changed configuration and stale build metadata before remote requests', async t => {
    for (const change of [
        async f => ({ ...env, WORKERS_CI: '' }),
        async f => ({ ...env, WORKERS_CI_BRANCH: 'feature' }),
        async f => { await writeFile(path.join(f.root, 'wrangler.jsonc'), JSON.stringify(config) + '\n'); return env; },
        async f => {
            const changed = structuredClone(config);
            changed.r2_buckets[0].preview_bucket_name = changed.r2_buckets[0].bucket_name;
            await writeFile(path.join(f.root, 'wrangler.jsonc'), JSON.stringify(changed));
            return env;
        },
        async f => { await writeFile(path.join(f.native, 'release.json'), '{"passed":false}'); return env; },
    ]) {
        const f = await releaseFixture(t);
        const selected = await change(f);
        await assert.rejects(deployNativeRelease(f.root, { ...selected, CLOUDFLARE_API_TOKEN: 'synthetic-native-api-token' }, f.options));
        assert.equal(f.requests.length, 0);
        assert.equal(f.commands.length, 0);
    }
});

test('native deploy rejects a credential in assets before migration or upload', async t => {
    const f = await releaseFixture(t);
    const token = 'synthetic-native-api-token';
    await writeFile(path.join(f.assets, 'index.html'), token);
    await assert.rejects(deployNativeRelease(f.root, { ...env, CLOUDFLARE_API_TOKEN: token }, f.options),
        error => /secret was found/.test(error.message) && !error.message.includes(token));
    assert.equal(f.requests.length, 0);
    assert.equal(f.commands.length, 0);
});

test('native deploy records an upload attempt honestly when a child process fails and redacts captured output', async t => {
    const f = await releaseFixture(t);
    const original = f.options.run;
    f.options.run = (root, args) => {
        if (args[1] === 'deploy') throw Object.assign(new Error('private-command-output'), { status: 1, stdout: 'private-command-output' });
        return original(root, args);
    };
    await assert.rejects(deployNativeRelease(f.root, { ...env, CLOUDFLARE_API_TOKEN: 'synthetic-native-api-token' }, f.options),
        error => error.message.includes('upload started: true') && !error.message.includes('private-command-output'));
    const recorded = JSON.parse(await readFile(path.join(f.native, 'deployment.json'), 'utf8'));
    assert.deepEqual(recorded, { passed: false, migrationStarted: true, uploadStarted: true });
    assert.equal(f.keys.length, 1);
});
