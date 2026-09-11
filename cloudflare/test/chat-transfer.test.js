import assert from 'node:assert/strict';
import test from 'node:test';
import { Documents } from '../src/documents.js';
import { MAX_CHAT_BYTES, MAX_UPLOAD_BYTES } from '../src/input.js';
import { MAX_CHAT_SEARCH_BYTES, MAX_CHAT_SEARCH_FILES } from '../src/chats.js';
import { makeD1, syntheticCardState } from './d1-helper.js';
import { harness } from './p1-helper.js';

const chatFixture = [
    {
        user_name: 'User', character_name: 'Fixture', create_date: '2026-09-08T00:00:00.000Z',
        chat_metadata: { ...syntheticCardState.chat_metadata, integrity: 'transfer-test' },
        future_header: { nullable: null, list: [false, 7] },
    },
    { name: 'User', is_user: true, mes: 'First question.', send_date: '2026-09-08T00:01:00.000Z' },
    {
        ...syntheticCardState.messages[0], send_date: '2026-09-08T00:02:00.000Z',
        swipe_info: [{ extra: { variables: { branch: 0 } } }, { extra: { variables: { branch: 1 } } }],
        future_message: { keep: true },
    },
];
const encode = chat => chat.map(message => JSON.stringify(message)).join('\n');
const key = (avatar, file) => JSON.stringify([avatar, file]);
const renameBody = (avatar, original = 'Original', destination = 'Renamed') => ({
    avatar_url: avatar, original_file: `${original}.jsonl`, renamed_file: `${destination}.jsonl`, is_group: false,
});

function importForm(avatar, content = encode(chatFixture), type = 'jsonl') {
    const form = new FormData();
    form.append('avatar_url', avatar);
    form.append('character_name', 'Ignored client name');
    form.append('user_name', 'User');
    form.append('file_type', type);
    form.append('avatar', new Blob([content], { type: 'application/x-ndjson' }), 'import.jsonl');
    return form;
}

async function savedChat(t) {
    const setup = await harness(t);
    const avatar = await setup.importCard();
    const body = { avatar_url: avatar, file_name: 'Original', chat: chatFixture };
    assert.equal((await setup.call('/api/chats/save', body)).status, 200);
    return { ...setup, avatar, body, store: new Documents(setup.env.DB) };
}

test('document rename atomically moves a revision-guarded row without overwriting the destination', async t => {
    const store = new Documents(makeD1(t));
    await store.put('chat', 'source', { unknown: [null, false] }, 0);
    await store.put('chat', 'occupied', { keep: true }, 0);
    await assert.rejects(store.rename('chat', 'source', 'occupied', {}, 1), { code: 'REVISION_CONFLICT' });
    await assert.rejects(store.rename('chat', 'source', 'destination', {}, 2), { code: 'REVISION_CONFLICT' });
    const before = await store.get('chat', 'source');
    await store.rename('chat', 'source', 'destination', before.value, before.revision);
    assert.equal(await store.get('chat', 'source'), null);
    const after = await store.get('chat', 'destination');
    assert.deepEqual(after.value, before.value);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.deepEqual((await store.get('chat', 'occupied')).value, { keep: true });
});

test('document rename enforces the same document size limit as save', async t => {
    const store = new Documents(makeD1(t));
    await store.put('chat', 'source', { keep: true }, 0);
    await assert.rejects(store.rename('chat', 'source', 'destination', { big: 'x'.repeat(1024 * 1024) }, 1),
        { code: 'PAYLOAD_TOO_LARGE' });
    assert.deepEqual((await store.get('chat', 'source')).value, { keep: true });
    assert.equal(await store.get('chat', 'destination'), null);
});

