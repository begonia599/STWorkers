import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { zipSync, strToU8, deflateSync } from 'fflate';
import { harness } from './p1-helper.js';
import { Documents } from '../src/documents.js';
import { repositoryUrl, extensionName, repositoryRef, resolveRepository } from '../src/extension-repository.js';
import { inspectArchive, inflateEntry } from '../src/extension-archive.js';
import worker from '../src/index.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const URL = 'https://github.com/example/p4-fixture.git';
const PREFIX = '/scripts/extensions/third-party/p4-fixture/';
const paths = action => `/api/extensions/${action}`;
const manifest = version => ({ display_name: 'P4 Fixture', version, author: 'Synthetic',
    js: 'dist/index.js', css: 'style.css', i18n: { en: 'locales/en.json' }, unknown: { retained: true } });
function archive(version = '1', extra = {}) {
    const files = {
        'manifest.json': JSON.stringify(manifest(version)),
        'dist/index.js': `window.P4Fixture = ${JSON.stringify(version)};`,
        'style.css': 'body { --p4-fixture: 1; }',
        'locales/en.json': '{}',
        'nested/template.html': '<p>Fixture</p>',
        'empty.txt': '',
        'LICENSE': 'Synthetic fixture license.',
        '.github/test.yml': 'inert',
        ...extra,
    };
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) =>
        [`fixture-${A}/${name}`, strToU8(value)])), { level: 6 });
}

function remote(t, initial = A) {
    const state = { head: initial, requests: [], archives: { [A]: archive('1'), [B]: archive('2'), [C]: archive('3') } };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Cookie, undefined);
        assert.equal(options.method, 'GET');
        state.requests.push(String(url));
        if (state.reply) return state.reply(String(url), options);
        if (String(url).startsWith('https://codeload.github.com/example/p4-fixture/zip/')) {
            const bytes = state.archives[String(url).split('/').at(-1)];
            return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        }
        if (String(url) === 'https://api.github.com/repos/example/p4-fixture') return Response.json({ default_branch: 'main', private: false });
        if (String(url).includes('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: state.head } });
        if (String(url).includes('/git/ref/heads/dev')) return Response.json({ object: { type: 'commit', sha: B } });
        if (String(url).includes('/git/ref/heads/')) return new Response(null, { status: 404 });
        if (String(url).includes('/git/ref/tags/v1')) return Response.json({ object: { type: 'tag', sha: C } });
        if (String(url).endsWith('/git/tags/' + C)) return Response.json({ object: { type: 'commit', sha: A } });
        if (String(url).includes('/git/commits/')) return Response.json({ sha: String(url).split('/').at(-1) });
        if (String(url).includes('/branches?')) return Response.json([
            { name: 'main', commit: { sha: state.head } }, { name: 'dev', commit: { sha: B } },
        ]);
        return new Response(null, { status: 404 });
    });
    return state;
}
async function installed(t) {
    const state = remote(t);
    const h = await harness(t);
    const response = await h.call(paths('install'), { url: URL });
    assert.equal(response.status, 200, await response.clone().text());
    return { ...h, state };
}
const assertError = async (response, status, code) => {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).error.code, code);
};

function attachBundle(env) {
    const state = { head: A, present: true, remoteUrl: URL.replace('.git', ''), ref: '' };
    const original = env.ASSETS.fetch;
    env.ASSETS.fetch = async request => {
        const path = new globalThis.URL(request.url).pathname;
        if (path === '/__stworks/bootstrap.json') {
            const data = await (await original(request)).json();
            if (state.present) data.stworks.extensions.push({
                name: 'third-party/p4-fixture', type: 'local', commit: state.head,
                version: state.head === A ? '1' : '2', remoteUrl: state.remoteUrl, ref: state.ref,
            });
            return Response.json(data);
        }
        if (state.present && path === PREFIX + 'manifest.json') return Response.json(manifest(state.head === A ? '1' : '2'));
        if (state.present && path === PREFIX + 'dist/index.js') return new Response(`bundled:${state.head}`);
        return original(request);
    };
    return state;
}

