import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CLOUD_NAME, prepareCloud } from './cloud-config.mjs';

try {
    const { values } = parseArgs({ options: {
        name: { type: 'string', default: DEFAULT_CLOUD_NAME },
        'account-id': { type: 'string' },
        'database-id': { type: 'string' },
        'with-p3-plugins': { type: 'boolean' },
        help: { type: 'boolean' },
    } });
    if (values.help) {
        console.log('setup:cloud -- [--name NAME] [--with-p3-plugins] [--account-id ID] [--database-id ID]');
        console.log('Local files only. No login, resource creation, downloads or upload. Existing files are never overwritten.');
    } else {
        const result = await prepareCloud(fileURLToPath(new URL('../', import.meta.url)), {
            name: values.name, accountId: values['account-id'], databaseId: values['database-id'],
            withP3Plugins: values['with-p3-plugins'],
        });
        console.log(`${result.created ? 'Created' : 'Kept existing'} local cloud-test files.`);
        console.log(`Configuration: ${path.join(result.directory, 'wrangler.json')}`);
        console.log(`Private credentials: ${path.join(result.directory, 'secrets.json')} (username: owner)`);
        console.log('Do not share the secrets file. Read docs/CLOUD-TEST.md before authorizing any remote action.');
    }
} catch (error) {
    console.error(`Cloud preparation failed: ${error.code ?? error.message}`);
    process.exitCode = 1;
}