test('native JSONL import preserves header, metadata, messages, swipes and unknown fields through export', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const imported = await call('/api/chats/import', importForm(avatar));
    assert.equal(imported.status, 200);
    const result = await imported.json();
    assert.equal(result.res, true);
    assert.equal(result.fileNames.length, 1);
    assert.match(result.fileNames[0], /^Fixture - .* imported\.jsonl$/);
    const body = { avatar_url: avatar, file_name: result.fileNames[0] };
    const loaded = await call('/api/chats/get', body);
    assert.equal(loaded.headers.get('ETag'), '"1"');
    assert.deepEqual(await loaded.json(), chatFixture);
    const exported = await (await call('/api/chats/export', { ...body, format: 'jsonl' })).json();
    assert.deepEqual(exported.result.split('\n').map(JSON.parse), chatFixture);
    const list = await (await call('/api/characters/chats', { avatar_url: avatar, metadata: true })).json();
    assert.equal(list[0].file_name, result.fileNames[0]);
    assert.equal(list[0].chat_items, 2);
    assert.equal(list[0].last_mes, chatFixture[2].send_date);
    assert.deepEqual(list[0].chat_metadata, chatFixture[0].chat_metadata);
    assert.equal(env.FILES.objects.size, 2);
});

test('repeated imports get independent names without overwriting earlier chats', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    const responses = await Promise.all([
        call('/api/chats/import', importForm(avatar)), call('/api/chats/import', importForm(avatar)),
    ]);
    const names = await Promise.all(responses.map(async response => (await response.json()).fileNames[0]));
    assert.equal(new Set(names).size, 2);
    for (const file_name of names) {
        assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name })).json(), chatFixture);
    }
});

test('an upstream-style header rewrite retains omitted extension fields without restoring replaced metadata', async t => {
    const { call, avatar, body } = await savedChat(t);
    const chat = [
        { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'transfer-test', variables: { chapter: 9 } } },
        ...chatFixture.slice(1),
    ];
    assert.equal((await call('/api/chats/save', { ...body, chat })).status, 200);
    const saved = await (await call('/api/chats/get', { avatar_url: avatar, file_name: 'Original' })).json();
    assert.deepEqual(saved[0].future_header, chatFixture[0].future_header);
    assert.equal(saved[0].create_date, chatFixture[0].create_date);
    assert.deepEqual(saved[0].chat_metadata, chat[0].chat_metadata);
    assert.equal(saved[0].user_name, 'unused');
    chat[0].future_header = null;
    assert.equal((await call('/api/chats/save', { ...body, chat })).status, 200);
    assert.equal((await (await call('/api/chats/get', body)).json())[0].future_header, null);
});

test('JSONL import accepts UTF-8 BOM, CRLF, trailing newline, blank lines and a header-only chat', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    for (const chat of [chatFixture, [chatFixture[0]]]) {
        const content = '\ufeff' + chat.map(JSON.stringify).join('\r\n\r\n') + '\r\n';
        const response = await call('/api/chats/import', importForm(avatar, content));
        assert.equal(response.status, 200);
        const file_name = (await response.json()).fileNames[0];
        assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name })).json(), chat);
    }
});

test('invalid JSONL and non-native chat shapes fail before any chat objects or indexes are written', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const store = new Documents(env.DB);
    const invalid = [
        '', '\n\n', 'null', '[]', '{}', '{"messages":[]}', '{"name":"first message","mes":"Do not drop me"}',
        encode([chatFixture[0]]) + '\n{broken',
        encode([chatFixture[0]]) + '\n[]',
        encode([chatFixture[0], { name: 'Fixture', mes: { nested: true } }]),
        encode([{ chat_metadata: [] }]),
        new Uint8Array([0xc3, 0x28]),
    ];
    for (const content of invalid) {
        const response = await call('/api/chats/import', importForm(avatar, content));
        assert.equal(response.status, 400);
        assert.equal((await store.list('chat')).length, 0);
        assert.equal(env.FILES.objects.size, 1);
    }
});

