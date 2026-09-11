import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, MAX_PLUGIN_FILE, MAX_PLUGINS, readPinnedArchive, readPluginManifest,
    validatePluginPath, validatePluginRecord } from './plugin-package.mjs';
import { readBytes } from '../src/http.js';

export function parsePluginList(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024) throw new Error('plugins.txt exceeds 32 KiB.');
    const plugins = [], repositories = new Set(), folders = new Set();
    for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        try {
            const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,99})\/?(?:#([A-Za-z0-9][A-Za-z0-9._/-]{0,159}))?$/.exec(line);
            if (!match) throw new Error();
            const id = match[2].replace(/\.git$/, ''), repository = `${match[1]}/${id}`, ref = match[3] ?? 'HEAD';
            validatePluginPath(id);
            if (ref.includes('..') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error();
            if (repositories.has(repository.toLowerCase()) || folders.has(id.toLowerCase())) {
                throw new Error('Duplicate repository or plugin folder name.');
            }
            repositories.add(repository.toLowerCase());
            folders.add(id.toLowerCase());
            plugins.push({ id, repository, ref });
            if (plugins.length > MAX_PLUGINS) throw new Error(`At most ${MAX_PLUGINS} prebundled plugins are supported.`);
        } catch (error) {
            throw new Error(`plugins.txt line ${index + 1}: ${error.message || 'Use one public HTTPS GitHub repository URL, optionally followed by #branch, #tag or #commit.'}`);
        }
    }
    return plugins;
}

export function validatePluginLock(lock) {
    try {
        if (!lock || lock.schema !== 1 || !Array.isArray(lock.plugins) || lock.plugins.length > MAX_PLUGINS
            || Object.keys(lock).some(key => !['schema', 'plugins'].includes(key))) throw new Error();
        const folders = new Set(), archives = new Set();
        for (const plugin of lock.plugins) {
            validatePluginRecord(plugin);
            if (Object.keys(plugin).some(key => !['id', 'repository', 'ref', 'version', 'commit', 'archive', 'license', 'sha256', 'layout'].includes(key))) throw new Error();
            const parsed = parsePluginList(`https://github.com/${plugin.repository}#${plugin.ref}`)[0];
            if (!parsed || parsed.id !== plugin.id || parsed.ref !== plugin.ref || folders.has(plugin.id.toLowerCase())
                || archives.has(plugin.archive.toLowerCase())) throw new Error();
            folders.add(plugin.id.toLowerCase());
            archives.add(plugin.archive.toLowerCase());
        }
    } catch { throw new Error('Invalid plugins.lock.json. Restore the last working lock file; do not paste credentials into it.'); }
    return lock;
}

export function assertLockMatchesList(text, lock) {
    validatePluginLock(lock);
    const specs = parsePluginList(text);
    if (specs.length !== lock.plugins.length || specs.some((spec, index) => {
        const item = lock.plugins[index];
        return spec.repository.toLowerCase() !== item.repository.toLowerCase() || spec.ref !== item.ref;
    })) throw new Error('Plugin list and lock differ. Rebuild before deploying.');
}

export async function readPluginInputs(projectRoot) {
    async function read(name, optional = false) {
        try {
            const file = path.join(projectRoot, name), info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Invalid file.');
            return await readFile(file, 'utf8');
        } catch (error) {
            if (optional && error.code === 'ENOENT') return null;
            throw new Error(`Cannot read ${name} as a regular project file.`);
        }
    }
    const text = await read('plugins.txt'), saved = await read('plugins.lock.json', true);
    let lock;
    try { lock = saved === null ? { schema: 1, plugins: [] } : JSON.parse(saved); }
    catch { throw new Error('plugins.lock.json is not valid JSON. Restore the last working lock file.'); }
    return { text, specs: parsePluginList(text), lock: validatePluginLock(lock) };
}

export async function downloadPlugin(plugin, { fetchImpl = fetch, signal, verify = true } = {}) {
    // Revalidate the destination even when the caller supplied a generated lock entry.
    const spec = parsePluginList(`https://github.com/${plugin.repository}`)[0];
    if (!spec || !/^[a-f0-9]{40}$/.test(plugin.commit)) throw new Error('Invalid pinned plugin download.');
    const url = `https://codeload.github.com/${spec.repository}/zip/${plugin.commit}`;
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET', redirect: 'manual', credentials: 'omit',
            headers: { Accept: 'application/zip', 'User-Agent': 'STWorkers-build-time-installer' },
            signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
        });
        if (response.status !== 200) { await response.body?.cancel(); throw new Error(); }
        const bytes = Buffer.from(await readBytes(response, MAX_PLUGIN_FILE));
        if (verify && digest(bytes) !== plugin.sha256) throw new Error();
        return bytes;
    } catch {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        throw new Error(`Pinned plugin download or checksum verification failed: ${spec.id}. Nothing was deployed.`);
    }
}

async function resolveCommit(spec, fetchImpl) {
    if (/^[a-f0-9]{40}$/.test(spec.ref)) return spec.ref;
    let response;
    try {
        response = await fetchImpl(`https://api.github.com/repos/${spec.repository}/commits/${encodeURIComponent(spec.ref)}`, {
            method: 'GET', redirect: 'manual', credentials: 'omit',
            headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'STWorkers-build-time-installer',
                'X-GitHub-Api-Version': '2022-11-28' },
            signal: AbortSignal.timeout(30000),
        });
        if (response.status !== 200) { await response.body?.cancel(); throw new Error(); }
        const sha = Buffer.from(await readBytes(response, 4096)).toString('utf8').trim();
        if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error();
        return sha;
    } catch {
        throw new Error(`Cannot resolve public plugin ${spec.id}. Check the repository/ref and GitHub availability or rate limit. Nothing was deployed.`);
    }
}

export async function preparePluginSelection(text, previous, { update = false, fetchImpl = fetch } = {}) {
    validatePluginLock(previous);
    const plugins = [], archives = new Map();
    let archiveBytes = 0;
    for (const spec of parsePluginList(text)) {
        const old = previous.plugins.find(item => item.repository.toLowerCase() === spec.repository.toLowerCase()
            && item.ref === spec.ref);
        let plugin = old;
        if (!old || update) {
            const commit = await resolveCommit(spec, fetchImpl);
            if (old?.commit === commit) plugin = old;
            else {
                const bytes = await downloadPlugin({ ...spec, commit }, { fetchImpl, verify: false });
                const candidate = { ...spec, commit, archive: `${spec.id}.zip`, sha256: digest(bytes), layout: 'runtime' };
                const files = await readPinnedArchive(bytes, candidate);
                const manifest = readPluginManifest(files, spec.id);
                plugin = { ...candidate, version: String(manifest.version ?? 'unversioned'),
                    license: typeof manifest.license === 'string' && manifest.license ? manifest.license : 'SEE-SOURCE' };
                validatePluginRecord(plugin);
                archives.set(plugin.id, bytes);
            }
        }
        if (!archives.has(plugin.id)) archives.set(plugin.id, await downloadPlugin(plugin, { fetchImpl }));
        archiveBytes += archives.get(plugin.id).length;
        if (archiveBytes > 128 * 1024 * 1024) throw new Error('Selected plugin archives exceed the 128 MiB build limit. Reduce plugins.txt.');
        plugins.push(plugin);
    }
    const lock = validatePluginLock({ schema: 1, plugins });
    assertLockMatchesList(text, lock);
    return { lock, archives, changed: !isDeepStrictEqual(lock, previous) };
}
