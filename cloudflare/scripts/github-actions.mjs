import { fileURLToPath } from 'node:url';

try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['guard', 'build', 'save-lock', 'deploy'].includes(action)) {
        throw new Error('Usage: node cloudflare/scripts/github-actions.mjs <guard|build|save-lock|deploy>');
    }
    // The early selection guard must work before npm dependencies are installed.
    if (action === 'guard') {
        if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
            || process.env.STWORKERS_DEPLOY !== 'true' || !process.env.STWORKERS_DEFAULT_BRANCH
            || process.env.GITHUB_REF !== `refs/heads/${process.env.STWORKERS_DEFAULT_BRANCH}`) {
            throw new Error('Deploy only from an explicit manual run on the repository default branch.');
        }
        console.log('Manual deployment selection accepted. No cloud operation performed.');
    } else {
        const { buildActionsRelease, deployActionsRelease } = await import('./actions-release.mjs');
        const root = fileURLToPath(new URL('../', import.meta.url));
        if (action === 'save-lock') {
            const { savePluginLock } = await import('./plugin-lock-github.mjs');
            await savePluginLock(root, process.env);
        } else await (action === 'build' ? buildActionsRelease : deployActionsRelease)(root, process.env);
    }
} catch (error) {
    // Child-process and assertion errors can contain arbitrary values. Keep CLI failure output generic.
    console.error('STWorkers Actions step failed. No further deployment steps will run.');
    if (error.constructor === Error) console.error(error.message);
    process.exitCode = 1;
}
