import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const upstreamCommit = JSON.parse(readFileSync(new URL('../../upstream-lock.json', import.meta.url), 'utf8')).sillytavern.commit;

export function assertPinnedSource(files) {
    for (const file of files) {
        const pinned = execFileSync('git', ['show', `${upstreamCommit}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString('utf8').replaceAll('\r\n', '\n');
        const local = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
        assert.equal(local, pinned, `Reference source changed: ${file}. Update the baseline deliberately.`);
    }
}

// Only Node tests import the original backend helpers. Configuration is the tracked public default.
assertPinnedSource(['src/prompt-converters.js', 'src/util.js', 'src/constants.js', 'src/endpoints/backends/chat-completions.js', 'default/config.yaml']);
const util = await import('../../src/util.js');
util.setConfigFilePath(fileURLToPath(new URL('../../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_PROMPTPLACEHOLDER = "Let's get started.";
export const reference = await import('../../src/prompt-converters.js');
export const originalFlattenSchema = util.flattenSchema;
export const constants = await import('../../src/constants.js');
