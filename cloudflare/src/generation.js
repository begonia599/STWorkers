import { isIP } from 'node:net';
import { parse } from 'yaml';
import { HttpError, readBytes, readJsonObject } from './http.js';
import { readModelSecret } from './secrets.js';
import { boundedJson, postProcessPrompt, validateMessages } from './prompt-processing.js';
import { applyReasoningOptions, schemaResponseFormat } from './model-options.js';

const OPENAI = 'https://api.openai.com/v1';
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;
const HEADER_GRACE_MS = 250;
const KEEPALIVE_MS = 1000;
const KEEPALIVE = new TextEncoder().encode(': stworks keep-alive\n\n');
const FIELDS = [
    'messages', 'model', 'temperature', 'max_tokens', 'max_completion_tokens', 'stream',
    'presence_penalty', 'frequency_penalty', 'top_p', 'top_k', 'stop', 'logit_bias', 'seed', 'n',
];
const forbiddenHeaders = /^(host|cookie|cookie2|set-cookie|proxy-.*|cf-.*|x-forwarded-.*|forwarded|sec-.*|x-csrf-token|connection|keep-alive|transfer-encoding|content-length|content-type|accept|accept-encoding|te|trailer|upgrade|origin|referer)$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(code, message) {
    throw new HttpError(422, code, message);
}

function yamlValue(value) {
    if (!value) return undefined;
    if (typeof value !== 'string' || value.length > 16384) {
        invalid('INVALID_CUSTOM_YAML', 'Custom YAML must be a string of at most 16384 characters.');
    }
    try {
        return parse(value, { maxAliasCount: 0 });
    } catch {
        invalid('INVALID_CUSTOM_YAML', 'Custom YAML is invalid; aliases are not supported.');
    }
}

function yamlObject(value) {
    const parsed = yamlValue(value);
    if (parsed == null) return {};
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (!entries.every(isObject)) invalid('INVALID_CUSTOM_YAML', 'Expected a YAML mapping or a list of mappings.');
    return Object.fromEntries(entries.flatMap(Object.entries));
}

