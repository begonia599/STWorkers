import assert from 'node:assert/strict';
import test from 'node:test';
import { Documents } from '../src/documents.js';
import { MAX_JSON_BYTES } from '../src/http.js';
import { makeD1, syntheticCardState } from './d1-helper.js';

test('missing documents are explicit, not invented defaults', async t => {
    assert.equal(await new Documents(makeD1(t)).get('chat', 'missing'), null);
});

test('opaque storage preserves synthetic variables, swipes, and unknown fields', async t => {
    const store = new Documents(makeD1(t));
    await store.put('fixture', 'synthetic-card', syntheticCardState);
    const saved = await store.get('fixture', 'synthetic-card');
    assert.deepEqual(saved.value, syntheticCardState);
    assert.equal(saved.revision, 1);
    assert.ok(saved.updatedAt);
});

test('updates increment revisions without merging or losing supplied fields', async t => {
    const store = new Documents(makeD1(t));
    await store.put('settings', 'owner', syntheticCardState);
    const updated = structuredClone(syntheticCardState);
    updated.messages[0].swipe_id = 0;
    updated.chat_metadata.variables.chapter = 4;
    await store.put('settings', 'owner', updated);
    const saved = await store.get('settings', 'owner');
    assert.deepEqual(saved.value, updated);
    assert.equal(saved.revision, 2);
});

test('document IDs and payloads are bound parameters', async t => {
    const store = new Documents(makeD1(t));
    const id = "'; DROP TABLE documents; --";
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"future":1}}');
    await store.put('fixture', id, payload);
    assert.deepEqual((await store.get('fixture', id)).value, payload);
    assert.equal({}.polluted, undefined);
    await store.put('fixture', 'still-present', {});
    assert.deepEqual((await store.get('fixture', 'still-present')).value, {});
});

test('oversized documents fail before being written', async t => {
    const store = new Documents(makeD1(t));
    await assert.rejects(store.put('fixture', 'too-large', { value: 'a'.repeat(MAX_JSON_BYTES) }),
        error => error.status === 413);
    assert.equal(await store.get('fixture', 'too-large'), null);
});

test('missing storage binding fails closed', () => {
    assert.throws(() => new Documents(undefined), error => error.status === 503);
});
