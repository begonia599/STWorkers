import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPublicFiles } from '../scripts/asset-policy.mjs';

test('asset inputs include only explicitly tracked public paths', () => {
    assert.deepEqual(selectPublicFiles([
        'public/index.html', 'public/scripts/st-context.js',
        'data/default-user/settings.json', 'secrets.json', 'src/server-main.js',
    ]), [
        { source: 'public/index.html', relative: 'index.html' },
        { source: 'public/scripts/st-context.js', relative: 'scripts/st-context.js' },
    ]);
});

test('tracked paths cannot escape the static root', () => {
    for (const pathname of ['public/../secrets.json', 'public//index.html', 'public/./index.html',
        'public/\\secrets.json', 'public/']) {
        assert.throws(() => selectPublicFiles([pathname]), /Invalid tracked public path/);
    }
});
