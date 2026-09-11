import { lookup } from 'mime-types';
import { Documents } from './documents.js';
import { Files } from './files.js';
import { HttpError, readJsonObject, readBytes } from './http.js';
import { bootstrap } from './settings.js';
import { extensionName, repositoryUrl, repositoryRef, resolveRepository, downloadRepository, repositoryBranches } from './extension-repository.js';
import { inspectArchive, inflateEntry, pluginPath, MAX_INDEX_BYTES } from './extension-archive.js';

const KIND = 'extension';
const PREFIX = '/scripts/extensions/third-party/';
const BUNDLED_SOURCES = {
    'JS-Slash-Runner': 'https://github.com/N0VI028/JS-Slash-Runner',
    'ST-Prompt-Template': 'https://github.com/zonde306/ST-Prompt-Template',
};
const identity = (scope, name) => `${scope}/${name.toLowerCase()}`;
const assetPath = name => `${PREFIX}${encodeURIComponent(name)}/`;
const objectKeys = snapshot => snapshot?.kind === 'archive' ? [snapshot.archiveKey, snapshot.indexKey] : [];

async function bundled(request, env) {
    return ((await bootstrap(request, env)).stworks?.extensions ?? []);
}

async function bundledSnapshot(request, env, name) {
    const item = (await bundled(request, env)).find(entry => entry.name.toLowerCase() === `third-party/${name}`.toLowerCase());
    if (!item) return null;
    const folder = item.name.slice('third-party/'.length);
    const remoteUrl = BUNDLED_SOURCES[folder];
    if (!remoteUrl || !/^[a-f0-9]{40}$/.test(item.commit ?? '')) {
        throw new HttpError(422, 'UNMANAGED_BUNDLED_EXTENSION', 'This bundled extension has no verified repository metadata.');
    }
    const response = await env.ASSETS.fetch(new Request(new URL(`${assetPath(folder)}manifest.json`, request.url)));
    if (!response.ok) throw new HttpError(503, 'BUNDLED_EXTENSION_MISSING', 'The bundled extension manifest is unavailable.');
    return { kind: 'bundled', remoteUrl, commit: item.commit, ref: '', refKind: 'bundled',
        folder, manifest: await response.json() };
}

async function stateFor(request, env, scope, name) {
    const store = new Documents(env.DB);
    const row = await store.get(KIND, identity(scope, name));
    if (row) return row;
    const snapshot = scope === 'local' ? await bundledSnapshot(request, env, name) : null;
    return { revision: 0, value: { name: snapshot?.folder ?? name, scope, current: snapshot, previous: null, garbage: [] } };
}

export async function discoverExtensions(request, env) {
    const entries = await bundled(request, env);
    const rows = await new Documents(env.DB).list(KIND);
    const result = entries.filter(entry => !entry.name.startsWith('third-party/'));
    const local = new Map(entries.filter(entry => entry.name.startsWith('third-party/'))
        .map(entry => [entry.name.toLowerCase(), entry]));
    const global = new Map();
    for (const { value } of rows) {
        const name = `third-party/${value.name}`;
        const target = value.scope === 'global' ? global : local;
        if (!value.current) target.delete(name.toLowerCase());
        else target.set(name.toLowerCase(), { name, type: value.scope, commit: value.current.commit,
            version: value.current.manifest.version });
    }
    return Response.json([...result, ...local.values(),
        ...[...global].filter(([name]) => !local.has(name)).map(([, value]) => value)]);
}

async function saveState(env, old, next, stagedKeys = []) {
    const store = new Documents(env.DB);
    const id = identity(next.scope, next.name);
    try {
        await store.put(KIND, id, next, old.revision);
    } catch (error) {
        // Only a definite CAS conflict proves a newly uploaded archive cannot be the active version.
        if (error instanceof HttpError && error.code === 'REVISION_CONFLICT') await new Files(env.FILES).cleanup(stagedKeys);
        throw error;
    }
    if (next.garbage.length) {
        const remaining = await new Files(env.FILES).cleanup(next.garbage);
        try { await store.put(KIND, id, { ...next, garbage: remaining }, old.revision + 1); }
        catch { /* A concurrent successful update keeps its own cleanup ledger. */ }
    }
}

function needCurrent(row) {
    if (!row.value.current) throw new HttpError(404, 'EXTENSION_NOT_FOUND', 'The extension is not installed in this scope.');
    return row.value.current;
}

