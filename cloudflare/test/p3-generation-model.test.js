import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createGenerationModel, frame } from '../scripts/p3-generation-model.mjs';

async function fixture(t) {
    const model = createGenerationModel();
    model.server.listen(0, '127.0.0.1');
    await once(model.server, 'listening');
    t.after(async () => {
        model.server.closeAllConnections();
        await new Promise(resolve => model.server.close(resolve));
    });
    return { ...model, url: `http://127.0.0.1:${model.server.address().port}` };
}

test('P3 model emits delayed UTF-8 SSE and records the actual request by side', async t => {
    const model = await fixture(t);
    const plan = model.plan('worker', 'utf8');
    const body = { stream: true, messages: [{ role: 'user', content: 'synthetic' }] };
    const response = await fetch(`${model.url}/worker/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(text, frame('P3 ') + frame(plan.text.slice(3, 6)) + frame(plan.text.slice(6))
        + frame('', 'stop') + 'data: [DONE]\n\n');
    assert.deepEqual(model.records.worker[0].body, body);
    assert.equal(model.records.worker[0].complete, true);
    assert.equal(model.records.original.length, 0);
});

test('P3 slow model observes client cancellation rather than declaring completion', async t => {
    const model = await fixture(t);
    model.plan('original', 'cancel', { mode: 'slow' });
    const abort = new AbortController();
    const response = await fetch(`${model.url}/original/v1/chat/completions`, {
        method: 'POST', body: '{"stream":true}', signal: abort.signal,
    });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    abort.abort();
    for (let count = 0; count < 100 && !model.records.original[0].closedEarly; count++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(model.records.original[0].closedEarly, true);
    assert.equal(model.records.original[0].complete, false);
});

test('P3 model treats extra generation requests as failures, not implicit retries', async t => {
    const model = await fixture(t);
    const response = await fetch(`${model.url}/worker/v1/chat/completions`, { method: 'POST', body: '{"stream":true}' });
    assert.equal(response.status, 409);
    assert.equal(model.records.worker[0].label, 'UNPLANNED');
});
