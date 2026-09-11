import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const DEFAULT_CLOUD_NAME = 'stworks-cloud-test';
export const ACCOUNT_PLACEHOLDER = 'REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID';
export const DATABASE_PLACEHOLDER = 'REPLACE_WITH_TEST_D1_DATABASE_ID';

function requireValue(condition, message) {
    if (!condition) throw new Error(message);
}

function validateName(name, base) {
    requireValue(typeof name === 'string' && /^[a-z][a-z0-9-]{1,45}[a-z0-9]$/.test(name)
        && name !== base.name, 'Use a 3-47 character cloud test name different from the local Worker name.');
}

function validateAccount(value, draft) {
    requireValue(typeof value === 'string' && (/^[a-f0-9]{32}$/i.test(value)
        || (draft && value === ACCOUNT_PLACEHOLDER)), 'Set account_id to your Cloudflare account ID before upload.');
}

function validateDatabase(value, draft) {
    requireValue(typeof value === 'string' && (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
        || (draft && value === DATABASE_PLACEHOLDER)), 'Set database_id to the separate test D1 ID before upload.');
}

export function createCloudConfig(base, {
    name = DEFAULT_CLOUD_NAME, accountId = ACCOUNT_PLACEHOLDER, databaseId = DATABASE_PLACEHOLDER,
    withP3Plugins = false,
} = {}) {
    validateName(name, base);
    validateAccount(accountId, true);
    validateDatabase(databaseId, true);
    requireValue(!base.d1_databases?.some(database => database.database_id === databaseId),
        'The cloud test database must not reuse the base configuration database ID.');
    return {
        $schema: '../../node_modules/wrangler/config-schema.json',
        name,
        account_id: accountId,
        main: '../../src/index.js',
        compatibility_date: base.compatibility_date,
        compatibility_flags: [...base.compatibility_flags],
        workers_dev: true,
        preview_urls: false,
        send_metrics: false,
        observability: { enabled: false },
        assets: {
            directory: `../../.build/${withP3Plugins ? 'assets-p3' : 'assets'}`,
            binding: 'ASSETS', run_worker_first: true,
            html_handling: 'none', not_found_handling: 'none',
        },
        secrets: { required: ['AUTH_PASSWORD', 'DATA_KEY'] },
        d1_databases: [{
            binding: 'DB', database_name: `${name}-db`, database_id: databaseId,
            migrations_dir: '../../migrations',
        }],
        r2_buckets: [{ binding: 'FILES', bucket_name: `${name}-files` }],
    };
}

export function validateCloudConfig(config, base, name, { draft = false } = {}) {
    const expected = createCloudConfig(base, {
        name, accountId: config.account_id, databaseId: config.d1_databases?.[0]?.database_id,
        withP3Plugins: config.assets?.directory === '../../.build/assets-p3',
    });
    const actual = { ...config };
    // Old deployments may retain the now-unused variable; do not require manual migration.
    if (actual.vars && typeof actual.vars === 'object' && !Array.isArray(actual.vars)
        && Object.keys(actual.vars).every(key => key === 'MODEL_ALLOWED_ORIGINS')) {
        delete actual.vars;
    }
    // Keep deployment hooks, extra bindings and authentication bypasses out of this test profile.
    requireValue(isDeepStrictEqual(actual, expected),
        'Cloud test configuration differs from the safe profile. Only account_id and database_id are editable.');
    validateAccount(config.account_id, draft);
    validateDatabase(config.d1_databases[0].database_id, draft);
    return config.account_id !== ACCOUNT_PLACEHOLDER && config.d1_databases[0].database_id !== DATABASE_PLACEHOLDER;
}

export function validateCloudSecrets(secrets) {
    requireValue(secrets && isDeepStrictEqual(Object.keys(secrets).sort(), ['AUTH_PASSWORD', 'DATA_KEY']),
        'The secrets file must contain only AUTH_PASSWORD and DATA_KEY.');
    requireValue(typeof secrets.AUTH_PASSWORD === 'string' && /^[A-Za-z0-9_-]{48}$/.test(secrets.AUTH_PASSWORD),
        'AUTH_PASSWORD must be the independent 48-character generated password.');
    requireValue(typeof secrets.DATA_KEY === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(secrets.DATA_KEY)
        && Buffer.from(secrets.DATA_KEY, 'base64').length === 32
        && Buffer.from(secrets.DATA_KEY, 'base64').toString('base64') === secrets.DATA_KEY,
    'DATA_KEY must be a canonical base64-encoded 32-byte key. Never regenerate an in-use key.');
}

async function readJson(file, limit = 256 * 1024) {
    const information = await lstat(file);
    requireValue(information.isFile() && !information.isSymbolicLink() && information.size <= limit,
        'Expected a regular JSON file within the size limit.');
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('Invalid JSON in a deployment input. Values are not logged.'); }
}

async function cloudDirectory(root, name) {
    const directory = path.join(root, '.deploy', name);
    const information = await lstat(directory);
    requireValue(information.isDirectory() && !information.isSymbolicLink()
        && await realpath(directory) === directory, 'Refusing a linked cloud deployment directory.');
    return directory;
}

