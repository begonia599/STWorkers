import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import wrangler from 'wrangler';
import { lookup } from 'mime-types';
import { zipSync } from 'fflate';
import { copyPluginBundle, digest, packagePlugins, PLUGIN_BASELINES, readPinnedArchive } from './plugin-package.mjs';
import { preparePluginSelection } from './plugin-list.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let assets = path.join(root, '.build', 'assets-p3');
const output = path.join(root, '.build', 'actions-check', randomUUID());
const require = createRequire(process.argv[2] ?? new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const password = randomBytes(36).toString('base64url');
const withFixture = process.argv[4] === '--with-list-fixture';
const selected = [...PLUGIN_BASELINES];
const headers = { Authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}` };
const evidence = { scope: 'Local Actions build output in isolated workerd/D1/R2. Not a GitHub-hosted or cloud deployment test.',
    startedAt: new Date().toISOString(), checks: [], workerOutbound: [], pageErrors: [], httpErrors: [],
    pluginManagementRequests: [], screenshots: [] };
let runtime, browser, base;
await mkdir(output, { recursive: true });

try {
    if (withFixture) {
        const commit = 'a'.repeat(40), id = 'list-fixture', repository = `example/${id}`;
        const source = {
            'manifest.json': JSON.stringify({ display_name: 'Synthetic List Fixture', version: '1',
                js: 'index.js', css: 'style.css', loading_order: 100, requires: [], optional: [] }),
            'index.js': 'import { value } from "./nested/value.js";\n'
                + 'const text = await (await fetch(new URL("./templates/panel.html", import.meta.url))).text();\n'
                + 'window.STWorkersListFixture = { value, text };\n',
            'nested/value.js': 'export const value = "loaded-from-list";',
            'templates/panel.html': '<span>synthetic-template</span>',
            'style.css': ':root { --stworkers-list-fixture: 1; }',
            'LICENSE': 'Synthetic test fixture; no external plugin source.',
        };
        const bytes = zipSync(Object.fromEntries(Object.entries(source).map(([name, value]) =>
            [`${id}-${commit}/${name}`, Buffer.from(value)])), { mtime: new Date('2020-01-01T00:00:00Z') });
        const prepared = await preparePluginSelection(`https://github.com/${repository}#${commit}`,
            { schema: 1, plugins: [] }, { fetchImpl: async url => {
                assert.equal(url, `https://codeload.github.com/${repository}/zip/${commit}`);
                return new Response(bytes);
            } });
        assert.equal(await realpath(output), output);
        const isolated = path.join(output, 'assets');
        await cp(assets, isolated, { recursive: true, errorOnExist: true, force: false });
        assets = isolated;
        const plugin = prepared.lock.plugins[0];
        await writeFile(path.join(output, plugin.archive), prepared.archives.get(id), { flag: 'wx' });
        const bundle = path.join(output, 'bundle');
        await packagePlugins(output, bundle, null, prepared.lock.plugins);
        const copied = await copyPluginBundle(path.join(bundle, 'bundle.json'), assets);
        const bootstrapFile = path.join(assets, '__stworks', 'bootstrap.json');
        const bootstrap = JSON.parse(await readFile(bootstrapFile, 'utf8'));
        bootstrap.stworks.extensions.push(...copied.plugins);
        await writeFile(bootstrapFile, JSON.stringify(bootstrap));
        selected.push(plugin);
        evidence.checks.push('Synthetic third plugin prepared from a list URL in an isolated copy; production list, lock and assets unchanged');
    }
    const scriptPath = path.join(root, '.build', 'actions', 'worker', 'index.js');
    evidence.workerSha256 = digest(await readFile(scriptPath));
    runtime = new Miniflare(convertV4MiniflareOptions({
        name: 'stworkers-actions-local', modules: true, scriptPath,
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        host: '127.0.0.1', port: 0, d1Databases: ['DB'], r2Buckets: ['FILES'],
        bindings: { AUTH_PASSWORD: password, DATA_KEY: randomBytes(32).toString('base64') },
        outboundService: request => {
            evidence.workerOutbound.push(request.url);
            return new Response('Unexpected Worker network request in prebundled verification.', { status: 502 });
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
    const database = await runtime.getD1Database('DB');
    for (const file of (await readdir(path.join(root, 'migrations'))).filter(file => file.endsWith('.sql')).sort()) {
        const statements = wrangler.unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8'));
        await database.batch(statements.map(sql => database.prepare(sql)));
    }
    base = (await runtime.ready).origin;
    assert.equal((await fetch(base)).status, 401);
    const discovered = await (await fetch(base + '/api/extensions/discover', { headers })).json();
    for (const plugin of selected) {
        const prefix = `/scripts/extensions/third-party/${plugin.id}/`;
        assert.ok(discovered.some(item => item.name === `third-party/${plugin.id}` && item.commit === plugin.commit));
        const source = await readFile(path.join(assets, prefix, '__source.zip'));
        assert.equal(digest(source), plugin.sha256);
        const original = await readPinnedArchive(source, plugin);
        const manifest = JSON.parse(original.find(file => file.name === 'manifest.json').bytes.toString());
        for (const file of ['manifest.json', '__source.zip', manifest.js, ...(manifest.css ? [manifest.css] : [])]) {
            assert.equal((await fetch(base + prefix + file)).status, 401);
            const response = await fetch(base + prefix + file, { headers });
            assert.equal(response.status, 200);
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(digest(bytes), file === '__source.zip' ? plugin.sha256 : digest(original.find(item => item.name === file).bytes));
        }
        evidence.checks.push(`${plugin.id}: original manifest, JS/CSS and source bytes through authenticated bundled paths`);
    }
    browser = await chromium.launch({ executablePath: process.argv[3], headless: true });
    async function pageFor(mobile) {
        const context = await browser.newContext({
            httpCredentials: { username: 'owner', password, origin: base }, locale: 'en-US', serviceWorkers: 'block',
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            ...(mobile ? { isMobile: true, hasTouch: true } : {}),
        });
        const page = await context.newPage();
        page.on('pageerror', error => evidence.pageErrors.push(error.message));
        page.on('response', response => {
            if (response.status() >= 400) evidence.httpErrors.push({ url: response.url(), status: response.status() });
        });
        page.on('request', request => {
            if (/\/api\/extensions\/(?:install|update|switch)/.test(request.url())) evidence.pluginManagementRequests.push(request.url());
        });
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction(() => window.TavernHelper && window.EjsTemplate
            && window.SillyTavern?.getContext && !document.querySelector('.splash-screen'), null, { timeout: 90000 });
        if (withFixture) {
            await page.waitForFunction(() => window.STWorkersListFixture, null, { timeout: 30000 });
            assert.deepEqual(await page.evaluate(() => window.STWorkersListFixture),
                { value: 'loaded-from-list', text: '<span>synthetic-template</span>' });
            assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement)
                .getPropertyValue('--stworkers-list-fixture').trim()), '1');
            evidence.checks.push(`${mobile ? 'Mobile' : 'Desktop'}: third-plugin root module, nested import, HTML template and CSS loaded`);
        }
        if (!mobile) {
            await page.getByText('Welcome to SillyTavern!', { exact: true }).waitFor();
            await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
            await page.getByText('Welcome to SillyTavern!', { exact: true }).waitFor({ state: 'hidden' });
        }
        return page;
    }
    const desktop = await pageFor(false);
    await desktop.evaluate(async () => {
        window.TavernHelper.replaceVariables({ actionsPrebundle: { retained: [false, 0, 'ok'] } }, { type: 'global' });
        await (await import('/script.js')).saveSettings();
    });
    await desktop.reload({ waitUntil: 'domcontentloaded' });
    await desktop.waitForFunction(() => window.TavernHelper && window.EjsTemplate);
    assert.deepEqual(await desktop.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).actionsPrebundle),
        { retained: [false, 0, 'ok'] });
    evidence.checks.push('Desktop loads both prebundled plugins without installing and retains a synthetic Helper variable after reload');
    const mobile = await pageFor(true);
    assert.deepEqual(await mobile.evaluate(() => window.TavernHelper.getVariables({ type: 'global' }).actionsPrebundle),
        { retained: [false, 0, 'ok'] });
    evidence.checks.push('Fresh mobile context loads both plugins and the saved synthetic variable');
    for (const [name, page] of [['desktop', desktop], ['mobile', mobile]]) {
        const icon = page.locator('#extensions-settings-button .drawer-icon');
        if (await icon.evaluate(element => element.classList.contains('closedIcon'))) await icon.click();
        await page.locator('#third_party_extension_button').waitFor({ state: 'visible' });
        await page.locator('#rm_extensions_block.openDrawer').waitFor({ state: 'visible' });
        await page.locator('#rm_extensions_block').evaluate(element =>
            Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
        await page.waitForFunction(() => !document.querySelector('.splash-screen'));
        const image = path.join(output, `${name}.png`);
        await page.screenshot({ path: image, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        evidence.screenshots.push(image);
    }
    assert.deepEqual(evidence.workerOutbound, []);
    assert.deepEqual(evidence.pluginManagementRequests, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.httpErrors, []);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM documents WHERE kind = 'extension'").first()).count, 0);
    assert.equal((await (await runtime.getR2Bucket('FILES')).list()).objects.length, 0);
    evidence.checks.push('No online install/update requests, no Worker outbound downloads, no R2 objects or extension archive records');
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
