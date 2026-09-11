import { Documents } from './documents.js';
import { HttpError, readJsonObject } from './http.js';
import { name, object, expectedRevision, readForm, jsonText } from './input.js';
import { parseJsonObject } from './http.js';

export const PRESETS = {
    openai: ['openai_settings', 'openai_setting_names'],
    kobold: ['koboldai_settings', 'koboldai_setting_names'],
    novel: ['novelai_settings', 'novelai_setting_names'],
    textgenerationwebui: ['textgenerationwebui_presets', 'textgenerationwebui_preset_names'],
    instruct: ['instruct'], context: ['context'], sysprompt: ['sysprompt'], reasoning: ['reasoning'],
};

export async function bootstrap(request, env) {
    if (!env.ASSETS) throw new HttpError(503, 'ASSETS_NOT_CONFIGURED', 'Build the frontend assets first.');
    const response = await env.ASSETS.fetch(new Request(new URL('/__stworks/bootstrap.json', request.url)));
    if (!response.ok) throw new HttpError(503, 'BOOTSTRAP_UNAVAILABLE', 'Build the frontend assets first.');
    return response.json();
}

function defaults(data, api) {
    const [field, namesField] = PRESETS[api];
    return new Map((data[field] ?? []).map((value, index) => [
        namesField ? data[namesField][index] : value.name,
        namesField ? JSON.parse(value) : value,
    ]));
}

export async function settingsResponse(request, env) {
    const data = await bootstrap(request, env);
    const store = new Documents(env.DB);
    const saved = await store.get('settings', 'owner');
    for (const [api, [field, namesField]] of Object.entries(PRESETS)) {
        const values = defaults(data, api);
        for (const row of await store.list(`preset:${api}`)) {
            if (row.value.deleted) values.delete(row.id);
            else values.set(row.id, row.value.preset);
        }
        const names = [...values.keys()].sort((a, b) => a.localeCompare(b));
        data[field] = names.map(key => namesField ? JSON.stringify(values.get(key)) : values.get(key));
        if (namesField) data[namesField] = names;
    }
    data.world_names = (await store.list('world')).map(row => row.id);
    const overrides = await store.list('quick-reply');
    const replies = new Map((data.quickReplyPresets ?? []).map(item => [item.name, item]));
    for (const row of overrides) row.value.deleted ? replies.delete(row.id) : replies.set(row.id, row.value);
    data.quickReplyPresets = [...replies.values()];
    return Response.json({
        ...data,
        enable_accounts: true,
        settings: saved === null ? data.settings : JSON.stringify(saved.value),
    }, { headers: { ETag: `"${saved?.revision ?? 0}"` } });
}

export async function handleSettings(request, env, pathname) {
    const store = new Documents(env.DB);
    if (pathname === '/api/worldinfo/import') {
        const form = await readForm(request);
        if (!form.avatar || typeof form.avatar.arrayBuffer !== 'function') {
            throw new HttpError(400, 'FILE_REQUIRED', 'A worldbook upload is required.');
        }
        const id = name(form.avatar.name.replace(/\.json$/i, ''));
        const data = form.convertedData ? jsonText(form.convertedData)
            : parseJsonObject(await form.avatar.arrayBuffer());
        object(data.entries);
        const current = await store.get('world', id);
        await store.put('world', id, data, expectedRevision(request, current));
        return Response.json({ name: id });
    }
    const body = await readJsonObject(request);
    if (pathname === '/api/settings/get') return settingsResponse(request, env);
    if (pathname === '/api/settings/save') {
        const current = await store.get('settings', 'owner');
        await store.put('settings', 'owner', body, expectedRevision(request, current));
        return Response.json({ result: 'ok' });
    }
    if (pathname.startsWith('/api/presets/')) {
        const api = body.apiId === 'koboldhorde' ? 'kobold' : body.apiId;
        if (!Object.hasOwn(PRESETS, api)) throw new HttpError(400, 'INVALID_PRESET_TYPE', 'Unknown preset type.');
        const id = name(body.name);
        const data = await bootstrap(request, env);
        if (pathname.endsWith('/restore')) {
            const preset = defaults(data, api).get(id);
            return Response.json({ isDefault: preset !== undefined, preset: preset ?? {} });
        }
        const current = await store.get(`preset:${api}`, id);
        if (pathname.endsWith('/delete')) {
            const exists = current ? !current.value.deleted : defaults(data, api).has(id);
            if (!exists) throw new HttpError(404, 'PRESET_NOT_FOUND', 'Preset not found.');
            await store.put(`preset:${api}`, id, { deleted: true }, expectedRevision(request, current));
            return new Response('OK');
        }
        await store.put(`preset:${api}`, id, { preset: object(body.preset) }, expectedRevision(request, current));
        return Response.json({ name: id });
    }
    if (pathname.startsWith('/api/worldinfo/')) {
        if (pathname.endsWith('/list')) {
            return Response.json((await store.list('world')).map(row => ({
                file_id: row.id, name: row.value.name || row.id, extensions: row.value.extensions ?? {},
            })));
        }
        const id = name(body.name);
        const current = await store.get('world', id);
        if (pathname.endsWith('/get')) {
            return Response.json(current?.value ?? { entries: {} }, { headers: { ETag: `"${current?.revision ?? 0}"` } });
        }
        if (pathname.endsWith('/delete')) {
            if (!current) throw new HttpError(404, 'WORLD_NOT_FOUND', 'Worldbook not found.');
            await store.remove('world', id, expectedRevision(request, current));
            return new Response('OK');
        }
        const data = object(body.data);
        object(data.entries);
        await store.put('world', id, data, expectedRevision(request, current));
        return Response.json({ ok: true });
    }
    const id = name(body.name);
    const current = await store.get('quick-reply', id);
    await store.put('quick-reply', id, pathname.endsWith('/delete') ? { deleted: true } : body,
        expectedRevision(request, current));
    return new Response('OK');
}
