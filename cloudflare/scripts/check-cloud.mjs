import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCloud, DEFAULT_CLOUD_NAME } from './cloud-config.mjs';

try {
    const { values } = parseArgs({ options: {
        name: { type: 'string', default: DEFAULT_CLOUD_NAME },
        draft: { type: 'boolean', default: false },
        help: { type: 'boolean' },
    } });
    if (values.help) {
        console.log('check:cloud -- [--name NAME] [--draft]');
        console.log('--draft checks local files while permitting explicit resource-ID placeholders. It is not upload readiness.');
    } else {
        console.log(JSON.stringify(await checkCloud(fileURLToPath(new URL('../', import.meta.url)), values), null, 2));
        console.log('Offline only: account permissions, resource existence, subscriptions, usage and runtime behavior are not verified.');
    }
} catch (error) {
    console.error(`Cloud preflight failed: ${error.code ?? error.message}`);
    process.exitCode = 1;
}
