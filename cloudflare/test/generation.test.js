import assert from 'node:assert/strict';
import test from 'node:test';
import { modelEndpoint, generationBody } from '../src/generation.js';
import { harness } from './p1-helper.js';
import worker from '../src/index.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const path = '/api/backends/chat-completions/';
const origin = 'https://model.example.com';
const input = {
    chat_completion_source: 'custom', custom_url: `${origin}/v1/`, model: 'fixture',
    stream: false, messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Hello' }],
    max_tokens: 128, temperature: 0.7, top_p: 0.9, presence_penalty: 0, frequency_penalty: 0,
};
const completion = { choices: [{ index: 0, message: { role: 'assistant', content: 'Reply' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } };

async function setup(t, responder) {
    const h = await harness(t);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url: String(url), ...options });
        return responder ? responder(url, options) : Response.json(completion);
    });
    return { ...h, calls };
}

test('HTTPS model base URLs work directly without provider approval and keep their API path', () => {
    const request = new Request('https://stworks.example');
    for (const base of [`${origin}/v1/`, 'https://another-provider.example/api/v2/',
        'https://model.example.com.other-provider.example:8443/v1/']) {
        for (const body of [{ ...input, custom_url: base }, { ...input, chat_completion_source: 'openai', reverse_proxy: base }]) {
            assert.equal(String(modelEndpoint(body, request, 'generate')), `${base}chat/completions`);
            assert.equal(String(modelEndpoint(body, request, 'status')), `${base}models`);
        }
    }
    assert.equal(String(modelEndpoint({ chat_completion_source: 'openai' }, request, 'status')), 'https://api.openai.com/v1/models');
});

test('unsafe model URLs remain rejected for both Custom and OpenAI reverse proxies', () => {
    const request = new Request('https://stworks.example');
    for (const url of ['http://model.example.com', 'https://user:password@model.example.com', `${origin}?key=private`,
        `${origin}#fragment`, 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://10.0.0.1',
        'https://0x7f000001', 'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://localhost.',
        'https://foo.internal', 'https://foo.internal.', 'https://foo.local.', 'https://foo.test.', 'https://foo.invalid.',
        'https://stworks.example', 'https://stworks.example.:443', 'ftp://model.example.com', 'not a URL']) {
        for (const body of [{ ...input, custom_url: url }, { ...input, chat_completion_source: 'openai', reverse_proxy: url }]) {
            assert.throws(() => modelEndpoint(body, request, 'generate'),
                error => error.status === 422 && error.code === 'INVALID_MODEL_URL', url);
        }
    }
});

test('plain HTTP fixtures require both incoming and outgoing loopback and cannot be enabled from the cloud', () => {
    const body = { ...input, custom_url: 'http://127.0.0.1:8791/v1' };
    for (const incoming of ['https://stworks.example', 'http://stworks.example', 'https://127.0.0.1:8790']) {
        assert.throws(() => modelEndpoint(body, new Request(incoming), 'generate'));
    }
    const local = new Request('http://127.0.0.1:8790');
    assert.equal(modelEndpoint(body, local, 'generate').port, '8791');
    for (const custom_url of ['http://model.example.com', 'http://127.0.0.1:8790/v1', 'https://127.0.0.1:8791']) {
        assert.throws(() => modelEndpoint({ ...input, custom_url }, local, 'generate'));
    }
});

test('status and generation ignore legacy allowlist bindings without changing credentials or contacting other services', async t => {
    const { call, env, calls } = await setup(t, (_url, options) => Response.json(options.method === 'GET'
        ? { data: [{ id: 'fixture' }] } : completion));
    await call('/api/secrets/write', { key: 'api_key_custom', value: 'synthetic-custom' });
    for (const legacy of [undefined, '[]', '["https://old-provider.example"]', 'invalid-json']) {
        if (legacy === undefined) delete env.MODEL_ALLOWED_ORIGINS;
        else env.MODEL_ALLOWED_ORIGINS = legacy;
        for (const body of [input, { ...input, chat_completion_source: 'openai',
            reverse_proxy: `${origin}/v1/`, proxy_password: 'synthetic-proxy' }]) {
            for (const action of ['status', 'generate']) {
                assert.equal((await call(`${path}${action}`, body)).status, 200);
                const sent = calls.at(-1);
                assert.equal(sent.url, `${origin}/v1/${action === 'status' ? 'models' : 'chat/completions'}`);
                assert.equal(sent.headers.get('Authorization'), `Bearer synthetic-${body.chat_completion_source === 'custom' ? 'custom' : 'proxy'}`);
                assert.equal(sent.headers.get('Cookie'), null);
                assert.equal(sent.redirect, 'manual');
            }
        }
    }
    assert.equal(calls.length, 16);
});

