import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { actionsConfig, buildActionsRelease, checkActionsContext, checkExistingInstance,
    deployActionsRelease, fetchPinnedPlugin } from '../scripts/actions-release.mjs';
import { digest, PLUGIN_BASELINES } from '../scripts/plugin-package.mjs';

const base = { name: 'stworks', compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat', 'enable_request_signal'] };
const env = {
    STWORKERS_WORKER_NAME: 'stworkers-test', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    STWORKERS_D1_DATABASE_ID: '12345678-1234-4321-8123-123456789abc',
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    STWORKERS_DEFAULT_BRANCH: 'main', STWORKERS_DEPLOY: 'true', CLOUDFLARE_API_TOKEN: 'synthetic-token-never-log-this-value',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/STWorkers',
};
const config = () => actionsConfig(base, env, true);
const json = (file, value) => writeFile(file, JSON.stringify(value));

function remote(change = () => {}) {
    const target = config();
    const payloads = {
        settings: { bindings: [
            { name: 'AUTH_PASSWORD', type: 'secret_text' }, { name: 'DATA_KEY', type: 'secret_text' },
            { name: 'ASSETS', type: 'assets' },
            { name: 'DB', type: 'd1', id: env.STWORKERS_D1_DATABASE_ID },
            { name: 'FILES', type: 'r2_bucket', bucket_name: target.r2_buckets[0].bucket_name },
        ] },
        database: { name: target.d1_databases[0].database_name },
        bucket: { name: target.r2_buckets[0].bucket_name },
    };
    change(payloads);
    const requests = [];
    return { payloads, requests, async fetchImpl(url, options) {
        requests.push({ url, options });
        assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/`));
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
        assert.equal(options.headers.Cookie, undefined);
        if (url.endsWith('/settings')) return Response.json({ success: true, result: payloads.settings });
        if (url.includes('/d1/database/')) return Response.json({ success: true, result: payloads.database });
        if (url.includes('/r2/buckets/')) return Response.json({ success: true, result: payloads.bucket });
        throw new Error('Unexpected API path.');
    } };
}

async function fixture(t) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'stworkers-actions-'));
    const root = path.join(parent, 'cloudflare');
    const output = path.join(root, '.build', 'actions');
    const assets = path.join(root, '.build', 'assets-p3');
    t.after(() => rm(parent, { recursive: true, force: true }));
    await mkdir(output, { recursive: true });
    await mkdir(path.join(assets, '__stworks'), { recursive: true });
    await json(path.join(root, 'wrangler.jsonc'), base);
    await json(path.join(parent, 'upstream-lock.json'), { extensions: PLUGIN_BASELINES });
    const lock = { schema: 1, plugins: PLUGIN_BASELINES.map(plugin => ({ ...plugin, ref: 'HEAD', layout: 'legacy' })) };
    const list = lock.plugins.map(plugin => `https://github.com/${plugin.repository}`).join('\n');
    await json(path.join(parent, 'plugins.lock.json'), lock);
    await writeFile(path.join(parent, 'plugins.txt'), list);
    await json(path.join(output, 'plugins.lock.json'), lock);
    const bundled = PLUGIN_BASELINES.map(plugin => ({ name: `third-party/${plugin.id}`, commit: plugin.commit, version: plugin.version }));
    const discovered = ['regex', 'quick-reply', ...bundled.map(plugin => plugin.name)];
    const bootstrap = JSON.stringify({ stworks: { extensions: discovered.map(name => ({ name })) } });
    await writeFile(path.join(assets, '__stworks', 'bootstrap.json'), bootstrap);
    await writeFile(path.join(assets, 'index.html'), 'synthetic');
    const manifest = { extensionsBundled: bundled, extensionsDiscovered: discovered,
        totalAssetFiles: 2, totalAssetBytes: Buffer.byteLength(bootstrap) + 9 };
    await json(path.join(root, '.build', 'build-manifest-p3.json'), manifest);
    await json(path.join(output, 'wrangler.json'), config());
    await json(path.join(output, 'release.json'), { schema: 1, validation: 'local-build-and-dry-run-only',
        configSha256: digest(Buffer.from(JSON.stringify(config()))),
        manifestSha256: digest(Buffer.from(JSON.stringify(manifest))),
        inputListSha256: digest(Buffer.from(list)), inputLockSha256: digest(Buffer.from(JSON.stringify(lock))),
        pluginLockSha256: digest(Buffer.from(JSON.stringify(lock))), lockChanged: false });
    await json(path.join(output, 'lock-saved.json'), { schema: 1,
        repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF,
        sourceRevision: env.GITHUB_SHA, savedRevision: env.GITHUB_SHA,
        pluginLockSha256: digest(Buffer.from(JSON.stringify(lock))) });
    return { root, output, assets };
}

test('Actions config uses explicit selected assets without credentials or deployment hooks', () => {
    const draft = actionsConfig(base, {});
    assert.equal(draft.name, 'stworkers');
    assert.equal(draft.assets.directory, '../../.build/assets-p3');
    assert.equal(draft.assets.run_worker_first, true);
    assert.deepEqual(draft.secrets.required, ['AUTH_PASSWORD', 'DATA_KEY']);
    assert.equal(draft.build, undefined);
    assert.equal(draft.vars, undefined);
    assert.ok(!JSON.stringify(config()).includes(env.CLOUDFLARE_API_TOKEN));
    assert.throws(() => actionsConfig(base, {}, true));
    assert.throws(() => actionsConfig(base, { ...env, STWORKERS_WORKER_NAME: '../escape' }));
});

test('deployment requires explicit manual dispatch on the actual default branch', () => {
    checkActionsContext(env);
    for (const changed of [
        { GITHUB_ACTIONS: '' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
        { STWORKERS_DEPLOY: 'false' }, { STWORKERS_DEFAULT_BRANCH: '' },
        { GITHUB_REF: 'refs/heads/other' }, { GITHUB_REF: 'refs/tags/main' },
    ]) assert.throws(() => checkActionsContext({ ...env, ...changed }));
});

test('plugin fetching is pinned, credential-free and fails closed for changed archive bytes', async () => {
    let calls = 0;
    const plugin = PLUGIN_BASELINES[0];
    await assert.rejects(fetchPinnedPlugin(plugin, { fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, `https://codeload.github.com/${plugin.repository}/zip/${plugin.commit}`);
        assert.equal(options.redirect, 'manual');
        assert.equal(options.credentials, 'omit');
        assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
        return new Response('not-the-reviewed-archive');
    } }), /checksum verification failed/);
    assert.equal(calls, 1);
    await assert.rejects(fetchPinnedPlugin({ ...plugin, repository: '../escape' }, {
        fetchImpl: () => { throw new Error('Must never fetch'); },
    }));
});

test('plugin redirects, HTTP errors, oversized headers and network details never enter CI logs', async () => {
    for (const response of [
        new Response(null, { status: 302, headers: { Location: 'https://example.test/secret-value' } }),
        new Response('secret-value', { status: 500 }),
        new Response('', { headers: { 'Content-Length': String(25 * 1024 * 1024 + 1) } }),
    ]) await assert.rejects(fetchPinnedPlugin(PLUGIN_BASELINES[0], { fetchImpl: async () => response }),
        error => /download or checksum/.test(error.message) && !error.message.includes('secret-value'));
    await assert.rejects(fetchPinnedPlugin(PLUGIN_BASELINES[0], { fetchImpl: async () => { throw new Error('secret-value'); } }),
        error => !error.message.includes('secret-value'));
});

test('streamed plugin downloads enforce the byte limit without trusting Content-Length', async () => {
    let cancelled = false;
    await assert.rejects(fetchPinnedPlugin(PLUGIN_BASELINES[0], { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
    })) }), /download or checksum/);
    assert.equal(cancelled, true);
});

