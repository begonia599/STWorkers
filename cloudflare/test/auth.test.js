import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { authenticate } from '../src/auth.js';
import { makeD1, syntheticCardState } from './d1-helper.js';
import { harness } from './p1-helper.js';
import { loginClient, anonymousClient, ORIGIN, PASSWORD } from './auth-helper.js';
import { readModelSecret } from '../src/secrets.js';

function environment(t) {
    return { AUTH_PASSWORD: PASSWORD, DB: makeD1(t), ASSETS: { async fetch(request) {
        return new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/plain' } });
    } } };
}
function send(env, path, headers = {}, body, options = {}) {
    return worker.fetch(new Request(ORIGIN + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...options,
    }), env);
}
function clearLimit(env) { env.DB.sqlite.exec('DELETE FROM stworkers_login_limits'); }
const passwordChange = (oldPassword, newPassword = 'new-test-password-long-enough') => ({
    handle: 'owner', oldPassword, newPassword,
});

test('unconfigured instances and insecure non-loopback transport fail closed', async t => {
    const env = environment(t);
    for (const password of [undefined, '', 'short', 'x'.repeat(1025)]) {
        env.AUTH_PASSWORD = password;
        for (const path of ['/', '/login', '/scripts/login.js', '/api/users/login', '/csrf-token']) {
            assert.equal((await send(env, path)).status, 503);
        }
    }
    env.AUTH_PASSWORD = PASSWORD;
    assert.equal((await worker.fetch(new Request('http://public.example/login'), env)).status, 403);
});

test('only minimal login assets are public; private CSS and plugins cannot leak', async t => {
    const env = environment(t);
    for (const path of ['/', '/index.html']) {
        const response = await send(env, path);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('Location'), '/login');
        assert.equal(response.headers.get('WWW-Authenticate'), null);
    }
    for (const path of ['/login', '/login.html', '/scripts/login.js', '/scripts/a11y.js', '/style.css',
        '/css/accounts.css', '/webfonts/NotoSans/NotoSans-Regular.woff2', '/img/logo.png']) {
        assert.equal((await send(env, path)).status, 200, path);
    }
    assert.doesNotMatch(await (await send(env, '/css/user.css')).text(), /\/css\/user.css/);
    for (const path of ['/script.js', '/lib.js', '/__stworks/bootstrap.json', '/characters/private.png',
        '/scripts/stworks-token-estimator.js', '/User%20Avatars/private.png', '/api/users/me',
        '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js',
        '/scripts/extensions/third-party/ST-Prompt-Template/__source.zip',
        '/scripts/%6cogin.js', '/css/user.css/private', '/webfonts/NotoSans/private.json']) {
        assert.equal((await send(env, path)).status, 401, path);
    }
    assert.equal((await send(env, '/?noauto=true&char=fixture')).headers.get('Location'), '/login?noauto=true&char=fixture');
});

test('Basic, forged, duplicate and wrong cookie names never authenticate', async t => {
    const env = environment(t);
    const client = await loginClient(env);
    for (const headers of [{ Authorization: `Basic ${btoa(`owner:${PASSWORD}`)}` },
        { Cookie: '__Host-stworkers-session=' + 'a'.repeat(64) }, { Cookie: 'stworkers-session=' + 'a'.repeat(64) },
        { Cookie: `${client.cookie}; ${client.cookie}` }, { Cookie: '__Host-stworkers-session=malformed' }]) {
        assert.equal((await send(env, '/api/users/me', headers)).status, 401);
    }
    const result = await send(env, '/api/users/me', client.headers);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('WWW-Authenticate'), null);
});

