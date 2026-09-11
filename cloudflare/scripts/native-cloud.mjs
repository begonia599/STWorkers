import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildActionsRelease } from './actions-release.mjs';
import { buildNativeRelease, deployNativeRelease, readNativeJson } from './native-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const action = process.argv[2];
try {
    if (process.argv.length !== 3 || !['build', 'bundle', 'deploy'].includes(action)) throw new Error('Choose build or deploy explicitly.');
    let result;
    if (action === 'bundle') {
        const previousPluginLock = await readNativeJson(path.join(root, 'cloudflare/.build/native/previous-lock.json'));
        result = await buildActionsRelease(path.join(root, 'cloudflare'), process.env, { previousPluginLock });
    } else if (action === 'build') result = await buildNativeRelease(root, process.env);
    else result = await deployNativeRelease(root, process.env);
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    // Child-process exceptions can contain captured credentials or command output; never print their stack or stdout.
    console.error(`Native ${action ?? 'command'} failed: ${typeof error.status === 'number' || error.stdout || error.stderr
        ? 'A child command failed. Review its redacted output.' : error.message}`);
    process.exitCode = 1;
}
