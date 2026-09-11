import assert from 'node:assert/strict';
import test from 'node:test';
import { Documents } from '../src/documents.js';
import { readCardPng, writeCardPng } from '../src/card-png.js';
import { readModelSecret } from '../src/secrets.js';
import { makeD1, syntheticCardState } from './d1-helper.js';
import { cardFixture, defaultPng, harness } from './p1-helper.js';

test('D1 list, compare-and-swap, and conditional deletion use actual SQLite', async t => {
    const store = new Documents(makeD1(t));
    await store.put('test', 'b', { n: 1 }, 0);
    await assert.rejects(store.put('test', 'b', { n: 2 }, 0), { code: 'REVISION_CONFLICT' });
    await store.put('test', 'a', { n: 3 }, 0);
    await store.put('test', 'b', { n: 4 }, 1);
    assert.deepEqual((await store.list('test')).map(row => row.id), ['a', 'b']);
    await assert.rejects(store.remove('test', 'b', 1), { code: 'REVISION_CONFLICT' });
    assert.equal((await store.get('test', 'b')).value.n, 4);
    assert.equal(await store.remove('test', 'b', 2), true);
});

test('boot routes expose ST version, real extension discovery, and persisted stats', async t => {
    const { call } = await harness(t);
    const version = await (await call('/version')).json();
    assert.equal(version.agent.split(':')[1], '1.18.0');
    assert.equal(version.stworks.readyForChat, false);
    assert.deepEqual(await (await call('/api/extensions/discover')).json(), [{ name: 'regex', type: 'system' }]);
    assert.deepEqual(await (await call('/api/avatars/get', {})).json(), ['user-default.png']);
    assert.deepEqual(await (await call('/api/groups/all', {})).json(), []);
    assert.equal((await call('/api/groups/create', {})).status, 501);
    assert.deepEqual(await (await call('/api/image-metadata/all', { prefix: 'backgrounds/' })).json(), { version: 1, images: {} });
    assert.equal((await call('/api/stats/update', { fixture: { unknown: 4 } })).status, 200);
    assert.deepEqual((await (await call('/api/stats/get', {})).json()).fixture, { unknown: 4 });
});

test('preset overlays preserve serialized pairs, restore defaults, and persist tombstones', async t => {
    const { call } = await harness(t);
    const preset = { ...syntheticCardState, name: 'Personal' };
    assert.equal((await call('/api/presets/save', { apiId: 'openai', name: 'Personal', preset })).status, 200);
    assert.equal((await call('/api/presets/delete', { apiId: 'openai', name: 'Default' })).status, 200);
    const settings = await (await call('/api/settings/get', {})).json();
    assert.deepEqual(settings.openai_setting_names, ['Personal']);
    assert.deepEqual(JSON.parse(settings.openai_settings[0]), preset);
    assert.deepEqual(await (await call('/api/presets/restore', { apiId: 'openai', name: 'Default' })).json(),
        { isDefault: true, preset: { name: 'Default', future: true } });
    assert.equal((await call('/api/presets/unknown', { apiId: 'openai', name: 'X', preset })).status, 501);
    assert.equal((await call('/api/presets/save', { apiId: '__proto__', name: 'X', preset })).status, 400);
});

test('worldbook multipart import, edit, list, and reload retain unknown extensions', async t => {
    const { call } = await harness(t);
    const world = { name: 'Display name', entries: { 0: { uid: 0, key: ['x'], content: '{{user}}', future: null } }, extensions: { new: [1] } };
    const form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(world)]), 'Fixture World.json');
    assert.deepEqual(await (await call('/api/worldinfo/import', form)).json(), { name: 'Fixture World' });
    const read = await call('/api/worldinfo/get', { name: 'Fixture World' });
    assert.equal(read.headers.get('ETag'), '"1"');
    assert.deepEqual(await read.json(), world);
    assert.equal((await call('/api/worldinfo/edit', { name: 'Fixture World', data: world }, { 'If-Match': '"0"' })).status, 409);
    assert.deepEqual(await (await call('/api/worldinfo/list', {})).json(),
        [{ file_id: 'Fixture World', name: 'Display name', extensions: world.extensions }]);
    assert.deepEqual((await (await call('/api/settings/get', {})).json()).world_names, ['Fixture World']);
    assert.equal((await call('/api/worldinfo/delete', { name: 'Fixture World' })).status, 200);
    assert.deepEqual(await (await call('/api/worldinfo/get', { name: 'Fixture World' })).json(), { entries: {} });
});

