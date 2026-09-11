import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { assertLockMatchesList, parsePluginList, preparePluginSelection, readPluginInputs, validatePluginLock } from '../scripts/plugin-list.mjs';
import { copyPluginBundle, digest, isPluginRuntimeFile, packagePlugins, readPinnedArchive } from '../scripts/plugin-package.mjs';
import { buildActionsRelease, readReleaseSelection } from '../scripts/actions-release.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const empty = () => ({ schema: 1, plugins: [] });
const url = 'https://github.com/example/fixture';
const json = (file, value) => writeFile(file, JSON.stringify(value));
function archive(commit = A, extra = {}, name = 'fixture') {
    return Buffer.from(zipSync(Object.fromEntries(Object.entries({
        'manifest.json': JSON.stringify({ display_name: 'Synthetic plugin', version: commit === A ? '1' : '2',
            js: 'index.js', css: 'style.css', i18n: { en: 'translations/en.json' } }),
        'index.js': 'import "./nested/util.js";',
        'nested/util.js': 'export const fixture = true;',
        'style.css': '.synthetic { color: green; }',
        'translations/en.json': '{}', 'templates/panel.html': '<div>Fixture</div>',
        'icons/logo.svg': '<svg/>', 'COPYING': 'Synthetic license',
        'package.json': '{"scripts":{"install":"must-not-run"}}', 'build.sh': 'must-not-run',
        '.env': 'must-not-deploy', '.github/workflows/example.yml': 'must-not-run',
        ...extra,
    }).map(([file, text]) => [`${name}-${commit}/${file}`, Buffer.from(text)])), { mtime: new Date('2020-01-01T00:00:00Z') }));
}
function transport({ head = A, extra = {}, name = 'fixture' } = {}) {
    const state = { head, calls: [] };
    state.fetchImpl = async (target, options) => {
        state.calls.push(target);
        assert.equal(options.redirect, 'manual');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Cookie, undefined);
        if (target === `https://api.github.com/repos/example/${name}/commits/HEAD`) return new Response(state.head);
        if (target.startsWith(`https://codeload.github.com/example/${name}/zip/`)) return new Response(archive(target.split('/').at(-1), extra, name));
        throw new Error('Unexpected destination.');
    };
    return state;
}
async function temp(t) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'stworkers-plugin-list-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    return parent;
}

test('list accepts comments, blank lines, BOM, CRLF, .git suffix and selected refs', () => {
    assert.deepEqual(parsePluginList(`\uFEFF# comment\r\n\r\n ${url}.git/ \r\nhttps://github.com/other/second#release/v1\n`), [
        { id: 'fixture', repository: 'example/fixture', ref: 'HEAD' },
        { id: 'second', repository: 'other/second', ref: 'release/v1' },
    ]);
    assert.deepEqual(parsePluginList('# no preinstalled plugins\n'), []);
});

test('list errors show the line without echoing credentials or untrusted URL text', () => {
    for (const value of [
        'http://github.com/o/r', 'https://secret-value@github.com/o/r', 'https://github.com/o/r?token=secret-value',
        'https://github.com.evil.test/o/r', 'https://gitlab.com/o/r', 'https://github.com/o/r/tree/main',
        'https://github.com/o/CON', 'https://github.com/o/repo.', 'https://github.com/o/r#../bad',
        'https://github.com/o/r#foo//bar', 'https://github.com/o/r#bad.lock', 'https://github.com/o/r#',
        'https://github.com/o/r%2fother', 'https://github.com/o/r extra',
    ]) assert.throws(() => parsePluginList(`# comment\n${value}`),
        error => error.message.includes('line 2') && !error.message.includes('secret-value'));
});

