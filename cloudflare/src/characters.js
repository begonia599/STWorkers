import sanitize from 'sanitize-filename';
import { Documents } from './documents.js';
import { Files } from './files.js';
import { HttpError, parseJsonObject, readJsonObject } from './http.js';
import { expectedRevision, jsonText, merge, name, object, readForm, rejectCrop } from './input.js';
import { pngChunks, readCardPng, writeCardPng } from './card-png.js';
import { validateAvatarPng } from './avatars.js';

const FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

export function normalizeCard(input) {
    const card = structuredClone(object(input));
    delete card.json_data;
    card.data = object(card.data ?? {});
    for (const field of FIELDS) card.data[field] ??= card[field] ?? '';
    if (typeof card.data.name !== 'string' || !card.data.name.trim()) {
        throw new HttpError(400, 'CHARACTER_NAME_REQUIRED', 'A character name is required.');
    }
    card.spec ??= 'chara_card_v2';
    card.spec_version ??= '2.0';
    for (const field of ['creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) {
        card.data[field] ??= card[field] ?? '';
    }
    card.data.tags ??= card.tags ?? [];
    card.data.alternate_greetings ??= [];
    card.data.extensions = object(card.data.extensions ?? {});
    card.data.extensions.talkativeness ??= card.talkativeness ?? 0.5;
    card.data.extensions.fav ??= card.fav ?? false;
    for (const field of FIELDS) {
        if (typeof card.data[field] !== 'string') throw new HttpError(400, 'INVALID_CARD', 'Character text fields must be strings.');
    }
    for (const field of ['tags', 'alternate_greetings']) {
        if (!Array.isArray(card.data[field]) || card.data[field].some(item => typeof item !== 'string')) {
            throw new HttpError(400, 'INVALID_CARD', 'Tags and alternate greetings must be string arrays.');
        }
    }
    for (const field of FIELDS) card[field] = card.data[field];
    card.tags = card.data.tags;
    card.talkativeness = card.data.extensions.talkativeness;
    card.fav = card.data.extensions.fav;
    card.chat ??= `${card.name} - ${Date.now()}`;
    card.create_date ??= new Date().toISOString();
    return card;
}

function cardFromForm(form, previous = {}) {
    let card = structuredClone(previous);
    if (form.json_data) card = merge(card, jsonText(form.json_data));
    card.data ??= {};
    for (const field of FIELDS) {
        const input = field === 'name' ? 'ch_name' : field;
        if (Object.hasOwn(form, input)) card.data[field] = form[input];
    }
    for (const field of ['creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) {
        if (Object.hasOwn(form, field)) card.data[field] = form[field];
    }
    if (Object.hasOwn(form, 'tags')) card.data.tags = Array.isArray(form.tags)
        ? form.tags : String(form.tags).split(',').map(value => value.trim()).filter(Boolean);
    card.data.alternate_greetings = form.alternate_greetings === undefined ? []
        : Array.isArray(form.alternate_greetings) ? form.alternate_greetings : [form.alternate_greetings];
    card.data.extensions ??= {};
    if (form.extensions) card.data.extensions = merge(card.data.extensions, jsonText(form.extensions));
    if (Object.hasOwn(form, 'fav')) card.data.extensions.fav = form.fav === true || form.fav === 'true';
    if (Object.hasOwn(form, 'talkativeness')) card.data.extensions.talkativeness = Number(form.talkativeness);
    if (Object.hasOwn(form, 'world')) card.data.extensions.world = form.world;
    if (Object.hasOwn(form, 'depth_prompt_prompt')) {
        card.data.extensions.depth_prompt = {
            prompt: form.depth_prompt_prompt, depth: Number(form.depth_prompt_depth ?? 4), role: form.depth_prompt_role ?? 'system',
        };
    }
    if (form.chat) card.chat = form.chat;
    if (form.create_date) card.create_date = form.create_date;
    return normalizeCard(card);
}

export function characterView(row, chats = []) {
    const card = normalizeCard(row.value.card);
    const related = chats.filter(chat => chat.value.avatar === row.id);
    return {
        ...card, avatar: row.id, json_data: JSON.stringify(row.value.card),
        date_added: Date.parse(row.value.createdAt),
        date_last_chat: Math.max(0, ...related.map(chat => Date.parse(chat.updatedAt))),
        chat_size: related.reduce((size, chat) => size + chat.value.bytes, 0),
        data_size: new TextEncoder().encode(JSON.stringify(card.data)).length,
    };
}

async function defaultImage(request, env) {
    const response = await env.ASSETS.fetch(new Request(new URL('/img/ai4.png', request.url)));
    if (!response.ok) throw new HttpError(503, 'DEFAULT_AVATAR_MISSING', 'Build the default avatar asset.');
    return new Uint8Array(await response.arrayBuffer());
}

async function unusedName(store, preferred) {
    const base = sanitize(String(preferred)).slice(0, 180) || 'Character';
    const used = new Set((await store.list('character')).map(row => row.id));
    for (let suffix = 0; suffix < 10000; suffix++) {
        const id = `${base}${suffix || ''}.png`;
        if (!used.has(id)) return id;
    }
    throw new HttpError(409, 'NAME_CONFLICT', 'No available character filename.');
}

function applyUnset(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (value === '__@@UNSET@@__') delete target[key];
        else if (value && typeof value === 'object' && !Array.isArray(value)
            && target[key] && typeof target[key] === 'object') applyUnset(target[key], value);
    }
}

export async function handleCharacters(request, env, pathname) {
    const store = new Documents(env.DB);
    const files = new Files(env.FILES);
    if (pathname === '/api/characters/all') {
        const [cards, chats] = await Promise.all([store.list('character'), store.list('chat')]);
        return Response.json(cards.map(row => characterView(row, chats)));
    }
    const form = ['/api/characters/create', '/api/characters/edit', '/api/characters/edit-avatar', '/api/characters/import'].includes(pathname)
        ? await readForm(request) : await readJsonObject(request);
    rejectCrop(request);

    if (pathname === '/api/characters/create' || pathname === '/api/characters/import') {
        let card;
        let image;
        if (pathname.endsWith('/import')) {
            if (!form.avatar || typeof form.avatar.arrayBuffer !== 'function') {
                throw new HttpError(400, 'FILE_REQUIRED', 'The avatar upload is required.');
            }
            const bytes = new Uint8Array(await form.avatar.arrayBuffer());
            if (form.file_type === 'png') { card = normalizeCard(readCardPng(bytes)); image = bytes; }
            else if (form.file_type === 'json') { card = normalizeCard(parseJsonObject(bytes)); }
            else throw new HttpError(415, 'FORMAT_NOT_IMPLEMENTED', 'This stage supports PNG and JSON cards.');
        } else {
            card = cardFromForm(form);
            if (form.avatar?.size) image = new Uint8Array(await form.avatar.arrayBuffer());
        }
        image ??= await defaultImage(request, env);
        pngChunks(image);
        const requested = form.preserved_name || form.file_name;
        const id = requested ? `${name(requested).replace(/\.png$/i, '')}.png` : await unusedName(store, card.name);
        const previous = await store.get('character', id);
        if (previous && !(pathname.endsWith('/import') && form.preserved_name)) {
            throw new HttpError(409, 'CHARACTER_EXISTS', 'Character already exists.');
        }
        const revision = expectedRevision(request, previous);
        if (previous) {
            card.chat = previous.value.card.chat;
            card.create_date = previous.value.card.create_date;
        }
        if (!pathname.endsWith('/import')) validateAvatarPng(image);
        const garbage = await files.cleanup(previous?.value.garbage ?? []);
        const imageKey = await files.put('characters', image, 'image/png');
        if (previous?.value.imageKey) garbage.push(previous.value.imageKey);
        try {
            await store.put('character', id, {
                card, imageKey, garbage, createdAt: previous?.value.createdAt ?? new Date().toISOString(),
            }, revision);
        } catch (error) {
            await files.cleanup([imageKey]);
            throw error;
        }
        await files.cleanup(garbage);
        return pathname.endsWith('/import') ? Response.json({ file_name: id.slice(0, -4) }) : new Response(id);
    }

    if (Array.isArray(form.avatars)) throw new HttpError(501, 'BULK_EDIT_PENDING', 'Bulk character updates are not implemented yet.');
    const id = name(form.avatar_url ?? form.avatar);
    const row = await store.get('character', id);
    if (!row) throw new HttpError(404, 'CHARACTER_NOT_FOUND', 'Character not found.');
    if (pathname.endsWith('/get')) {
        return Response.json(characterView(row, await store.list('chat')), { headers: { ETag: `"${row.revision}"` } });
    }
    if (pathname.endsWith('/rename')) {
        const revision = expectedRevision(request, row);
        if (typeof form.new_name !== 'string') throw new HttpError(400, 'INVALID_NAME', 'A character name is required.');
        const newName = name(sanitize(form.new_name));
        if (newName === row.value.card.name) return Response.json({ avatar: id });
        const destination = await unusedName(store, newName);
        const card = normalizeCard({
            ...row.value.card, name: newName, data: { ...row.value.card.data, name: newName },
        });
        try {
            await store.rename('character', id, destination, { ...row.value, card }, revision);
        } catch (error) {
            if (/UNIQUE constraint failed|STWORKS_CHAT_DESTINATION_CONFLICT/.test(String(error.message))) {
                throw new HttpError(409, 'CHAT_DESTINATION_CONFLICT', 'Chats already exist at the destination. Choose another character name.');
            }
            throw error;
        }
        return Response.json({ avatar: destination });
    }
    if (pathname.endsWith('/export')) {
        const card = structuredClone(row.value.card);
        delete card.chat;
        card.fav = false;
        card.data.extensions.fav = false;
        if (form.format === 'json') return Response.json(card);
        if (form.format !== 'png') throw new HttpError(415, 'FORMAT_NOT_IMPLEMENTED', 'Only PNG and JSON exports are implemented.');
        const image = await files.get(row.value.imageKey);
        return new Response(writeCardPng(await image.arrayBuffer(), card), {
            headers: { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(id)}` },
        });
    }
    if (pathname.endsWith('/delete')) {
        expectedRevision(request, row);
        if (form.delete_chats === true) {
            const chats = (await store.list('chat')).filter(chat => chat.value.avatar === id);
            for (const chat of chats) {
                await store.remove('chat', chat.id, chat.revision);
                await files.cleanup([chat.value.objectKey, chat.value.previous?.objectKey, ...(chat.value.garbage ?? [])]);
            }
        }
        await store.remove('character', id, expectedRevision(request, row));
        await files.cleanup([row.value.imageKey, ...(row.value.garbage ?? [])]);
        return new Response('OK');
    }
    if (pathname.endsWith('/duplicate')) {
        const duplicate = await unusedName(store, row.value.card.name);
        const image = await files.get(row.value.imageKey);
        const imageKey = await files.put('characters', await image.arrayBuffer(), 'image/png');
        try {
            await store.put('character', duplicate, { ...row.value, imageKey, garbage: [], createdAt: new Date().toISOString() }, 0);
        } catch (error) {
            await files.cleanup([imageKey]);
            throw error;
        }
        return Response.json({ path: duplicate });
    }
    let card;
    if (pathname.endsWith('/edit-attribute')) {
        const field = name(form.field);
        if (['__proto__', 'prototype', 'constructor', 'json_data'].includes(field)
            || (!Object.hasOwn(row.value.card, field) && !Object.hasOwn(row.value.card.data, field))) {
            throw new HttpError(400, 'INVALID_FIELD', 'The character field cannot be edited.');
        }
        card = structuredClone(row.value.card);
        card[field] = form.value;
        card.data[field] = form.value;
        card = normalizeCard(card);
    } else if (pathname.endsWith('/merge-attributes')) {
        const patch = structuredClone(form);
        delete patch.avatar;
        delete patch.json_data;
        card = merge(row.value.card, patch);
        applyUnset(card, patch);
        card = normalizeCard(card);
    } else if (pathname.endsWith('/edit-avatar')) {
        if (!form.avatar?.size) throw new HttpError(400, 'FILE_REQUIRED', 'An avatar upload is required.');
        card = row.value.card;
    } else {
        card = cardFromForm(form, row.value.card);
    }
    const revision = expectedRevision(request, row);
    if (form.avatar?.size) {
        const bytes = await form.avatar.arrayBuffer();
        validateAvatarPng(bytes);
        const garbage = await files.cleanup(row.value.garbage ?? []);
        const imageKey = await files.put('characters', bytes, 'image/png');
        garbage.push(row.value.imageKey);
        try {
            await store.put('character', id, { ...row.value, card, imageKey, garbage }, revision);
        } catch (error) {
            await files.cleanup([imageKey]);
            throw error;
        }
        await files.cleanup(garbage);
    } else {
        await store.put('character', id, { ...row.value, card }, revision);
    }
    return new Response('OK');
}

export async function characterImage(request, env, id) {
    const row = await new Documents(env.DB).get('character', name(id));
    if (!row) throw new HttpError(404, 'CHARACTER_NOT_FOUND', 'Character not found.');
    const image = await new Files(env.FILES).get(row.value.imageKey);
    return new Response(request.method === 'HEAD' ? null : image.body, { headers: { 'Content-Type': 'image/png' } });
}
