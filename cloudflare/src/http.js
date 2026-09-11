export const MAX_JSON_BYTES = 1024 * 1024;

export class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function jsonError(status, code, message) {
    return Response.json({ error: { code, message } }, { status });
}

export function protectResponse(response) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export async function readJsonObject(request) {
    const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
        throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
    }
    const bytes = await readBytes(request, MAX_JSON_BYTES);
    return parseJsonObject(bytes);
}

export function parseJsonObject(bytes) {
    try {
        const object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected an object');
        return object;
    } catch {
        throw new HttpError(400, 'INVALID_JSON', 'A valid JSON object is required.');
    }
}

export async function readBytes(request, maximum) {
    if (Number(request.headers.get('Content-Length')) > maximum) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request exceeds the ${maximum}-byte limit.`);
    }
    if (!request.body) {
        throw new HttpError(400, 'INVALID_JSON', 'A JSON object is required.');
    }

    const reader = request.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximum) {
                await reader.cancel();
                throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request exceeds the ${maximum}-byte limit.`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
