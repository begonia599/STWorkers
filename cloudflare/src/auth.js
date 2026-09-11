import { HttpError, readBytes, parseJsonObject } from './http.js';
import { loginAsset } from './login-assets.js';

const encoder = new TextEncoder();
const DAY = 86400;
const SESSION_AGE = 7 * DAY;
const MAX_SESSION_AGE = 30 * DAY;
const LOGIN_AGE = 3600;
const ITERATIONS = 100000;
const WINDOW = 900;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_ACTIONS = new Set(['list', 'login', 'recover-step1', 'recover-step2']);
const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const now = () => Math.floor(Date.now() / 1000);
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function sign(env, value) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.AUTH_PASSWORD),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function equal(left, right) {
    const [a, b] = await Promise.all([digest(left), digest(right)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function cookieName(request, type) {
    return `${new URL(request.url).protocol === 'https:' ? '__Host-' : ''}stworkers-${type}`;
}

function cookie(request, type) {
    const name = cookieName(request, type);
    const matches = (request.headers.get('Cookie') ?? '').split(';')
        .map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
    return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}

function setCookie(request, type, value, age) {
    return `${cookieName(request, type)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`
        + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
}

function configured(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new HttpError(403, 'HTTPS_REQUIRED', 'Use HTTPS to sign in.');
    }
    if (typeof env.AUTH_PASSWORD !== 'string' || env.AUTH_PASSWORD.length < 24 || env.AUTH_PASSWORD.length > 1024) {
        throw new HttpError(503, 'OWNER_NOT_CONFIGURED', 'Configure AUTH_PASSWORD before using this instance.');
    }
    if (!env.DB) throw new HttpError(503, 'DB_NOT_CONFIGURED', 'Configure and migrate the account database first.');
}

function sameOrigin(request) {
    const origin = request.headers.get('Origin');
    if ((origin !== null && origin !== new URL(request.url).origin)
        || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        throw new HttpError(403, 'CROSS_ORIGIN_WRITE', 'Cross-origin authentication and writes are not permitted.');
    }
}

async function anonymous(request, env) {
    const value = cookie(request, 'login');
    if (!/^\d{10}\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) return null;
    const [expires, nonce, signature] = value.split('.');
    if (Number(expires) <= now() || Number(expires) > now() + LOGIN_AGE) return null;
    const payload = `${expires}.${nonce}`;
    const expected = await sign(env, `login:${new URL(request.url).origin}:${payload}`);
    return await equal(signature, expected) ? payload : null;
}

export async function authenticate(request, env) {
    configured(request, env);
    const raw = cookie(request, 'session');
    if (!/^[a-f0-9]{64}$/.test(raw)) return null;
    // No Sessions API replica is used: revocation checks read D1's primary.
    const session = await env.DB.prepare(`SELECT s.*, a.bootstrap_hash
        FROM stworkers_sessions s JOIN stworkers_accounts a ON a.handle = s.handle
        WHERE s.token_hash = ? AND s.origin = ? AND s.expires_at > ? AND s.version = a.version`)
        .bind(await digest(raw), new URL(request.url).origin, now()).first();
    if (!session || !await equal(session.bootstrap_hash, await sign(env, 'stworkers:owner-bootstrap:v1'))) return null;
    return session;
}

export async function csrfToken(request, env, session = null) {
    if (session) return session.csrf;
    const payload = await anonymous(request, env);
    return payload ? sign(env, `csrf:${new URL(request.url).origin}:${payload}`) : null;
}

export async function validateCsrf(request, env, session = null) {
    if (READ_METHODS.has(request.method)) return;
    sameOrigin(request);
    const supplied = request.headers.get('X-CSRF-Token');
    const expected = await csrfToken(request, env, session);
    if (!expected || !supplied || !/^[a-f0-9]{64}$/.test(supplied) || !await equal(supplied, expected)) {
        throw new HttpError(403, 'INVALID_CSRF_TOKEN', 'Refresh the page to obtain a CSRF token.');
    }
}

function profile(account) {
    return { handle: 'owner', name: account.name, avatar: account.avatar || '/img/logo.png',
        admin: true, singleOwner: true, password: true, created: account.created };
}

async function authBody(request, maxBytes = 8192) {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
    }
    return parseJsonObject(await readBytes(request, maxBytes));
}

function validPassword(value, minimum = 1) {
    return typeof value === 'string' && value.length >= minimum && value.length <= 1024;
}

async function verifier(password, salt, env) {
    // A Worker-secret pepper protects a database-only leak; no password or pepper is stored in D1.
    const peppered = await sign(env, `password:v1:${password.normalize()}`);
    const key = await crypto.subtle.importKey('raw', encoder.encode(peppered), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({
        name: 'PBKDF2', salt: encoder.encode(salt), iterations: ITERATIONS, hash: 'SHA-256',
    }, key, 256));
}

async function throttle(request, env) {
    // Fixed 256 IP buckets plus one global bucket bound storage without retaining IP addresses.
    const bucket = (await digest(request.headers.get('CF-Connecting-IP') || 'local')).slice(0, 2);
    const time = now();
    for (const [id, limit] of [['global', 100], [`ip:${bucket}`, 10]]) {
        const row = await env.DB.prepare(`INSERT INTO stworkers_login_limits (id, started_at, attempts)
            VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET
            attempts = CASE WHEN started_at <= ? THEN 1 ELSE min(attempts + 1, ?) END,
            started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END
            RETURNING attempts, started_at`).bind(id, time, time - WINDOW, limit + 1, time - WINDOW).first();
        if (row.attempts > limit) {
            return Response.json({ error: 'Too many attempts. Please try again later.' },
                { status: 429, headers: { 'Retry-After': String(Math.max(1, row.started_at + WINDOW - time)) } });
        }
    }
    return null;
}

async function issueSession(request, env, account, csrf = random()) {
    const raw = random();
    const time = now();
    const inserted = await env.DB.prepare(`INSERT INTO stworkers_sessions
        (token_hash, handle, version, csrf, origin, created_at, expires_at)
        SELECT ?, handle, version, ?, ?, ?, ? FROM stworkers_accounts
        WHERE handle = 'owner' AND version = ? AND bootstrap_hash = ? RETURNING token_hash`)
        .bind(await digest(raw), csrf, new URL(request.url).origin, time, time + SESSION_AGE,
            account.version, account.bootstrap_hash).first();
    if (!inserted) throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed. Sign in again.');
    await env.DB.prepare(`DELETE FROM stworkers_sessions WHERE expires_at <= ?
        OR version <> (SELECT version FROM stworkers_accounts WHERE handle = 'owner')
        OR token_hash NOT IN (SELECT token_hash FROM stworkers_sessions ORDER BY created_at DESC, rowid DESC LIMIT 20)`)
        .bind(time).run();
    return setCookie(request, 'session', raw, SESSION_AGE);
}

async function login(request, env) {
    const limited = await throttle(request, env);
    if (limited) return limited;
    const body = await authBody(request);
    const rejected = () => Response.json({ error: 'Incorrect handle or password.' }, { status: 403 });
    if (body.handle !== 'owner' || !validPassword(body.password)) return rejected();
    let account = await env.DB.prepare("SELECT * FROM stworkers_accounts WHERE handle = 'owner'").bind().first();
    const bootstrapHash = await sign(env, 'stworkers:owner-bootstrap:v1');
    if (!account || account.bootstrap_hash !== bootstrapHash) {
        if (!await equal(body.password, env.AUTH_PASSWORD)) return rejected();
        const salt = random();
        const hash = await verifier(body.password, salt, env);
        // The deployment secret proves ownership. Concurrent first logins cannot overwrite an account.
        account = account
            ? await env.DB.prepare(`UPDATE stworkers_accounts SET password_hash = ?, salt = ?,
                bootstrap_hash = ?, version = version + 1 WHERE handle = 'owner' AND version = ?
                AND bootstrap_hash = ? RETURNING *`)
                .bind(hash, salt, bootstrapHash, account.version, account.bootstrap_hash).first()
            : await env.DB.prepare(`INSERT INTO stworkers_accounts
                (handle, name, avatar, password_hash, salt, bootstrap_hash, version, created)
                VALUES ('owner', 'Owner', '', ?, ?, ?, 1, ?) ON CONFLICT(handle) DO NOTHING RETURNING *`)
                .bind(hash, salt, bootstrapHash, Date.now()).first();
        if (!account) throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed. Try signing in again.');
    } else if (!await equal(await verifier(body.password, account.salt, env), account.password_hash)) {
        return rejected();
    }
    return Response.json({ handle: 'owner' }, { headers: { 'Set-Cookie': await issueSession(request, env, account) } });
}

export async function handleUsers(request, env, session, action) {
    const method = action === 'me' ? 'GET' : 'POST';
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
    await validateCsrf(request, env, session);
    if (action === 'list') {
        return Response.json([{ handle: 'owner', name: 'Owner', avatar: '/img/logo.png', password: true }]);
    }
    if (action === 'login') return login(request, env);
    if (action.startsWith('recover-')) {
        return Response.json({ error: 'Recovery codes are not sent to logs. In Cloudflare, replace AUTH_PASSWORD '
            + 'with a new random password of at least 24 characters and deploy it. Then sign in as owner using that password. '
            + 'Keep DATA_KEY unchanged.' }, { status: 501 });
    }
    if (action === 'me') {
        // Read potentially large avatar data only for the profile, not for every authenticated asset.
        const account = await env.DB.prepare(`SELECT name, avatar, created FROM stworkers_accounts
            WHERE handle = 'owner' AND version = ?`).bind(session.version).first();
        if (!account) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in again.');
        return Response.json(profile(account));
    }
    if (action === 'logout') {
        await env.DB.prepare('DELETE FROM stworkers_sessions WHERE token_hash = ?').bind(session.token_hash).run();
        return new Response(null, { status: 204, headers: { 'Set-Cookie': setCookie(request, 'session', '', 0) } });
    }
    if (!['change-password', 'change-name', 'change-avatar'].includes(action)) {
        return Response.json({ error: 'This account operation is not supported in the single-owner Workers edition.' }, { status: 501 });
    }
    const limited = action === 'change-password' ? await throttle(request, env) : null;
    if (limited) return limited;
    const body = await authBody(request, action === 'change-avatar' ? 512 * 1024 : 8192);
    if (body.handle !== 'owner') throw new HttpError(403, 'WRONG_ACCOUNT', 'Only the signed-in owner can be changed.');
    if (action === 'change-password') {
        if (!validPassword(body.newPassword, 12)) {
            throw new HttpError(400, 'WEAK_PASSWORD', 'Use a password between 12 and 1024 characters. Passwordless login is disabled.');
        }
        const account = await env.DB.prepare("SELECT * FROM stworkers_accounts WHERE handle = 'owner'").bind().first();
        if (!validPassword(body.oldPassword) || !await equal(await verifier(body.oldPassword, account.salt, env), account.password_hash)) {
            throw new HttpError(403, 'WRONG_PASSWORD', 'Incorrect current password.');
        }
        const salt = random();
        const changed = await env.DB.prepare(`UPDATE stworkers_accounts SET password_hash = ?, salt = ?, version = version + 1
            WHERE handle = 'owner' AND version = ? AND bootstrap_hash = ? RETURNING *`)
            .bind(await verifier(body.newPassword, salt, env), salt, session.version, session.bootstrap_hash).first();
        if (!changed) throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed. Sign in again.');
        // Keep this page's CSRF token while rotating its session ID; other sessions fail the version check.
        return new Response(null, { status: 204,
            headers: { 'Set-Cookie': await issueSession(request, env, changed, session.csrf) } });
    }
    if (action === 'change-name') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) {
            throw new HttpError(400, 'INVALID_NAME', 'Use a display name between 1 and 100 characters.');
        }
    } else if (typeof body.avatar !== 'string' || (body.avatar !== ''
        && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(body.avatar))) {
        throw new HttpError(400, 'INVALID_AVATAR', 'Use a PNG, JPEG or WebP avatar.');
    }
    const column = action === 'change-name' ? 'name' : 'avatar';
    const result = await env.DB.prepare(`UPDATE stworkers_accounts SET ${column} = ?
        WHERE handle = 'owner' AND version = ? AND bootstrap_hash = ? RETURNING handle`)
        .bind(body[column], session.version, session.bootstrap_hash).first();
    if (!result) throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed. Sign in again.');
    return new Response(null, { status: 204 });
}

