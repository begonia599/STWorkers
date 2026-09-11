import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const NATIVE_DATABASE_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const resourceName = /^[a-z][a-z0-9-]{1,45}[a-z0-9]$/;

export function createNativeConfig({
    name = 'stworkers', databaseName = 'stworkers-db', databaseId = NATIVE_DATABASE_PLACEHOLDER,
    bucketName = 'stworkers-files', accountId,
} = {}) {
    assert.ok(resourceName.test(name) && resourceName.test(databaseName) && resourceName.test(bucketName),
        'Use 3-47 lowercase letters, numbers and hyphens for the Worker and resource names.');
    assert.ok(uuid.test(databaseId), 'The deploy button must configure a valid D1 database ID.');
    assert.ok(accountId === undefined || /^[a-f0-9]{32}$/i.test(accountId), 'Invalid Cloudflare account ID.');
    return {
        $schema: 'cloudflare/node_modules/wrangler/config-schema.json',
        name, ...(accountId ? { account_id: accountId } : {}), main: 'cloudflare/src/index.js',
        compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
        workers_dev: true, preview_urls: false, send_metrics: false, observability: { enabled: false },
        assets: { directory: 'cloudflare/.build/assets-p3', binding: 'ASSETS', run_worker_first: true,
            html_handling: 'none', not_found_handling: 'none' },
        secrets: { required: ['AUTH_PASSWORD', 'DATA_KEY'] },
        d1_databases: [{ binding: 'DB', database_name: databaseName, database_id: databaseId,
            migrations_dir: 'cloudflare/migrations' }],
        r2_buckets: [{ binding: 'FILES', bucket_name: bucketName }],
    };
}

export function validateNativeConfig(config, { provisioned = false } = {}) {
    const expected = createNativeConfig({
        name: config.name, accountId: config.account_id,
        databaseName: config.d1_databases?.[0]?.database_name,
        databaseId: config.d1_databases?.[0]?.database_id,
        bucketName: config.r2_buckets?.[0]?.bucket_name,
    });
    assert.ok(isDeepStrictEqual(config, expected),
        'Native configuration differs from the protected template; only names, account and database ID may change.');
    assert.ok(!provisioned || config.d1_databases[0].database_id !== NATIVE_DATABASE_PLACEHOLDER,
        'The deploy button must provision D1 before native deployment. The example ID cannot be deployed.');
    return config;
}

export function nativeContext(config, env) {
    validateNativeConfig(config, { provisioned: true });
    assert.ok(env.WORKERS_CI === '1' && env.CI === 'true' && env.WORKERS_CI_BRANCH === 'main'
        && /^[a-f0-9]{40}$/i.test(env.WORKERS_CI_COMMIT_SHA ?? '')
        && uuid.test(env.WORKERS_CI_BUILD_UUID ?? ''),
    'Native deployment requires a Workers Builds production run on main; local and preview deployment are refused.');
    const accountId = env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
    assert.ok(/^[a-f0-9]{32}$/i.test(accountId ?? '')
        && (!config.account_id || config.account_id === accountId), 'The selected Cloudflare account is missing or differs.');
    const name = env.WRANGLER_CI_OVERRIDE_NAME || config.name;
    assert.ok(resourceName.test(name), 'The platform Worker name is invalid.');
    return { name, accountId, revision: env.WORKERS_CI_COMMIT_SHA, buildId: env.WORKERS_CI_BUILD_UUID };
}

export function buildEnvironment(env) {
    const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ComSpec',
        'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
        'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
    return { ...Object.fromEntries(allowed.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])),
        CI: 'true', WRANGLER_SEND_METRICS: 'false', STWORKERS_WORKER_NAME: 'stworkers-native-build' };
}

export function inspectNativeBindings(config, bindings, { complete = false } = {}) {
    assert.ok(Array.isArray(bindings), 'Worker bindings cannot be verified.');
    const expected = [
        { name: 'AUTH_PASSWORD', type: 'secret_text' },
        { name: 'DATA_KEY', type: 'secret_text' },
        { name: 'ASSETS', type: 'assets' },
        { name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
        { name: 'FILES', type: 'r2_bucket', bucket_name: config.r2_buckets[0].bucket_name },
    ];
    for (const entry of bindings) {
        const required = expected.find(item => item.name === entry.name);
        assert.ok(required && bindings.filter(item => item.name === entry.name).length === 1
            && Object.entries(required).every(([key, value]) => entry[key] === value),
        'Existing Worker bindings differ. Do not replace another instance or its storage.');
    }
    assert.ok(bindings.some(item => item.name === 'AUTH_PASSWORD'),
        'Set AUTH_PASSWORD in the deployment setup before uploading the application.');
    if (complete) assert.ok(expected.every(item => bindings.some(binding => binding.name === item.name)),
        'The initialized Worker is missing required bindings or secrets. Restore them; do not regenerate a key.');
    return { hasDataKey: bindings.some(item => item.name === 'DATA_KEY') };
}
