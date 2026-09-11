import { Documents } from './documents.js';
import { HttpError, readJsonObject } from './http.js';

function encode(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function decode(value) {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
}

async function encryptionKey(env) {
    try {
        const bytes = decode(env.DATA_KEY ?? '');
        if (bytes.length !== 32) throw new Error('Invalid key');
        return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch {
        throw new HttpError(503, 'DATA_KEY_NOT_CONFIGURED', 'Configure the independent data encryption key.');
    }
}

async function encrypt(value, env) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), new TextEncoder().encode(value));
    return { iv: encode(iv), cipher: encode(new Uint8Array(cipher)) };
}

export async function readModelSecret(env, provider, id) {
    const saved = await new Documents(env.DB).get('secrets', provider);
    const active = saved?.value.find(secret => id ? secret.id === id : secret.active);
    if (id && !active) throw new HttpError(404, 'SECRET_NOT_FOUND', 'The selected model credential no longer exists.');
    if (!active) return null;
    const text = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(active.iv) }, await encryptionKey(env), decode(active.cipher),
    );
    return new TextDecoder().decode(text);
}

export async function handleSecrets(request, env, pathname) {
    if (pathname === '/api/secrets/settings') return Response.json({ allowKeysExposure: false });
    if (pathname === '/api/secrets/view' || pathname === '/api/secrets/find') {
        throw new HttpError(403, 'SECRET_EXPOSURE_DISABLED', 'Returning plaintext credentials to the browser is disabled.');
    }
    const store = new Documents(env.DB);
    if (pathname === '/api/secrets/read') {
        const state = {};
        for (const row of await store.list('secrets')) {
            state[row.id] = row.value.map(({ id, label, active }) => ({ id, label, active, value: '********' }));
        }
        return Response.json(state);
    }
    const body = await readJsonObject(request);
    if (typeof body.key !== 'string' || !/^[a-zA-Z0-9_]{1,100}$/.test(body.key)) {
        throw new HttpError(400, 'INVALID_SECRET_KEY', 'A provider key is required.');
    }
    const row = await store.get('secrets', body.key);
    let entries = row?.value ?? [];
    const action = pathname.split('/').at(-1);
    let createdId;
    if (action === 'write') {
        if (typeof body.value !== 'string' || !body.value || body.value.length > 8192) {
            throw new HttpError(400, 'INVALID_SECRET', 'A nonempty credential within the size limit is required.');
        }
        createdId = crypto.randomUUID();
        entries = entries.map(entry => ({ ...entry, active: false }));
        entries.push({ id: createdId, label: String(body.label ?? 'API key').slice(0, 200), active: true, ...await encrypt(body.value, env) });
    } else {
        const selected = entries.find(entry => entry.id === body.id);
        if (!selected && !(action === 'delete' && !body.id)) {
            throw new HttpError(404, 'SECRET_NOT_FOUND', 'Credential entry not found.');
        }
        if (action === 'delete') entries = entries.filter(entry => body.id ? entry.id !== body.id : !entry.active);
        if (action === 'rotate') entries = entries.map(entry => ({ ...entry, active: entry.id === body.id }));
        if (action === 'rename') {
            if (typeof body.label !== 'string' || !body.label.trim()) throw new HttpError(400, 'INVALID_LABEL', 'A label is required.');
            selected.label = body.label.slice(0, 200);
        }
        if (entries.length && !entries.some(entry => entry.active)) entries[0].active = true;
    }
    await store.put('secrets', body.key, entries, row?.revision ?? 0);
    return createdId ? Response.json({ id: createdId }) : new Response(null, { status: 204 });
}
