import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = new URL('../../', import.meta.url);
const normalize = text => text.replaceAll('\r\n', '\n');

test('the STWorkers deployment README is not shadowed by a higher-priority GitHub README', async () => {
    const github = await readdir(new URL('.github/', root));
    assert.deepEqual(github.filter(name => /^readme(?:\.|$)/i.test(name)), []);
    const readme = await readFile(new URL('README.md', root), 'utf8');
    assert.match(readme, /^# STWorkers\r?\n/);
    assert.ok(readme.includes('https://deploy.workers.cloudflare.com/?url=https://github.com/begonia599/STWorkers'));
    const upstream = await readFile(new URL('docs/UPSTREAM.md', root), 'utf8');
    assert.ok(upstream.includes('../.github/upstream-readme.md'));
});

test('the original upstream README is preserved and its translation links still resolve', async () => {
    const lock = JSON.parse(await readFile(new URL('upstream-lock.json', root), 'utf8'));
    const original = execFileSync('git', ['show', `${lock.sillytavern.commit}:.github/readme.md`], {
        cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
    const archived = await readFile(new URL('.github/upstream-readme.md', root), 'utf8');
    assert.equal(normalize(archived), normalize(original));
    for (const language of ['de_de', 'ja_jp', 'ko_kr', 'ru_ru', 'zh_cn', 'zh_tw']) {
        const translation = await readFile(new URL(`.github/readme-${language}.md`, root), 'utf8');
        assert.ok(translation.includes('[English](upstream-readme.md)'));
        assert.ok(!translation.includes('[English](readme.md)'));
        assert.ok(archived.includes(`readme-${language}.md`));
    }
});

test('public feedback targets STWorkers and accepts community compatibility reports', async () => {
    const issues = 'https://github.com/begonia599/STWorkers/issues';
    const readme = await readFile(new URL('README.md', root), 'utf8');
    assert.ok(readme.includes(issues));
    for (const file of ['bug-report.yml', 'feature-request.yml']) {
        const source = await readFile(new URL(`.github/ISSUE_TEMPLATE/${file}`, root), 'utf8');
        const form = parse(source);
        assert.match(form.description, /STWorkers/);
        assert.ok(form.body[0].attributes.value.includes(issues));
        for (const credential of ['Token', 'API Key', 'DATA_KEY', 'Cookie']) {
            assert.ok(form.body[0].attributes.value.includes(credential));
        }
        assert.doesNotMatch(source, /SillyTavern\/SillyTavern\/issues|English only|I confirm that my issue is not related to third-party/);
        const fields = form.body.filter(field => field.type !== 'markdown');
        assert.equal(new Set(fields.map(field => field.id)).size, fields.length);
        for (const field of fields) {
            assert.ok(field.id && field.attributes.label);
            assert.ok(['input', 'textarea', 'dropdown', 'checkboxes'].includes(field.type));
            if (field.type === 'dropdown') assert.ok(field.attributes.options.length > 0);
        }
        if (file === 'bug-report.yml') {
            assert.ok(fields.some(field => field.id === 'related'));
            assert.equal(fields.find(field => field.id === 'repro').validations.required, true);
            assert.notEqual(fields.find(field => field.id === 'version').validations?.required, true);
            assert.equal(fields.some(field => field.type === 'checkboxes'), false);
        }
    }
});
