import assert from 'node:assert/strict';
import { ownerStorageState } from './owner-client.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startUpstreamBrowserServer, stopChild } from './upstream-browser-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../.build/frontend-parity/', import.meta.url);
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
assert.ok(AUTH_PASSWORD, 'Configure local owner authentication before running the suite.');
const workerBase = 'http://127.0.0.1:8792';
const modelBase = 'http://127.0.0.1:8794';
const persistence = `.wrangler/p2-parity/${randomUUID()}`;
const records = { worker: [], original: [] };
const evidence = { cases: [], failures: [], pageErrors: [], externalRequests: [], tokenRequests: { worker: [], original: [] } };
const model = createServer(async (req, res) => {
    const match = req.url.match(/^\/(worker|original)\/v1\/(models|chat\/completions)$/);
    if (!match) return res.writeHead(404).end();
    const [, side, action] = match;
    if (action === 'models') return res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'stworks-parity-fixture' }] }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    records[side].push(body);
    const reply = `PARITY REPLY ${records[side].length}. {{setvar::model_seen::yes}}`;
    if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
    }
});
let browser, preview, original, stage = 'startup', watchdog;
const targets = [];
const setStage = value => { stage = value; console.log(value); };
const until = async (callback, message) => {
    for (let i = 0; i < 100; i++) {
        if (await callback()) return;
        await delay(100);
    }
    throw new Error(message);
};

function initialChat() {
    const message = (is_user, mes, extra = {}) => ({ name: is_user ? 'Parity User' : 'Parity Card', is_user, is_system: false,
        send_date: '2026-09-08T00:00:00.000Z', mes, extra });
    return [
        { user_name: 'Parity User', character_name: 'Parity Card', create_date: '2026-09-08T00:00:00.000Z',
            chat_metadata: { variables: { score: '2' }, parity_unknown: { retain: [null, false, 3] } } },
        message(false, 'PARITY GREETING {{user}}.'),
        message(true, `PARITY_OLDEST ${'boundary '.repeat(1600)}`, { parity_unknown: { old: true } }),
        message(false, 'PARITY RECENT ANSWER.'),
        message(true, 'PARITY RECENT QUESTION WIKEY.'),
        message(false, 'PARITY RECENT FOLLOWUP.'),
    ];
}

async function openTarget(side, base, credentials, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ ...(side === 'worker'
        ? { storageState: await ownerStorageState(base, credentials.password) }
        : { httpCredentials: credentials }), locale: 'en-US', viewport,
        serviceWorkers: 'block', ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    context.setDefaultTimeout(25000);
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        evidence.externalRequests.push({ side, url: url.href });
        return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', error => evidence.pageErrors.push({ side, message: error.message }));
    page.on('response', response => {
        if (new URL(response.url()).origin === base && response.status() >= 400) {
            evidence.failures.push({ side, path: new URL(response.url()).pathname, status: response.status() });
        }
    });
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/tokenizers/')) evidence.tokenRequests[side].push(new URL(request.url()).pathname);
    });
    const csrfResponse = await context.request.get(`${base}/csrf-token`);
    assert.ok(csrfResponse.ok(), `CSRF initialization: ${side}`);
    const { token } = await csrfResponse.json();
    const post = async (pathname, data, multipart = false) => {
        const response = await context.request.post(`${base}${pathname}`, {
            headers: { Origin: base, 'X-CSRF-Token': token },
            ...(multipart ? { multipart: data } : { data }), timeout: 15000,
        });
        assert.ok(response.ok(), `${side} ${pathname}: ${response.status()} ${(await response.text()).slice(0, 300)}`);
        return response;
    };
    return { side, base, credentials, context, page, post };
}