test('anonymous CSRF uses a signed expiring cookie; token alone or another browser cannot log in', async t => {
    const env = environment(t);
    const a = await anonymousClient(env), b = await anonymousClient(env);
    assert.notEqual(a.token, b.token);
    for (const headers of [{ 'X-CSRF-Token': a.token },
        { ...a.headers, Cookie: b.cookie }, { ...a.headers, Origin: 'null' },
        { ...a.headers, 'Sec-Fetch-Site': 'cross-site' }, { ...a.headers, Origin: 'https://other.example' }]) {
        assert.equal((await send(env, '/api/users/login', headers, { handle: 'owner', password: PASSWORD })).status, 403);
    }
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_accounts').get().n, 0);
    assert.equal((await send(env, '/csrf-token', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const originalNow = Date.now;
    t.mock.method(Date, 'now', () => originalNow() + 3601000);
    assert.equal((await send(env, '/api/users/list', a.headers, {})).status, 403);
});

test('first owner needs the deployment secret; login returns upstream shape and protected opaque cookies', async t => {
    const env = environment(t);
    const anon = await anonymousClient(env);
    for (const body of [{ handle: 'guest', password: PASSWORD }, { handle: 'owner', password: '' },
        { handle: 'owner', password: 'wrong' }, { handle: 'owner', password: {} }]) {
        const failed = await send(env, '/api/users/login', anon.headers, body);
        assert.equal(failed.status, 403);
        assert.equal(typeof (await failed.json()).error, 'string');
    }
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_accounts').get().n, 0);
    const response = await send(env, '/api/users/login', anon.headers, { handle: 'owner', password: PASSWORD });
    assert.deepEqual(await response.json(), { handle: 'owner' });
    const header = response.headers.get('Set-Cookie');
    assert.match(header, /^__Host-stworkers-session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const raw = header.split(';')[0].split('=')[1];
    const stored = env.DB.sqlite.prepare('SELECT * FROM stworkers_sessions').get();
    assert.notEqual(stored.token_hash, raw);
    const account = env.DB.sqlite.prepare('SELECT * FROM stworkers_accounts').get();
    assert.doesNotMatch(JSON.stringify(account), new RegExp(PASSWORD));
    assert.equal(account.password_hash.length, 64);
    assert.equal(account.salt.length, 64);
    const fresh = await loginClient(env);
    assert.notEqual(fresh.cookie, header.split(';')[0]);
    assert.notEqual(fresh.token, anon.token);
});

test('login failures are bounded, durable and checked before password computation', async t => {
    const env = environment(t);
    const a = await anonymousClient(env);
    for (let i = 0; i < 10; i++) {
        assert.equal((await send(env, '/api/users/login', a.headers, { handle: 'owner', password: 'wrong' })).status, 403);
    }
    const limited = await send(env, '/api/users/login', a.headers, { handle: 'owner', password: PASSWORD });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_login_limits').get().n, 2);
    env.DB.sqlite.exec('UPDATE stworkers_login_limits SET started_at = 0');
    assert.equal((await send(env, '/api/users/login', a.headers, { handle: 'owner', password: PASSWORD })).status, 200);
});

test('logout deletes the session and rejects replay; another device stays signed in', async t => {
    const env = environment(t);
    const a = await loginClient(env), b = await loginClient(env);
    assert.equal((await send(env, '/api/users/change-name',
        { ...a.headers, 'X-CSRF-Token': b.token }, { handle: 'owner', name: 'Must not change' })).status, 403);
    const logout = await send(env, '/api/users/logout', a.headers, {});
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await send(env, '/api/users/me', a.headers)).status, 401);
    assert.equal((await send(env, '/api/users/me', b.headers)).status, 200);
});

test('password changes require the old password, rotate this cookie, revoke others and preserve data', async t => {
    const { env, client: a, call } = await harness(t);
    const b = await loginClient(env);
    await call('/api/settings/save', syntheticCardState);
    await call('/api/secrets/write', { key: 'api_key_openai', value: 'synthetic-model-secret' });
    const before = env.DB.sqlite.prepare('SELECT * FROM documents ORDER BY kind,id').all();
    for (const body of [passwordChange('wrong'), passwordChange(PASSWORD, ''), passwordChange(PASSWORD, 'short'),
        { ...passwordChange(PASSWORD), handle: 'guest' }]) {
        assert.ok([400, 403].includes((await send(env, '/api/users/change-password', a.headers, body)).status));
    }
    const change = await send(env, '/api/users/change-password', a.headers, passwordChange(PASSWORD));
    assert.equal(change.status, 204);
    const cookie = change.headers.get('Set-Cookie').split(';')[0];
    assert.notEqual(cookie, a.cookie);
    const current = { ...a.headers, Cookie: cookie };
    assert.equal((await send(env, '/api/users/me', current)).status, 200);
    assert.equal((await send(env, '/api/users/change-name', current, { handle: 'owner', name: 'Updated' })).status, 204);
    for (const old of [a, b]) assert.equal((await send(env, '/api/users/me', old.headers)).status, 401);
    const anonymous = await anonymousClient(env);
    assert.equal((await send(env, '/api/users/login', anonymous.headers, { handle: 'owner', password: PASSWORD })).status, 403);
    assert.equal((await loginClient(env, 'new-test-password-long-enough')).headers.Origin, ORIGIN);
    assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM documents ORDER BY kind,id').all(), before);
    assert.equal(await readModelSecret(env, 'api_key_openai'), 'synthetic-model-secret');
});

test('secret rotation recovers only with the new deployment password and preserves owner profile', async t => {
    const env = environment(t);
    const a = await loginClient(env);
    await send(env, '/api/users/change-name', a.headers, { handle: 'owner', name: 'Preserved' });
    env.AUTH_PASSWORD = 'rotated-deployment-secret-at-least-24';
    assert.equal((await send(env, '/api/users/me', a.headers)).status, 401);
    const anon = await anonymousClient(env);
    assert.equal((await send(env, '/api/users/login', anon.headers, { handle: 'owner', password: PASSWORD })).status, 403);
    const restored = await loginClient(env);
    assert.equal((await (await restored.fetch('/api/users/me')).json()).name, 'Preserved');
    assert.equal(env.DB.sqlite.prepare('SELECT version FROM stworkers_accounts').get().version, 2);
});

test('profile edits persist but never disclose private details in anonymous user list', async t => {
    const env = environment(t);
    const a = await loginClient(env);
    assert.equal((await send(env, '/api/users/change-name', a.headers, { handle: 'owner', name: 'Private name' })).status, 204);
    assert.equal((await send(env, '/api/users/change-avatar', a.headers, { handle: 'owner', avatar: 'data:image/png;base64,YQ==' })).status, 204);
    assert.equal((await send(env, '/api/users/change-avatar', a.headers, { handle: 'owner', avatar: 'data:image/svg+xml;base64,YQ==' })).status, 400);
    const profile = await (await a.fetch('/api/users/me')).json();
    assert.deepEqual(Object.keys(profile).sort(), ['admin', 'avatar', 'created', 'handle', 'name', 'password', 'singleOwner']);
    assert.equal(profile.admin, true);
    assert.equal(profile.singleOwner, true);
    assert.equal(profile.name, 'Private name');
    const session = await authenticate(new Request(ORIGIN + '/script.js', { headers: a.headers }), env);
    for (const privateField of ['avatar', 'name', 'created', 'password_hash', 'salt']) {
        assert.equal(Object.hasOwn(session, privateField), false);
    }
    const anon = await anonymousClient(env);
    assert.doesNotMatch(await (await send(env, '/api/users/list', anon.headers, {})).text(), /Private|YQ==|salt|hash/);
});

test('unsupported account operations fail clearly, without creating users or logging recovery secrets', async t => {
    const env = environment(t);
    const client = await loginClient(env);
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    t.mock.method(console, 'error', (...args) => logs.push(args));
    for (const action of ['create', 'delete', 'get', 'backup', 'reset-step1', 'reset-step2', 'recover-step1', 'recover-step2']) {
        const response = await send(env, '/api/users/' + action, client.headers, { handle: 'owner' });
        assert.equal(response.status, 501, action);
        assert.equal(typeof (await response.json()).error, 'string');
    }
    assert.deepEqual(logs, []);
    assert.equal((await send(env, '/api/users/login')).status, 405);
    assert.equal((await send(env, '/api/users/me', client.headers, {})).status, 405);
});

test('expired sessions are rejected; ping extends near expiry with a hard 30 day cap', async t => {
    const env = environment(t), client = await loginClient(env);
    const initial = env.DB.sqlite.prepare('SELECT * FROM stworkers_sessions').get();
    const originalNow = Date.now;
    t.mock.method(Date, 'now', () => originalNow() + 6.5 * 86400000);
    const extended = await send(env, '/api/ping?extend=1', client.headers, {});
    assert.equal(extended.status, 200);
    assert.match(extended.headers.get('Set-Cookie'), /Max-Age=604800/);
    t.mock.method(Date, 'now', () => (initial.created_at + 30 * 86400 + 1) * 1000);
    assert.equal((await send(env, '/api/users/me', client.headers)).status, 401);
});

test('concurrent owner initialization and password change cannot overwrite winners', async t => {
    const env = environment(t);
    const a = await anonymousClient(env), b = await anonymousClient(env);
    const results = await Promise.all([a, b].map(client =>
        send(env, '/api/users/login', client.headers, { handle: 'owner', password: PASSWORD })));
    assert.ok(results.some(response => response.status === 200));
    assert.ok(results.every(response => [200, 409].includes(response.status)));
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_accounts').get().n, 1);
    const client = await loginClient(env);
    const changes = await Promise.all(['password-concurrent-one', 'password-concurrent-two'].map(password =>
        send(env, '/api/users/change-password', client.headers, passwordChange(PASSWORD, password))));
    assert.deepEqual(changes.map(response => response.status).sort(), [204, 409]);
    assert.equal(env.DB.sqlite.prepare('SELECT version FROM stworkers_accounts').get().version, 2);
});

test('sessions are capped, expired records pruned and login limits have bounded keys', async t => {
    const env = environment(t);
    for (let i = 0; i < 23; i++) { clearLimit(env); await loginClient(env); }
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_sessions').get().n, 20);
    env.DB.sqlite.exec('UPDATE stworkers_sessions SET expires_at = 0');
    await loginClient(env);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM stworkers_sessions').get().n, 1);
});

test('additive account migration preserves old document rows byte for byte and is repeatable', async t => {
    const env = environment(t);
    env.DB.sqlite.prepare('INSERT INTO documents(kind,id,payload) VALUES (?,?,?)')
        .run('settings', 'owner', JSON.stringify(syntheticCardState));
    const before = env.DB.sqlite.prepare('SELECT * FROM documents').all();
    const migration = readFileSync(new URL('../migrations/0004_accounts.sql', import.meta.url), 'utf8');
    env.DB.sqlite.exec(migration);
    env.DB.sqlite.exec(migration);
    await loginClient(env);
    assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM documents').all(), before);
});
