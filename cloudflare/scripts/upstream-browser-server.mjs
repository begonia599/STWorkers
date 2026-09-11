import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { copyPluginBundle } from './plugin-package.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const sourcePaths = ['package.json', 'server.js', 'webpack.config.js', 'src', 'public', 'default'];
const hash = value => createHash('sha256').update(value).digest('hex');

export async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
        child.kill('SIGTERM');
    }
    await Promise.race([exited, delay(5000).then(() => {
        if (child.exitCode === null && !child.signalCode) throw new Error('Test child did not exit.');
    })]);
}

export async function startUpstreamBrowserServer(port, { pluginBundle } = {}) {
    const root = await realpath(project);
    const build = path.join(root, 'cloudflare', '.build');
    await mkdir(build, { recursive: true });
    assert.equal(await realpath(build), build, 'Reference build root must not be a link.');
    const runRoot = await mkdtemp(path.join(build, 'upstream-browser-'));
    const source = path.join(runRoot, 'source');
    const data = path.join(runRoot, 'data');
    await mkdir(source);
    await mkdir(data);
    const { sillytavern } = JSON.parse(await readFile(path.join(root, 'upstream-lock.json'), 'utf8'));
    assert.match(sillytavern.commit, /^[a-f0-9]{40}$/);
    const archive = path.join(runRoot, 'source.tar');
    // Git objects, not the working tree: ignored extensions, private config and user data never enter the reference.
    execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--output=${archive}`, sillytavern.commit, ...sourcePaths], { cwd: root });
    execFileSync('tar', ['-xf', archive, '-C', source], { windowsHide: true });
    const verified = {};
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', sillytavern.commit, ...sourcePaths], { cwd: root, encoding: 'utf8' })
        .trim().split('\n');
    for (const name of files) {
        const filename = path.join(source, name);
        assert.equal(await realpath(filename), filename, `Linked reference source: ${name}`);
    }
    for (const name of ['server.js', 'public/script.js', 'public/scripts/openai.js',
        'public/scripts/tokenizers.js', 'public/scripts/variables.js', 'public/scripts/world-info.js']) {
        const expected = execFileSync('git', ['show', `${sillytavern.commit}:${name}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
        const actual = await readFile(path.join(source, name));
        assert.equal(hash(actual), hash(expected), `Reference bytes differ: ${name}`);
        verified[name] = hash(actual);
    }
    const plugins = pluginBundle ? (await copyPluginBundle(pluginBundle, path.join(source, 'public'))).plugins : [];
    const password = randomUUID();
    const config = parse(await readFile(path.join(source, 'default', 'config.yaml'), 'utf8'));
    Object.assign(config, {
        dataRoot: data, port, listen: true, listenAddress: { ipv4: '127.0.0.1', ipv6: '[::1]' },
        protocol: { ipv4: true, ipv6: false }, basicAuthMode: true,
        basicAuthUser: { username: 'reference', password }, whitelistMode: true,
        whitelist: ['127.0.0.1', '::1'], whitelistDockerHosts: false,
        enableUserAccounts: false, enableServerPlugins: false, enableCorsProxy: false,
        enableDownloadableTokenizers: false, disableCsrfProtection: false,
    });
    config.browserLaunch.enabled = false;
    config.extensions.autoUpdate = false;
    config.extensions.models.autoDownload = false;
    const configPath = path.join(runRoot, 'config.yaml');
    await writeFile(configPath, stringify(config));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [path.join(source, 'server.js'), '--configPath', configPath], {
        cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SILLYTAVERN_PROMPTPLACEHOLDER: config.promptPlaceholder },
    });
    let diagnostics = '', launchError;
    child.on('error', error => { launchError = error; });
    const capture = chunk => { diagnostics = (diagnostics + chunk.toString().replaceAll(password, '[redacted]')).slice(-12000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const authorization = `Basic ${Buffer.from(`reference:${password}`).toString('base64')}`;
    try {
        let ready = false;
        for (let i = 0; i < 240; i++) {
            if (launchError) throw launchError;
            if (child.exitCode !== null) throw new Error(`Original ST exited: ${diagnostics}`);
            try {
                const response = await fetch(`${base}/csrf-token`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(1000) });
                if (response.ok) { ready = true; break; }
            } catch { /* Original frontend libraries are compiling. */ }
            await delay(500);
        }
        assert.ok(ready, `Original ST startup timed out: ${diagnostics}`);
        assert.equal((await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })).status, 401);
        return {
            base, credentials: { username: 'reference', password },
            evidence: { commit: sillytavern.commit, verified, exportedFiles: files.length,
                source: path.relative(root, source), data: path.relative(root, data),
                frontendModified: false, tokenizersMocked: false, csrf: true, loopbackAuthenticated: true, plugins },
            close: () => stopChild(child),
        };
    } catch (error) {
        await stopChild(child);
        throw error;
    }
}
