import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { BYTES_PER_TOKEN, TOKEN_ESTIMATOR, estimateText, estimateMessages } from '../../public/scripts/stworks-token-estimator.js';
import { STATUS } from '../src/capabilities.js';

test('browser estimation is explicitly approximate and does not supply token ids', () => {
    assert.equal(TOKEN_ESTIMATOR.runtime, 'browser');
    assert.equal(TOKEN_ESTIMATOR.accuracy, 'estimate');
    assert.equal(TOKEN_ESTIMATOR.tokenIds, false);
    assert.ok(Object.isFrozen(TOKEN_ESTIMATOR));
    assert.equal(STATUS.tokenCounting.algorithm, TOKEN_ESTIMATOR.id);
    assert.equal(STATUS.tokenCounting.backendTokenizers, false);
});

test('temporary text estimates follow the pinned ST UTF-8 byte fallback', () => {
    for (const text of ['', 'hello world', '\u4e16\u754c', '\u{1f680}', 'e\u0301', '\ud800',
        '{{user}}\n{{char}}\t', '<|endoftext|>', 'abc \u4e2d\u6587'.repeat(20000)]) {
        assert.equal(estimateText(text), Math.ceil(Buffer.byteLength(text, 'utf8') / 3.35));
    }
    assert.equal(BYTES_PER_TOKEN, 3.35);
});

test('empty and invalid text does not produce NaN or a negative count', () => {
    for (const text of ['', undefined, null, false, 7, {}, []]) {
        assert.equal(estimateText(text), 0);
    }
});

test('message estimates support one message, arrays, names and full adjustment', () => {
    const message = { role: 'user', content: 'hello world', name: 'Tester' };
    const expected = 6 + 2 + 4 + 2 + 1 - 1;
    assert.equal(estimateMessages(message, { full: true }), expected);
    assert.equal(estimateMessages([message]), expected - 2);
    assert.equal(estimateMessages([message, message]), (expected + 1) * 2 - 3);
    assert.equal(estimateMessages(message, { model: 'claude' }), expected);
    assert.deepEqual(message, { role: 'user', content: 'hello world', name: 'Tester' });
});

test('structured message fields are estimated as JSON text without input mutation', () => {
    const message = { role: 'assistant', content: [{ type: 'text', text: 'hello' }], extra: null };
    const before = structuredClone(message);
    assert.equal(estimateMessages(message, { full: true }),
        5 + estimateText('assistant') + estimateText(JSON.stringify(message.content)) + estimateText('null'));
    assert.deepEqual(message, before);
});

test('empty message collections return zero instead of upstream negative padding', () => {
    for (const messages of [[], null, undefined, [null, undefined, 'invalid']]) {
        assert.equal(estimateMessages(messages), 0);
        assert.equal(estimateMessages(messages, { full: true }), 0);
    }
});

test('estimation is synchronous and independent of model ids', () => {
    const messages = [{ role: 'system', content: 'A synthetic prompt.' }];
    const expected = estimateMessages(messages);
    for (const model of ['gpt-4o', 'gemini-test', 'unknown-model']) {
        assert.equal(estimateMessages(messages, { model }), expected);
    }
    assert.equal(typeof estimateText('prompt'), 'number');
    assert.equal(typeof expected, 'number');
});
