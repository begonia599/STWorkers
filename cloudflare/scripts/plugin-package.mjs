import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

export const PLUGIN_BASELINES = Object.freeze([
    { id: 'JS-Slash-Runner', repository: 'N0VI028/JS-Slash-Runner', version: '4.9.5',
        commit: '8e0f4324e7d051025a333831411f03bd3145fac8', archive: 'helper.zip', license: 'AFPL-9',
        sha256: 'be7919088b9fdb0edf0544b683cdc23895823a463c7a8b36536ad517bdc5c07a' },
    { id: 'ST-Prompt-Template', repository: 'zonde306/ST-Prompt-Template', version: '1.17.9',
        commit: 'd6f520d149aba146305b0b781ddd691d449c28d2', archive: 'ejs.zip', license: 'AGPL-3.0',
        sha256: '1a866075e0bf7499f4fb0c39e5e763077aeddfee851624b4464289176943546b' },
]);
export const MAX_PLUGIN_FILE = 25 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_PLUGINS = 32;

export function validatePluginRecord(plugin) {
    assert.ok(plugin && typeof plugin === 'object', 'Invalid plugin lock entry.');
    assert.match(plugin.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/);
    assert.equal(plugin.id, plugin.repository.split('/')[1], 'Plugin folder must match repository name.');
    validatePluginPath(plugin.id);
    assert.match(plugin.commit, /^[a-f0-9]{40}$/);
    assert.match(plugin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(['legacy', 'runtime'].includes(plugin.layout ?? 'legacy'), 'Unknown plugin packaging layout.');
    assert.ok(typeof plugin.archive === 'string' && !plugin.archive.includes('/') && plugin.archive.endsWith('.zip'));
    validatePluginPath(plugin.archive);
    for (const field of ['version', 'license']) {
        assert.ok(typeof plugin[field] === 'string' && plugin[field].length > 0 && plugin[field].length <= 160
            && !/[\x00-\x1f\x7f]/.test(plugin[field]), 'Invalid plugin display metadata.');
    }
    return plugin;
}

export function validatePluginPath(name) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0 && name.length <= 500, 'Invalid plugin path length.');
    assert.ok(!/[\\\x00-\x1f<>:"|?*]/.test(name), 'Invalid plugin path characters.');
    for (const part of name.split('/')) {
        assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Unsafe plugin path.');
        assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), 'Reserved plugin path.');
    }
    return name;
}

export function isPluginRuntimeFile(name, layout = 'legacy') {
    validatePluginPath(name);
    if (layout === 'runtime') {
        const parts = name.split('/');
        if (parts.some(part => part.startsWith('.') || /^(node_modules|__MACOSX)$/i.test(part))
            || /^(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|__source\.zip|secrets\.json|wrangler\..*|_worker\.js|_redirects|_headers)$/i.test(parts.at(-1))
            || /\.map$/i.test(name)) return false;
        return /(?:\.(?:js|mjs|css|json|html?|wasm|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|txt|md|zip)|\.d\.ts)$/i.test(name)
            || /^(?:LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(parts.at(-1));
    }
    return !name.endsWith('.map') && (/^(dist|lib|libs|include|i18n|locales)\//.test(name)
        || /^(manifest\.json|LICENSE|README(?:_CN)?\.md|CHANGELOG\.md|settings\.html)$/.test(name));
}

export async function readPinnedArchive(bytes, baseline) {
    assert.ok(bytes.byteLength <= MAX_PLUGIN_FILE, 'Plugin archive is too large.');
    assert.equal(digest(bytes), baseline.sha256, `Pinned archive checksum differs: ${baseline.id}`);
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
            if (error) return reject(error);
            const entries = [], seen = new Set();
            let expanded = 0, count = 0, failed = false;
            const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
            zip.on('error', fail);
            zip.on('end', () => { if (!failed) resolve(entries); });
            zip.on('entry', entry => {
                try {
                    assert.ok(++count <= 5000, 'Too many plugin archive entries.');
                    expanded += entry.uncompressedSize;
                    assert.ok(expanded <= 256 * 1024 * 1024, 'Plugin archive expansion is too large.');
                    assert.notEqual((entry.externalFileAttributes >>> 16) & 0xf000, 0xa000, 'Plugin symlinks are not allowed.');
                    const filename = entry.fileName.replace(/\/$/, '');
                    validatePluginPath(filename);
                    const prefix = `${baseline.id}-${baseline.commit}/`;
                    if (filename === prefix.slice(0, -1) && entry.fileName.endsWith('/')) return zip.readEntry();
                    assert.ok(filename.startsWith(prefix), 'Unexpected archive root.');
                    const relative = validatePluginPath(filename.slice(prefix.length));
                    if (entry.fileName.endsWith('/')) return zip.readEntry();
                    assert.ok(!seen.has(relative.toLowerCase()), 'Duplicate plugin file.');
                    seen.add(relative.toLowerCase());
                    if (relative === '__source.zip') throw new Error('Reserved plugin source archive name.');
                    if (!isPluginRuntimeFile(relative, baseline.layout)) return zip.readEntry();
                    assert.ok(entry.uncompressedSize <= MAX_PLUGIN_FILE, 'Plugin file exceeds asset limit.');
                    zip.openReadStream(entry, (error, stream) => {
                        if (error) return fail(error);
                        const chunks = [];
                        let size = 0;
                        stream.on('error', fail);
                        stream.on('data', chunk => {
                            size += chunk.length;
                            if (size > MAX_PLUGIN_FILE) { stream.destroy(); fail(new Error('Plugin file exceeds asset limit.')); }
                            else chunks.push(chunk);
                        });
                        stream.on('end', () => {
                            if (failed) return;
                            const bytes = Buffer.concat(chunks);
                            if (crc32(bytes) !== entry.crc32) return fail(new Error('Plugin resource checksum differs.'));
                            entries.push({ name: relative, bytes });
                            zip.readEntry();
                        });
                    });
                } catch (error) { fail(error); }
            });
            zip.readEntry();
        });
    });
}

