import assert from 'node:assert/strict';
import { ownerStorageState } from './owner-client.mjs';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// Rechecks the synthetic fixtures imported through the original UI during P1 acceptance.
// Supply a package.json whose dependencies contain Playwright and an optional browser executable.
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const output = new URL('../.build/p1-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
    const context = await browser.newContext({
        storageState: await ownerStorageState('http://127.0.0.1:8789', AUTH_PASSWORD),
        viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const failures = [];
    const requests = [];
    const pageErrors = [];
    const tokenizerRequests = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/tokenizers/')) tokenizerRequests.push(url.pathname);
    });
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== 'http://127.0.0.1:8789') return;
        const item = { method: response.request().method(), path: url.pathname, status: response.status() };
        if (response.status() >= 400) failures.push(item);
        if (url.pathname.startsWith('/api/') || url.pathname === '/version') requests.push(item);
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:8789', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.characters?.some(
        card => card.avatar === 'STworks P1 Fixture.png',
    ), null, { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.splash-screen'), null, { timeout: 20000 });
    if (await page.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('closedIcon'))) {
        await page.locator('#rightNavDrawerIcon').click();
    }
    await page.getByText('STworks P1 Fixture', { exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('#description_textarea')?.value
        === 'Edited in original UI. Preserve {{user}} and {{char}}.', null, { timeout: 10000 });
    const state = await page.evaluate(async () => {
        const { getRequestHeaders } = await import('/script.js');
        const post = async (path, body) => {
            const response = await fetch(path, {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`${path}: ${response.status}`);
            return response.json();
        };
        const card = await post('/api/characters/get', { avatar_url: 'STworks P1 Fixture.png' });
        const world = await post('/api/worldinfo/get', { name: 'P1 UI World' });
        const settings = await post('/api/settings/get', {});
        const index = settings.openai_setting_names.indexOf('P1 UI Preset');
        const chats = await post('/api/chats/get', { avatar_url: card.avatar, file_name: card.chat });
        return {
            description: card.data.description,
            cardFuture: card.future,
            cardExtension: card.data.extensions.fixture,
            world: world.entries?.[0]?.content,
            worldExtension: world.extensions,
            preset: index < 0 ? null : JSON.parse(settings.openai_settings[index]).fixture,
            mainApi: JSON.parse(settings.settings).main_api,
            greeting: chats[1]?.mes,
            editorDescription: document.querySelector('#description_textarea')?.value,
        };
    });
    assert.equal(state.description, 'Edited in original UI. Preserve {{user}} and {{char}}.');
    assert.deepEqual(state.cardFuture, { retain: true });
    assert.deepEqual(state.cardExtension, { unknown: [null, false, 7] });
    assert.equal(state.world, 'A persistent worldbook entry.');
    assert.deepEqual(state.worldExtension, { fixture: { keep: null } });
    assert.deepEqual(state.preset, { unknown: [null, false, 9] });
    assert.equal(state.mainApi, 'openai');
    assert.equal(state.greeting, 'Hello STworks Tester, this is the storage test.');
    assert.equal(state.editorDescription, state.description);

    const tokenState = await page.evaluate(async () => {
        const counters = await import('/scripts/tokenizers.js');
        const { power_user } = await import('/scripts/power-user.js');
        const text = 'hello world \u4e16\u754c {{user}}';
        const messages = [{ role: 'system', content: text }, { role: 'user', content: 'test', name: 'Tester' }];
        const estimatedText = Math.ceil(new TextEncoder().encode(text).byteLength / 3.35);
        const started = performance.now();
        for (let i = 0; i < 100; i++) await counters.getTokenCountAsync(`${text} ${i}`);
        return {
            metadata: counters.tokenEstimator,
            name: counters.getFriendlyTokenizerName().tokenizerName,
            sync: counters.getTokenCount(text),
            async: await counters.getTokenCountAsync(text),
            empty: await counters.getTokenCountAsync(''),
            shadow: await counters.getTokenCountAsync(text, power_user.token_padding),
            expectedShadow: estimatedText + power_user.token_padding,
            messagesSync: counters.countTokensOpenAI(messages),
            messagesAsync: await counters.countTokensOpenAIAsync(messages),
            messagesFull: await counters.countTokensOpenAIAsync(messages, true),
            emptyMessages: await counters.countTokensOpenAIAsync([]),
            guesstimate: counters.guesstimate(text),
            expectedGuesstimate: estimatedText,
            batchMs: performance.now() - started,
        };
    });
    assert.equal(tokenState.metadata.accuracy, 'estimate');
    assert.equal(tokenState.metadata.tokenIds, false);
    assert.match(tokenState.name, /browser estimate/);
    assert.ok(tokenState.sync > 0);
    assert.equal(tokenState.sync, tokenState.async);
    assert.equal(tokenState.empty, 0);
    assert.equal(tokenState.shadow, tokenState.expectedShadow);
    assert.equal(tokenState.guesstimate, tokenState.expectedGuesstimate);
    assert.equal(tokenState.messagesSync, tokenState.messagesAsync);
    assert.equal(tokenState.messagesFull, tokenState.messagesSync + 2);
    assert.equal(tokenState.emptyMessages, 0);
    await page.waitForFunction(() => {
        const value = document.querySelector('#result_info_total_tokens')?.textContent;
        return /^\d+$/.test(value ?? '') && Number(value) > 0;
    }, null, { timeout: 10000 });
    tokenState.characterTotal = Number(await page.locator('#result_info_total_tokens').textContent());

    await page.locator('#WIDrawerIcon').click();
    await page.locator('#world_editor_select').selectOption({ label: 'P1 UI World' });
    await page.locator('#world_popup_entries_list .world_entry .inline-drawer-icon').first().click();
    await page.waitForFunction(() => {
        const counters = [...document.querySelectorAll('#world_popup_entries_list .world_entry_form_token_counter')];
        return counters.length > 0 && counters.every(counter => /^\d+$/.test(counter.textContent.trim()) && Number(counter.textContent) > 0);
    }, null, { timeout: 10000 });
    tokenState.worldEntries = await page.locator('#world_popup_entries_list .world_entry_form_token_counter')
        .evaluateAll(counters => counters.map(counter => Number(counter.textContent)));
    await page.locator('#WIDrawerIcon').click();

    if (await page.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('closedIcon'))) {
        await page.locator('#rightNavDrawerIcon').click();
    }
    await page.waitForFunction(() => !window.jQuery('#right-nav-panel').is(':animated'), null, { timeout: 5000 });
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), animations: 'disabled' });
    if (await page.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('openIcon'))) {
        await page.locator('#rightNavDrawerIcon').click();
    }
    await page.locator('#right-nav-panel').waitFor({ state: 'hidden', timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), animations: 'disabled' });
    const imageState = await page.locator('#chat img').evaluateAll(images => images.map(image => ({
        rendered: image.complete && image.naturalWidth > 0, source: image.getAttribute('src'),
    })));
    assert.ok(imageState.length > 0);
    assert.ok(imageState.every(image => image.rendered));
    const report = {
        browserVersion: browser.version(),
        fixtureReloadPassed: true, fullFrontendAcceptance: false, readyForChat: false,
        viewports: ['1440x1000', '390x844'], requests, failures, pageErrors, imageState, tokenState, tokenizerRequests,
        note: 'Browser-only approximate counts; no token ids or provider accuracy claim. Generation remains pending. Not plugin compatibility evidence.',
    };
    await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
    assert.deepEqual(tokenizerRequests, [], 'Counting must not call the Worker tokenizer APIs.');
    assert.deepEqual(pageErrors, [], 'The tested editing flow must not leave unhandled browser errors.');
    assert.deepEqual(failures, [], 'The tested editing flow must not leave failed HTTP responses.');
    console.log('PASS: fresh browser context recovered UI-imported card, edited description, greeting, worldbook, preset and extension fields.');
    console.log(`PASS: sync/async browser estimates; character=${tokenState.characterTotal}, world=${tokenState.worldEntries.join(',')}; zero tokenizer requests.`);
    console.log(`100 uncached short counts: ${tokenState.batchMs.toFixed(2)} ms in this local browser.`);
    console.log('Screenshots and request report: cloudflare/.build/p1-browser/');
} finally {
    await browser.close();
}
