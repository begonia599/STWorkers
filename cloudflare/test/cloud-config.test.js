import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    ACCOUNT_PLACEHOLDER, DATABASE_PLACEHOLDER, DEFAULT_CLOUD_NAME,
    checkCloud, createCloudConfig, prepareCloud, validateCloudConfig, validateCloudSecrets,
} from '../scripts/cloud-config.mjs';

const base = {
    name: 'stworks', compatibility_date: '2026-09-08',
    compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
};
const ids = { accountId: 'a'.repeat(32), databaseId: '12345678-1234-4321-8123-123456789abc' };
const secrets = () => ({ AUTH_PASSWORD: randomBytes(36).toString('base64url'), DATA_KEY: randomBytes(32).toString('base64') });
const json = (file, value) => writeFile(file, JSON.stringify(value));

async function fixture(t) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'stworks-cloud-config-'));
    const root = path.join(parent, 'cloudflare');
    await mkdir(root);
    t.after(() => rm(parent, { recursive: true, force: true }));
    await json(path.join(root, 'wrangler.jsonc'), base);
    await writeFile(path.join(root, '.dev.vars'), 'AUTH_PASSWORD=local-sentinel\nDATA_KEY=local-sentinel-key\n');
    return root;
}

async function assetsFixture(root, plugins = false) {
    const build = path.join(root, '.build');
    const assets = path.join(build, plugins ? 'assets-p3' : 'assets');
    await mkdir(path.join(assets, '__stworks'), { recursive: true });
    const extensions = [{ id: 'JS-Slash-Runner', commit: 'a'.repeat(40) }, { id: 'ST-Prompt-Template', commit: 'b'.repeat(40) }];
    const bundled = plugins ? extensions.map(item => ({ name: `third-party/${item.id}`, commit: item.commit })) : [];
    const discovered = ['regex', 'quick-reply', ...bundled.map(item => item.name)];
    await json(path.join(root, '..', 'upstream-lock.json'), { extensions });
    const bootstrap = JSON.stringify({ stworks: { extensions: discovered.map(name => ({ name })) } });
    await writeFile(path.join(assets, '__stworks', 'bootstrap.json'), bootstrap);
    await writeFile(path.join(assets, 'index.html'), '<html>synthetic</html>');
    const manifest = {
        extensionsBundled: bundled, extensionsDiscovered: discovered,
        totalAssetFiles: 2, totalAssetBytes: Buffer.byteLength(bootstrap) + Buffer.byteLength('<html>synthetic</html>'),
    };
    const manifestPath = path.join(build, plugins ? 'build-manifest-p3.json' : 'build-manifest.json');
    await json(manifestPath, manifest);
    return { assets, manifest, manifestPath };
}

test('cloud profile isolates names and paths, requires both secrets, and protects every asset', () => {
    const config = createCloudConfig(base);
    assert.equal(config.name, DEFAULT_CLOUD_NAME);
    assert.equal(config.account_id, ACCOUNT_PLACEHOLDER);
    assert.equal(config.d1_databases[0].database_id, DATABASE_PLACEHOLDER);
    assert.equal(config.d1_databases[0].database_name, `${DEFAULT_CLOUD_NAME}-db`);
    assert.equal(config.r2_buckets[0].bucket_name, `${DEFAULT_CLOUD_NAME}-files`);
    assert.equal(config.assets.directory, '../../.build/assets');
    assert.equal(config.assets.run_worker_first, true);
    assert.deepEqual(config.secrets.required, ['AUTH_PASSWORD', 'DATA_KEY']);
    assert.equal(config.preview_urls, false);
    assert.equal(config.observability.enabled, false);
    assert.equal(config.vars, undefined);
    assert.equal(validateCloudConfig(config, base, DEFAULT_CLOUD_NAME, { draft: true }), false);
    assert.throws(() => validateCloudConfig(config, base, DEFAULT_CLOUD_NAME), /account_id/);
});

test('fully configured P3 profile passes only the offline resource-ID gate', () => {
    const config = createCloudConfig(base, { ...ids, withP3Plugins: true });
    assert.equal(config.assets.directory, '../../.build/assets-p3');
    assert.equal(validateCloudConfig(config, base, DEFAULT_CLOUD_NAME), true);
});

