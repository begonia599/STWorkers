import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const person = '\u6c88\u8232', rapport = '\u597d\u611f\u5ea6', inventory = '\u7269\u54c1\u680f';
const duty = '\u503c\u73ed', first = '\u9996\u6b21\u4ea4\u8c08\u5df2\u8bb0\u5f55';
const item = '\u9a6c\u706f', id = '_\u7f16\u53f7';
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function assign(object, key, value) {
    const parts = key.split('.');
    const leaf = parts.pop();
    const container = parts.reduce((value, part) => value[part], object);
    container[leaf] = value;
}
const command = (name, ...args) => `_.${name}(${args.map(value => JSON.stringify(value)).join(', ')});`;
async function waitForStat(page, expected) {
    await page.waitForFunction(expected => window._.isEqual(
        window.Mvu.getMvuData({ type: 'message' }).stat_data, expected), expected);
}
const facts = {
    room: '\u4e8c\u5341\u4e03\u7bb1',
    fog: '\u4e8c\u7ea7\u7f38',
    tide: '\u672c\u6708\u6700\u9ad8\u8bfb\u6570',
    bell: '\u949f\u7ef3\u524d\u5e74',
    supply: '\u660c\u5c7f\u4e09\u53f7',
    negative: '\u6728\u7bb1\u73b0\u5728\u7a7a\u7740',
};
const activations = prompt => Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, prompt.includes(value)]));

