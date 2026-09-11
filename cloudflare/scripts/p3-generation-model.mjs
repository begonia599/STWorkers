import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export const frame = (content, finish = null) => `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
})}\n\n`;

export function createGenerationModel() {
    const records = { worker: [], original: [] };
    const queues = { worker: [], original: [] };
    const server = createServer(async (request, response) => {
        const match = request.url.match(/^\/(worker|original)\/v1\/(models|chat\/completions)$/);
        if (!match) return response.writeHead(404).end();
        const [, side, action] = match;
        if (action === 'models') return response.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ data: [{ id: 'p3-generation-fixture' }] }));
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const plan = queues[side].shift();
        const record = { label: plan?.label ?? 'UNPLANNED', body: JSON.parse(Buffer.concat(chunks).toString()),
            complete: false, closedEarly: false, chunksWritten: 0 };
        records[side].push(record);
        response.on('close', () => { record.closedEarly = !record.complete; });
        if (plan) plan.close = () => response.destroy();
        if (!plan) return response.writeHead(409).end('Unplanned synthetic request');
        if (plan.mode === 'headers-pending') {
            while (!response.destroyed) await delay(50);
            return;
        }
        if (plan.mode === 'late-error') {
            await delay(600);
            if (response.destroyed) return;
            record.complete = true;
            return response.writeHead(429, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: { message: 'P3 synthetic delayed failure', code: 'rate_limit_exceeded' } }));
        }
        if (!record.body.stream) {
            record.complete = true;
            return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                choices: [{ index: 0, message: { role: 'assistant', content: plan.text }, finish_reason: 'stop' }],
            }));
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(frame('P3 '));
        record.chunksWritten++;
        if (plan.mode === 'slow' || plan.mode === 'stalled') {
            let sent = false;
            while (!response.destroyed) {
                await delay(100);
                if (!response.destroyed && (plan.mode === 'slow' || !sent)) {
                    response.write(frame('waiting '));
                    record.chunksWritten++;
                    sent = true;
                }
            }
            return;
        }
        await delay(150);
        if (response.destroyed) return;
        // The first frame may arrive before the frontend's streaming throttle opens.
        response.write(frame(plan.text.slice(3, 6)));
        record.chunksWritten++;
        await delay(150);
        if (response.destroyed) return;
        const bytes = Buffer.from(frame(plan.text.slice(6)));
        // Split inside a UTF-8 character, not only at JSON/SSE boundaries.
        const position = bytes.indexOf(Buffer.from('\u4f60'));
        const split = position < 0 ? Math.floor(bytes.length / 2) : position + 1;
        response.write(bytes.subarray(0, split));
        await delay(150);
        if (response.destroyed) return;
        response.write(bytes.subarray(split));
        record.chunksWritten++;
        response.write(frame('', 'stop'));
        record.complete = true;
        response.end('data: [DONE]\n\n');
    });
    return {
        server, records,
        plan(side, label, { mode = 'normal', text = `P3 ${label}. \u4f60\u597d.` } = {}) {
            assert.ok(side in queues);
            assert.ok(['normal', 'slow', 'stalled', 'headers-pending', 'late-error'].includes(mode));
            assert.ok(text.startsWith('P3 '));
            const plan = { label, mode, text };
            queues[side].push(plan);
            return plan;
        },
    };
}