test('chat import rejects unsupported formats, missing files, missing characters and group imports', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    assert.equal((await call('/api/chats/import', {})).status, 415);
    assert.equal((await call('/api/chats/import', importForm(avatar, '{}', 'json'))).status, 415);
    assert.equal((await call('/api/chats/import', importForm('Missing.png'))).status, 404);
    assert.equal((await call('/api/chats/import', importForm('../escape.png'))).status, 400);
    const form = importForm(avatar);
    form.delete('avatar');
    assert.equal((await call('/api/chats/import', form)).status, 400);
    form.append('avatar', 'not-a-file');
    assert.equal((await call('/api/chats/import', form)).status, 400);
    form.set('is_group', 'true');
    assert.equal((await call('/api/chats/import', form)).status, 501);
    assert.equal((await new Documents(env.DB).list('chat')).length, 0);
});

test('chat multipart import supports files over the image upload limit and bounds the whole streamed request', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const chat = structuredClone(chatFixture);
    chat[2].mes = 'x'.repeat(MAX_UPLOAD_BYTES + 128);
    const imported = await call('/api/chats/import', importForm(avatar, encode(chat)));
    assert.equal(imported.status, 200);
    const file_name = (await imported.json()).fileNames[0];
    assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name })).json(), chat);
    const tooLarge = await call('/api/chats/import', importForm(avatar, 'x'.repeat(MAX_CHAT_BYTES)));
    assert.equal(tooLarge.status, 413);
    assert.equal((await new Documents(env.DB).list('chat')).length, 1);
    assert.equal(env.FILES.objects.size, 2);
});

test('carrying forward omitted header fields cannot grow a saved snapshot beyond its limit', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    const original = structuredClone(chatFixture);
    original[0].large_header = 'x'.repeat(9 * 1024 * 1024);
    const body = { avatar_url: avatar, file_name: 'Large header', chat: original };
    assert.equal((await call('/api/chats/save', body)).status, 200);
    const objects = [...env.FILES.objects.keys()];
    const updated = structuredClone(chatFixture);
    updated[2].mes = 'y'.repeat(8 * 1024 * 1024);
    assert.equal((await call('/api/chats/save', { ...body, chat: updated })).status, 413);
    assert.deepEqual([...env.FILES.objects.keys()], objects);
    assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name: body.file_name })).json(), original);
});

test('new chat routes retain authentication, CSRF, origin and method protections', async t => {
    const { call, importCard } = await harness(t);
    const avatar = await importCard();
    for (const path of ['/api/chats/import', '/api/chats/rename', '/api/chats/search']) {
        const body = path.endsWith('/import') ? importForm(avatar) : renameBody(avatar);
        assert.equal((await call(path, body, { Cookie: '' })).status, 401);
        assert.equal((await call(path, body, { 'X-CSRF-Token': '' })).status, 403);
        assert.equal((await call(path, body, { Origin: 'https://foreign.example' })).status, 403);
        assert.equal((await call(path)).status, 405);
    }
});

test('failed R2 import and failed D1 commit do not leave a committed chat or a newly uploaded snapshot', async t => {
    const { call, importCard, env } = await harness(t);
    const avatar = await importCard();
    env.FILES.failPut = true;
    assert.equal((await call('/api/chats/import', importForm(avatar))).status, 500);
    env.FILES.failPut = false;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = sql => {
        if (sql.startsWith('INSERT INTO documents')) throw new Error('Synthetic index write failure');
        return prepare(sql);
    };
    assert.equal((await call('/api/chats/import', importForm(avatar))).status, 500);
    env.DB.prepare = prepare;
    assert.equal((await new Documents(env.DB).list('chat')).length, 0);
    assert.equal(env.FILES.objects.size, 1);
});

test('rename returns the upstream sanitizedFileName contract and retains snapshots without copying R2 objects', async t => {
    const { call, env, store, avatar, body } = await savedChat(t);
    await call('/api/chats/save', body);
    const before = await store.get('chat', key(avatar, 'Original'));
    const objects = [...env.FILES.objects.keys()];
    env.FILES.failPut = true;
    env.FILES.failDelete = true;
    const renamed = await call('/api/chats/rename', renameBody(avatar, 'Original', 'Renamed? Chat'), { 'If-Match': '"2"' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { ok: true, sanitizedFileName: 'Renamed Chat' });
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), []);
    const after = await store.get('chat', key(avatar, 'Renamed Chat'));
    assert.deepEqual(after.value, { ...before.value, file: 'Renamed Chat' });
    assert.equal(after.revision, 3);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.deepEqual([...env.FILES.objects.keys()], objects);
    assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name: 'Renamed Chat.jsonl' })).json(), chatFixture);
});