test('duplicate repositories, colliding folder names and excessive lists are rejected', () => {
    for (const list of [`${url}\n${url}.git`, `${url}\nhttps://github.com/EXAMPLE/FIXTURE`,
        `${url}\nhttps://github.com/other/fixture`]) assert.throws(() => parsePluginList(list), /Duplicate/);
    assert.throws(() => parsePluginList(Array.from({ length: 33 }, (_, i) => `https://github.com/o/repo${i}`).join('\n')), /At most/);
    assert.throws(() => parsePluginList(' '.repeat(32769)), /32 KiB/);
});

test('first selection resolves a real commit and computes a lock without running plugin scripts', async () => {
    const network = transport();
    const selection = await preparePluginSelection(url, empty(), network);
    assert.equal(selection.changed, true);
    assert.equal(selection.lock.plugins[0].commit, A);
    assert.equal(selection.lock.plugins[0].version, '1');
    assert.equal(selection.lock.plugins[0].sha256, digest(archive()));
    assert.equal(selection.lock.plugins[0].layout, 'runtime');
    assert.equal(selection.lock.plugins[0].license, 'SEE-SOURCE');
    assert.equal(network.calls.length, 2);
});

test('ordinary rebuilds preserve versions even if upstream moved; update is explicit', async () => {
    const network = transport();
    const original = await preparePluginSelection(url, empty(), network);
    network.head = B;
    network.calls = [];
    const repeat = await preparePluginSelection(url, original.lock, network);
    assert.equal(repeat.changed, false);
    assert.equal(repeat.lock.plugins[0].commit, A);
    assert.equal(network.calls.length, 1);
    assert.ok(network.calls[0].endsWith('/' + A));
    const updated = await preparePluginSelection(url, original.lock, { ...network, update: true });
    assert.equal(updated.changed, true);
    assert.equal(updated.lock.plugins[0].commit, B);
});

test('unchanged commits retain the established archive hash when checking for updates', async () => {
    const network = transport();
    const original = await preparePluginSelection(url, empty(), network);
    const updated = await preparePluginSelection(url, original.lock, { ...network, update: true });
    assert.equal(updated.changed, false);
    const broken = { ...network, fetchImpl: async (target, options) =>
        target.includes('codeload') ? new Response('changed') : network.fetchImpl(target, options) };
    await assert.rejects(preparePluginSelection(url, original.lock, { ...broken, update: true }), /checksum/);
});

test('full commit refs skip mutable lookups, while changing the selected ref resolves a new lock', async () => {
    const network = transport();
    const original = await preparePluginSelection(`${url}#${A}`, empty(), network);
    assert.equal(network.calls.length, 1);
    const updated = await preparePluginSelection(`${url}#${B}`, original.lock, network);
    assert.equal(updated.lock.plugins[0].commit, B);
    assert.equal(updated.changed, true);
});

test('removal and an empty list remove only prebundle entries without downloading removed plugins', async () => {
    const original = await preparePluginSelection(url, empty(), transport());
    const result = await preparePluginSelection('# no plugins', original.lock, { fetchImpl: () => assert.fail('No download expected') });
    assert.deepEqual(result.lock, empty());
    assert.equal(result.changed, true);
    assert.equal(result.archives.size, 0);
});

test('unsupported manifests, missing compiled files and invalid metadata fail without a usable lock', async () => {
    for (const extra of [
        { 'manifest.json': 'null' }, { 'manifest.json': 'invalid' },
        { 'manifest.json': '{"display_name":"bad","js":"dist/missing.js"}' },
        { 'manifest.json': '{"display_name":"bad","js":"../index.js"}' },
        { 'manifest.json': '{"display_name":"bad","js":"index.js","i18n":"wrong"}' },
        { 'manifest.json': '{"display_name":"bad","js":"index.js","version":"bad\\nvalue"}' },
        { '__source.zip': 'forged source' },
    ]) await assert.rejects(preparePluginSelection(url, empty(), transport({ extra })));
});