export async function runCard2Cases(env) {
    const { targets, checkpoint, generate, snapshot, readyJqueryPanels, card, sourceRoot, evidence,
        newTarget, openChat, connect, output, setStage } = env;
    assert.equal(card.data.character_version, '1.1-stworks-smoke');
    assert.ok(sourceRoot, 'Supply the reviewed card2 revision source directory.');
    const baseline = JSON.parse(await readFile(path.join(sourceRoot, 'verify/state.json'), 'utf8'));
    const sourceOps = JSON.parse(await readFile(path.join(sourceRoot, 'verify/ops.json'), 'utf8'));
    assert.equal(sourceOps.length, 26);
    const groups = new Map();
    for (const op of sourceOps) {
        const sourceLabel = op.reason.match(/^T\d+(?:-\d+)?/)?.[0];
        // The author's final thought/time operations belong to the end of T8.
        const label = sourceLabel === 'T8' ? 'T8-6' : sourceLabel;
        assert.ok(label);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(op);
    }
    let consumedOps = 0;
    let expected = structuredClone(baseline);
    const panels = async target => {
        const state = await snapshot(target);
        // The unchanged runtime cleans every fifth message, keeping 20 recent floors.
        const cleanupEnd = Math.floor(state.messages.length / 5) * 5 - 1 - 20;
        const expectedCleanedIds = state.messages.flatMap((m, id) =>
            !m.is_user && id > 0 && id <= cleanupEnd ? [id] : []);
        const result = await readyJqueryPanels(target, { expectedCleanedIds });
        for (const panel of result) {
            assert.equal(panel.foreground, 'rgb(232, 237, 241)');
            assert.equal(panel.panelBackground, 'rgb(32, 36, 40)');
        }
        return result;
    };
    async function send(target, label, commands, desired, input, action = 'send') {
        const before = await snapshot(target);
        const result = await generate(target, action, label, commands, desired[person][rapport], input);
        // MVU throttles reception for 3s; inherited equal values do not prove it has run.
        // Its affected-message render follows BEFORE_MESSAGE_UPDATE and the variable write.
        await target.page.waitForFunction(label => {
            const c = window.SillyTavern.getContext();
            return c.chat.at(-1)?.mes.includes(`P3 ${label}.`)
                && window.lighthouseMvuRenderedMessage === c.chat.length - 1;
        }, label);
        await waitForStat(target.page, desired);
        const rendered = await panels(target);
        assert.ok(!result.visible.includes('<UpdateVariable>'));
        for (const marker of ['SMOKE-PROBE-BEFORE-CHAR', 'SMOKE-PROBE-AFTER-CHAR']) {
            assert.equal(result.prompt.split(marker).length - 1, 1, `${label}: duplicate/missing probe`);
        }
        const prior = action === 'send' ? before.stat
            : before.messages.at(-2).variables[before.messages.at(-2).swipe_id].stat_data;
        const rapportBlock = result.prompt.match(/<Rapport[^>]*>[\s\S]*?<\/Rapport>/)?.[0] ?? null;
        if (prior[duty][first] === '\u662f') {
            assert.ok(rapportBlock?.includes(`"${prior[person][rapport]}"`), `${label}: EJS read the wrong prior value`);
            const tiers = ['\u53ea\u56de\u7b54\u88ab\u95ee\u5230', '\u4f1a\u4e3b\u52a8\u62a5\u51fa', '\u6ca1\u8bf4\u5b8c'];
            const tier = prior[person][rapport] >= 70 ? 2 : prior[person][rapport] >= 40 ? 1 : 0;
            assert.deepEqual(tiers.map(text => rapportBlock.includes(text)), tiers.map((_, index) => index === tier));
        } else assert.equal(rapportBlock, null);
        return { prompt: result.prompt, active: activations(result.prompt), rapportBlock, panels: rendered };
    }
    await checkpoint('card2-T0-primary-default-jquery', async target => {
        assert.deepEqual((await snapshot(target)).stat, baseline);
        const schema = await target.page.evaluate(({ person, inventory }) =>
            window.Mvu.getMvuData({ type: 'message' }).schema.properties[person].properties[inventory], { person, inventory });
        assert.equal(schema.extensible, true);
        const cleanup = await target.page.evaluate(() =>
            window.SillyTavern.getContext().extensionSettings.mvu_settings['\u81ea\u52a8\u6e05\u7406\u53d8\u91cf']);
        assert.deepEqual(cleanup, {
            '\u542f\u7528': true, '\u5feb\u7167\u4fdd\u7559\u95f4\u9694': 50,
            '\u8981\u4fdd\u7559\u53d8\u91cf\u7684\u6700\u8fd1\u697c\u5c42\u6570': 20,
            '\u89e6\u53d1\u6062\u590d\u53d8\u91cf\u7684\u6700\u8fd1\u697c\u5c42\u6570': 10,
        });
        return { schema, cleanup, panels: await panels(target) };
    });
    await checkpoint('card2-T0-alternate-complete', async target => {
        await target.page.locator('#chat .mes').first().locator('.swipe_right').click();
        await target.page.waitForFunction(({ person, rapport }) =>
            window.Mvu.getMvuData({ type: 'message' }).stat_data[person][rapport] === 15, { person, rapport });
        await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
        const stat = (await snapshot(target)).stat;
        assert.equal(stat[person][id], baseline[person][id]);
        assert.deepEqual(stat[person][inventory], {});
        assert.deepEqual(stat[duty], baseline[duty]);
        assert.equal(stat[person]['\u72b6\u6001'], baseline[person]['\u72b6\u6001']);
        const probe = await target.page.evaluate(async ({ person, inventory, item }) => {
            const data = structuredClone(window.Mvu.getMvuData({ type: 'message' }));
            const parsed = await window.Mvu.parseMessage(`_.insert('${person}.${inventory}', '${item}', {quantity:1});`, data);
            return { extensible: data.schema.properties[person].properties[inventory].extensible,
                inserted: parsed.stat_data[person][inventory][item] };
        }, { person, inventory, item });
        assert.deepEqual(probe, { extensible: true, inserted: { quantity: 1 } });
        assert.deepEqual((await snapshot(target)).stat, stat, 'Alternate probe must not persist');
        return panels(target);
    });
    await checkpoint('card2-T0-primary-restored', async target => {
        await delay(500);
        await target.page.locator('#chat .mes').first().locator('.swipe_left').click();
        await waitForStat(target.page, baseline);
        await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
        return panels(target);
    });
    const inputs = {
        T1: '\u6211\u628a\u4fdd\u6e29\u676f\u91cc\u7684\u70ed\u8336\u5012\u8fdb\u4f60\u7684\u676f\u5b50\u3002',
        T2: '\u8fd9\u76cf\u9a6c\u706f\u4ea4\u7ed9\u4f60,\u6e05\u70b9\u4e00\u4e0b\u706f\u6cb9\u3002',
        T3: '\u9a6c\u706f\u6211\u5148\u62ff\u56de\u6765\u3002',
        T4: '\u7a97\u5916\u98ce\u5ffd\u7136\u538b\u4e0b\u6765,\u96fe\u6563\u4e86,\u6d6a\u5934\u5f00\u59cb\u7838\u5e73\u53f0\u3002',
        T5: '\u518d\u7ed9\u4f60\u5012\u4e00\u676f\u3002',
        T7: '\u4f60\u8fd8\u8bb0\u5f97\u65e7\u706f\u5ba4\u5417?',
    };
    for (const label of ['T1', 'T2', 'T3', 'T4', 'T5', 'T7', 'T8-1', 'T8-2', 'T8-3', 'T8-4', 'T8-5', 'T8-6']) {
        const commands = [];
        for (const op of groups.get(label) ?? []) {
            consumedOps++;
            assert.ok(['\u589e\u52a0', '\u6539\u4e3a'].includes(op.op));
            const old = get(expected, op.path);
            let value = op.op === '\u589e\u52a0' ? old + op.value : structuredClone(op.value);
            if (typeof value === 'string') value = value.replaceAll('{{user}}', 'Smoke Observer');
            if (label === 'T2' && op.path === `${person}.${inventory}.${item}`) {
                commands.push(command('insert', `${person}.${inventory}`, item, value));
            } else if (label === 'T3' && op.path === `${person}.${inventory}`) {
                commands.push(command('delete', `${person}.${inventory}.${item}`));
            } else {
                assert.notEqual(old, undefined);
                commands.push(command('set', op.path, old, value));
            }
            assign(expected, op.path, value);
        }
        const desired = structuredClone(expected);
        await checkpoint(`card2-${label}-engine-fixture`, async target => {
            const result = await send(target, label, commands, desired, inputs[label] ?? `SMOKE goodwill ${label}.`);
            assert.equal(result.active.negative, false);
            assert.equal(result.active.fog, false);
            if (label === 'T2') assert.ok(result.panels.at(-1).text.includes(item));
            if (label === 'T3') assert.deepEqual((await snapshot(target)).stat[person][inventory], {});
            if (label === 'T7') assert.equal(result.active.room, true);
            if (label === 'T5') assert.ok(commands.every(text => !text.includes(first)));
            return result;
        });
    }
    assert.equal(consumedOps, sourceOps.length, 'Every author operation must be exercised');
    await checkpoint('card2-default-cleanup-history-reload', async target => {
        const before = await snapshot(target);
        assert.equal(before.messages.length, 25);
        assert.deepEqual(before.messages.flatMap((m, id) =>
            !m.is_user && !m.variables[m.swipe_id]?.stat_data ? [id] : []), [2, 4]);
        await target.page.evaluate(async () => (await import('/script.js')).reloadCurrentChat());
        const rendered = await panels(target);
        assert.deepEqual(rendered.filter(panel => panel.unavailable).map(panel => panel.id), [2, 4]);
        assert.deepEqual(await snapshot(target), before, 'Rendering must not restore or overwrite cleaned variables');
        await target.page.locator('#chat .mes[mesid="2"]').scrollIntoViewIfNeeded();
        await target.page.screenshot({ path: fileURLToPath(new URL(`${target.side}-card2-cleanup.png`, output)) });
        return { cleanedAssistantIds: [2, 4], panels: rendered };
    });
    await checkpoint('card2-T8-trust-prompt', async target => {
        const result = await send(target, 'T8-trust', [], expected, 'SMOKE trust observation.');
        assert.ok(result.rapportBlock?.includes('"75"'));
        assert.ok(result.rapportBlock?.includes('\u6ca1\u8bf4\u5b8c'));
        return result;
    });
    await checkpoint('card2-T6-soft-rule-boundary-not-model-test', async target => {
        const before = await snapshot(target);
        const result = await target.page.evaluate(async ({ person, id }) => {
            const data = structuredClone(window.Mvu.getMvuData({ type: 'message' }));
            const result = await window.Mvu.parseMessage(`_.set('${person}.${id}', 'LT-07', 'LT-99');`, data);
            return result.stat_data[person][id];
        }, { person, id });
        assert.equal(result, 'LT-99', 'This card has no code-level readonly guard');
        assert.deepEqual(await snapshot(target), before);
        return { parsedInMemory: result, realModelT6: 'not-run' };
    });
    for (const value of [76, 77, 78, 80]) {
        expected[person][rapport] = value;
        await checkpoint(`card2-dispatch-${value}`, target => send(target, `dispatch-${value}`,
            [command('set', `${person}.${rapport}`, 75, value)], expected, '', value === 80 ? 'swipe' : 'regenerate'));
    }
    for (const [direction, value] of [['left', 78], ['right', 80]]) {
        expected[person][rapport] = value;
        await checkpoint(`card2-branch-${direction}`, async target => {
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            await delay(500);
            await target.page.locator('#chat .mes').last().locator(`.swipe_${direction}`).click();
            await waitForStat(target.page, expected);
            await target.page.waitForFunction(async () => (await import('/script.js')).isSwipingAllowed());
            return panels(target);
        });
    }
    async function screenshot(target, name) {
        await target.page.locator('#chat').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await delay(300);
        assert.equal(await target.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await target.page.screenshot({
            path: fileURLToPath(new URL(`${target.side}-card2-${name}.png`, output)), fullPage: true });
    }
    for (const target of targets) await screenshot(target, 'desktop');
    const saved = await snapshot(targets[0]);
    setStage('card2-mobile-reload');
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        await target.page.evaluate(() => window.SillyTavern.getContext().saveChat());
        await delay(1500);
        await target.context.close();
        const replacement = await newTarget(target.side, target.base, target.credentials, true);
        replacement.avatar = target.avatar;
        targets[index] = replacement;
        await openChat(replacement);
        assert.deepEqual(await snapshot(replacement), saved);
        await connect(replacement);
    }
    await checkpoint('card2-N7-mobile-reload-panels', panels);
    expected[person][rapport] = 81;
    await checkpoint('card2-mobile-send', target => send(target, 'mobile-card2',
        [command('set', `${person}.${rapport}`, 80, 81)], expected, 'SMOKE mobile.'));
    for (const target of targets) await screenshot(target, 'mobile');
    async function fresh(target) {
        await target.page.evaluate(async () => (await import('/script.js')).doNewChat());
        await waitForStat(target.page, baseline);
        await panels(target);
    }
    await checkpoint('card2-N-new-chat', fresh);
    expected = structuredClone(baseline);
    for (let turn = 1; turn <= 3; turn++) {
        expected[person][rapport] = 30 + turn;
        await checkpoint(`card2-N-timing-${turn}`, async target => {
            const input = (turn === 1 ? '\u6f6e\u6c50 \u96fe\u53f7 ' : '') + '\u6362\u73ed\u949f \u8865\u7ed9\u8239';
            const result = await send(target, `timing-${turn}`,
                [command('set', `${person}.${rapport}`, 29 + turn, 30 + turn)], expected, input);
            assert.equal(result.active.negative, false);
            assert.equal(result.active.fog, false);
            assert.equal(result.active.tide, turn < 3);
            assert.equal(result.active.bell, true, 'cooldown=2 expires by the next full user/assistant round');
            assert.equal(result.active.supply, turn >= 3);
            return { ...result, timed: (await snapshot(target)).timed };
        });
    }
    await checkpoint('card2-N-recursion-fixture-config', async target => {
        await target.page.evaluate(async name => {
            const wi = await import('/scripts/world-info.js');
            const book = await wi.loadWorldInfo(name);
            book.entries[0].preventRecursion = false;
            await wi.saveWorldInfo(name, book, true);
        }, card.data.character_book.name);
        await fresh(target);
    });
    expected = structuredClone(baseline);
    expected[person][rapport] = 31;
    await checkpoint('card2-N-recursion-keeps-probability-and-delay', async target => {
        const result = await send(target, 'recursion', [command('set', `${person}.${rapport}`, 30, 31)],
            expected, 'SMOKE no trigger words.');
        assert.deepEqual(result.active, { room: true, fog: false, tide: true, bell: true, supply: false, negative: false });
        return result;
    });
    const dispatchCases = evidence.cases.filter(c => c.label.startsWith('card2-dispatch-'));
    for (const result of dispatchCases) for (const side of ['worker', 'original']) {
        const dispatch = result[side].dispatch.filter(event => event.name !== 'PREVIEW_STARTED');
        const received = dispatch.findIndex(event => event.name === 'MESSAGE_RECEIVED');
        const updates = dispatch.map((event, index) => ({ ...event, index }))
            .filter(event => event.name === 'MVU:VARIABLE_UPDATE_STARTED' && event.role === 'assistant');
        assert.equal(updates.length, 1, `${result.label}/${side}: assistant update dispatched more than once`);
        assert.ok(received >= 0 && received < updates[0].index, 'MVU update must start inside/after message reception dispatch');
    }
    assert.ok(isDeepStrictEqual((await snapshot(targets[0])).stat, expected));
    evidence.card2Scope = {
        authorOps: sourceOps.length, consumedOps, realModelFill: false, sourceLintReexecuted: false,
        cleanup: 'Unmodified defaults; floors 2/4 have no snapshot after 25 messages and show unavailable after reload',
        readonlyT6: 'soft rule only; no real model used',
        N4Correction: 'cooldown counts messages, not rounds',
        instructionSources: 'README and build.py reviewed as data; no external skill files executed',
    };
}
