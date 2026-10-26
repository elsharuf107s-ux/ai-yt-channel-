import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server.js';
import { createConfigStore } from '../lib/config.js';
import { scriptedLlm, act, tmpDir, until } from './helpers.js';

const TOKEN = 'hf_testtoken0123456789';
const LIVE = ['running', 'awaiting_approval'];

async function boot({ replies = [act('finish', { summary: 'ok' })], env = { HF_TOKEN: TOKEN }, bridgeToken = '', llm } = {}) {
  const dir = tmpDir();
  const configStore = createConfigStore({ file: path.join(dir, 'config.json'), env });
  const model = llm || scriptedLlm(replies);
  const app = createApp({ configStore, createLlm: () => model, dataDir: dir, shellCwd: path.join(dir, 'ws'), bridgeToken });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  const finished = (id) => until(async () => {
    const { json } = await call('GET', `/api/runs/${id}`);
    return json && !LIVE.includes(json.status) ? json : null;
  }, { label: 'run to finish' });
  return { port, call, finished, model, dir, ws: path.join(dir, 'ws'), app, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

const rawGet = (port, pathname, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  }).on('error', reject);
});

test('only expected host names are served (DNS-rebinding guard)', async (t) => {
  const s = await boot();
  t.after(s.close);
  assert.equal(await rawGet(s.port, '/api/health', { Host: 'evil.example.com' }), 403);
  assert.equal(await rawGet(s.port, '/api/health', { Host: `localhost:${s.port}` }), 200);
  assert.equal(await rawGet(s.port, '/api/health', { Host: 'my-codespace-3000.app.github.dev' }), 200);
  assert.equal(await rawGet(s.port, '/api/health', { Host: 'github.dev.evil.com' }), 403);
});