test('unsafe names and reuse of the base database ID are rejected', () => {
    for (const name of ['stworks', '../escape', 'a\\b', '-bad', 'bad-', 'UPPER', 'a', 'a'.repeat(48), 'bad:name']) {
        assert.throws(() => createCloudConfig(base, { name }), /cloud test name/);
    }
    assert.throws(() => createCloudConfig({ ...base, d1_databases: [{ database_id: ids.databaseId }] }, ids), /must not reuse/);
});

test('resource IDs reject empty values and substitution placeholders other than the explicit draft markers', () => {
    for (const accountId of ['', 'YOUR_ACCOUNT', 'g'.repeat(32), 'a'.repeat(31)]) {
        assert.throws(() => createCloudConfig(base, { accountId }), /account_id/);
    }
    for (const databaseId of ['', 'TODO', 'a'.repeat(32), '12345678-1234-1234-1234-zzzzzzzzzzzz']) {
        assert.throws(() => createCloudConfig(base, { databaseId }), /database_id/);
    }
    assert.throws(() => validateCloudConfig(createCloudConfig(base, { accountId: ids.accountId }),
        base, DEFAULT_CLOUD_NAME), /database_id/);
});

test('preflight tolerates an obsolete model allowlist without requiring manual migration or changing files', () => {
    for (const vars of [{}, { MODEL_ALLOWED_ORIGINS: '[]' },
        { MODEL_ALLOWED_ORIGINS: '["https://old-provider.example"]' }, { MODEL_ALLOWED_ORIGINS: 'invalid-json' }]) {
        const config = { ...createCloudConfig(base, ids), vars };
        const before = JSON.stringify(config);
        assert.equal(validateCloudConfig(config, base, DEFAULT_CLOUD_NAME), true);
        assert.equal(JSON.stringify(config), before);
    }
});

test('preflight rejects auth bypass, local assets, extra vars, remote hooks and changed resource names', () => {
    const changes = [
        c => { c.assets.run_worker_first = false; },
        c => { c.assets.run_worker_first = ['/api/*']; },
        c => { c.assets.directory = '../../data'; },
        c => { c.assets.html_handling = 'auto-trailing-slash'; },
        c => { c.main = '../../server.js'; },
        c => { c.preview_urls = true; },
        c => { c.vars = { AUTH_PASSWORD: 'should-not-be-a-var' }; },
        c => { c.vars = { MODEL_ALLOWED_ORIGINS: '[]', AUTH_PASSWORD: 'should-not-be-a-var' }; },
        c => { c.vars = { UNEXPECTED: 'value' }; },
        c => { c.vars = []; },
        c => { c.secrets.required = ['AUTH_PASSWORD']; },
        c => { c.routes = ['example.com/*']; },
        c => { c.build = { command: 'unexpected-hook' }; },
        c => { c.d1_databases[0].database_name = 'stworks'; },
        c => { c.r2_buckets[0].bucket_name = 'stworks-files'; },
        c => { c.r2_buckets[0].remote = true; },
        c => { delete c.account_id; },
        c => { delete c.d1_databases[0].database_id; },
    ];
    for (const change of changes) {
        const config = createCloudConfig(base, ids);
        change(config);
        assert.throws(() => validateCloudConfig(config, base, DEFAULT_CLOUD_NAME));
    }
});

test('secret checks reject missing, extra or malformed credentials', () => {
    validateCloudSecrets(secrets());
    for (const value of [null, {}, { AUTH_PASSWORD: 'only-one' }, { ...secrets(), CLOUDFLARE_API_TOKEN: 'never-copy' },
        ...['', null, 123456, {}, 'x'.repeat(1025)].map(AUTH_PASSWORD => ({ ...secrets(), AUTH_PASSWORD })),
        { ...secrets(), DATA_KEY: 'invalid' },
        { ...secrets(), DATA_KEY: randomBytes(31).toString('base64') }]) {
        assert.throws(() => validateCloudSecrets(value));
    }
});

test('user-chosen nonempty passwords pass without changing the independent encryption key', () => {
    for (const AUTH_PASSWORD of ['a', 'test12', 'test1234', 'x'.repeat(23), 'x'.repeat(1024), ' p! ', '\u5bc6\u7801']) {
        const value = { ...secrets(), AUTH_PASSWORD };
        const before = structuredClone(value);
        validateCloudSecrets(value);
        assert.deepEqual(value, before);
        assert.throws(() => validateCloudSecrets({ ...value, DATA_KEY: 'short' }));
    }
});

