import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { readCardPng } from '../src/card-png.js';

const person = '\u6c88\u8232', rapport = '\u597d\u611f\u5ea6', idKey = '_\u7f16\u53f7';
const probe = { nil: null, enabled: false, nested: [0, { retained: 'transfer' }] };
const worldMarker = 'TRANSFER-WORLDBOOK-REVISION-2';
const set = (key, value) => `_.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`;

export async function runTransferCases(env) {
    const { targets, checkpoint, generate, snapshot, readyJqueryPanels, card, evidence,
        newTarget, openChat, connect, output, setStage } = env;
    assert.equal(card.data.character_version, '1.1-stworks-smoke');
    const savedA = new Map(), savedB = new Map(), exports = new Map();
    const avatars = new Map();
    for (const target of targets) avatars.set(target.side, { a: target.avatar });
    async function waitMvu(target, value, id = 'LT-07') {
        await target.page.waitForFunction(({ person, rapport, idKey, value, id }) => {
            const stat = window.Mvu?.getMvuData({ type: 'message' }).stat_data;
            return stat?.[person]?.[rapport] === value && stat?.[person]?.[idKey] === id;
        }, { person, rapport, idKey, value, id });
        return readyJqueryPanels(target);
    }
    async function send(target, label, value, action = 'send') {
        const result = await generate(target, action, label, [set(`${person}.${rapport}`, value)], value, `SMOKE ${label}.`);
        await target.page.waitForFunction(() => window.lighthouseMvuRenderedMessage === window.SillyTavern.getContext().chat.length - 1);
        return { prompt: result.prompt, panels: await readyJqueryPanels(target) };
    }
    async function select(target, avatar, value, id = 'LT-07', fresh = false) {
        await target.page.evaluate(async avatar => {
            window.transferPreviousMvu = window.Mvu;
            const st = await import('/script.js');
            await st.selectCharacterById(st.characters.findIndex(c => c.avatar === avatar), { switchMenu: false });
        }, avatar);
        if (id === 'HB-02' && fresh) {
            const consent = target.page.locator('dialog[open]').filter({ hasText: '\u5d4c\u5165\u5f0f\u811a\u672c' });
            await consent.locator('.popup-button-ok').click();
            await target.page.waitForFunction(() => !!window.Mvu && window.Mvu !== window.transferPreviousMvu);
        }
        if (fresh) await target.page.evaluate(async () => (await import('/script.js')).doNewChat());
        await waitMvu(target, value, id);
    }
    async function refreshAndAuthorize(target, avatar, name) {
        await target.page.evaluate(async ({ avatar, name }) => {
            const c = window.SillyTavern.getContext();
            const allowed = c.extensionSettings.character_allowed_regex;
            if (!allowed.includes(avatar)) allowed.push(avatar);
            const enabled = c.extensionSettings.tavern_helper.script.enabled.characters;
            if (!enabled.includes(name)) enabled.push(name);
            c.saveSettingsDebounced();
            await (await import('/script.js')).getCharacters();
        }, { avatar, name });
    }
    async function mvuFrames(target, scriptId = card.data.extensions.tavern_helper.scripts[0].id) {
        const frames = [];
        for (const frame of target.page.frames()) {
            if (await frame.evaluate(scriptId => {
                try { return typeof getScriptId === 'function' && getScriptId() === scriptId; }
                catch { return false; }
            }, scriptId).catch(() => false)) frames.push(frame);
        }
        assert.equal(frames.length, 1, 'Exactly one active MVU script iframe expected');
        return frames;
    }
    for (const [action, value] of [['send', 34], ['regenerate', 35], ['swipe', 36]]) {
        await checkpoint(`transfer-A-${action}`, target => send(target, `A-${action}`, value, action));
    }
    await checkpoint('transfer-A-unknown-fields', async target => {
        await target.page.evaluate(async probe => {
            const c = window.SillyTavern.getContext();
            c.chatMetadata.transfer_probe = structuredClone(probe);
            c.chat.at(-1).extra ??= {};
            c.chat.at(-1).extra.transfer_probe = structuredClone(probe);
            await window.TavernHelper.updateVariablesWith(v => ({ ...v, transfer_probe: structuredClone(probe) }), { type: 'message' });
            await (await import('/scripts/extensions.js')).writeExtensionField(c.characterId, 'transfer_probe', probe);
            await c.saveChat();
        }, probe);
        savedA.set(target.side, await snapshot(target));
        return { metadata: await target.page.evaluate(() => window.SillyTavern.getContext().chatMetadata.transfer_probe) };
    });
    await checkpoint('transfer-B-select-isolation', async target => {
        const oldFrames = await mvuFrames(target);
        const b = structuredClone(card);
        b.data.name = b.name = 'SMOKE Transfer B';
        b.data.extensions.tavern_helper.scripts[0].id = 'smoke-transfer-b-mvu';
        b.data.character_book.name = b.data.extensions.world = 'SMOKE Transfer B World';
        const init = b.data.character_book.entries.find(e => e.comment.includes('[InitVar]'));
        const variables = parse(init.content);
        variables[person][rapport] = 12;
        variables[person][idKey] = 'HB-02';
        init.content = stringify(variables);
        const response = await target.post('/api/characters/import', {
            file_type: 'json', avatar: { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(b)) },
        }, true);
        const avatar = `${(await response.json()).file_name}.png`;
        avatars.get(target.side).b = avatar;
        await refreshAndAuthorize(target, avatar, b.data.name);
        await target.page.evaluate(async book => {
            const wi = await import('/scripts/world-info.js');
            await wi.saveWorldInfo(book.name, wi.convertCharacterBook(book), true);
            await wi.updateWorldInfoList();
        }, b.data.character_book);
        await select(target, avatar, 12, 'HB-02', true);
        assert.ok(oldFrames.every(frame => frame.isDetached()), 'A MVU iframe survived character switch');
        await mvuFrames(target, 'smoke-transfer-b-mvu');
        assert.equal(await target.page.evaluate(() => window.SillyTavern.getContext().chatMetadata.transfer_probe), undefined);
        return { activeScriptFrames: 1 };
    });
    await checkpoint('transfer-B-generate', async target => {
        const result = await send(target, 'B-send', 13);
        savedB.set(target.side, await snapshot(target));
        return result;
    });
    await checkpoint('transfer-A-return', async target => {
        const oldFrames = await mvuFrames(target, 'smoke-transfer-b-mvu');
        await select(target, avatars.get(target.side).a, 36);
        assert.ok(oldFrames.every(frame => frame.isDetached()), 'B MVU iframe survived character switch');
        assert.deepEqual(await snapshot(target), savedA.get(target.side));
        assert.deepEqual(await target.page.evaluate(() => window.SillyTavern.getContext().chatMetadata.transfer_probe), probe);
        return { activeScriptFrames: (await mvuFrames(target)).length };
    });
    await checkpoint('transfer-edited-world-and-UI-export', async target => {
        await target.page.evaluate(async ({ name, marker, probe }) => {
            const wi = await import('/scripts/world-info.js');
            const book = await wi.loadWorldInfo(name);
            book.entries[0].content += `\n${marker}`;
            book.entries[0].extensions ??= {};
            book.entries[0].extensions.transfer_probe = probe;
            await wi.saveWorldInfo(name, book, true);
        }, { name: card.data.character_book.name, marker: worldMarker, probe });
        const file = await target.page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
        const chat = (await (await target.post('/api/chats/export', {
            avatar_url: avatars.get(target.side).a, file: `${file}.jsonl`, format: 'jsonl', exportfilename: 'transfer.jsonl',
        })).json()).result;
        if (await target.page.locator('#rightNavDrawerIcon').evaluate(el => el.classList.contains('closedIcon'))) {
            await target.page.locator('#rightNavDrawerIcon').click();
        }
        await target.page.locator('div#export_button').click();
        const exporting = target.page.waitForResponse(r => new URL(r.url()).pathname === '/api/characters/export');
        const downloading = target.page.waitForEvent('download');
        await target.page.locator('#export_format_popup .export_format[data-format="json"]').click();
        const json = await (await exporting).json();
        await (await downloading).saveAs(fileURLToPath(new URL(`${target.side}-transfer-card.json`, output)));
        await target.page.locator('#rightNavDrawerIcon').click();
        assert.ok(json.data.character_book.entries[0].content.includes(worldMarker), 'Export used a stale embedded worldbook');
        assert.deepEqual(json.data.character_book.entries[0].extensions.transfer_probe, probe);
        assert.deepEqual(json.data.extensions.transfer_probe, probe);
        assert.deepEqual(json.data.extensions.tavern_helper, card.data.extensions.tavern_helper);
        assert.deepEqual(json.data.extensions.regex_scripts, card.data.extensions.regex_scripts);
        const png = await (await target.post('/api/characters/export', { avatar_url: avatars.get(target.side).a, format: 'png' })).body();
        assert.deepEqual(readCardPng(png).data, json.data, 'PNG and JSON must contain the same card data');
        await writeFile(new URL(`${target.side}-transfer-card.png`, output), png);
        await writeFile(new URL(`${target.side}-transfer-chat.jsonl`, output), chat);
        exports.set(target.side, { json, png, chat, file });
        return { data: json.data };
    });
    await checkpoint('transfer-PNG-reimport-fresh-chat', async target => {
        const exported = exports.get(target.side);
        const response = await target.post('/api/characters/import', {
            file_type: 'png', avatar: { name: 'roundtrip.png', mimeType: 'image/png', buffer: exported.png },
        }, true);
        const avatar = `${(await response.json()).file_name}.png`;
        assert.notEqual(avatar, avatars.get(target.side).a, 'Reimport must not overwrite the source character');
        avatars.get(target.side).copy = avatar;
        await refreshAndAuthorize(target, avatar, card.data.name);
        await select(target, avatar, 30, 'LT-07', true);
        const imported = await (await target.post('/api/characters/get', { avatar_url: avatar })).json();
        assert.deepEqual(imported.data, exported.json.data);
        assert.equal(await target.page.evaluate(() => window.SillyTavern.getContext().chatMetadata.transfer_probe), undefined);
        return { data: imported.data };
    });
    await checkpoint('transfer-JSONL-UI-import', async target => {
        const { page } = target, exported = exports.get(target.side);
        await page.locator('#options_button').click();
        await page.locator('#option_select_chat').click();
        await page.locator('#shadow_select_chat_popup').waitFor({ state: 'visible' });
        const importing = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/import');
        await page.locator('#chat_import_file').setInputFiles({
            name: 'transfer.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(exported.chat),
        });
        const filename = (await (await importing).json()).fileNames[0];
        const raw = await (await target.post('/api/chats/get', {
            avatar_url: avatars.get(target.side).copy, file_name: filename,
        })).json();
        assert.deepEqual(raw, exported.chat.split('\n').filter(Boolean).map(JSON.parse));
        const base = filename.replace(/\.jsonl$/i, '');
        await page.locator(`#select_chat_div .select_chat_block[file_name=${JSON.stringify(base)}]`).click();
        await waitMvu(target, 36);
        assert.deepEqual(await snapshot(target), savedA.get(target.side));
        assert.deepEqual(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.transfer_probe), probe);
        assert.deepEqual(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).extra.transfer_probe), probe);
        return { metadata: probe, rawRoundtrip: true };
    });
    for (const [direction, value] of [['left', 35], ['right', 36]]) {
        await checkpoint(`transfer-imported-branch-${direction}`, async target => {
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            await delay(500);
            await target.page.locator('#chat .mes').last().locator(`.swipe_${direction}`).click();
            return waitMvu(target, value);
        });
    }
    await checkpoint('transfer-imported-send', target => send(target, 'imported-send', 37));
    const copied = new Map();
    for (const target of targets) {
        copied.set(target.side, await snapshot(target));
        await target.page.locator('#chat').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-transfer-desktop.png`, output)), fullPage: true });
    }
    await checkpoint('transfer-originals-unaffected', async target => {
        await select(target, avatars.get(target.side).b, 13, 'HB-02');
        assert.deepEqual(await snapshot(target), savedB.get(target.side));
        await select(target, avatars.get(target.side).a, 36);
        assert.deepEqual(await snapshot(target), savedA.get(target.side));
        await select(target, avatars.get(target.side).copy, 37);
        assert.deepEqual(await snapshot(target), copied.get(target.side));
        return { originalA: 36, originalB: 13, imported: 37 };
    });
    setStage('transfer-mobile-reload');
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(1500);
        await target.context.close();
        const replacement = await newTarget(target.side, target.base, target.credentials, true);
        replacement.avatar = avatars.get(target.side).copy;
        targets[index] = replacement;
        await openChat(replacement, false, true);
        assert.deepEqual(await snapshot(replacement), copied.get(target.side));
        await connect(replacement);
    }
    await checkpoint('transfer-mobile-send', target => send(target, 'transfer-mobile', 38));
    for (const target of targets) {
        await target.page.locator('#chat').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await delay(300);
        assert.equal(await target.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-transfer-mobile.png`, output)), fullPage: true });
    }
    evidence.transferScope = { realModel: false, cloud: false, nativeCharacterSwitch: true,
        uiJsonExport: true, pngAndJsonPayloadParity: true, uiJsonlImport: true, twoSourceCharactersPreserved: true };
}
