import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEnvironment } from './native-profile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cloud = process.env.WORKERS_CI === '1' || process.argv[2] === '--cloud';
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--cloud')) throw new Error('Unknown build option.');
function run(command, args, env) {
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true,
        shell: process.platform === 'win32' && command === npm });
    if (result.error || result.status !== 0) process.exit(result.status || 1);
}
if (cloud) {
    run(npm, ['--prefix', 'cloudflare', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], buildEnvironment(process.env));
    run(process.execPath, ['cloudflare/scripts/native-cloud.mjs', 'build'], process.env);
} else {
    run(npm, ['--prefix', 'cloudflare', 'run', 'build'], process.env);
}