test('empty optional CSS and style-only manifests match original ST extension conventions', async () => {
    for (const fields of [{ js: 'index.js', css: '' }, { js: '', css: 'style.css' }]) {
        const selection = await preparePluginSelection(url, empty(), transport({
            extra: { 'manifest.json': JSON.stringify({ display_name: 'Fixture', version: '1', ...fields }) },
        }));
        assert.equal(selection.lock.plugins[0].version, '1');
    }
});

test('ref lookup failures are bounded and do not echo response bodies, redirects or credentials', async () => {
    for (const status of [301, 403, 404, 429, 500, 200]) {
        await assert.rejects(preparePluginSelection(url, empty(), {
            fetchImpl: async () => new Response('secret-value', { status }),
        }), error => /Cannot resolve/.test(error.message) && !error.message.includes('secret-value'));
    }
});

test('lock validation rejects malformed hashes, duplicate destinations and unexpected fields', async () => {
    const { lock } = await preparePluginSelection(url, empty(), transport());
    for (const mutate of [
        value => { value.schema = 2; }, value => { value.plugins[0].sha256 = 'wrong'; },
        value => { value.plugins[0].archive = '../bad.zip'; },
        value => { value.plugins.push(value.plugins[0]); },
        value => { value.plugins[0].repository = 'https://evil.test/repo'; },
        value => { value.plugins[0].CLOUDFLARE_API_TOKEN = 'secret-value'; },
        value => { value.plugins[0].ref = undefined; },
    ]) {
        const value = structuredClone(lock);
        mutate(value);
        assert.throws(() => validatePluginLock(value), error => /Invalid plugins.lock/.test(error.message) && !error.message.includes('secret-value'));
    }
    assertLockMatchesList(url, lock);
    assert.throws(() => assertLockMatchesList('', lock), /list and lock differ/);
});

test('generic packaging retains root scripts, nested templates, translations, images and licenses', async t => {
    const parent = await temp(t);
    const selected = await preparePluginSelection(url, empty(), transport());
    const plugin = selected.lock.plugins[0];
    await writeFile(path.join(parent, plugin.archive), selected.archives.get(plugin.id));
    const bundle = path.join(parent, 'bundle'), assets = path.join(parent, 'assets');
    await mkdir(assets);
    await packagePlugins(parent, bundle, null, selected.lock.plugins);
    const result = await copyPluginBundle(path.join(bundle, 'bundle.json'), assets);
    for (const file of ['index.js', 'nested/util.js', 'templates/panel.html', 'translations/en.json', 'COPYING', 'icons/logo.svg', '__source.zip']) {
        assert.ok(result.files.includes(`scripts/extensions/third-party/fixture/${file}`));
    }
    for (const file of ['package.json', '.env', 'build.sh', '.github/workflows/example.yml']) {
        assert.ok(!result.files.some(name => name.endsWith('/' + file)));
    }
    assert.equal(result.plugins[0].remoteUrl, url);
    assert.equal(result.plugins[0].ref, '');
    assert.deepEqual(await readFile(path.join(assets, 'scripts/extensions/third-party/fixture/__source.zip')), archive());
    await writeFile(path.join(bundle, 'fixture/index.js'), 'tampered');
    const retry = path.join(parent, 'retry');
    await mkdir(retry);
    await assert.rejects(copyPluginBundle(path.join(bundle, 'bundle.json'), retry), /cache changed/);
});

test('generic resource filter omits secret/routing controls and source maps anywhere in the archive', () => {
    for (const name of ['secrets.json', 'nested/wrangler.jsonc', 'nested/_worker.js', '.env', 'dist/a.js.map',
        'node_modules/x/index.js', 'dist/package.json', '_headers', '_redirects']) assert.equal(isPluginRuntimeFile(name, 'runtime'), false, name);
    for (const name of ['index.js', 'src/browser.js', 'panels/a.html', 'fonts/a.woff2', 'COPYING.md']) {
        assert.equal(isPluginRuntimeFile(name, 'runtime'), true, name);
    }
});

