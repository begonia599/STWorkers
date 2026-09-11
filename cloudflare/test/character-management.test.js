import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'crc';
import { Documents } from '../src/documents.js';
import { writeCardPng } from '../src/card-png.js';
import { validateAvatarPng } from '../src/avatars.js';
import { avatarGeometry } from '../../public/scripts/stworks-avatar.js';
import { cardFixture, defaultPng, harness } from './p1-helper.js';

const image = writeCardPng(defaultPng, { data: { name: 'Image fixture only' } });
const chat = [
    { user_name: 'User', chat_metadata: { variables: { count: 3 }, unknown: [null, false] }, future_header: 7 },
    { name: 'Fixture', is_user: false, mes: 'Chosen', swipes: ['First', 'Chosen'], swipe_id: 1,
        swipe_info: [{ extra: { score: 1 } }, { extra: { score: 4 } }], extra: { future: true } },
];
const chatKey = (avatar, file) => JSON.stringify([avatar, file]);
function upload(fields = {}, bytes = image) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (bytes !== null) form.append('avatar', new Blob([bytes], { type: 'image/png' }), 'avatar.png');
    return form;
}
function replacement(avatar, card = cardFixture) {
    return upload({ preserved_name: avatar, file_type: 'json' }, JSON.stringify(card));
}
async function saved(t) {
    const setup = await harness(t);
    const avatar = await setup.importCard();
    const body = { avatar_url: avatar, file_name: 'Original', chat };
    assert.equal((await setup.call('/api/chats/save', body)).status, 200);
    return { ...setup, avatar, body, store: new Documents(setup.env.DB) };
}
function pauseUpload(env) {
    const put = env.FILES.put.bind(env.FILES);
    let arrive, release;
    const arrived = new Promise(resolve => { arrive = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    env.FILES.put = async (...args) => {
        arrive();
        await barrier;
        return put(...args);
    };
    return { arrived, release: () => release() };
}

test('browser geometry keeps original dimensions, validates crops and matches upstream cover size', () => {
    assert.deepEqual(avatarGeometry(800, 600), { x: 0, y: 0, width: 800, height: 600, outputWidth: 800, outputHeight: 600 });
    assert.deepEqual(avatarGeometry(800, 600, { x: 100, y: 0, width: 400, height: 600, want_resize: true }),
        { x: 100, y: 0, width: 400, height: 600, outputWidth: 512, outputHeight: 768 });
    assert.equal(avatarGeometry(800, 600, { x: 10.2, y: 10.1, width: 200.3, height: 300.3 }).outputWidth, 200);
    for (const crop of [null, {}, { x: NaN, y: 0, width: 10, height: 10 },
        { x: -1, y: 0, width: 10, height: 10 }, { x: 790, y: 0, width: 11, height: 10 },
        { x: 0, y: 0, width: 0, height: 10 }]) {
        assert.throws(() => avatarGeometry(800, 600, crop));
    }
    assert.throws(() => avatarGeometry(8193, 1));
    assert.throws(() => avatarGeometry(5000, 5000));
});

test('avatar validation rejects non-PNG and oversized pixel headers before storage', () => {
    validateAvatarPng(defaultPng);
    assert.throws(() => validateAvatarPng(new Uint8Array([0, 1, 2])), { code: 'INVALID_PNG' });
    const oversized = Buffer.from(defaultPng);
    oversized.writeUInt32BE(8193, 16);
    oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
    assert.throws(() => validateAvatarPng(oversized), { code: 'AVATAR_DIMENSIONS_EXCEEDED' });
});

test('persona upload, replacement, authenticated images, thumbnail and deletion use the same stored bytes', async t => {
    const { call, env } = await harness(t);
    const response = await call('/api/avatars/upload', upload());
    assert.equal(response.status, 200);
    const { path } = await response.json();
    assert.match(path, /^[\da-f-]+\.png$/);
    assert.ok((await (await call('/api/avatars/get', {})).json()).includes(path));
    const url = `/User%20Avatars/${encodeURIComponent(path)}`;
    assert.deepEqual(Buffer.from(await (await call(url)).arrayBuffer()), Buffer.from(image));
    assert.deepEqual(Buffer.from(await (await call(`/thumbnail?type=persona&file=${encodeURIComponent(path)}`)).arrayBuffer()), Buffer.from(image));
    assert.equal((await call(url, undefined, { Authorization: '' })).status, 401);
    const overwritten = await call('/api/avatars/upload', upload({ overwrite_name: path }, defaultPng));
    assert.deepEqual(await overwritten.json(), { path });
    assert.deepEqual(Buffer.from(await (await call(url)).arrayBuffer()), defaultPng);
    assert.equal(env.FILES.objects.size, 1);
    assert.deepEqual(await (await call('/api/avatars/delete', { avatar: path })).json(), { result: 'ok' });
    assert.equal((await call(url)).status, 404);
    assert.equal(env.FILES.objects.size, 0);
    assert.deepEqual(await (await call('/api/avatars/get', {})).json(), ['user-default.png']);
});

test('default persona supports replacement and a deletion tombstone without exposing the static fallback', async t => {
    const { call } = await harness(t);
    const path = '/User%20Avatars/user-default.png';
    assert.equal((await call(path)).status, 200);
    assert.equal((await call('/api/avatars/delete', { avatar: 'user-default.png' })).status, 200);
    assert.deepEqual(await (await call('/api/avatars/get', {})).json(), []);
    assert.equal((await call(path)).status, 404);
    assert.equal((await call('/thumbnail?type=persona&file=user-default.png')).status, 404);
    assert.equal((await call('/api/avatars/upload', upload({ overwrite_name: 'user-default.png' }))).status, 200);
    assert.equal((await call(path)).status, 200);
});

test('avatar endpoints reject missing images, unprocessed crops, invalid paths, stale revisions and wrong methods', async t => {
    const { call, env } = await harness(t);
    for (const [path, form, status] of [
        ['/api/avatars/upload', upload({}, null), 400],
        ['/api/avatars/upload', upload({}, 'not PNG'), 400],
        ['/api/avatars/upload?crop={}', upload(), 422],
        ['/api/avatars/upload', upload({ overwrite_name: '../bad.png' }), 400],
        ['/api/avatars/delete', { avatar: 'missing.png' }, 404],
    ]) assert.equal((await call(path, form)).status, status);
    assert.equal((await call('/User%20Avatars/nested/user-default.png')).status, 400);
    assert.equal((await call('/api/avatars/upload')).status, 405);
    assert.equal(env.FILES.objects.size, 0);
    const form = upload({ overwrite_name: 'Known.png' });
    assert.equal((await call('/api/avatars/upload', form)).status, 200);
    assert.equal((await call('/api/avatars/upload', upload({ overwrite_name: 'Known.png' }), { 'If-Match': '"0"' })).status, 409);
    assert.equal((await call('/api/avatars/delete', { avatar: 'Known.png' }, { 'If-Match': '"0"' })).status, 409);
    assert.equal(env.FILES.objects.size, 1);
});

test('new character and persona mutation routes require authentication, CSRF and same origin', async t => {
    const { call } = await harness(t);
    for (const path of ['/api/avatars/upload', '/api/avatars/delete', '/api/characters/edit-avatar', '/api/characters/rename']) {
        assert.equal((await call(path, {}, { Authorization: '' })).status, 401);
        assert.equal((await call(path, {}, { 'X-CSRF-Token': '' })).status, 403);
        assert.equal((await call(path, {}, { Origin: 'https://foreign.example' })).status, 403);
    }
});

test('persona R2 failures and a competing deletion leave the winning state intact', async t => {
    const { call, env } = await harness(t);
    const fields = { overwrite_name: 'Known.png' };
    assert.equal((await call('/api/avatars/upload', upload(fields))).status, 200);
    env.FILES.failPut = true;
    assert.equal((await call('/api/avatars/upload', upload(fields, defaultPng))).status, 500);
    env.FILES.failPut = false;
    const pending = pauseUpload(env);
    const first = call('/api/avatars/upload', upload(fields, defaultPng));
    await pending.arrived;
    assert.equal((await call('/api/avatars/delete', { avatar: fields.overwrite_name })).status, 200);
    pending.release();
    assert.equal((await first).status, 409);
    assert.equal((await call('/User%20Avatars/Known.png')).status, 404);
    assert.equal(env.FILES.objects.size, 0);
});

test('post-commit persona cleanup failures are retained for the next replacement to retry', async t => {
    const { call, env } = await harness(t);
    const fields = { overwrite_name: 'Known.png' };
    await call('/api/avatars/upload', upload(fields));
    env.FILES.failDelete = true;
    assert.equal((await call('/api/avatars/upload', upload(fields, defaultPng))).status, 200);
    assert.equal(env.FILES.objects.size, 2);
    env.FILES.failDelete = false;
    assert.equal((await call('/api/avatars/upload', upload(fields))).status, 200);
    assert.equal(env.FILES.objects.size, 1);
});

test('character avatar-only replacement leaves the card, active chat and all extension fields untouched', async t => {
    const { call, env, avatar, body, store } = await saved(t);
    const before = await store.get('character', avatar);
    const chatBefore = await store.get('chat', chatKey(avatar, body.file_name));
    assert.equal((await call('/api/characters/edit-avatar', upload({ avatar_url: avatar }))).status, 200);
    const after = await store.get('character', avatar);
    assert.deepEqual(after.value.card, before.value.card);
    assert.equal(after.value.createdAt, before.value.createdAt);
    assert.notEqual(after.value.imageKey, before.value.imageKey);
    assert.deepEqual(await store.get('chat', chatBefore.id), chatBefore);
    assert.equal(env.FILES.objects.size, 2);
    assert.equal((await call('/api/characters/edit-avatar', upload({ avatar_url: avatar }, null))).status, 400);
});

test('form editing can atomically change both card fields and the avatar', async t => {
    const { call, avatar, store } = await saved(t);
    const form = upload({ avatar_url: avatar, ch_name: 'Fixture', description: 'Updated {{char}}', alternate_greetings: 'Alternate' });
    assert.equal((await call('/api/characters/edit', form)).status, 200);
    const row = await store.get('character', avatar);
    assert.equal(row.value.card.data.description, 'Updated {{char}}');
    assert.deepEqual(row.value.card.future, cardFixture.future);
    assert.deepEqual(row.value.card.data.extensions.tavern_helper, cardFixture.data.extensions.tavern_helper);
    assert.deepEqual(Buffer.from(await (await call(`/characters/${avatar}`)).arrayBuffer()), Buffer.from(image));
});

test('avatar replacement failure leaves the old image and card unchanged', async t => {
    const { call, avatar, env, store } = await saved(t);
    const before = await store.get('character', avatar);
    env.FILES.failPut = true;
    assert.equal((await call('/api/characters/edit', upload({ avatar_url: avatar, description: 'Must not save' }))).status, 500);
    assert.deepEqual(await store.get('character', avatar), before);
    env.FILES.failPut = false;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = sql => {
        if (sql.startsWith('UPDATE documents SET payload')) throw new Error('Synthetic commit failure');
        return prepare(sql);
    };
    assert.equal((await call('/api/characters/edit-avatar', upload({ avatar_url: avatar }))).status, 500);
    env.DB.prepare = prepare;
    assert.deepEqual(await store.get('character', avatar), before);
    assert.equal(env.FILES.objects.size, 2);
});

test('overwrite import replaces card data but preserves filename, creation date, active chat and all snapshots', async t => {
    const { call, avatar, store, body, env } = await saved(t);
    const before = await store.get('character', avatar);
    const chats = await store.list('chat');
    const card = { data: { name: 'Replacement', first_mes: 'New greeting', extensions: { replacement: [null, false] } }, future: { next: true } };
    const response = await call('/api/characters/import', replacement(avatar, card));
    assert.deepEqual(await response.json(), { file_name: avatar.slice(0, -4) });
    const after = await store.get('character', avatar);
    assert.equal(after.value.card.name, 'Replacement');
    assert.equal(after.value.card.chat, before.value.card.chat);
    assert.equal(after.value.card.create_date, before.value.card.create_date);
    assert.equal(after.value.createdAt, before.value.createdAt);
    assert.deepEqual(after.value.card.future, card.future);
    assert.equal(after.value.card.data.extensions.tavern_helper, undefined);
    assert.deepEqual(await store.list('chat'), chats);
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), chat);
    assert.equal(env.FILES.objects.size, 2);
    assert.equal((await call('/api/characters/import', replacement(avatar), { 'If-Match': '"1"' })).status, 409);
});

