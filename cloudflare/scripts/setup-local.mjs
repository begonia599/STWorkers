import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const target = new URL('../.dev.vars', import.meta.url);
try {
    await writeFile(target, `AUTH_PASSWORD=${randomBytes(36).toString('base64url')}\nDATA_KEY=${randomBytes(32).toString('base64')}\n`, {
        flag: 'wx',
        mode: 0o600,
    });
    console.log('Created local-only owner credentials in cloudflare/.dev.vars. Username: owner.');
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = parseEnv(await readFile(target, 'utf8'));
    if (!Object.hasOwn(existing, 'DATA_KEY')) {
        await appendFile(target, `\nDATA_KEY=${randomBytes(32).toString('base64')}\n`);
        console.log('Added an independent DATA_KEY. Kept the existing owner password.');
    } else {
        console.log('Kept the existing owner password and DATA_KEY unchanged.');
    }
}
