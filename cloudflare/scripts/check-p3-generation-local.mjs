import assert from 'node:assert/strict';
import { ownerStorageState } from './owner-client.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startUpstreamBrowserServer, stopChild } from './upstream-browser-server.mjs';
import { PLUGIN_BASELINES } from './plugin-package.mjs';
import { createGenerationModel } from './p3-generation-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = fileURLToPath(new URL('../../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const bundle = process.argv[4];
assert.ok(bundle, 'Supply the explicitly reviewed P3 bundle.json as the third argument.');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
assert.ok(AUTH_PASSWORD);
const runId = randomUUID();
const output = new URL(`../.build/p3-generation/${runId}/`, import.meta.url);
const workerBase = 'http://127.0.0.1:8798', modelBase = 'http://127.0.0.1:8800';
const persistence = `.wrangler/p3-generation/${runId}`;
const model = createGenerationModel();
const targets = [];
const evidence = { runId, startedAt: new Date().toISOString(), status: 'running',
    plugins: PLUGIN_BASELINES.map(({ id, commit, version }) => ({ id, commit, version })),
    cases: [], boundaries: [], expectedErrors: [], failures: [], pageErrors: [], consoleErrors: [], external: [],
    tokenRequests: { worker: [], original: [] } };
const external = new Set([
    'https://testingcf.jsdelivr.net/npm/vue/dist/vue.runtime.global.prod.min.js',
    'https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js',
    'https://testingcf.jsdelivr.net/gh/N0VI028/JS-Slash-Runner/src/iframe/node_modules/log.js',
    'https://testingcf.jsdelivr.net/npm/@fortawesome/fontawesome-free/css/all.min.css',
    'https://testingcf.jsdelivr.net/npm/jquery/dist/jquery.min.js',
    'https://testingcf.jsdelivr.net/npm/jquery-ui/dist/jquery-ui.min.js',
    'https://testingcf.jsdelivr.net/npm/jquery-ui/themes/base/theme.min.css',
    'https://testingcf.jsdelivr.net/npm/jquery-ui-touch-punch',
    'https://gitlab.com/api/v4/projects/novi028%2FJS-Slash-Runner/repository/files/manifest.json/raw?ref=main',
]);
let browser, preview, original, stage = 'startup', watchdog;
const setStage = value => { stage = value; console.log(value); };
async function until(callback, description) {
    for (let index = 0; index < 150; index++) {
        if (await callback()) return;
        await delay(100);
    }
    throw new Error(description);
}
async function newTarget(side, base, credentials, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ ...(side === 'worker'
        ? { storageState: await ownerStorageState(base, credentials.password) }
        : { httpCredentials: { ...credentials, origin: base } }), viewport,
        locale: 'en-US', serviceWorkers: 'block', ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    context.setDefaultTimeout(30000);
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base || ['blob:', 'data:'].includes(url.protocol) || external.has(url.href)) return route.continue();
        evidence.external.push({ side, url: url.href, blocked: true });
        return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const consoleTail = [];
    page.on('pageerror', error => evidence.pageErrors.push({ side, stage, error: error.stack ?? error.message }));
    page.on('console', message => {
        const text = message.text().slice(0, 600);
        if (message.type() === 'error') {
            const expected = side === 'original' && stage.endsWith('late-upstream-error')
                && message.location().url === `${base}/api/backends/chat-completions/generate`
                && /^Failed to load resource: the server responded with a status of 429\b/.test(text);
            (expected ? evidence.expectedErrors : evidence.consoleErrors).push({ side, stage, text, location: message.location() });
        }
        consoleTail.push(text);
        if (consoleTail.length > 40) consoleTail.shift();
    });
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === base && response.status() >= 400) {
            const expected = side === 'original' && stage.endsWith('late-upstream-error')
                && url.pathname === '/api/backends/chat-completions/generate' && response.status() === 429;
            (expected ? evidence.expectedErrors : evidence.failures).push({ side, stage, path: url.pathname, status: response.status() });
        }
        else if (url.origin !== base) evidence.external.push({ side, url: url.href, status: response.status() });
    });
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === base && url.pathname.startsWith('/api/tokenizers/')) evidence.tokenRequests[side].push(url.pathname);
    });
    const csrfResponse = await context.request.get(`${base}/csrf-token`);
    assert.ok(csrfResponse.ok());
    const { token } = await csrfResponse.json();
    const post = async (pathname, data, multipart = false) => {
        const response = await context.request.post(`${base}${pathname}`, { headers: { Origin: base, 'X-CSRF-Token': token },
            ...(multipart ? { multipart: data } : { data }), timeout: 20000 });
        assert.ok(response.ok(), `${side} ${pathname}: ${response.status()} ${(await response.text()).slice(0, 300)}`);
        return response;
    };
    return { side, base, credentials, context, page, post, consoleTail };
}
async function seed(target) {
    const settings = JSON.parse(await readFile(new URL('../../default/content/settings.json', import.meta.url), 'utf8'));
    const preset = JSON.parse(await readFile(new URL('../../default/content/presets/openai/Default.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../../upstream-lock.json', import.meta.url), 'utf8'));
    const builtins = execFileSync('git', ['ls-tree', '-r', '--name-only', lock.sillytavern.commit, 'public/scripts/extensions'],
        { cwd: project, encoding: 'utf8' }).split('\n').filter(name => /^public\/scripts\/extensions\/[^/]+\/manifest\.json$/.test(name))
        .map(name => name.split('/')[3]);
    Object.assign(settings, { firstRun: false, username: 'P3 Generation User', main_api: 'openai' });
    Object.assign(settings.oai_settings, { prompts: preset.prompts, prompt_order: preset.prompt_order,
        chat_completion_source: 'custom', custom_url: `${modelBase}/${target.side}/v1`, custom_model: 'p3-generation-fixture',
        stream_openai: false, openai_max_context: 8192, openai_max_tokens: 128,
        preset_settings_openai: 'P3 Generation', custom_prompt_post_processing: '' });
    settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content =
        "P3 PRESET <%= getvar('p3_tag') %>. <% setvar('p3_preset_runs', (getvar('p3_preset_runs', {scope:'local'}) ?? 0) + 1, {scope:'local'}); %>";
    settings.extension_settings.disabledExtensions = builtins.filter(name => !['regex', 'quick-reply'].includes(name));
    settings.extension_settings.tavern_helper = { audio: { enabled: false }, listener: { enabled: false } };
    await target.post('/api/presets/save', { apiId: 'openai', name: 'P3 Generation', preset: settings.oai_settings });
    await target.post('/api/settings/save', settings);
    const response = await target.post('/api/characters/import', {
        file_type: 'json', avatar: { name: 'p3-generation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
            spec: 'chara_card_v3', spec_version: '3.0', data: {
                name: 'P3 Generation Card', description: 'P3 CARD {{char}} / {{user}}.',
                personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '',
                post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
                character_version: '', group_only_greetings: [],
                first_mes: 'P3 generation greeting.', extensions: { p3_unknown: [null, false, { keep: true }] },
            },
        })) },
    }, true);
    target.avatar = `${(await response.json()).file_name}.png`;
}
async function openChat(target, initialize = true) {
    const { page, base, avatar } = target;
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.TavernHelper && !!window.EjsTemplate);
    await page.waitForFunction(avatar => window.SillyTavern.getContext().characters.some(card => card.avatar === avatar), avatar);
    await page.waitForFunction(() => !document.querySelector('.splash-screen'));
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await page.locator('#rightNavDrawerIcon').click();
    await page.getByText('P3 Generation Card', { exact: true }).first().click();
    await page.locator('#chat .mes_text').first().waitFor();
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    await page.evaluate(async initialize => {
        const c = window.SillyTavern.getContext();
        if (initialize) {
            window.TavernHelper.insertOrAssignVariables({ p3_tag: 'shared', p3_preset_runs: 0, p3_raw_runs: 0 }, { type: 'chat' });
            await c.saveChat();
        }
        window.p3Trace = [];
        window.p3PreviewTrace = [];
        window.p3Tasks = {};
        const types = c.eventTypes ?? c.event_types;
        for (const name of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'CHAT_COMPLETION_PROMPT_READY',
            'CHAT_COMPLETION_SETTINGS_READY', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED',
            'CHARACTER_MESSAGE_RENDERED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_SWIPED']) {
            c.eventSource.on(types[name], (...args) => {
                const preview = (['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS'].includes(name) && args[2] === true)
                    || (name === 'CHAT_COMPLETION_PROMPT_READY' && args[0]?.dryRun === true);
                (preview ? window.p3PreviewTrace : window.p3Trace).push({
                    name, id: name === 'GENERATION_STOPPED' && typeof args[0] === 'string' ? args[0] : null,
                });
            });
        }
        for (const [name, event] of Object.entries({
            started: 'js_generation_started', beforeEnd: 'js_generation_before_end', ended: 'js_generation_ended',
            full: 'js_stream_token_received_fully', incremental: 'js_stream_token_received_incrementally',
        })) c.eventSource.on(event, (...args) => window.p3Trace.push({
            name, id: name === 'started' ? args[0] : args[1],
            text: name === 'started' ? undefined : name === 'beforeEnd' ? args[0].message : args[0],
        }));
    }, initialize);
}
async function connect(target) {
    const { page } = target;
    await page.locator('#API-status-top').click();
    const pending = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await page.locator('#api_button_openai').click();
    assert.equal((await pending).status(), 200);
    await page.locator('#API-status-top').click();
    await page.locator('#api_button_openai').waitFor({ state: 'hidden' });
}
async function snapshot(target) {
    return target.page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        const pick = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key.startsWith('p3_')));
        return {
            variables: pick(window.TavernHelper.getVariables({ type: 'chat' })),
            streamSetting: c.chatCompletionSettings.stream_openai,
            messages: c.chat.map(message => ({ mes: message.mes, is_user: message.is_user,
                swipe_id: message.swipe_id ?? 0, swipes: message.swipes ?? [message.mes],
                variables: message.variables?.map(pick) ?? [] })),
        };
    });
}
async function startTask(target, id, { raw = false, silent = false, custom = false } = {}) {
    await target.page.evaluate(({ id, raw, silent, custom, api }) => {
        const config = { generation_id: id, user_input: `P3 INPUT ${id}`, should_stream: true, should_silence: silent };
        if (raw) config.ordered_prompts = [{ role: 'system', content:
            "P3 RAW <%= getvar('p3_tag') %>. <% setvar('p3_raw_runs', (getvar('p3_raw_runs', {scope:'local'}) ?? 0) + 1, {scope:'local'}); %>" }, 'user_input'];
        if (custom) config.custom_api = { source: 'custom', apiurl: api, model: 'p3-generation-fixture' };
        const task = { status: 'pending' };
        window.p3Tasks[id] = task;
        window.TavernHelper[raw ? 'generateRaw' : 'generate'](config).then(
            value => Object.assign(task, { status: 'fulfilled', value }),
            error => Object.assign(task, { status: 'rejected', error: String(error) }),
        );
    }, { id, raw, silent, custom, api: `${modelBase}/${target.side}/v1` });
}
async function settled(target, id) {
    await target.page.waitForFunction(id => window.p3Tasks[id]?.status !== 'pending', id);
    return target.page.evaluate(id => window.p3Tasks[id], id);
}
async function received(target, id) {
    await target.page.waitForFunction(id => window.p3Trace.some(event => event.name === 'full' && event.id === id), id);
}
async function assertFinished(target, id, plan) {
    const task = await settled(target, id);
    assert.equal(task.status, 'fulfilled', `${target.side} ${id}: ${task.error}`);
    assert.equal(task.value, plan.text);
    // EJS awaits template handling inside before_end; later observers may run after ended.
    await target.page.waitForFunction(id => window.p3Trace.some(event => event.id === id && event.name === 'beforeEnd'), id);
    const events = await target.page.evaluate(id => window.p3Trace.filter(event => event.id === id), id);
    for (const name of ['started', 'beforeEnd', 'ended']) assert.equal(events.filter(event => event.name === name).length, 1, `${id}: ${name}`);
    assert.equal(events[0].name, 'started');
    const full = events.filter(event => event.name === 'full');
    assert.ok(full.some(event => event.text !== plan.text && plan.text.startsWith(event.text)), 'No intermediate stream event.');
    assert.equal(full.at(-1).text, plan.text);
    assert.ok(full.every(event => !event.text.includes('\ufffd')), 'Broken UTF-8 text.');
    assert.ok(!events.some(event => event.name === 'GENERATION_STOPPED'));
}
async function assertStopped(target, id, index, requireConnectionClose = true) {
    const task = await settled(target, id);
    assert.equal(task.status, 'rejected', `${id} must reject on cancellation, not report a finished reply.`);
    if (requireConnectionClose) await until(() => model.records[target.side][index]?.closedEarly,
        `${target.side} ${id}: upstream connection did not close`);
    const events = await target.page.evaluate(id => window.p3Trace.filter(event => event.id === id), id);
    assert.equal(events.filter(event => event.name === 'GENERATION_STOPPED').length, 1, `${id}: duplicate stop event`);
    assert.equal(events.filter(event => event.name === 'ended').length, 0);
    assert.equal(events.filter(event => event.name === 'beforeEnd').length, 0);
    assert.equal(await target.page.evaluate(id => window.TavernHelper.stopGenerationById(id), id), false);
}
async function checkpoint(label, action) {
    setStage(label);
    const states = [], lifecycle = [], details = {};
    for (const target of targets) {
        await target.page.evaluate(() => { window.p3Trace = []; window.p3PreviewTrace = []; });
        const before = await snapshot(target);
        const firstRequest = model.records[target.side].length;
        await action(target, before, firstRequest);
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(250);
        const state = await snapshot(target);
        states.push(state);
        const trace = await target.page.evaluate(() => window.p3Trace);
        lifecycle.push(trace.filter(event => !['full', 'incremental'].includes(event.name)));
        details[target.side] = { before, state, trace, backgroundPreview: await target.page.evaluate(() => window.p3PreviewTrace),
            requests: model.records[target.side].slice(firstRequest) };
    }
    evidence.cases.push({ label, ...details });
    assert.deepEqual(states[0], states[1], `${label}: original/Worker variable or chat mismatch`);
    assert.deepEqual(lifecycle[0], lifecycle[1], `${label}: original/Worker lifecycle mismatch`);
    assert.deepEqual(details.worker.requests.map(record => record.body), details.original.requests.map(record => record.body),
        `${label}: actual model requests differ`);
    assert.ok(details.worker.requests.every(record => record.label !== 'UNPLANNED'));
}
async function nativeGenerate(target, action, label, before, index) {
    const text = `P3 ${label}. \u4f60\u597d.`
        + `<% setvar('p3_reply_label','${label}',{scope:'message'}); setvar('p3_reply_runs',(getvar('p3_reply_runs',{scope:'message'}) ?? 0)+1,{scope:'message'}); %>`;
    model.plan(target.side, label, { text });
    if (action === 'send') {
        await target.page.locator('#send_textarea').fill(`P3 ${label} stream input.`);
        await target.page.locator('#send_but').click();
    } else if (action === 'regenerate') {
        await target.page.locator('#options_button').click();
        await target.page.locator('#option_regenerate').click();
    } else await target.page.locator('#chat .mes').last().locator('.swipe_right').click();
    await target.page.waitForFunction(label => window.TavernHelper.getVariables({ type: 'message' }).p3_reply_label === label, label);
    await target.page.locator('#mes_stop').waitFor({ state: 'hidden' });
    await target.page.waitForFunction(() => window.p3Trace.some(event => event.name === 'GENERATION_ENDED'));
    await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
    assert.equal(model.records[target.side].length, index + 1);
    assert.equal((await snapshot(target)).variables.p3_preset_runs, before.variables.p3_preset_runs + 1);
    const previous = before.messages.at(action === 'send' ? -1 : -2);
    const inheritedRuns = previous?.variables?.[previous.swipe_id]?.p3_reply_runs ?? 0;
    assert.equal(await target.page.evaluate(() => window.TavernHelper.getVariables({ type: 'message' }).p3_reply_runs),
        inheritedRuns + 1, `${label}: reply template must increment the inherited value once`);
    assert.equal(await target.page.evaluate(() => window.p3Trace.filter(event => event.name === 'GENERATION_ENDED').length), 1);
    assert.doesNotMatch(JSON.stringify(model.records[target.side][index].body.messages), /<%/);
}
async function run() {
    await mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { model.server.once('error', reject); model.server.listen(8800, '127.0.0.1', resolve); });
    const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(migration.status, 0, 'P3 generation migrations failed.');
    preview = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8798', '--inspector-port', '9248',
        '--assets', '.build/assets-p3', '--persist-to', persistence],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    preview.stdout.resume();
    preview.stderr.resume();
    await until(async () => {
        try { return (await fetch(`${workerBase}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })).status === 302; }
        catch { return false; }
    }, 'P3 generation Worker did not start.');
    original = await startUpstreamBrowserServer(8799, { pluginBundle: bundle });
    evidence.original = original.evidence;
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    targets.push(await newTarget('worker', workerBase, { username: 'owner', password: AUTH_PASSWORD }));
    targets.push(await newTarget('original', original.base, original.credentials));
    for (const target of targets) {
        setStage(`${target.side}: actual plugins and isolated fixture`);
        await seed(target);
        await openChat(target);
        await connect(target);
    }
    for (const [label, options] of [
        ['helper-stream', {}], ['raw-stream', { raw: true }], ['custom-api-stream', { raw: true, custom: true }],
    ]) await checkpoint(label, async (target, before, index) => {
        const plan = model.plan(target.side, label);
        await startTask(target, label, options);
        await assertFinished(target, label, plan);
        await target.page.locator('#mes_stop').waitFor({ state: 'hidden' });
        const after = await snapshot(target);
        assert.deepEqual(after.messages, before.messages);
        assert.equal(after.streamSetting, false);
        const counter = options.raw ? 'p3_raw_runs' : 'p3_preset_runs';
        assert.equal(after.variables[counter], before.variables[counter] + 1, `${label}: EJS should execute once`);
        assert.equal(model.records[target.side].length, index + 1);
        assert.doesNotMatch(JSON.stringify(model.records[target.side][index].body.messages), /<%/);
    });
    for (const [label, options] of [
        ['helper-late-upstream-error', {}], ['custom-api-late-upstream-error', { raw: true, custom: true }],
    ]) await checkpoint(label, async (target, before, index) => {
        model.plan(target.side, label, { mode: 'late-error' });
        await startTask(target, label, options);
        assert.equal((await settled(target, label)).status, 'rejected', 'An SSE error must not become a successful reply.');
        const events = await target.page.evaluate(id => window.p3Trace.filter(event => event.id === id), label);
        assert.equal(events.filter(event => event.name === 'started').length, 1);
        assert.equal(events.filter(event => ['beforeEnd', 'ended'].includes(event.name)).length, 0);
        assert.deepEqual((await snapshot(target)).messages, before.messages);
        assert.equal(model.records[target.side].length, index + 1);
    });
    await checkpoint('stop-by-id', async (target, before, index) => {
        model.plan(target.side, 'stop-by-id', { mode: 'slow' });
        await startTask(target, 'reusable-id');
        await received(target, 'reusable-id');
        assert.equal(await target.page.evaluate(() => window.TavernHelper.stopGenerationById('reusable-id')), true);
        await assertStopped(target, 'reusable-id', index);
        assert.equal(model.records[target.side].length, index + 1);
        assert.deepEqual((await snapshot(target)).messages, before.messages);
    });
    await checkpoint('reuse-cancelled-id', async target => {
        const plan = model.plan(target.side, 'reuse-cancelled-id');
        await startTask(target, 'reusable-id');
        await assertFinished(target, 'reusable-id', plan);
    });
    await checkpoint('stop-before-response-headers', async (target, before, index) => {
        const plan = model.plan(target.side, 'stop-before-response-headers', { mode: 'headers-pending' });
        await startTask(target, 'pending-headers', { raw: true, custom: true });
        await until(() => model.records[target.side].length === index + 1, 'Pending request was not sent.');
        assert.equal(await target.page.evaluate(() => window.TavernHelper.stopGenerationById('pending-headers')), true);
        await assertStopped(target, 'pending-headers', index, false);
        for (let count = 0; count < 50 && !model.records[target.side][index].closedEarly; count++) await delay(100);
        evidence.boundaries.push({ side: target.side, label: 'stop-before-response-headers',
            closedWithinFiveSeconds: model.records[target.side][index].closedEarly,
            browserTask: await settled(target, 'pending-headers') });
        // Test-only cleanup must not turn a failed cancellation observation into a pass.
        plan.close();
        assert.deepEqual((await snapshot(target)).messages, before.messages);
    });
    await checkpoint('UI-stop-preserves-silent-task-and-stop-all', async (target, before, index) => {
        model.plan(target.side, 'bound', { mode: 'slow' });
        await startTask(target, 'bound', { raw: true });
        await received(target, 'bound');
        model.plan(target.side, 'silent', { mode: 'slow' });
        await startTask(target, 'silent', { raw: true, silent: true });
        await received(target, 'silent');
        const duplicate = await target.page.evaluate(async () => {
            try { await window.TavernHelper.generateRaw({ generation_id: 'bound', should_stream: true, ordered_prompts: [] }); }
            catch (error) { return String(error); }
            return null;
        });
        assert.ok(duplicate?.includes('bound'), 'An active generation ID must not be reused.');
        await target.page.locator('#mes_stop').click();
        await assertStopped(target, 'bound', index);
        assert.equal(await target.page.evaluate(() => window.p3Tasks.silent.status), 'pending');
        assert.equal(model.records[target.side][index + 1].closedEarly, false);
        model.plan(target.side, 'silent-two', { mode: 'slow' });
        await startTask(target, 'silent-two', { raw: true, silent: true, custom: true });
        await received(target, 'silent-two');
        assert.equal(await target.page.evaluate(() => window.TavernHelper.stopAllGeneration()), true);
        await assertStopped(target, 'silent', index + 1);
        await assertStopped(target, 'silent-two', index + 2);
        assert.equal(model.records[target.side].length, index + 3);
        assert.deepEqual((await snapshot(target)).messages, before.messages);
    });
    await checkpoint('generation-recovers-after-stop-all', async target => {
        const plan = model.plan(target.side, 'after-stop-all');
        await startTask(target, 'after-stop-all');
        await assertFinished(target, 'after-stop-all', plan);
        assert.equal((await snapshot(target)).streamSetting, false);
    });
    for (const target of targets) {
        const saved = target.page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/save');
        await target.page.evaluate(() => window.$('#stream_toggle').prop('checked', true).trigger('change'));
        assert.equal((await saved).status(), 200);
    }
    for (const action of ['send', 'regenerate', 'swipe']) await checkpoint(`native-${action}`,
        (target, before, index) => nativeGenerate(target, action, `native-${action}`, before, index));
    for (const [direction, label] of [['left', 'native-regenerate'], ['right', 'native-swipe']]) {
        await checkpoint(`native-branch-${direction}`, async (target, before, index) => {
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            await delay(500);
            await target.page.locator('#chat .mes').last().locator(`.swipe_${direction}`).click();
            await target.page.waitForFunction(label => window.TavernHelper.getVariables({ type: 'message' }).p3_reply_label === label, label);
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            assert.equal(model.records[target.side].length, index);
            assert.equal(await target.page.evaluate(() => window.TavernHelper.getVariables({ type: 'message' }).p3_reply_runs), 1);
        });
    }
    await checkpoint('native-stop-regeneration', async (target, before, index) => {
        model.plan(target.side, 'native-stop-regeneration', { mode: 'stalled' });
        await target.page.locator('#options_button').click();
        await target.page.locator('#option_regenerate').click();
        await target.page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1).mes.includes('waiting'));
        await target.page.locator('#mes_stop').click();
        await target.page.locator('#mes_stop').waitFor({ state: 'hidden' });
        await until(() => model.records[target.side][index].closedEarly, 'Native stopped regeneration left the model connected.');
        await target.page.waitForFunction(() => window.p3Trace.some(event => event.name === 'GENERATION_ENDED'));
        assert.equal(model.records[target.side].length, index + 1);
        assert.equal((await snapshot(target)).variables.p3_preset_runs, before.variables.p3_preset_runs + 1);
    });
    await checkpoint('native-recovery',
        (target, before, index) => nativeGenerate(target, 'regenerate', 'native-recovery', before, index));
    for (const target of targets) await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-desktop.png`, output)), fullPage: true });
    const saved = await snapshot(targets[0]);
    setStage('mobile-reload');
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(1200);
        await target.context.close();
        const replacement = await newTarget(target.side, target.base, target.credentials, { width: 390, height: 844 });
        replacement.avatar = target.avatar;
        targets[index] = replacement;
        await openChat(replacement, false);
        await connect(replacement);
        assert.deepEqual(await snapshot(replacement), saved, `${target.side}: mobile reload lost generation state`);
        assert.equal(await replacement.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await replacement.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-mobile.png`, output)), fullPage: true });
    }
    await checkpoint('native-mobile-send',
        (target, before, index) => nativeGenerate(target, 'send', 'native-mobile-send', before, index));
    for (const target of targets) await target.page.screenshot({
        path: fileURLToPath(new URL(`${target.side}-mobile-generated.png`, output)), fullPage: true });
    assert.deepEqual(evidence.failures, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.deepEqual(evidence.external.filter(item => item.blocked || item.status >= 400), []);
    assert.deepEqual(evidence.tokenRequests.worker, []);
    assert.ok(evidence.tokenRequests.original.length > 0, 'Original ST must keep its native tokenizer.');
    evidence.status = evidence.boundaries.every(item => item.closedWithinFiveSeconds) ? 'passed' : 'partial';
    evidence.finishedAt = new Date().toISOString();
    evidence.scope = 'Pinned actual plugins, independent original ST and local Workers; synthetic text only. Not community/MVU/cloud acceptance.';
}
try {
    await Promise.race([run(), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`P3 generation watchdog: ${stage}`)), 480000);
    })]);
    console.log(`P3 generation ${evidence.status}: ${evidence.cases.length} state/request/lifecycle comparisons; `
        + `${evidence.boundaries.filter(item => !item.closedWithinFiveSeconds).length} cancellation boundary failures.`);
    if (evidence.status !== 'passed') process.exitCode = 1;
} catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, message: error.message };
    for (const target of targets) {
        evidence[`${target.side}Failure`] = { console: target.consoleTail, snapshot: await snapshot(target).catch(() => null),
            trace: await target.page.evaluate(() => window.p3Trace).catch(() => null) };
        await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-failure.png`, output)), fullPage: true }).catch(() => {});
    }
    console.error(`P3 generation failed at ${stage}: ${error.message}`);
    throw error;
} finally {
    clearTimeout(watchdog);
    await browser?.close();
    await stopChild(preview);
    await original?.close();
    model.server.closeAllConnections();
    if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
    await mkdir(output, { recursive: true });
    await writeFile(new URL('results.json', output), JSON.stringify({ ...evidence, modelRequests: model.records }, null, 2));
    await writeFile(new URL('../latest.json', output), JSON.stringify({ runId, status: evidence.status,
        results: `${runId}/results.json`, failure: evidence.failure }, null, 2));
}