test('build rejects deployment credentials before filesystem access or downloads', async () => {
    for (const secret of ['CLOUDFLARE_API_TOKEN', 'AUTH_PASSWORD', 'DATA_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) {
        await assert.rejects(buildActionsRelease('nonexistent', { [secret]: 'sensitive' }), /Do not provide deployment credentials/);
    }
});

test('read-only cloud checks require matching resources and both existing secret names', async () => {
    const transport = remote();
    assert.deepEqual(await checkExistingInstance(config(), env.CLOUDFLARE_API_TOKEN, transport), {
        existingInstanceChecked: true, resourceBindingsMatched: true, secretNamesPresent: true,
    });
    assert.equal(transport.requests.length, 3);
    assert.ok(transport.requests.every(item => item.options.body === undefined));
});

test('missing or differently bound resources stop an update without creating replacements', async () => {
    for (const change of [
        value => { value.settings.bindings = []; },
        value => { value.settings.bindings = value.settings.bindings.filter(item => item.name !== 'DATA_KEY'); },
        value => { value.settings.bindings.find(item => item.name === 'DB').id = 'different'; },
        value => { value.settings.bindings.find(item => item.name === 'FILES').bucket_name = 'different'; },
        value => { value.settings.bindings.push({ name: 'EXTRA_KEY', type: 'secret_text' }); },
        value => { value.database.name = 'different'; },
        value => { value.bucket.name = 'different'; },
    ]) await assert.rejects(checkExistingInstance(config(), env.CLOUDFLARE_API_TOKEN, remote(change)));
});

test('an unused legacy model-domain variable does not require manual cloud edits', async () => {
    const transport = remote(value => value.settings.bindings.push({ name: 'MODEL_ALLOWED_ORIGINS', type: 'plain_text', text: 'obsolete' }));
    assert.equal((await checkExistingInstance(config(), env.CLOUDFLARE_API_TOKEN, transport)).resourceBindingsMatched, true);
});

test('missing Workers, redirects, API failures, and invalid tokens never imply resource creation', async () => {
    for (const status of [301, 403, 404, 500]) {
        await assert.rejects(checkExistingInstance(config(), env.CLOUDFLARE_API_TOKEN, {
            fetchImpl: async () => new Response('secret-value', { status }),
        }), error => /verification failed/.test(error.message) && !error.message.includes('secret-value'));
    }
    await assert.rejects(checkExistingInstance(config(), '', { fetchImpl: () => assert.fail('No request expected') }));
    await assert.rejects(checkExistingInstance(config(), env.CLOUDFLARE_API_TOKEN, {
        fetchImpl: async () => Response.json({ success: false, errors: [{ message: 'secret-value' }] }),
    }), error => !error.message.includes('secret-value'));
});

test('a checked update migrates before deploy, inherits secrets, disables provisioning, and rechecks bindings', async t => {
    t.mock.method(console, 'log', () => {});
    const { root } = await fixture(t);
    const transport = remote(), commands = [];
    const result = await deployActionsRelease(root, env, { ...transport, run: async (cwd, args) => {
        assert.equal(cwd, root);
        assert.equal(transport.requests.length, 3);
        commands.push(args);
    } });
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].slice(1, 6), ['d1', 'migrations', 'apply', 'DB', '--remote']);
    assert.equal(commands[0].at(-1), commands[1][commands[1].indexOf('--config') + 1]);
    assert.equal(commands[1][1], 'deploy');
    assert.ok(commands[1].includes('--strict'));
    assert.ok(commands[1].includes('--x-auto-create=false'));
    assert.ok(commands[1].includes('--no-x-provision'));
    assert.ok(!commands[1].includes('--secrets-file'));
    assert.ok(!JSON.stringify(commands).includes(env.CLOUDFLARE_API_TOKEN));
    assert.equal(transport.requests.length, 6);
    assert.equal(result.runtimeVerified, false);
    assert.equal(result.migrationsCompleted, true);
});

