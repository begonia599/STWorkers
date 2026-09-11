import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { MAX_JSON_BYTES } from '../src/http.js';
import { makeD1, syntheticCardState } from './d1-helper.js';

const PASSWORD = 'synthetic-local-test-password-not-for-production';
const ORIGIN = 'https://stworks.example';
const AUTHORIZATION = `Basic ${btoa(`owner:${PASSWORD}`)}`;

function environment(t) {
    return {
        AUTH_PASSWORD: PASSWORD,
        DB: makeD1(t),
        assetCalls: [],
        ASSETS: {
            async fetch(request) {
                const pathname = new URL(request.url).pathname;
                if (pathname === '/__stworks/bootstrap.json') {
                    return Response.json({
                        settings: JSON.stringify({ username: 'Default owner' }),
                        openai_settings: ['{"name":"Default"}'],
                        openai_setting_names: ['Default'],
                        enable_extensions: true,
                    });
                }
                if (pathname === '/index.html') return new Response('<!doctype html><title>Upstream fixture</title>');
                return new Response('Not found', { status: 404 });
            },
        },
    };
}

function request(pathname, options = {}) {
    const { headers, ...rest } = options;
    return new Request(`${ORIGIN}${pathname}`, {
        ...rest,
        headers: { Authorization: AUTHORIZATION, ...headers },
    });
}

async function token(env) {
    const response = await worker.fetch(request('/csrf-token'), env);
    assert.equal(response.status, 200);
    return (await response.json()).token;
}

function post(pathname, csrf, body, headers = {}) {
    return request(pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
        body: JSON.stringify(body),
    });
}

test('missing or short owner password denies all paths', async t => {
    const env = environment(t);
    for (const password of [undefined, '', 'short']) {
        env.AUTH_PASSWORD = password;
        for (const pathname of ['/', '/script.js', '/api/stworks/status']) {
            assert.equal((await worker.fetch(request(pathname), env)).status, 503);
        }
    }
});

