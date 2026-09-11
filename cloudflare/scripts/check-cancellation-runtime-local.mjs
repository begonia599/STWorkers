import assert from 'node:assert/strict';
import { ownerClient } from './owner-client.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import wrangler from 'wrangler';
import { createGenerationModel } from './p3-generation-model.mjs';

const bundle = new URL('../.build/worker/index.js', import.meta.url);
const { unstable_splitSqlQuery: splitSqlQuery } = wrangler;
const model = createGenerationModel();
const password = randomUUID();
const evidence = { startedAt: new Date().toISOString(), cases: [], scope: 'Local built Worker only; no cloud verification.' };
let runtime;
try {
    model.server.listen(0, '127.0.0.1');
    await once(model.server, 'listening');
    const origin = `http://127.0.0.1:${model.server.address().port}`;
    evidence.bundleSha256 = createHash('sha256').update(await readFile(bundle)).digest('hex');
    runtime = new Miniflare(convertV4MiniflareOptions({
        name: 'stworks-cancellation-probe', modules: true, scriptPath: fileURLToPath(bundle),
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        host: '127.0.0.1', port: 0, unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
        d1Databases: ['DB'], r2Buckets: ['FILES'],
        bindings: { AUTH_PASSWORD: password },
    }));
    const db = await runtime.getD1Database('DB');
    for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
        await db.batch(splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    for (const [name, url] of [['miniflare-entry', await runtime.ready],
        ['workerd-direct', await runtime.unsafeGetDirectURL('stworks-cancellation-probe')]]) {
        const base = url.origin;
        const owner = await ownerClient(base, password);
        const index = model.records.worker.length;
        model.plan('worker', name, { mode: 'headers-pending' });
        const controller = new AbortController();
        const request = fetch(`${base}/api/backends/chat-completions/generate`, {
            method: 'POST', signal: controller.signal,
            headers: { ...owner.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: `${origin}/worker/v1`,
                model: 'p3-generation-fixture', stream: true, messages: [{ role: 'user', content: 'P3 pending headers' }] }),
        }).then(response => ({ status: response.status }), error => ({ error: error.name }));
        for (let count = 0; count < 100 && model.records.worker.length === index; count++) await delay(50);
        assert.equal(model.records.worker.length, index + 1);
        controller.abort();
        assert.equal((await request).error, 'AbortError');
        for (let count = 0; count < 100 && !model.records.worker[index].closedEarly; count++) await delay(50);
        const record = model.records.worker[index];
        evidence.cases.push({ name, closedBeforeHeaders: record.closedEarly, requests: 1, chunksWritten: record.chunksWritten });
        console.log(JSON.stringify(evidence.cases.at(-1)));
    }
    assert.ok(evidence.cases.every(record => record.closedBeforeHeaders), 'A local runtime did not propagate cancellation before headers.');
    evidence.status = 'passed';
} catch (error) {
    evidence.status = 'failed';
    evidence.failure = error.message;
    throw error;
} finally {
    await runtime?.dispose();
    model.server.closeAllConnections();
    if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
    const output = new URL('../.build/cancellation-runtime/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('results.json', output), JSON.stringify(evidence, null, 2));
}
