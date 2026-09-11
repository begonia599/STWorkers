import sanitize from 'sanitize-filename';
import { Documents } from './documents.js';
import { Files } from './files.js';
import { HttpError, parseJsonObject, readBytes, readJsonObject } from './http.js';
import { expectedRevision, MAX_CHAT_BYTES, name, object, readForm } from './input.js';

export const MAX_CHAT_SEARCH_FILES = 32;
export const MAX_CHAT_SEARCH_BYTES = MAX_CHAT_BYTES;

function identifier(avatar, file) {
    return JSON.stringify([name(avatar), name(file)]);
}

function chatName(value) {
    return name(name(value).replace(/\.jsonl$/i, ''));
}

function parseImportedChat(bytes) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new HttpError(400, 'INVALID_CHAT_ENCODING', 'Chat imports must use UTF-8.');
    }
    const chat = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); }
        catch { throw new HttpError(400, 'INVALID_CHAT_JSONL', `Invalid JSON at line ${index + 1}.`); }
        chat.push(object(item));
    }
    const header = chat[0];
    if (!header || Object.hasOwn(header, 'mes')
        || (!Object.hasOwn(header, 'user_name') && !Object.hasOwn(header, 'chat_metadata'))) {
        throw new HttpError(400, 'INVALID_CHAT_HEADER', 'A native SillyTavern JSONL header is required.');
    }
    object(header.chat_metadata ?? {});
    if (chat.slice(1).some(message => typeof message.mes !== 'string')) {
        throw new HttpError(400, 'INVALID_CHAT_MESSAGE', 'Each imported message must contain a text mes field.');
    }
    return chat;
}

function summary(row, metadata = false) {
    return {
        file_id: row.value.file,
        file_name: `${row.value.file}.jsonl`,
        file_size: `${row.value.bytes} B`,
        chat_items: row.value.messageCount,
        mes: row.value.lastMessage,
        last_mes: row.value.lastMessageDate,
        avatar: row.value.avatar,
        ...(metadata ? { chat_metadata: row.value.metadata } : {}),
    };
}

async function loadChat(files, row) {
    if (!row) return [];
    const object = await files.get(row.value.objectKey);
    return (await object.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function saveSnapshot(store, files, { avatar, file, chat, current, revision }) {
    if (!Array.isArray(chat) || !chat.length) {
        throw new HttpError(400, 'INVALID_CHAT', 'A chat header and message array are required.');
    }
    chat.forEach(object);
    if (current) {
        // Upstream rebuilds the header on save. Keep omitted extension fields, but replace supplied fields (including metadata).
        const previousHeader = (await loadChat(files, current))[0] ?? {};
        chat = [{ ...previousHeader, ...chat[0] }, ...chat.slice(1)];
    }
    const metadata = object(chat[0].chat_metadata ?? {});
    const text = chat.map(message => JSON.stringify(message)).join('\n');
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_CHAT_BYTES) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The complete chat snapshot exceeds the 16 MiB limit.');
    }
    const pending = await files.cleanup(current?.value.garbage ?? []);
    const objectKey = await files.put('chats', text, 'application/x-ndjson');
    const last = chat.at(-1);
    const value = {
        avatar, file, objectKey,
        bytes, messageCount: chat.length - 1,
        lastMessage: String(last.mes ?? '[The chat is empty]').slice(0, 400),
        lastMessageDate: last.send_date ?? new Date().toISOString(),
        metadata,
        previous: current ? { objectKey: current.value.objectKey, revision: current.revision } : null,
        garbage: [...pending, ...(current?.value.previous ? [current.value.previous.objectKey] : [])],
    };
    try {
        await store.put('chat', identifier(avatar, file), value, revision);
    } catch (error) {
        await files.cleanup([objectKey]);
        if (String(error.message).includes('STWORKS_CHAT_CHARACTER_MISSING')) {
            throw new HttpError(409, 'CHARACTER_CHANGED', 'The character was renamed or deleted while the chat was saving.');
        }
        throw error;
    }
    // D1 commits the pointer first. Cleanup failures must not turn a committed save into a failed one.
    await files.cleanup(value.garbage);
}

async function importChat(request, store, files) {
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data;')) {
        throw new HttpError(415, 'MULTIPART_REQUIRED', 'Chat import requires a multipart file upload.');
    }
    const form = await readForm(request, MAX_CHAT_BYTES);
    if (form.is_group && form.is_group !== 'false') {
        throw new HttpError(501, 'GROUP_CHAT_PENDING', 'Group chat storage is not implemented yet.');
    }
    const avatar = name(form.avatar_url);
    const character = await store.get('character', avatar);
    if (!character) throw new HttpError(404, 'CHARACTER_NOT_FOUND', 'Character not found.');
    if (form.file_type !== 'jsonl') {
        throw new HttpError(415, 'CHAT_FORMAT_NOT_IMPLEMENTED', 'Only native SillyTavern JSONL chat import is implemented.');
    }
    if (!form.avatar || typeof form.avatar.arrayBuffer !== 'function') {
        throw new HttpError(400, 'FILE_REQUIRED', 'A chat file upload is required.');
    }
    const chat = parseImportedChat(await form.avatar.arrayBuffer());
    const characterName = sanitize(character.value.card.name).slice(0, 100) || 'Character';
    const file = `${characterName} - ${new Date().toISOString().replaceAll(':', '-')} ${crypto.randomUUID()} imported`;
    await saveSnapshot(store, files, { avatar, file, chat, current: null, revision: 0 });
    return Response.json({ res: true, fileNames: [`${file}.jsonl`] });
}