test('standard request fields match ST projection and preserve nested tool/message data', () => {
    const body = {
        ...input, type: 'normal', user_name: 'Owner', char_name: 'Card', proxy_password: 'never-send',
        secret_id: 'secret-selection', include_reasoning: true,
        messages: [...input.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call', function: { name: 'f', arguments: '{}' } }], future: { keep: 1 } }],
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }], tool_choice: 'auto',
        logprobs: 5, logit_bias: { 123: -1 }, stop: ['STOP'], seed: 42, n: 2,
    };
    const result = JSON.parse(generationBody(body));
    assert.deepEqual(result, {
        messages: body.messages, model: 'fixture', temperature: 0.7, max_tokens: 128,
        stream: false, presence_penalty: 0, frequency_penalty: 0, top_p: 0.9,
        stop: ['STOP'], logit_bias: { 123: -1 }, seed: 42, n: 2, logprobs: true, top_logprobs: 5,
        tools: body.tools, tool_choice: 'auto',
    });
});

test('custom YAML supports ST merge-list and exclude forms without prototype pollution', () => {
    const result = JSON.parse(generationBody({
        ...input, custom_include_body: '- temperature: 0.25\n- top_k: 40\n  future: {keep: true}\n  __proto__: {polluted: true}',
        custom_exclude_body: '- presence_penalty\n- frequency_penalty',
    }));
    assert.equal(result.temperature, 0.25);
    assert.equal(result.top_k, 40);
    assert.deepEqual(result.future, { keep: true });
    assert.deepEqual(result.__proto__, { polluted: true });
    assert.equal({}.polluted, undefined);
    assert.equal(result.presence_penalty, undefined);
    for (const exclude of ['temperature', '{temperature: true}']) {
        assert.equal(JSON.parse(generationBody({ ...input, custom_exclude_body: exclude })).temperature, undefined);
    }
});