async function seed(target) {
    const { post, side } = target;
    const settings = JSON.parse(await readFile(new URL('../../default/content/settings.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../../upstream-lock.json', import.meta.url), 'utf8'));
    const manifestNames = execFileSync('git', ['ls-tree', '-r', '--name-only', lock.sillytavern.commit, 'public/scripts/extensions'],
        { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).split('\n')
        .filter(name => /^public\/scripts\/extensions\/[^/]+\/manifest\.json$/.test(name)).map(name => name.split('/')[3]);
    Object.assign(settings, { firstRun: false, username: 'Parity User', main_api: 'openai' });
    settings.world_info_settings.world_info.globalSelect = ['Parity World'];
    Object.assign(settings.oai_settings, {
        chat_completion_source: 'custom', custom_url: `${modelBase}/${side}/v1`, custom_model: 'stworks-parity-fixture',
        stream_openai: false, openai_max_context: 8192, openai_max_tokens: 128,
        preset_settings_openai: 'Parity Preset', custom_prompt_post_processing: '',
        custom_include_body: 'seed: 23', temp_openai: 0.42,
    });
    settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content =
        'PARITY PRESET {{char}} for {{user}}; global={{getglobalvar::parity_global}}; score={{getvar::score}}. {{setvar::prompt_seen::yes}}';
    settings.extension_settings.disabledExtensions = manifestNames.filter(name => !['regex', 'quick-reply'].includes(name));
    settings.extension_settings.variables = { global: { parity_global: 'initial' } };
    settings.extension_settings.regex = [{
        id: 'parity-regex', scriptName: 'Parity prompt-only', findRegex: '/RAW_PARITY/g', replaceString: 'REGEX_PARITY',
        trimStrings: [], placement: [1], disabled: false, markdownOnly: false, promptOnly: true,
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    }];
    await post('/api/worldinfo/edit', { name: 'Parity World', data: { entries: {
        0: { uid: 0, key: ['WIKEY'], keysecondary: [], content: 'PARITY WORLD {{char}} score={{getvar::score}}.',
            comment: 'Synthetic parity', constant: false, selective: false, order: 100, position: 0,
            disable: false, probability: 100, useProbability: true, excludeRecursion: false, preventRecursion: false },
    } } });
    await post('/api/presets/save', { apiId: 'openai', name: 'Parity Preset', preset: settings.oai_settings });
    await post('/api/settings/save', settings);
    const response = await post('/api/characters/import', {
        file_type: 'json',
        avatar: { name: 'parity.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
            spec: 'chara_card_v3', spec_version: '3.0', data: {
                name: 'Parity Card', description: 'PARITY CARD {{char}} speaks to {{user}}.',
                first_mes: 'PARITY GREETING {{user}}.', extensions: { parity_unknown: { keep: [null, false, 3] } },
            },
        })) },
    }, true);
    target.avatar = `${(await response.json()).file_name}.png`;
    await post('/api/chats/save', { avatar_url: target.avatar, file_name: 'Parity Main', chat: initialChat() });
}

async function selectChat(target) {
    const { page, base, avatar } = target;
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(avatar => window.SillyTavern?.getContext?.().characters.some(card => card.avatar === avatar), avatar);
    await page.waitForFunction(() => !document.querySelector('.splash-screen'));
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await page.locator('#rightNavDrawerIcon').click();
    await page.getByText('Parity Card', { exact: true }).first().click();
    await page.locator('#chat .mes_text').first().waitFor();
    if (await page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        if (c.chatId !== 'Parity Main') await c.openCharacterChat('Parity Main');
    });
    await page.waitForFunction(() => window.SillyTavern.getContext().chatId === 'Parity Main');
    await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        window.parityEvents = [];
        window.parityPreviewEvents = [];
        for (const name of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT',
            'USER_MESSAGE_RENDERED', 'WORLD_INFO_ACTIVATED', 'CHAT_COMPLETION_PROMPT_READY',
            'CHAT_COMPLETION_SETTINGS_READY', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED',
            'GENERATION_ENDED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
            c.eventSource.on(c.eventTypes[name], (...args) => {
                const preview = (['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS'].includes(name) && args[2] === true)
                    || (name === 'CHAT_COMPLETION_PROMPT_READY' && args[0]?.dryRun === true);
                (preview ? window.parityPreviewEvents : window.parityEvents).push(name);
            });
        }
    });
}

async function connect(target) {
    const { page } = target;
    await page.locator('#API-status-top').click();
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await page.locator('#api_button_openai').click();
    assert.equal((await response).status(), 200);
    await page.locator('#API-status-top').click();
    await page.locator('#api_button_openai').waitFor({ state: 'hidden' });
}

