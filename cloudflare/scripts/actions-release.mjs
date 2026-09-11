import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkAssets, createCloudConfig, validateCloudConfig } from './cloud-config.mjs';
import { digest, packagePlugins, validatePluginRecord } from './plugin-package.mjs';
import { assertLockMatchesList, downloadPlugin, preparePluginSelection, readPluginInputs, validatePluginLock } from './plugin-list.mjs';
import { readBytes } from '../src/http.js';

export function checkActionsContext(env) {
    assert.ok(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        && env.STWORKERS_DEPLOY === 'true', 'Deployment requires an explicit GitHub Actions manual run.');
    assert.ok(env.STWORKERS_DEFAULT_BRANCH && env.GITHUB_REF === `refs/heads/${env.STWORKERS_DEFAULT_BRANCH}`,
        'Deploy from the repository default branch. Other revisions may be built, but not deployed.');
}

export function actionsConfig(base, env, deploy = false) {
    const config = createCloudConfig(base, {
        name: env.STWORKERS_WORKER_NAME || 'stworkers',
        ...(env.CLOUDFLARE_ACCOUNT_ID ? { accountId: env.CLOUDFLARE_ACCOUNT_ID } : {}),
        ...(env.STWORKERS_D1_DATABASE_ID ? { databaseId: env.STWORKERS_D1_DATABASE_ID } : {}),
        withP3Plugins: true,
    });
    validateCloudConfig(config, base, config.name, { draft: !deploy });
    return config;
}

export async function fetchPinnedPlugin(plugin, { fetchImpl = fetch, signal } = {}) {
    validatePluginRecord(plugin);
    return downloadPlugin(plugin, { fetchImpl, signal });
}

async function generatedDirectory(root, relative) {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    assert.equal(await realpath(directory), directory, 'Refusing a linked build directory.');
    return directory;
}

async function readJson(file) {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 4 * 1024 * 1024, 'Invalid build metadata file.');
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('Invalid build metadata JSON. Values are not logged.'); }
}