async function installVersion(request, env, old, repo, reference) {
    if (old.value.garbage.length > 64) {
        throw new HttpError(503, 'EXTENSION_CLEANUP_REQUIRED', 'Retry extension cleanup before installing another version.');
    }
    if (old.value.current?.kind === 'archive' && old.value.current.refKind === 'commit'
        && reference?.toLowerCase() === old.value.current.commit) {
        return { current: old.value.current, isUpToDate: true };
    }
    const resolved = await resolveRepository(repo, reference, request.signal);
    if (old.value.current?.kind === 'archive' && old.value.current.commit === resolved.commit
        && old.value.current.ref === resolved.ref && old.value.current.refKind === resolved.refKind) {
        return { current: old.value.current, isUpToDate: true };
    }
    const bytes = await downloadRepository(repo, resolved, request.signal);
    const inspection = await inspectArchive(bytes, request.signal);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        value => value.toString(16).padStart(2, '0')).join('');
    const files = new Files(env.FILES);
    const archiveKey = `extensions/${crypto.randomUUID()}/source.zip`;
    const indexKey = `extensions/${crypto.randomUUID()}/index.json`;
    try {
        request.signal.throwIfAborted();
        await env.FILES.put(archiveKey, bytes, { httpMetadata: { contentType: 'application/zip' } });
        await env.FILES.put(indexKey, inspection.index, { httpMetadata: { contentType: 'application/json' } });
        request.signal.throwIfAborted();
    } catch (error) {
        await files.cleanup([archiveKey, indexKey]);
        throw error;
    }
    const current = { ...resolved, kind: 'archive', archiveKey, indexKey, archiveSha256: hash,
        manifest: inspection.manifest, fileCount: inspection.fileCount, archiveBytes: bytes.byteLength };
    const garbage = [...new Set([...old.value.garbage, ...objectKeys(old.value.previous)])];
    const next = { ...old.value, current, previous: old.value.current, garbage };
    await saveState(env, old, next, [archiveKey, indexKey]);
    return { current, isUpToDate: false };
}