test('unsupported options and malformed/expansive YAML fail explicitly', () => {
    for (const change of [
        { json_schema: { value: {} } },
        { request_images: true }, { enable_web_search: true }, { messages: 'legacy prompt' },
        { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
        { model: '' }, { stream: 'true' }, { custom_include_body: 'stream: true' },
        { custom_include_body: 'a: &a [1]\nb: *a' }, { custom_include_body: 'a: [' },
        { custom_include_body: '- false' }, { custom_exclude_body: 'stream' },
    ]) assert.throws(() => generationBody({ ...input, ...change }), error => error.status === 422);
});

test('nonstream response and custom headers are preserved without forwarding browser credentials', async t => {
    const { call, calls, client } = await setup(t);
    const response = await call(`${path}generate`, {
        ...input, custom_include_headers: 'X-Model-Option: test\nAuthorization: Bearer synthetic-custom',
    }, { Cookie: `${client.cookie}; extra=private-owner-cookie`, 'X-Private-Browser-Header': 'private' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), completion);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer synthetic-custom');
    assert.equal(calls[0].headers.get('X-Model-Option'), 'test');
    for (const name of ['Cookie', 'Origin', 'X-CSRF-Token', 'X-Private-Browser-Header']) assert.equal(calls[0].headers.get(name), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('active and explicitly selected encrypted model credentials do not fall back silently', async t => {
    const { call, calls } = await setup(t);
    const first = await (await call('/api/secrets/write', { key: 'api_key_custom', value: 'synthetic-A' })).json();
    await call('/api/secrets/write', { key: 'api_key_custom', value: 'synthetic-B' });
    await call(`${path}generate`, input);
    assert.equal(calls.at(-1).headers.get('Authorization'), 'Bearer synthetic-B');
    await call(`${path}generate`, { ...input, secret_id: first.id });
    assert.equal(calls.at(-1).headers.get('Authorization'), 'Bearer synthetic-A');
    assert.equal((await call(`${path}generate`, { ...input, secret_id: 'missing' })).status, 404);
    assert.equal(calls.length, 2);
});

test('OpenAI requires a key; reverse proxy uses only proxy credentials', async t => {
    const { call, calls } = await setup(t);
    const openai = { ...input, chat_completion_source: 'openai' };
    assert.equal((await call(`${path}generate`, openai)).status, 400);
    await call('/api/secrets/write', { key: 'api_key_openai', value: 'synthetic-openai' });
    await call(`${path}generate`, openai);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer synthetic-openai');
    await call(`${path}generate`, { ...openai, reverse_proxy: `${origin}/api`, proxy_password: 'synthetic-proxy' });
    assert.equal(calls[1].headers.get('Authorization'), 'Bearer synthetic-proxy');
    assert.equal(calls[1].url, `${origin}/api/chat/completions`);
});

test('model list is a GET without a prompt or response cookies', async t => {
    const { call, calls } = await setup(t, () => Response.json({ data: [{ id: 'fixture', future: true }] }, { headers: { 'Set-Cookie': 'evil', 'Location': 'evil' } }));
    const response = await call(`${path}status`, input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: 'fixture', future: true }] });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Location'), null);
});

test('security and unsupported source failures never contact the upstream', async t => {
    const { call, env, calls } = await setup(t);
    for (const name of ['Cookie', 'Host', 'CF-Access-Client-Secret', 'X-CSRF-Token', 'X-Forwarded-For', 'Content-Type', 'Content-Length', 'Connection']) {
        assert.equal((await call(`${path}generate`, { ...input, custom_include_headers: `${name}: forbidden` })).status, 422, name);
    }
    assert.equal((await call(`${path}generate`, { ...input, chat_completion_source: 'claude' })).status, 501);
    assert.equal((await worker.fetch(new Request(`https://stworks.example${path}generate`, { method: 'POST' }), env)).status, 401);
    assert.equal((await call(`${path}generate`, input, { 'X-CSRF-Token': 'invalid' })).status, 403);
    assert.equal(calls.length, 0);
});

test('redirects are not followed and errors never echo upstream content', async t => {
    let status = 302;
    const { call, calls } = await setup(t, () => new Response('private prompt / private key', { status, headers: { Location: 'https://evil.example' } }));
    for (status of [302, 307, 400, 401, 403, 404, 413, 429, 500]) {
        const response = await call(`${path}generate`, input);
        assert.equal(response.status, status < 400 ? 502 : status);
        assert.doesNotMatch(await response.text(), /private|evil/);
    }
    assert.equal(calls.length, 9);
});

test('invalid JSON, HTML, empty choices and malformed models fail instead of faking success', async t => {
    let fixture;
    const { call } = await setup(t, () => fixture());
    for (fixture of [
        () => new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } }),
        () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
        () => Response.json({ choices: [] }), () => Response.json({ error: { message: 'private echo' } }),
        () => Response.json({ choices: [{}] }), () => Response.json({ choices: [{ message: { content: 7 } }] }),
    ]) assert.equal((await call(`${path}generate`, input)).status, 502);
    fixture = () => Response.json({ data: [{}] });
    assert.equal((await call(`${path}status`, input)).status, 502);
});

test('stream forwards split UTF-8 and SSE bytes incrementally without buffering the reply', async t => {
    let source;
    const expected = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"\u4f60\u597d"}}]}\n\ndata: [DONE]\n\n');
    const { call } = await setup(t, () => new Response(new ReadableStream({ start(controller) { source = controller; } }), {
        headers: { 'Content-Type': 'text/event-stream' },
    }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const reader = response.body.getReader();
    source.enqueue(expected.slice(0, 45));
    const first = await reader.read();
    assert.deepEqual(first.value, expected.slice(0, 45));
    source.enqueue(expected.slice(45));
    source.close();
    assert.deepEqual((await reader.read()).value, expected.slice(45));
    assert.equal((await reader.read()).done, true);
});

