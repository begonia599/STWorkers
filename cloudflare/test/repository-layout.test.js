import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const git = args => execFileSync('git', args, {
    cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
});
const normalize = value => value.replaceAll('\r\n', '\n');

test('the tracked root omits retired platform tools and local-only directories', () => {
    const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
    const retired = new Set([
        '.dockerignore', '.nomedia', '.replit', 'Dockerfile', 'Remote-Link.cmd',
        'Start.bat', 'UpdateAndStart.bat', 'UpdateForkAndStart.bat',
        'plugins.js', 'recover.js', 'replit.nix', 'start.sh',
        'CONTRIBUTING.md', 'SECURITY.md', 'Update-Instructions.txt',
    ]);
    const directories = ['docker/', 'colab/', '.vscode/', '.gemini/', 'backups/', 'data/', 'plugins/'];
    assert.deepEqual(tracked.filter(file => retired.has(file)
        || directories.some(directory => file.startsWith(directory))), []);
    for (const file of ['.vscode/extensions.json', '.gemini/config.yaml',
        'backups/local.json', 'data/local.json', 'plugins/local/index.js']) {
        assert.ok(git(['check-ignore', '--no-index', file]).trim(), file);
    }
});

test('deployment entries and explicit upstream comparison sources remain available', async () => {
    for (const file of ['README.md', 'LICENSE', 'AGENTS.md', 'wrangler.jsonc', '.dev.vars.example',
        '.node-version', '.npmrc', 'package.json', 'package-lock.json', 'plugins.txt',
        'plugins.lock.json', 'upstream-lock.json', 'public/index.html', 'public/login.html',
        'default/config.yaml', 'cloudflare/src/index.js', 'server.js', 'webpack.config.js',
        'src/prompt-converters.js', 'src/util.js', 'src/endpoints/backends/chat-completions.js']) {
        assert.ok((await stat(new URL(file, root))).isFile(), file);
    }
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    assert.equal(pkg.scripts.start, 'npm --prefix cloudflare run dev');
    assert.equal(pkg.scripts.build, 'node cloudflare/scripts/build-entry.mjs');
    assert.equal(pkg.scripts.deploy, 'node cloudflare/scripts/native-cloud.mjs deploy');
    assert.equal(pkg.scripts['start:upstream'], 'node server.js');
    for (const name of ['init', 'debug', 'start:global', 'start:electron', 'start:deno',
        'start:bun', 'start:no-csrf', 'plugins:update', 'plugins:install']) {
        assert.equal(Object.hasOwn(pkg.scripts, name), false, name);
    }
    const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
    assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
    assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
});

test('relocated upstream guides and security policy preserve their original contents', async () => {
    const lock = JSON.parse(await readFile(new URL('upstream-lock.json', root), 'utf8'));
    const index = await readFile(new URL('docs/UPSTREAM.md', root), 'utf8');
    for (const [original, archived] of [
        ['CONTRIBUTING.md', 'UPSTREAM-CONTRIBUTING.md'],
        ['SECURITY.md', 'SECURITY.md'],
        ['Update-Instructions.txt', 'UPSTREAM-UPDATE.txt'],
    ]) {
        const pinned = git(['show', `${lock.sillytavern.commit}:${original}`]);
        const moved = await readFile(new URL(`docs/${archived}`, root), 'utf8');
        assert.equal(normalize(moved), normalize(pinned), archived);
        assert.ok(index.includes(`](${archived})`), archived);
    }
});
