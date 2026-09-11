import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packagePlugins } from './plugin-package.mjs';

if (!process.argv[2]) throw new Error('Provide the directory containing the pinned helper.zip and ejs.zip archives. No downloads are implicit.');
const build = fileURLToPath(new URL('../.build/', import.meta.url));
await mkdir(build, { recursive: true });
const destination = await mkdtemp(path.join(build, 'p3-plugins-'));
const lock = JSON.parse(await readFile(new URL('../../upstream-lock.json', import.meta.url), 'utf8'));
const packages = await packagePlugins(path.resolve(process.argv[2]), destination, lock);
console.log(JSON.stringify({ bundle: path.join(destination, 'bundle.json'),
    plugins: packages.map(item => ({ id: item.id, version: item.version, files: item.files.length })) }, null, 2));
