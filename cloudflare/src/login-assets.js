// Only upstream login dependencies are public, never application modules or user/plugin resources.
const ASSETS = new Set([
    '/style.css', '/css/st-tailwind.css', '/css/login.css', '/css/fontawesome.min.css', '/css/solid.min.css',
    ...['animations', 'popup', 'promptmanager', 'loader', 'character-group-overlay', 'file-form', 'logprobs',
        'accounts', 'tags', 'scrollable-button', 'welcome', 'data-maid', 'secrets', 'backgrounds',
        'chat-backups', 'streaming-display'].map(name => `/css/${name}.css`),
    '/scripts/login.js', '/scripts/a11y.js', '/lib/jquery-3.5.1.min.js',
    '/manifest.json', '/favicon.ico', '/img/logo.png', '/img/down-arrow.svg', '/img/times-circle.svg',
    ...[57, 72, 114, 144, 192, 512].map(size => `/img/apple-icon-${size}x${size}.png`),
    '/webfonts/NotoSans/stylesheet.css', '/webfonts/NotoSansMono/stylesheet.css',
    '/webfonts/fa-solid-900.woff2', '/webfonts/fa-solid-900.ttf',
]);

export async function loginAsset(request, env) {
    const pathname = new URL(request.url).pathname;
    // Never serve private CSS through the anonymous login exception.
    if (pathname === '/css/user.css') return new Response('/* No filesystem user CSS in this build. */\n',
        { headers: { 'Content-Type': 'text/css' } });
    if (ASSETS.has(pathname)
        || /^\/webfonts\/NotoSans\/NotoSans-[A-Za-z]+\.woff2?$/.test(pathname)
        || /^\/webfonts\/NotoSansMono\/noto-sans-mono-v30-(?:[1-9]00|regular)\.woff2$/.test(pathname)) {
        return env.ASSETS.fetch(request);
    }
    return null;
}
