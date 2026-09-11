import { execFileSync } from 'node:child_process';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readReleaseSelection } from './actions-release.mjs';
import { readBytes } from '../src/http.js';

const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function requireValue(condition, message) {
    if (!condition) throw new Error(message);
}

export async function savePluginLock(workerRoot, env, { fetchImpl = fetch, head = root =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() } = {}) {
    requireValue(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        && env.STWORKERS_DEFAULT_BRANCH && env.GITHUB_REF === `refs/heads/${env.STWORKERS_DEFAULT_BRANCH}`,
    'Plugin lock saving requires a manual run on the default branch.');
    requireValue(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(env.GITHUB_REPOSITORY)
        && isSha(env.GITHUB_SHA), 'Invalid GitHub run identity.');
    requireValue(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length >= 20 && !/\s/.test(env.GITHUB_TOKEN),
        'The workflow needs its built-in GITHUB_TOKEN with contents: write to save plugins.lock.json.');
    requireValue(!env.CLOUDFLARE_API_TOKEN && !env.AUTH_PASSWORD && !env.DATA_KEY, 'Do not expose cloud secrets to the lock-saving step.');
    const root = await realpath(workerRoot);
    requireValue(head(root) === env.GITHUB_SHA, 'Checkout differs from the selected run revision.');
    const { receipt, lock } = await readReleaseSelection(root);
    const prefix = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
    async function request(relative, method = 'GET', body) {
        try {
            const response = await fetchImpl(prefix + relative, {
                method, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
                    'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (response.status !== (method === 'POST' ? 201 : 200)) {
                await response.body?.cancel();
                throw new Error();
            }
            return JSON.parse(Buffer.from(await readBytes(response, 2 * 1024 * 1024)).toString('utf8'));
        } catch {
            throw new Error('Could not confirm/save plugins.lock.json. Check Actions write permissions or branch rules and rerun the latest default branch. No cloud deployment was attempted by this step.');
        }
    }
    const branch = env.STWORKERS_DEFAULT_BRANCH.split('/').map(encodeURIComponent).join('/');
    const ref = `/git/ref/heads/${branch}`;
    const current = await request(ref);
    requireValue(current.ref === env.GITHUB_REF && current.object?.type === 'commit'
        && current.object.sha === env.GITHUB_SHA, 'The branch changed during the build. Rerun the latest revision; do not deploy this build.');
    let savedRevision = env.GITHUB_SHA;
    if (receipt.lockChanged) {
        const parent = await request(`/git/commits/${env.GITHUB_SHA}`);
        requireValue(parent.sha === env.GITHUB_SHA && isSha(parent.tree?.sha), 'Invalid base commit.');
        const tree = await request('/git/trees', 'POST', {
            base_tree: parent.tree.sha,
            tree: [{ path: 'plugins.lock.json', mode: '100644', type: 'blob', content: JSON.stringify(lock, null, 2) + '\n' }],
        });
        requireValue(isSha(tree.sha), 'Invalid lock tree.');
        const commit = await request('/git/commits', 'POST', {
            message: 'chore: lock selected STWorkers plugins', tree: tree.sha, parents: [env.GITHUB_SHA],
        });
        requireValue(isSha(commit.sha), 'Invalid lock commit.');
        // A non-fast-forward failure preserves any edits pushed since the run started.
        const updated = await request(`/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
        requireValue(updated.ref === env.GITHUB_REF && updated.object?.sha === commit.sha, 'Lock commit update was not confirmed.');
        savedRevision = commit.sha;
    }
    const file = path.join(root, '.build', 'actions', 'lock-saved.json');
    try { const info = await lstat(file); requireValue(info.isFile() && !info.isSymbolicLink(), 'Linked lock receipt.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = { schema: 1, repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF,
        sourceRevision: env.GITHUB_SHA, savedRevision, pluginLockSha256: receipt.pluginLockSha256 };
    await writeFile(file, JSON.stringify(result, null, 2) + '\n');
    console.log(receipt.lockChanged ? 'Saved only plugins.lock.json using the workflow token.' : 'Plugin lock unchanged; no repository commit needed.');
    return result;
}