test('downstream cancellation aborts the upstream and cancels its body', async t => {
    let cancelled = false;
    const { call, calls } = await setup(t, () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    await response.body.cancel();
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(cancelled, true);
});

test('delayed streaming headers allow cancellation without waiting for the model or retrying', async t => {
    const { call, calls } = await setup(t, (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private detail')), { once: true });
    }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
    await response.body.cancel();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
});

test('late upstream errors after deferred headers remain redacted SSE failures, never DONE', async t => {
    let respond;
    const { call, calls } = await setup(t, () => new Promise(resolve => { respond = resolve; }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    respond(new Response('private credential echo', { status: 429 }));
    const text = await response.text();
    assert.match(text, /MODEL_UPSTREAM_ERROR/);
    assert.match(text, /rate limit or quota/);
    assert.doesNotMatch(text, /private|\[DONE\]/);
    assert.equal(calls.length, 1);
});

test('late valid headers preserve the upstream text after deferred streaming starts', async t => {
    let respond;
    const { call } = await setup(t, () => new Promise(resolve => { respond = resolve; }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const bytes = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';
    respond(new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } }));
    assert.equal(await response.text(), bytes);
});

test('stream keepalives preserve one pending read and never split SSE or UTF-8 bytes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let source;
    const { call } = await setup(t, () => new Response(new ReadableStream({ start(controller) { source = controller; } }),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const reader = response.body.getReader();
    const read = reader.read();
    await setImmediate();
    t.mock.timers.tick(1000);
    assert.match(new TextDecoder().decode((await read).value), /^: stworks keep-alive\n\n$/);
    const bytes = new TextEncoder().encode('data: {"text":"\u4f60\u597d"}\r\n\r\n');
    const split = bytes.findIndex(byte => byte > 127) + 1;
    source.enqueue(bytes.slice(0, split));
    assert.deepEqual((await reader.read()).value, bytes.slice(0, split));
    let finished = false;
    const middle = reader.read().then(value => { finished = true; return value; });
    await setImmediate();
    t.mock.timers.tick(5000);
    await setImmediate();
    assert.equal(finished, false, 'A heartbeat must not corrupt an incomplete event.');
    source.enqueue(bytes.slice(split, -1));
    assert.deepEqual((await middle).value, bytes.slice(split, -1));
    source.enqueue(bytes.slice(-1));
    assert.deepEqual((await reader.read()).value, bytes.slice(-1));
    const heartbeat = reader.read();
    await setImmediate();
    t.mock.timers.tick(1000);
    assert.match(new TextDecoder().decode((await heartbeat).value), /^: stworks keep-alive/);
    await reader.cancel();
});

test('cancellation during a pending stream read never enqueues an error into a closed stream', async t => {
    let source;
    const { call, calls } = await setup(t, () => new Response(new ReadableStream({ start(controller) { source = controller; } }),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const reader = response.body.getReader();
    const pending = reader.read();
    await setImmediate();
    await reader.cancel();
    assert.equal((await pending).done, true);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(source.desiredSize, 0);
});

test('incoming abort cancels a pending upstream request with no retry', async t => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { env, calls, client } = await setup(t, (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private transport detail')), { once: true });
        started();
    }));
    const controller = new AbortController();
    const request = new Request(`https://stworks.example${path}generate`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify(input),
        headers: { ...client.headers, 'Content-Type': 'application/json' },
    });
    const pending = worker.fetch(request, env);
    await ready;
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(await response.text(), /private/);
});

test('upstream stream failure becomes an ST-compatible SSE error', async t => {
    const { call } = await setup(t, () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('private transport detail')); } }), {
        headers: { 'Content-Type': 'text/event-stream' },
    }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const text = await response.text();
    assert.match(text, /"error":.*MODEL_INTERRUPTED/);
    assert.doesNotMatch(text, /private/);
});

test('oversized successful response is bounded and rejected', async t => {
    const { call } = await setup(t, () => new Response('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024 * 1024) } }));
    const response = await call(`${path}generate`, input);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'MODEL_RESPONSE_TOO_LARGE');
});

test('five-minute timeout aborts the pending upstream request without retry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { call, calls } = await setup(t, (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
        started();
    }));
    const pending = call(`${path}generate`, input);
    await ready;
    t.mock.timers.tick(300000);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'MODEL_TIMEOUT');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
});

test('stream size limit aborts instead of buffering an unbounded response', async t => {
    const { call, calls } = await setup(t, () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await call(`${path}generate`, { ...input, stream: true });
    const text = await response.text();
    assert.match(text, /MODEL_RESPONSE_TOO_LARGE/);
    assert.equal(calls[0].signal.aborted, true);
});

test('original frontend error helper throws model errors without swallowing or stringifying objects', () => {
    const source = readFileSync(new URL('../../public/scripts/openai.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const start = source.indexOf('export function tryParseStreamingError(');
    assert.ok(start > 0);
    const end = source.indexOf('\n}', start) + 2;
    const notifications = [];
    const parseError = runInNewContext(`(${source.slice(start, end).replace('export ', '')})`, {
        checkQuotaError() {}, checkModerationError() {},
        toastr: { error(message) { notifications.push(message); } },
    });
    parseError({}, 'data: [DONE]');
    parseError({}, '{"choices":[]}');
    assert.throws(() => parseError({}, '{"error":{"message":"interrupted"}}'), /interrupted/);
    assert.deepEqual(notifications, ['interrupted']);
    assert.throws(() => parseError({}, '{"error":{"message":"quiet error"}}', { quiet: true }), /quiet error/);
    assert.equal(notifications.length, 1);
});
