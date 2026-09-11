import assert from 'node:assert/strict';
import test from 'node:test';
import { PROCESSING_TYPES, postProcessPrompt } from '../src/prompt-processing.js';
import { flattenSchema, applyReasoningOptions } from '../src/model-options.js';
import { generationBody } from '../src/generation.js';
import { harness } from './p1-helper.js';
import { reference, originalFlattenSchema, constants } from './upstream-reference.js';

const names = { char_name: 'Alice', user_name: 'Bob', group_names: ['Carol', 'Dave'] };
const tool = { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"test"}' } };
const fixtures = [
    [],
    [{ role: 'system', content: 'Only system.' }],
    [{ role: 'assistant', content: 'Assistant first.' }],
    [{ role: 'system', name: 'example_assistant', content: 'Hi' }, { role: 'system', name: 'example_user', content: 'Hello' }],
    [{ role: 'system', name: 'example_assistant', content: 'Carol: Already named' }],
    [{ role: 'user', name: 'Bob', content: 'Bob: No duplicate prefix' }, { role: 'user', content: 'Second', future: [1, null] }],
    [{ role: 'system', content: 'Top' }, { role: 'assistant', content: 'A' }, { role: 'system', content: 'Middle' }, { role: 'user', content: 'U' }],
    [{ role: 'assistant', content: null, tool_calls: [tool], extra: { retain: true } }, { role: 'tool', content: 'Result', tool_call_id: 'call_1' },
        { role: 'tool', content: 'Other', tool_call_id: 'call_2' }, { role: 'assistant', content: 'Reply' }],
    [{ role: 'assistant', tool_calls: [tool] }, { role: 'assistant', content: 'After tools', future: false }],
    [{ role: 'user', content: [{ type: 'text', text: 'Part one' }, { type: 'text', text: 'Part two' }] }, { role: 'user', content: [] }],
    [{ role: 'user', content: '' }, { role: 'user', content: '' }, { role: 'user', content: 'End' }],
    [{ role: 'function', name: 'lookup', content: 'Return' }, { role: 'developer', content: 'Developer rule' }],
];

for (const type of PROCESSING_TYPES) {
    test(`post-processing ${type || 'none'} matches actual pinned ST functions`, () => {
        for (const messages of fixtures) {
            const original = structuredClone(messages);
            const expected = reference.postProcessPrompt(structuredClone(messages), type, reference.getPromptNames({ body: names }));
            assert.deepEqual(postProcessPrompt(messages, type, names), expected);
            assert.deepEqual(messages, original, 'Worker helper must not mutate its caller input');
        }
    });
}

test('deterministic mixed text/tool message sequences agree with the original processor', () => {
    let seed = 17;
    const next = max => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max);
    for (let i = 0; i < 80; i++) {
        const messages = Array.from({ length: next(16) }, () => structuredClone(fixtures[1 + next(fixtures.length - 1)][0]));
        for (const type of PROCESSING_TYPES) {
            assert.deepEqual(postProcessPrompt(messages, type, names),
                reference.postProcessPrompt(structuredClone(messages), type, reference.getPromptNames({ body: names })), `${type} case ${i}`);
        }
    }
});

test('standalone process route returns the ST envelope without calling a model or requiring its key', async t => {
    const { call } = await harness(t);
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected model request'); });
    const messages = fixtures[6];
    const response = await call('/api/backends/chat-completions/process', { ...names, type: 'strict_tools', messages });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messages: postProcessPrompt(messages, 'strict_tools', names) });
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal((await call('/api/backends/chat-completions/process', { type: 'unknown', messages })).status, 400);
    assert.equal((await call('/api/backends/chat-completions/process', { type: '', messages: 'invalid' })).status, 400);
    assert.equal((await call('/api/backends/chat-completions/process')).status, 405);
    assert.equal((await call('/api/backends/chat-completions/process', { type: '', messages }, { 'X-CSRF-Token': 'invalid' })).status, 403);
    assert.equal((await call('/api/backends/chat-completions/process', { type: '', messages }, { Cookie: '' })).status, 401);
});

test('post-processing rejects unsupported media, oversized names and oversized expanded prompts', () => {
    assert.throws(() => postProcessPrompt([{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }], 'merge'), { code: 'INVALID_MESSAGES' });
    assert.throws(() => postProcessPrompt(fixtures[1], 'single', { char_name: 'x'.repeat(513) }), { code: 'INVALID_PROMPT_NAMES' });
    const messages = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    assert.throws(() => postProcessPrompt(messages, 'single', { char_name: 'C'.repeat(512), user_name: 'U'.repeat(512) }), { code: 'PAYLOAD_TOO_LARGE' });
});