test('an Actions migration failure cannot upload new code or expose captured output', async t => {
    const { root } = await fixture(t);
    const commands = [];
    await assert.rejects(deployActionsRelease(root, env, { ...remote(), run: (_root, args) => {
        commands.push(args);
        throw new Error('synthetic private migration detail');
    } }), error => /No Worker upload/.test(error.message) && !/private migration detail/.test(error.message));
    assert.equal(commands.length, 1);
    assert.equal(commands[0][1], 'd1');
});

test('failed remote preflight cannot reach the deploy command', async t => {
    const { root } = await fixture(t);
    await assert.rejects(deployActionsRelease(root, env, {
        ...remote(value => { value.settings.bindings = []; }),
        run: () => assert.fail('Must not deploy'),
    }));
});

test('missing receipts, mismatched targets and changed build inventory block deployment', async t => {
    const { root, output } = await fixture(t);
    const never = { fetchImpl: () => assert.fail('Must not contact Cloudflare'), run: () => assert.fail('Must not deploy') };
    await assert.rejects(deployActionsRelease(root, { ...env, STWORKERS_WORKER_NAME: 'another-worker' }, never));
    const receipt = path.join(output, 'release.json');
    await json(receipt, { schema: 1, validation: 'failed-build' });
    await assert.rejects(deployActionsRelease(root, env, never));
    await rm(receipt);
    await assert.rejects(deployActionsRelease(root, env, never), { code: 'ENOENT' });
});