export function readPluginManifest(files, id) {
    let manifest;
    try { manifest = JSON.parse(files.find(file => file.name === 'manifest.json')?.bytes.toString()); }
    catch { throw new Error(`Plugin ${id} has no valid root manifest.json. Use a compiled ST frontend extension.`); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || typeof manifest.display_name !== 'string' || (!manifest.js && !manifest.css)
        || (manifest.i18n !== undefined && (!manifest.i18n || typeof manifest.i18n !== 'object' || Array.isArray(manifest.i18n)))) {
        throw new Error(`Plugin ${id} has an unsupported frontend manifest.`);
    }
    const entries = [manifest.js, manifest.css].filter(value => value !== undefined && value !== null && value !== '');
    for (const required of [...entries, ...Object.values(manifest.i18n ?? {})]) {
        try { validatePluginPath(required); }
        catch { throw new Error(`Plugin ${id} has an invalid manifest resource path.`); }
        if (!files.some(file => file.name === required)) {
            throw new Error(`Plugin ${id} is missing a manifest resource. Use a branch containing compiled frontend files.`);
        }
    }
    return manifest;
}

export async function packagePlugins(archives, destination, lock, selected = null) {
    const packages = [];
    await mkdir(destination, { recursive: true });
    assert.equal(await realpath(destination), path.resolve(destination), 'Plugin destination must not be linked.');
    for (const baseline of selected ?? PLUGIN_BASELINES) {
        if (!selected) assert.equal(lock.extensions.find(item => item.id === baseline.id)?.commit, baseline.commit, 'Plugin baseline is out of sync.');
        const archive = await readFile(path.join(archives, baseline.archive));
        const files = await readPinnedArchive(archive, baseline);
        const manifest = readPluginManifest(files, baseline.id);
        assert.equal(String(manifest.version ?? 'unversioned'), baseline.version);
        if (!selected) assert.ok(files.some(file => file.name === 'LICENSE'), 'Missing plugin license.');
        files.push({ name: '__source.zip', bytes: archive });
        const metadata = { ...(selected ? { locked: baseline } : {}),
            id: baseline.id, version: baseline.version, commit: baseline.commit, license: baseline.license,
            archiveSha256: baseline.sha256, sourceUrl: `https://github.com/${baseline.repository}/tree/${baseline.commit}`, files: [] };
        for (const file of files) {
            const output = path.join(destination, baseline.id, file.name);
            await mkdir(path.dirname(output), { recursive: true });
            await writeFile(output, file.bytes, { flag: 'wx' });
            metadata.files.push({ name: file.name, size: file.bytes.length, sha256: digest(file.bytes) });
        }
        packages.push(metadata);
    }
    await writeFile(path.join(destination, 'bundle.json'), JSON.stringify({ schema: selected ? 2 : 1, localOptIn: true, plugins: packages }, null, 2), { flag: 'wx' });
    return packages;
}

export async function copyPluginBundle(bundlePath, assetsRoot) {
    const folder = await realpath(path.dirname(bundlePath));
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
    assert.ok([1, 2].includes(bundle.schema));
    assert.equal(bundle.localOptIn, true);
    assert.ok(Array.isArray(bundle.plugins) && bundle.plugins.length <= MAX_PLUGINS);
    if (bundle.schema === 1) assert.equal(bundle.plugins.length, PLUGIN_BASELINES.length);
    const selected = bundle.schema === 1 ? PLUGIN_BASELINES : bundle.plugins.map(item => validatePluginRecord(item.locked));
    assert.equal(new Set(selected.map(item => item.id.toLowerCase())).size, selected.length, 'Duplicate plugin folders.');
    const copied = [], plugins = [];
    for (const baseline of selected) {
        const item = bundle.plugins.find(plugin => plugin.id === baseline.id);
        assert.equal(item?.commit, baseline.commit);
        assert.equal(item.archiveSha256, baseline.sha256);
        const sourceFile = path.join(folder, baseline.id, '__source.zip');
        assert.equal(await realpath(sourceFile), sourceFile, 'Linked plugin source archive.');
        const bytes = await readFile(sourceFile);
        // Derive files again from the pinned archive. An edited bundle cannot smuggle extra assets into the build.
        const runtime = await readPinnedArchive(bytes, baseline);
        readPluginManifest(runtime, baseline.id);
        const files = [...runtime, { name: '__source.zip', bytes }];
        for (const file of files) {
            const source = path.join(folder, baseline.id, file.name);
            assert.equal(await realpath(source), source, 'Linked plugin resource.');
            assert.equal(digest(await readFile(source)), digest(file.bytes), `Plugin cache changed: ${file.name}`);
            const relative = `scripts/extensions/third-party/${baseline.id}/${file.name}`;
            const output = path.join(assetsRoot, relative);
            await mkdir(path.dirname(output), { recursive: true });
            await writeFile(output, file.bytes, { flag: 'wx' });
            copied.push(relative);
        }
        plugins.push({ name: `third-party/${baseline.id}`, type: 'local', commit: baseline.commit, version: baseline.version,
            ...(bundle.schema === 2 ? { remoteUrl: `https://github.com/${baseline.repository}`,
                ref: baseline.ref === 'HEAD' ? '' : baseline.ref } : {}) });
    }
    return { files: copied, plugins };
}