test('setup creates independent credentials without changing local settings; rerun preserves exact bytes', async t => {
    const root = await fixture(t);
    const before = await readFile(path.join(root, '.dev.vars'));
    const first = await prepareCloud(root);
    const keyFile = path.join(first.directory, 'secrets.json');
    const configFile = path.join(first.directory, 'wrangler.json');
    const saved = await readFile(keyFile);
    const savedConfig = await readFile(configFile);
    validateCloudSecrets(JSON.parse(saved));
    assert.match(JSON.parse(saved).AUTH_PASSWORD, /^[A-Za-z0-9_-]{48}$/);
    assert.equal(first.created, true);
    assert.equal((await prepareCloud(root)).created, false);
    assert.deepEqual(await readFile(keyFile), saved);
    assert.deepEqual(await readFile(configFile), savedConfig);
    assert.deepEqual(await readFile(path.join(root, '.dev.vars')), before);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'))), base);
    const second = await prepareCloud(root, { name: 'stworks-second-test' });
    assert.notDeepEqual(JSON.parse(await readFile(path.join(second.directory, 'secrets.json'))), JSON.parse(saved));
});

test('rerun and preflight preserve a short chosen password without mistaking ordinary asset text for a leak', async t => {
    const root = await fixture(t);
    const prepared = await prepareCloud(root, ids);
    const keyFile = path.join(prepared.directory, 'secrets.json');
    const values = JSON.parse(await readFile(keyFile));
    values.AUTH_PASSWORD = 'h';
    await json(keyFile, values);
    const saved = await readFile(keyFile);
    const { assets } = await assetsFixture(root);
    assert.equal((await prepareCloud(root, ids)).created, false);
    assert.equal((await checkCloud(root)).resourceIdsConfigured, true);
    assert.deepEqual(await readFile(keyFile), saved);
    await writeFile(path.join(assets, 'index.html'), values.DATA_KEY);
    await assert.rejects(checkCloud(root), /secret was found/);
});

test('rerun preserves manually filled IDs and rejects conflicting setup options', async t => {
    const root = await fixture(t);
    const result = await prepareCloud(root);
    await json(path.join(result.directory, 'wrangler.json'), createCloudConfig(base, ids));
    assert.equal((await prepareCloud(root)).created, false);
    assert.equal((await prepareCloud(root, ids)).created, false);
    await assert.rejects(prepareCloud(root, { withP3Plugins: true }), /Nothing was overwritten/);
    await assert.rejects(prepareCloud(root, { accountId: 'b'.repeat(32) }), /Nothing was overwritten/);
});

test('rerun and preflight preserve legacy deployment files and encryption keys without a model-origin setting', async t => {
    const root = await fixture(t);
    const prepared = await prepareCloud(root, ids);
    const configFile = path.join(prepared.directory, 'wrangler.json');
    const keyFile = path.join(prepared.directory, 'secrets.json');
    const config = JSON.parse(await readFile(configFile));
    config.vars = { MODEL_ALLOWED_ORIGINS: '[]' };
    await json(configFile, config);
    const before = await readFile(configFile);
    const beforeKey = await readFile(keyFile);
    await assetsFixture(root);
    assert.equal((await prepareCloud(root, ids)).created, false);
    assert.equal((await checkCloud(root)).resourceIdsConfigured, true);
    assert.deepEqual(await readFile(configFile), before);
    assert.deepEqual(await readFile(keyFile), beforeKey);
});

test('partial or malformed setup never silently regenerates a key', async t => {
    const root = await fixture(t);
    const first = await prepareCloud(root);
    const keyFile = path.join(first.directory, 'secrets.json');
    const saved = await readFile(keyFile);
    await rm(path.join(first.directory, 'wrangler.json'));
    await assert.rejects(prepareCloud(root), { code: 'ENOENT' });
    assert.deepEqual(await readFile(keyFile), saved);
    await writeFile(path.join(first.directory, 'wrangler.json'), '{"secret":"DO-NOT-ECHO"');
    await assert.rejects(prepareCloud(root), error => error.message.includes('Invalid JSON') && !error.message.includes('DO-NOT-ECHO'));
    assert.deepEqual(await readFile(keyFile), saved);
});

test('parallel setup attempts cannot replace the winning key', async t => {
    const root = await fixture(t);
    const results = await Promise.allSettled([prepareCloud(root), prepareCloud(root)]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.created).length, 1);
    const keyFile = path.join(root, '.deploy', DEFAULT_CLOUD_NAME, 'secrets.json');
    const saved = await readFile(keyFile);
    await prepareCloud(root);
    assert.deepEqual(await readFile(keyFile), saved);
});

