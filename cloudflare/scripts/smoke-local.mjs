import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8788');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('This development smoke test is restricted to loopback instances.');
}
const { AUTH_PASSWORD: password } = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
assert.ok(password?.length >= 24, 'Run setup:local before this test.');
const authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
const authenticatedFetch = (pathname, options = {}) => fetch(new URL(pathname, base), {
    ...options,
    headers: { Authorization: authorization, ...options.headers },
});

assert.equal((await fetch(new URL('/', base))).status, 401);
const statusResponse = await authenticatedFetch('/api/stworks/status');
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.readyForChat, false);
assert.equal(status.phase, 'P3-in-progress');
assert.equal(status.compatibility.tavernHelper, 'pinned-local-synthetic-partial');
assert.equal(status.compatibility.communityCards, 'not-yet-verified');
const csrfResponse = await authenticatedFetch('/csrf-token');
assert.equal(csrfResponse.status, 200);
const { token } = await csrfResponse.json();
const post = (pathname, value, headers = {}) => authenticatedFetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: base.origin, ...headers },
    body: JSON.stringify(value),
});
assert.equal((await post('/api/settings/save', {}, { Origin: 'https://other.example' })).status, 403);

const initialResponse = await post('/api/settings/get', {});
assert.equal(initialResponse.status, 200);
const initial = await initialResponse.json();
const originalSettings = JSON.parse(initial.settings);
const probe = structuredClone(originalSettings);
probe.__stworks_probe = {
    id: randomUUID(),
    swipe_id: 1,
    variables: [{ stat_data: { score: 2 } }, { stat_data: { score: 7 } }],
    unknown: { preserve: [false, 0, '', null] },
};
try {
    assert.equal((await post('/api/settings/save', probe)).status, 200);
    const roundTripResponse = await post('/api/settings/get', {});
    assert.equal(roundTripResponse.status, 200);
    const roundTrip = await roundTripResponse.json();
    assert.deepEqual(JSON.parse(roundTrip.settings), probe);
    assert.deepEqual(roundTrip.openai_setting_names, initial.openai_setting_names);
} finally {
    assert.equal((await post('/api/settings/save', originalSettings)).status, 200, 'Restore original local settings.');
}

assert.equal((await post('/api/extensions/install', {})).status, 501);
assert.equal((await post('/api/sd/generate', {})).status, 410);
const index = await authenticatedFetch('/');
assert.equal(index.status, 200);
assert.match(await index.text(), /SillyTavern/);
const library = await authenticatedFetch('/lib.js');
assert.equal(library.status, 200);
assert.match(library.headers.get('Content-Type'), /javascript/);
await library.body.cancel();
console.log('PASS: local Worker auth, CSRF, D1 settings round-trip, explicit capability errors, original HTML and bundled lib.js.');
console.log('Original local settings restored. This does not verify frontend boot or extension compatibility.');