export function modelEndpoint(body, request, action) {
    if (!['openai', 'custom'].includes(body.chat_completion_source)) {
        throw new HttpError(501, 'MODEL_SOURCE_NOT_IMPLEMENTED', 'This stage supports OpenAI and Custom (OpenAI-compatible).');
    }
    const base = body.chat_completion_source === 'custom' ? body.custom_url : (body.reverse_proxy || OPENAI);
    let url;
    try { url = new URL(base); }
    catch { invalid('INVALID_MODEL_URL', 'Enter a valid model API base URL.'); }
    if (url.username || url.password || url.search || url.hash) {
        invalid('INVALID_MODEL_URL', 'Model URLs cannot contain credentials, query parameters or fragments.');
    }
    const incoming = new URL(request.url);
    const hostname = url.hostname.replace(/\.+$/, '');
    // Plain HTTP is only for loopback-to-loopback fixtures in local development.
    const local = incoming.protocol === 'http:' && incoming.hostname === '127.0.0.1' && url.hostname === '127.0.0.1';
    if (!(local && url.protocol === 'http:') && (
        url.protocol !== 'https:' || isIP(hostname.replace(/^\[|\]$/g, ''))
        || !hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname)
    )) invalid('INVALID_MODEL_URL', 'Use a public HTTPS hostname for the model API.');
    if (url.protocol === incoming.protocol && hostname === incoming.hostname.replace(/\.+$/, '') && url.port === incoming.port) {
        invalid('INVALID_MODEL_URL', 'The model API cannot point to STworks itself.');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${action === 'status' ? 'models' : 'chat/completions'}`;
    return url;
}

export function generationBody(body) {
    for (const field of ['enable_web_search', 'request_images']) {
        if (body[field]) invalid('MODEL_OPTION_NOT_IMPLEMENTED', `The ${field} option is not implemented in this stage.`);
    }
    const payload = Object.fromEntries(FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    payload.messages = postProcessPrompt(body.messages, body.custom_prompt_post_processing ?? '', body);
    const responseFormat = body.json_schema ? schemaResponseFormat(body.json_schema) : undefined;
    if (body.logprobs !== undefined) {
        payload.logprobs = body.logprobs > 0 ? true : body.logprobs;
        if (body.logprobs > 0) payload.top_logprobs = body.logprobs;
    }
    if (body.chat_completion_source === 'custom') {
        Object.defineProperties(payload, Object.fromEntries(Object.entries(yamlObject(body.custom_include_body))
            .map(([key, value]) => [key, { value, enumerable: true, writable: true, configurable: true }])));
        if (responseFormat) payload.response_format = responseFormat;
    }
    applyReasoningOptions(payload, body);
    if (Array.isArray(body.stop) && body.stop.length) payload.stop = body.stop;
    if (Array.isArray(body.tools) && body.tools.length) {
        payload.tools = body.tools;
        payload.tool_choice = body.tool_choice;
    }
    if (responseFormat && !payload.response_format) payload.response_format = responseFormat;
    if (body.chat_completion_source === 'custom') {
        const excluded = yamlValue(body.custom_exclude_body);
        const keys = Array.isArray(excluded) ? excluded : isObject(excluded) ? Object.keys(excluded) : typeof excluded === 'string' ? [excluded] : [];
        for (const key of keys) delete payload[key];
    }
    if (typeof payload.model !== 'string' || !payload.model.trim() || payload.model.length > 256) {
        invalid('INVALID_MODEL', 'A model name of at most 256 characters is required.');
    }
    if (typeof payload.stream !== 'boolean' || payload.stream !== body.stream) {
        invalid('INVALID_STREAM_MODE', 'Stream mode must match the frontend request and cannot be overridden or excluded.');
    }
    validateMessages(payload.messages);
    return boundedJson(payload);
}

async function modelHeaders(body, env, stream) {
    const proxy = body.chat_completion_source === 'openai' && body.reverse_proxy;
    const key = proxy ? body.proxy_password : await readModelSecret(env, `api_key_${body.chat_completion_source}`, body.secret_id);
    if (!key && !proxy && body.chat_completion_source === 'openai') {
        throw new HttpError(400, 'MODEL_KEY_REQUIRED', 'Save an OpenAI API key before connecting.');
    }
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' });
    try {
        if (key) headers.set('Authorization', `Bearer ${key}`);
        if (body.chat_completion_source === 'custom') {
            for (const [name, value] of Object.entries(yamlObject(body.custom_include_headers))) {
                if (forbiddenHeaders.test(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
                    invalid('MODEL_HEADER_NOT_ALLOWED', 'Custom headers cannot override transport, browser or STworks security headers.');
                }
                headers.set(name, String(value));
            }
        }
    } catch (error) {
        if (error instanceof HttpError) throw error;
        invalid('INVALID_MODEL_HEADER', 'A model credential or custom header is invalid.');
    }
    return headers;
}

function upstreamError(status) {
    const messages = {
        400: 'The model rejected the request. Check model options and the context limit.',
        401: 'The model service rejected the API credential.',
        403: 'The model service denied access.',
        404: 'The model endpoint or model was not found.',
        413: 'The model service rejected the prompt size.',
        429: 'The model service rate limit or quota was exceeded.',
    };
    return new HttpError(status >= 400 && status <= 599 ? status : 502, 'MODEL_UPSTREAM_ERROR',
        messages[status] ?? `The model service returned HTTP ${status}.`);
}

function interruption(signal) {
    return new HttpError(signal.reason === 'timeout' ? 504 : 502,
        signal.reason === 'timeout' ? 'MODEL_TIMEOUT' : 'MODEL_INTERRUPTED',
        signal.reason === 'timeout' ? 'The model request exceeded five minutes.' : 'The model connection was interrupted. No automatic retry was made.');
}

async function headersOrDeferred(upstream) {
    let timer;
    try {
        return await Promise.race([upstream, new Promise(resolve => {
            timer = setTimeout(() => resolve(null), HEADER_GRACE_MS);
        })]);
    } finally { clearTimeout(timer); }
}

function relayStream(upstream, controller, cleanup) {
    let reader, stopped = false, timer;
    let size = 0;
    let lineBreaks = 2, previousCR = false;
    const result = promise => promise.then(value => ({ value }), error => ({ error }));
    let pending = result(Promise.resolve(upstream).then(async response => {
        reader = response.body.getReader();
        if (stopped) {
            await reader.cancel();
            return { done: true };
        }
        return reader.read();
    }));
    return new ReadableStream({
        async pull(downstream) {
            try {
                // Keep the same pending read across heartbeats; never insert bytes inside an SSE event.
                const next = lineBreaks >= 2 ? await Promise.race([pending, new Promise(resolve => {
                    timer = setTimeout(() => resolve({ heartbeat: true }), KEEPALIVE_MS);
                })]) : await pending;
                clearTimeout(timer);
                if (stopped) return;
                if (next.heartbeat) {
                    downstream.enqueue(KEEPALIVE);
                    return;
                }
                if (next.error) throw next.error;
                const { value, done } = next.value;
                if (done) {
                    stopped = true;
                    downstream.close();
                    cleanup();
                    return;
                }
                size += value.byteLength;
                if (size > RESPONSE_LIMIT) throw new HttpError(502, 'MODEL_RESPONSE_TOO_LARGE', 'The model response exceeded 8 MiB.');
                // Only the final four bytes can determine whether two SSE line endings precede a heartbeat.
                if (value.length >= 4) { lineBreaks = 0; previousCR = false; }
                for (let index = Math.max(0, value.length - 4); index < value.length; index++) {
                    const byte = value[index];
                    if (byte === 13) { lineBreaks++; previousCR = true; }
                    else if (byte === 10) { if (!previousCR) lineBreaks++; previousCR = false; }
                    else { lineBreaks = 0; previousCR = false; }
                }
                downstream.enqueue(value);
                pending = result(reader.read());
            } catch (error) {
                clearTimeout(timer);
                if (stopped) return;
                stopped = true;
                const failure = error instanceof HttpError ? error : interruption(controller.signal);
                // HTTP status is already sent; ST's SSE parser surfaces this error envelope.
                downstream.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n\n`));
                downstream.close();
                controller.abort();
                await reader?.cancel().catch(() => {});
                cleanup();
            }
        },
        async cancel() {
            stopped = true;
            clearTimeout(timer);
            controller.abort('client');
            await reader?.cancel().catch(() => {});
            cleanup();
        },
    }, { highWaterMark: 0 });
}