test('rename rejects occupied destinations and stale revisions without changing either chat', async t => {
    const { call, env, store, avatar, body } = await savedChat(t);
    await call('/api/chats/save', { ...body, file_name: 'Occupied', chat: [chatFixture[0]] });
    const before = await store.list('chat');
    const objects = [...env.FILES.objects.keys()];
    assert.equal((await call('/api/chats/rename', renameBody(avatar), { 'If-Match': '"0"' })).status, 409);
    assert.equal((await call('/api/chats/rename', renameBody(avatar, 'Original', 'Occupied'))).status, 409);
    assert.deepEqual(await store.list('chat'), before);
    assert.deepEqual([...env.FILES.objects.keys()], objects);
});

test('rename validates names, source existence and group boundaries; same name is a harmless no-op', async t => {
    const { call, avatar, store } = await savedChat(t);
    assert.equal((await call('/api/chats/rename', renameBody(avatar, 'Missing'))).status, 404);
    assert.equal((await call('/api/chats/rename', renameBody(avatar, '../Original'))).status, 400);
    assert.equal((await call('/api/chats/rename', { ...renameBody(avatar), renamed_file: 7 })).status, 400);
    assert.equal((await call('/api/chats/rename', { ...renameBody(avatar), renamed_file: '.jsonl' })).status, 400);
    assert.equal((await call('/api/chats/rename', { ...renameBody(avatar), is_group: true })).status, 501);
    assert.equal((await call('/api/chats/rename', renameBody(avatar, 'Original', 'Original'))).status, 200);
    assert.equal((await store.get('chat', key(avatar, 'Original'))).revision, 1);
});

test('two overlapping renames have one winner and cannot create multiple owners of a snapshot', async t => {
    const { call, env, avatar, store } = await savedChat(t);
    const prepare = env.DB.prepare.bind(env.DB);
    let arrived = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    env.DB.prepare = sql => {
        if (!sql.includes('UPDATE documents SET id = ?')) return prepare(sql);
        return {
            bind(...values) {
                return { async run() {
                    if (++arrived === 2) release();
                    await barrier;
                    return prepare(sql).bind(...values).run();
                } };
            },
        };
    };
    const responses = await Promise.all([
        call('/api/chats/rename', renameBody(avatar, 'Original', 'One')),
        call('/api/chats/rename', renameBody(avatar, 'Original', 'Two')),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await store.list('chat')).length, 1);
    assert.equal(env.FILES.objects.size, 2);
});

test('a save already uploading when rename commits cannot recreate the old name or damage the moved snapshot', async t => {
    const { call, env, avatar, body } = await savedChat(t);
    const put = env.FILES.put.bind(env.FILES);
    let arrive;
    let release;
    const arrived = new Promise(resolve => { arrive = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    env.FILES.put = async (...args) => {
        arrive();
        await barrier;
        return put(...args);
    };
    const saving = call('/api/chats/save', body);
    await arrived;
    assert.equal((await call('/api/chats/rename', renameBody(avatar))).status, 200);
    release();
    assert.equal((await saving).status, 409);
    assert.deepEqual(await (await call('/api/chats/get', body)).json(), []);
    assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name: 'Renamed' })).json(), chatFixture);
    assert.equal(env.FILES.objects.size, 2);
});