export async function prepareCloud(workerRoot, options = {}) {
    const root = await realpath(workerRoot);
    const base = await readJson(path.join(root, 'wrangler.jsonc'));
    const name = options.name ?? DEFAULT_CLOUD_NAME;
    const config = createCloudConfig(base, { ...options, name });
    const parent = path.join(root, '.deploy');
    await mkdir(parent, { recursive: true });
    requireValue(await realpath(parent) === parent && !(await lstat(parent)).isSymbolicLink(),
        'Refusing a linked .deploy directory.');
    const directory = path.join(parent, name);
    try {
        await mkdir(directory);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await cloudDirectory(root, name);
        const saved = await readJson(path.join(directory, 'wrangler.json'));
        validateCloudConfig(saved, base, name, { draft: true });
        validateCloudSecrets(await readJson(path.join(directory, 'secrets.json'), 8192));
        const explicit = {
            accountId: saved.account_id, databaseId: saved.d1_databases[0].database_id,
            withP3Plugins: saved.assets.directory === '../../.build/assets-p3',
        };
        for (const key of Object.keys(explicit)) {
            requireValue(options[key] === undefined || isDeepStrictEqual(options[key], explicit[key]),
            'Existing cloud configuration differs from the requested options. Nothing was overwritten.');
        }
        return { created: false, directory, name };
    }
    // Exclusive files: an interrupted setup is not permission to replace an existing encryption key.
    await writeFile(path.join(directory, 'secrets.json'), `${JSON.stringify({
        AUTH_PASSWORD: randomBytes(36).toString('base64url'),
        DATA_KEY: randomBytes(32).toString('base64'),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    return { created: true, directory, name };
}

export async function checkAssets(root, config, secrets = {}) {
    const plugins = config.assets.directory === '../../.build/assets-p3';
    const build = path.join(root, '.build');
    requireValue(await realpath(build) === build, 'Refusing a linked build directory.');
    const assets = path.join(build, plugins ? 'assets-p3' : 'assets');
    requireValue(await realpath(assets) === assets, 'Refusing a linked assets directory.');
    const manifest = await readJson(path.join(build, plugins ? 'build-manifest-p3.json' : 'build-manifest.json'));
    const bootstrap = await readJson(path.join(assets, '__stworks', 'bootstrap.json'), 4 * 1024 * 1024);
    const expectedCount = plugins ? 2 : 0;
    requireValue(Array.isArray(manifest.extensionsBundled) && manifest.extensionsBundled.length === expectedCount,
        'Build the selected default or explicit P3 assets before this check.');
    const discovered = bootstrap.stworks?.extensions?.map(extension => extension.name);
    requireValue(isDeepStrictEqual(discovered, manifest.extensionsDiscovered)
        && discovered?.length === 2 + expectedCount && discovered.includes('regex') && discovered.includes('quick-reply'),
    'Asset discovery does not match the selected build manifest.');
    if (plugins) {
        const lock = await readJson(path.join(root, '..', 'upstream-lock.json'));
        for (const locked of lock.extensions) {
            requireValue(manifest.extensionsBundled.some(plugin => locked.commit === plugin.commit
                && plugin.name === `third-party/${locked.id}` && discovered.includes(plugin.name)),
                'P3 assets must use the pinned plugin commits.');
        }
    }
    let files = 0;
    let bytes = 0;
    let largestFileBytes = 0;
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            const trackedPlaceholder = path.relative(assets, file) === path.join('scripts', 'extensions', 'third-party', '.gitkeep');
            requireValue(!entry.isSymbolicLink() && (!entry.name.startsWith('.') || trackedPlaceholder)
                && !/^(secrets\.json|wrangler\..*|_worker\.js|_redirects|_headers)$/i.test(entry.name),
            'Private, linked or routing-control files must not be in deployment assets.');
            if (entry.isDirectory()) {
                await visit(file);
                continue;
            }
            requireValue(entry.isFile(), 'Deployment assets must be regular files.');
            const information = await lstat(file);
            requireValue(!trackedPlaceholder || information.size === 0, 'The tracked .gitkeep placeholder must remain empty.');
            files++;
            requireValue(files <= 20000 && information.size <= 25 * 1024 * 1024,
                'Assets exceed the checked Free-plan file-count or per-file limit.');
            const contents = await readFile(file);
            requireValue(!Object.values(secrets).some(secret => contents.includes(Buffer.from(secret))),
                'A deployment secret was found in static assets. Do not upload.');
            bytes += information.size;
            largestFileBytes = Math.max(largestFileBytes, information.size);
        }
    }
    await visit(assets);
    requireValue(files === manifest.totalAssetFiles && bytes === manifest.totalAssetBytes,
        'Assets differ from the build inventory. Rebuild and repeat this check.');
    return { files, bytes, largestFileBytes, plugins: manifest.extensionsBundled };
}

export async function checkCloud(workerRoot, { name = DEFAULT_CLOUD_NAME, draft = false } = {}) {
    const root = await realpath(workerRoot);
    const base = await readJson(path.join(root, 'wrangler.jsonc'));
    validateName(name, base);
    const directory = await cloudDirectory(root, name);
    const config = await readJson(path.join(directory, 'wrangler.json'));
    const resourceIdsConfigured = validateCloudConfig(config, base, name, { draft });
    const secrets = await readJson(path.join(directory, 'secrets.json'), 8192);
    validateCloudSecrets(secrets);
    const assets = await checkAssets(root, config, secrets);
    return {
        name, resourceIdsConfigured, assets,
        validation: resourceIdsConfigured ? 'offline-preflight-only' : 'draft-only-resource-ids-required',
        cloudVerified: false,
    };
}