test('writes need the app header, so another website cannot trigger them', async (t) => {
  const s = await boot();
  t.after(s.close);
  const forged = await fetch(`http://127.0.0.1:${s.port}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example.com' },
    body: JSON.stringify({ task: 'do something bad' })
  });
  assert.equal(forged.status, 403);
  const noHeader = await fetch(`http://127.0.0.1:${s.port}/api/runs/x/stop`, { method: 'POST' });
  assert.equal(noHeader.status, 403);
  assert.equal(s.model.calls.length, 0);
});

test('pages are served with a strict content security policy', async (t) => {
  const s = await boot();
  t.after(s.close);
  const home = await s.call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>AI Shell<\/title>/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  const shared = await s.call('GET', '/shared/duration.js');
  assert.match(shared.headers.get('content-type'), /javascript/);
  assert.match(shared.text, /export function parseTimePlan/);
});

test('settings are saved, masked, and never echoed back in full', async (t) => {
  const s = await boot({ env: {} });
  t.after(s.close);
  const before = await s.call('GET', '/api/settings');
  assert.equal(before.json.hfToken.set, false);
  const saved = await s.call('PATCH', '/api/settings', { hfToken: 'hf_abcdefghijklmnopqrstuvwxyz', autonomy: 'strict', maxSteps: 25 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.autonomy, 'strict');
  assert.equal(saved.text.includes('abcdefghijklmnopqrstuvwxyz'), false);
  const health = await s.call('GET', '/api/health');
  assert.equal(health.json.configured, true);
  assert.equal(health.text.includes('abcdefghijklmnopqrstuvwxyz'), false);
  const bad = await s.call('PATCH', '/api/settings', { autonomy: 'yolo' });
  assert.equal(bad.status, 400);
});

test('refuses to start without a Hugging Face token and explains why', async (t) => {
  const s = await boot({ env: {} });
  t.after(s.close);
  const result = await s.call('POST', '/api/runs', { task: 'do it' });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /Hugging Face token/);
  assert.equal((await s.call('POST', '/api/runs', { task: '   ' })).status, 400);
});

test('runs a task end to end and reports progress incrementally', async (t) => {
  const s = await boot({ replies: [act('shell', { command: 'echo hi from the workspace' }), act('finish', { summary: 'The workspace said hi.' })] });
  t.after(s.close);
  const started = await s.call('POST', '/api/runs', { task: 'Say hi from the shell' });
  assert.equal(started.status, 202);
  const done = await s.finished(started.json.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.summary, 'The workspace said hi.');
  assert.deepEqual(done.events.map((e) => e.type).filter((x) => ['action', 'observation', 'final', 'done'].includes(x)), ['action', 'observation', 'final', 'done']);
  const tail = await s.call('GET', `/api/runs/${done.id}?after=${done.lastSeq - 1}`);
  assert.equal(tail.json.events.length, 1);
  assert.equal(tail.json.events[0].type, 'done');
  assert.equal((await s.call('GET', '/api/runs')).json[0].id, done.id);
  assert.equal((await s.call('GET', '/api/runs/nope')).status, 404);
});

test('a time limit comes from the prompt, or from the field, which wins', async (t) => {
  const s = await boot({ replies: [act('finish', { summary: 'x' })] });
  t.after(s.close);
  const fromPrompt = await s.call('POST', '/api/runs', { task: 'Watch example.com for 20 minutes, check every 5 minutes' });
  assert.equal(fromPrompt.json.options.minutes, 20);
  assert.equal(fromPrompt.json.options.minutesSource, 'prompt');
  assert.equal(fromPrompt.json.options.everyMinutes, 5);
  assert.ok(fromPrompt.json.options.maxSteps >= 150);
  assert.ok(fromPrompt.json.deadline);
  await s.finished(fromPrompt.json.id);

  const fromField = await s.call('POST', '/api/runs', { task: 'Watch example.com for 20 minutes', minutes: 7 });
  assert.equal(fromField.json.options.minutes, 7);
  assert.equal(fromField.json.options.minutesSource, 'field');
  await s.finished(fromField.json.id);

  const none = await s.call('POST', '/api/runs', { task: 'Read example.com', startUrl: 'example.com' });
  assert.equal(none.json.options.minutes, null);
  assert.equal(none.json.options.startUrl, 'https://example.com/');
  await s.finished(none.json.id);

  assert.equal((await s.call('POST', '/api/runs', { task: 'x', minutes: 9999 })).status, 400);
  assert.equal((await s.call('POST', '/api/runs', { task: 'x', startUrl: 'ftp://example.com' })).status, 400);
});

test('approving over HTTP lets a risky command run; denying keeps it from running', async (t) => {
  const s = await boot({ replies: [act('shell', { command: 'touch approved.txt' }), act('finish', { summary: 'done' })] });
  t.after(s.close);
  const first = await s.call('POST', '/api/runs', { task: 'Create a file' });
  const waiting = await until(async () => {
    const { json } = await s.call('GET', `/api/runs/${first.json.id}`);
    return json.pending.length ? json : null;
  }, { label: 'approval request' });
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(waiting.pending[0].summary, 'Run: touch approved.txt');
  assert.equal(fs.existsSync(path.join(s.ws, 'approved.txt')), false);
  assert.equal((await s.call('POST', `/api/runs/${first.json.id}/approvals/${waiting.pending[0].id}`, { decision: 'maybe' })).status, 400);
  assert.equal((await s.call('POST', `/api/runs/${first.json.id}/approvals/not-real`, { decision: 'approve' })).status, 404);
  assert.equal((await s.call('POST', `/api/runs/${first.json.id}/approvals/${waiting.pending[0].id}`, { decision: 'approve' })).status, 200);
  assert.equal((await s.finished(first.json.id)).status, 'completed');
  assert.equal(fs.existsSync(path.join(s.ws, 'approved.txt')), true);

  const second = await boot({ replies: [act('shell', { command: 'touch denied.txt' }), act('finish', { summary: 'ok, not done' })] });
  t.after(second.close);
  const run = await second.call('POST', '/api/runs', { task: 'Create a file' });
  const pending = await until(async () => (await second.call('GET', `/api/runs/${run.json.id}`)).json.pending[0], { label: 'approval request' });
  await second.call('POST', `/api/runs/${run.json.id}/approvals/${pending.id}`, { decision: 'deny' });
  const done = await second.finished(run.json.id);
  assert.equal(done.summary, 'ok, not done');
  assert.equal(fs.existsSync(path.join(second.ws, 'denied.txt')), false);
  assert.ok(done.events.some((e) => e.type === 'approval_result' && e.decision === 'denied'));
});

test('Stop ends a long wait right away, and only one task runs at a time', async (t) => {
  const s = await boot({ replies: [act('wait', { seconds: 120 })] });
  t.after(s.close);
  const run = await s.call('POST', '/api/runs', { task: 'Watch something for 30 minutes' });
  const clash = await s.call('POST', '/api/runs', { task: 'another' });
  assert.equal(clash.status, 409);
  const started = Date.now();
  await s.call('POST', `/api/runs/${run.json.id}/stop`);
  const done = await s.finished(run.json.id);
  assert.equal(done.status, 'stopped');
  assert.ok(Date.now() - started < 3000);
  assert.equal((await s.call('GET', '/api/health')).json.activeRunId, null);
});

test('bridge endpoints hand browser tasks to the local helper and take results back', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { bridge } = s.app.locals.deps;
  assert.equal((await s.call('GET', '/api/health')).json.bridge.online, false);
  await s.call('POST', '/api/bridge/heartbeat', { bridgeId: 'laptop', mode: 'playwright-headed', version: '0.1.0' });
  assert.equal((await s.call('GET', '/api/health')).json.bridge.online, true);
  assert.equal((await s.call('POST', '/api/bridge/claim', { bridgeId: 'laptop' })).status, 204);

  const pending = bridge.enqueue({ tool: 'snapshot', args: {} });
  const claimed = await s.call('POST', '/api/bridge/claim', { bridgeId: 'laptop' });
  assert.equal(claimed.json.action.tool, 'snapshot');
  const completed = await s.call('POST', `/api/bridge/tasks/${claimed.json.id}/complete`, { ok: true, result: { url: 'https://x.test/' } });
  assert.equal(completed.json.accepted, true);
  assert.deepEqual(await pending, { url: 'https://x.test/' });
});

