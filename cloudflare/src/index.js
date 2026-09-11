import { authenticate, csrfToken, validateCsrf } from './auth.js';
import { STATUS, EXCLUDED_API_PREFIXES } from './capabilities.js';
import { HttpError, jsonError, protectResponse } from './http.js';
import { handleSettings } from './settings.js';
import { handleSecrets } from './secrets.js';
import { handleCharacters, characterImage } from './characters.js';
import { handleChats } from './chats.js';
import { handleStartup, thumbnail } from './startup.js';
import { handleAvatars, personaImage } from './avatars.js';
import { handleGeneration } from './generation.js';
import { handlePromptProcessing } from './prompt-processing.js';
import { handleExtensions, extensionAsset } from './extensions.js';

const ROUTES = new Map([
    ['/api/stworks/status', ['GET', () => Response.json(STATUS)]],
    ['/csrf-token', ['GET', async (request, env) => Response.json({ token: await csrfToken(request, env) })]],
    ['/api/ping', ['POST', () => new Response('ok')]],
    ['/version', ['GET', handleStartup]],
    ['/api/extensions/discover', ['GET', handleExtensions]],
    ['/thumbnail', ['GET', thumbnail]],
    ['/api/backends/chat-completions/process', ['POST', handlePromptProcessing]],
]);

for (const [prefix, actions, handler] of [
    ['extensions', ['install', 'update', 'version', 'delete', 'branches', 'switch', 'rollback', 'cleanup'], handleExtensions],
    ['backends/chat-completions', ['status', 'generate'], handleGeneration],
    ['settings', ['get', 'save'], handleSettings],
    ['presets', ['save', 'delete', 'restore'], handleSettings],
    ['worldinfo', ['list', 'get', 'edit', 'delete', 'import'], handleSettings],
    ['quick-replies', ['save', 'delete'], handleSettings],
    ['secrets', ['settings', 'read', 'write', 'delete', 'rotate', 'rename', 'view', 'find'], handleSecrets],
    ['characters', ['all', 'get', 'create', 'edit', 'edit-avatar', 'edit-attribute', 'merge-attributes', 'import', 'export', 'duplicate', 'delete', 'rename'], handleCharacters],
    ['characters', ['chats'], handleChats],
    ['chats', ['get', 'save', 'delete', 'recent', 'export', 'import', 'rename', 'search'], handleChats],
    ['avatars', ['get', 'upload', 'delete'], handleAvatars],
    ['backgrounds', ['all', 'folders'], handleStartup],
    ['image-metadata', ['all'], handleStartup],
    ['files', ['sanitize-filename'], handleStartup],
    ['groups', ['all'], handleStartup],
    ['stats', ['get', 'update'], handleStartup],
]) {
    for (const action of actions) ROUTES.set(`/api/${prefix}/${action}`, ['POST', handler]);
}

async function route(request, env) {
    const pathname = new URL(request.url).pathname;
    const entry = ROUTES.get(pathname);
    if (entry) {
        const [method, handler] = entry;
        if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
        return handler(request, env, pathname);
    }

    if (EXCLUDED_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        return jsonError(410, 'FEATURE_OUT_OF_SCOPE', 'This service is outside the frozen project scope.');
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        return jsonError(501, 'NOT_IMPLEMENTED', 'This API is not implemented in the current development stage.');
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (pathname.startsWith('/scripts/extensions/third-party/')) return extensionAsset(request, env, pathname);
    if (pathname.startsWith('/characters/')) {
        let id;
        try { id = decodeURIComponent(pathname.slice('/characters/'.length)); }
        catch { throw new HttpError(400, 'INVALID_PATH', 'Malformed character path.'); }
        return characterImage(request, env, id);
    }
    if (pathname.startsWith('/User%20Avatars/') || pathname.startsWith('/User Avatars/')) {
        const prefix = pathname.startsWith('/User%20Avatars/') ? '/User%20Avatars/' : '/User Avatars/';
        let id;
        try { id = decodeURIComponent(pathname.slice(prefix.length)); }
        catch { throw new HttpError(400, 'INVALID_PATH', 'Malformed avatar path.'); }
        return personaImage(request, env, id);
    }
    if (!env.ASSETS) throw new HttpError(503, 'ASSETS_NOT_CONFIGURED', 'Build the frontend assets first.');
    const url = new URL(request.url);
    if (url.pathname === '/') url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
}

export default {
    async fetch(request, env) {
        try {
            const challenge = await authenticate(request, env);
            if (challenge) return protectResponse(challenge);
            await validateCsrf(request, env);
            return protectResponse(await route(request, env));
        } catch (error) {
            if (error instanceof HttpError) {
                return protectResponse(jsonError(error.status, error.code, error.message));
            }
            // Never include data, request headers, credentials, or database errors in responses.
            console.error('STworks request failed with an internal error.');
            return protectResponse(jsonError(500, 'INTERNAL_ERROR', 'The request could not be completed.'));
        }
    },
};
