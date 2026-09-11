import assert from 'node:assert/strict';
import { ownerClient, ownerStorageState } from './owner-client.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stopChild } from './upstream-browser-server.mjs';
import { PLUGIN_BASELINES } from './plugin-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../.build/p3-browser/', import.meta.url);
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
const base = 'http://127.0.0.1:8796', modelBase = 'http://127.0.0.1:8797';
const persistence = `.wrangler/p3-test/${randomUUID()}`;
let owner;
const evidence = { plugins: PLUGIN_BASELINES.map(({ id, commit, version }) => ({ id, commit, version })),
    stages: [], requests: [], failures: [], pageErrors: [], consoleErrors: [], external: [], tokenRequests: [],
    consoleTail: [], statusCancellations: [] };
const consoleChecks = [];
let browser, preview, page, avatar, post, stage = 'startup', watchdog;
const setStage = value => { stage = value; console.log(value); evidence.stages.push(value); };
const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'stworks-p3-fixture' }] }));
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    evidence.requests.push(body);
    const text = `P3 MODEL REPLY ${evidence.requests.length}.`;
    if (body.stream) return res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        .end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
});
const send = (pathname, options = {}) => fetch(`${base}${pathname}`, {
    ...options, signal: AbortSignal.timeout(15000), headers: { ...owner?.headers, ...options.headers },
});
async function waitFor(callback, message) {
    for (let i = 0; i < 100; i++) {
        if (await callback()) return;
        await delay(100);
    }
    throw new Error(message);
}