async function snapshot(target) {
    return target.page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        return {
            variables: c.chatMetadata.variables, global: c.extensionSettings.variables.global,
            metadataUnknown: c.chatMetadata.parity_unknown,
            cardUnknown: c.characters[c.characterId].data.extensions.parity_unknown,
            messages: c.chat.map(message => ({
                name: message.name, is_user: message.is_user, mes: message.mes,
                swipe_id: message.swipe_id, swipes: message.swipes,
                unknown: message.extra?.parity_unknown, branch: message.extra?.parity_branch,
                swipeBranches: message.swipe_info?.map(info => info.extra?.parity_branch ?? null),
            })),
        };
    });
}

async function savedState(target) {
    const response = await target.post('/api/chats/get', { avatar_url: target.avatar, file_name: 'Parity Main' });
    return response.json();
}

async function flushAndCheck(target) {
    await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
    const state = await snapshot(target);
    await until(async () => {
        const saved = await savedState(target);
        return JSON.stringify(saved[0]?.chat_metadata?.variables) === JSON.stringify(state.variables)
            && saved.at(-1)?.mes === state.messages.at(-1)?.mes && saved.at(-1)?.swipe_id === state.messages.at(-1)?.swipe_id;
    }, `${target.side}: chat snapshot did not persist`);
    return state;
}

async function compare(label, generated = false) {
    const states = [];
    const events = [];
    const previews = {};
    const tokenCounts = {};
    for (const target of targets) {
        states.push(await flushAndCheck(target));
        events.push(await target.page.evaluate(() => window.parityEvents.splice(0)));
        previews[target.side] = await target.page.evaluate(() => window.parityPreviewEvents.splice(0));
    }
    assert.deepEqual(states[0], states[1], `${label}: frontend state mismatch`);
    assert.deepEqual(events[0], events[1], `${label}: lifecycle event ordering mismatch`);
    if (generated) {
        assert.equal(records.worker.length, records.original.length, `${label}: independent request count mismatch`);
        assert.deepEqual(records.worker.at(-1), records.original.at(-1), `${label}: independently assembled model request mismatch`);
        for (const target of targets) {
            tokenCounts[target.side] = await target.page.evaluate(async messages => {
                const { countTokensOpenAIAsync } = await import('/scripts/tokenizers.js');
                return countTokensOpenAIAsync(messages, true);
            }, records[target.side].at(-1).messages);
        }
    }
    evidence.cases.push({ label, events: events[0], backgroundPreviewEvents: previews,
        state: states[0], tokenCounts: generated ? tokenCounts : undefined,
        request: generated ? records.worker.at(-1) : undefined });
    return states[0];
}

async function generate(target, action, text) {
    const { page, side } = target;
    const expected = records[side].length + 1;
    if (action === 'send') {
        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_but').click();
    } else if (action === 'regenerate') {
        await page.locator('#options_button').click();
        await page.locator('#option_regenerate').click();
    } else {
        await page.locator('#chat .mes').last().locator('.swipe_right').click();
    }
    await page.waitForFunction(expected => window.SillyTavern.getContext().chat.at(-1)?.mes.includes(`PARITY REPLY ${expected}.`), expected);
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.parityEvents.includes('GENERATION_ENDED'));
    assert.equal(records[side].length, expected, 'A UI action must make exactly one model request.');
}

async function branch(target, value) {
    await target.page.evaluate(async value => {
        const c = window.SillyTavern.getContext(), message = c.chat.at(-1);
        // This is an explicit synthetic client API write, not Tavern Helper or MVU execution.
        message.extra.parity_branch = { branch: value, retain: [null, false, { score: value === 'first' ? 7 : 11 }] };
        message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
        await c.saveChat();
    }, value);
}

