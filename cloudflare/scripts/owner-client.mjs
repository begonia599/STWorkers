import assert from 'node:assert/strict';

// Shared by local/cloud probes. Cookie credentials are only sent to the exact instance origin.
export async function ownerClient(base, password, { fetchImpl = fetch } = {}) {
    const origin = new URL(base).origin;
    const cookies = new Map();
    let token;
    async function send(path, options = {}) {
        const url = new URL(path, origin);
        assert.equal(url.origin, origin, 'Never forward owner credentials to another origin.');
        const headers = new Headers(options.headers);
        headers.delete('Authorization');
        if (!headers.has('Cookie')) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
        if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        if (!headers.has('Origin')) headers.set('Origin', origin);
        const response = await fetchImpl(url, { ...options, headers, redirect: 'manual' });
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';')[0];
            const index = pair.indexOf('=');
            cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
    }
    const anonymous = await send('/csrf-token');
    assert.equal(anonymous.status, 200, 'Anonymous CSRF handshake failed.');
    token = (await anonymous.json()).token;
    const result = await send('/api/users/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'owner', password }) });
    assert.equal(result.status, 200, `Owner login failed (HTTP ${result.status}). Use the current account password.`);
    const signedIn = await send('/csrf-token');
    assert.equal(signedIn.status, 200);
    token = (await signedIn.json()).token;
    return {
        fetch: send,
        get headers() { return { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            Origin: origin, 'X-CSRF-Token': token }; },
        get cookie() { return this.headers.Cookie; },
        get token() { return token; },
        storageState() {
            return { cookies: [...cookies].map(([name, value]) => ({
                name, value, domain: new URL(origin).hostname, path: '/', httpOnly: true,
                secure: origin.startsWith('https:'), sameSite: 'Strict', expires: -1,
            })), origins: [] };
        },
    };
}

export async function ownerStorageState(base, password) {
    return (await ownerClient(base, password)).storageState();
}

export async function loginThroughPage(page, base, password) {
    await page.goto(new URL('/login', base).href, { waitUntil: 'domcontentloaded' });
    await page.locator('#userList .userSelect').click();
    await page.locator('#userPassword').fill(password);
    await page.locator('#loginButton').click();
    await page.waitForURL(url => url.pathname === '/', { timeout: 90000 });
}