test('a bridge token, when configured, is required and compared safely', async (t) => {
  const s = await boot({ bridgeToken: 'shared-secret-123' });
  t.after(s.close);
  assert.equal((await s.call('POST', '/api/bridge/heartbeat', {})).status, 401);
  assert.equal((await s.call('POST', '/api/bridge/heartbeat', {}, { 'x-bridge-token': 'wrong' })).status, 401);
  assert.equal((await s.call('POST', '/api/bridge/claim', {}, { 'x-bridge-token': 'shared-secret-123x' })).status, 401);
  assert.equal((await s.call('POST', '/api/bridge/heartbeat', {}, { 'x-bridge-token': 'shared-secret-123' })).status, 200);
});

test('Improve prompt rewrites a rough idea; the model test checks the connection', async (t) => {
  const s = await boot({ replies: ['"Go to example.com. Read the heading. Report it."'] });
  t.after(s.close);
  const improved = await s.call('POST', '/api/prompt/improve', { text: 'look at example.com', startUrl: 'example.com' });
  assert.equal(improved.json.prompt, 'Go to example.com. Read the heading. Report it.');
  assert.match(s.model.calls[0][1].content, /look at example\.com[\s\S]*Website: example\.com/);
  assert.equal((await s.call('POST', '/api/prompt/improve', { text: '  ' })).status, 400);

  const probe = await boot({ replies: ['OK'] });
  t.after(probe.close);
  const tested = await probe.call('POST', '/api/settings/test', {});
  assert.deepEqual(tested.json, { ok: true, model: 'scripted', reply: 'OK' });
});

test('screenshots return nothing until the browser has produced one; unknown routes are JSON 404s', async (t) => {
  const s = await boot();
  t.after(s.close);
  const run = await s.call('POST', '/api/runs', { task: 'x' });
  await s.finished(run.json.id);
  assert.equal((await s.call('GET', `/api/runs/${run.json.id}/screenshot`)).status, 204);
  const missing = await s.call('GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'Not found');
  const broken = await fetch(`http://127.0.0.1:${s.port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' }, body: '{nope' });
  assert.equal(broken.status, 400);
});
