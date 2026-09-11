import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../public/scripts/openai.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('async function getStatusOpen()');
assert.ok(start > 0);
const functionSource = source.slice(start, source.indexOf('\n}', start) + 2);
const sourcesStart = source.indexOf('export const chat_completion_sources = ');
assert.ok(sourcesStart > 0);
const sources = runInNewContext(`(${source.slice(sourcesStart + 'export const chat_completion_sources = '.length,
    source.indexOf('\n};', sourcesStart) + 2)})`);

async function connect(responder, settings = {}) {
    const state = { statuses: [], notifications: [], errors: [], requests: [], models: [], updates: 0, finished: 0 };
    const getStatus = runInNewContext(`(${functionSource})`, {
        chat_completion_sources: sources,
        oai_settings: { chat_completion_source: 'custom', custom_url: 'https://models.example.com/v1', ...settings },
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        $: () => ({ empty() {} }),
        isValidUrl: () => true,
        validateReverseProxy: async () => {},
        setOnlineStatus: status => state.statuses.push(status),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        abortStatusCheck: new AbortController(),
        fetch: async (url, options) => {
            state.requests.push({ url, options });
            return responder();
        },
        saveModelList: models => state.models.push(...models),
        console: { error: error => state.errors.push(error) },
        toastr: { error: (message, title, options) => state.notifications.push({ message, title, options }) },
        updateFeatureSupportFlags: () => state.updates++,
        resultCheckStatus: () => state.finished++,
    });
    await getStatus();
    assert.equal(state.updates, 1);
    assert.equal(state.finished, 1);
    assert.equal(state.requests.length, 1, 'Connecting must not retry or generate a test message.');
    assert.equal(state.requests[0].url, '/api/backends/chat-completions/status');
    assert.equal(state.requests[0].options.method, 'POST');
    return state;
}

test('connection shows a structured URL error instead of leaving Custom status bypassed', async () => {
    for (const settings of [{}, { chat_completion_source: 'openai', bypass_status_check: true },
        { chat_completion_source: 'openai', bypass_status_check: false }]) {
        const state = await connect(() => Response.json({ error: {
            code: 'INVALID_MODEL_URL',
            message: 'Use a public HTTPS hostname for the model API.',
        } }, { status: 422 }), settings);
        assert.equal(state.statuses.at(-1), 'no_connection');
        assert.equal(state.notifications.length, 1);
        assert.match(state.notifications[0].message, /HTTP 422.*INVALID_MODEL_URL.*HTTPS/);
        assert.equal(state.notifications[0].options.escapeHtml, true);
        assert.equal(state.errors[0].code, 'INVALID_MODEL_URL');
    }
});

test('CSRF and unsupported source failures cannot be bypassed as a successful connection', async () => {
    for (const [status, code] of [[403, 'INVALID_CSRF_TOKEN'], [403, 'CROSS_ORIGIN_WRITE'],
        [501, 'MODEL_SOURCE_NOT_IMPLEMENTED'], [400, 'MODEL_KEY_REQUIRED']]) {
        const state = await connect(() => Response.json({ error: { code, message: 'Synthetic configuration failure.' } }, { status }));
        assert.equal(state.statuses.at(-1), 'no_connection');
        assert.match(state.notifications[0].message, new RegExp(code));
    }
});

test('empty status text, HTML and malformed errors fall back to the HTTP status without reflecting raw bodies', async () => {
    for (const response of [
        () => new Response('<html>private-key-echo</html>', { status: 403 }),
        () => new Response('{private-key-echo', { status: 502 }),
        () => Response.json({ error: { message: { private: 'private-key-echo' }, code: {} } }, { status: 403 }),
    ]) {
        const state = await connect(response, { chat_completion_source: 'openai' });
        assert.equal(state.statuses.at(-1), 'no_connection');
        assert.match(state.notifications[0].message, /^HTTP (403|502)$/);
        assert.doesNotMatch(state.notifications[0].message, /private|\[object Object\]|<html>/);
    }
});

test('status errors are rendered as text and upstream-only model-list failures still permit Custom bypass', async () => {
    const message = '<img src=x onerror=alert(1)> Model listing is not supported.';
    const state = await connect(() => Response.json({ error: { code: 'MODEL_UPSTREAM_ERROR', message } }, { status: 404 }));
    assert.equal(state.statuses.at(-1), 'Status check bypassed');
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].options.escapeHtml, true);
    assert.ok(state.notifications[0].message.includes(message));
    assert.equal(state.models.length, 0);
});

test('legacy JSON error strings and HTTP-200 error envelopes are displayed rather than marked Valid', async () => {
    for (const response of [
        () => Response.json({ error: 'Synthetic legacy error.' }, { status: 401 }),
        () => Response.json({ error: { code: 'MODEL_KEY_REQUIRED', message: 'Save the model key.' } }),
    ]) {
        const state = await connect(response, { chat_completion_source: 'openai' });
        assert.equal(state.statuses.at(-1), 'no_connection');
        assert.equal(state.notifications.length, 1);
        assert.match(state.notifications[0].message, /Synthetic legacy error|Save the model key/);
    }
});

test('valid model list and explicit successful bypass retain the original status behavior', async () => {
    const state = await connect(() => Response.json({ data: [{ id: 'fixture-model', future: true }] }));
    assert.equal(state.statuses.at(-1), 'Valid');
    assert.deepEqual(state.models, [{ id: 'fixture-model', future: true }]);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.errors.length, 0);
    const bypass = await connect(() => Response.json({ bypass: true }));
    assert.equal(bypass.statuses.at(-1), 'Status check bypassed');
    assert.equal(bypass.notifications.length, 0);
});

test('invalid successful JSON and network errors are visible without marking the API valid', async () => {
    for (const response of [
        () => new Response('<html>private-page</html>'),
        () => Response.json(null),
        () => { throw new TypeError('Failed to fetch'); },
    ]) {
        const state = await connect(response, { chat_completion_source: 'openai' });
        assert.equal(state.statuses.at(-1), 'no_connection');
        assert.equal(state.notifications.length, 1);
        assert.ok(state.notifications[0].message.length > 0);
        assert.doesNotMatch(state.notifications[0].message, /private-page/);
    }
});

test('aborting the request or response body does not create an error toast', async () => {
    for (const responder of [
        () => { throw new DOMException('Cancelled', 'AbortError'); },
        () => ({ ok: false, status: 403, json: async () => { throw new DOMException('Cancelled', 'AbortError'); } }),
    ]) {
        const state = await connect(responder);
        assert.equal(state.notifications.length, 0);
        assert.equal(state.errors.length, 0);
    }
});