test('deployment refuses asset leaks and linked generated directories', async t => {
    const { root, output, assets } = await fixture(t);
    const never = { fetchImpl: () => assert.fail('Must not contact Cloudflare'), run: () => assert.fail('Must not deploy') };
    await writeFile(path.join(assets, 'index.html'), env.CLOUDFLARE_API_TOKEN);
    await assert.rejects(deployActionsRelease(root, env, never), /secret was found/);
    await writeFile(path.join(assets, 'index.html'), 'synthetic');
    const outside = path.join(root, 'separate-directory');
    await mkdir(outside);
    await rm(output, { recursive: true });
    await symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(deployActionsRelease(root, env, never), /linked build directory/);
});

test('post-deployment network failure reports that deployment already ran, not that nothing happened', async t => {
    const { root } = await fixture(t);
    const transport = remote();
    let deployed = false;
    await assert.rejects(deployActionsRelease(root, env, {
        fetchImpl: (...args) => deployed ? new Response(null, { status: 503 }) : transport.fetchImpl(...args),
        run: () => { deployed = true; },
    }), /Deployment command completed, but post-deployment/);
    assert.equal(deployed, true);
});

test('workflow is manual, default-dry-run, SHA-pinned and saves only lock metadata before optional deployment', async () => {
    const workflow = parse(await readFile(new URL('../../.github/workflows/stworkers-deploy.yml', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(workflow.on.workflow_dispatch.inputs.deploy.default, false);
    assert.equal(workflow.on.workflow_dispatch.inputs.deploy.type, 'boolean');
    assert.equal(workflow.on.workflow_dispatch.inputs.update_plugins.default, false);
    assert.equal(workflow.on.workflow_dispatch.inputs.update_plugins.type, 'boolean');
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    const job = workflow.jobs['prepare-and-deploy'];
    assert.deepEqual(job.permissions, { contents: 'write' });
    assert.equal(job.env.CLOUDFLARE_API_TOKEN, undefined);
    const steps = job.steps;
    for (const step of steps.filter(step => step.uses)) assert.match(step.uses, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
    assert.equal(steps[0].with['persist-credentials'], false);
    assert.equal(steps[0].with['fetch-depth'], 0);
    for (const step of steps.filter(step => step.run?.includes(' ci '))) assert.match(step.run, /--ignore-scripts/);
    const secretSteps = steps.filter(step => JSON.stringify(step).includes('secrets.'));
    assert.equal(secretSteps.length, 1);
    assert.equal(secretSteps[0].run, 'node cloudflare/scripts/github-actions.mjs deploy');
    assert.equal(secretSteps[0].if, '${{ inputs.deploy }}');
    assert.equal(steps.filter(step => step.run?.includes('github-actions.mjs build')).length, 1);
    const save = steps.find(step => step.run?.endsWith('github-actions.mjs save-lock'));
    assert.equal(save.env.GITHUB_TOKEN, '${{ github.token }}');
    assert.equal(save.if, "${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}");
    assert.ok(steps.indexOf(save) > steps.findIndex(step => step.run?.endsWith('github-actions.mjs build')));
    assert.ok(steps.indexOf(save) < steps.findIndex(step => step.run?.endsWith('github-actions.mjs deploy')));
    assert.equal(steps.filter(step => step.env?.GITHUB_TOKEN).length, 1);
    assert.equal(job.env.GITHUB_TOKEN, undefined);
});

test('deployment rejects changed plugin inputs or a missing lock-save receipt before cloud access', async t => {
    const { root, output } = await fixture(t);
    const never = { fetchImpl: () => assert.fail('Must not contact Cloudflare'), run: () => assert.fail('Must not deploy') };
    const list = path.join(root, '..', 'plugins.txt'), previous = await readFile(list, 'utf8');
    await writeFile(list, previous + '\n# changed after building');
    await assert.rejects(deployActionsRelease(root, env, never), /unchanged plugin inputs/);
    await writeFile(list, previous);
    await rm(path.join(output, 'lock-saved.json'));
    await assert.rejects(deployActionsRelease(root, env, never), { code: 'ENOENT' });
});

test('only the reviewed STWorkers workflow is active; upstream automation is preserved outside workflows', async () => {
    const active = await readdir(new URL('../../.github/workflows/', import.meta.url));
    assert.deepEqual(active.filter(name => /\.ya?ml$/.test(name)), ['stworkers-deploy.yml']);
    const archived = await readdir(new URL('../../.github/upstream-workflows/', import.meta.url));
    for (const name of ['docker-publish.yml', 'npm-publish.yml', 'job-close-stale.yml', 'pr-check-merge-conflicts.yaml']) {
        assert.ok(archived.includes(name));
    }
});