test('setup and preflight refuse linked deployment directories', async t => {
    const root = await fixture(t);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, '.deploy'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareCloud(root), /linked/);
    await rm(path.join(root, '.deploy'));
    await mkdir(path.join(root, '.deploy'));
    await symlink(outside, path.join(root, '.deploy', DEFAULT_CLOUD_NAME), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareCloud(root), /linked/);
    await assert.rejects(checkCloud(root, { draft: true }), /linked/);
});

test('draft assets pass without claiming cloud verification, while normal check blocks missing IDs', async t => {
    const root = await fixture(t);
    await prepareCloud(root);
    await assetsFixture(root);
    const result = await checkCloud(root, { draft: true });
    assert.equal(result.cloudVerified, false);
    assert.equal(result.resourceIdsConfigured, false);
    assert.equal(result.validation, 'draft-only-resource-ids-required');
    assert.equal(result.assets.files, 2);
    await assert.rejects(checkCloud(root), /account_id/);
});

test('configured P3 inventory passes offline and requires both locked plugins', async t => {
    const root = await fixture(t);
    await prepareCloud(root, { ...ids, withP3Plugins: true });
    const { manifest, manifestPath } = await assetsFixture(root, true);
    const result = await checkCloud(root);
    assert.equal(result.resourceIdsConfigured, true);
    assert.equal(result.cloudVerified, false);
    assert.equal(result.assets.plugins.length, 2);
    manifest.extensionsBundled[1] = manifest.extensionsBundled[0];
    await json(manifestPath, manifest);
    await assert.rejects(checkCloud(root), /pinned plugin/);
});

test('preflight rejects missing builds, changed inventory and bootstrap discovery', async t => {
    const root = await fixture(t);
    await prepareCloud(root, ids);
    await assert.rejects(checkCloud(root), { code: 'ENOENT' });
    const { assets } = await assetsFixture(root);
    await writeFile(path.join(assets, 'extra.txt'), 'extra');
    await assert.rejects(checkCloud(root), /inventory/);
    await rm(path.join(assets, 'extra.txt'));
    await json(path.join(assets, '__stworks', 'bootstrap.json'), { stworks: { extensions: [] } });
    await assert.rejects(checkCloud(root), /discovery/);
});

test('the exact empty upstream gitkeep is permitted but is not a general dotfile exception', async t => {
    const root = await fixture(t);
    await prepareCloud(root, ids);
    const { assets, manifest, manifestPath } = await assetsFixture(root);
    const directory = path.join(assets, 'scripts', 'extensions', 'third-party');
    await mkdir(directory, { recursive: true });
    const placeholder = path.join(directory, '.gitkeep');
    await writeFile(placeholder, '');
    manifest.totalAssetFiles++;
    await json(manifestPath, manifest);
    assert.equal((await checkCloud(root)).assets.files, 3);
    await writeFile(placeholder, 'unexpected content');
    await assert.rejects(checkCloud(root), /must remain empty/);
    await writeFile(placeholder, '');
    await writeFile(path.join(assets, '.gitkeep'), '');
    await assert.rejects(checkCloud(root), /Private, linked or routing/);
});

test('preflight rejects private files, leaked deployment secrets and per-file oversize', async t => {
    const root = await fixture(t);
    const prepared = await prepareCloud(root, ids);
    const { assets } = await assetsFixture(root);
    for (const file of ['.dev.vars', 'secrets.json', 'wrangler.json', '_redirects', '_headers']) {
        await writeFile(path.join(assets, file), 'private');
        await assert.rejects(checkCloud(root), /Private, linked or routing/);
        await rm(path.join(assets, file));
    }
    const key = JSON.parse(await readFile(path.join(prepared.directory, 'secrets.json')));
    for (const secret of [key.DATA_KEY, key.AUTH_PASSWORD]) {
        await writeFile(path.join(assets, 'index.html'), secret);
        await assert.rejects(checkCloud(root), /secret was found/);
    }
    await writeFile(path.join(assets, 'index.html'), Buffer.alloc(25 * 1024 * 1024 + 1));
    await assert.rejects(checkCloud(root), /per-file limit/);
    assert.equal((await stat(path.join(assets, 'index.html'))).size, 25 * 1024 * 1024 + 1);
});
