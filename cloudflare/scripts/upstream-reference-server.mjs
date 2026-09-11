import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { upstreamCommit } from '../test/upstream-reference.js';

export async function startReferenceServer(modelBase) {
    const url = new URL(modelBase);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, 'http:');
    const dataRoot = fileURLToPath(new URL(`../.build/reference-api/${randomUUID()}/`, import.meta.url));
    await mkdir(dataRoot, { recursive: true });
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_ENABLEDOWNLOADABLETOKENIZERS = 'false';
    const { router } = await import('../../src/endpoints/backends/chat-completions.js');
    const token = randomUUID();
    const app = express();
    app.use((request, response, next) => {
        if (request.get('X-STworks-Test') !== token) return response.sendStatus(401);
        if (request.method !== 'POST' || !['generate', 'process', 'status'].some(action => request.path === `/api/backends/chat-completions/${action}`)) return response.sendStatus(404);
        next();
    });
    app.use(express.json({ limit: '1mb' }));
    app.use((request, response, next) => {
        const body = request.body;
        if (!request.path.endsWith('/process')) {
            if (!['custom', 'openai'].includes(body.chat_completion_source)) return response.sendStatus(403);
            const base = body.chat_completion_source === 'custom' ? body.custom_url : body.reverse_proxy;
            if (base !== modelBase) return response.sendStatus(403);
        }
        request.user = { directories: { root: dataRoot } };
        next();
    });
    app.use('/api/backends/chat-completions', router);
    const debug = console.debug;
    console.debug = () => {}; // Original router logs prompts; the comparison report stores only synthetic fixtures.
    let server;
    try {
        server = await new Promise((resolve, reject) => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
            instance.once('error', reject);
        });
    } catch (error) {
        console.debug = debug;
        throw error;
    }
    return {
        commit: upstreamCommit,
        async post(action, body) {
            const input = structuredClone(body);
            if (action !== 'process') {
                if (input.chat_completion_source === 'custom') input.custom_url = modelBase;
                else {
                    input.reverse_proxy = modelBase;
                    input.proxy_password = 'synthetic-reference-proxy';
                }
            }
            return fetch(`http://127.0.0.1:${server.address().port}/api/backends/chat-completions/${action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STworks-Test': token },
                body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
            });
        },
        async close() {
            console.debug = debug;
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