test('ordinary imports never overwrite existing cards and preserved-name PNG imports keep new metadata and pixels', async t => {
    const { call, importCard, avatar, store } = await saved(t);
    assert.equal(await importCard(), 'Fixture1.png');
    const png = writeCardPng(defaultPng, { ...cardFixture, future: { replacement: true } });
    const form = upload({ preserved_name: avatar, file_type: 'png' }, png);
    assert.equal((await call('/api/characters/import', form)).status, 200);
    assert.deepEqual((await store.get('character', avatar)).value.card.future, { replacement: true });
    assert.deepEqual(Buffer.from(await (await call(`/characters/${avatar}`)).arrayBuffer()), Buffer.from(png));
});

test('character rename atomically moves every chat index without reading, copying or deleting R2 objects', async t => {
    const { call, env, avatar, store, body } = await saved(t);
    await call('/api/chats/save', body);
    await call('/api/chats/save', { ...body, file_name: 'Second' });
    const before = await store.get('character', avatar);
    const chats = await store.list('chat');
    const objects = [...env.FILES.objects.keys()];
    env.FILES.failPut = env.FILES.failDelete = true;
    const response = await call('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' });
    assert.deepEqual(await response.json(), { avatar: 'Renamed.png' });
    assert.equal(await store.get('character', avatar), null);
    const after = await store.get('character', 'Renamed.png');
    assert.equal(after.value.imageKey, before.value.imageKey);
    assert.equal(after.value.card.chat, before.value.card.chat);
    assert.deepEqual(after.value.card.future, cardFixture.future);
    assert.equal(after.value.card.name, 'Renamed');
    assert.equal(after.value.card.data.name, 'Renamed');
    for (const previous of chats) {
        const moved = await store.get('chat', chatKey('Renamed.png', previous.value.file));
        assert.deepEqual(moved.value, { ...previous.value, avatar: 'Renamed.png' });
        assert.equal(moved.revision, previous.revision + 1);
        assert.equal(moved.updatedAt, previous.updatedAt);
        assert.deepEqual(await (await call('/api/chats/get', { avatar_url: 'Renamed.png', file_name: moved.value.file })).json(), chat);
    }
    assert.deepEqual([...env.FILES.objects.keys()], objects);
});

