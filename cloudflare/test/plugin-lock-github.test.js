import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, PLUGIN_BASELINES } from '../scripts/plugin-package.mjs';
import { savePluginLock } from '../scripts/plugin-lock-github.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    STWORKERS_DEFAULT_BRANCH: 'main', GITHUB_SHA: A, GITHUB_REPOSITORY: 'example/STWorkers',
    GITHUB_TOKEN: 'synthetic-github-token-never-log' };
const hash = value => digest(Buffer.from(JSON.stringify(value)));
const json = (file, value) => writeFile(file, JSON.stringify(value));

async function fixture(t, changed = true) {
    t.mock.method(console, 'log', () => {});
    const parent = await mkdtemp(path.join(os.tmpdir(), 'stworkers-lock-save-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'cloudflare'), output = path.join(root, '.build', 'actions');
    await mkdir(output, { recursive: true });
    const lock = { schema: 1, plugins: [{ ...PLUGIN_BASELINES[0], ref: 'HEAD', layout: 'legacy' }] };
    const previous = changed ? { schema: 1, plugins: [] } : lock;
    const text = 'https://github.com/N0VI028/JS-Slash-Runner';
    await writeFile(path.join(parent, 'plugins.txt'), text);
    await json(path.join(parent, 'plugins.lock.json'), previous);
    await json(path.join(output, 'plugins.lock.json'), lock);
    const manifest = { synthetic: true };
    await json(path.join(root, '.build', 'build-manifest-p3.json'), manifest);
    await json(path.join(output, 'release.json'), { schema: 1, validation: 'local-build-and-dry-run-only',
        inputListSha256: digest(Buffer.from(text)), inputLockSha256: hash(previous),
        pluginLockSha256: hash(lock), manifestSha256: hash(manifest), lockChanged: changed });
    return { root, parent, output, lock };
}
function transport({ stale = false, rejectUpdate = false, failStatus } = {}) {
    const requests = [];
    return { requests, head: () => A, async fetchImpl(url, options) {
        assert.ok(url.startsWith('https://api.github.com/repos/example/STWorkers/'));
        assert.equal(options.redirect, 'manual');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
        const body = options.body && JSON.parse(options.body);
        requests.push({ url, method: options.method, body });
        if (failStatus) return new Response('secret-response-body', { status: failStatus });
        if (url.endsWith('/git/ref/heads/main')) return Response.json({ ref: env.GITHUB_REF, object: { type: 'commit', sha: stale ? B : A } });
        if (url.endsWith('/git/commits/' + A)) return Response.json({ sha: A, tree: { sha: B } });
        if (url.endsWith('/git/trees')) {
            assert.equal(body.base_tree, B);
            assert.equal(body.tree.length, 1);
            assert.equal(body.tree[0].path, 'plugins.lock.json');
            assert.equal(body.tree[0].mode, '100644');
            assert.equal(body.tree[0].type, 'blob');
            return Response.json({ sha: C }, { status: 201 });
        }
        if (url.endsWith('/git/commits')) {
            assert.deepEqual(body.parents, [A]);
            assert.equal(body.tree, C);
            return Response.json({ sha: D }, { status: 201 });
        }
        if (url.endsWith('/git/refs/heads/main')) {
            assert.deepEqual(body, { sha: D, force: false });
            if (rejectUpdate) return new Response('race-secret', { status: 422 });
            return Response.json({ ref: env.GITHUB_REF, object: { type: 'commit', sha: D } });
        }
        assert.fail('Unexpected request.');
    } };
}

test('successful lock save modifies exactly plugins.lock.json with a non-force commit and no cloud requests', async t => {
    const { root, output, parent, lock } = await fixture(t);
    const network = transport();
    const result = await savePluginLock(root, env, network);
    assert.equal(result.savedRevision, D);
    assert.equal(network.requests.length, 5);
    assert.deepEqual(JSON.parse(network.requests[2].body.tree[0].content), lock);
    assert.equal(JSON.parse(await readFile(path.join(output, 'lock-saved.json'), 'utf8')).savedRevision, D);
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, 'plugins.lock.json'), 'utf8')), { schema: 1, plugins: [] });
});

test('unchanged locks only verify the branch and never make an empty commit', async t => {
    const { root } = await fixture(t, false), network = transport();
    assert.equal((await savePluginLock(root, env, network)).savedRevision, A);
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].method, 'GET');
});

test('changed remote HEAD prevents all repository writes', async t => {
    const { root, output } = await fixture(t), network = transport({ stale: true });
    await assert.rejects(savePluginLock(root, env, network), /branch changed/);
    assert.equal(network.requests.length, 1);
    await assert.rejects(readFile(path.join(output, 'lock-saved.json')), { code: 'ENOENT' });
});

test('a concurrent commit is not overwritten and cannot produce a lock-save receipt', async t => {
    const { root, output } = await fixture(t);
    await assert.rejects(savePluginLock(root, env, transport({ rejectUpdate: true })),
        error => /Could not confirm\/save/.test(error.message) && !error.message.includes('race-secret'));
    await assert.rejects(readFile(path.join(output, 'lock-saved.json')), { code: 'ENOENT' });
});

test('missing workflow token, cloud secrets, nondefault branches and nonmanual events fail before HTTP', async t => {
    const { root } = await fixture(t);
    for (const changes of [
        { GITHUB_TOKEN: '' }, { CLOUDFLARE_API_TOKEN: 'no' }, { AUTH_PASSWORD: 'no' }, { DATA_KEY: 'no' },
        { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/feature' },
        { STWORKERS_DEFAULT_BRANCH: '' }, { GITHUB_SHA: 'not-a-sha' }, { GITHUB_REPOSITORY: '../outside' },
    ]) await assert.rejects(savePluginLock(root, { ...env, ...changes }, {
        head: () => A, fetchImpl: () => assert.fail('Must not contact GitHub'),
    }));
});

test('HTTP permission, branch-rule and redirect errors are actionable without leaking response contents', async t => {
    const { root } = await fixture(t);
    for (const failStatus of [302, 403, 404, 409, 422, 500]) {
        await assert.rejects(savePluginLock(root, env, transport({ failStatus })),
            error => /permissions or branch rules/.test(error.message) && !error.message.includes('secret-response-body'));
    }
});

test('changed checkouts, generated locks and input text cannot be committed by a stale build', async t => {
    const { root, output, parent } = await fixture(t);
    const never = { head: () => A, fetchImpl: () => assert.fail('Must not contact GitHub') };
    await assert.rejects(savePluginLock(root, env, { ...never, head: () => B }), /Checkout differs/);
    await writeFile(path.join(parent, 'plugins.txt'), 'https://github.com/example/different');
    await assert.rejects(savePluginLock(root, env, never), /list and lock differ/);
    await writeFile(path.join(parent, 'plugins.txt'), 'https://github.com/N0VI028/JS-Slash-Runner');
    await json(path.join(output, 'plugins.lock.json'), { schema: 1, plugins: [] });
    await assert.rejects(savePluginLock(root, env, never), /list and lock differ/);
});
