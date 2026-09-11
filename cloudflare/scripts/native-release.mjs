import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readBytes } from '../src/http.js';
import { checkAssets } from './cloud-config.mjs';
import { readReleaseSelection } from './actions-release.mjs';
import { digest } from './plugin-package.mjs';
import { validatePluginLock } from './plugin-list.mjs';
import { buildEnvironment, inspectNativeBindings, nativeContext, validateNativeConfig } from './native-profile.mjs';

const STATE_TABLE = 'stworkers_deployment_state';
const SELECT_TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
const assetProfile = { assets: { directory: '../../.build/assets-p3' } };

export async function readNativeJson(file, limit = 1024 * 1024) {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= limit, 'Expected bounded, regular build metadata.');
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('Invalid build metadata JSON. Values are not logged.'); }
}

export function runNativeNode(root, args, env, capture = false) {
    return execFileSync(process.execPath, args, { cwd: root, windowsHide: true,
        timeout: 10 * 60 * 1000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
}

async function nativeOutput(root) {
    const build = path.join(root, 'cloudflare/.build');
    await mkdir(build, { recursive: true });
    assert.equal(await realpath(build), build, 'Refusing a linked build directory.');
    const output = path.join(build, 'native');
    await mkdir(output, { recursive: true });
    assert.equal(await realpath(output), output, 'Refusing a linked native output directory.');
    return output;
}

async function saveJson(file, value) {
    try {
        const info = await lstat(file);
        assert.ok(info.isFile() && !info.isSymbolicLink(), 'Refusing linked output metadata.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

export function nativeToken(root, env, run = runNativeNode) {
    let token = env.CLOUDFLARE_API_TOKEN;
    if (!token) {
        try {
            const value = JSON.parse(run(root, ['cloudflare/node_modules/wrangler/bin/wrangler.js',
                'auth', 'token', '--json', '--config', 'wrangler.jsonc'], env, true));
            assert.ok(['oauth', 'api_token'].includes(value.type));
            token = value.token;
        } catch { throw new Error('Cannot obtain the platform build credential. Check Workers Builds authorization.'); }
    }
    assert.ok(typeof token === 'string' && token.length >= 20 && token.length <= 512 && !/\s/.test(token),
        'The platform build credential is missing or invalid.');
    return token;
}

export function nativeClient(config, context, token, { fetchImpl = fetch } = {}) {
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${context.accountId}`;
    const queryPath = `/d1/database/${config.d1_databases[0].database_id}/query`;
    async function request(suffix, { method = 'GET', body, expectedStatuses = [200] } = {}) {
        let response, result;
        try {
            response = await fetchImpl(prefix + suffix, {
                method, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(60000),
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!expectedStatuses.includes(response.status)) {
                await response.body?.cancel();
                throw new Error();
            }
            result = JSON.parse(Buffer.from(await readBytes(response, 1024 * 1024)).toString('utf8'));
            assert.ok(result.success === true && result.result !== undefined);
        } catch {
            throw new Error(`Cloudflare ${method} check failed (HTTP ${response?.status ?? 'unavailable'}). `
                + 'Check resource provisioning and build-token permissions. No error body or credential is logged.');
        }
        return result.result;
    }
    return {
        settings: () => request(`/workers/scripts/${context.name}/settings`),
        database: () => request(`/d1/database/${config.d1_databases[0].database_id}`),
        bucket: () => request(`/r2/buckets/${config.r2_buckets[0].bucket_name}`),
        async query(sql, params = []) {
            const result = await request(queryPath, { method: 'POST', body: { sql, params } });
            assert.ok(result.length === 1 && result[0].success === true && Array.isArray(result[0].results),
                'D1 returned an invalid result. Nothing is treated as a successful migration.');
            return result[0].results;
        },
        async createDataKey(key) {
            const result = await request(`/workers/scripts/${context.name}/secrets`, {
                method: 'PUT', expectedStatuses: [200, 201],
                body: { name: 'DATA_KEY', type: 'secret_text', text: key },
            });
            assert.ok(result?.name === 'DATA_KEY' && result?.type === 'secret_text',
                'Cloudflare did not confirm the expected DATA_KEY secret. Inspect existing bindings before retrying.');
        },
    };
}

async function schema(client) {
    const rows = await client.query(SELECT_TABLES);
    const names = rows.map(row => row.name);
    assert.ok(names.every(name => typeof name === 'string' && (
        ['documents', STATE_TABLE, 'd1_migrations', 'stworkers_accounts', 'stworkers_sessions',
            'stworkers_login_limits'].includes(name) || name.startsWith('sqlite_') || name.startsWith('_cf_'))),
    'The selected database has unrelated tables. Select a new database; do not adopt unrelated data.');
    return new Set(names);
}

async function state(client, id) {
    const rows = await client.query(`SELECT payload FROM ${STATE_TABLE} WHERE id = ?`, [id]);
    assert.ok(rows.length <= 1, 'Invalid deployment state.');
    if (!rows.length) return null;
    try { return JSON.parse(rows[0].payload); }
    catch { throw new Error('Invalid saved deployment state. Do not replace it automatically.'); }
}

export async function previousNativePlugins(client) {
    if (!(await schema(client)).has(STATE_TABLE)) return { schema: 1, plugins: [] };
    const previous = await state(client, 'plugins');
    return previous === null ? { schema: 1, plugins: [] } : validatePluginLock(previous);
}

export async function initializeAndDeploy(config, context, lock, client, {
    migrate, upload, randomKey = () => randomBytes(32).toString('base64'),
} = {}) {
    validateNativeConfig(config, { provisioned: true });
    validatePluginLock(lock);
    assert.equal((await client.database()).name, config.d1_databases[0].database_name, 'D1 name differs from selected binding.');
    assert.equal((await client.bucket()).name, config.r2_buckets[0].bucket_name, 'R2 name differs from selected binding.');
    const initial = inspectNativeBindings(config, (await client.settings()).bindings);
    const tables = await schema(client);
    const count = tables.has('documents') ? (await client.query('SELECT count(*) AS count FROM documents'))[0]?.count : 0;
    assert.ok(Number.isSafeInteger(count) && count >= 0, 'Cannot verify existing document count.');
    const accounts = tables.has('stworkers_accounts')
        ? (await client.query('SELECT count(*) AS count FROM stworkers_accounts'))[0]?.count : 0;
    assert.ok(Number.isSafeInteger(accounts) && accounts >= 0, 'Cannot verify existing account count.');
    const initialization = tables.has(STATE_TABLE) ? await state(client, 'initialization') : null;
    if (!initial.hasDataKey) {
        assert.ok(count === 0 && accounts === 0 && initialization === null,
            'DATA_KEY is missing but data or an initialization claim exists. Restore the original key; never regenerate it.');
    }
    await migrate();
    let initializedKey = false;
    if (!initial.hasDataKey) {
        const claim = JSON.stringify({ schema: 1, status: 'pending', buildId: context.buildId });
        const inserted = await client.query(`INSERT INTO ${STATE_TABLE} (id, payload)
            SELECT 'initialization', ? WHERE NOT EXISTS (SELECT 1 FROM documents)
            AND NOT EXISTS (SELECT 1 FROM stworkers_accounts)
            ON CONFLICT(id) DO NOTHING RETURNING id`, [claim]);
        assert.ok(inserted.length === 1,
            'Another initialization is pending or data appeared. No encryption key was generated or replaced.');
        // Persist the secret before uploading large assets. A failed upload can then safely inherit it on retry.
        const key = randomKey();
        assert.ok(typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key)
            && Buffer.from(key, 'base64').length === 32, 'Invalid generated encryption key.');
        await client.createDataKey(key);
        initializedKey = true;
    }
    const current = inspectNativeBindings(config, (await client.settings()).bindings);
    assert.ok(current.hasDataKey, 'Encryption-key initialization was not confirmed. Do not upload or generate another key.');
    await upload();
    inspectNativeBindings(config, (await client.settings()).bindings, { complete: true });
    await client.query(`INSERT INTO ${STATE_TABLE} (id, payload) VALUES ('plugins', ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [JSON.stringify(lock)]);
    await client.query(`INSERT INTO ${STATE_TABLE} (id, payload) VALUES ('initialization', ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [JSON.stringify({ schema: 1, status: 'ready', buildId: context.buildId })]);
    return { initializedKey, existingKeyInherited: !initializedKey, migrationsCompleted: true,
        uploadCompleted: true, bindingsVerified: true, pluginLockSaved: true, runtimeVerified: false };
}

export async function buildNativeRelease(projectRoot, env, { run = runNativeNode, fetchImpl = fetch } = {}) {
    const root = await realpath(projectRoot);
    const config = validateNativeConfig(await readNativeJson(path.join(root, 'wrangler.jsonc')));
    const output = await nativeOutput(root);
    await saveJson(path.join(output, 'release.json'), { passed: false, stage: 'build-incomplete' });
    let previous = { schema: 1, plugins: [] };
    if (env.WORKERS_CI === '1') {
        const context = nativeContext(config, env);
        const token = nativeToken(root, env, run);
        previous = await previousNativePlugins(nativeClient(config, context, token, { fetchImpl }));
    }
    await saveJson(path.join(output, 'previous-lock.json'), previous);
    await run(root, ['cloudflare/scripts/native-cloud.mjs', 'bundle'], buildEnvironment(env));
    const { receipt, lock } = await readReleaseSelection(path.join(root, 'cloudflare'));
    const assets = await checkAssets(path.join(root, 'cloudflare'), assetProfile, {}, lock.plugins);
    const revision = run(root, ['-e', "process.stdout.write(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())"],
        buildEnvironment(env), true).trim();
    assert.match(revision, /^[a-f0-9]{40}$/);
    if (env.WORKERS_CI === '1') assert.equal(revision, env.WORKERS_CI_COMMIT_SHA, 'The build revision differs from platform metadata.');
    const result = { passed: true, stage: 'build-and-dry-run-only', cloudDeployed: false, revision,
        configSha256: digest(await readFile(path.join(root, 'wrangler.jsonc'))),
        receiptSha256: digest(Buffer.from(JSON.stringify(receipt))),
        plugins: assets.plugins, files: assets.files, bytes: assets.bytes };
    await saveJson(path.join(output, 'release.json'), result);
    return result;
}

export async function deployNativeRelease(projectRoot, env, { run = runNativeNode, fetchImpl = fetch } = {}) {
    const root = await realpath(projectRoot);
    const configFile = path.join(root, 'wrangler.jsonc');
    const config = await readNativeJson(configFile);
    const context = nativeContext(config, env);
    const output = await nativeOutput(root);
    const built = await readNativeJson(path.join(output, 'release.json'));
    const { receipt, lock } = await readReleaseSelection(path.join(root, 'cloudflare'));
    assert.ok(built.passed && built.stage === 'build-and-dry-run-only' && built.revision === context.revision
        && built.configSha256 === digest(await readFile(configFile))
        && built.receiptSha256 === digest(Buffer.from(JSON.stringify(receipt))), 'A matching native build is required before deployment.');
    const token = nativeToken(root, env, run);
    await checkAssets(path.join(root, 'cloudflare'), assetProfile, { token }, lock.plugins);
    const client = nativeClient(config, context, token, { fetchImpl });
    const wrangler = 'cloudflare/node_modules/wrangler/bin/wrangler.js';
    let migrationStarted = false, uploadStarted = false;
    try {
        const result = await initializeAndDeploy(config, context, lock, client, {
            migrate: async () => {
                migrationStarted = true;
                await run(root, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configFile], env);
            },
            upload: async () => {
                uploadStarted = true;
                await run(root, [wrangler, 'deploy', '--config', configFile, '--strict',
                    '--x-auto-create=false', '--no-x-provision', '--message', `STWorkers native build ${context.revision}`], env);
            },
        });
        await saveJson(path.join(output, 'deployment.json'), { ...result, name: context.name, revision: context.revision });
        return result;
    } catch (error) {
        await saveJson(path.join(output, 'deployment.json'), { passed: false, migrationStarted, uploadStarted });
        const reason = typeof error.status === 'number' || error.stdout || error.stderr
            ? 'A Wrangler command failed; review its redacted output.' : error.message;
        throw new Error(`Native deployment did not finish verification. Migration started: ${migrationStarted}; upload started: ${uploadStarted}. `
            + `${reason} Inspect Cloudflare before retrying. Never delete resources or replace DATA_KEY to bypass a failed check.`);
    }
}
