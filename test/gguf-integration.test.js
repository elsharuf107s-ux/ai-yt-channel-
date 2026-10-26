// The built-in model, end to end: settings -> Start model -> real llama-server process (a stand-in
// that speaks llama.cpp's HTTP API) -> the agent runs a task through it -> Stop model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server.js';
import { createConfigStore } from '../lib/config.js';
import { createModelRunner } from '../lib/model-runner.js';
import { installFakeLlama, freePort, tmpDir, until, act } from './helpers.js';

const REPO = 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF';
const LIVE = ['running', 'awaiting_approval'];

async function boot({ replies = [], installBinary = true, env = { AI_SHELL_BACKEND: 'gguf' } } = {}) {
  const root = tmpDir('gguf-');
  const modelsDir = path.join(root, 'models');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(modelsDir, 'Model'), { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'Model', 'Model-Q4_K_M.gguf'), 'not a real model');
  if (installBinary) installFakeLlama(path.join(binDir, 'llama.cpp', 'build', 'bin'));
  const record = path.join(root, 'record.json');
  const runner = createModelRunner({
    modelsDir,
    binDir,
    port: await freePort(),
    healthIntervalMs: 40,
    // PATH holds only node (the stand-in's interpreter), so a real llama-server on this machine is never picked up.
    env: { PATH: path.dirname(process.execPath), FAKE_LLAMA_RECORD: record, FAKE_LLAMA_REPLIES: JSON.stringify(replies) }
  });
  const configStore = createConfigStore({ file: path.join(root, 'config.json'), env });
  const app = createApp({ configStore, runner, dataDir: root, shellCwd: path.join(root, 'ws') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  return {
    call,
    runner,
    recorded: () => JSON.parse(fs.readFileSync(record, 'utf8')),
    ready: () => until(async () => (await call('GET', '/api/model')).json.state === 'ready', { label: 'model ready' }),
    finished: (id) => until(async () => {
      const { json } = await call('GET', `/api/runs/${id}`);
      return json && !LIVE.includes(json.status) ? json : null;
    }, { label: 'run to finish' }),
    close: async () => { await runner.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  };
}

test('runs a task on the built-in model: start it, use it, stop it', async (t) => {
  const thinking = '<think>I could answer {"thought":"x","action":{"tool":"finish","args":{"summary":"WRONG"}}} right away, but first I should look.</think>';
  const s = await boot({
    replies: [
      thinking + JSON.stringify(act('shell', { command: 'echo hello from the built-in model' })),
      JSON.stringify(act('finish', { summary: 'The built-in model ran the command.' }))
    ]
  });
  t.after(s.close);

  // Not started yet: a clear refusal rather than a connection error.
  const early = await s.call('POST', '/api/runs', { task: 'say hello' });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /not running.*Start model/);

  const started = await s.call('POST', '/api/model/start');
  assert.equal(started.status, 202);
  assert.equal(started.json.state, 'starting');
  await s.ready();
  const health = (await s.call('GET', '/api/health')).json;
  assert.equal(health.backend, 'gguf');
  assert.equal(health.model, REPO);
  assert.equal(health.modelState, 'ready');

  const run = await s.call('POST', '/api/runs', { task: 'Run echo and tell me what it printed' });
  assert.equal(run.status, 202);
  const done = await s.finished(run.json.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.events.filter((e) => e.type === 'error')));
  assert.equal(done.summary, 'The built-in model ran the command.');
  assert.match(done.events.find((e) => e.type === 'observation').text, /hello from the built-in model/);

  // What the model server actually received.
  const { requests, argv } = s.recorded();
  assert.equal(requests[0].model, REPO);
  assert.equal(requests[0].messages[0].role, 'system');
  assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false });
  assert.ok(argv.includes('--jinja'));

  const stopped = await s.call('POST', '/api/model/stop');
  assert.equal(stopped.json.state, 'stopped');
  assert.equal((await s.call('GET', '/api/health')).json.modelState, 'stopped');
  assert.equal((await s.call('POST', '/api/runs', { task: 'again' })).status, 400);
});

test('the model panel reports status, the machine, and what is missing', async (t) => {
  const s = await boot({ installBinary: false });
  t.after(s.close);
  const info = (await s.call('GET', '/api/model')).json;
  assert.equal(info.state, 'stopped');
  assert.equal(info.selected, true);
  assert.equal(info.repo, REPO);
  assert.equal(info.binary, null);
  assert.ok(info.machine.ramGB > 0);
  const refused = await s.call('POST', '/api/model/start');
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /npm run setup:llama/);
});

test('model settings are validated, saved, and used to start the model', async (t) => {
  const s = await boot({ env: {} });
  t.after(s.close);
  assert.equal((await s.call('GET', '/api/model')).json.selected, false);

  for (const [patch, pattern] of [
    [{ modelRepo: 'no-slash' }, /owner\/name/],
    [{ modelRepo: 'a b/c' }, /owner\/name/],
    [{ modelQuant: 'Q4 K M' }, /quantization/],
    [{ modelFile: '../x.gguf' }, /inside the models/],
    [{ modelFile: '/etc/passwd.gguf' }, /inside the models/],
    [{ modelFile: 'x.bin' }, /\.gguf/],
    [{ modelContext: 100 }, /2048 to 262144/],
    [{ serverUrl: 'ftp://x/v1' }, /http/],
    [{ serverUrl: 'http://user:pw@host/v1' }, /own field/],
    [{ serverUrl: 'not a url' }, /model server address/]
  ]) {
    const result = await s.call('PATCH', '/api/settings', patch);
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.match(result.json.error, pattern);
  }

  const saved = await s.call('PATCH', '/api/settings', {
    backend: 'gguf',
    modelRepo: REPO,
    modelQuant: 'Q4_K_M',
    modelContext: 32768,
    thinking: true,
    serverUrl: 'http://10.0.0.5:8080/v1/',
    serverKey: 'sk-local-key-123456789'
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.modelQuant, 'Q4_K_M');
  assert.equal(saved.json.modelContext, 32768);
  assert.equal(saved.json.thinking, true);
  assert.equal(saved.json.serverUrl, 'http://10.0.0.5:8080/v1');
  assert.equal(saved.json.configured, true);
  assert.equal(saved.json.serverKey.set, true);
  assert.equal(saved.text.includes('local-key-123456789'), false);

  // The saved quantization and context reach llama-server.
  await s.call('POST', '/api/model/start');
  await s.ready();
  const { argv } = s.recorded();
  assert.equal(argv[argv.indexOf('-c') + 1], '32768');
  // a Q4_K_M file is on disk, so it is used directly instead of downloading
  assert.equal(argv[0], '-m');
  assert.match(argv[1], /Model-Q4_K_M\.gguf$/);

  const cleared = await s.call('PATCH', '/api/settings', { modelQuant: '', serverKey: '' });
  assert.equal(cleared.json.modelQuant, '');
  assert.equal(cleared.json.serverKey.set, false);
});