test('static assets and API data cannot bypass authentication', async t => {
    const env = environment(t);
    let assetCalls = 0;
    env.ASSETS.fetch = async () => { assetCalls++; return new Response('private'); };
    for (const pathname of ['/', '/index.html', '/lib.js', '/__stworks/bootstrap.json', '/csrf-token',
        '/scripts/stworks-token-estimator.js', '/css/user.css',
        '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js',
        '/scripts/extensions/third-party/ST-Prompt-Template/__source.zip']) {
        const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`), env);
        assert.equal(response.status, 401);
        assert.match(response.headers.get('WWW-Authenticate'), /Basic/);
    }
    assert.equal(assetCalls, 0);
});

test('wrong and malformed credentials are rejected', async t => {
    const env = environment(t);
    for (const value of ['Bearer ignored', 'Basic !!!', `Basic ${btoa('guest:' + PASSWORD)}`,
        `Basic ${btoa('owner:incorrect')}`]) {
        assert.equal((await worker.fetch(request('/', { headers: { Authorization: value } }), env)).status, 401);
    }
});

test('root serves the upstream index only after authentication', async t => {
    const response = await worker.fetch(request('/'), environment(t));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Upstream fixture/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Content-Security-Policy'), null);
});

test('status distinguishes partial plugin evidence, opt-in delivery and full readiness', async t => {
    const response = await worker.fetch(request('/api/stworks/status'), environment(t));
    const status = await response.json();
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

test('writes require a valid CSRF token', async t => {
    const env = environment(t);
    for (const csrf of ['', 'a'.repeat(64)]) {
        assert.equal((await worker.fetch(post('/api/settings/save', csrf, {}), env)).status, 403);
    }
});

test('CSRF tokens are bound to the instance origin', async t => {
    const env = environment(t);
    const csrf = await token(env);
    const foreign = new Request('https://other.example/api/settings/save', {
        method: 'POST',
        headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: '{}',
    });
    assert.equal((await worker.fetch(foreign, env)).status, 403);
});

test('cross-origin and opaque-origin writes fail even with a valid token', async t => {
    const env = environment(t);
    const csrf = await token(env);
    for (const headers of [{ Origin: 'https://other.example' }, { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await worker.fetch(post('/api/settings/save', csrf, {}, headers), env)).status, 403);
    }
});

test('settings retain the ST string envelope and all synthetic extension data', async t => {
    const env = environment(t);
    const csrf = await token(env);
    const saved = await worker.fetch(post('/api/settings/save', csrf, syntheticCardState, { Origin: ORIGIN }), env);
    assert.deepEqual(await saved.json(), { result: 'ok' });
    const response = await worker.fetch(post('/api/settings/get', csrf, {}), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(typeof data.settings, 'string');
    assert.deepEqual(JSON.parse(data.settings), syntheticCardState);
    assert.deepEqual(data.openai_setting_names, ['Default']);
    assert.deepEqual(data.openai_settings, ['{"name":"Default"}']);
});

test('fresh settings use the explicitly built bootstrap data', async t => {
    const env = environment(t);
    const response = await worker.fetch(post('/api/settings/get', await token(env), {}), env);
    assert.deepEqual(JSON.parse((await response.json()).settings), { username: 'Default owner' });
});

test('missing bootstrap data is not silently replaced', async t => {
    const env = environment(t);
    env.ASSETS.fetch = async () => new Response('missing', { status: 404 });
    const response = await worker.fetch(post('/api/settings/get', await token(env), {}), env);
    assert.equal(response.status, 503);
});

test('invalid JSON values and wrong content type never update storage', async t => {
    const env = environment(t);
    const csrf = await token(env);
    for (const value of [null, [], 'text', 42]) {
        assert.equal((await worker.fetch(post('/api/settings/save', csrf, value), env)).status, 400);
    }
    const malformed = post('/api/settings/save', csrf, {});
    const badRequest = new Request(malformed, { body: '{broken' });
    assert.equal((await worker.fetch(badRequest, env)).status, 400);
    assert.equal((await worker.fetch(post('/api/settings/save', csrf, {}, { 'Content-Type': 'text/plain' }), env)).status, 415);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS count FROM documents').get().count, 0);
});

test('oversized streamed JSON is rejected without a Content-Length header', async t => {
    const env = environment(t);
    const bytes = new TextEncoder().encode(JSON.stringify({ value: 'x'.repeat(MAX_JSON_BYTES) }));
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const incoming = request('/api/settings/save', {
        method: 'POST', duplex: 'half', body: stream,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await token(env) },
    });
    assert.equal((await worker.fetch(incoming, env)).status, 413);
});

test('declared oversized JSON is rejected before reading it', async t => {
    const env = environment(t);
    const incoming = post('/api/settings/save', await token(env), {}, { 'Content-Length': String(MAX_JSON_BYTES + 1) });
    assert.equal((await worker.fetch(incoming, env)).status, 413);
});

test('excluded and unimplemented APIs fail explicitly instead of returning the SPA', async t => {
    const env = environment(t);
    const csrf = await token(env);
    for (const pathname of ['/api/sd/generate', '/api/speech/recognize']) {
        const response = await worker.fetch(post(pathname, csrf, {}), env);
        assert.equal(response.status, 410);
        assert.equal((await response.json()).error.code, 'FEATURE_OUT_OF_SCOPE');
    }
    for (const pathname of ['/api/sd-other', '/api/characters/unknown', '/api/extensions/unknown', '/api']) {
        const response = await worker.fetch(post(pathname, csrf, {}), env);
        assert.equal(response.status, 501);
        assert.equal((await response.json()).error.code, 'NOT_IMPLEMENTED');
    }
});

test('wrong methods and missing assets keep real HTTP failure statuses', async t => {
    const env = environment(t);
    const wrongMethod = await worker.fetch(request('/api/settings/save'), env);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('Allow'), 'POST');
    assert.equal((await worker.fetch(request('/missing.js'), env)).status, 404);
});

test('storage errors do not disclose queries, data, or credentials', async t => {
    const env = environment(t);
    env.DB.prepare = () => { throw new Error(`sensitive query ${PASSWORD}`); };
    const response = await worker.fetch(post('/api/settings/save', await token(env), {}), env);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /sensitive|synthetic-local-test-password/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
