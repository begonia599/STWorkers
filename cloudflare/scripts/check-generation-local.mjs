import assert from 'node:assert/strict';
import { ownerClient } from './owner-client.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startReferenceServer } from './upstream-reference-server.mjs';

// All data, model requests and responses in this suite are synthetic.
const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const output = new URL('../.build/generation-browser/', import.meta.url);
const base = 'http://127.0.0.1:8790';
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
let owner;
await mkdir(output, { recursive: true });
const modelRequests = [];
const referenceRequests = [];
const requestInputs = [];
let mode = 'normal', cancelled = 0, completed = 0, statusRequests = 0;
const model = createServer(async (req, res) => {
    if (req.url === '/reference/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        referenceRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const body = referenceRequests.at(-1);
        const choice = { index: 0, message: { role: 'assistant', content: 'Reference reply.' }, finish_reason: 'stop' };
        if (body.stream) res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: {"choices":[{"index":0,"delta":{"content":"Reference reply."}}]}\n\ndata: [DONE]\n\n');
        else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [choice] }));
        return;
    }
    if (req.url === '/v1/models') {
        statusRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'stworks-fixture' }] }));
        return;
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelRequests.push({ body, headers: req.headers });
    const selectedMode = mode;
    if (selectedMode === 'error') return res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":{"message":"synthetic private upstream error"}}');
    const text = `Fixture reply ${modelRequests.length}. \u4f60\u597d.`;
    if (!body.stream) {
        completed++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }));
        return;
    }
    let ended = false;
    res.on('close', () => { if (!ended) cancelled++; });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = value => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: value } }] })}\n\n`;
    res.write(sse('Fixture '));
    if (selectedMode === 'broken') {
        await delay(100);
        res.destroy();
        return;
    }
    if (selectedMode === 'slow') {
        while (!res.destroyed) {
            await delay(100);
            if (!res.destroyed) res.write(sse('waiting '));
        }
        return;
    }
    const bytes = Buffer.from(sse(text.slice(8)));
    const split = bytes.indexOf(Buffer.from('\u4f60')) + 1;
    res.write(bytes.subarray(0, split));
    await delay(80);
    if (res.destroyed) return;
    res.write(bytes.subarray(split));
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    ended = true;
    completed++;
    res.end(selectedMode === 'truncated' ? '' : 'data: [DONE]\n\n');
});
let preview, browser, page, referenceServer, stage = 'startup';
const failures = [], pageErrors = [], tokenRequests = [];
const evidence = {};
let watchdog;
const run = async () => {
    await new Promise((resolve, reject) => { model.once('error', reject); model.listen(8791, '127.0.0.1', resolve); });
    const migrate = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', '.wrangler/p2-test'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(migrate.status, 0, 'Local P2 migrations failed.');
    preview = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8790',
        '--inspector-port', '9240', '--persist-to', '.wrangler/p2-test'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    preview.stdout.resume();
    preview.stderr.resume();
    const send = (pathname, options = {}) => fetch(`${base}${pathname}`, {
        ...options, signal: AbortSignal.timeout(10000), headers: { ...owner?.headers, ...options.headers },
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
        try { if ((await send('/csrf-token')).ok) { ready = true; break; } } catch { /* Starting workerd. */ }
        await delay(500);
    }
    assert.ok(ready, 'Isolated local preview did not start.');
    owner = await ownerClient(base, AUTH_PASSWORD);
    const { token } = await (await send('/csrf-token')).json();
    const post = async (pathname, body) => {
        const response = await send(pathname, { method: 'POST',
            headers: { Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.ok(response.ok, `${pathname}: ${response.status}`);
        return response;
    };
    stage = 'synthetic fixtures';
    console.log(stage);
    const settings = JSON.parse(await readFile(new URL('../../default/content/settings.json', import.meta.url), 'utf8'));
    settings.firstRun = false;
    settings.username = 'P2 Tester';
    settings.main_api = 'openai';
    settings.world_info_settings.world_info.globalSelect = ['P2 World'];
    Object.assign(settings.oai_settings, {
        chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:8791/v1', custom_model: 'stworks-fixture',
        stream_openai: true, openai_max_context: 8192, openai_max_tokens: 128, preset_settings_openai: 'P2 Preset',
        custom_prompt_post_processing: '', custom_include_body: 'seed: 42', custom_include_headers: 'X-Synthetic: P2',
        temp_openai: 0.37,
    });
    settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content = 'P2 PRESET: Write as {{char}} for {{user}}.';
    settings.extension_settings ??= {};
    settings.extension_settings.regex = [{
        id: 'p2-synthetic-regex', scriptName: 'P2 Prompt Replacement', findRegex: '/RAWWORD/g', replaceString: 'REGEXWORD',
        trimStrings: [], placement: [1], disabled: false, markdownOnly: false, promptOnly: true,
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    }];
    await post('/api/worldinfo/edit', { name: 'P2 World', data: { entries: {
        0: { uid: 0, key: ['P2KEY'], keysecondary: [], content: 'P2 WORLD: {{char}} remembers {{user}}.',
            comment: 'Synthetic P2 world', constant: false, selective: false, order: 100, position: 0,
            disable: false, probability: 100, useProbability: true, excludeRecursion: false, preventRecursion: false },
    } } });
    await post('/api/presets/save', { apiId: 'openai', name: 'P2 Preset', preset: settings.oai_settings });
    await post('/api/settings/save', settings);
    // Repeated runs own this character and may remove only this exact synthetic fixture.
    const all = await (await post('/api/characters/all', {})).json();
    const previous = all.find(card => card.name === 'P2 Fixture');
    if (previous) await post('/api/characters/delete', { avatar_url: previous.avatar, delete_chats: true });
    const form = new FormData();
    form.append('file_type', 'json');
    form.append('avatar', new Blob([JSON.stringify({
        spec: 'chara_card_v3', spec_version: '3.0',
        data: { name: 'P2 Fixture', description: 'P2 CARD: {{char}} talks with {{user}}.',
            first_mes: 'P2 greeting for {{user}}.', extensions: { fixture: { retain: [null, false, 2] } } },
    })]), 'p2.json');
    const imported = await send('/api/characters/import', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': token }, body: form });
    assert.equal(imported.status, 200);
    const avatar = `${(await imported.json()).file_name}.png`;
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    const options = { storageState: owner.storageState(), locale: 'en-US', viewport: { width: 1440, height: 1000 } };
    const context = await browser.newContext(options);
    context.setDefaultTimeout(20000);
    const observe = target => {
        target.on('pageerror', error => pageErrors.push(error.message));
        target.on('response', response => {
            if (new URL(response.url()).origin === base && response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() });
        });
        target.on('request', request => {
            if (new URL(request.url()).pathname.startsWith('/api/tokenizers/')) tokenRequests.push(request.url());
            if (new URL(request.url()).pathname === '/api/backends/chat-completions/generate') requestInputs.push(request.postDataJSON());
        });
    };
    page = await context.newPage();
    observe(page);
    const selectCard = async target => {
        await target.goto(base, { waitUntil: 'domcontentloaded' });
        await target.waitForFunction(avatar => window.SillyTavern?.getContext?.().characters.some(card => card.avatar === avatar), avatar);
        await target.waitForFunction(() => !document.querySelector('.splash-screen'));
        if (await target.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) await target.locator('#rightNavDrawerIcon').click();
        await target.getByText('P2 Fixture', { exact: true }).first().click();
        await target.locator('#chat .mes_text').first().waitFor();
        if (await target.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('openIcon'))) await target.locator('#rightNavDrawerIcon').click();
        await target.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    };
    await selectCard(page);
    stage = 'original UI connection';
    console.log(stage);
    await page.locator('#API-status-top').click();
    await page.locator('#custom_api_url_text').fill('http://127.0.0.1:8791/v1');
    await page.locator('#custom_model_id').fill('stworks-fixture');
    const connected = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await page.locator('#api_button_openai').click();
    assert.equal((await connected).status(), 200);
    assert.ok(statusRequests > 0);
    await page.locator('#API-status-top').click();
    const sendText = async text => {
        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_but').click();
    };
    const waitReply = async number => {
        await page.waitForFunction(number => window.SillyTavern.getContext().chat.at(-1)?.mes.includes(`Fixture reply ${number}.`), number);
        await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    };
    stage = 'stream / preset / macro / regex / worldbook';
    console.log(stage);
    await sendText('P2KEY RAWWORD Hello {{char}} from {{user}}.');
    await waitReply(1);
    const first = modelRequests[0];
    const messages = JSON.stringify(first.body.messages);
    assert.match(messages, /P2 PRESET: Write as P2 Fixture for P2 Tester/);
    assert.match(messages, /P2 CARD: P2 Fixture talks with P2 Tester/);
    assert.match(messages, /P2 WORLD: P2 Fixture remembers P2 Tester/);
    assert.match(messages, /REGEXWORD/);
    assert.doesNotMatch(messages, /RAWWORD|\{\{char\}\}|\{\{user\}\}/);
    assert.equal(first.body.temperature, 0.37);
    assert.equal(first.body.seed, 42);
    assert.equal(first.headers['x-synthetic'], 'P2');
    for (const header of ['authorization', 'cookie', 'x-csrf-token', 'origin']) assert.equal(first.headers[header], undefined);
    evidence.firstOutboundRequest = first.body;
    evidence.firstReply = await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).mes);
    assert.match(evidence.firstReply, /\u4f60\u597d/);
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), fullPage: true });
    stage = 'original UI regenerate';
    console.log(stage);
    await page.locator('#options_button').click();
    await page.locator('#option_regenerate').click();
    await waitReply(2);
    assert.deepEqual(modelRequests[1].body.messages, first.body.messages);
    stage = 'original UI stop';
    console.log(stage);
    mode = 'slow';
    await sendText('Stop this synthetic stream.');
    await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes.includes('waiting'));
    const beforeCancel = cancelled;
    await page.locator('#mes_stop').click();
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    for (let i = 0; i < 50 && cancelled === beforeCancel; i++) await delay(100);
    assert.ok(cancelled > beforeCancel, 'Stop did not disconnect the real local upstream.');
    evidence.stopCancelledUpstream = true;
    stage = 'nonstream';
    console.log(stage);
    mode = 'normal';
    // Toggle the existing control; no frontend replacement or generation stubs.
    await page.locator('#ai-config-button .drawer-icon').click();
    await page.locator('#stream_toggle').uncheck();
    await page.locator('#ai-config-button .drawer-icon').click();
    await sendText('A nonstream reply.');
    await waitReply(4);
    assert.equal(modelRequests[3].body.stream, false);
    stage = 'upstream error and manual retry';
    console.log(stage);
    mode = 'error';
    await sendText('A synthetic rate limit.');
    await page.locator('#toast-container').getByText(/rate limit or quota/).waitFor();
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    assert.equal(modelRequests.length, 5);
    mode = 'normal';
    await page.locator('#options_button').click();
    await page.locator('#option_regenerate').click();
    await waitReply(6);
    evidence.manualRetry = true;
    stage = 'broken upstream stream and recovery';
    console.log(stage);
    await page.locator('#ai-config-button .drawer-icon').click();
    await page.locator('#stream_toggle').check();
    await page.locator('#ai-config-button .drawer-icon').click();
    mode = 'broken';
    await sendText('A synthetic disconnected stream.');
    await page.locator('#toast-container').getByText(/model connection was interrupted/i).first().waitFor();
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    assert.equal(modelRequests.length, 7);
    mode = 'normal';
    await page.locator('#options_button').click();
    await page.locator('#option_regenerate').click();
    await waitReply(8);
    evidence.streamInterruptionRecovery = true;
    stage = 'missing completion marker and recovery';
    console.log(stage);
    mode = 'truncated';
    await sendText('A synthetic missing completion marker.');
    await page.locator('#toast-container').getByText(/stream ended before its completion marker/i).first().waitFor();
    await page.locator('#mes_stop').waitFor({ state: 'hidden' });
    assert.equal(modelRequests.length, 9);
    mode = 'normal';
    await page.locator('#options_button').click();
    await page.locator('#option_regenerate').click();
    await waitReply(10);
    evidence.missingCompletionMarkerDetected = true;
    stage = 'mobile reload';
    console.log(stage);
    await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes.includes('Fixture reply 10.'));
    // Wait for the real persisted snapshot rather than relying on an arbitrary debounce delay.
    const active = await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        return { file: c.characters[c.characterId].chat, count: c.chat.length };
    });
    let saved;
    for (let i = 0; i < 60; i++) {
        saved = await (await post('/api/chats/get', { avatar_url: avatar, file_name: active.file })).json();
        if (saved.at(-1)?.mes?.includes('Fixture reply 10.')) break;
        await delay(100);
    }
    assert.match(saved.at(-1).mes, /Fixture reply 10/);
    const mobileContext = await browser.newContext({ ...options, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    observe(mobile);
    await selectCard(mobile);
    await mobile.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes.includes('Fixture reply 10.'));
    evidence.mobile = await mobile.evaluate(() => ({
        count: window.SillyTavern.getContext().chat.length,
        last: window.SillyTavern.getContext().chat.at(-1).mes,
        overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(evidence.mobile.count, active.count);
    assert.equal(evidence.mobile.overflow, false);
    stage = 'mobile connection and send';
    console.log(stage);
    await mobile.locator('#API-status-top').click();
    const mobileConnected = mobile.waitForResponse(response => new URL(response.url()).pathname.endsWith('/chat-completions/status'));
    await mobile.locator('#api_button_openai').click();
    assert.equal((await mobileConnected).status(), 200);
    await mobile.locator('#API-status-top').click();
    await mobile.locator('#api_button_openai').waitFor({ state: 'hidden' });
    await mobile.locator('#send_textarea').fill('Sent from the synthetic mobile context.');
    await mobile.locator('#send_but').click();
    await mobile.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes.includes('Fixture reply 11.'));
    await mobile.locator('#mes_stop').waitFor({ state: 'hidden' });
    evidence.mobile.generatedReply = await mobile.locator('#chat .mes_text').last().textContent();
    assert.match(evidence.mobile.generatedReply, /Fixture reply 11/);
    assert.equal(modelRequests.length, 11);
    await mobile.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), fullPage: true });
    stage = 'original UI post-processing modes';
    console.log(stage);
    const modes = ['merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single', ''];
    for (const type of modes) {
        await mobile.locator('#API-status-top').click();
        await mobile.locator('#custom_prompt_post_processing').selectOption(type);
        await mobile.locator('#API-status-top').click();
        await mobile.locator('#custom_prompt_post_processing').waitFor({ state: 'hidden' });
        await mobile.locator('#send_textarea').fill(`P2KEY RAWWORD mode ${type || 'none'}.`);
        const count = modelRequests.length + 1;
        await mobile.locator('#send_but').click();
        await mobile.waitForFunction(count => window.SillyTavern.getContext().chat.at(-1)?.mes.includes(`Fixture reply ${count}.`), count);
        await mobile.locator('#mes_stop').waitFor({ state: 'hidden' });
        assert.equal(requestInputs.at(-1).custom_prompt_post_processing, type);
    }
    stage = 'schema and parameter precedence through real Workers';
    console.log(stage);
    const schema = { name: 'SyntheticResult', strict: false, value: {
        $schema: 'synthetic-schema', $defs: { score: { type: 'integer', minimum: 0 } },
        type: 'object', properties: { score: { $ref: '#/$defs/score' } }, required: ['score'], additionalProperties: false,
    } };
    const optionCases = [
        { model: 'gpt-5', custom_prompt_post_processing: 'strict_tools', reasoning_effort: 'min', verbosity: 'low',
            json_schema: schema, stop: ['ST-stop'], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
            tool_choice: 'required', custom_include_body: 'stop: [yaml-stop]\ntools: [yaml-tool]\nreasoning_effort: yaml-effort\nresponse_format: {type: json_object}' },
        { chat_completion_source: 'openai', reverse_proxy: 'http://127.0.0.1:8791/v1', proxy_password: 'synthetic-proxy',
            model: 'gpt-5.3-chat-latest', json_schema: schema, reasoning_effort: 'high', verbosity: 'high' },
        { model: 'stworks-fixture', reasoning_effort: 'high', custom_include_body: 'reasoning_effort: yaml-effort\nresponse_format: {type: json_object}' },
        { custom_prompt_post_processing: 'strict', messages: [], json_schema: schema,
            custom_include_body: 'seed: 5', custom_exclude_body: '[seed, temperature]' },
    ];
    for (const extra of optionCases) {
        const input = { ...structuredClone(requestInputs[0]), stream: false, ...extra };
        requestInputs.push(input);
        await (await post('/api/backends/chat-completions/generate', input)).text();
    }
    stage = 'actual original ST router outbound comparison';
    console.log(stage);
    referenceServer = await startReferenceServer('http://127.0.0.1:8791/reference/v1');
    assert.equal(requestInputs.length, modelRequests.length);
    for (let i = 0; i < requestInputs.length; i++) {
        const response = await referenceServer.post('generate', requestInputs[i]);
        assert.equal(response.status, 200, `Reference HTTP failure at case ${i}`);
        await response.text();
        assert.equal(referenceRequests.length, i + 1, `Reference did not contact the model at case ${i}`);
        assert.deepEqual(modelRequests[i].body, referenceRequests[i], `Original ST outbound body mismatch at case ${i}`);
    }
    const processTypes = ['', 'claude', ...modes.filter(Boolean)];
    for (const type of processTypes) {
        const input = { ...requestInputs[0], type };
        const original = await referenceServer.post('process', input);
        const adapted = await post('/api/backends/chat-completions/process', input);
        assert.deepEqual(await adapted.json(), await original.json(), `Process API mismatch for ${type}`);
    }
    evidence.parity = { commit: referenceServer.commit, outboundBodies: referenceRequests.length, processModes: processTypes,
        uiModes: modes, schemaAndOptionCases: optionCases.length, comparison: 'Same browser-assembled input through Workers and actual original ST router; not two independent UIs.' };
    await writeFile(new URL('parity.json', output), JSON.stringify({ ...evidence.parity, cases: requestInputs.map((input, i) => ({
        input, worker: modelRequests[i].body, original: referenceRequests[i],
    })) }, null, 2));
    assert.equal(tokenRequests.length, 0);
    assert.deepEqual(failures, [{ path: '/api/backends/chat-completions/generate', status: 429 }]);
    // Original UI click handlers surface intentional generation rejections as page errors.
    assert.deepEqual(pageErrors, [
        'The model service rate limit or quota was exceeded.',
    ]);
    Object.assign(evidence, { statusRequests, requests: modelRequests.length, completed, cancelled, tokenRequests, failures, pageErrors });
    await writeFile(new URL('results.json', output), JSON.stringify(evidence, null, 2));
    console.log('P2 local UI generation regression passed. Evidence: cloudflare/.build/generation-browser/');
};
try {
    await Promise.race([run(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`P2 watchdog: ${stage}`)), 180000); })]);
} catch (error) {
    console.error(`P2 failed during ${stage}: ${error.message}`);
    if (page) {
        await page.screenshot({ path: fileURLToPath(new URL('failure.png', output)), fullPage: true }).catch(() => {});
        await writeFile(new URL('failure.json', output), JSON.stringify({ stage, failures, pageErrors, modelRequests }, null, 2));
    }
    throw error;
} finally {
    clearTimeout(watchdog);
    await referenceServer?.close();
    await browser?.close();
    if (preview?.pid) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
        else preview.kill('SIGTERM');
    }
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    // Never persist Wrangler's startup output, which can contain local secret bindings.
}
