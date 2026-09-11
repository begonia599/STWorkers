import assert from 'node:assert/strict';
import { ownerClient, ownerStorageState } from './owner-client.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import wrangler from 'wrangler';
import { lookup } from 'mime-types';
import { zipSync, strToU8 } from 'fflate';
import { PLUGIN_BASELINES } from './plugin-package.mjs';

const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, '.build', 'assets');
const output = path.join(root, '.build', 'p4', randomUUID());
const archiveReplay = process.argv[4];
const downloadMode = archiveReplay ? 'local-pinned-archive-replay' : 'live-public-network';
const password = randomBytes(36).toString('base64url');
const fixture = { project: 'stworkers-fixture/p4-ui', head: '1'.repeat(40) };
const fixtureUrl = `https://github.com/${fixture.project}`;
const failedDeleteStage = 'A rejected delete stays visible and does not report success or reload';
const evidence = { startedAt: new Date().toISOString(), scope: 'Isolated local workerd, D1 and R2; not a cloud or free-plan performance test.',
    downloadMode, checkpoints: [], network: [], apiResponses: [], pageErrors: [], consoleErrors: [], httpErrors: [], screenshots: [] };
let runtime, browser, page, base, db, owner, stage = 'start';
const mark = name => { stage = name; evidence.checkpoints.push(name); console.log(name); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixtureArchive(commit) {
    const version = commit.startsWith('1') ? '1' : '2';
    // Crosses a native workerd inflate growth boundary with a partial final chunk.
    const script = `window.P4UiVersion = ${JSON.stringify(version)};`.padEnd(81921, ' ');
    return zipSync({
        'p4-ui/manifest.json': strToU8(JSON.stringify({ display_name: 'P4 UI Fixture', version, loading_order: 500,
            requires: [], optional: [], js: 'index.js', author: 'Synthetic' })),
        'p4-ui/index.js': strToU8(script),
        'p4-ui/LICENSE': strToU8('Synthetic test fixture.'),
    });
}
async function outbound(request) {
    const url = new URL(request.url);
    assert.equal(request.headers.get('Authorization'), null, 'Owner credentials must not leave the Worker.');
    assert.equal(request.headers.get('Cookie'), null);
    assert.equal(request.method, 'GET');
    if (url.pathname.includes(fixture.project)) {
        if (url.hostname === 'codeload.github.com') return new Response(fixtureArchive(url.pathname.split('/').at(-1)));
        if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: fixture.head } });
        if (url.pathname.endsWith('/branches')) return Response.json([{ name: 'main', commit: { sha: fixture.head } }]);
        return Response.json({ default_branch: 'main', private: false });
    }
    const plugin = PLUGIN_BASELINES.find(item => url.pathname.includes(item.repository));
    assert.ok(plugin && ['api.github.com', 'codeload.github.com'].includes(url.hostname), `Unexpected Worker outbound request: ${url.href}`);
    if (archiveReplay) {
        assert.ok(url.pathname.endsWith('/' + plugin.commit));
        const bytes = url.hostname === 'codeload.github.com'
            ? await readFile(path.join(archiveReplay, plugin.id, '__source.zip'))
            : strToU8(JSON.stringify({ sha: plugin.commit }));
        if (url.hostname === 'codeload.github.com') assert.equal(hash(bytes), plugin.sha256);
        evidence.network.push({ url: url.href, status: 200, bytes: bytes.byteLength, sha256: hash(bytes), mode: downloadMode });
        return new Response(bytes);
    }
    const attempt = { url: url.href, mode: 'live-public-network' };
    evidence.network.push(attempt);
    let response;
    try {
        response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'STWorkers-P4-local-verification' },
            signal: AbortSignal.timeout(90000) });
    } catch (error) {
        attempt.error = error.message;
        attempt.cause = error.cause?.message;
        throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const record = { url: url.href, status: response.status, bytes: bytes.byteLength, sha256: hash(bytes), mode: 'live-public-network' };
    Object.assign(attempt, record);
    if (url.hostname === 'codeload.github.com' && response.ok) assert.equal(record.sha256, plugin.sha256, 'The pinned upstream archive hash changed.');
    return new Response(bytes, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        ...(response.headers.has('X-RateLimit-Remaining') ? { 'X-RateLimit-Remaining': response.headers.get('X-RateLimit-Remaining') } : {}),
    } });
}
async function send(route, data) {
    const headers = owner.headers;
    if (data === undefined) return fetch(base + route, { headers });
    const { token } = await (await fetch(base + '/csrf-token', { headers })).json();
    return fetch(base + route, { method: 'POST',
        headers: { ...headers, Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
async function api(route, data) {
    const response = await send('/api/extensions/' + route, data);
    assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
    return response;
}
async function newPage(mobile = false) {
    const context = await browser.newContext({ storageState: await ownerStorageState(base, password),
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        locale: 'en-US', serviceWorkers: 'block', isMobile: mobile, hasTouch: mobile });
    const target = await context.newPage();
    target.setDefaultTimeout(30000);
    target.on('pageerror', error => evidence.pageErrors.push({ stage, message: error.message }));
    target.on('console', message => {
        if (message.type() === 'error') evidence.consoleErrors.push({ stage, text: message.text().slice(0, 500), location: message.location() });
    });
    target.on('response', response => {
        if (response.status() >= 400) evidence.httpErrors.push({ stage, url: response.url(), status: response.status() });
        if (response.url().startsWith(base + '/api/extensions/')) evidence.apiResponses.push({
            stage, url: response.url(), status: response.status(), body: response.request().postData(),
        });
    });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base || ['testingcf.jsdelivr.net', 'gitlab.com', 'cdn.jsdelivr.net'].includes(url.hostname)) return route.continue();
        evidence.httpErrors.push({ stage, url: url.href, blocked: true });
        return route.abort('blockedbyclient');
    });
    await target.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await target.waitForFunction(() => window.SillyTavern?.getContext && !document.querySelector('.splash-screen'));
    if (!mobile) {
        await target.getByText('Welcome to SillyTavern!', { exact: true }).waitFor();
        await target.locator('dialog[open]').last().locator('.popup-button-ok').click();
        await target.getByText('Welcome to SillyTavern!', { exact: true }).waitFor({ state: 'hidden' });
    }
    return target;
}
async function openExtensions(target) {
    const icon = target.locator('#extensions-settings-button .drawer-icon');
    if (await icon.evaluate(element => element.classList.contains('closedIcon'))) await icon.click();
    await target.locator('#third_party_extension_button').waitFor({ state: 'visible' });
}
async function installUi(target, url, ref = '') {
    await openExtensions(target);
    await target.locator('#third_party_extension_button').click();
    const dialog = target.locator('dialog[open]').last();
    await dialog.locator('.popup-input').fill(url);
    await dialog.locator('#extension_branch_name').fill(ref);
    await dialog.locator('.popup-button-ok').click();
    await target.getByText('Install a third-party extension?', { exact: true }).waitFor();
    const pending = target.waitForResponse(response => response.url() === base + '/api/extensions/install', { timeout: 120000 });
    await target.getByRole('button', { name: 'Yes, install it', exact: true }).click();
    const installed = await pending;
    assert.ok(installed.ok(), `Install failed: ${installed.status()} ${await installed.text()}`);
    await target.waitForFunction(name => document.querySelector(`script[src="/scripts/extensions/third-party/${name}/index.js"]`)
        || document.querySelector(`script[src="/scripts/extensions/third-party/${name}/dist/index.js"]`), url.split('/').at(-1), { timeout: 90000 });
}
async function manage(target) {
    await openExtensions(target);
    await target.locator('#extensions_details').click();
    await target.locator('.extensions_info').waitFor();
}
async function screenshot(target, name) {
    await target.waitForFunction(() => !document.querySelector('dialog[opening], dialog[closing]'));
    const file = path.join(output, name + '.png');
    await target.screenshot({ path: file, fullPage: true });
    evidence.screenshots.push(file);
}
try {
    await mkdir(output, { recursive: true });
    evidence.bundleSha256 = hash(await readFile(path.join(root, '.build/worker/index.js')));
    runtime = new Miniflare(convertV4MiniflareOptions({
        name: 'stworkers-p4-verification', modules: true, scriptPath: path.join(root, '.build/worker/index.js'),
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        host: '127.0.0.1', port: 0, d1Databases: ['DB'], r2Buckets: ['FILES'],
        bindings: { AUTH_PASSWORD: password, DATA_KEY: randomBytes(32).toString('base64') },
        outboundService: outbound,
        serviceBindings: { ASSETS: async request => {
            let file;
            try { file = path.resolve(assets, '.' + decodeURIComponent(new URL(request.url).pathname)); }
            catch { return new Response(null, { status: 400 }); }
            if (!file.startsWith(assets + path.sep)) return new Response(null, { status: 404 });
            try { return new Response(request.method === 'HEAD' ? null : await readFile(file),
                { headers: { 'Content-Type': lookup(file) || 'application/octet-stream' } }); }
            catch { return new Response(null, { status: 404 }); }
        } },
    }));
    db = await runtime.getD1Database('DB');
    for (const name of (await readdir(path.join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
        await db.batch(wrangler.unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    base = (await runtime.ready).origin;
    owner = await ownerClient(base, password);
    assert.equal((await fetch(base + '/api/extensions/discover')).status, 401);
    assert.equal((await (await api('discover')).json()).filter(item => item.name.startsWith('third-party/')).length, 0);
    browser = await chromium.launch({ executablePath: process.argv[3], headless: true });
    page = await newPage();
    for (const plugin of PLUGIN_BASELINES) {
        mark(`Install ${plugin.id} through the original dialog (${downloadMode})`);
        await installUi(page, `https://github.com/${plugin.repository}`, plugin.commit);
        await page.waitForFunction(id => id === 'JS-Slash-Runner' ? Boolean(window.TavernHelper) : Boolean(window.EjsTemplate),
            plugin.id, { timeout: 90000 });
        const version = await (await api('version', { extensionName: plugin.id })).json();
        assert.equal(version.currentCommitHash, plugin.commit);
        assert.equal(version.currentBranchName, '');
        const source = new Uint8Array(await (await send(`/scripts/extensions/third-party/${plugin.id}/__source.zip`)).arrayBuffer());
        assert.equal(hash(source), plugin.sha256);
        assert.equal((await (await api('update', { extensionName: plugin.id })).json()).isUpToDate, true);
    }
    mark('Install a synthetic moving-branch fixture through the original dialog');
    await installUi(page, fixtureUrl);
    await page.waitForFunction(() => window.P4UiVersion === '1');
    await page.evaluate(async () => {
        window.TavernHelper.replaceVariables({ p4RoundTrip: { retained: [0, false, 'ok'] } }, { type: 'global' });
        await (await import('/script.js')).saveSettings();
    });
    fixture.head = '2'.repeat(40);
    await manage(page);
    const update = page.locator('.extension_block[data-name="/p4-ui"] .btn_update');
    await update.waitFor({ state: 'visible' });
    mark('Update moving branch using the original update button');
    await update.click();
    await page.waitForFunction(async () => (await (await fetch('/scripts/extensions/third-party/p4-ui/manifest.json')).json()).version === '2');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.P4UiVersion === '2' && !!window.TavernHelper && !!window.EjsTemplate);
    assert.deepEqual(await page.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).p4RoundTrip), { retained: [0, false, 'ok'] });
    await manage(page);
    await page.locator('.extension_block[data-name="/p4-ui"] .btn_rollback').waitFor({ state: 'visible' });
    await screenshot(page, 'desktop-management');
    mark('Restore previous version using the rollback button');
    await page.locator('.extension_block[data-name="/p4-ui"] .btn_rollback').click();
    await page.getByText('Restore previous extension version?', { exact: true }).waitFor();
    const rolledBack = page.waitForResponse(response => response.url() === base + '/api/extensions/rollback');
    const rollbackReload = page.waitForEvent('domcontentloaded');
    await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
    assert.equal((await rolledBack).status(), 200);
    await rollbackReload;
    await page.waitForFunction(() => window.P4UiVersion === '1' && !!window.TavernHelper, null, { timeout: 90000 });
    assert.equal((await (await send('/scripts/extensions/third-party/p4-ui/manifest.json')).json()).version, '1');
    mark('Fresh mobile browser restores installed plugins, code and saved variables');
    const mobile = await newPage(true);
    await mobile.waitForFunction(() => window.P4UiVersion === '1' && !!window.TavernHelper && !!window.EjsTemplate);
    assert.deepEqual(await mobile.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).p4RoundTrip), { retained: [0, false, 'ok'] });
    await manage(mobile);
    await mobile.locator('.extension_block[data-name="/p4-ui"] .btn_rollback').waitFor({ state: 'visible' });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    await screenshot(mobile, 'mobile-management');
    mark(failedDeleteStage);
    let navigations = 0;
    mobile.on('framenavigated', frame => { if (frame === mobile.mainFrame()) navigations++; });
    await mobile.route(base + '/api/extensions/delete', route => route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'P4_INJECTED_FAILURE', message: 'Synthetic deletion failure.' } }) }));
    await mobile.locator('.extension_block[data-name="/p4-ui"] .btn_delete').click();
    await mobile.getByText('Are you sure you want to delete /p4-ui?', { exact: true }).waitFor();
    await mobile.locator('dialog[open]').last().locator('.popup-button-ok').click();
    await mobile.getByText('Extension deletion failed', { exact: true }).waitFor();
    assert.equal((await send('/scripts/extensions/third-party/p4-ui/manifest.json')).status, 200);
    assert.equal(await mobile.evaluate(() => window.P4UiVersion), '1');
    assert.equal(navigations, 0);
    assert.equal(await mobile.locator('.toast-success').count(), 0);
    await mobile.unroute(base + '/api/extensions/delete');
    mark('Delete through the original confirmation flow, then verify persistent absence');
    await mobile.locator('.extension_block[data-name="/p4-ui"] .btn_delete').click();
    await mobile.getByText('Are you sure you want to delete /p4-ui?', { exact: true }).waitFor();
    const deleted = mobile.waitForResponse(response => response.url() === base + '/api/extensions/delete');
    const deleteReload = mobile.waitForEvent('domcontentloaded');
    await mobile.locator('dialog[open]').last().locator('.popup-button-ok').click();
    assert.equal((await deleted).status(), 200);
    await deleteReload;
    await mobile.waitForFunction(() => !!window.TavernHelper && !!window.EjsTemplate, null, { timeout: 90000 });
    assert.equal((await send('/scripts/extensions/third-party/p4-ui/manifest.json')).status, 404);
    assert.equal(await mobile.evaluate(() => typeof window.P4UiVersion), 'undefined');
    assert.deepEqual(await mobile.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).p4RoundTrip), { retained: [0, false, 'ok'] });
    assert.deepEqual(evidence.pageErrors, []);
    const expectedHttpError = item => item.stage === failedDeleteStage && item.status === 503
        && item.url === base + '/api/extensions/delete';
    assert.equal(evidence.httpErrors.filter(expectedHttpError).length, 1);
    assert.deepEqual(evidence.httpErrors.filter(item => !expectedHttpError(item)), []);
    assert.deepEqual(evidence.consoleErrors.filter(item => !(item.stage === failedDeleteStage
        && item.location.url === base + '/api/extensions/delete'
        && /^Failed to load resource: the server responded with a status of 503 \([^)]+\)$/.test(item.text))), []);
    evidence.status = 'passed';
} catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, message: error.message, stack: error.stack };
    if (page) evidence.failureState = await page.evaluate(async () => ({
        fixture: window.P4UiVersion, helper: !!window.TavernHelper, ejs: !!window.EjsTemplate,
        fixtureManifest: await (await fetch('/scripts/extensions/third-party/p4-ui/manifest.json')).text(),
        scripts: [...document.scripts].map(script => script.src).filter(url => url.includes('third-party')),
    })).catch(() => null);
    if (page) await screenshot(page, 'failure').catch(() => {});
    throw error;
} finally {
    await browser?.close();
    await runtime?.dispose();
    await writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${path.join(output, 'results.json')}`);
}
