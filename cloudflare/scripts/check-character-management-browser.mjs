import assert from 'node:assert/strict';
import { ownerClient } from './owner-client.mjs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// This suite only uses the isolated local preview and its own synthetic fixtures.
const base = 'http://127.0.0.1:8789';
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { AUTH_PASSWORD } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
const owner = await ownerClient(base, AUTH_PASSWORD);
const output = new URL('../.build/character-management-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const send = (pathname, options = {}) => fetch(new URL(pathname, base), {
    ...options, signal: AbortSignal.timeout(20000),
    headers: { ...owner.headers, ...options.headers },
});
const { token } = await (await send('/csrf-token')).json();
const post = (pathname, body) => send(pathname, {
    method: 'POST', headers: { Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});
const originalSettings = JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
const suffix = randomUUID().slice(0, 8);
const initialName = `Management ${suffix}`;
const renamedName = `Renamed ${suffix}`;
const personaName = `Persona ${suffix}`;
const chatFile = `Existing chat ${suffix}`;
const fixture = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: { name: initialName, description: 'Synthetic management fixture.', first_mes: 'New greeting.',
        extensions: { fixture: { unknown: [null, false, 7] } }, alternate_greetings: ['Alternative'] },
    future: { retained: true },
};
const chat = [
    { user_name: 'User', character_name: initialName, chat_metadata: { integrity: randomUUID(), tainted: true, variables: { score: 8 } }, future_header: [null, false] },
    { name: initialName, is_user: false, mes: 'Keep this reply through every edit.',
        swipes: ['First branch', 'Keep this reply through every edit.'], swipe_id: 1,
        swipe_info: [{ extra: { score: 2 } }, { extra: { score: 8 } }], extra: { future: true } },
];
const failures = [], pageErrors = [], paths = [];
const evidence = {};
let browser, page, avatar, persona;
let watchdog;
let stage = 'setup';
try {
    const completed = (async () => {
    const form = new FormData();
    form.append('file_type', 'json');
    form.append('avatar', new Blob([JSON.stringify(fixture)]), 'fixture.json');
    const imported = await send('/api/characters/import', {
        method: 'POST', headers: { Origin: base, 'X-CSRF-Token': token }, body: form,
    });
    assert.equal(imported.status, 200);
    avatar = `${(await imported.json()).file_name}.png`;
    assert.equal((await post('/api/chats/save', { avatar_url: avatar, file_name: chatFile, chat })).status, 200);
    assert.equal((await post('/api/characters/merge-attributes', { avatar, chat: chatFile })).status, 200);
    browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
    const options = {
        storageState: owner.storageState(),
        locale: 'en-US',
        viewport: { width: 1440, height: 1000 },
    };
    const context = await browser.newContext(options);
    context.setDefaultTimeout(20000);
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
    const selectCharacter = async (target, displayName) => {
        await target.goto(base, { waitUntil: 'domcontentloaded' });
        await target.waitForFunction(avatar => window.SillyTavern?.getContext?.()?.characters?.some(card => card.avatar === avatar), avatar);
        await target.waitForFunction(() => !document.querySelector('.splash-screen'));
        if (await target.locator('#rightNavDrawerIcon').evaluate(element => element.classList.contains('closedIcon'))) {
            await target.locator('#rightNavDrawerIcon').click();
        }
        await target.getByText(displayName, { exact: true }).first().click();
        await target.locator('#chat .mes_text').filter({ hasText: chat[1].mes }).waitFor();
    };
    const selectMenu = async id => {
        const value = await page.locator(`#${id}`).getAttribute('value')
            ?? await page.locator(`#${id}`).evaluate(option => option.value);
        await page.locator('#char-management-dropdown').selectOption(value);
    };
    const acceptCrop = async (path, crop) => {
        console.log(`Waiting for the original crop dialog: ${path}`);
        await page.locator('dialog[open] .cropper-container').waitFor();
        await page.evaluate(crop => {
            const image = document.querySelector('dialog[open] .popup-crop-image');
            if (!image) {
                const cropperImage = document.querySelector('dialog[open] .cropper-hidden');
                window.$(cropperImage).cropper('setData', crop);
            } else window.$(image).cropper('setData', crop);
        }, crop);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === path);
        await page.locator('dialog[open] .popup-button-ok').click();
        const result = await response;
        console.log(`Crop response received: ${result.status()}`);
        assert.equal(result.status(), 200);
        assert.equal(new URL(result.url()).searchParams.has('crop'), false);
        return result;
    };
    const inspectImage = async path => page.evaluate(async path => {
        const bitmap = await createImageBitmap(await (await fetch(path, { cache: 'reload' })).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height,
            center: [...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data] };
        bitmap.close();
        return result;
    }, path);
    const assertChat = async () => {
        const state = await (await post('/api/chats/get', { avatar_url: avatar, file_name: chatFile })).json();
        assert.deepEqual(state[0].future_header, chat[0].future_header);
        assert.deepEqual(state[0].chat_metadata.variables, chat[0].chat_metadata.variables);
        assert.deepEqual(state[1].swipes, chat[1].swipes);
        assert.deepEqual(state[1].swipe_info, chat[1].swipe_info);
        assert.deepEqual(state[1].extra, chat[1].extra);
        return state;
    };

    console.log('Selecting the synthetic character.');
    await selectCharacter(page, initialName);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.never_resize_avatars = false;
    });
    const imageData = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 900;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e52030';
        ctx.fillRect(0, 0, 600, 900);
        ctx.fillStyle = '#20c060';
        ctx.fillRect(600, 0, 600, 900);
        return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    });
    const jpeg = { name: 'synthetic-avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imageData, 'base64') };
    const greenCrop = { x: 600, y: 0, width: 600, height: 900 };
    const redCrop = { x: 0, y: 0, width: 600, height: 900 };
    stage = 'character-avatar-crop';
    console.log(stage);
    await page.locator('#add_avatar_button').setInputFiles(jpeg);
    await acceptCrop('/api/characters/edit', greenCrop);
    console.log('Character crop upload returned successfully; checking stored pixels.');
    const characterPixels = await inspectImage(`/characters/${encodeURIComponent(avatar)}`);
    assert.equal(characterPixels.width, 512);
    assert.equal(characterPixels.height, 768);
    assert.ok(characterPixels.center[1] > 150 && characterPixels.center[0] < 80);
    evidence.characterCrop = characterPixels;
    let card = await (await post('/api/characters/get', { avatar_url: avatar })).json();
    assert.deepEqual(card.future, fixture.future);
    assert.deepEqual(card.data.extensions.fixture, fixture.data.extensions.fixture);
    await assertChat();

    stage = 'cancel-character-crop';
    await page.locator('#add_avatar_button').setInputFiles(jpeg);
    await page.locator('dialog[open] .cropper-container').waitFor();
    await page.locator('dialog[open] .popup-button-cancel').click();
    await page.waitForFunction(() => document.querySelector('#add_avatar_button').files.length === 0);
    await page.evaluate(async () => (await import('/script.js')).createOrEditCharacter());
    assert.deepEqual(await inspectImage(`/characters/${encodeURIComponent(avatar)}`), characterPixels);
    evidence.cancelledCropDoesNotUploadOnLaterSave = true;

    stage = 'character-rename';
    console.log(stage);
    await selectMenu('renameCharButton');
    await page.locator('dialog[open] .popup-input').fill(renamedName);
    const renaming = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/rename');
    await page.locator('dialog[open] .popup-button-ok').click();
    const renamed = await renaming;
    assert.equal(renamed.status(), 200);
    const oldAvatar = avatar;
    avatar = (await renamed.json()).avatar;
    await page.getByText('Past chats will still contain the old character name.', { exact: false }).waitFor();
    await page.locator('dialog[open] .popup-button-cancel').click();
    await page.locator('#chat .mes_text').filter({ hasText: chat[1].mes }).waitFor();
    assert.deepEqual(await (await post('/api/characters/chats', { avatar_url: oldAvatar })).json(), []);
    await assertChat();
    evidence.renameChatPreserved = true;

    stage = 'character-overwrite-import';
    console.log(stage);
    await selectMenu('replace_update');
    const choosing = page.waitForEvent('filechooser');
    await page.getByText('Replace with File', { exact: true }).click();
    const replacement = structuredClone(fixture);
    replacement.data.name = renamedName;
    replacement.data.description = 'Replacement description.';
    replacement.data.extensions.fixture.replacement = true;
    const replacing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/import');
    const replacementReload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/get');
    await (await choosing).setFiles({ name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
    assert.equal((await replacing).status(), 200);
    await page.waitForFunction(() => document.querySelector('#description_textarea')?.value === 'Replacement description.');
    await replacementReload;
    await page.locator('#chat .mes_text').filter({ hasText: chat[1].mes }).waitFor();
    await assertChat();
    evidence.overwriteImportPreservedChat = true;
    await page.locator('#description_textarea').waitFor({ state: 'visible' });
    await page.locator('#chat .mes_text').filter({ hasText: chat[1].mes }).waitFor();
    await page.evaluate(() => window.toastr.clear());
    await page.screenshot({ path: fileURLToPath(new URL('character-desktop.png', output)), animations: 'disabled' });

    stage = 'persona-upload-and-crop';
    console.log(stage);
    await page.locator('#persona-management-button .drawer-icon').click();
    await page.locator('#avatar_upload_file').setInputFiles(jpeg);
    const uploaded = await acceptCrop('/api/avatars/upload', greenCrop);
    persona = (await uploaded.json()).path;
    for (const [title, value] of [
        ['Enter a name for this persona:', personaName],
        ['Enter a description for this persona:', 'Synthetic persona with {{user}}.'],
    ]) {
        const dialog = page.locator('dialog[open]:not([closing])').filter({ hasText: title });
        await dialog.locator('.popup-input').fill(value);
        await dialog.locator('.popup-button-ok').click();
        await dialog.waitFor({ state: 'hidden' });
    }
    const personaBlock = page.locator(`#user_avatar_block .avatar-container[data-avatar-id="${persona}"]`);
    await personaBlock.waitFor();
    await personaBlock.click();
    await page.waitForFunction(name => document.querySelector('#your_name')?.textContent === name, personaName);
    const personaPixels = await inspectImage(`/User%20Avatars/${encodeURIComponent(persona)}`);
    assert.equal(personaPixels.width, 512);
    assert.equal(personaPixels.height, 768);
    assert.ok(personaPixels.center[1] > 150 && personaPixels.center[0] < 80);

    stage = 'persona-replace';
    console.log(stage);
    const personaChoosing = page.waitForEvent('filechooser');
    await page.locator('#persona_set_image_button').click();
    await (await personaChoosing).setFiles(jpeg);
    const replacedPersona = await acceptCrop('/api/avatars/upload', redCrop);
    assert.equal((await replacedPersona.json()).path, persona);
    const replacedPixels = await inspectImage(`/User%20Avatars/${encodeURIComponent(persona)}`);
    assert.ok(replacedPixels.center[0] > 170 && replacedPixels.center[1] < 80);
    await page.evaluate(async persona => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.persona_descriptions[persona].future = { unknown: [null, false] };
        await (await import('/script.js')).saveSettings();
    }, persona);
    await page.screenshot({ path: fileURLToPath(new URL('persona-desktop.png', output)), animations: 'disabled' });
    evidence.personaCrop = personaPixels;
    evidence.personaReplacement = replacedPixels;
    evidence.uncroppedBrowserConversion = await page.evaluate(async data => {
        const { prepareAvatarUpload } = await import('/scripts/stworks-avatar.js');
        const form = new FormData();
        form.set('avatar', await (await fetch(`data:image/jpeg;base64,${data}`)).blob(), 'uncropped.jpg');
        await prepareAvatarUpload(form);
        const blob = form.get('avatar');
        const image = await createImageBitmap(blob);
        const result = { width: image.width, height: image.height, type: blob.type };
        image.close();
        return result;
    }, imageData);
    assert.deepEqual(evidence.uncroppedBrowserConversion, { width: 1200, height: 900, type: 'image/png' });
    await context.close();

    stage = 'fresh-mobile-context';
    console.log(stage);
    const mobile = await browser.newContext({ ...options, viewport: { width: 390, height: 844 } });
    mobile.setDefaultTimeout(20000);
    page = await mobile.newPage();
    observe(page);
    await selectCharacter(page, renamedName);
    assert.equal(await page.locator('#description_textarea').inputValue(), 'Replacement description.');
    await assertChat();
    await page.locator('#persona-management-button .drawer-icon').click();
    const mobilePersona = page.locator(`#user_avatar_block .avatar-container[data-avatar-id="${persona}"]`);
    await mobilePersona.waitFor();
    await mobilePersona.click();
    await page.waitForFunction(name => document.querySelector('#your_name')?.textContent === name, personaName);
    const savedPersona = await page.evaluate(async persona => {
        const { power_user } = await import('/scripts/power-user.js');
        return power_user.persona_descriptions[persona];
    }, persona);
    assert.equal(savedPersona.description, 'Synthetic persona with {{user}}.');
    assert.deepEqual(savedPersona.future, { unknown: [null, false] });
    assert.deepEqual(await inspectImage(`/User%20Avatars/${encodeURIComponent(persona)}`), replacedPixels);
    await page.screenshot({ path: fileURLToPath(new URL('persona-mobile.png', output)), animations: 'disabled' });
    evidence.freshMobileReload = true;

    stage = 'persona-delete-original-ui';
    await page.locator('#persona_delete_button').click();
    const deleting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/avatars/delete');
    await page.locator('dialog[open] .popup-button-ok').click();
    assert.equal((await deleting).status(), 200);
    assert.equal((await (await post('/api/avatars/get', {})).json()).includes(persona), false);
    evidence.personaDelete = true;
    persona = undefined;
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(paths.some(path => path.startsWith('/api/tokenizers/')), false);
    await writeFile(new URL('report.json', output), JSON.stringify({
        browserVersion: browser.version(), evidence, failures, pageErrors, paths,
        readyForChat: false, fullFrontendAcceptance: false,
        note: 'Original UI management flows only. Generation, third-party plugins and cloud performance remain unverified.',
    }, null, 2));
    console.log('PASS: original UI character JPEG crop, rename, replacement-card import and chat preservation.');
    console.log('PASS: persona crop/upload, replacement, settings and image persistence in a fresh mobile context, deletion.');
    console.log('PASS: decoded pixels and dimensions, zero failed browser HTTP responses, page errors or backend tokenizer calls.');
    })();
    await Promise.race([completed, new Promise((resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Browser suite deadline exceeded at ${stage}`)), 120000);
    })]);
} catch (error) {
    console.error(`Browser regression failed at ${stage}: ${error.message}`);
    await writeFile(new URL('failure.json', output), JSON.stringify({ stage, evidence, failures, pageErrors, paths }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: fileURLToPath(new URL('failure.png', output)), timeout: 5000 }).catch(() => {});
    throw error;
} finally {
    clearTimeout(watchdog);
    await browser?.close();
    if (persona) assert.equal((await post('/api/avatars/delete', { avatar: persona })).status, 200);
    try {
        if (avatar) assert.equal((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).status, 200);
    } finally {
        assert.equal((await post('/api/settings/save', originalSettings)).status, 200);
    }
    console.log('Removed only this run\'s synthetic files and restored the isolated test settings.');
}