async function searchChats(body, store, files) {
    if (body.group_id) throw new HttpError(501, 'GROUP_CHAT_PENDING', 'Group chat storage is not implemented yet.');
    const avatar = name(body.avatar_url);
    const query = body.query ?? '';
    if (typeof query !== 'string' || query.length > 1024) {
        throw new HttpError(400, 'INVALID_QUERY', 'A text query of at most 1024 characters is required.');
    }
    const fragments = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = texts => {
        const normalized = texts.map(text => String(text ?? '').toLowerCase());
        return fragments.every(fragment => normalized.some(text => text.includes(fragment)));
    };
    const rows = (await store.list('chat')).filter(row => row.value.avatar === avatar);
    const results = [];
    let bytesRead = 0;
    let filesRead = 0;
    for (const row of rows) {
        let matched = matches([row.value.file]);
        if (!matched && row.value.messageCount > 0) {
            bytesRead += row.value.bytes;
            if (++filesRead > MAX_CHAT_SEARCH_FILES || bytesRead > MAX_CHAT_SEARCH_BYTES) {
                throw new HttpError(422, 'SEARCH_BUDGET_EXCEEDED', 'Full-text search exceeds this stage\'s scan budget. No partial results were returned.');
            }
            const chat = await loadChat(files, row);
            matched = matches(chat.slice(1).map(message => message.mes));
        }
        if (matched) {
            results.push({
                file_name: row.value.file,
                file_size: `${row.value.bytes} B`,
                message_count: row.value.messageCount,
                last_mes: row.value.lastMessageDate,
                preview_message: row.value.lastMessage,
            });
        }
    }
    return Response.json(results);
}

export async function handleChats(request, env, pathname) {
    const store = new Documents(env.DB);
    const files = new Files(env.FILES);
    if (pathname === '/api/chats/import') return importChat(request, store, files);
    if (pathname.endsWith('/save') && request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
        throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
    }
    const body = pathname.endsWith('/save')
        ? parseJsonObject(await readBytes(request, MAX_CHAT_BYTES)) : await readJsonObject(request);
    if (body.is_group) throw new HttpError(501, 'GROUP_CHAT_PENDING', 'Group chat storage is not implemented yet.');
    if (pathname === '/api/chats/search') return searchChats(body, store, files);
    if (pathname === '/api/chats/recent') {
        const pinned = Array.isArray(body.pinned) ? body.pinned : [];
        const isPinned = row => pinned.some(pin => pin.avatar === row.value.avatar && pin.file_name === `${row.value.file}.jsonl`);
        const rows = (await store.list('chat')).sort((a, b) => Number(isPinned(b)) - Number(isPinned(a))
            || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        return Response.json(rows.slice(0, Math.max(0, Math.min(Number(body.max ?? 100), 1000)) + pinned.length)
            .map(row => summary(row, body.metadata)));
    }
    if (pathname === '/api/characters/chats') {
        const avatar = name(body.avatar_url);
        const rows = (await store.list('chat')).filter(row => row.value.avatar === avatar);
        return Response.json(rows.map(row => body.simple
            ? { file_name: `${row.value.file}.jsonl`, file_id: row.value.file } : summary(row, body.metadata)));
    }
    const avatar = name(body.avatar_url);
    if (pathname === '/api/chats/rename') {
        const original = chatName(body.original_file);
        if (typeof body.renamed_file !== 'string') {
            throw new HttpError(400, 'INVALID_NAME', 'The new chat filename is required.');
        }
        const renamed = chatName(sanitize(body.renamed_file));
        const id = identifier(avatar, original);
        const current = await store.get('chat', id);
        if (!current) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Chat not found.');
        const revision = expectedRevision(request, current);
        if (original !== renamed) {
            await store.rename('chat', id, identifier(avatar, renamed), { ...current.value, file: renamed }, revision);
        }
        return Response.json({ ok: true, sanitizedFileName: renamed });
    }
    if (pathname.endsWith('/save') && !await store.get('character', avatar)) {
        throw new HttpError(404, 'CHARACTER_NOT_FOUND', 'Character not found.');
    }
    const requestedFile = body.file_name ?? body.file ?? body.chatfile;
    if (!requestedFile && pathname.endsWith('/get')) return Response.json([]);
    const file = chatName(requestedFile);
    const id = identifier(avatar, file);
    const current = await store.get('chat', id);
    if (pathname.endsWith('/get')) {
        return Response.json(await loadChat(files, current), { headers: { ETag: `"${current?.revision ?? 0}"` } });
    }
    if (pathname.endsWith('/export')) {
        if (!current) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Chat not found.');
        const chat = await loadChat(files, current);
        const result = body.format === 'jsonl' ? chat.map(item => JSON.stringify(item)).join('\n')
            : chat.filter(item => !item.is_system && item.mes).map(item => `${item.name}: ${item.mes}`).join('\n\n');
        return Response.json({ message: `Chat saved to ${body.exportfilename ?? file}`, result });
    }
    if (pathname.endsWith('/delete')) {
        if (!current) throw new HttpError(404, 'CHAT_NOT_FOUND', 'Chat not found.');
        await store.remove('chat', id, expectedRevision(request, current));
        await files.cleanup([current.value.objectKey, current.value.previous?.objectKey, ...(current.value.garbage ?? [])]);
        return Response.json({ ok: true });
    }
    if (!Array.isArray(body.chat) || !body.chat.length) {
        throw new HttpError(400, 'INVALID_CHAT', 'A chat header and message array are required.');
    }
    body.chat.forEach(object);
    const metadata = object(body.chat[0].chat_metadata ?? {});
    if (!body.force && metadata.integrity && current?.value.metadata?.integrity
        && metadata.integrity !== current.value.metadata.integrity) {
        return Response.json({ error: 'integrity' }, { status: 400 });
    }
    await saveSnapshot(store, files, { avatar, file, chat: body.chat, current, revision: expectedRevision(request, current) });
    return Response.json({ ok: true });
}
