import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { validatePluginPath, isPluginRuntimeFile, PLUGIN_BASELINES, readPinnedArchive, digest } from '../scripts/plugin-package.mjs';

test('plugin paths reject traversal, ambiguous Windows names and reserved paths', () => {
    for (const name of ['', '../secret', '/absolute', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\0b', 'C:/file',
        'a/b.', 'a/b ', 'a/CON', 'a/NUL.txt', 'a/COM1.js', 'a/file:stream', 'a/file?.js']) {
        assert.throws(() => validatePluginPath(name), name);
    }
    for (const name of ['manifest.json', 'dist/index.js', 'dist/@types.zip', 'i18n/zh-cn.json']) assert.equal(validatePluginPath(name), name);
});

test('plugin selection retains original runtime and licenses without build scripts or source maps', () => {
    for (const name of ['LICENSE', 'settings.html', 'dist/index.js', 'lib/jsoneditor.js', 'include/types.d.ts', 'locales/zh-cn.json']) {
        assert.equal(isPluginRuntimeFile(name), true, name);
    }
    for (const name of ['package.json', 'src/index.ts', '.github/workflows/build.yml', 'dist/index.js.map']) {
        assert.equal(isPluginRuntimeFile(name), false, name);
    }
});

test('only explicitly reviewed archives pass before any zip entry is processed', async () => {
    for (const baseline of PLUGIN_BASELINES) {
        assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
        assert.match(baseline.commit, /^[a-f0-9]{40}$/);
        await assert.rejects(readPinnedArchive(Buffer.from('not the reviewed plugin'), baseline), /checksum differs/);
    }
});

function syntheticArchive(files) {
    const bytes = Buffer.from(zipSync(files));
    return { bytes, baseline: { id: 'fixture', commit: 'commit', sha256: digest(bytes) } };
}

test('verified archives preserve selected bytes and omit build-time files', async () => {
    const archive = syntheticArchive({
        'fixture-commit/dist/index.js': Buffer.from('window.synthetic = true;'),
        'fixture-commit/LICENSE': Buffer.from('Synthetic license'),
        'fixture-commit/src/private.ts': Buffer.from('not deployed'),
        'fixture-commit/dist/index.js.map': Buffer.from('not deployed'),
    });
    const entries = await readPinnedArchive(archive.bytes, archive.baseline);
    assert.deepEqual(entries.map(entry => entry.name), ['dist/index.js', 'LICENSE']);
    assert.equal(entries[0].bytes.toString(), 'window.synthetic = true;');
});

test('verified zip entries still reject wrong roots, traversal and case collisions', async () => {
    for (const files of [
        { 'elsewhere/dist/index.js': Buffer.from('x') },
        { 'fixture-commit/../secret': Buffer.from('x') },
        { 'fixture-commit/dist/index.js': Buffer.from('x'), 'fixture-commit/dist/INDEX.js': Buffer.from('y') },
        { 'fixture-commit/dist/NUL.js': Buffer.from('x') },
    ]) {
        const archive = syntheticArchive(files);
        await assert.rejects(readPinnedArchive(archive.bytes, archive.baseline));
    }
});

test('verified archives reject Unix symlinks rather than following their target', async () => {
    const archive = syntheticArchive({
        'fixture-commit/dist/index.js': [Buffer.from('../../outside'), { os: 3, attrs: (0xa1ff << 16) >>> 0 }],
    });
    await assert.rejects(readPinnedArchive(archive.bytes, archive.baseline), /symlinks/);
});
