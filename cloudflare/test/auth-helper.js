import worker from '../src/index.js';
import { ownerClient } from '../scripts/owner-client.mjs';

export const ORIGIN = 'https://stworks.example';
export const PASSWORD = 'synthetic-test-password-at-least-24-characters';

export function loginClient(env, password = env.AUTH_PASSWORD) {
    return ownerClient(ORIGIN, password, { fetchImpl: (url, options) => worker.fetch(new Request(url, options), env) });
}

export async function anonymousClient(env) {
    const response = await worker.fetch(new Request(ORIGIN + '/csrf-token'), env);
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    const { token } = await response.json();
    return { cookie, token, headers: { Cookie: cookie, 'X-CSRF-Token': token, Origin: ORIGIN } };
}
