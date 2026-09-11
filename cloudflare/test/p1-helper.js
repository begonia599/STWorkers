import { readFileSync } from 'node:fs';
import { makeD1 } from './d1-helper.js';
import { csrfToken } from '../src/auth.js';
import worker from '../src/index.js';

export const defaultPng = readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
export const cardFixture = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
        name: 'Fixture', description: 'A synthetic character.', first_mes: 'Hello {{user}}.',
        alternate_greetings: ['Alternative {{user}}'], tags: ['synthetic'],
        character_book: { entries: [{ keys: ['key'], content: 'book', extensions: { nested: null } }] },
        extensions: { tavern_helper: { scripts: [{ id: 'fixture', content: '/* inert */' }] }, unknown: [0, null, false] },
    },
    future: { nested: [null, { flag: true }] },
};

export function makeR2() {
    return {
        objects: new Map(),
        failPut: false,
        failDelete: false,
        async put(key, bytes, options) {
            if (this.failPut) throw new Error('Synthetic R2 failure');
            this.objects.set(key, { bytes: await new Response(bytes).arrayBuffer(), options });
        },
        async get(key, options) {
            const value = this.objects.get(key);
            if (!value) return null;
            const range = options?.range;
            const bytes = range ? value.bytes.slice(range.offset, range.offset + range.length) : value.bytes;
            return new Response(bytes, { headers: { 'Content-Type': value.options.httpMetadata.contentType } });
        },
        async delete(key) {
            if (this.failDelete) throw new Error('Synthetic cleanup failure');
            this.objects.delete(key);
        },
    };
}

export async function harness(t) {
    const origin = 'https://stworks.example';
    const password = 'synthetic-test-password-at-least-24-characters';
    const env = {
        AUTH_PASSWORD: password,
        DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
        DB: makeD1(t), FILES: makeR2(),
        ASSETS: {
            async fetch(request) {
                if (new URL(request.url).pathname === '/__stworks/bootstrap.json') {
                    return Response.json({
                        settings: JSON.stringify({ username: 'User' }),
                        openai_settings: ['{"name":"Default","future":true}'], openai_setting_names: ['Default'],
                        quickReplyPresets: [{ name: 'Default', qrList: [] }],
                        stworks: { extensions: [{ name: 'regex', type: 'system' }], backgrounds: ['tavern day.jpg'] },
                    });
                }
                if (['/img/ai4.png', '/User%20Avatars/user-default.png'].includes(new URL(request.url).pathname)) {
                    return new Response(defaultPng, { headers: { 'Content-Type': 'image/png' } });
                }
                return new Response('Not found', { status: 404 });
            },
        },
    };
    const token = await csrfToken(new Request(origin), env);
    const call = (path, body, extra = {}) => {
        const form = body instanceof FormData;
        return worker.fetch(new Request(origin + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                Authorization: `Basic ${btoa(`owner:${password}`)}`, Origin: origin, 'X-CSRF-Token': token,
                ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra,
            },
            ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
        }), env);
    };
    const importCard = async (value = cardFixture) => {
        const form = new FormData();
        form.append('avatar', new Blob([JSON.stringify(value)], { type: 'application/json' }), 'fixture.json');
        form.append('file_type', 'json');
        const response = await call('/api/characters/import', form);
        if (response.status !== 200) throw new Error(`Import failed: ${await response.text()}`);
        return `${(await response.json()).file_name}.png`;
    };
    return { env, call, importCard };
}
