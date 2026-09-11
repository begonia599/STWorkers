import assert from 'node:assert/strict';
import { ownerClient } from './owner-client.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PLUGIN_BASELINES } from './plugin-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const phase = process.argv[2];
assert.ok(['before', 'after', 'exercise', 'recover', 'delivery'].includes(phase), 'Choose a cloud verification phase explicitly.');
const directory = path.join(root, '.deploy', 'stworks-cloud-test');
const deployment = JSON.parse(await readFile(path.join(directory, 'deployment.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(directory, 'wrangler.json'), 'utf8'));
const base = new URL(deployment.url).origin;
assert.equal(deployment.name, 'stworks-cloud-test');
assert.equal(config.name, deployment.name);
assert.equal(config.account_id, deployment.accountId);
assert.ok(base.startsWith('https://') && new URL(base).hostname.endsWith('.workers.dev'));
const { AUTH_PASSWORD } = JSON.parse(await readFile(path.join(directory, 'secrets.json'), 'utf8'));
const owner = await ownerClient(base, process.env.STWORKERS_TEST_PASSWORD || AUTH_PASSWORD);
const runId = randomUUID();
const output = path.join(root, '.build', 'p4-cloud', runId);
const evidence = { runId, phase, startedAt: new Date().toISOString(), origin: base, requests: [],
    checks: [], plugins: [], tail: [], userDataWrites: 0, modelRequests: 0, cleanup: [],
    scope: 'Actual edge API and object delivery. No browser chat workflow, subscription changes, or synthetic model calls.' };
let csrf, tail;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checkpoint = async () => writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
const pass = name => { evidence.checks.push(name); console.log(`PASS: ${name}`); };

async function send(route, { body, authenticated = true, headers = {} } = {}) {
    const url = new URL(route, base);
    assert.equal(url.origin, base, 'Instance credentials must never leave the verified origin.');
    const started = performance.now();
    const entry = { path: url.pathname, method: body === undefined ? 'GET' : 'POST', startedAt: new Date().toISOString() };
    evidence.requests.push(entry);
    await checkpoint();
    let response, bytes;
    try {
        response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(120000),
        headers: { ...(authenticated ? owner.headers : {}),
            'X-STWorkers-P4': runId,
            ...(body === undefined ? {} : { Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }),
            ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        Object.assign(entry, { status: response.status, headersMs: Math.round(performance.now() - started),
            ray: response.headers.get('cf-ray'), contentLength: response.headers.get('content-length'),
            contentType: response.headers.get('content-type'), contentEncoding: response.headers.get('content-encoding') });
        const chunks = [];
        entry.bytesReceived = 0;
        if (response.body) {
            const reader = response.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    entry.bytesReceived += value.length;
                    if (entry.bytesReceived > 32 * 1024 * 1024) {
                        await reader.cancel();
                        throw new Error('Response exceeds the verification size limit.');
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
        }
        bytes = Buffer.concat(chunks);
        entry.bytes = bytes.length;
    } catch (error) {
        entry.elapsedMs = Math.round(performance.now() - started);
        entry.failure = { name: error.name, causeCode: error.cause?.code ?? null };
        await checkpoint();
        throw error;
    }
    entry.elapsedMs = Math.round(performance.now() - started);
    let data;
    if (entry.contentType?.includes('json')) {
        try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Retain a non-JSON error without logging its body. */ }
    }
    if (data?.error?.code) entry.errorCode = data.error.code;
    await checkpoint();
    return { status: response.status, bytes, data, record: entry };
}
async function api(action, body, expected = 200) {
    const result = await send(`/api/extensions/${action}`, { body });
    assert.equal(result.status, expected, `${action}: HTTP ${result.status}, ${result.data?.error?.code ?? 'non-JSON error'}`);
    return result;
}

async function startTail() {
    tail = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'tail',
        '--config', path.join(directory, 'wrangler.json'), '--format', 'json',
        '--header', `x-stworkers-p4:${runId}`],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    evidence.tailCapture = { filteredByRunId: true, rawHeadersSaved: false, stderrBytes: 0 };
    tail.stderr.on('data', chunk => { evidence.tailCapture.stderrBytes += chunk.length; });
    tail.on('error', error => { evidence.tailCapture.error = error.code ?? error.name; });
    tail.on('exit', code => { evidence.tailCapture.exitCode = code; });
    const lines = createInterface({ input: tail.stdout });
    let buffer = '';
    lines.on('line', line => {
        if (!buffer && !line.startsWith('{')) return;
        buffer += line + '\n';
        if (buffer.length > 1024 * 1024) { buffer = ''; evidence.tailCapture.oversizedRecord = true; return; }
        let value;
        try { value = JSON.parse(buffer); } catch { return; }
        buffer = '';
        const request = value.event?.request;
        if (!request?.url) return;
        const header = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-stworkers-p4');
        if (header?.[1] !== runId) return;
        const record = { path: new URL(request.url).pathname, method: request.method, outcome: value.outcome,
            timestamp: value.eventTimestamp, cpuTime: value.cpuTime ?? null, wallTime: value.wallTime ?? null,
            exceptionNames: (value.exceptions ?? []).map(item => item.name), logCount: value.logs?.length ?? 0 };
        evidence.tail.push(record);
    });
    for (let attempt = 0; attempt < 4 && evidence.tail.length === 0; attempt++) {
        await delay(2500);
        await send('/api/stworks/status');
        await delay(500);
    }
    evidence.tailCapture.connected = evidence.tail.length > 0;
}
async function stopTail() {
    if (!tail) return;
    await delay(1500);
    if (tail.exitCode !== null) return;
    const exited = new Promise(resolve => tail.once('exit', resolve));
    tail.kill();
    await Promise.race([exited, delay(5000)]);
    if (tail.exitCode === null) {
        tail.kill('SIGKILL');
        await exited;
    }
}

async function baselineChecks() {
    for (const route of ['/', '/scripts/extensions.js', '/api/stworks/status',
        '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js']) {
        assert.equal((await send(route, { authenticated: false })).status, 401);
    }
    const token = await send('/csrf-token');
    assert.equal(token.status, 200);
    csrf = token.data.token;
    assert.match(csrf, /^[a-f0-9]{64}$/);
    pass('Existing authentication still protects frontend, APIs and plugin code');
    const status = await send('/api/stworks/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.readyForChat, false);
    assert.equal(status.data.phase, phase === 'before' ? 'P3-in-progress' : 'P4-in-progress');
    if (phase !== 'before') assert.equal(status.data.pluginDelivery.onlineManagement, true);
    evidence.appStatus = status.data;
    const discover = await api('discover');
    evidence.initialDiscovery = discover.data;
    for (const plugin of PLUGIN_BASELINES) {
        const resource = await send(`/scripts/extensions/third-party/${plugin.id}/manifest.json`);
        assert.equal(resource.status, 200);
        assert.equal(resource.data.version, plugin.version);
        evidence.plugins.push({ id: plugin.id, commit: plugin.commit, version: plugin.version, unchanged: true });
    }
    const frontend = await send('/scripts/extensions.js');
    assert.equal(frontend.status, 200);
    evidence.frontendSha256 = hash(frontend.bytes);
    evidence.expectedFrontendSha256 = hash(await readFile(path.join(root, '../public/scripts/extensions.js')));
    if (phase !== 'before') assert.equal(evidence.frontendSha256, evidence.expectedFrontendSha256);
    pass('Existing pinned plugins remain available and release gates stay explicit');
    if (phase !== 'before') {
        for (const [headers, code] of [[{ 'X-CSRF-Token': '' }, 'INVALID_CSRF_TOKEN'],
            [{ Origin: 'https://untrusted.example' }, 'CROSS_ORIGIN_WRITE']]) {
            const result = await send('/api/extensions/install', { body: { url: 'https://github.com/example/unused' }, headers });
            assert.equal(result.status, 403);
            assert.equal(result.data.error.code, code);
        }
        pass('New extension writes cannot bypass CSRF or origin checks');
    }
}

async function exercise(plugin) {
    const name = plugin.id;
    const body = { extensionName: name, global: true };
    const state = { id: name, globalInstall: false, localArchiveActive: false, outcomes: [] };
    evidence.pluginExercises ??= [];
    evidence.pluginExercises.push(state);
    let globalAttempted = false;
    try {
        // Never replace an existing global plugin. Local bundled code stays preferred throughout this test.
        await api('version', body, 404);
        globalAttempted = true;
        const response = await api('install', { url: `https://github.com/${plugin.repository}`, branch: plugin.commit, global: true });
        state.globalInstall = true;
        assert.equal(response.data.version, plugin.version);
        state.outcomes.push('global-install');
        const installed = await api('version', body);
        assert.equal(installed.data.currentCommitHash, plugin.commit);
        assert.equal(installed.data.refKind, 'commit');
        assert.equal((await api('update', body)).data.isUpToDate, true);
        state.outcomes.push('fixed-commit-query-and-update');
        // A real ancestor gives a distinct archive snapshot without publishing or moving an upstream ref.
        const parentResponse = await fetch(`https://api.github.com/repos/${plugin.repository}/git/commits/${plugin.commit}`,
            { redirect: 'manual', headers: { 'User-Agent': 'STWorkers-P4-cloud-verification' }, signal: AbortSignal.timeout(45000) });
        assert.equal(parentResponse.status, 200);
        const parent = (await parentResponse.json()).parents?.[0]?.sha;
        assert.match(parent, /^[a-f0-9]{40}$/);
        state.alternateCommit = parent;
        await api('switch', { ...body, branch: parent }, 204);
        assert.equal((await api('version', body)).data.currentCommitHash, parent);
        state.outcomes.push('distinct-snapshot-switch');
        await api('rollback', body);
        assert.equal((await api('version', body)).data.currentCommitHash, plugin.commit);
        state.outcomes.push('global-rollback');
        pass(`${name}: edge install, immutable update, snapshot switch and rollback`);
        // Replace local delivery only with the identical pinned source, then restore its bundled pointer.
        const local = await api('version', { extensionName: name });
        assert.equal(local.data.currentCommitHash, plugin.commit);
        assert.equal(local.data.refKind, 'bundled', 'Do not replace an owner-managed local plugin.');
        assert.equal(local.data.canRollback, false, 'Do not replace a previous owner-managed snapshot.');
        state.localArchiveActive = true;
        await checkpoint();
        await api('switch', { extensionName: name, branch: plugin.commit }, 204);
        const source = await send(`/scripts/extensions/third-party/${name}/__source.zip`);
        assert.equal(source.status, 200);
        assert.equal(hash(source.bytes), plugin.sha256);
        const manifest = await send(`/scripts/extensions/third-party/${name}/manifest.json`);
        assert.equal(manifest.data.version, plugin.version);
        for (const file of [manifest.data.js, manifest.data.css].filter(Boolean)) {
            const resource = await send(`/scripts/extensions/third-party/${name}/${file}`);
            assert.equal(resource.status, 200);
            const reference = await readFile(path.join(root, '.build/assets-p3/scripts/extensions/third-party', name, file));
            assert.equal(hash(resource.bytes), hash(reference));
        }
        state.outcomes.push('edge-archive-source-and-entrypoints');
        await api('rollback', { extensionName: name });
        state.localArchiveActive = false;
        state.localArchiveRetainedAsPrevious = true;
        state.outcomes.push('restore-bundled-local');
        pass(`${name}: authenticated R2 archive assets match the original bytes; bundled version restored`);
        state.passed = true;
    } catch (error) {
        state.passed = false;
        state.error = error.message;
        console.log(`FAIL: ${name}: ${error.message}`);
    } finally {
        if (state.localArchiveActive) {
            try {
                const current = await api('version', { extensionName: name });
                assert.equal(current.data.currentCommitHash, plugin.commit);
                if (current.data.refKind === 'commit') {
                    await api('rollback', { extensionName: name });
                    state.localArchiveRetainedAsPrevious = true;
                } else assert.equal(current.data.refKind, 'bundled');
                state.localArchiveActive = false;
                evidence.cleanup.push({ id: name, action: 'restore-bundled-local', passed: true });
            } catch (error) { evidence.cleanup.push({ id: name, action: 'restore-bundled-local', passed: false, error: error.message }); }
        }
        if (globalAttempted) {
            try {
                const current = await send('/api/extensions/version', { body });
                if (current.status === 404 && current.data?.error?.code === 'EXTENSION_NOT_FOUND') {
                    evidence.cleanup.push({ id: name, action: 'global-test-copy-absent', passed: true });
                } else {
                    assert.equal(current.status, 200);
                    assert.ok([plugin.commit, state.alternateCommit].includes(current.data.currentCommitHash),
                        'The global plugin changed independently; do not remove it.');
                    await api('delete', body);
                    await api('cleanup', body, 204);
                    await api('version', body, 404);
                    evidence.cleanup.push({ id: name, action: 'delete-global-test-copy', passed: true });
                }
            } catch (error) { evidence.cleanup.push({ id: name, action: 'delete-global-test-copy', passed: false, error: error.message }); }
        }
        await checkpoint();
    }
}

async function recover() {
    const previousRunId = process.argv[3];
    assert.match(previousRunId, /^[a-f0-9-]{36}$/);
    const previous = JSON.parse(await readFile(path.join(root, '.build/p4-cloud', previousRunId, 'results.json'), 'utf8'));
    assert.equal(previous.origin, base);
    assert.ok(['exercise', 'delivery'].includes(previous.phase));
    evidence.recoveryOf = previousRunId;
    for (const state of previous.pluginExercises.filter(item => item.localArchiveActive)) {
        const plugin = PLUGIN_BASELINES.find(item => item.id === state.id);
        assert.ok(plugin);
        const current = await api('version', { extensionName: state.id });
        assert.equal(current.data.currentCommitHash, plugin.commit);
        if (current.data.refKind === 'commit') {
            assert.equal(current.data.canRollback, true);
            await api('rollback', { extensionName: state.id });
        } else assert.equal(current.data.refKind, 'bundled', 'The owner changed this plugin; do not alter it.');
        const restored = await api('version', { extensionName: state.id });
        assert.equal(restored.data.refKind, 'bundled');
        assert.equal(restored.data.currentCommitHash, plugin.commit);
        evidence.cleanup.push({ id: state.id, action: 'restore-bundled-local', passed: true });
        pass(`${state.id}: bundled pointer restored after interrupted test`);
    }
    assert.deepEqual((await api('discover')).data, previous.initialDiscovery);
}

async function checkExistingDelivery() {
    const plugin = PLUGIN_BASELINES.find(item => item.id === process.argv[3]);
    assert.ok(plugin, 'Choose a locked plugin explicitly.');
    const sql = `SELECT json_extract(payload, '$.current.kind') AS current_kind,
        json_extract(payload, '$.current.commit') AS current_commit,
        json_extract(payload, '$.previous.kind') AS previous_kind,
        json_extract(payload, '$.previous.commit') AS previous_commit,
        json_extract(payload, '$.previous.archiveSha256') AS previous_sha256
        FROM documents WHERE kind = 'extension' AND id = 'local/${plugin.id.toLowerCase()}';`;
    const query = await promisify(execFile)(process.execPath,
        [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--remote',
            '--config', path.join(directory, 'wrangler.json'), '--command', sql, '--json'],
        { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 90000 });
    const metadata = JSON.parse(query.stdout)[0].results[0];
    assert.deepEqual(metadata, { current_kind: 'bundled', current_commit: plugin.commit,
        previous_kind: 'archive', previous_commit: plugin.commit, previous_sha256: plugin.sha256 });
    const state = { id: plugin.id, localArchiveActive: true };
    evidence.pluginExercises = [state];
    evidence.storedArchiveVerified = { commit: plugin.commit, sha256: plugin.sha256 };
    await checkpoint();
    try {
        await api('rollback', { extensionName: plugin.id });
        const current = await api('version', { extensionName: plugin.id });
        assert.equal(current.data.refKind, 'commit');
        assert.equal(current.data.currentCommitHash, plugin.commit);
        const manifest = await send(`/scripts/extensions/third-party/${plugin.id}/manifest.json`);
        assert.equal(manifest.status, 200);
        for (const file of [manifest.data.js, manifest.data.css].filter(Boolean)) {
            const resource = await send(`/scripts/extensions/third-party/${plugin.id}/${file}`);
            assert.equal(resource.status, 200);
            const reference = await readFile(path.join(root, '.build/assets-p3/scripts/extensions/third-party', plugin.id, file));
            assert.equal(hash(resource.bytes), hash(reference));
        }
        state.passed = true;
        pass(`${plugin.id}: edge R2 runtime entrypoints match the original files`);
    } finally {
        const current = await api('version', { extensionName: plugin.id });
        assert.equal(current.data.currentCommitHash, plugin.commit);
        if (current.data.refKind === 'commit') await api('rollback', { extensionName: plugin.id });
        else assert.equal(current.data.refKind, 'bundled');
        state.localArchiveActive = false;
        state.localArchiveRetainedAsPrevious = true;
        evidence.cleanup.push({ id: plugin.id, action: 'restore-bundled-local', passed: true });
        await checkpoint();
    }
    assert.equal((await api('version', { extensionName: plugin.id })).data.refKind, 'bundled');
}

await mkdir(output, { recursive: true });
try {
    if (['exercise', 'after', 'recover'].includes(phase)) await startTail();
    await baselineChecks();
    if (phase === 'recover') await recover();
    if (phase === 'delivery') await checkExistingDelivery();
    if (phase === 'exercise') {
        for (const plugin of PLUGIN_BASELINES) await exercise(plugin);
        assert.ok(evidence.pluginExercises.every(item => item.passed), 'One or more edge plugin checks failed.');
        assert.ok(evidence.cleanup.every(item => item.passed), 'A test cleanup requires attention.');
        assert.deepEqual((await api('discover')).data, evidence.initialDiscovery);
    }
    evidence.passed = true;
} catch (error) {
    evidence.passed = false;
    evidence.error = { name: error.name, message: error.message };
    console.log(`FAIL: ${error.message}`);
    process.exitCode = 1;
} finally {
    await stopTail();
    evidence.finishedAt = new Date().toISOString();
    evidence.cpuMetricsAvailable = evidence.tail.some(item => typeof item.cpuTime === 'number');
    await checkpoint();
    console.log(`Evidence: ${path.join(output, 'results.json')}`);
}