test('plugin inputs reject symlinked files and malformed JSON rather than resetting a lock', async t => {
    const parent = await temp(t);
    await writeFile(path.join(parent, 'plugins.txt'), url);
    assert.deepEqual((await readPluginInputs(parent)).lock, empty());
    await writeFile(path.join(parent, 'plugins.lock.json'), '{broken');
    await assert.rejects(readPluginInputs(parent), /not valid JSON/);
    await rm(path.join(parent, 'plugins.lock.json'));
    await writeFile(path.join(parent, 'outside.json'), '{}');
    await symlink(path.join(parent, 'outside.json'), path.join(parent, 'plugins.lock.json'));
    await assert.rejects(readPluginInputs(parent), /regular project file/);
});

async function releaseFixture(t, text = url) {
    const parent = await temp(t), root = path.join(parent, 'cloudflare');
    await mkdir(root);
    await writeFile(path.join(parent, 'plugins.txt'), text);
    await json(path.join(parent, 'plugins.lock.json'), empty());
    await json(path.join(root, 'wrangler.jsonc'), { name: 'stworks', compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat'] });
    return { parent, root };
}

async function syntheticAssetBuild(root, args) {
    if (args[0] !== 'scripts/build-assets.mjs') return;
    const assets = path.join(root, '.build', 'assets-p3');
    await mkdir(path.join(assets, '__stworks'), { recursive: true });
    const { plugins } = await copyPluginBundle(args[2], assets);
    const discovered = ['regex', 'quick-reply', ...plugins.map(plugin => plugin.name)];
    await json(path.join(assets, '__stworks/bootstrap.json'), { stworks: { extensions: discovered.map(name => ({ name })) } });
    const files = await readdir(assets, { recursive: true });
    let count = 0, bytes = 0;
    for (const file of files) { const info = await stat(path.join(assets, file)); if (info.isFile()) { count++; bytes += info.size; } }
    await json(path.join(root, '.build', 'build-manifest-p3.json'), {
        extensionsBundled: plugins, extensionsDiscovered: discovered, totalAssetFiles: count, totalAssetBytes: bytes,
    });
}

test('Actions build consumes only plugins.txt and produces a reusable lock after successful packaging', async t => {
    t.mock.method(console, 'log', () => {});
    const { root, parent } = await releaseFixture(t);
    const commands = [];
    const receipt = await buildActionsRelease(root, {}, { ...transport(), run: async (cwd, args) => {
        commands.push(args);
        await syntheticAssetBuild(cwd, args);
    } });
    assert.equal(receipt.plugins.length, 1);
    assert.equal(receipt.plugins[0].name, 'third-party/fixture');
    assert.equal(receipt.lockChanged, true);
    assert.equal(commands.length, 2);
    assert.ok(commands[1].includes('--dry-run'));
    const { lock } = await readReleaseSelection(root);
    assert.equal(lock.plugins[0].commit, A);
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, 'plugins.lock.json'), 'utf8')), empty());
});

test('an empty list produces a valid zero-plugin release without network access', async t => {
    t.mock.method(console, 'log', () => {});
    const { root } = await releaseFixture(t, '# none');
    const receipt = await buildActionsRelease(root, {}, {
        fetchImpl: () => assert.fail('No network expected'), run: syntheticAssetBuild,
    });
    assert.deepEqual(receipt.plugins, []);
    assert.equal(receipt.lockChanged, false);
});

test('a failed rebuild invalidates the preceding successful release receipt', async t => {
    t.mock.method(console, 'log', () => {});
    const { root, parent } = await releaseFixture(t, '');
    await buildActionsRelease(root, {}, { run: syntheticAssetBuild });
    await writeFile(path.join(parent, 'plugins.txt'), 'not a repo URL');
    await assert.rejects(buildActionsRelease(root, {}, { fetchImpl: () => assert.fail('No fetch expected') }), /line 1/);
    const receipt = JSON.parse(await readFile(path.join(root, '.build/actions/release.json'), 'utf8'));
    assert.equal(receipt.validation, 'build-incomplete');
});