test('quick reply settings actually persist saves and deletions', async t => {
    const { call } = await harness(t);
    const reply = { name: 'Fixture', qrList: [{ message: '/echo hello', extension: null }] };
    assert.equal((await call('/api/quick-replies/save', reply)).status, 200);
    assert.equal((await call('/api/quick-replies/delete', { name: 'Default' })).status, 200);
    assert.deepEqual((await (await call('/api/settings/get', {})).json()).quickReplyPresets, [reply]);
});

test('settings reject a stale explicit revision without replacing unknown fields', async t => {
    const { call } = await harness(t);
    assert.equal((await call('/api/settings/save', syntheticCardState, { 'If-Match': '"0"' })).status, 200);
    assert.equal((await call('/api/settings/save', {}, { 'If-Match': '"0"' })).status, 409);
    assert.deepEqual(JSON.parse((await (await call('/api/settings/get', {})).json()).settings), syntheticCardState);
});

test('JSON card import returns the upstream extensionless filename and preserves V3 data', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    assert.equal(avatar, 'Fixture.png');
    const card = await (await call('/api/characters/get', { avatar_url: avatar })).json();
    assert.equal(card.spec, 'chara_card_v3');
    assert.deepEqual(card.future, cardFixture.future);
    assert.deepEqual(card.data.character_book, cardFixture.data.character_book);
    assert.deepEqual(card.data.extensions.tavern_helper, cardFixture.data.extensions.tavern_helper);
    assert.equal(card.avatar, avatar);
    assert.equal(typeof card.json_data, 'string');
    assert.equal((await call('/characters/Fixture.png')).headers.get('Content-Type'), 'image/png');
});

test('V1 card creation fills core aliases and keeps foreign fields', async t => {
    const { call } = await harness(t);
    const form = new FormData();
    form.append('ch_name', 'Created');
    form.append('description', 'Desc');
    form.append('json_data', JSON.stringify({ future: { a: null } }));
    const created = await call('/api/characters/create', form);
    assert.equal(await created.text(), 'Created.png');
    const card = await (await call('/api/characters/get', { avatar_url: 'Created.png' })).json();
    assert.equal(card.data.description, 'Desc');
    assert.deepEqual(card.future, { a: null });
});

test('form edits keep V3 fields, macros, unknown fields, and alternate greeting arrays', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    const form = new FormData();
    form.append('avatar_url', avatar);
    form.append('ch_name', 'Edited');
    form.append('description', '{{char}} {{user}}');
    form.append('alternate_greetings', 'A');
    form.append('alternate_greetings', 'B');
    assert.equal((await call('/api/characters/edit', form)).status, 200);
    const card = await (await call('/api/characters/export', { avatar_url: avatar, format: 'json' })).json();
    assert.equal(card.name, 'Edited');
    assert.equal(card.spec, 'chara_card_v3');
    assert.equal(card.data.description, '{{char}} {{user}}');
    assert.deepEqual(card.data.alternate_greetings, ['A', 'B']);
    assert.deepEqual(card.future, cardFixture.future);
    assert.equal(card.chat, undefined);
    assert.equal(card.data.extensions.fav, false);
    form.delete('alternate_greetings');
    assert.equal((await call('/api/characters/edit', form)).status, 200);
    const cleared = await (await call('/api/characters/get', { avatar_url: avatar })).json();
    assert.deepEqual(cleared.data.alternate_greetings, []);
});

test('filename sanitization follows the utility used by original worldbook imports', async t => {
    const { call } = await harness(t);
    assert.deepEqual(await (await call('/api/files/sanitize-filename', { fileName: 'A:/B?.json' })).json(), { fileName: 'AB.json' });
    assert.equal((await call('/api/files/sanitize-filename', { fileName: null })).status, 400);
});

test('merge attributes replace arrays, preserve null, and remove only explicit unset sentinels', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    assert.equal((await call('/api/characters/merge-attributes', {
        avatar, data: { extensions: { unknown: [null], keep: null, tavern_helper: '__@@UNSET@@__' } },
        'future.path': '__@@UNSET@@__',
    })).status, 200);
    const card = await (await call('/api/characters/get', { avatar_url: avatar })).json();
    assert.deepEqual(card.data.extensions.unknown, [null]);
    assert.equal(card.data.extensions.keep, null);
    assert.equal(Object.hasOwn(card.data.extensions, 'tavern_helper'), false);
    assert.equal(Object.hasOwn(card, 'future.path'), false);
    const malicious = JSON.parse(`{"avatar":"${avatar}","__proto__":{"polluted":true}}`);
    assert.equal((await call('/api/characters/merge-attributes', malicious)).status, 400);
    assert.equal({}.polluted, undefined);
    assert.equal((await call('/api/characters/merge-attributes', { avatars: [], data: {} })).status, 501);
});