export async function handleExtensions(request, env, pathname) {
    if (pathname === '/api/extensions/discover') return discoverExtensions(request, env);
    const body = await readJsonObject(request);
    if (body.global !== undefined && typeof body.global !== 'boolean') {
        throw new HttpError(400, 'INVALID_EXTENSION_SCOPE', 'global must be a boolean.');
    }
    const scope = body.global ? 'global' : 'local';
    const action = pathname.split('/').at(-1);
    const repo = action === 'install' ? repositoryUrl(body.url) : null;
    const name = repo?.name ?? extensionName(body.extensionName);
    const row = await stateFor(request, env, scope, name);
    const path = assetPath(row.value.name);
    if (action === 'install') {
        if (row.value.current) throw new HttpError(409, 'EXTENSION_ALREADY_INSTALLED', 'This extension folder already exists. Use update, or uninstall it first.');
        const { current } = await installVersion(request, env, row, repo, body.branch);
        return Response.json({ version: current.manifest.version, author: current.manifest.author,
            display_name: current.manifest.display_name, extensionPath: path, folderName: row.value.name });
    }
    if (action === 'cleanup') {
        if (!row.revision && !row.value.current) needCurrent(row);
        await saveState(env, row, row.value);
        return new Response(null, { status: 204 });
    }
    const current = needCurrent(row);
    if (action === 'delete') {
        const garbage = [...new Set([...row.value.garbage, ...objectKeys(current), ...objectKeys(row.value.previous)])];
        await saveState(env, row, { ...row.value, current: null, previous: null, garbage });
        return new Response('Extension deleted. Saved settings and chat data were not removed.');
    }
    if (action === 'rollback') {
        const previous = row.value.previous;
        if (!previous) throw new HttpError(409, 'NO_EXTENSION_ROLLBACK', 'There is no previous installed version to restore.');
        if (previous.kind === 'bundled') {
            const available = await bundledSnapshot(request, env, row.value.name);
            if (available?.commit !== previous.commit) throw new HttpError(409, 'BUNDLED_ROLLBACK_UNAVAILABLE', 'The original bundled version is no longer in this deployment.');
        } else {
            for (const key of objectKeys(previous)) {
                const object = await env.FILES.get(key, { range: { offset: 0, length: 1 } });
                if (!object) throw new HttpError(409, 'EXTENSION_ROLLBACK_MISSING', 'The previous archive is missing. The active version was not changed.');
                await object.body?.cancel();
            }
        }
        await saveState(env, row, { ...row.value, current: previous, previous: current });
        return Response.json({ shortCommitHash: previous.commit.slice(0, 7), extensionPath: path });
    }
    const source = repositoryUrl(current.remoteUrl);
    if (action === 'version') {
        const store = new Documents(env.DB);
        const id = `${source.url}#${current.ref}`;
        const cached = await store.get('extension-check', id);
        let remote = current.kind === 'archive' && current.refKind === 'commit' ? current
            : cached?.value?.expires > Date.now() && cached.value.version?.commit === current.commit ? cached.value.version : null;
        if (!remote) {
            remote = await resolveRepository(source, current.ref, request.signal);
            await store.put('extension-check', id, { expires: Date.now() + 60000, version: remote });
        }
        return Response.json({
            currentBranchName: current.refKind === 'branch' ? current.ref : '',
            currentCommitHash: current.commit, isUpToDate: current.commit === remote.commit, remoteUrl: current.remoteUrl,
            ref: current.ref, refKind: current.refKind, canRollback: Boolean(row.value.previous), canMove: false,
        });
    }
    if (action === 'branches') return Response.json(await repositoryBranches(source, current, request.signal));
    if (action === 'update' || action === 'switch') {
        const ref = action === 'switch' ? repositoryRef(typeof body.branch === 'string' ? body.branch.replace(/^origin\//, '') : body.branch) : current.ref;
        if (action === 'switch' && !ref) throw new HttpError(400, 'INVALID_EXTENSION_REF', 'Choose a branch to switch to.');
        const result = await installVersion(request, env, row, source, ref);
        if (action === 'switch') return new Response(null, { status: 204 });
        return Response.json({ shortCommitHash: result.current.commit.slice(0, 7), extensionPath: path,
            isUpToDate: result.isUpToDate, remoteUrl: result.current.remoteUrl });
    }
    throw new HttpError(501, 'EXTENSION_OPERATION_UNSUPPORTED', 'This extension operation is not implemented.');
}

export async function extensionAsset(request, env, pathname) {
    const raw = pathname.slice(PREFIX.length);
    const separator = raw.indexOf('/');
    let name, relative;
    try {
        name = extensionName(decodeURIComponent(separator < 0 ? raw : raw.slice(0, separator)));
        relative = pluginPath(decodeURIComponent(separator < 0 ? '' : raw.slice(separator + 1)));
    } catch { throw new HttpError(400, 'INVALID_EXTENSION_PATH', 'A valid plugin resource path is required.'); }
    if (relative.split('/').some(part => part.startsWith('.'))) return new Response('Not found', { status: 404 });
    const store = new Documents(env.DB);
    const local = await store.get(KIND, identity('local', name));
    const global = await store.get(KIND, identity('global', name));
    const snapshot = local?.value.current
        ?? (local === null ? await bundledSnapshot(request, env, name) : null)
        ?? global?.value.current;
    if (!snapshot) return new Response('Not found', { status: 404 });
    if (snapshot.kind === 'bundled') {
        const available = await bundledSnapshot(request, env, name);
        if (available?.commit !== snapshot.commit) throw new HttpError(503, 'BUNDLED_EXTENSION_CHANGED', 'The recorded bundled version is no longer available.');
        return env.ASSETS.fetch(new Request(new URL(`${assetPath(snapshot.folder)}${relative.split('/').map(encodeURIComponent).join('/')}`, request.url), { method: request.method }));
    }
    if (relative === 'manifest.json') return new Response(request.method === 'HEAD' ? null : JSON.stringify(snapshot.manifest),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    if (relative === '__source.zip') {
        const source = await new Files(env.FILES).get(snapshot.archiveKey);
        if (request.method === 'HEAD') await source.body?.cancel();
        return new Response(request.method === 'HEAD' ? null : source.body, { headers: {
            'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="extension-source.zip"',
        } });
    }
    const object = await new Files(env.FILES).get(snapshot.indexKey);
    let index;
    try {
        index = JSON.parse(new TextDecoder().decode(await readBytes(new Response(object.body), MAX_INDEX_BYTES)));
        if (!index.files || typeof index.files !== 'object' || Array.isArray(index.files)) throw new Error('Invalid index.');
    }
    catch { throw new HttpError(503, 'EXTENSION_INDEX_INVALID', 'The stored extension index is unavailable or invalid.'); }
    const entry = Object.hasOwn(index.files, relative) ? index.files[relative] : null;
    if (!entry) return new Response('Not found', { status: 404 });
    if (![entry.offset, entry.compressed, entry.size, entry.method, entry.crc].every(Number.isSafeInteger)
        || entry.offset < 0 || entry.compressed < 0 || entry.offset + entry.compressed > snapshot.archiveBytes
        || entry.size < 0 || entry.size > 25 * 1024 * 1024 || ![0, 8].includes(entry.method)) {
        throw new HttpError(503, 'EXTENSION_INDEX_INVALID', 'The stored extension index is invalid.');
    }
    const headers = { 'Content-Type': lookup(relative) || 'application/octet-stream', 'Content-Length': String(entry.size) };
    if (request.method === 'HEAD') return new Response(null, { headers });
    let compressed = new Uint8Array();
    if (entry.compressed) {
        const part = await env.FILES.get(snapshot.archiveKey, { range: { offset: entry.offset, length: entry.compressed } });
        if (!part) throw new HttpError(503, 'EXTENSION_ARCHIVE_MISSING', 'The installed extension archive is missing.');
        compressed = await readBytes(new Response(part.body), entry.compressed);
    }
    return new Response(inflateEntry(compressed, entry), { headers });
}
