import { HttpError, jsonError } from './http.js';

const encoder = new TextEncoder();
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function equalDigests(left, right) {
    const [a, b] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(left)),
        crypto.subtle.digest('SHA-256', encoder.encode(right)),
    ]);
    const bytesA = new Uint8Array(a);
    const bytesB = new Uint8Array(b);
    let difference = 0;
    for (let index = 0; index < bytesA.length; index++) {
        difference |= bytesA[index] ^ bytesB[index];
    }
    return difference === 0;
}

export async function authenticate(request, env) {
    if (typeof env.AUTH_PASSWORD !== 'string' || env.AUTH_PASSWORD.length < 24) {
        return jsonError(503, 'OWNER_NOT_CONFIGURED', 'Configure the instance owner password before use.');
    }

    const authorization = request.headers.get('Authorization') ?? '';
    if (authorization.length < 4096 && /^Basic /i.test(authorization)) {
        try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
                Uint8Array.from(atob(authorization.slice(6)), character => character.charCodeAt(0)),
            );
            const separator = decoded.indexOf(':');
            if (separator !== -1
                && decoded.slice(0, separator) === 'owner'
                && await equalDigests(decoded.slice(separator + 1), env.AUTH_PASSWORD)) {
                return null;
            }
        } catch {
            // Malformed Basic credentials receive the same challenge as invalid credentials.
        }
    }
    return new Response('Authentication required.', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="STworks", charset="UTF-8"' },
    });
}

export async function csrfToken(request, env) {
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(env.AUTH_PASSWORD),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign(
        'HMAC', key, encoder.encode(`stworks:csrf:v1:${new URL(request.url).origin}`),
    );
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateCsrf(request, env) {
    if (READ_METHODS.has(request.method)) return;

    const origin = request.headers.get('Origin');
    if ((origin !== null && origin !== new URL(request.url).origin)
        || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        throw new HttpError(403, 'CROSS_ORIGIN_WRITE', 'Cross-origin writes are not permitted.');
    }
    const supplied = request.headers.get('X-CSRF-Token');
    if (!supplied || supplied.length !== 64 || !await equalDigests(supplied, await csrfToken(request, env))) {
        throw new HttpError(403, 'INVALID_CSRF_TOKEN', 'Refresh the page to obtain a CSRF token.');
    }
}