test('PNG codec round-trip and HTTP export/reimport preserve character data', async t => {
    const encoded = writeCardPng(defaultPng, cardFixture);
    assert.deepEqual(readCardPng(encoded).data, cardFixture.data);
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    const png = await call('/api/characters/export', { avatar_url: avatar, format: 'png' });
    assert.equal(png.headers.get('Content-Type'), 'image/png');
    const form = new FormData();
    form.append('avatar', new Blob([await png.arrayBuffer()], { type: 'image/png' }), 'export.png');
    form.append('file_type', 'png');
    const imported = await call('/api/characters/import', form);
    assert.deepEqual(await imported.json(), { file_name: 'Fixture1' });
    const reimport = await (await call('/api/characters/get', { avatar_url: 'Fixture1.png' })).json();
    assert.deepEqual(reimport.future, cardFixture.future);
});

test('invalid card JSON, names, PNG and unprocessed crop do not write documents or files', async t => {
    const { call, env } = await harness(t);
    for (const [path, form] of [
        ['/api/characters/create', { ch_name: 'Test', json_data: '{invalid' }],
        ['/api/characters/create', { ch_name: 'Test', file_name: { invalid: true } }],
        ['/api/characters/create', { ch_name: 'Test', extensions: '{invalid' }],
        ['/api/characters/create?crop={}', { ch_name: 'Test' }],
    ]) {
        const response = await call(path, form);
        assert.ok([400, 422].includes(response.status), await response.text());
    }
    const form = new FormData();
    form.append('avatar', new Blob(['bad png']), 'invalid.png');
    form.append('file_type', 'png');
    assert.equal((await call('/api/characters/import', form)).status, 400);
    assert.equal(env.FILES.objects.size, 0);
    assert.equal((await new Documents(env.DB).list('character')).length, 0);
});

const chatFixture = [
    { user_name: 'User', character_name: 'Fixture', chat_metadata: { ...syntheticCardState.chat_metadata, integrity: 'fixed' }, future_header: null },
    ...syntheticCardState.messages,
];

test('chat snapshots preserve header, swipes, branch variables and unknown fields beyond D1 document limits', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const chat = structuredClone(chatFixture);
    chat[1].mes = 'long '.repeat(230000);
    assert.equal((await call('/api/chats/save', { avatar_url: avatar, file_name: 'Fixture chat', chat })).status, 200);
    const loaded = await call('/api/chats/get', { avatar_url: avatar, file_name: 'Fixture chat' });
    assert.equal(loaded.headers.get('ETag'), '"1"');
    assert.deepEqual(await loaded.json(), chat);
    const pointer = (await new Documents(env.DB).list('chat'))[0];
    assert.ok(pointer.value.bytes > 1024 * 1024);
    assert.ok(JSON.stringify(pointer.value).length < 10000);
    const summary = await (await call('/api/characters/chats', { avatar_url: avatar, metadata: true })).json();
    assert.equal(summary[0].file_name, 'Fixture chat.jsonl');
    assert.deepEqual(summary[0].chat_metadata, chat[0].chat_metadata);
});

test('chat integrity and stale revisions cannot overwrite an existing snapshot', async t => {
    const { call, importCard } = await harness(t);
    const body = { avatar_url: await importCard(), file_name: 'Chat', chat: chatFixture };
    assert.equal((await call('/api/chats/save', body)).status, 200);
    const changed = structuredClone(body);
    changed.chat[0].chat_metadata.integrity = 'other';
    const integrity = await call('/api/chats/save', changed);
    assert.equal(integrity.status, 400);
    assert.deepEqual(await integrity.json(), { error: 'integrity' });
    assert.equal((await call('/api/chats/save', body, { 'If-Match': '"0"' })).status, 409);
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), chatFixture);
    assert.equal((await call('/api/chats/save', { ...changed, force: true })).status, 200);
});

test('R2 failure leaves the existing chat pointer and content intact', async t => {
    const { call, importCard, env } = await harness(t);
    const body = { avatar_url: await importCard(), file_name: 'Chat', chat: chatFixture };
    assert.equal((await call('/api/chats/save', body)).status, 200);
    env.FILES.failPut = true;
    assert.equal((await call('/api/chats/save', body)).status, 500);
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), chatFixture);
    assert.equal((await new Documents(env.DB).list('chat'))[0].revision, 1);
});

