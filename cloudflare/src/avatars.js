import { Documents } from './documents.js';
import { Files } from './files.js';
import { HttpError, readJsonObject } from './http.js';
import { expectedRevision, name, readForm, rejectCrop } from './input.js';
import { pngChunks } from './card-png.js';

const DEFAULT_AVATAR = 'user-default.png';

export function validateAvatarPng(bytes) {
    const chunks = pngChunks(bytes);
    const header = chunks[0];
    if (header?.name !== 'IHDR' || header.data.length !== 13
        || !chunks.some(chunk => chunk.name === 'IDAT') || chunks.at(-1)?.name !== 'IEND') {
        throw new HttpError(400, 'INVALID_PNG', 'A complete PNG image is required.');
    }
    const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
    const width = view.getUint32(0), height = view.getUint32(4);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) {
        throw new HttpError(413, 'AVATAR_DIMENSIONS_EXCEEDED', 'Avatar limit: 8192 per side and 16 megapixels.');
    }
}

export async function handleAvatars(request, env, pathname) {
    const store = new Documents(env.DB);
    const files = new Files(env.FILES);
    if (pathname.endsWith('/get')) {
        const rows = await store.list('avatar');
        const ids = new Set([DEFAULT_AVATAR]);
        for (const row of rows) {
            if (row.value.deleted) ids.delete(row.id);
            else ids.add(row.id);
        }
        return Response.json([...ids].sort());
    }
    rejectCrop(request);
    const form = pathname.endsWith('/upload') ? await readForm(request) : await readJsonObject(request);
    const id = name(pathname.endsWith('/upload')
        ? form.overwrite_name || `${crypto.randomUUID()}.png` : form.avatar);
    const row = await store.get('avatar', id);
    const revision = expectedRevision(request, row);
    if (pathname.endsWith('/delete')) {
        if (row?.value.deleted || (!row && id !== DEFAULT_AVATAR)) {
            throw new HttpError(404, 'AVATAR_NOT_FOUND', 'User avatar not found.');
        }
        const garbage = [...(row?.value.garbage ?? []), row?.value.imageKey].filter(Boolean);
        await store.put('avatar', id, { deleted: true, garbage }, revision);
        await files.cleanup(garbage);
        return Response.json({ result: 'ok' });
    }
    if (!form.avatar?.size || typeof form.avatar.arrayBuffer !== 'function') {
        throw new HttpError(400, 'FILE_REQUIRED', 'A PNG avatar upload is required.');
    }
    const bytes = await form.avatar.arrayBuffer();
    validateAvatarPng(bytes);
    const garbage = await files.cleanup(row?.value.garbage ?? []);
    const imageKey = await files.put('avatars', bytes, 'image/png');
    if (row?.value.imageKey) garbage.push(row.value.imageKey);
    try {
        await store.put('avatar', id, { imageKey, garbage, createdAt: row?.value.createdAt ?? new Date().toISOString() }, revision);
    } catch (error) {
        await files.cleanup([imageKey]);
        throw error;
    }
    await files.cleanup(garbage);
    return Response.json({ path: id });
}

export async function personaImage(request, env, id) {
    name(id);
    const row = await new Documents(env.DB).get('avatar', id);
    if (row?.value.deleted || (!row && id !== DEFAULT_AVATAR)) {
        throw new HttpError(404, 'AVATAR_NOT_FOUND', 'User avatar not found.');
    }
    if (!row) {
        return env.ASSETS.fetch(new Request(new URL(`/User%20Avatars/${DEFAULT_AVATAR}`, request.url), { method: request.method }));
    }
    const image = await new Files(env.FILES).get(row.value.imageKey);
    return new Response(request.method === 'HEAD' ? null : image.body, { headers: { 'Content-Type': 'image/png' } });
}