test('a generic prebundled plugin loads through authenticated original paths and can be managed without hardcoded sources', async t => {
    const { env, call } = await harness(t);
    const bundle = attachBundle(env);
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), `bundled:${A}`);
    const discovered = await (await call(paths('discover'))).json();
    assert.equal(discovered.at(-1).remoteUrl, bundle.remoteUrl);
    assert.equal((await call(paths('cleanup'), { extensionName: 'p4-fixture' })).status, 204);
    const row = await new Documents(env.DB).get('extension', 'local/p4-fixture');
    assert.equal(row.value.current.remoteUrl, bundle.remoteUrl);
    assert.equal((await call(paths('delete'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 404);
});

test('stored bundled pointers follow redeployed versions and removals without changing user data', async t => {
    const { env, call } = await harness(t), bundle = attachBundle(env), store = new Documents(env.DB);
    const settings = { extension_settings: { fixture: { value: [0, false, 'retained'] } } };
    await store.put('settings', 'owner', settings);
    assert.equal((await call(paths('cleanup'), { extensionName: 'p4-fixture' })).status, 204);
    const before = await store.get('extension', 'local/p4-fixture');
    bundle.head = B;
    assert.equal((await (await call(paths('discover'))).json()).at(-1).commit, B);
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), `bundled:${B}`);
    bundle.present = false;
    assert.equal((await (await call(paths('discover'))).json()).some(item => item.name === 'third-party/p4-fixture'), false);
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 404);
    assert.deepEqual(await store.get('extension', 'local/p4-fixture'), before);
    assert.deepEqual((await store.get('settings', 'owner')).value, settings);
    assert.equal(env.FILES.objects.size, 0);
});

test('online archives and uninstall tombstones keep precedence over a changed prebundle', async t => {
    const { env, call } = await installed(t), bundle = attachBundle(env);
    bundle.head = B;
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), 'window.P4Fixture = "1";');
    assert.equal((await (await call(paths('discover'))).json()).at(-1).commit, A);
    assert.equal((await call(paths('delete'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 404);
    assert.equal((await (await call(paths('discover'))).json()).some(item => item.name === 'third-party/p4-fixture'), false);
});

test('bundled repository metadata must match the served folder and cannot contain credentials', async t => {
    const { env, call } = await harness(t), bundle = attachBundle(env);
    bundle.remoteUrl = 'https://github.com/example/other';
    await assertError(await call(PREFIX + 'dist/index.js'), 422, 'UNMANAGED_BUNDLED_EXTENSION');
    bundle.remoteUrl = 'https://user:secret@github.com/example/p4-fixture';
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 400);
});

test('bounded inflate accepts final partial chunks but rejects incorrect declared lengths', () => {
    for (const size of [0, 40961, 81921, 163841, 2621441]) {
        const output = new Uint8Array(size).fill(65);
        const compressed = deflateSync(output);
        const entry = { size, compressed: compressed.length, crc: crc32(output), method: 8 };
        assert.deepEqual(new Uint8Array(inflateEntry(compressed, entry)), output);
        assert.throws(() => inflateEntry(compressed, { ...entry, size: size + 1 }));
        if (size) assert.throws(() => inflateEntry(compressed, { ...entry, size: size - 1 }));
    }
});

test('an installed immutable commit is queryable and up to date without another network request', async t => {
    const { call, state } = await installed(t);
    assert.equal((await call(paths('switch'), { extensionName: 'p4-fixture', branch: B })).status, 204);
    const requests = state.requests.length;
    state.reply = () => { throw new Error('Network is unavailable.'); };
    const version = await call(paths('version'), { extensionName: 'p4-fixture' });
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { currentBranchName: '', currentCommitHash: B,
        isUpToDate: true, remoteUrl: URL.replace('.git', ''), ref: B, refKind: 'commit', canRollback: true, canMove: false });
    assert.equal((await (await call(paths('update'), { extensionName: 'p4-fixture' })).json()).isUpToDate, true);
    assert.equal(state.requests.length, requests);
});

test('repository and ref validation accepts original UI names but rejects credentials, traversal and unsupported hosts', () => {
    assert.equal(repositoryUrl(URL).name, 'p4-fixture');
    assert.equal(repositoryUrl('https://gitlab.com/group/subgroup/repo.git').project, 'group/subgroup/repo');
    for (const name of ['p4-fixture', '/p4-fixture', 'third-party/p4-fixture']) assert.equal(extensionName(name), 'p4-fixture');
    for (const name of ['../bad', '/etc/passwd', 'a\\b', '', 'a.', 'CON', '//bad']) assert.throws(() => extensionName(name));
    for (const url of ['http://github.com/o/r', 'https://user:pass@github.com/o/r',
        'https://github.com/o/r?token=private', 'https://github.com/o/r#main', 'https://127.0.0.1/o/r',
        'https://github.com.evil.test/o/r', 'https://github.com/o/r/tree/main']) assert.throws(() => repositoryUrl(url));
    for (const ref of ['../main', 'a b', 'a\\b', 'a%2fb', 'x.lock', 'origin//main', '-x']) assert.throws(() => repositoryRef(ref));
    assert.equal(repositoryRef('feature/one'), 'feature/one');
});