test('character rename rejects stale revisions, invalid names and missing sources; occupied character names get a suffix', async t => {
    const { call, avatar, importCard } = await saved(t);
    const body = { avatar_url: avatar, new_name: 'Other' };
    assert.equal((await call('/api/characters/rename', body, { 'If-Match': '"0"' })).status, 409);
    assert.equal((await call('/api/characters/rename', { ...body, new_name: '' })).status, 400);
    assert.equal((await call('/api/characters/rename', { ...body, avatar_url: 'Missing.png' })).status, 404);
    assert.deepEqual(await (await call('/api/characters/rename', { ...body, new_name: 'Fixture' })).json(), { avatar });
    await importCard({ data: { name: 'Other' } });
    assert.deepEqual(await (await call('/api/characters/rename', body)).json(), { avatar: 'Other1.png' });
});

test('rename refuses orphan destination chats and rolls back all character and chat changes', async t => {
    const { call, avatar, importCard, body, store } = await saved(t);
    const other = await importCard({ data: { name: 'Destination' } });
    await call('/api/chats/save', { ...body, avatar_url: other, file_name: 'Unrelated' });
    await call('/api/characters/delete', { avatar_url: other });
    const cards = await store.list('character'), chats = await store.list('chat');
    const response = await call('/api/characters/rename', { avatar_url: avatar, new_name: 'Destination' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'CHAT_DESTINATION_CONFLICT');
    assert.deepEqual(await store.list('character'), cards);
    assert.deepEqual(await store.list('chat'), chats);
});

test('new and existing chat saves already uploading cannot recreate a renamed character namespace', async t => {
    for (const file of ['Original', 'New']) {
        const { call, avatar, body, env, store } = await saved(t);
        const pending = pauseUpload(env);
        const saving = call('/api/chats/save', { ...body, file_name: file });
        await pending.arrived;
        assert.equal((await call('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' })).status, 200);
        pending.release();
        assert.equal((await saving).status, 409);
        assert.equal(await store.get('chat', chatKey(avatar, file)), null);
        assert.deepEqual(await (await call('/api/chats/get', { ...body, avatar_url: 'Renamed.png' })).json(), chat);
        assert.equal(env.FILES.objects.size, 2);
    }
});

