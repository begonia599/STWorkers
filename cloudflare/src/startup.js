import { Documents } from './documents.js';
import { HttpError, readJsonObject } from './http.js';
import { bootstrap } from './settings.js';
import { expectedRevision, name } from './input.js';
import { STATUS } from './capabilities.js';
import { characterImage } from './characters.js';
import { personaImage } from './avatars.js';
import sanitize from 'sanitize-filename';

export async function handleStartup(request, env, pathname) {
    if (pathname === '/version') {
        return Response.json({
            agent: `SillyTavern:${STATUS.upstream.version}:STworks`,
            pkgVersion: STATUS.upstream.version,
            stworks: { phase: STATUS.phase, readyForChat: STATUS.readyForChat },
        });
    }
    if (pathname === '/api/backgrounds/all') {
        const data = await bootstrap(request, env);
        return Response.json({
            images: (data.stworks?.backgrounds ?? []).map(filename => ({ filename, isAnimated: false })),
            config: { width: 160, height: 90 },
        });
    }
    if (pathname === '/api/backgrounds/folders') return Response.json({ folders: [], imageFolderMap: {} });
    const store = new Documents(env.DB);
    if (pathname === '/api/groups/all') return Response.json((await store.list('group')).map(row => row.value));
    const body = await readJsonObject(request);
    if (pathname === '/api/files/sanitize-filename') {
        if (typeof body.fileName !== 'string' || !body.fileName) throw new HttpError(400, 'INVALID_NAME', 'A filename is required.');
        return Response.json({ fileName: sanitize(body.fileName) });
    }
    if (pathname === '/api/image-metadata/all') {
        const index = (await store.get('image-metadata', 'owner'))?.value ?? { version: 1, images: {}, folders: [] };
        return Response.json(body.prefix ? {
            version: index.version,
            images: Object.fromEntries(Object.entries(index.images).filter(([key]) => key.startsWith(String(body.prefix)))),
        } : index);
    }
    const saved = await store.get('stats', 'owner');
    if (pathname === '/api/stats/get') return Response.json(saved?.value ?? {});
    await store.put('stats', 'owner', { ...body, timestamp: Date.now() }, expectedRevision(request, saved));
    return new Response('OK');
}

export async function thumbnail(request, env) {
    const { searchParams } = new URL(request.url);
    const id = name(searchParams.get('file'));
    const type = searchParams.get('type');
    if (type === 'avatar') return characterImage(request, env, id);
    if (type === 'persona') return personaImage(request, env, id);
    if (type !== 'bg') throw new HttpError(400, 'INVALID_THUMBNAIL_TYPE', 'Unknown thumbnail type.');
    const path = `/backgrounds/${id}`;
    // Background thumbnails currently serve the original asset.
    return env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method }));
}