test('archive inspection retains manifest fields and validates declared entry points without extracting to a filesystem', async () => {
    const result = await inspectArchive(archive());
    assert.deepEqual(result.manifest, manifest('1'));
    assert.equal(result.fileCount, 7);
    assert.equal(JSON.parse(result.index).files['.github/test.yml'], undefined);
    await assert.rejects(inspectArchive(archive('1', { 'manifest.json': '[]' })));
    await assert.rejects(inspectArchive(archive('1', { 'manifest.json': JSON.stringify({ ...manifest('1'), js: '../escape.js' }) })));
    await assert.rejects(inspectArchive(archive('1', { '__source.zip': 'ambiguous source' })));
    await assert.rejects(inspectArchive(archive('1', { 'DIST/index.js': 'case collision' })));
    await assert.rejects(inspectArchive(new Uint8Array([1, 2, 3])));
});

test('archives reject traversal, encrypted entries, symlinks, oversized inflation and corrupted entry points', async () => {
    for (const name of ['../escape', 'bad\\name', 'CON.txt', 'a%2fb', 'a/../b']) {
        await assert.rejects(inspectArchive(archive('1', { [name]: 'bad' })));
    }
    const bytes = archive();
    const result = await inspectArchive(bytes);
    const entry = JSON.parse(result.index).files['dist/index.js'];
    const broken = bytes.slice();
    broken[entry.offset] ^= 0xff;
    await assert.rejects(inspectArchive(broken));
    assert.throws(() => inflateEntry(new Uint8Array(4), { method: 0, size: 1, compressed: 4, crc: 0 }));
    for (const flag of ['symlink', 'encrypted']) {
        const changed = bytes.slice();
        const view = new DataView(changed.buffer);
        for (let i = 0; i < changed.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                if (flag === 'symlink') view.setUint32(i + 38, 0xa1ff0000, true);
                else view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true);
                break;
            }
        }
        await assert.rejects(inspectArchive(changed));
    }
});

test('install returns upstream fields, persists discovery, serves ranged assets and retains complete source', async t => {
    const { env, call, state } = await installed(t);
    const discover = await (await call(paths('discover'))).json();
    assert.deepEqual(discover.at(-1), { name: 'third-party/p4-fixture', type: 'local', commit: A, version: '1' });
    assert.deepEqual(await (await call(PREFIX + 'manifest.json')).json(), manifest('1'));
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), 'window.P4Fixture = "1";');
    assert.match((await call(PREFIX + 'style.css')).headers.get('Content-Type'), /text\/css/);
    assert.equal(await (await call(PREFIX + 'empty.txt')).text(), '');
    assert.equal((await call(PREFIX + '.github/test.yml')).status, 404);
    assert.equal((await call(PREFIX + 'not-found.js')).status, 404);
    assert.deepEqual(new Uint8Array(await (await call(PREFIX + '__source.zip')).arrayBuffer()), state.archives[A]);
    assert.equal(env.FILES.objects.size, 2);
    assert.equal(state.requests.length, 3);
    await assertError(await call(paths('install'), { url: URL }), 409, 'EXTENSION_ALREADY_INSTALLED');
});

