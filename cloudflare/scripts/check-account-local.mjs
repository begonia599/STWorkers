import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import wrangler from 'wrangler';
import { lookup } from 'mime-types';
import { loginThroughPage } from './owner-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, '.build', process.argv.includes('--plugins') ? 'assets-p3' : 'assets');
const output = path.join(root, '.build', 'account-check', randomUUID());
const scriptPath = path.join(root, '.build', 'worker', 'index.js');
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const password = randomBytes(6).toString('base64url');
const changedPassword = randomBytes(4).toString('base64url');
const evidence = { scope: 'Isolated local workerd, real D1, original login/profile UI. No cloud deployment or real model.',
    passwordLengths: { bootstrap: password.length, changed: changedPassword.length },
    checks: [], screenshots: [], pageErrors: [], httpErrors: [], revokedRequests: [], outbound: [] };
const revokedCookies = new Set(), responseChecks = [];
const mark = value => { evidence.checks.push(value); console.log(`PASS: ${value}`); };
let runtime, browser, base;
await mkdir(output, { recursive: true });
try {
    evidence.workerSha256 = createHash('sha256').update(await readFile(scriptPath)).digest('hex');
    assert.equal(await readFile(path.join(assets, 'login.html'), 'utf8'),
        await readFile(path.join(root, '../public/login.html'), 'utf8'));
    assert.equal(await readFile(path.join(assets, 'scripts/login.js'), 'utf8'),
        await readFile(path.join(root, '../public/scripts/login.js'), 'utf8'));
    runtime = new Miniflare(convertV4MiniflareOptions({
        name: 'stworkers-account-check', modules: true, scriptPath,
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        host: '127.0.0.1', port: 0, d1Databases: ['DB'], r2Buckets: ['FILES'],
        bindings: { AUTH_PASSWORD: password, DATA_KEY: randomBytes(32).toString('base64') },
        outboundService: request => {
            assert.equal(request.headers.get('Cookie'), null);
            assert.equal(request.headers.get('X-CSRF-Token'), null);
            assert.equal(request.headers.get('Authorization'), null);
            evidence.outbound.push(new URL(request.url).pathname);
            if (new URL(request.url).origin !== 'https://synthetic-model.example') return new Response(null, { status: 502 });
            if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'account-fixture' }] });
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'Account test response.' }, finish_reason: 'stop' }] });
        },
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
    const db = await runtime.getD1Database('DB');
    for (const file of (await readdir(path.join(root, 'migrations'))).filter(file => file.endsWith('.sql')).sort()) {
        const sql = wrangler.unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8'));
        await db.batch(sql.map(statement => db.prepare(statement)));
    }
    // An old owner document exists before the first account is created.
    const bootstrap = JSON.parse(await readFile(path.join(assets, '__stworks/bootstrap.json'), 'utf8'));
    const settings = JSON.parse(bootstrap.settings);
    settings.firstRun = false;
    settings.__accountMigrationFixture = { unknown: [0, false, 'preserved'] };
    await db.prepare("INSERT INTO documents(kind,id,payload) VALUES ('settings','owner',?)").bind(JSON.stringify(settings)).run();
    base = (await runtime.ready).origin;
    assert.equal((await fetch(base + '/script.js')).status, 401);
    assert.equal((await fetch(base, { redirect: 'manual' })).status, 302);
    browser = await chromium.launch({ executablePath: process.argv[3], headless: true });

    async function pageFor(mobile) {
        const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            isMobile: mobile, hasTouch: mobile, locale: 'en-US', serviceWorkers: 'block',
        });
        const page = await context.newPage();
        page.on('pageerror', error => evidence.pageErrors.push(error.message));
        page.on('response', response => {
            if (response.status() < 400) return;
            responseChecks.push((async () => {
                const pathname = new URL(response.url()).pathname;
                if (['/api/users/login', '/api/users/logout'].includes(pathname)) return;
                if (response.status() === 401 && ['/api/settings/save', '/api/ping'].includes(pathname)) {
                    const cookies = (await response.request().allHeaders()).cookie?.split(';').map(value => value.trim()) ?? [];
                    if (cookies.some(value => revokedCookies.has(value))) {
                        evidence.revokedRequests.push({ path: pathname, status: 401, reason: 'known-revoked-cookie' });
                        return;
                    }
                }
                evidence.httpErrors.push({ path: pathname, status: response.status() });
            })());
        });
        return page;
    }
    async function screenshot(page, name) {
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        const file = path.join(output, `${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        evidence.screenshots.push(file);
    }
    async function appReady(page) {
        await page.waitForFunction(() => window.SillyTavern?.getContext && !document.querySelector('.splash-screen'), null, { timeout: 90000 });
        await page.waitForFunction(async () => (await import('/script.js')).settingsReady
            || document.querySelector('dialog[open] .onboarding'));
        if (await page.locator('dialog[open] .onboarding').isVisible()) {
            await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
        }
        await page.waitForFunction(async () => (await import('/script.js')).settingsReady);
        await page.waitForFunction(async () => (await import('/scripts/user.js')).currentUser?.handle === 'owner');
        if (process.argv.includes('--plugins')) {
            await page.waitForFunction(() => window.TavernHelper && window.EjsTemplate, null, { timeout: 90000 });
        }
    }
    async function post(page, route, body) {
        return page.evaluate(async ({ route, body }) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch(route, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            return { status: response.status, text: await response.text() };
        }, { route, body });
    }
    async function profile(page) {
        const dialogs = await page.locator('dialog[open]').allTextContents();
        if (dialogs.length) {
            evidence.unexpectedDialogs = dialogs.map(text => text.slice(0, 1500));
            await screenshot(page, 'before-profile');
            throw new Error('An unexpected open dialog blocked the profile; see screenshot and dialog text.');
        }
        const drawer = page.locator('#user-settings-button .drawer-icon');
        if (await drawer.evaluate(element => element.classList.contains('closedIcon'))) await drawer.click();
        await page.locator('#account_button').click();
        await page.locator('dialog[open] .userChangePasswordButton').waitFor();
        assert.equal(await page.locator('#admin_button').isVisible(), false);
        assert.equal(await page.evaluate(async () => (await import('/scripts/user.js')).isAdmin()), true);
    }
    const desktop = await pageFor(false);
    await desktop.goto(base, { waitUntil: 'domcontentloaded' });
    await desktop.waitForURL('**/login');
    await desktop.locator('#userList .userSelect').click();
    await screenshot(desktop, 'desktop-login');
    await desktop.locator('#userPassword').fill('wrong-password');
    await desktop.locator('#loginButton').click();
    await desktop.locator('#errorMessage').filter({ hasText: 'Incorrect handle or password.' }).waitFor();
    await loginThroughPage(desktop, base, password);
    await appReady(desktop);
    mark('Original desktop login page: redirect, wrong-password error, 8-character password login and account controls');
    assert.equal(await desktop.locator('#logout_button').isVisible(), false); // Its drawer is initially closed.
    const session = (await desktop.context().cookies()).find(cookie => cookie.name.endsWith('stworkers-session'));
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Strict');
    assert.ok(!(await desktop.evaluate(() => document.cookie)).includes('stworkers-session'));
    mark('HttpOnly session is invisible to page JS; cookie survives reload');
    const loaded = JSON.parse((await post(desktop, '/api/settings/get', {})).text);
    assert.deepEqual(JSON.parse(loaded.settings).__accountMigrationFixture, settings.__accountMigrationFixture);
    if (process.argv.includes('--plugins')) {
        await desktop.evaluate(async () => {
            window.TavernHelper.replaceVariables({ cookieAuthFixture: { kept: [0, false, 'ok'] } }, { type: 'global' });
            await (await import('/script.js')).saveSettings();
        });
    }
    const generation = await post(desktop, '/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom', custom_url: 'https://synthetic-model.example/v1', model: 'account-fixture',
        stream: false, messages: [{ role: 'user', content: 'Synthetic auth regression.' }],
    });
    assert.equal(generation.status, 200);
    assert.equal(JSON.parse(generation.text).choices[0].message.content, 'Account test response.');
    await desktop.reload({ waitUntil: 'domcontentloaded' });
    await appReady(desktop);
    mark('Old owner data, synthetic model generation and reload work after account migration');
    const mobile = await pageFor(true);
    await mobile.goto(base + '/login', { waitUntil: 'domcontentloaded' });
    await mobile.locator('#userList .userSelect').click();
    await screenshot(mobile, 'mobile-login');
    await loginThroughPage(mobile, base, password);
    await appReady(mobile);
    if (process.argv.includes('--plugins')) {
        assert.deepEqual(await mobile.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).cookieAuthFixture),
            { kept: [0, false, 'ok'] });
        mark('Helper/EJS load in desktop and fresh mobile sessions; real Helper variable survives');
    }
    const mobileSession = (await mobile.context().cookies()).find(cookie => cookie.name.endsWith('stworkers-session'));
    await profile(desktop);
    await desktop.locator('dialog[open] .userChangePasswordButton').click();
    const change = desktop.locator('dialog[open]').last();
    await change.locator('input[name="current"]').fill(password);
    await change.locator('input[name="password"]').fill(changedPassword);
    await change.locator('input[name="confirm"]').fill(changedPassword);
    for (const cookie of [session, mobileSession]) revokedCookies.add(`${cookie.name}=${cookie.value}`);
    const changed = desktop.waitForResponse(response => response.url().endsWith('/api/users/change-password'));
    await change.locator('.popup-button-ok').click();
    assert.equal((await changed).status(), 204);
    await desktop.getByText('Password changed successfully', { exact: true }).waitFor();
    await desktop.locator('dialog[open]').last().locator('.popup-button-ok').click();
    const newSession = (await desktop.context().cookies()).find(cookie => cookie.name.endsWith('stworkers-session'));
    assert.notEqual(newSession.value, session.value);
    for (const previous of [session, mobileSession]) {
        assert.equal((await fetch(base + '/api/users/me', { headers: { Cookie: `${previous.name}=${previous.value}` } })).status, 401);
    }
    assert.equal((await post(desktop, '/api/settings/get', {})).status, 200);
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    await mobile.waitForURL('**/login');
    mark('Original profile accepts a 6-character password, rotates current cookie and invalidates desktop replay and mobile session');
    await loginThroughPage(mobile, base, changedPassword);
    await appReady(mobile);
    await profile(mobile);
    await screenshot(mobile, 'mobile-profile');
    await mobile.locator('dialog[open]').last().locator('.popup-button-ok').click();
    const logoutSession = (await mobile.context().cookies()).find(cookie => cookie.name.endsWith('stworkers-session'));
    // A failed logout must not pretend to succeed.
    await mobile.route('**/api/users/logout', route => route.fulfill({ status: 503, body: 'Synthetic logout failure' }));
    await mobile.locator('#logout_button').click();
    await mobile.getByText('Logout failed', { exact: true }).waitFor();
    assert.equal(new URL(mobile.url()).pathname, '/');
    await mobile.unroute('**/api/users/logout');
    revokedCookies.add(`${logoutSession.name}=${logoutSession.value}`);
    await mobile.locator('#logout_button').click();
    await mobile.waitForURL(url => url.pathname === '/login' && url.searchParams.get('noauto') === 'true');
    assert.equal((await fetch(base + '/api/users/me')).status, 401);
    assert.equal((await fetch(base + '/api/users/me',
        { headers: { Cookie: `${logoutSession.name}=${logoutSession.value}` } })).status, 401);
    assert.equal((await post(desktop, '/api/settings/get', {})).status, 200);
    mark('Mobile login with new password; real logout, failed-logout error, noauto redirect and replay protection');
    await Promise.all(responseChecks);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.httpErrors, []);
    assert.ok(evidence.outbound.every(pathname => pathname.endsWith('/chat/completions')));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM stworkers_accounts').first()).n, 1);
    evidence.status = 'passed';
} catch (error) {
    evidence.status = 'failed';
    evidence.failure = { message: error.message, stack: error.stack };
    throw error;
} finally {
    await browser?.close();
    await runtime?.dispose();
    await writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${path.join(output, 'results.json')}`);
}