test('an overlapping old-name delete cannot remove the renamed snapshot', async t => {
    const { call, env, avatar, body } = await savedChat(t);
    const prepare = env.DB.prepare.bind(env.DB);
    let arrive;
    let release;
    const arrived = new Promise(resolve => { arrive = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    env.DB.prepare = sql => {
        if (!sql.startsWith('DELETE FROM documents')) return prepare(sql);
        return { bind(...values) {
            return { async run() {
                arrive();
                await barrier;
                return prepare(sql).bind(...values).run();
            } };
        } };
    };
    const deleting = call('/api/chats/delete', body);
    await arrived;
    assert.equal((await call('/api/chats/rename', renameBody(avatar))).status, 200);
    release();
    assert.equal((await deleting).status, 409);
    assert.deepEqual(await (await call('/api/chats/get', { avatar_url: avatar, file_name: 'Renamed' })).json(), chatFixture);
    assert.equal(env.FILES.objects.size, 2);
});

test('renamed chats can still save, rotate snapshots, list and delete under the new name', async t => {
    const { call, env, avatar, body } = await savedChat(t);
    await call('/api/chats/save', body);
    await call('/api/chats/rename', renameBody(avatar));
    const renamedBody = { ...body, file_name: 'Renamed' };
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/chats/save', renamedBody)).status, 200);
    assert.equal(env.FILES.objects.size, 3);
    const recent = await (await call('/api/chats/recent', {})).json();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].file_name, 'Renamed.jsonl');
    assert.equal((await call('/api/chats/delete', renamedBody)).status, 200);
    assert.equal(env.FILES.objects.size, 1);
});

test('past-chat listing follows the original search response contract without reading R2', async t => {
    const { call, env, avatar } = await savedChat(t);
    env.FILES.get = async () => { throw new Error('Empty-query listing must use the D1 index'); };
    const response = await call('/api/chats/search', { avatar_url: avatar, query: '' });
    assert.equal(response.status, 200);
    const [item] = await response.json();
    assert.equal(item.file_name, 'Original');
    assert.equal(item.message_count, 2);
    assert.equal(item.preview_message, chatFixture.at(-1).mes);
    assert.equal(item.last_mes, chatFixture.at(-1).send_date);
    assert.match(item.file_size, /^\d+ B$/);
});

test('chat search matches filename or all case-insensitive words across message bodies, but not hidden swipe branches', async t => {
    const { call, avatar } = await savedChat(t);
    for (const query of ['original', 'FIRST reply', ' question \n SECOND ']) {
        const response = await call('/api/chats/search', { avatar_url: avatar, query });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).length, 1);
    }
    for (const query of ['missing', 'Original question', 'FIRST reply visited']) {
        assert.deepEqual(await (await call('/api/chats/search', { avatar_url: avatar, query })).json(), []);
    }
    assert.deepEqual(await (await call('/api/chats/search', { avatar_url: 'Other.png', query: '' })).json(), []);
    assert.equal((await call('/api/chats/search', { avatar_url: avatar, query: 7 })).status, 400);
    assert.equal((await call('/api/chats/search', { group_id: 'group', query: '' })).status, 501);
});

test('full-text search fails explicitly at its scan budget instead of returning partial results', async t => {
    const { call, env, avatar, body, store } = await savedChat(t);
    for (let i = 0; i < MAX_CHAT_SEARCH_FILES; i++) {
        await call('/api/chats/save', { ...body, file_name: `Additional ${i}` });
    }
    const response = await call('/api/chats/search', { avatar_url: avatar, query: 'not-present' });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'SEARCH_BUDGET_EXCEEDED');
    assert.equal((await (await call('/api/chats/search', { avatar_url: avatar, query: '' })).json()).length, MAX_CHAT_SEARCH_FILES + 1);
    const row = await store.get('chat', key(avatar, 'Additional 0'));
    await store.put('chat', row.id, { ...row.value, bytes: MAX_CHAT_SEARCH_BYTES + 1 }, row.revision);
    env.FILES.get = async () => { throw new Error('An oversized scan must fail before fetching'); };
    assert.equal((await call('/api/chats/search', { avatar_url: avatar, query: 'not-present' })).status, 422);
});