export async function extendSession(request, env, session) {
    if (new URL(request.url).searchParams.get('extend') !== '1' || session.expires_at > now() + DAY) return new Response('ok');
    const expires = Math.min(now() + SESSION_AGE, session.created_at + MAX_SESSION_AGE);
    const updated = await env.DB.prepare(`UPDATE stworkers_sessions SET expires_at = ?
        WHERE token_hash = ? AND expires_at > ? RETURNING token_hash`).bind(expires, session.token_hash, now()).first();
    if (!updated) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in again.');
    return new Response('ok', { headers: { 'Set-Cookie': setCookie(request, 'session', cookie(request, 'session'), expires - now()) } });
}

export async function access(request, env) {
    const session = await authenticate(request, env);
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === '/csrf-token') {
        if (request.method !== 'GET') return { response: new Response(null, { status: 405, headers: { Allow: 'GET' } }) };
        sameOrigin(request);
        const existing = await csrfToken(request, env, session);
        if (existing) return { response: Response.json({ token: existing }) };
        const payload = `${now() + LOGIN_AGE}.${random()}`;
        const value = `${payload}.${await sign(env, `login:${url.origin}:${payload}`)}`;
        return { response: Response.json({ token: await sign(env, `csrf:${url.origin}:${payload}`) },
            { headers: { 'Set-Cookie': setCookie(request, 'login', value, LOGIN_AGE) } }) };
    }
    const action = pathname.startsWith('/api/users/') ? pathname.slice('/api/users/'.length) : null;
    if (!session && action && PUBLIC_ACTIONS.has(action)) {
        return { response: await handleUsers(request, env, null, action) };
    }
    if (['GET', 'HEAD'].includes(request.method)) {
        if (['/login', '/login/', '/login.html'].includes(pathname)) {
            if (session) return { response: new Response(null, { status: 302, headers: { Location: `/${url.search}` } }) };
            return { response: await env.ASSETS.fetch(new Request(new URL('/login.html', url), request)) };
        }
        const asset = await loginAsset(request, env);
        if (asset) return { response: asset };
    }
    if (!session) {
        const navigation = ['GET', 'HEAD'].includes(request.method)
            && (pathname === '/' || pathname === '/index.html'
                || (!pathname.startsWith('/api/') && request.headers.get('Sec-Fetch-Dest') === 'document'));
        return { response: navigation
            ? new Response(null, { status: 302, headers: { Location: `/login${url.search}` } })
            : Response.json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' }, { status: 401 }) };
    }
    if (action !== null) return { response: await handleUsers(request, env, session, action) };
    await validateCsrf(request, env, session);
    if (pathname === '/api/ping' && request.method === 'POST') return { response: await extendSession(request, env, session) };
    return { session };
}