test('overlapping chat writes produce one winner and clean up the rejected snapshot', async t => {
    const { call, importCard, env } = await harness(t);
    const body = { avatar_url: await importCard(), file_name: 'Chat', chat: chatFixture };
    await call('/api/chats/save', body);
    const originalPut = env.FILES.put.bind(env.FILES);
    let arrived = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    env.FILES.put = async (...args) => {
        if (++arrived === 2) release();
        await barrier;
        return originalPut(...args);
    };
    const responses = await Promise.all([call('/api/chats/save', body), call('/api/chats/save', body)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(env.FILES.objects.size, 3); // One avatar and two retained snapshots.
});

test('snapshot retention is bounded and failed post-commit cleanup is retried on the next save', async t => {
    const { call, importCard, env } = await harness(t);
    const body = { avatar_url: await importCard(), file_name: 'Chat', chat: chatFixture };
    for (let index = 0; index < 5; index++) assert.equal((await call('/api/chats/save', body)).status, 200);
    assert.equal(env.FILES.objects.size, 3);
    env.FILES.failDelete = true;
    assert.equal((await call('/api/chats/save', body)).status, 200);
    assert.equal(env.FILES.objects.size, 4);
    env.FILES.failDelete = false;
    assert.equal((await call('/api/chats/save', body)).status, 200);
    assert.equal(env.FILES.objects.size, 3);
    assert.equal((await call('/api/chats/delete', body)).status, 200);
    assert.equal(env.FILES.objects.size, 1);
});

test('character deletion keeps chats unless delete_chats is explicitly true', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const body = { avatar_url: avatar, file_name: 'Chat', chat: chatFixture };
    await call('/api/chats/save', body);
    assert.equal((await call('/api/characters/delete', { avatar_url: avatar })).status, 200);
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), chatFixture);
    assert.equal((await new Documents(env.DB).list('chat')).length, 1);
    assert.equal(await importCard(), avatar);
    assert.equal((await call('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).status, 200);
    assert.equal((await new Documents(env.DB).list('chat')).length, 0);
    assert.equal(env.FILES.objects.size, 0);
});

test('model secrets are encrypted at rest, masked on read, rotatable, and delete only the active entry by default', async t => {
    const { call, env } = await harness(t);
    const first = await (await call('/api/secrets/write', { key: 'api_key_openai', value: 'synthetic-secret-A', label: 'One' })).json();
    const second = await (await call('/api/secrets/write', { key: 'api_key_openai', value: 'synthetic-secret-B' })).json();
    const row = await new Documents(env.DB).get('secrets', 'api_key_openai');
    assert.doesNotMatch(JSON.stringify(row), /synthetic-secret/);
    const state = await (await call('/api/secrets/read', {})).json();
    assert.doesNotMatch(JSON.stringify(state), /synthetic-secret/);
    for (const entry of state.api_key_openai) {
        assert.equal(Object.hasOwn(entry, 'cipher'), false);
        assert.equal(Object.hasOwn(entry, 'iv'), false);
    }
    assert.equal(state.api_key_openai[1].active, true);
    assert.equal(await readModelSecret(env, 'api_key_openai'), 'synthetic-secret-B');
    assert.equal((await call('/api/secrets/rotate', { key: 'api_key_openai', id: first.id })).status, 204);
    assert.equal(await readModelSecret(env, 'api_key_openai'), 'synthetic-secret-A');
    assert.equal((await call('/api/secrets/rename', { key: 'api_key_openai', id: second.id, label: 'Other' })).status, 204);
    assert.equal((await call('/api/secrets/delete', { key: 'api_key_openai' })).status, 204);
    assert.equal(await readModelSecret(env, 'api_key_openai'), 'synthetic-secret-B');
    assert.equal((await call('/api/secrets/find', { key: 'api_key_openai' })).status, 403);
    assert.equal((await call('/api/secrets/view', {})).status, 403);
});

test('invalid data encryption key never stores plaintext and auth rotation does not lose encrypted data', async t => {
    const { call, env } = await harness(t);
    const key = env.DATA_KEY;
    env.DATA_KEY = 'invalid';
    assert.equal((await call('/api/secrets/write', { key: 'api_key_openai', value: 'secret' })).status, 503);
    assert.equal((await new Documents(env.DB).list('secrets')).length, 0);
    env.DATA_KEY = key;
    await call('/api/secrets/write', { key: 'api_key_openai', value: 'secret' });
    env.AUTH_PASSWORD = 'different-owner-password-still-long-enough';
    assert.equal(await readModelSecret(env, 'api_key_openai'), 'secret');
});
