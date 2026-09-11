import { HttpError, parseJsonObject, readBytes, readJsonObject } from './http.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_BYTES = 16 * 1024 * 1024;

export function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200
        || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || value === '.' || value === '..') {
        throw new HttpError(400, 'INVALID_NAME', 'A nonempty name without path separators is required.');
    }
    return value;
}

export function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new HttpError(400, 'INVALID_OBJECT', 'A JSON object is required.');
    }
    return value;
}

export function jsonText(value) {
    if (typeof value !== 'string') throw new HttpError(400, 'INVALID_JSON', 'JSON text is required.');
    return parseJsonObject(new TextEncoder().encode(value));
}

export function rejectCrop(request) {
    if (new URL(request.url).searchParams.has('crop')) {
        throw new HttpError(422, 'CLIENT_IMAGE_PROCESSING_REQUIRED', 'Crop and encode avatars as PNG in the browser before uploading.');
    }
}

export function merge(base, update) {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(update)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
            throw new HttpError(400, 'UNSAFE_KEY', 'Prototype-related patch keys are not allowed.');
        }
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
            ? merge(result[key], value) : structuredClone(value);
    }
    return result;
}

export async function readForm(request, maximum = MAX_UPLOAD_BYTES) {
    if (request.headers.get('Content-Type')?.startsWith('application/json')) return readJsonObject(request);
    const bytes = await readBytes(request, maximum);
    let form;
    try {
        form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } }).formData();
    } catch {
        throw new HttpError(400, 'INVALID_FORM', 'A valid multipart form is required.');
    }
    const result = Object.create(null);
    for (const [key, value] of form) {
        const field = key.endsWith('[]') ? key.slice(0, -2) : key;
        if (['__proto__', 'prototype', 'constructor'].includes(field)) throw new HttpError(400, 'UNSAFE_KEY', 'Invalid field.');
        if (Object.hasOwn(result, field)) {
            result[field] = Array.isArray(result[field]) ? [...result[field], value] : [result[field], value];
        } else result[field] = key.endsWith('[]') ? [value] : value;
    }
    return result;
}

export function expectedRevision(request, current) {
    const header = request.headers.get('If-Match');
    if (header === null) return current?.revision ?? 0;
    const match = /^"(\d+)"$/.exec(header);
    if (!match || Number(match[1]) !== (current?.revision ?? 0)) {
        throw new HttpError(409, 'REVISION_CONFLICT', 'The document changed. Reload before saving again.');
    }
    return Number(match[1]);
}
