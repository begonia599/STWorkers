import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// Isolated local acceptance only. No personal browser profile or remote deployment.
const base = 'http://127.0.0.1:8789';
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
const output = new URL('../.build/chat-transfer-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const authorization = `Basic ${Buffer.from(`owner:${AUTH_PASSWORD}`).toString('base64')}`;
const send = (pathname, options = {}) => fetch(new URL(pathname, base), {
    ...options, signal: AbortSignal.timeout(20000),
    headers: { Authorization: authorization, ...options.headers },
});
const { token } = await (await send('/csrf-token')).json();
const post = (pathname, body) => send(pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: base },
    body: JSON.stringify(body),
});
const suffix = randomUUID().slice(0, 8);
const characterName = `Chat flow ${suffix}`;
const renamedFile = `Renamed chat ${suffix}`;
const fixture = [
    { user_name: 'Synthetic user', character_name: characterName, chat_metadata: {
        integrity: randomUUID(), variables: { chapter: 5, nested: { enabled: true } }, unknown: [null, false, 7],
    }, future_header: { retainOnImport: true } },
    { name: 'Synthetic user', is_user: true, mes: 'Question for an imported chat.', send_date: '2026-09-08T00:01:00.000Z' },
    {
        name: characterName, is_user: false, mes: 'Chosen imported reply.', send_date: '2026-09-08T00:02:00.000Z',
        swipes: ['Alternative imported reply.', 'Chosen imported reply.'], swipe_id: 1,
        swipe_info: [{ extra: { branch: { score: 1 } } }, { extra: { branch: { score: 8 } } }],
        extra: { unknown: { preserve: true } }, variables: [{ value: 1 }, { value: 8 }],
    },
];
let avatar;
let browser;
let page;
let stage = 'setup';
const failures = [];
const pageErrors = [];
const paths = [];
try {
    const form = new FormData();
    form.append('file_type', 'json');
    form.append('avatar', new Blob([JSON.stringify({
        spec: 'chara_card_v3', spec_version: '3.0',
        data: { name: characterName, description: 'Synthetic transfer fixture.', first_mes: 'Synthetic greeting.' },
    })]), 'fixture.json');
    const response = await send('/api/characters/import', {
        method: 'POST', headers: { 'X-CSRF-Token': token, Origin: base }, body: form,
    });
    assert.equal(response.status, 200);
    avatar = `${(await response.json()).file_name}.png`;
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    const options = {
        httpCredentials: { username: 'owner', password: AUTH_PASSWORD },
        viewport: { width: 1440, height: 1000 },
    };
    const context = await browser.newContext(options);
    page = await context.newPage();
    const observe = target => {
        target.on('pageerror', error => pageErrors.push(error.message));
        target.on('response', response => {
            const url = new URL(response.url());
            if (url.origin !== base) return;
            if (response.status() >= 400) failures.push({ path: url.pathname, status: response.status() });
            if (url.pathname.startsWith('/api/')) paths.push(url.pathname);
        });
    };
    observe(page);
    const selectCharacter = async target => {
        await target.goto(base, { waitUntil: 'domcontentloaded' });
        await target.waitForFunction(avatar => window.SillyTavern?.getContext?.()?.characters?.some(card => card.avatar === avatar), avatar);
        await target.waitForFunction(() => !document.querySelector('.splash-screen'));
        if (await target.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('closedIcon'))) {
            await target.locator('#rightNavDrawerIcon').click();
        }
        await target.getByText(characterName, { exact: true }).first().click();
        await target.waitForFunction(() => document.querySelector('#description_textarea')?.value === 'Synthetic transfer fixture.');
    };
    const openPastChats = async () => {
        await page.locator('#options_button').click();
        await page.locator('#option_select_chat').click();
        await page.locator('#shadow_select_chat_popup').waitFor({ state: 'visible' });
    };
    const assertVariables = async () => {
        const state = await page.evaluate(async () => {
            const st = await import('/script.js');
            return { messages: st.chat, metadata: st.chat_metadata, file: st.getCurrentChatId() };
        });
        assert.deepEqual(state.metadata.variables, fixture[0].chat_metadata.variables);
        assert.deepEqual(state.metadata.unknown, fixture[0].chat_metadata.unknown);
        const reply = state.messages.find(message => message.mes === 'Chosen imported reply.');
        assert.ok(reply);
        assert.deepEqual(reply.swipes, fixture[2].swipes);
        assert.equal(reply.swipe_id, 1);
        assert.deepEqual(reply.swipe_info, fixture[2].swipe_info);
        assert.deepEqual(reply.variables, fixture[2].variables);
        assert.deepEqual(reply.extra.unknown, fixture[2].extra.unknown);
        return state;
    };
    stage = 'original-ui-import';
    await selectCharacter(page);
    await openPastChats();
    const importing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/import');
    await page.locator('#chat_import_file').setInputFiles({
        name: 'native-fixture.jsonl', mimeType: 'application/x-ndjson',
        buffer: Buffer.from(fixture.map(item => JSON.stringify(item)).join('\n')),
    });
    const importedResponse = await importing;
    assert.equal(importedResponse.status(), 200);
    const importedFile = (await importedResponse.json()).fileNames[0];
    const importedBase = importedFile.replace(/\.jsonl$/i, '');
    const importedBody = { avatar_url: avatar, file_name: importedFile };
    assert.deepEqual(await (await post('/api/chats/get', importedBody)).json(), fixture);
    const importedBlock = page.locator(`#select_chat_div .select_chat_block[file_name="${importedBase}"]`);
    await importedBlock.waitFor({ state: 'visible' });
    await importedBlock.click();
    await page.locator('#chat .mes_text').filter({ hasText: 'Chosen imported reply.' }).waitFor();
    await assertVariables();

    stage = 'original-ui-rename';
    await openPastChats();
    await page.locator(`#select_chat_div .select_chat_block[file_name="${importedBase}"] .renameChatButton`).click();
    await page.locator('dialog[open] .popup-input').fill(renamedFile);
    const renaming = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/rename');
    await page.locator('dialog[open] .popup-button-ok').click();
    assert.equal((await renaming).status(), 200);
    await page.locator(`#select_chat_div .select_chat_block[file_name="${renamedFile}"]`).waitFor({ state: 'visible' });
    await page.locator('#select_chat_cross').click();
    assert.equal((await assertVariables()).file, renamedFile);
    assert.deepEqual(await (await post('/api/chats/get', importedBody)).json(), []);

    stage = 'save-and-export';
    await page.evaluate(async () => (await import('/script.js')).saveChatConditional());
    const afterSave = await (await post('/api/chats/get', { avatar_url: avatar, file_name: renamedFile })).json();
    assert.deepEqual(afterSave[0].future_header, fixture[0].future_header);
    assert.deepEqual(afterSave[0].chat_metadata.variables, fixture[0].chat_metadata.variables);
    assert.deepEqual(afterSave.at(-1).extra.unknown, fixture[2].extra.unknown);
    const exported = await (await post('/api/chats/export', { avatar_url: avatar, file_name: renamedFile, format: 'jsonl' })).json();
    assert.deepEqual(exported.result.split('\n').map(JSON.parse), afterSave);
    if (await page.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('openIcon'))) {
        await page.locator('#rightNavDrawerIcon').click();
    }
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), animations: 'disabled' });
    await context.close();

    stage = 'fresh-mobile-context';
    const mobile = await browser.newContext({ ...options, viewport: { width: 390, height: 844 } });
    page = await mobile.newPage();
    observe(page);
    await selectCharacter(page);
    await page.locator('#chat .mes_text').filter({ hasText: 'Chosen imported reply.' }).waitFor();
    assert.equal((await assertVariables()).file, renamedFile);
    if (await page.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('openIcon'))) {
        await page.locator('#rightNavDrawerIcon').click();
    }
    await page.locator('#right-nav-panel').waitFor({ state: 'hidden' });
    await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), animations: 'disabled' });
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(paths.some(path => path.startsWith('/api/tokenizers/')), false);
    await writeFile(new URL('report.json', output), JSON.stringify({
        browserVersion: browser.version(), originalUiImportAndRenamePassed: true, freshMobileReloadPassed: true,
        metadataAndSwipeFieldsPreserved: true,
        customHeaderAfterFrontendSave: Object.hasOwn(afterSave[0], 'future_header'),
        fullFrontendAcceptance: false, readyForChat: false, failures, pageErrors, paths,
        note: 'Native import and subsequent frontend save retain custom header, metadata and message fields. Generation and plugins remain unverified.',
    }, null, 2));
    console.log('PASS: original UI JSONL import, chat selection, rename, save/export and fresh mobile reload.');
    console.log('PASS: metadata, variables, swipes, swipe_info and unknown message fields; zero failed HTTP responses or page errors.');
    console.log('PASS: custom header fields survive the original frontend header rewrite.');
} catch (error) {
    await writeFile(new URL('failure.json', output), JSON.stringify({ stage, failures, pageErrors, paths }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: fileURLToPath(new URL('failure.png', output)) }).catch(() => {});
    throw error;
} finally {
    await browser?.close();
    if (avatar) {
        assert.equal((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).status, 200);
        console.log('Removed only this run\'s synthetic character and chats.');
    }
}
