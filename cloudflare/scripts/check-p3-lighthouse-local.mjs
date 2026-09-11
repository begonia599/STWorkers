import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { createGenerationModel } from './p3-generation-model.mjs';
import { startUpstreamBrowserServer, stopChild } from './upstream-browser-server.mjs';
import { PLUGIN_BASELINES } from './plugin-package.mjs';
import { runCard2Cases } from './p3-card2-cases.mjs';
import { runTransferCases } from './p3-transfer-cases.mjs';

const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { parse } = createRequire(new URL('../../package.json', import.meta.url))('acorn');
const [chrome, bundle, cardPath, runtimePath, suite = 'baseline', sourceRoot, replayPath] = process.argv.slice(3);
assert.ok(['baseline', 'card2', 'transfer'].includes(suite));
assert.ok(bundle && cardPath && runtimePath, 'Supply Playwright package.json, Chrome, plugin bundle, card JSON, reviewed MVU JS.');
const project = fileURLToPath(new URL('../../', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
assert.ok(AUTH_PASSWORD);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cardBytes = await readFile(cardPath);
const card = JSON.parse(cardBytes.toString());
const runtimeBytes = await readFile(runtimePath);
const replay = replayPath ? JSON.parse(await readFile(replayPath, 'utf8')) : null;
if (replay) assert.equal(replay.runtime.sha256, hash(runtimeBytes), 'Replay MVU bytes differ');
const runtimeUrl = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
assert.equal(card.data.extensions.tavern_helper.scripts[0].content, `import '${runtimeUrl}'`);
const initial = parseYaml(card.data.character_book.entries.find(entry => entry.comment.includes('[InitVar]')).content);
const runId = randomUUID();
const output = new URL(`../.build/p3-lighthouse/${runId}/`, import.meta.url);
const workerBase = 'http://127.0.0.1:8801', modelBase = 'http://127.0.0.1:8803';
const model = createGenerationModel();
const evidence = {
    runId, startedAt: new Date().toISOString(), status: 'running', suite,
    dependencyMode: replay ? 'recorded-cdn-replay' : 'live-cdn-cache',
    replayRunId: replay?.runId ?? null,
    card: { name: card.data.name, bytes: cardBytes.length, sha256: hash(cardBytes) },
    runtime: { url: runtimeUrl, bytes: runtimeBytes.length, sha256: hash(runtimeBytes), commit: null },
    plugins: PLUGIN_BASELINES.map(({ id, commit, version }) => ({ id, commit, version })),
    cases: [], observations: [], failures: [], pageErrors: [], consoleErrors: [], external: [],
    tokenRequests: { worker: [], original: [] },
    scope: `${suite !== 'baseline' ? 'Explicit v1.1 revision of user smoke card' : 'Unmodified user smoke card'}, real MVU and plugins, isolated original/Worker browsers, synthetic model replies. No real-model fill or cloud acceptance.`,
};
const external = new Set([
    runtimeUrl,
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
const cache = new Map();
const targets = [];
let browser, preview, original, watchdog, stage = 'startup';
const setStage = value => { stage = value; console.log(value); };
function discoverImports(bytes, url) {
    let ast;
    try { ast = parse(bytes.toString(), { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch { return; }
    for (const node of ast.body) {
        if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
        const dependency = new URL(node.source.value, url);
        assert.equal(dependency.origin, 'https://testingcf.jsdelivr.net');
        assert.ok(dependency.pathname.startsWith('/npm/'));
        external.add(dependency.href);
    }
}
discoverImports(runtimeBytes, runtimeUrl);
async function until(callback, description) {
    for (let index = 0; index < 150; index++) {
        if (await callback()) return;
        await delay(100);
    }
    throw new Error(description);
}
async function newTarget(side, base, credentials, mobile = false) {
    const context = await browser.newContext({
        httpCredentials: { ...credentials, origin: base }, locale: 'en-US', serviceWorkers: 'block',
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    context.setDefaultTimeout(40000);
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
        if (!external.has(url.href)) {
            evidence.external.push({ side, url: url.href, blocked: true, stage });
            return route.abort('blockedbyclient');
        }
        try {
            if (!cache.has(url.href)) cache.set(url.href, (async () => {
                let body = runtimeBytes, contentType = 'application/javascript';
                if (url.href !== runtimeUrl) {
                    if (replay) {
                        const entry = replay.external.find(item => item.url === url.href && item.sha256);
                        assert.ok(entry, `No recorded dependency: ${url.href}`);
                        assert.match(entry.sha256, /^[a-f0-9]{64}$/);
                        body = await readFile(new URL(`cdn/${entry.sha256}`, pathToFileURL(replayPath)));
                        assert.equal(hash(body), entry.sha256, 'Recorded dependency hash mismatch');
                        contentType = entry.contentType;
                    } else {
                    const response = await route.fetch({ maxRedirects: 0, timeout: 60000 });
                    assert.equal(response.status(), 200, `CDN ${response.status()}: ${url.href}`);
                    body = await response.body();
                    contentType = response.headers()['content-type'] ?? contentType;
                    await response.dispose();
                    }
                }
                if (/javascript/.test(contentType)) discoverImports(body, url.href);
                const sha256 = hash(body);
                await writeFile(new URL(`cdn/${sha256}`, output), body);
                evidence.external.push({ url: url.href, sha256, bytes: body.length, contentType });
                return { body, contentType };
            })());
            const { body, contentType } = await cache.get(url.href);
            await route.fulfill({ status: 200, contentType, headers: { 'Access-Control-Allow-Origin': '*' }, body });
        } catch (error) {
            evidence.external.push({ side, url: url.href, stage, error: String(error) });
            await route.abort('failed').catch(() => {});
        }
    });
    const page = await context.newPage();
    const consoleTail = [];
    page.on('pageerror', error => evidence.pageErrors.push({ side, stage, error: String(error) }));
    page.on('console', message => {
        const text = message.text().slice(0, 1000);
        consoleTail.push(text);
        if (consoleTail.length > 50) consoleTail.shift();
        if (message.type() === 'error') evidence.consoleErrors.push({ side, stage, text, location: message.location() });
    });
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === base && response.status() >= 400) evidence.failures.push({ side, stage, path: url.pathname, status: response.status() });
    });
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === base && url.pathname.startsWith('/api/tokenizers/')) evidence.tokenRequests[side].push(url.pathname);
    });
    const csrfResponse = await context.request.get(`${base}/csrf-token`);
    assert.ok(csrfResponse.ok());
    const { token } = await csrfResponse.json();
    const post = async (pathname, data, multipart = false) => {
        const response = await context.request.post(`${base}${pathname}`, {
            headers: { Origin: base, 'X-CSRF-Token': token }, ...(multipart ? { multipart: data } : { data }),
        });
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
    Object.assign(settings, { firstRun: false, username: 'Smoke Observer', main_api: 'openai' });
    settings.power_user.world_import_dialog = false;
    Object.assign(settings.oai_settings, {
        prompts: preset.prompts, prompt_order: preset.prompt_order, chat_completion_source: 'custom',
        custom_url: `${modelBase}/${target.side}/v1`, custom_model: 'p3-generation-fixture',
        stream_openai: true, openai_max_context: 32768, openai_max_tokens: 2048,
        preset_settings_openai: 'Lighthouse', custom_prompt_post_processing: '',
    });
    settings.extension_settings.disabledExtensions = builtins.filter(name => !['regex', 'quick-reply'].includes(name));
    // Test-only owner consent, not a replacement for the production enablement dialogs.
    settings.extension_settings.tavern_helper = {
        audio: { enabled: false }, listener: { enabled: false },
        script: { enabled: { characters: [card.data.name] } },
    };
    const response = await target.post('/api/characters/import', {
        file_type: 'json', avatar: { name: 'lighthouse.json', mimeType: 'application/json', buffer: cardBytes },
    }, true);
    target.avatar = `${(await response.json()).file_name}.png`;
    settings.extension_settings.character_allowed_regex = [target.avatar];
    await target.post('/api/presets/save', { apiId: 'openai', name: 'Lighthouse', preset: settings.oai_settings });
    await target.post('/api/settings/save', settings);
}
async function openChat(target, initialize = false, byAvatar = false) {
    const { page, base, avatar } = target;
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.TavernHelper && !!window.EjsTemplate);
    await page.waitForFunction(avatar => window.SillyTavern.getContext().characters.some(card => card.avatar === avatar), avatar);
    await page.waitForFunction(() => !document.querySelector('.splash-screen'));
    if (initialize) {
        await page.evaluate(async book => {
            const wi = await import('/scripts/world-info.js');
            await wi.saveWorldInfo(book.name, wi.convertCharacterBook(book), true);
            await wi.updateWorldInfoList();
        }, card.data.character_book);
    }
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await page.locator('#rightNavDrawerIcon').click();
    if (byAvatar) {
        await page.evaluate(async avatar => {
            const st = await import('/script.js');
            await st.selectCharacterById(st.characters.findIndex(c => c.avatar === avatar));
        }, avatar);
    } else await page.getByText(card.data.name, { exact: true }).first().click();
    await page.locator('#chat .mes_text').first().waitFor();
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !!window.Mvu);
    if (initialize) await page.evaluate(async () => (await import('/script.js')).doNewChat());
    await page.waitForFunction(() => !!window.Mvu.getMvuData({ type: 'message' }).stat_data?.['\u4e16\u754c']);
    await page.evaluate(instrumentDispatch => {
        const c = window.SillyTavern.getContext();
        window.lighthouseTrace = [];
        window.lighthouseDispatch = [];
        window.lighthouseMvuRenderedMessage = null;
        if (instrumentDispatch && !window.lighthouseEmitWrapped) {
            const names = new Map(Object.entries(c.eventTypes).map(([name, event]) => [event, name]));
            for (const [name, event] of Object.entries(window.Mvu.events)) names.set(event, `MVU:${name}`);
            const emit = c.eventSource.emit;
            // Observe invocation, not our listener's position in an asynchronously reordered list.
            c.eventSource.emit = function (event, ...args) {
                let name = names.get(event);
                if (name === 'GENERATION_STARTED' && args[2] === true) name = 'PREVIEW_STARTED';
                if (name === 'CHARACTER_MESSAGE_RENDERED' && window.lighthouseDispatch.some(item =>
                    item.name === 'MVU:BEFORE_MESSAGE_UPDATE' && item.role === 'assistant')) {
                    window.lighthouseMvuRenderedMessage = Number(args[0]);
                }
                if (name?.startsWith('MVU:') || ['GENERATION_STARTED', 'PREVIEW_STARTED', 'MESSAGE_RECEIVED',
                    'GENERATION_ENDED', 'MESSAGE_SENT', 'MESSAGE_SWIPED'].includes(name)) {
                    window.lighthouseDispatch.push({ name, role: c.chat.at(-1)?.is_user ? 'user' : 'assistant' });
                }
                return Reflect.apply(emit, this, [event, ...args]);
            };
            window.lighthouseEmitWrapped = true;
        }
        for (const name of ['GENERATION_STARTED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'MESSAGE_SWIPED']) {
            c.eventSource.on(c.eventTypes[name], (...args) => window.lighthouseTrace.push(
                name === 'GENERATION_STARTED' && args[2] === true ? 'PREVIEW_STARTED' : name));
        }
        for (const [name, event] of Object.entries(window.Mvu.events)) {
            c.eventSource.on(event, () => window.lighthouseTrace.push(`MVU:${name}`));
        }
    }, suite !== 'baseline');
}
async function connect(target) {
    await target.page.locator('#API-status-top').click();
    const pending = target.page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await target.page.locator('#api_button_openai').click();
    assert.equal((await pending).status(), 200);
    await target.page.locator('#API-status-top').click();
    await target.page.locator('#api_button_openai').waitFor({ state: 'hidden' });
}
async function snapshot(target) {
    return target.page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        return {
            stat: window.Mvu?.getMvuData({ type: 'message' }).stat_data,
            timed: {
                sticky: c.chatMetadata.timedWorldInfo?.sticky ?? {},
                cooldown: c.chatMetadata.timedWorldInfo?.cooldown ?? {},
            },
            messages: c.chat.map(m => ({
                mes: m.mes, is_user: m.is_user, swipe_id: m.swipe_id ?? 0,
                swipes: m.swipes ?? [m.mes], variables: m.variables ?? [],
            })),
        };
    });
}
async function checkpoint(label, action) {
    setStage(label);
    const details = {};
    for (const target of targets) {
        await target.page.evaluate(() => {
            window.lighthouseTrace = [];
            window.lighthouseDispatch = [];
            window.lighthouseMvuRenderedMessage = null;
        });
        const before = await snapshot(target);
        const index = model.records[target.side].length;
        const observation = await action(target, before, index);
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(350);
        details[target.side] = {
            before, state: await snapshot(target), observation,
            trace: await target.page.evaluate(() => window.lighthouseTrace),
            dispatch: await target.page.evaluate(() => window.lighthouseDispatch),
            rawTimedMetadata: await target.page.evaluate(() => window.SillyTavern.getContext().chatMetadata.timedWorldInfo ?? null),
            requests: model.records[target.side].slice(index),
        };
    }
    evidence.cases.push({ label, ...details });
    assert.deepEqual(details.worker.state, details.original.state, `${label}: original/Worker state differs`);
    assert.deepEqual(details.worker.observation, details.original.observation, `${label}: original/Worker observation differs`);
    assert.deepEqual(details.worker.requests.map(r => r.body), details.original.requests.map(r => r.body), `${label}: prompts differ`);
    if (label === 'runtime-command-probes-nonpersistent') {
        for (const side of ['worker', 'original']) {
            assert.deepEqual(details[side].state, details[side].before, 'Diagnostic probe changed persistent chat state');
        }
    }
    evidence.observations.push({ label, traceIdentical: JSON.stringify(details.worker.trace) === JSON.stringify(details.original.trace) });
    if (suite === 'card2') {
        const relevant = value => value.filter(event => event.name !== 'PREVIEW_STARTED');
        evidence.observations.push({ label, dispatchIdentical: JSON.stringify(relevant(details.worker.dispatch))
            === JSON.stringify(relevant(details.original.dispatch)) });
        assert.deepEqual(relevant(details.worker.dispatch), relevant(details.original.dispatch),
            `${label}: event invocation order differs`);
    }
}
const world = '\u4e16\u754c', person = '\u6c88\u8232', duty = '\u503c\u73ed';
const rapport = '\u597d\u611f\u5ea6', thought = '\u5f53\u524d\u6240\u60f3', inventory = '\u7269\u54c1\u680f';
const timeKey = '\u5f53\u524d\u65f6\u95f4', weather = '\u5929\u6c14', wind = '\u98ce\u529b';
const completed = '\u4ea4\u63a5\u9879\u5b8c\u6210', first = '\u9996\u6b21\u4ea4\u8c08\u5df2\u8bb0\u5f55';
const command = (path, ...values) => `_.set(${[path, ...values].map(v => JSON.stringify(v)).join(', ')});`;
async function macroPanels(target) {
    return target.page.evaluate(({ person, rapport }) => {
        const c = window.SillyTavern.getContext();
        return [...document.querySelectorAll('#chat .mes')].flatMap(element => {
            const text = element.querySelector('.mes_text')?.innerText ?? '';
            const marker = text.indexOf('SMOKE-PANEL-MACRO');
            if (marker < 0) return [];
            const id = Number(element.getAttribute('mesid'));
            const value = Number(text.slice(marker).match(/\u597d\u611f\s+(\d+)/)?.[1]);
            const stored = c.chat[id].variables[c.chat[id].swipe_id ?? 0].stat_data[person][rapport];
            return [{ id, value, stored, matchesMessage: value === stored }];
        });
    }, { person, rapport });
}
async function jqueryPanels(target) {
    const result = [];
    for (const frame of target.page.frames()) {
        const panel = await frame.evaluate(() => {
            const element = document.querySelector('#smoke-panel');
            if (!element) return null;
            return { id: getCurrentMessageId(), text: element.innerText,
                unavailable: element.dataset.state === 'unavailable',
                overflow: document.documentElement.scrollWidth > innerWidth,
                foreground: getComputedStyle(element).color,
                panelBackground: getComputedStyle(element).backgroundColor };
        }).catch(() => null);
        if (panel) result.push(panel);
    }
    return result.sort((a, b) => a.id - b.id);
}
async function readyJqueryPanels(target, { expectedCleanedIds = [] } = {}) {
    const assistantCount = (await snapshot(target)).messages.filter(m => !m.is_user).length;
    const matchesState = (panel, state) => {
        const message = state.messages[panel.id];
        const stat = message?.variables[message.swipe_id]?.stat_data;
        if (!stat) return expectedCleanedIds.includes(panel.id)
            && (panel.unavailable || panel.text.includes(' / 100'));
        const required = [
            `${stat[person][rapport]} / 100`,
            ...[stat[world]?.[timeKey], stat[world]?.[weather], stat[person]?.[thought]]
                .filter(value => value !== undefined).map(String),
        ];
        const items = stat[person]?.[inventory];
        if (items) required.push(...(Object.keys(items).length ? Object.keys(items) : ['\uff08\u7a7a\uff09']));
        return required.every(text => panel.text.includes(text));
    };
    const cleanedIds = state => state.messages.flatMap((m, id) =>
        !m.is_user && !m.variables[m.swipe_id]?.stat_data ? [id] : []);
    await until(async () => {
        const panels = await jqueryPanels(target);
        const state = await snapshot(target);
        return JSON.stringify(cleanedIds(state)) === JSON.stringify(expectedCleanedIds)
            && panels.length === assistantCount && panels.every(p =>
            p.text.includes('SMOKE-PANEL-JQUERY') && matchesState(p, state));
    }, `${target.side}: jQuery panels did not render`);
    const panels = await jqueryPanels(target);
    const state = await snapshot(target);
    for (const panel of panels) {
        const m = state.messages[panel.id];
        const stat = m.variables[m.swipe_id]?.stat_data;
        if (stat) assert.ok(panel.text.includes(`${stat[person][rapport]} / 100`), `Panel ${panel.id}: wrong message variable`);
        assert.equal(panel.overflow, false);
    }
    return panels;
}
async function generate(target, action, label, commands, expectedRapport, input = 'SMOKE observation.') {
    const index = model.records[target.side].length;
    model.plan(target.side, label, { text: `P3 ${label}. \u4f60\u597d.\n<UpdateVariable>\n${commands.join('\n')}\n</UpdateVariable>\n<StatusPlaceHolderImpl/>` });
    if (action === 'send') {
        await target.page.locator('#send_textarea').fill(input);
        await target.page.locator('#send_but').click();
    } else if (action === 'regenerate') {
        await target.page.locator('#options_button').click();
        await target.page.locator('#option_regenerate').click();
    } else await target.page.locator('#chat .mes').last().locator('.swipe_right').click();
    await target.page.waitForFunction(({ person, rapport, value }) =>
        window.Mvu.getMvuData({ type: 'message' }).stat_data?.[person]?.[rapport] === value,
    { person, rapport, value: expectedRapport });
    await target.page.waitForFunction(() => window.lighthouseTrace.includes('GENERATION_ENDED'));
    await target.page.locator('#mes_stop').waitFor({ state: 'hidden' });
    await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
    assert.equal(model.records[target.side].length, index + 1);
    const messages = model.records[target.side][index].body.messages;
    const prompt = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    assert.match(prompt, /SMOKE-PROBE-BEFORE-CHAR/);
    assert.match(prompt, /SMOKE-PROBE-AFTER-CHAR/);
    assert.doesNotMatch(prompt, /<%|{{format_message_variable::/);
    // The rules themselves contain example update blocks; only dialogue must be cleaned.
    for (const message of messages.filter(m => m.role === 'assistant')) {
        assert.doesNotMatch(JSON.stringify(message.content), /<StatusPlaceHolderImpl|<UpdateVariable>/);
    }
    return { visible: await target.page.locator('#chat .mes_text').last().innerText(), prompt };
}
async function run() {
    await mkdir(new URL('cdn/', output), { recursive: true });
    await new Promise((resolve, reject) => { model.server.once('error', reject); model.server.listen(8803, '127.0.0.1', resolve); });
    const persistence = `.wrangler/p3-lighthouse/${runId}`;
    const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(migration.status, 0, `Migrations: ${migration.stderr}`);
    preview = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8801', '--inspector-port', '9251',
        '--assets', '.build/assets-p3', '--persist-to', persistence],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    preview.stdout.resume();
    preview.stderr.resume();
    await until(async () => {
        try { return (await fetch(workerBase, { signal: AbortSignal.timeout(1000) })).status === 401; } catch { return false; }
    }, 'Worker startup timeout');
    original = await startUpstreamBrowserServer(8802, { pluginBundle: bundle });
    evidence.original = original.evidence;
    browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
    targets.push(await newTarget('worker', workerBase, { username: 'owner', password: AUTH_PASSWORD }));
    targets.push(await newTarget('original', original.base, original.credentials));
    for (const target of targets) {
        setStage(`${target.side}: import and fresh chat`);
        await seed(target);
        await openChat(target, true);
        await connect(target);
    }
    if (suite === 'transfer') {
        await runTransferCases({ targets, checkpoint, generate, snapshot, readyJqueryPanels, card,
            evidence, newTarget, openChat, connect, output, setStage });
    } else if (suite === 'card2') {
        await runCard2Cases({ targets, checkpoint, generate, snapshot, readyJqueryPanels, initial, card, sourceRoot,
            evidence, newTarget, openChat, connect, output, setStage });
    } else {
    await checkpoint('primary-bootstrap', async target => {
        assert.deepEqual((await snapshot(target)).stat, initial);
        return { visible: await target.page.locator('#chat .mes_text').first().innerText() };
    });
    await checkpoint('alternate-greeting', async target => {
        await target.page.locator('#chat .mes').first().locator('.swipe_right').click();
        await target.page.waitForFunction(({ person, rapport }) =>
            window.Mvu.getMvuData({ type: 'message' }).stat_data?.[person]?.[rapport] === 15, { person, rapport });
        await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
        await until(async () => (await target.page.locator('#chat .mes_text').first().innerText()).includes('15 / 100'),
            'Alternate greeting panel did not finish rendering');
        return { visible: await target.page.locator('#chat .mes_text').first().innerText() };
    });
    await checkpoint('primary-greeting-restored', async target => {
        await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
        await delay(500);
        await target.page.locator('#chat .mes').first().locator('.swipe_left').click();
        await target.page.waitForFunction(({ person, rapport }) =>
            window.Mvu.getMvuData({ type: 'message' }).stat_data?.[person]?.[rapport] === 30, { person, rapport });
    });
    await checkpoint('runtime-command-probes-nonpersistent', async target => target.page.evaluate(async ({ person, rapport, inventory }) => {
        const data = window.Mvu.getMvuData({ type: 'message' });
        const run = async (text, source = data) => (await window.Mvu.parseMessage(text, structuredClone(source)))?.stat_data ?? null;
        const item = '\u9a6c\u706f';
        const literal = "{\u6570\u91cf: 1, \u63cf\u8ff0: 'SMOKE lamp'}";
        const missing = `_.set('${person}.${inventory}.${item}', ${literal});`;
        const insert = `_.insert('${person}.${inventory}', '${item}', ${literal});`;
        const withItem = structuredClone(data);
        withItem.stat_data[person][inventory][item] = { '\u6570\u91cf': 1, '\u63cf\u8ff0': 'SMOKE lamp' };
        const extensible = structuredClone(data);
        extensible.schema.properties[person].properties[inventory].extensible = true;
        return {
            missingSet: await run(missing), insert: await run(insert),
            insertWithExtensibleSchema: await run(insert, extensible),
            wrongOld: await run(`_.set('${person}.${rapport}', 999, 34);`),
            delete: await run(`_.delete('${person}.${inventory}.${item}');`, withItem),
            readonly: await run(`_.set('${person}._\u7f16\u53f7', 'LT-07', 'CHANGED');`),
            outOfRange: await run(`_.set('${person}.${rapport}', 30, 999);`),
        };
    }, { person, rapport, inventory }));
    const commands = value => [
        command(`${world}.${timeKey}`, initial[world][timeKey], '3\u670811\u65e5 19:55'),
        command(`${world}.${weather}`, initial[world][weather], '\u96e8'),
        command(`${world}.${wind}`, 5, 6),
        command(`${person}.${rapport}`, 30, value),
        command(`${person}.${thought}`, initial[person][thought], 'SMOKE signed'),
        command(`${duty}.${completed}`, 0, 1),
        command(`${duty}.${first}`, '\u5426', '\u662f'),
    ];
    for (const [action, value] of [['send', 34], ['regenerate', 35], ['swipe', 36]]) {
        await checkpoint(`native-${action}`, target => generate(target, action, action, commands(value), value));
    }
    for (const [direction, value] of [['left', 35], ['right', 36]]) {
        await checkpoint(`branch-${direction}`, async target => {
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            await delay(500);
            await target.page.locator('#chat .mes').last().locator(`.swipe_${direction}`).click();
            await target.page.waitForFunction(({ person, rapport, value }) =>
                window.Mvu.getMvuData({ type: 'message' }).stat_data?.[person]?.[rapport] === value, { person, rapport, value });
        });
    }
    await checkpoint('second-turn-ejs-keyword', target => generate(target, 'send', 'second', [
        command(`${person}.${rapport}`, 36, 40), command(`${person}.${thought}`, 'SMOKE signed', 'SMOKE next'),
    ], 40, '\u65e7\u706f\u5ba4 \u96fe\u53f7 SMOKE next.'));
    const promptCases = evidence.cases.filter(c => c.worker.requests.length);
    for (const item of promptCases) {
        const prompt = item.worker.observation.prompt;
        assert.equal(prompt.includes('<Rapport '), item.label === 'second-turn-ejs-keyword');
        assert.equal(prompt.includes('\u4e8c\u5341\u4e03\u7bb1'), item.label === 'second-turn-ejs-keyword');
        assert.ok(!prompt.includes('\u4e8c\u7ea7\u7f38'), 'Probability-zero entry activated');
        assert.ok(!prompt.includes('\u6728\u7bb1\u73b0\u5728\u7a7a\u7740'), 'Negative-control entry activated');
    }
    await checkpoint('macro-panel-before-reload', macroPanels);
    for (const target of targets) await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-desktop.png`, output)), fullPage: true });
    const saved = await snapshot(targets[0]);
    setStage('mobile-reload');
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(1500);
        await target.context.close();
        const replacement = await newTarget(target.side, target.base, target.credentials, true);
        replacement.avatar = target.avatar;
        targets[index] = replacement;
        await openChat(replacement);
        assert.deepEqual(await snapshot(replacement), saved, `${target.side}: reload lost state`);
        assert.equal(await replacement.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await replacement.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-mobile.png`, output)), fullPage: true });
    }
    evidence.observations.push({ label: 'mobile-reload', state: saved, matchedBoth: true });
    await checkpoint('macro-panel-after-reload', macroPanels);
    await checkpoint('jquery-panel-toggle-test-copy', async target => {
        await target.page.evaluate(async () => {
            const c = window.SillyTavern.getContext();
            const regexes = structuredClone(c.characters[c.characterId].data.extensions.regex_scripts);
            regexes.find(r => r.id === 'smoke-rx-02-panel-macro').disabled = true;
            regexes.find(r => r.id === 'smoke-rx-03-panel-jquery').disabled = false;
            await (await import('/scripts/extensions.js')).writeExtensionField(c.characterId, 'regex_scripts', regexes);
            await (await import('/script.js')).reloadCurrentChat();
        });
        return readyJqueryPanels(target);
    });
    await checkpoint('jquery-mobile-generation', async target => {
        await connect(target);
        await generate(target, 'send', 'jquery-mobile', [command(`${person}.${rapport}`, 40, 41)], 41);
        return readyJqueryPanels(target);
    });
    for (const target of targets) await target.page.screenshot({
        path: fileURLToPath(new URL(`${target.side}-jquery-mobile.png`, output)), fullPage: true });
    setStage('jquery-desktop-reload');
    const jquerySaved = await snapshot(targets[0]);
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(1500);
        await target.context.close();
        const replacement = await newTarget(target.side, target.base, target.credentials);
        replacement.avatar = target.avatar;
        targets[index] = replacement;
        await openChat(replacement);
        assert.deepEqual(await snapshot(replacement), jquerySaved, `${target.side}: jQuery reload lost state`);
    }
    await checkpoint('jquery-panel-after-desktop-reload', readyJqueryPanels);
    for (const target of targets) await target.page.screenshot({
        path: fileURLToPath(new URL(`${target.side}-jquery-desktop.png`, output)), fullPage: true });
    }
    assert.equal(hash(await readFile(cardPath)), evidence.card.sha256, 'Original card was modified');
    assert.deepEqual(evidence.failures, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.deepEqual(evidence.external.filter(item => item.blocked || item.error), []);
    assert.deepEqual(evidence.tokenRequests.worker, []);
    assert.ok(model.records.worker.every(record => record.label !== 'UNPLANNED'));
    evidence.status = 'passed-with-observations';
    evidence.finishedAt = new Date().toISOString();
}
try {
    await Promise.race([run(), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Watchdog: ${stage}`)), 600000);
    })]);
    console.log(`Lighthouse ${evidence.status}: ${evidence.cases.length} comparisons.`);
} catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, message: error.message };
    for (const target of targets) {
        evidence[`${target.side}Failure`] = {
            console: target.consoleTail, snapshot: await snapshot(target).catch(() => null),
            panels: await jqueryPanels(target).catch(() => null),
            dispatch: await target.page.evaluate(() => window.lighthouseDispatch).catch(() => null),
            html: await target.page.locator('body').innerText().catch(() => null),
        };
        await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-failure.png`, output)), fullPage: true }).catch(() => {});
    }
    console.error(`Lighthouse failed at ${stage}: ${error.stack}`);
    process.exitCode = 1;
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