test('avatar upload already in flight loses cleanly to a character rename', async t => {
    const { call, env, avatar, store } = await saved(t);
    const before = await store.get('character', avatar);
    const pending = pauseUpload(env);
    const editing = call('/api/characters/edit-avatar', upload({ avatar_url: avatar }));
    await pending.arrived;
    assert.equal((await call('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' })).status, 200);
    pending.release();
    assert.equal((await editing).status, 409);
    assert.equal((await store.get('character', 'Renamed.png')).value.imageKey, before.value.imageKey);
    assert.equal(env.FILES.objects.size, 2);
});

test('the D1 test adapter includes cascade writes in mutation metadata', async t => {
    const { env, avatar, store } = await saved(t);
    const result = await env.DB.prepare("UPDATE documents SET id = ? WHERE kind = 'character' AND id = ?")
        .bind('Renamed.png', avatar).run();
    assert.equal(result.meta.changes, 2);
    assert.ok(await store.get('chat', chatKey('Renamed.png', 'Original')));
});

test('failed or overlapping replacement-card imports cannot detach the existing image and chats', async t => {
    const { call, env, avatar, store } = await saved(t);
    const before = await store.get('character', avatar);
    env.FILES.failPut = true;
    assert.equal((await call('/api/characters/import', replacement(avatar))).status, 500);
    assert.deepEqual(await store.get('character', avatar), before);
    env.FILES.failPut = false;
    const pending = pauseUpload(env);
    const replacing = call('/api/characters/import', replacement(avatar));
    await pending.arrived;
    assert.equal((await call('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' })).status, 200);
    pending.release();
    assert.equal((await replacing).status, 409);
    assert.equal((await store.get('character', 'Renamed.png')).value.imageKey, before.value.imageKey);
    assert.equal(env.FILES.objects.size, 2);
});

test('two concurrent persona replacements have only one winner and clean the rejected image', async t => {
    const { call, env } = await harness(t);
    const fields = { overwrite_name: 'Known.png' };
    await call('/api/avatars/upload', upload(fields));
    const put = env.FILES.put.bind(env.FILES);
    let arrived = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    env.FILES.put = async (...args) => {
        if (++arrived === 2) release();
        await barrier;
        return put(...args);
    };
    const responses = await Promise.all([
        call('/api/avatars/upload', upload(fields, defaultPng)),
        call('/api/avatars/upload', upload(fields, defaultPng)),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(env.FILES.objects.size, 1);
});
