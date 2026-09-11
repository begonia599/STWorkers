import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import { selectPublicFiles } from './asset-policy.mjs';
import { copyPluginBundle } from './plugin-package.mjs';

const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const buildRoot = path.join(root, 'cloudflare', '.build');
const pluginIndex = process.argv.indexOf('--plugins');
const pluginBundle = pluginIndex < 0 ? null : process.argv[pluginIndex + 1];
if (pluginIndex >= 0 && (!pluginBundle || pluginBundle.startsWith('--'))) throw new Error('--plugins requires an explicit local bundle.json path.');
const assetsRoot = path.join(buildRoot, pluginBundle ? 'assets-p3' : 'assets');
await mkdir(buildRoot, { recursive: true });
if (path.relative(root, await realpath(buildRoot)) !== path.join('cloudflare', '.build')) {
    throw new Error('Refusing to build outside the project .build directory.');
}
try {
    if ((await lstat(assetsRoot)).isSymbolicLink()) {
        throw new Error('Refusing to replace a linked assets directory.');
    }
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
// Only this verified, generated directory is replaced. No user directories are scanned.
console.log(`Building tracked frontend assets in ${assetsRoot}`);
await rm(assetsRoot, { recursive: true, force: true });
await mkdir(assetsRoot);

const tracked = execFileSync('git', ['ls-files', '-z', '--', 'public'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}).split('\0').filter(Boolean);
const projectPublicFiles = ['public/scripts/stworks-token-estimator.js', 'public/scripts/stworks-avatar.js'];
const files = selectPublicFiles([...new Set([...tracked, ...projectPublicFiles])]);
for (const { source, relative } of files) {
    const input = path.join(root, source);
    const canonical = await realpath(input);
    const withinPublic = path.relative(path.join(root, 'public'), canonical);
    if (withinPublic.startsWith('..') || path.isAbsolute(withinPublic) || !(await lstat(input)).isFile()) {
        throw new Error(`Refusing to include a linked or non-public file: ${source}`);
    }
    const output = path.join(assetsRoot, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(input, output);
}

const trackedDefaults = execFileSync('git', ['ls-files', '-z', '--', 'default/content'], {
    cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const defaultFiles = trackedDefaults.filter(file => file.startsWith('default/content/backgrounds/')).map(source => ({
    source, relative: source.slice('default/content/'.length),
}));
defaultFiles.push({ source: 'default/content/user-default.png', relative: 'User Avatars/user-default.png' });
for (const { source, relative } of defaultFiles) {
    const input = path.join(root, source);
    if (!trackedDefaults.includes(source) || !(await lstat(input)).isFile()
        || path.relative(path.join(root, 'default', 'content'), await realpath(input)).startsWith('..')) {
        throw new Error(`Refusing to include an untracked or linked default: ${source}`);
    }
    await mkdir(path.dirname(path.join(assetsRoot, relative)), { recursive: true });
    await copyFile(input, path.join(assetsRoot, relative));
}

const compiler = webpack({
    mode: 'production',
    entry: path.join(root, 'public', 'lib.js'),
    devtool: false,
    watch: false,
    experiments: { outputModule: true },
    performance: { hints: false },
    output: { path: assetsRoot, filename: 'lib.js', libraryTarget: 'module' },
});
const bundledFiles = await new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
        compiler.close(closeError => {
            if (error || closeError) return reject(error ?? closeError);
            if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
            console.log(stats.toString({ all: false, timings: true, errors: true, warnings: true }));
            resolve(stats.compilation.getAssets().map(asset => asset.name));
        });
    });
});

