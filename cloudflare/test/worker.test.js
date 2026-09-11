import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { MAX_JSON_BYTES } from '../src/http.js';
import { syntheticCardState } from './d1-helper.js';
import { harness } from './p1-helper.js';
import { ORIGIN } from './auth-helper.js';

test('root serves upstream HTML only after cookie authentication', async t => {
    const { env, call } = await harness(t);
    env.ASSETS.fetch = async request => {
        assert.equal(new URL(request.url).pathname, '/index.html');
        return new Response('<!doctype html><title>Upstream fixture</title>');
    };
    const response = await call('/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Upstream fixture/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Content-Security-Policy'), null);
});

test('status distinguishes partial plugin evidence, opt-in delivery and full readiness', async t => {
    const { call } = await harness(t);
    const status = await (await call('/api/stworks/status')).json();
    assert.equal(status.readyForChat, false);
    assert.equal(status.phase, 'P4-in-progress');
    assert.equal(status.compatibility.tavernHelper, 'pinned-local-synthetic-partial');
    assert.equal(status.compatibility.promptTemplate, 'pinned-local-synthetic-partial');
    assert.equal(status.compatibility.communityCards, 'not-yet-verified');
    assert.equal(status.pluginDelivery.defaultBundled, false);
    assert.equal(status.pluginDelivery.onlineManagement, true);
    assert.equal(status.pluginDelivery.cloudVerified, false);
    assert.equal(status.pluginDelivery.redistributionCleared, false);
    assert.equal(status.compatibility.promptAssembly, 'independent-frontends-local-fixtures-verified');
    assert.equal(status.compatibility.nativeVariables, 'slash-swipes-mobile-reload-local-fixtures-verified');
    assert.ok(status.pending.includes('community-prompt-variable-regressions'));
    assert.equal(status.tokenCounting.accuracy, 'estimate');
    assert.equal(status.tokenCounting.backendTokenizers, false);
});

test('writes require a valid CSRF token and reject cross/opaque origins', async t => {
    const { call } = await harness(t);
    for (const headers of [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'a'.repeat(64) },
        { Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await call('/api/settings/save', {}, headers)).status, 403);
    }
});

test('session and CSRF tokens cannot cross instance origins', async t => {
    const { env, client } = await harness(t);
    const foreign = new Request('https://other.example/api/settings/save', {
        method: 'POST', headers: { ...client.headers, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal((await worker.fetch(foreign, env)).status, 401);
});

test('settings retain the ST string envelope and all synthetic extension data', async t => {
    const { call } = await harness(t);
    assert.deepEqual(await (await call('/api/settings/save', syntheticCardState)).json(), { result: 'ok' });
    const data = await (await call('/api/settings/get', {})).json();
    assert.equal(typeof data.settings, 'string');
    assert.deepEqual(JSON.parse(data.settings), syntheticCardState);
    assert.deepEqual(data.openai_setting_names, ['Default']);
    assert.deepEqual(data.openai_settings, ['{"name":"Default","future":true}']);
    assert.equal(data.enable_accounts, true);
});

test('fresh settings use the explicitly built bootstrap data', async t => {
    const { call } = await harness(t);
    const response = await call('/api/settings/get', {});
    assert.deepEqual(JSON.parse((await response.json()).settings), { username: 'User' });
});

test('missing bootstrap data is not silently replaced', async t => {
    const { call, env } = await harness(t);
    env.ASSETS.fetch = async () => new Response('missing', { status: 404 });
    assert.equal((await call('/api/settings/get', {})).status, 503);
});

test('invalid JSON and content type never update storage', async t => {
    const { call, env, client } = await harness(t);
    for (const value of [null, [], 'text', 42]) {
        assert.equal((await call('/api/settings/save', value)).status, 400);
    }
    const malformed = new Request(ORIGIN + '/api/settings/save', { method: 'POST',
        headers: { ...client.headers, 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal((await worker.fetch(malformed, env)).status, 400);
    assert.equal((await call('/api/settings/save', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS count FROM documents').get().count, 0);
});

test('oversized streamed JSON is rejected without a Content-Length header', async t => {
    const { env, client } = await harness(t);
    const bytes = new TextEncoder().encode(JSON.stringify({ value: 'x'.repeat(MAX_JSON_BYTES) }));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const incoming = new Request(ORIGIN + '/api/settings/save', {
        method: 'POST', duplex: 'half', body: stream,
        headers: { ...client.headers, 'Content-Type': 'application/json' },
    });
    assert.equal((await worker.fetch(incoming, env)).status, 413);
});

test('declared oversized JSON is rejected before reading it', async t => {
    const { call } = await harness(t);
    assert.equal((await call('/api/settings/save', {}, { 'Content-Length': String(MAX_JSON_BYTES + 1) })).status, 413);
});

test('excluded and unimplemented APIs fail explicitly instead of returning the SPA', async t => {
    const { call } = await harness(t);
    for (const pathname of ['/api/sd/generate', '/api/speech/recognize']) {
        const response = await call(pathname, {});
        assert.equal(response.status, 410);
        assert.equal((await response.json()).error.code, 'FEATURE_OUT_OF_SCOPE');
    }
    for (const pathname of ['/api/sd-other', '/api/characters/unknown', '/api/extensions/unknown', '/api']) {
        const response = await call(pathname, {});
        assert.equal(response.status, 501);
        assert.equal((await response.json()).error.code, 'NOT_IMPLEMENTED');
    }
});

test('wrong methods and missing assets keep real HTTP failure statuses', async t => {
    const { call } = await harness(t);
    const wrongMethod = await call('/api/settings/save');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('Allow'), 'POST');
    assert.equal((await call('/missing.js')).status, 404);
});

test('storage errors do not disclose queries, data, or credentials', async t => {
    const { call, env } = await harness(t);
    env.DB.prepare = () => { throw new Error(`sensitive query ${env.AUTH_PASSWORD}`); };
    const response = await call('/api/settings/save', {});
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /sensitive|synthetic-test-password/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
