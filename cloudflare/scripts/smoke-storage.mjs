import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8789');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('This test only runs against an explicitly local instance.');
}
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
assert.ok(AUTH_PASSWORD?.length >= 24);
const authorization = `Basic ${Buffer.from(`owner:${AUTH_PASSWORD}`).toString('base64')}`;
const send = (pathname, options = {}) => fetch(new URL(pathname, base), {
    ...options, signal: AbortSignal.timeout(20000),
    headers: { Authorization: authorization, ...options.headers },
});
const { token } = await (await send('/csrf-token')).json();
const post = (pathname, value, headers = {}) => send(pathname, {
    method: 'POST',
    headers: { 'X-CSRF-Token': token, Origin: base.origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value),
});
const id = `STworks-probe-${randomUUID()}`;
const avatar = `${id}.png`;
const secretKey = `stworks_probe_${randomUUID().replaceAll('-', '')}`;
const results = [];
let secretId;
let characterCreated = false;
let worldCreated = false;
let presetCreated = false;
try {
    assert.equal((await fetch(new URL(`/characters/${encodeURIComponent(avatar)}`, base))).status, 401);
    const card = {
        spec: 'chara_card_v3', spec_version: '3.0',
        data: { name: id, first_mes: 'Hello {{user}}', extensions: { synthetic: [null, false, 7] } },
        future: { opaque: true },
    };
    const form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(card)]), `${id}.json`);
    form.append('file_type', 'json');
    const imported = await send('/api/characters/import', {
        method: 'POST', headers: { 'X-CSRF-Token': token, Origin: base.origin }, body: form,
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(await imported.json(), { file_name: id });
    characterCreated = true;
    const image = await send(`/characters/${encodeURIComponent(avatar)}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    results.push('private character image in local R2');

    const chat = [
        { chat_metadata: { integrity: id, variables: { chapter: 4 }, future: null } },
        { name: id, is_user: false, mes: 'Chosen', swipes: ['A', 'Chosen'], swipe_id: 1,
            variables: [{ score: 1 }, { score: 2 }], extra: { future: [null, false] } },
    ];
    const body = { avatar_url: avatar, file_name: id, chat };
    assert.equal((await post('/api/chats/save', body)).status, 200);
    const loaded = await post('/api/chats/get', body);
    assert.deepEqual(await loaded.json(), chat);
    assert.equal((await post('/api/chats/save', body, { 'If-Match': '"0"' })).status, 409);
    assert.equal((await post('/api/chats/save', body)).status, 200);
    const exportedChat = await (await post('/api/chats/export', { ...body, format: 'jsonl' })).json();
    assert.deepEqual(exportedChat.result.split('\n').map(JSON.parse), chat);
    results.push('real D1/R2 chat round-trip, swipes, variables, JSONL export and revision conflict');

    const chatForm = new FormData();
    chatForm.append('avatar', new Blob([exportedChat.result]), 'fixture.jsonl');
    chatForm.append('avatar_url', avatar);
    chatForm.append('file_type', 'jsonl');
    chatForm.append('character_name', id);
    const chatImport = await send('/api/chats/import', {
        method: 'POST', headers: { 'X-CSRF-Token': token, Origin: base.origin }, body: chatForm,
    });
    assert.equal(chatImport.status, 200);
    const importedChat = (await chatImport.json()).fileNames[0];
    const renamedFile = `${id}-renamed`;
    const rename = await post('/api/chats/rename', {
        avatar_url: avatar, original_file: importedChat, renamed_file: `${renamedFile}.jsonl`,
    });
    assert.deepEqual(await rename.json(), { ok: true, sanitizedFileName: renamedFile });
    assert.deepEqual(await (await post('/api/chats/get', { avatar_url: avatar, file_name: importedChat })).json(), []);
    assert.deepEqual(await (await post('/api/chats/get', { avatar_url: avatar, file_name: renamedFile })).json(), chat);
    assert.equal((await post('/api/chats/rename', {
        avatar_url: avatar, original_file: `${id}.jsonl`, renamed_file: `${renamedFile}.jsonl`,
    })).status, 409);
    results.push('native JSONL import, atomic chat rename, conflict protection and reload in local D1/R2');

    const world = { entries: { 0: { uid: 0, key: ['probe'], content: '{{user}}', extension: null } }, future: [false] };
    assert.equal((await post('/api/worldinfo/edit', { name: id, data: world })).status, 200);
    worldCreated = true;
    assert.deepEqual(await (await post('/api/worldinfo/get', { name: id })).json(), world);
    assert.equal((await post('/api/presets/save', { name: id, apiId: 'openai', preset: { name: id, future: world } })).status, 200);
    presetCreated = true;
    const settings = await (await post('/api/settings/get', {})).json();
    const index = settings.openai_setting_names.indexOf(id);
    assert.ok(index >= 0);
    assert.deepEqual(JSON.parse(settings.openai_settings[index]).future, world);
    results.push('worldbook and preset persistence with unknown fields');

    const secret = await post('/api/secrets/write', { key: secretKey, value: 'synthetic-not-a-real-model-key' });
    assert.equal(secret.status, 200);
    secretId = (await secret.json()).id;
    const state = await (await post('/api/secrets/read', {})).json();
    assert.equal(state[secretKey][0].value, '********');
    assert.equal((await post('/api/secrets/view', {})).status, 403);
    results.push('local Worker AES-GCM credential write and metadata-only read');
} finally {
    if (characterCreated) assert.equal((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).status, 200);
    if (worldCreated) assert.equal((await post('/api/worldinfo/delete', { name: id })).status, 200);
    if (presetCreated) assert.equal((await post('/api/presets/delete', { name: id, apiId: 'openai' })).status, 200);
    if (secretId) assert.equal((await post('/api/secrets/delete', { key: secretKey, id: secretId })).status, 204);
}
for (const result of results) console.log(`PASS: ${result}`);
console.log('Removed only this run\'s uniquely named fixtures. Owner settings and existing data were not modified.');