test('JSON Schema transformation matches pinned ST including recursion and sibling handling', () => {
    for (const schema of [
        { type: 'object', additionalProperties: false, properties: { score: { type: 'integer', minimum: 0 } }, required: ['score'] },
        { $schema: 'synthetic-schema', $defs: { item: { type: 'string', default: 'x' } }, properties: { item: { $ref: '#/$defs/item', description: 'discarded by ST' } } },
        { $defs: { A: { type: 'object', properties: { next: { $ref: '#/$defs/A' } } } }, $ref: '#/$defs/A' },
        { $defs: { A: { $ref: '#/$defs/B' }, B: { type: 'integer' } }, items: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/missing' }] },
        { type: 'object', properties: { one: { $ref: 'https://example.com/schema' } }, future: { nested: [null, false, 0] } },
    ]) {
        const before = structuredClone(schema);
        assert.deepEqual(flattenSchema(schema), originalFlattenSchema(schema, 'custom'));
        assert.deepEqual(flattenSchema(schema), originalFlattenSchema(schema, 'openai'));
        assert.deepEqual(schema, before);
    }
});

test('schema expansion bounds depth, repeated definitions, node count and prototype keys', () => {
    let deep = { type: 'string' };
    for (let i = 0; i < 70; i++) deep = { items: deep };
    assert.throws(() => flattenSchema(deep), { code: 'SCHEMA_EXPANSION_LIMIT' });
    const defs = { item0: { type: 'string' } };
    for (let i = 1; i < 20; i++) defs[`item${i}`] = { anyOf: [{ $ref: `#/$defs/item${i - 1}` }, { $ref: `#/$defs/item${i - 1}` }] };
    assert.throws(() => flattenSchema({ $defs: defs, $ref: '#/$defs/item19' }), { code: 'SCHEMA_EXPANSION_LIMIT' });
    assert.throws(() => flattenSchema({ $defs: { text: { description: 'x'.repeat(32768) } }, anyOf: Array.from({ length: 50 }, () => ({ $ref: '#/$defs/text' })) }), { code: 'SCHEMA_EXPANSION_LIMIT' });
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    assert.deepEqual(flattenSchema(schema), schema);
    assert.deepEqual(flattenSchema({ $defs: {}, $ref: '#/$defs/constructor' }), {});
    assert.equal({}.polluted, undefined);
});

test('reasoning and verbosity mappings match the locked ST tables, not an invented model list', () => {
    for (const source of ['openai', 'custom']) {
        for (const model of [...constants.OPENAI_REASONING_EFFORT_MODELS, 'stworks-fixture', 'koboldcpp/fixture']) {
            for (const effort of [undefined, '', 'min', 'low', 'high', 'none']) {
                const body = { chat_completion_source: source, model, reasoning_effort: effort, verbosity: 'low' };
                const expected = {};
                if (effort && constants.OPENAI_REASONING_EFFORT_MODELS.includes(model)) expected.reasoning_effort = constants.OPENAI_FIXED_REASONING_EFFORT[model] ?? constants.OPENAI_REASONING_EFFORT_MAP[effort] ?? effort;
                if (effort && source === 'custom' && /^koboldcpp\/(.+)$/.test(model)) expected.reasoning_effort = effort;
                if (constants.OPENAI_VERBOSITY_MODELS.test(model)) expected.verbosity = 'low';
                const result = {};
                applyReasoningOptions(result, body);
                assert.deepEqual(result, expected);
            }
        }
    }
});

test('generation preserves ST ordering: postprocess then YAML, schema/stop/tools override, exclusions last', () => {
    const body = {
        ...names, chat_completion_source: 'custom', model: 'gpt-5', stream: false,
        messages: fixtures[6], custom_prompt_post_processing: 'strict',
        custom_include_body: 'stop: [yaml-stop]\ntools: [yaml-tool]\nreasoning_effort: yaml-effort\nresponse_format: {type: json_object}',
        stop: ['ST-stop'], tools: [tool], tool_choice: 'required', reasoning_effort: 'min', verbosity: 'low',
        json_schema: { name: 'Result', value: { $defs: { score: { type: 'integer' } }, properties: { score: { $ref: '#/$defs/score' } } } },
    };
    const result = JSON.parse(generationBody(body));
    assert.deepEqual(result.messages, postProcessPrompt(body.messages, 'strict', names));
    assert.deepEqual(result.stop, ['ST-stop']);
    assert.deepEqual(result.tools, [tool]);
    assert.equal(result.tool_choice, 'required');
    assert.equal(result.reasoning_effort, 'minimal');
    assert.equal(result.verbosity, 'low');
    assert.deepEqual(result.response_format, { type: 'json_schema', json_schema: {
        name: 'Result', strict: true, schema: { properties: { score: { type: 'integer' } } },
    } });
    const excluded = JSON.parse(generationBody({ ...body, custom_exclude_body: '[tools, stop, reasoning_effort, response_format]' }));
    for (const key of ['tools', 'stop', 'reasoning_effort', 'response_format']) assert.equal(excluded[key], undefined);
    const overridden = JSON.parse(generationBody({ ...body, custom_include_body: 'messages: [{role: user, content: replacement}]' }));
    assert.deepEqual(overridden.messages, [{ role: 'user', content: 'replacement' }]);
});