async function run() {
    await mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { model.once('error', reject); model.listen(8794, '127.0.0.1', resolve); });
    const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(migration.status, 0, 'Isolated parity migrations failed.');
    preview = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8792',
        '--inspector-port', '9242', '--persist-to', persistence],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    preview.stdout.resume();
    preview.stderr.resume();
    let ready = false;
    for (let i = 0; i < 80; i++) {
        try {
            const response = await fetch(`${workerBase}/csrf-token`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { ready = true; break; }
        } catch { /* Starting the isolated Worker. */ }
        await delay(500);
    }
    assert.ok(ready, 'Isolated parity Worker did not start.');
    setStage('exporting and starting pinned original ST');
    original = await startUpstreamBrowserServer(8793);
    evidence.reference = original.evidence;
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    targets.push(await openTarget('worker', workerBase, { username: 'owner', password: AUTH_PASSWORD }));
    targets.push(await openTarget('original', original.base, original.credentials));
    setStage('independent seed, selection, and connection');
    for (const target of targets) {
        await seed(target);
        await selectChat(target);
        await connect(target);
    }
    await compare('initial independent load');
    setStage('original slash commands and variable persistence');
    for (const { page, post } of targets) {
        await page.locator('#send_textarea').fill('/setvar key=score 7 | /setglobalvar key=parity_global amber');
        await page.locator('#send_but').click();
        await page.waitForFunction(() => {
            const c = window.SillyTavern.getContext();
            return c.variables.local.get('score') === 7 && c.variables.global.get('parity_global') === 'amber';
        });
        await until(async () => JSON.parse((await (await post('/api/settings/get', {})).json()).settings)
            .extension_settings.variables.global.parity_global === 'amber', 'Global variable was not saved.');
    }
    await compare('slash local/global variables');
    setStage('independent prompt assembly and generation');
    for (const target of targets) await generate(target, 'send', 'WIKEY RAW_PARITY {{char}} {{user}} {{getvar::score}}.');
    const first = await compare('large-context send', true);
    const body = JSON.stringify(records.worker.at(-1).messages);
    assert.match(body, /PARITY PRESET Parity Card for Parity User; global=amber; score=7/);
    assert.match(body, /PARITY WORLD Parity Card score=7/);
    assert.match(body, /PARITY CARD/);
    assert.match(body, /PARITY_OLDEST/);
    assert.match(body, /REGEX_PARITY/);
    assert.doesNotMatch(body, /RAW_PARITY|\{\{(?:char|user|getvar|getglobalvar|setvar)::?/);
    assert.equal(first.variables.prompt_seen, 'yes');
    assert.equal(first.variables.model_seen, undefined, 'Original ST does not execute this reply macro on display.');
    for (const target of targets) await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-desktop.png`, output)), fullPage: true });
    setStage('independent regenerate and swipe branches');
    for (const target of targets) await generate(target, 'regenerate');
    await compare('regenerate', true);
    for (const target of targets) await branch(target, 'first');
    await compare('first branch API write');
    for (const target of targets) await generate(target, 'swipe');
    await compare('new swipe generation', true);
    for (const target of targets) await branch(target, 'second');
    await compare('second branch API write');
    for (const { page } of targets) {
        await page.locator('#chat .mes').last().locator('.swipe_left').click();
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1).extra.parity_branch?.branch === 'first');
    }
    await compare('swipe left restores first message extra');
    for (const { page } of targets) {
        await page.locator('#chat .mes').last().locator('.swipe_right').click();
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1).extra.parity_branch?.branch === 'second');
    }
    await compare('swipe right restores second message extra');
    setStage('original UI message editing');
    for (const { page } of targets) {
        await page.locator('#chat .mes').last().hover();
        await page.locator('#chat .mes').last().locator('.mes_edit').click();
        await page.locator('#curEditTextarea').fill('PARITY EDITED SECOND. {{setvar::model_seen::yes}}');
        await page.locator('#chat .mes').last().locator('.mes_edit_done').click();
        await page.locator('#curEditTextarea').waitFor({ state: 'hidden' });
    }
    const edited = await compare('original UI message edit');
    assert.equal(edited.messages.at(-1).branch.branch, 'second');
    setStage('context boundary with each frontend own tokenizer');
    for (const target of targets) {
        await target.page.evaluate(() => {
            const c = window.SillyTavern.getContext();
            c.chatCompletionSettings.openai_max_context = 1024;
            c.saveSettingsDebounced();
        });
        await generate(target, 'send', 'WIKEY PARITY BOUNDARY REQUEST {{getvar::score}}.');
    }
    const boundedState = await compare('bounded-context send', true);
    assert.equal(boundedState.variables.model_seen, 'yes', 'Reply macro must run when included in the next prompt.');
    const bounded = JSON.stringify(records.worker.at(-1).messages);
    assert.doesNotMatch(bounded, /PARITY_OLDEST/);
    assert.match(bounded, /PARITY BOUNDARY REQUEST/);
    assert.match(bounded, /PARITY RECENT FOLLOWUP/);
    setStage('native client quiet and raw generation APIs');
    for (const kind of ['quiet', 'raw']) {
        const replies = [];
        for (const target of targets) {
            const before = await snapshot(target);
            const count = records[target.side].length;
            replies.push(await target.page.evaluate(async kind => {
                const c = window.SillyTavern.getContext();
                return kind === 'quiet'
                    ? c.generateQuietPrompt({ quietPrompt: 'WIKEY PARITY QUIET {{getvar::score}}.', responseLength: 64 })
                    : c.generateRaw({ prompt: 'PARITY RAW INPUT.', systemPrompt: 'PARITY RAW SYSTEM.', responseLength: 64 });
            }, kind));
            assert.equal(records[target.side].length, count + 1);
            assert.deepEqual((await snapshot(target)).messages, before.messages, `${kind} must not append or replace chat messages`);
            assert.equal(await target.page.evaluate(() => window.SillyTavern.getContext().chatCompletionSettings.openai_max_tokens), 128);
        }
        assert.equal(replies[0], replies[1], `${kind}: API results mismatch`);
        await compare(`native ${kind} generation API`, true);
        assert.equal(records.worker.at(-1).max_tokens, 64);
        if (kind === 'raw') {
            assert.match(JSON.stringify(records.worker.at(-1).messages), /PARITY RAW SYSTEM/);
            assert.doesNotMatch(JSON.stringify(records.worker.at(-1).messages), /PARITY PRESET|PARITY WORLD|PARITY CARD/);
        }
    }
    const beforeReload = await snapshot(targets[0]);
    setStage('fresh mobile contexts and storage recovery');
    for (let i = 0; i < targets.length; i++) {
        const previous = targets[i];
        await previous.context.close();
        const fresh = await openTarget(previous.side, previous.base, previous.credentials, { width: 390, height: 844 });
        fresh.avatar = previous.avatar;
        targets[i] = fresh;
        await selectChat(fresh);
        assert.deepEqual(await snapshot(fresh), beforeReload, `${fresh.side}: reload did not restore full projected state`);
        assert.equal(await fresh.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await connect(fresh);
        await fresh.page.evaluate(() => window.parityEvents.splice(0));
    }
    await compare('fresh mobile state');
    for (const target of targets) await generate(target, 'send', 'WIKEY PARITY MOBILE {{getglobalvar::parity_global}}.');
    await compare('fresh mobile send', true);
    for (const target of targets) await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-mobile.png`, output)), fullPage: true });
    assert.equal(evidence.tokenRequests.worker.length, 0);
    assert.ok(evidence.tokenRequests.original.length > 0, 'Original tokenizer must run, not use a shared stub.');
    assert.deepEqual(evidence.failures, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.externalRequests, []);
    evidence.scope = 'Independent original frontends and actual backends. Original tokenizers are not replaced. Fixed coarse boundary, not identical tokenizer thresholds or Tavern Helper/MVU execution.';
    evidence.generatedRequestsPerSide = records.worker.length;
    await writeFile(new URL('results.json', output), JSON.stringify(evidence, null, 2));
    await writeFile(new URL('requests.json', output), JSON.stringify(records, null, 2));
    console.log(`Independent frontend parity passed: ${evidence.cases.length} states, ${records.worker.length} model requests per side.`);
}

try {
    await Promise.race([run(), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Frontend parity watchdog: ${stage}`)), 300000);
    })]);
} catch (error) {
    console.error(`Frontend parity failed during ${stage}: ${error.message}`);
    for (const target of targets) {
        if (!target.page.isClosed()) {
            await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-failure.png`, output)), fullPage: true }).catch(() => {});
            target.state = await snapshot(target).catch(() => null);
            target.events = await target.page.evaluate(() => window.parityEvents).catch(() => null);
        }
    }
    await writeFile(new URL('failure.json', output), JSON.stringify({
        stage, ...evidence, records, targets: targets.map(({ side, state, events }) => ({ side, state, events })),
    }, null, 2));
    throw error;
} finally {
    clearTimeout(watchdog);
    await browser?.close();
    await original?.close();
    await stopChild(preview);
    model.closeAllConnections();
    if (model.listening) await new Promise(resolve => model.close(resolve));
}