export async function handleGeneration(request, env, pathname) {
    const body = await readJsonObject(request);
    const action = pathname.split('/').at(-1);
    const url = modelEndpoint(body, request, action);
    const payload = action === 'generate' ? generationBody(body) : undefined;
    const streaming = action === 'generate' && body.stream === true;
    const headers = await modelHeaders(body, env, streaming);
    const controller = new AbortController();
    const abort = () => controller.abort('client');
    const timeout = setTimeout(() => controller.abort('timeout'), TIMEOUT_MS);
    const cleanup = () => {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', abort);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    let streamed = false;
    try {
        const responsePending = fetch(url, {
            method: action === 'status' ? 'GET' : 'POST', headers, body: payload,
            redirect: 'manual', signal: controller.signal,
        }).then(async upstream => {
            if (upstream.status >= 300 && upstream.status < 400) {
                await upstream.body?.cancel();
                throw new HttpError(502, 'MODEL_REDIRECT_BLOCKED', 'Model redirects are disabled. Configure the final API base URL.');
            }
            if (!upstream.ok) {
                // Never reflect upstream error bodies or headers: they can echo credentials and prompts.
                await upstream.body?.cancel();
                throw upstreamError(upstream.status);
            }
            const contentType = upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
            if (!upstream.body || contentType !== (streaming ? 'text/event-stream' : 'application/json')) {
                await upstream.body?.cancel();
                throw new HttpError(502, 'INVALID_MODEL_RESPONSE', 'The model service returned an unexpected response format.');
            }
            return upstream;
        });
        const upstream = streaming ? await headersOrDeferred(responsePending) : await responsePending;
        if (streaming) {
            streamed = true;
            return new Response(relayStream(upstream ?? responsePending, controller, cleanup), {
                headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
            });
        }
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(upstream, RESPONSE_LIMIT))); }
        catch (error) {
            if (controller.signal.aborted) throw interruption(controller.signal);
            if (error?.code === 'PAYLOAD_TOO_LARGE') throw new HttpError(502, 'MODEL_RESPONSE_TOO_LARGE', 'The model response exceeded 8 MiB.');
            throw new HttpError(502, 'INVALID_MODEL_RESPONSE', 'The model service returned invalid JSON.');
        }
        if (!isObject(value) || value.error || (action === 'status'
            ? !Array.isArray(value.data) || !value.data.every(model => typeof model?.id === 'string')
            : !Array.isArray(value.choices) || !value.choices.length || !value.choices.every(choice => {
                const message = choice?.message;
                return isObject(message) && (typeof message.content === 'string' || message.content === null || Array.isArray(message.tool_calls));
            }))) {
            throw new HttpError(502, 'INVALID_MODEL_RESPONSE', 'The model response does not match the expected chat completion contract.');
        }
        return Response.json(value);
    } catch (error) {
        controller.abort(controller.signal.reason);
        if (error instanceof HttpError) throw error;
        throw interruption(controller.signal);
    } finally {
        if (!streamed) cleanup();
    }
}