async function readPresets(directory, asStrings = false) {
    const folder = directory === 'themes'
        ? path.join(root, 'default', 'content', 'themes')
        : path.join(root, 'default', 'content', 'presets', directory);
    const names = trackedDefaults.filter(file => path.dirname(path.join(root, file)) === folder && file.endsWith('.json'))
        .map(file => path.basename(file)).sort();
    const content = await Promise.all(names.map(async name => {
        const input = path.join(folder, name);
        if (!(await lstat(input)).isFile() || path.dirname(await realpath(input)) !== folder) {
            throw new Error('Refusing to include linked preset files.');
        }
        const text = await readFile(input, 'utf8');
        const parsed = JSON.parse(text);
        return asStrings ? JSON.stringify(parsed) : parsed;
    }));
    return { content, names: names.map(name => name.slice(0, -5)) };
}

const bootstrap = {
    settings: await readFile(path.join(root, 'default', 'content', 'settings.json'), 'utf8'),
    world_names: [],
    enable_extensions: true,
    enable_extensions_auto_update: false,
    enable_accounts: true,
    request_compression: { enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 },
    stworks: {
        backgrounds: defaultFiles.filter(file => file.relative.startsWith('backgrounds/'))
            .map(file => path.posix.basename(file.relative)),
        extensions: ['regex', 'quick-reply'].map(name => ({ name, type: 'system' })),
    },
};
const selectedPlugins = pluginBundle ? await copyPluginBundle(path.resolve(pluginBundle), assetsRoot) : { files: [], plugins: [] };
bootstrap.stworks.extensions.push(...selectedPlugins.plugins);
const defaultSettings = JSON.parse(bootstrap.settings);
defaultSettings.main_api = 'openai';
bootstrap.settings = JSON.stringify(defaultSettings);
for (const [folder, field, namesField] of [
    ['openai', 'openai_settings', 'openai_setting_names'],
    ['kobold', 'koboldai_settings', 'koboldai_setting_names'],
    ['novel', 'novelai_settings', 'novelai_setting_names'],
    ['textgen', 'textgenerationwebui_presets', 'textgenerationwebui_preset_names'],
]) {
    const presets = await readPresets(folder, true);
    bootstrap[field] = presets.content;
    bootstrap[namesField] = presets.names;
}
for (const [folder, field] of [
    ['themes', 'themes'], ['moving-ui', 'movingUIPresets'], ['quick-replies', 'quickReplyPresets'],
    ['instruct', 'instruct'], ['context', 'context'], ['sysprompt', 'sysprompt'], ['reasoning', 'reasoning'],
]) {
    bootstrap[field] = (await readPresets(folder)).content;
}
await mkdir(path.join(assetsRoot, '__stworks'));
await writeFile(path.join(assetsRoot, '__stworks', 'bootstrap.json'), JSON.stringify(bootstrap));
// This server-side optional file has no source asset. Never copy a developer's private CSS.
await writeFile(path.join(assetsRoot, 'css', 'user.css'), '/* No filesystem user CSS in this build. */\n', { flag: 'wx' });

const allAssetFiles = [...new Set([
    ...files.map(file => file.relative),
    ...defaultFiles.map(file => file.relative),
    ...bundledFiles,
    '__stworks/bootstrap.json',
    'css/user.css',
    ...selectedPlugins.files,
])].sort();
let bytes = 0;
for (const relative of allAssetFiles) {
    const information = await stat(path.join(assetsRoot, relative));
    bytes += information.size;
    if (information.size > 25 * 1024 * 1024) {
        throw new Error(`Asset exceeds the build size guard: ${relative}`);
    }
}
const manifest = {
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedPublicFiles: tracked.length,
    projectPublicFiles,
    totalAssetFiles: allAssetFiles.length,
    totalAssetBytes: bytes,
    bundledFiles,
    generatedFiles: ['__stworks/bootstrap.json', 'css/user.css'],
    extensionsDiscovered: bootstrap.stworks.extensions.map(extension => extension.name),
    defaultAssetFiles: defaultFiles.map(file => file.source),
    extensionsBundled: selectedPlugins.plugins,
};
await writeFile(path.join(buildRoot, pluginBundle ? 'build-manifest-p3.json' : 'build-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Prepared ${files.length} explicit public source files and ${selectedPlugins.plugins.length} opt-in plugins. No user data included.`);