test('update and explicit rollback switch complete snapshots and preserve unrelated settings and variables', async t => {
    const { env, call, state } = await installed(t);
    const store = new Documents(env.DB);
    const personal = { variables: { nested: [false, 7] }, plugins: { preserved: true } };
    await store.put('settings', 'owner', personal);
    state.head = B;
    const response = await call(paths('update'), { extensionName: '/p4-fixture' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).isUpToDate, false);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
    assert.equal(env.FILES.objects.size, 4);
    assert.equal((await call(paths('rollback'), { extensionName: 'third-party/p4-fixture' })).status, 200);
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), 'window.P4Fixture = "1";');
    assert.deepEqual((await store.get('settings', 'owner')).value, personal);
    assert.equal((await call(paths('rollback'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
});

test('up-to-date checks and pinned tags/commits do not invent branch names or needless archives', async t => {
    const { env, call, state } = await installed(t);
    const body = { extensionName: 'p4-fixture' };
    const version = await (await call(paths('version'), body)).json();
    assert.equal(version.currentBranchName, 'main');
    assert.equal(version.currentCommitHash, A);
    assert.equal(version.canRollback, false);
    const count = state.requests.length;
    assert.equal((await (await call(paths('version'), body)).json()).isUpToDate, true);
    assert.equal(state.requests.length, count);
    assert.equal((await (await call(paths('update'), body)).json()).isUpToDate, true);
    assert.equal(env.FILES.objects.size, 2);
    assert.equal((await call(paths('switch'), { ...body, branch: 'v1' })).status, 204);
    const tag = await (await call(paths('version'), body)).json();
    assert.equal(tag.refKind, 'tag');
    assert.equal(tag.currentBranchName, '');
    assert.equal(tag.ref, 'v1');
    assert.equal((await call(paths('switch'), { ...body, branch: B })).status, 204);
    assert.equal((await (await call(paths('version'), body)).json()).currentBranchName, '');
});

test('branch listing and original origin branch names switch to real resolved commits', async t => {
    const { call } = await installed(t);
    const body = { extensionName: 'p4-fixture' };
    const branches = await (await call(paths('branches'), body)).json();
    assert.equal(branches[0].name, 'origin/main');
    assert.equal(branches[1].commit, B);
    assert.equal((await call(paths('switch'), { ...body, branch: 'origin/dev' })).status, 204);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
    await assertError(await call(paths('switch'), { ...body, branch: 'missing' }), 404, 'EXTENSION_REF_NOT_FOUND');
});

test('failed download, redirect, rate limit and invalid new archive leave current and previous untouched', async t => {
    const { env, call, state } = await installed(t);
    const before = (await new Documents(env.DB).get('extension', 'local/p4-fixture')).value;
    for (const response of [
        () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
        () => new Response(null, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }),
        () => new Response('untrusted html', { status: 500 }),
    ]) {
        state.reply = response;
        assert.ok((await call(paths('update'), { extensionName: 'p4-fixture' })).status >= 400);
        assert.deepEqual((await new Documents(env.DB).get('extension', 'local/p4-fixture')).value, before);
    }
    state.reply = null;
    state.head = B;
    state.archives[B] = new Uint8Array([1, 2, 3]);
    await assertError(await call(paths('update'), { extensionName: 'p4-fixture' }), 422, 'INVALID_EXTENSION_ARCHIVE');
    assert.deepEqual((await new Documents(env.DB).get('extension', 'local/p4-fixture')).value, before);
    assert.equal(env.FILES.objects.size, 2);
});

test('R2 upload failure does not publish metadata and does not affect the installed version', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    env.FILES.failPut = true;
    assert.equal((await call(paths('update'), { extensionName: 'p4-fixture' })).status, 500);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '1');
    env.FILES.failPut = false;
    assert.equal(env.FILES.objects.size, 2);
});

