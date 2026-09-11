import { HttpError, readBytes } from './http.js';

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export function extensionName(value) {
    if (typeof value !== 'string') throw new HttpError(400, 'INVALID_EXTENSION_NAME', 'An extension folder name is required.');
    const name = value.replace(/^third-party\//, '').replace(/^\//, '');
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/.test(name) || /[.]$/.test(name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw new HttpError(400, 'INVALID_EXTENSION_NAME', 'Use the extension folder name, not a filesystem path.');
    }
    return name;
}

export function repositoryUrl(value) {
    let url;
    try { url = new URL(value); } catch { /* Rejected below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
        throw new HttpError(400, 'INVALID_REPOSITORY_URL', 'Use a public HTTPS repository URL without credentials or query parameters.');
    }
    if (!['github.com', 'gitlab.com'].includes(url.hostname)) {
        throw new HttpError(422, 'UNSUPPORTED_REPOSITORY_HOST', 'Public github.com and gitlab.com repositories are supported. Other Git hosts are not implemented yet.');
    }
    const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').slice(1).split('/');
    if (parts.length < 2 || (url.hostname === 'github.com' && parts.length !== 2)
        || parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/.test(part) || part.endsWith('.'))) {
        throw new HttpError(400, 'INVALID_REPOSITORY_URL', 'Use the repository root URL; enter a branch or tag separately.');
    }
    const name = extensionName(parts.at(-1));
    const project = parts.join('/');
    return {
        host: url.hostname, project, name, url: `https://${url.hostname}/${project}`,
        api: url.hostname === 'github.com'
            ? `https://api.github.com/repos/${project}`
            : `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}`,
    };
}

export function repositoryRef(value) {
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' || value.length > 200 || /[\s\x00-\x1f~^:?*[\]\\%#]/.test(value)
        || value.includes('..') || value.includes('@{') || value.startsWith('-')
        || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
        throw new HttpError(400, 'INVALID_EXTENSION_REF', 'Use a valid branch, tag, or full commit ID.');
    }
    return value;
}

async function remoteBytes(url, signal, maximum, missing = false) {
    let response;
    try {
        response = await fetch(url, {
            method: 'GET', redirect: 'manual',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]),
            headers: { Accept: 'application/json, application/zip', 'User-Agent': 'STWorkers-extension-installer' },
        });
        if (response.status === 404 && missing) {
            await response.body?.cancel();
            return null;
        }
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status >= 300 && response.status < 400) {
                throw new HttpError(409, 'REPOSITORY_REDIRECT', 'The repository redirected. Use its current canonical repository URL.');
            }
            if (response.status === 429 || (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0')) {
                throw new HttpError(429, 'REPOSITORY_RATE_LIMIT', 'The Git host rate limit was reached. Wait before retrying.');
            }
            throw new HttpError(response.status === 404 ? 404 : 502, 'REPOSITORY_DOWNLOAD_FAILED',
                'The public repository or requested version could not be downloaded.');
        }
        return await readBytes(response, maximum);
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(signal?.aborted ? 408 : 502, 'REPOSITORY_DOWNLOAD_INTERRUPTED', 'Repository download failed or was interrupted. The active version was not changed.');
    }
}

async function remoteJson(url, signal, missing = false) {
    const bytes = await remoteBytes(url, signal, 2 * 1024 * 1024, missing);
    if (bytes === null) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(502, 'INVALID_REPOSITORY_RESPONSE', 'The Git host returned invalid metadata.'); }
}

function commitId(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
        throw new HttpError(502, 'INVALID_REPOSITORY_COMMIT', 'The Git host did not return a full commit ID.');
    }
    return value.toLowerCase();
}

export async function resolveRepository(repo, reference, signal) {
    let ref = repositoryRef(reference);
    if (!ref) {
        const metadata = await remoteJson(repo.api, signal);
        if (metadata?.private || metadata?.visibility === 'private') {
            throw new HttpError(422, 'PRIVATE_REPOSITORY_UNSUPPORTED', 'Private repositories are not supported.');
        }
        ref = repositoryRef(metadata?.default_branch);
        if (!ref) throw new HttpError(422, 'EMPTY_REPOSITORY', 'The repository has no default branch.');
    }
    const github = repo.host === 'github.com';
    let kind = 'commit', commit;
    if (!/^[a-f0-9]{40}$/i.test(ref)) {
        const branch = await remoteJson(github
            ? `${repo.api}/git/ref/heads/${ref.split('/').map(encodeURIComponent).join('/')}`
            : `${repo.api}/repository/branches/${encodeURIComponent(ref)}`, signal, true);
        if (branch) {
            kind = 'branch';
            commit = github ? branch.object?.sha : branch.commit?.id;
        } else {
            let tag = await remoteJson(github
                ? `${repo.api}/git/ref/tags/${ref.split('/').map(encodeURIComponent).join('/')}`
                : `${repo.api}/repository/tags/${encodeURIComponent(ref)}`, signal, true);
            if (!tag) throw new HttpError(404, 'EXTENSION_REF_NOT_FOUND', 'The requested branch or tag does not exist.');
            kind = 'tag';
            if (github) {
                let object = tag.object;
                for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
                    tag = await remoteJson(`${repo.api}/git/tags/${commitId(object.sha)}`, signal);
                    object = tag.object;
                }
                if (object?.type !== 'commit') throw new HttpError(422, 'UNSUPPORTED_EXTENSION_TAG', 'The tag does not resolve to a commit.');
                commit = object.sha;
            } else commit = tag.commit?.id;
        }
    } else {
        const data = await remoteJson(github ? `${repo.api}/git/commits/${ref}`
            : `${repo.api}/repository/commits/${ref}`, signal);
        commit = github ? data.sha : data.id;
        if (commitId(commit) !== ref.toLowerCase()) {
            throw new HttpError(502, 'EXTENSION_COMMIT_MISMATCH', 'The Git host returned a different commit.');
        }
    }
    return { remoteUrl: repo.url, ref, refKind: kind, commit: commitId(commit) };
}

export async function downloadRepository(repo, version, signal) {
    return remoteBytes(repo.host === 'github.com'
        ? `https://codeload.github.com/${repo.project}/zip/${version.commit}`
        : `${repo.api}/repository/archive.zip?sha=${version.commit}`, signal, MAX_ARCHIVE_BYTES);
}

export async function repositoryBranches(repo, current, signal) {
    const all = [];
    for (let page = 1; page <= 3; page++) {
        const data = await remoteJson(`${repo.api}/${repo.host === 'github.com' ? 'branches' : 'repository/branches'}?per_page=100&page=${page}`, signal);
        if (!Array.isArray(data)) throw new HttpError(502, 'INVALID_REPOSITORY_RESPONSE', 'The Git host did not return a branch list.');
        for (const entry of data) {
            const name = repositoryRef(entry.name);
            all.push({ name: `origin/${name}`, commit: commitId(entry.commit?.sha ?? entry.commit?.id),
                current: current.refKind === 'branch' && current.ref === name, label: name });
        }
        if (data.length < 100) return all;
    }
    throw new HttpError(422, 'TOO_MANY_EXTENSION_BRANCHES', 'More than 300 branches are not supported by this bounded listing.');
}