async function writeGeneratedJson(file, value) {
    try {
        const info = await lstat(file);
        assert.ok(info.isFile() && !info.isSymbolicLink(), 'Refusing to overwrite linked build metadata.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function runNode(root, args, env) {
    execFileSync(process.execPath, args, {
        cwd: root, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000,
        env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
}

async function summary(env, text) {
    console.log(text);
    if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + '\n');
}

export function mergePluginHistory(specs, sourceLock, previousLock = sourceLock) {
    validatePluginLock(sourceLock);
    validatePluginLock(previousLock);
    const matches = (item, spec) => item.repository.toLowerCase() === spec.repository.toLowerCase() && item.ref === spec.ref;
    return validatePluginLock({ schema: 1, plugins: specs.flatMap(spec => {
        const item = sourceLock.plugins.find(item => matches(item, spec))
            ?? previousLock.plugins.find(item => matches(item, spec));
        return item ? [item] : [];
    }) });
}

export async function buildActionsRelease(workerRoot, env, { fetchImpl = fetch, run = runNode, previousPluginLock } = {}) {
    // The build path never needs a deployment credential.
    assert.ok(!env.CLOUDFLARE_API_TOKEN && !env.AUTH_PASSWORD && !env.DATA_KEY && !env.GITHUB_TOKEN && !env.GH_TOKEN,
        'Do not provide deployment credentials to the build step.');
    assert.ok([undefined, '', 'false', 'true'].includes(env.STWORKERS_UPDATE_PLUGINS), 'Invalid plugin update selection.');
    const root = await realpath(workerRoot);
    const base = await readJson(path.join(root, 'wrangler.jsonc'));
    const config = actionsConfig(base, env);
    const build = await generatedDirectory(root, '.build');
    const output = await generatedDirectory(root, path.join('.build', 'actions'));
    await writeGeneratedJson(path.join(output, 'release.json'), { schema: 1, validation: 'build-incomplete' });
    const inputs = await readPluginInputs(path.join(root, '..'));
    const selection = await preparePluginSelection(inputs.text, mergePluginHistory(inputs.specs, inputs.lock, previousPluginLock), {
        update: env.STWORKERS_UPDATE_PLUGINS === 'true', fetchImpl,
    });
    const input = await mkdtemp(path.join(build, 'actions-input-'));
    for (const plugin of selection.lock.plugins) {
        const bytes = selection.archives.get(plugin.id);
        await writeFile(path.join(input, plugin.archive), bytes, { flag: 'wx' });
        console.log(`Verified ${plugin.id} ${plugin.version}: ${plugin.sha256}`);
    }
    const bundle = path.join(input, 'bundle');
    await packagePlugins(input, bundle, null, selection.lock.plugins);
    await run(root, ['scripts/build-assets.mjs', '--plugins', path.join(bundle, 'bundle.json')], env);
    const assets = await checkAssets(root, config, {}, selection.lock.plugins);
    const configFile = path.join(output, 'wrangler.json');
    await writeGeneratedJson(configFile, config);
    await run(root, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configFile,
        '--dry-run', '--outdir', path.join(output, 'worker'), '--strict', '--x-auto-create=false', '--no-x-provision'], env);
    await writeGeneratedJson(path.join(output, 'plugins.lock.json'), selection.lock);
    const receipt = { schema: 1, configSha256: digest(Buffer.from(JSON.stringify(config))),
        manifestSha256: digest(await readFile(path.join(build, 'build-manifest-p3.json'))),
        inputListSha256: digest(Buffer.from(inputs.text)),
        inputLockSha256: digest(Buffer.from(JSON.stringify(inputs.lock))),
        pluginLockSha256: digest(Buffer.from(JSON.stringify(selection.lock))), lockChanged: !isDeepStrictEqual(selection.lock, inputs.lock),
        plugins: assets.plugins, files: assets.files, bytes: assets.bytes,
        validation: 'local-build-and-dry-run-only', cloudVerified: false };
    await writeGeneratedJson(path.join(output, 'release.json'), receipt);
    await summary(env, `Prepared ${assets.plugins.length} pinned plugins and ${assets.files} assets. `
        + 'Build and dry-run completed. No Cloudflare resources or secrets were changed.');
    return receipt;
}

export async function readReleaseSelection(root) {
    const directory = await generatedDirectory(root, path.join('.build', 'actions'));
    const receipt = await readJson(path.join(directory, 'release.json'));
    const lock = validatePluginLock(await readJson(path.join(directory, 'plugins.lock.json')));
    const inputs = await readPluginInputs(path.join(root, '..'));
    assertLockMatchesList(inputs.text, lock);
    assert.ok(receipt.schema === 1 && receipt.validation === 'local-build-and-dry-run-only'
        && receipt.inputListSha256 === digest(Buffer.from(inputs.text))
        && receipt.inputLockSha256 === digest(Buffer.from(JSON.stringify(inputs.lock)))
        && receipt.pluginLockSha256 === digest(Buffer.from(JSON.stringify(lock)))
        && receipt.manifestSha256 === digest(await readFile(path.join(root, '.build', 'build-manifest-p3.json')))
        && receipt.lockChanged === !isDeepStrictEqual(inputs.lock, lock),
    'A matching successful build and unchanged plugin inputs are required.');
    return { receipt, lock, inputs };
}

export async function checkExistingInstance(config, token, { fetchImpl = fetch } = {}) {
    assert.ok(typeof token === 'string' && token.length >= 20 && token.length <= 512 && !/\s/.test(token),
        'Set the repository CLOUDFLARE_API_TOKEN secret before deploying.');
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
    async function get(relative) {
        let response, result;
        try {
            response = await fetchImpl(prefix + relative, {
                method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new Error('Cloudflare read failed.');
            }
            result = JSON.parse(new TextDecoder().decode(await readBytes(response, 1024 * 1024)));
            assert.equal(result.success, true);
            assert.ok(result.result);
        } catch {
            throw new Error('Existing Cloudflare resource verification failed. Check account, resource IDs, and token permissions.');
        }
        return result.result;
    }
    const settings = await get(`/workers/scripts/${config.name}/settings`);
    const bindings = settings.bindings;
    assert.ok(Array.isArray(bindings), 'The existing Worker has no readable binding inventory.');
    const required = [
        { name: 'AUTH_PASSWORD', type: 'secret_text' }, { name: 'DATA_KEY', type: 'secret_text' },
        { name: 'ASSETS', type: 'assets' },
        { name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
        { name: 'FILES', type: 'r2_bucket', bucket_name: config.r2_buckets[0].bucket_name },
    ];
    for (const expected of required) {
        const found = bindings.filter(binding => binding.name === expected.name);
        assert.ok(found.length === 1 && Object.entries(expected).every(([key, value]) => found[0][key] === value),
            'The existing Worker resources or required secrets differ. Refusing to replace bindings or initialize secrets.');
    }
    assert.ok(bindings.every(binding => required.some(item => item.name === binding.name)
        || (binding.name === 'MODEL_ALLOWED_ORIGINS' && binding.type === 'plain_text')),
    'The existing Worker has additional bindings. Review them before using this deployment profile.');
    const database = await get(`/d1/database/${config.d1_databases[0].database_id}`);
    assert.equal(database.name, config.d1_databases[0].database_name, 'The existing D1 name differs from the deployment target.');
    const bucket = await get(`/r2/buckets/${config.r2_buckets[0].bucket_name}`);
    assert.equal(bucket.name, config.r2_buckets[0].bucket_name, 'The existing R2 bucket differs from the deployment target.');
    return { existingInstanceChecked: true, resourceBindingsMatched: true, secretNamesPresent: true };
}

export async function deployActionsRelease(workerRoot, env, { fetchImpl = fetch, run = runNode } = {}) {
    checkActionsContext(env);
    const root = await realpath(workerRoot);
    const base = await readJson(path.join(root, 'wrangler.jsonc'));
    const expected = actionsConfig(base, env, true);
    const directory = await generatedDirectory(root, path.join('.build', 'actions'));
    const configFile = path.join(directory, 'wrangler.json');
    const config = await readJson(configFile);
    validateCloudConfig(config, base, expected.name);
    assert.ok(isDeepStrictEqual(config, expected), 'Build and deployment targets differ. Rebuild before deploying.');
    const { receipt, lock } = await readReleaseSelection(root);
    assert.ok(receipt.schema === 1 && receipt.validation === 'local-build-and-dry-run-only'
        && receipt.configSha256 === digest(Buffer.from(JSON.stringify(config)))
        && receipt.manifestSha256 === digest(await readFile(path.join(root, '.build', 'build-manifest-p3.json'))),
    'A matching successful build receipt is required before deployment.');
    const saved = await readJson(path.join(directory, 'lock-saved.json'));
    assert.ok(saved.schema === 1 && saved.sourceRevision === env.GITHUB_SHA
        && saved.repository === env.GITHUB_REPOSITORY && saved.ref === env.GITHUB_REF
        && saved.pluginLockSha256 === receipt.pluginLockSha256
        && /^[a-f0-9]{40}$/.test(saved.savedRevision),
    'Save the generated plugin lock on the current default branch before deployment.');
    await checkAssets(root, config, env.CLOUDFLARE_API_TOKEN ? { token: env.CLOUDFLARE_API_TOKEN } : {}, lock.plugins);
    await checkExistingInstance(config, env.CLOUDFLARE_API_TOKEN, { fetchImpl });
    // Omit --secrets-file: required secret bindings must inherit their existing values.
    await run(root, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configFile,
        '--strict', '--x-auto-create=false', '--no-x-provision',
        '--message', 'STWorkers Actions: deploy with pinned prebundled plugins'], env);
    let checked;
    try { checked = await checkExistingInstance(config, env.CLOUDFLARE_API_TOKEN, { fetchImpl }); }
    catch { throw new Error('Deployment command completed, but post-deployment binding checks failed. Check Cloudflare before retrying. No rollback was attempted.'); }
    await summary(env, 'Deployment command completed and resource bindings were checked again. '
        + 'Existing secret values were inherited, not initialized or replaced. '
        + 'Cloud browser, model, compatibility, and free-resource acceptance still require separate testing.');
    return { deploymentCommandCompleted: true, ...checked, runtimeVerified: false };
}