async function openPage(viewport) {
    const context = await browser.newContext({ storageState: await ownerStorageState(base, AUTH_PASSWORD),
        viewport, locale: 'en-US', serviceWorkers: 'block', ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    context.setDefaultTimeout(30000);
    const allowed = new Set([
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
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base || allowed.has(url.href)) return route.continue();
        evidence.external.push({ url: url.href, blocked: true });
        return route.abort('blockedbyclient');
    });
    const target = await context.newPage();
    target.on('pageerror', error => evidence.pageErrors.push(error.stack ?? error.message));
    target.on('console', message => {
        if (message.type() === 'error') {
            const record = { text: message.text().slice(0, 500), location: message.location(), stage };
            consoleChecks.push((async () => {
                const argument = await message.args()[0]?.evaluate(value => ({
                    type: value?.constructor?.name, reason: value?.reason,
                })).catch(() => null);
                if (argument?.type === 'AbortReason' && argument.reason === 'Chat Completion source changed'
                    && record.location.url === `${base}/scripts/openai.js`) {
                    evidence.statusCancellations.push({ ...record, ...argument });
                } else evidence.consoleErrors.push(record);
            })());
        }
        evidence.consoleTail.push(message.text().slice(0, 500));
        if (evidence.consoleTail.length > 40) evidence.consoleTail.shift();
    });
    target.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/tokenizers/')) evidence.tokenRequests.push(request.url());
    });
    target.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== base) evidence.external.push({ url: url.href, status: response.status() });
        else if (response.status() >= 400) evidence.failures.push({ path: url.pathname, status: response.status() });
    });
    await target.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await target.waitForFunction(() => !!window.TavernHelper && !!window.EjsTemplate);
    await target.waitForFunction(avatar => window.SillyTavern?.getContext?.().characters.some(card => card.avatar === avatar), avatar);
    await target.waitForFunction(() => !document.querySelector('.splash-screen'));
    if (await target.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await target.locator('#rightNavDrawerIcon').click();
    await target.getByText('P3 Fixture', { exact: true }).first().click();
    await target.locator('#chat .mes_text').first().waitFor();
    if (await target.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await target.locator('#rightNavDrawerIcon').click();
    await target.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    return target;
}

async function scopedVariables(target) {
    return target.evaluate(() => Object.fromEntries(['global', 'preset', 'character', 'chat', 'message']
        .map(type => [type, window.TavernHelper.getVariables(type === 'message' ? { type, message_id: 0 } : { type })])));
}

async function run() {
    await mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { model.once('error', reject); model.listen(8797, '127.0.0.1', resolve); });
    const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(migration.status, 0, 'P3 migrations failed.');
    preview = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8796', '--inspector-port', '9246',
        '--assets', '.build/assets-p3', '--persist-to', persistence],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    preview.stdout.resume();
    preview.stderr.resume();
    let ready = false;
    for (let i = 0; i < 80; i++) {
        try { if ((await send('/csrf-token')).ok) { ready = true; break; } } catch { /* Starting. */ }
        await delay(500);
    }
    assert.ok(ready, 'P3 preview did not start.');
    owner = await ownerClient(base, AUTH_PASSWORD);
    const { token } = await (await send('/csrf-token')).json();
    post = async (pathname, data) => {
        const response = await send(pathname, { method: 'POST',
            headers: { Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        assert.ok(response.ok, `${pathname}: ${response.status} ${(await response.clone().text()).slice(0, 300)}`);
        return response;
    };
    setStage('authenticated plugin discovery and unchanged entry points');
    const discovered = await (await send('/api/extensions/discover')).json();
    for (const plugin of PLUGIN_BASELINES) {
        assert.ok(discovered.some(item => item.name === `third-party/${plugin.id}`));
        const prefix = `/scripts/extensions/third-party/${plugin.id}/`;
        for (const resource of ['manifest.json', 'dist/index.js', 'LICENSE', '__source.zip']) {
            assert.equal((await fetch(`${base}${prefix}${resource}`, { signal: AbortSignal.timeout(15000) })).status, 401);
            const response = await send(`${prefix}${resource}`);
            assert.equal(response.status, 200);
            if (resource === 'manifest.json') assert.equal((await response.json()).version, plugin.version);
            else await response.body.cancel();
        }
    }
    const settings = JSON.parse(await readFile(new URL('../../default/content/settings.json', import.meta.url), 'utf8'));
    Object.assign(settings, { firstRun: false, username: 'P3 Tester', main_api: 'openai' });
    settings.world_info_settings.world_info.globalSelect = ['P3 World'];
    Object.assign(settings.oai_settings, {
        chat_completion_source: 'custom', custom_url: `${modelBase}/v1`, custom_model: 'stworks-p3-fixture',
        stream_openai: false, openai_max_context: 8192, openai_max_tokens: 128,
        preset_settings_openai: 'P3 Preset', custom_prompt_post_processing: '',
    });
    // settings.json has only the legacy 100000 order. A saved preset also needs the native 100001 order.
    const defaultPreset = JSON.parse(await readFile(
        new URL('../../default/content/presets/openai/Default.json', import.meta.url), 'utf8'));
    settings.oai_settings.prompt_order = defaultPreset.prompt_order;
    settings.oai_settings.prompts = defaultPreset.prompts;
    settings.oai_settings.prompts.find(item => item.identifier === 'main').content =
        "P3 EJS PRESET <%= getvar('p3_chat') %>/<%= getvar('p3_global', {scope:'global'}) %>. <% setvar('p3_ejs_saved', 42, {scope:'local'}); %>";
    settings.extension_settings.tavern_helper = { audio: { enabled: false }, listener: { enabled: false } };
    await post('/api/worldinfo/edit', { name: 'P3 World', data: { entries: {
        0: { uid: 0, key: ['P3KEY'], keysecondary: [], content: "P3 EJS WORLD <%= getvar('p3_chat') %>.",
            comment: 'P3 synthetic', constant: false, selective: false, order: 100, position: 0,
            disable: false, probability: 100, useProbability: true },
    } } });
    await post('/api/presets/save', { apiId: 'openai', name: 'P3 Preset', preset: settings.oai_settings });
    await post('/api/settings/save', settings);
    const form = new FormData();
    form.set('file_type', 'json');
    form.set('avatar', new Blob([JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: 'P3 Fixture', description: 'P3 CARD {{char}} / {{user}}.', first_mes: 'P3 greeting.',
        extensions: { p3_unknown: { keep: [null, false, 3] } },
    } })]), 'p3.json');
    const imported = await send('/api/characters/import', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': token }, body: form });
    assert.equal(imported.status, 200);
    avatar = `${(await imported.json()).file_name}.png`;
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    setStage('actual Tavern Helper and EJS initialization');
    page = await openPage({ width: 1440, height: 1000 });
    evidence.helperVersion = await page.evaluate(() => window.TavernHelper.getTavernHelperVersion());
    assert.equal(evidence.helperVersion, '4.9.5');
    assert.ok(await page.locator('#tavern_helper').count());
    assert.ok(await page.locator('#prompt_template_settings').count());
    setStage('actual Helper worldbook, preset and global regex edits');
    evidence.editedResources = await page.evaluate(async () => {
        const h = window.TavernHelper;
        await h.updateWorldbookWith('P3 World', entries => entries.map(entry => ({
            ...entry, content: `${entry.content} P3 HELPER WORLD EDIT.`, extra: { p3_keep: [null, false, 3] },
        })));
        await h.updatePresetWith('P3 Preset', preset => ({
            ...preset, prompts: preset.prompts.map(prompt => prompt.id === 'main'
                ? { ...prompt, content: `${prompt.content} P3 HELPER PRESET EDIT.` } : prompt),
            extensions: { ...preset.extensions, p3_keep: [null, false, 3] },
        }));
        await new Promise((resolve, reject) => {
            const context = window.SillyTavern.getContext();
            context.eventSource.once(context.event_types.PRESET_CHANGED, resolve);
            if (!h.loadPreset('P3 Preset')) reject(new Error('Synthetic preset could not be selected.'));
        });
        await h.replaceTavernRegexes([{
            id: 'p3-regex', script_name: 'P3 Regex', enabled: true,
            find_regex: '/P3_RAW_MARKER/g', trim_strings: [], replace_string: 'P3_CLEAN_MARKER',
            source: { user_input: true, ai_output: false, slash_command: false, world_info: false, reasoning: false },
            destination: { display: false, prompt: true }, run_on_edit: true, min_depth: null, max_depth: null,
        }], { type: 'global' });
        return { world: await h.getWorldbook('P3 World'), preset: h.getPreset('P3 Preset'),
            regex: h.getTavernRegexes({ type: 'global' }) };
    });
    setStage('actual Helper global/preset/character/chat/message variables');
    await page.evaluate(async () => {
        const h = window.TavernHelper;
        for (const type of ['global', 'preset', 'character', 'chat', 'message']) {
            h.insertOrAssignVariables({ [`p3_${type}`]: type, p3_unknown: [null, false, { keep: true }] },
                type === 'message' ? { type, message_id: 0 } : { type });
        }
        await window.SillyTavern.getContext().saveChat();
    });
    const initialVariables = await scopedVariables(page);
    for (const [type, values] of Object.entries(initialVariables)) assert.equal(values[`p3_${type}`], type);
    evidence.initialVariables = initialVariables;
    setStage('EJS evaluation reads Helper variables and saves changes');
    const evaluated = await page.evaluate(async () => {
        const text = await window.EjsTemplate.evalTemplate(
            "<% setvar('p3_ejs_direct', 9, {scope:'local'}); %><%= getvar('p3_chat') %>/<%= getvar('p3_global', {scope:'global'}) %>");
        await window.EjsTemplate.saveVariables();
        return { text, variables: window.TavernHelper.getVariables({ type: 'chat' }) };
    });
    assert.equal(evaluated.text, 'chat/global');
    assert.equal(evaluated.variables.p3_ejs_direct, 9);
    setStage('original UI generation with both plugins enabled');
    await page.locator('#API-status-top').click();
    const connected = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await page.locator('#api_button_openai').click();
    assert.equal((await connected).status(), 200);
    await page.locator('#API-status-top').click();
    await page.locator('#api_button_openai').waitFor({ state: 'hidden' });
    await page.locator('#send_textarea').fill('P3KEY hello {{char}}. P3_RAW_MARKER');
    await page.locator('#send_but').click();
    await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes.includes('P3 MODEL REPLY 1.'));
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    assert.match(JSON.stringify(evidence.requests[0].messages), /P3 EJS PRESET chat\/global/);
    assert.match(JSON.stringify(evidence.requests[0].messages), /P3 EJS WORLD chat/);
    assert.match(JSON.stringify(evidence.requests[0].messages), /P3 HELPER WORLD EDIT/);
    assert.match(JSON.stringify(evidence.requests[0].messages), /P3 HELPER PRESET EDIT/);
    assert.match(JSON.stringify(evidence.requests[0].messages), /P3_CLEAN_MARKER/);
    assert.doesNotMatch(JSON.stringify(evidence.requests[0].messages), /P3_RAW_MARKER/);
    assert.doesNotMatch(JSON.stringify(evidence.requests[0].messages), /<%/);
    assert.equal(await page.evaluate(() => window.TavernHelper.getVariables({ type: 'chat' }).p3_ejs_saved), 42);
    setStage('actual Helper generate and generateRaw');
    const responses = await page.evaluate(async () => {
        const count = window.SillyTavern.getContext().chat.length;
        const first = await window.TavernHelper.generate({ user_input: 'P3KEY HELPER GENERATE', should_stream: false });
        const second = await window.TavernHelper.generateRaw({ user_input: 'P3 RAW INPUT', should_stream: false,
            ordered_prompts: [{ role: 'system', content: 'P3 RAW SYSTEM' }, 'user_input'] });
        return { first, second, before: count, after: window.SillyTavern.getContext().chat.length };
    });
    assert.match(responses.first, /P3 MODEL REPLY 2/);
    assert.match(responses.second, /P3 MODEL REPLY 3/);
    assert.equal(responses.before, responses.after);
    evidence.helperGeneration = responses;
    setStage('Helper message writes and real swipe variable branches');
    await page.evaluate(async () => {
        await window.TavernHelper.setChatMessages([{ message_id: -1, swipe_id: 0, swipes: ['P3 branch A', 'P3 branch B'],
            swipes_data: [{ p3_branch: 'A' }, { p3_branch: 'B' }] }], { refresh: 'all' });
    });
    assert.equal(await page.evaluate(() => window.TavernHelper.getVariables({ type: 'message' }).p3_branch), 'A');
    await page.locator('#chat .mes').last().locator('.swipe_right').click();
    await page.waitForFunction(() => window.TavernHelper.getVariables({ type: 'message' }).p3_branch === 'B');
    await page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
    await delay(500);
    await page.locator('#chat .mes').last().locator('.swipe_left').click();
    await page.waitForFunction(() => window.TavernHelper.getVariables({ type: 'message' }).p3_branch === 'A');
    await page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
    setStage('Helper script iframe and event cleanup');
    const script = {
        type: 'script', id: 'p3-synthetic-script', name: 'P3 Synthetic Script', enabled: true,
        content: `parent.p3Lifecycle ??= { mounts: 0, hides: 0, hits: 0 };
parent.p3Lifecycle.mounts++;
eventOn('p3-lifecycle-probe', () => parent.p3Lifecycle.hits++);
$(window).on('pagehide', () => parent.p3Lifecycle.hides++);
parent.p3ScriptBridge = { id: getScriptId(), helper: getTavernHelperVersion(), ejs: typeof EjsTemplate.evalTemplate };`,
    };
    await page.evaluate(script => window.TavernHelper.replaceScriptTrees([script], { type: 'global' }), script);
    await page.waitForFunction(() => window.p3ScriptBridge?.id === 'p3-synthetic-script');
    await page.evaluate(() => window.SillyTavern.getContext().eventSource.emit('p3-lifecycle-probe'));
    assert.equal(await page.evaluate(() => window.p3Lifecycle.hits), 1);
    await page.evaluate(() => window.TavernHelper.updateScriptTreesWith(trees => trees.map(tree => ({ ...tree, enabled: false })), { type: 'global' }));
    await page.waitForFunction(() => window.p3Lifecycle.hides === 1);
    await page.evaluate(() => window.SillyTavern.getContext().eventSource.emit('p3-lifecycle-probe'));
    assert.equal(await page.evaluate(() => window.p3Lifecycle.hits), 1, 'Disabled iframe left a live listener.');
    await page.evaluate(() => window.TavernHelper.updateScriptTreesWith(trees => trees.map(tree => ({ ...tree, enabled: true })), { type: 'global' }));
    await page.waitForFunction(() => window.p3Lifecycle.mounts === 2);
    await page.evaluate(() => window.SillyTavern.getContext().eventSource.emit('p3-lifecycle-probe'));
    assert.equal(await page.evaluate(() => window.p3Lifecycle.hits), 2);
    evidence.scriptLifecycle = await page.evaluate(() => ({ ...window.p3Lifecycle, bridge: window.p3ScriptBridge }));
    setStage('real rendered HTML iframe button updates chat variables');
    const html = '```html\n<!DOCTYPE html><html><body style="margin:0;padding:16px;background:#202325;color:#fff;font:16px sans-serif">'
        + '<button id="p3-counter" style="padding:8px 16px">P3 +1</button><output id="p3-value"></output>'
        + '<script>const show=()=>document.getElementById("p3-value").textContent=getVariables({type:"chat"}).p3_clicks||0;'
        + 'document.getElementById("p3-counter").onclick=()=>{updateVariablesWith(v=>({...v,p3_clicks:(v.p3_clicks||0)+1}),{type:"chat"});show();};'
        + 'show();</script></body></html>\n```';
    await page.evaluate(async message => {
        await window.TavernHelper.createChatMessages([{ role: 'assistant', message }], { refresh: 'all' });
    }, html);
    const rendered = page.frameLocator('iframe[id^="TH-message"]').last();
    await rendered.locator('#p3-counter').click();
    await page.waitForFunction(() => window.TavernHelper.getVariables({ type: 'chat' }).p3_clicks === 1);
    assert.equal(await rendered.locator('#p3-value').textContent(), '1');
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), fullPage: true });
    setStage('persisted plugin scopes and fresh mobile context');
    await page.evaluate(() => window.SillyTavern.getContext().saveChat());
    const beforeReload = await scopedVariables(page);
    const file = await page.evaluate(() => window.SillyTavern.getContext().chatId);
    await waitFor(async () => {
        const saved = await (await post('/api/chats/get', { avatar_url: avatar, file_name: file })).json();
        return saved[0]?.chat_metadata?.variables?.p3_clicks === 1;
    }, 'Iframe variable did not persist in chat storage.');
    await delay(1500);
    await page.context().close();
    page = await openPage({ width: 390, height: 844 });
    await page.waitForFunction(() => !!window.p3ScriptBridge);
    assert.deepEqual(await scopedVariables(page), beforeReload);
    evidence.reloadedResources = await page.evaluate(async () => {
        const h = window.TavernHelper;
        return { world: await h.getWorldbook('P3 World'), preset: h.getPreset('P3 Preset'),
            regex: h.getTavernRegexes({ type: 'global' }) };
    });
    assert.deepEqual(evidence.reloadedResources.world, evidence.editedResources.world);
    assert.deepEqual(evidence.reloadedResources.regex, evidence.editedResources.regex);
    assert.deepEqual(evidence.reloadedResources.preset.extensions.p3_keep, [null, false, 3]);
    assert.match(evidence.reloadedResources.preset.prompts.find(prompt => prompt.id === 'main').content, /P3 HELPER PRESET EDIT/);
    const mobileFrame = page.frameLocator('iframe[id^="TH-message"]').last();
    await mobileFrame.locator('#p3-counter').click();
    await page.waitForFunction(() => window.TavernHelper.getVariables({ type: 'chat' }).p3_clicks === 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    evidence.reloadedVariables = await scopedVariables(page);
    await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), fullPage: true });
    await Promise.all(consoleChecks);
    assert.deepEqual(evidence.failures, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.deepEqual(evidence.tokenRequests, []);
    assert.deepEqual(evidence.external.filter(request => request.blocked || request.status >= 400), []);
    evidence.scope = 'Actual pinned plugins and synthetic fixture on local Workers/D1/R2. Not real community/MVU, cloud, update or redistribution clearance.';
    await writeFile(new URL('results.json', output), JSON.stringify(evidence, null, 2));
    console.log('P3 actual plugin local regression passed.');
}
try {
    await Promise.race([run(), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`P3 watchdog: ${stage}`)), 240000);
    })]);
} catch (error) {
    console.error(`P3 failed at ${stage}: ${error.message}`);
    if (page && !page.isClosed()) {
        await page.screenshot({ path: fileURLToPath(new URL('failure.png', output)), fullPage: true }).catch(() => {});
        evidence.lastChat = await page.evaluate(() => window.SillyTavern?.getContext().chat).catch(() => null);
        evidence.lastDom = await page.locator('#chat .mes').last().evaluate(el => ({
            classes: el.className, html: el.innerHTML.slice(-6000),
        })).catch(() => null);
    }
    await writeFile(new URL('failure.json', output), JSON.stringify({ stage, error: error.message, ...evidence }, null, 2));
    throw error;
} finally {
    clearTimeout(watchdog);
    await browser?.close();
    await stopChild(preview);
    model.closeAllConnections();
    if (model.listening) await new Promise(resolve => model.close(resolve));
}