test('simultaneous first installs have one winner and clean only the losing unreferenced archive', async t => {
    remote(t);
    const { env, call } = await harness(t);
    const responses = await Promise.all([call(paths('install'), { url: URL }), call(paths('install'), { url: URL })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(env.FILES.objects.size, 2);
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 200);
});

test('concurrent updates cannot partially overwrite an installed archive or lose rollback', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    const responses = await Promise.all([call(paths('update'), { extensionName: 'p4-fixture' }),
        call(paths('update'), { extensionName: 'p4-fixture' })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(env.FILES.objects.size, 4);
    assert.equal((await call(paths('rollback'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '1');
});

test('third revision retires old archives, retryable cleanup never changes active data', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    await call(paths('update'), { extensionName: 'p4-fixture' });
    env.FILES.failDelete = true;
    state.head = C;
    assert.equal((await call(paths('update'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal(env.FILES.objects.size, 6);
    env.FILES.failDelete = false;
    assert.equal((await call(paths('cleanup'), { extensionName: 'p4-fixture' })).status, 204);
    assert.equal(env.FILES.objects.size, 4);
    assert.equal((await call(paths('rollback'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
});

test('deleting preserves settings, persists a tombstone and supports clean reinstall', async t => {
    const { env, call } = await installed(t);
    await new Documents(env.DB).put('settings', 'owner', { unknown: true });
    assert.equal((await call(paths('delete'), { extensionName: '/p4-fixture' })).status, 200);
    assert.equal(env.FILES.objects.size, 0);
    assert.equal((await call(PREFIX + 'manifest.json')).status, 404);
    assert.equal((await (await call(paths('discover'))).json()).some(item => item.name.includes('p4-fixture')), false);
    assert.deepEqual((await new Documents(env.DB).get('settings', 'owner')).value, { unknown: true });
    await assertError(await call(paths('delete'), { extensionName: 'p4-fixture' }), 404, 'EXTENSION_NOT_FOUND');
    assert.equal((await call(paths('install'), { url: URL })).status, 200);
    assert.equal(env.FILES.objects.size, 2);
});

test('global and local scopes preserve original local-precedence semantics', async t => {
    const { call, state } = await installed(t);
    state.head = B;
    assert.equal((await call(paths('install'), { url: URL, global: true })).status, 200);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '1');
    assert.equal((await call(paths('delete'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
    assert.equal((await (await call(paths('discover'))).json()).at(-1).type, 'global');
});

test('new plugin routes preserve authentication and CSRF before network or storage access', async t => {
    const state = remote(t);
    const { env, call } = await harness(t);
    for (const action of ['install', 'update', 'rollback', 'delete']) {
        assert.equal((await call(paths(action), {}, { 'X-CSRF-Token': '' })).status, 403);
        const request = new Request('https://stworks.example' + paths(action), { method: 'POST', body: '{}' });
        assert.equal((await worker.fetch(request, env)).status, 401);
    }
    assert.equal((await worker.fetch(new Request('https://stworks.example' + PREFIX + '__source.zip'), env)).status, 401);
    assert.equal(state.requests.length, 0);
    assert.equal(env.FILES.objects.size, 0);
});

test('GitLab nested projects resolve real branch, tag and commit metadata without credentials', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push(String(url));
        assert.equal(options.headers.Authorization, undefined);
        if (String(url).endsWith('/repository/branches/main')) return Response.json({ commit: { id: A } });
        if (String(url).includes('/repository/branches/')) return new Response(null, { status: 404 });
        if (String(url).endsWith('/repository/tags/v1')) return Response.json({ commit: { id: B } });
        if (String(url).endsWith('/repository/commits/' + C)) return Response.json({ id: C });
        return Response.json({ default_branch: 'main' });
    });
    const repo = repositoryUrl('https://gitlab.com/group/subgroup/repo.git');
    assert.equal((await resolveRepository(repo)).commit, A);
    assert.equal((await resolveRepository(repo, 'v1')).refKind, 'tag');
    assert.equal((await resolveRepository(repo, C)).commit, C);
    assert.ok(calls.every(url => url.startsWith('https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Frepo')));
});

test('bundled plugins can be updated, restored and uninstalled without reappearing from static assets', async t => {
    const state = remote(t);
    state.reply = async url => {
        if (url.startsWith('https://codeload.github.com/')) return new Response(archive('2'));
        if (url.endsWith('/JS-Slash-Runner')) return Response.json({ default_branch: 'main' });
        return Response.json({ object: { type: 'commit', sha: B } });
    };
    const { env, call } = await harness(t);
    const original = env.ASSETS.fetch;
    env.ASSETS.fetch = async request => {
        const path = new globalThis.URL(request.url).pathname;
        if (path === '/__stworks/bootstrap.json') {
            const data = await (await original(request)).json();
            data.stworks.extensions.push({ name: 'third-party/JS-Slash-Runner', type: 'local', commit: A, version: 'bundled' });
            return Response.json(data);
        }
        if (path.endsWith('/JS-Slash-Runner/manifest.json')) return Response.json(manifest('bundled'));
        if (path.endsWith('/JS-Slash-Runner/dist/index.js')) return new Response('BUNDLED ORIGINAL');
        return original(request);
    };
    const file = '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js';
    const body = { extensionName: '/JS-Slash-Runner' };
    assert.equal(await (await call(file)).text(), 'BUNDLED ORIGINAL');
    assert.equal((await call(paths('update'), body)).status, 200);
    assert.equal(await (await call(file)).text(), 'window.P4Fixture = "2";');
    assert.equal((await call(paths('rollback'), body)).status, 200);
    assert.equal(await (await call(file)).text(), 'BUNDLED ORIGINAL');
    assert.equal((await call(paths('delete'), body)).status, 200);
    assert.equal((await call(file)).status, 404);
    assert.equal((await (await call(paths('discover'))).json()).some(entry => entry.name.includes('JS-Slash-Runner')), false);
});

test('a missing previous archive cannot replace a valid active version', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    await call(paths('update'), { extensionName: 'p4-fixture' });
    const row = await new Documents(env.DB).get('extension', 'local/p4-fixture');
    await env.FILES.delete(row.value.previous.indexKey);
    await assertError(await call(paths('rollback'), { extensionName: 'p4-fixture' }), 409, 'EXTENSION_ROLLBACK_MISSING');
    assert.equal((await (await call(PREFIX + 'manifest.json')).json()).version, '2');
});

test('a delete with failed object cleanup can retry cleanup without reinstalling', async t => {
    const { env, call } = await installed(t);
    env.FILES.failDelete = true;
    assert.equal((await call(paths('delete'), { extensionName: 'p4-fixture' })).status, 200);
    assert.equal((await call(PREFIX + 'dist/index.js')).status, 404);
    assert.equal(env.FILES.objects.size, 2);
    env.FILES.failDelete = false;
    assert.equal((await call(paths('cleanup'), { extensionName: 'p4-fixture' })).status, 204);
    assert.equal(env.FILES.objects.size, 0);
});

test('a database acknowledgement failure never deletes an archive that may already be committed', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    const original = Documents.prototype.put;
    t.mock.method(Documents.prototype, 'put', async function (kind, id, value, revision) {
        await original.call(this, kind, id, value, revision);
        if (kind === 'extension' && value.current?.commit === B) throw new Error('Synthetic acknowledgement failure after commit');
    });
    assert.equal((await call(paths('update'), { extensionName: 'p4-fixture' })).status, 500);
    const snapshot = (await new Documents(env.DB).get('extension', 'local/p4-fixture')).value.current;
    assert.equal(snapshot.commit, B);
    assert.ok(env.FILES.objects.has(snapshot.archiveKey));
    assert.ok(env.FILES.objects.has(snapshot.indexKey));
    assert.equal(await (await call(PREFIX + 'dist/index.js')).text(), 'window.P4Fixture = "2";');
});

test('an update racing with deletion cannot resurrect the deleted extension', async t => {
    const { env, call, state } = await installed(t);
    state.head = B;
    const original = env.FILES.put;
    let triggered = false;
    env.FILES.put = async function (...args) {
        if (!triggered) {
            triggered = true;
            assert.equal((await call(paths('delete'), { extensionName: 'p4-fixture' })).status, 200);
        }
        return original.apply(this, args);
    };
    await assertError(await call(paths('update'), { extensionName: 'p4-fixture' }), 409, 'REVISION_CONFLICT');
    assert.equal((await call(PREFIX + 'manifest.json')).status, 404);
    assert.equal(env.FILES.objects.size, 0);
});

test('compressed size lies and oversized downloads fail before a version is published', async t => {
    const compressed = deflateSync(strToU8('x'.repeat(50000)));
    assert.throws(() => inflateEntry(compressed, { method: 8, compressed: compressed.length, size: 1, crc: 0 }));
    const { env, call, state } = await installed(t);
    const before = (await new Documents(env.DB).get('extension', 'local/p4-fixture')).value;
    state.reply = async () => new Response('{}', { headers: { 'Content-Length': String(26 * 1024 * 1024) } });
    assert.equal((await call(paths('update'), { extensionName: 'p4-fixture' })).status, 413);
    assert.deepEqual((await new Documents(env.DB).get('extension', 'local/p4-fixture')).value, before);
});

test('range delivery validates on-demand file integrity and refuses corrupted index bounds', async t => {
    const { env, call } = await installed(t);
    const snapshot = (await new Documents(env.DB).get('extension', 'local/p4-fixture')).value.current;
    const index = JSON.parse(new TextDecoder().decode(env.FILES.objects.get(snapshot.indexKey).bytes));
    index.files['nested/template.html'].size = 100 * 1024 * 1024;
    await env.FILES.put(snapshot.indexKey, JSON.stringify(index), { httpMetadata: { contentType: 'application/json' } });
    await assertError(await call(PREFIX + 'nested/template.html'), 503, 'EXTENSION_INDEX_INVALID');
    assert.equal((await call(PREFIX + 'manifest.json')).status, 200);
});
