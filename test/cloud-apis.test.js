// Claude (through the official Anthropic SDK) and ChatGPT (OpenAI Chat Completions).
// The SDK is real; the network is a fake fetch, so request shapes are checked exactly as sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAnthropicBackend, toAnthropicMessages, FALLBACK_BETA } from '../lib/llm/anthropic.js';
import { createOpenAiBackend } from '../lib/llm/openai.js';
import { createLlm } from '../lib/llm/index.js';
import { createConfigStore, credentialProblem } from '../lib/config.js';
import { createApp } from '../server.js';
import { runAgent } from '../lib/agent.js';
import { act, tmpDir, until, collector } from './helpers.js';

const KEY = 'sk-ant-api03-testkey0123456789abcdef';
const OAI_KEY = 'sk-proj-testkey0123456789abcdefghij';

const claudeReply = (content, extra = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, ...extra
});
const claudeError = (status, type, message) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch that records every request and answers from `respond(callNumber)`. */
function recorder(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
    return respond(calls.length);
  };
  impl.calls = calls;
  return impl;
}

const claude = (fetchImpl, extra = {}) => createAnthropicBackend({ apiKey: KEY, model: 'claude-opus-5-5', fetchImpl, maxRetries: 0, ...extra });

/* ---------------- Claude ---------------- */

test('Claude: messages are converted to what the Messages API accepts', () => {
  const converted = toAnthropicMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'task' },
    { role: 'user', content: '   ' },
    { role: 'user', content: [{ type: 'text', text: 'observation' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] },
    { role: 'assistant', content: '{"a":1}' },
    { role: 'user', content: 'next' }
  ], { images: true });
  assert.equal(converted.system, 'Be brief.');
  assert.deepEqual(converted.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(converted.messages[0].content, [
    { type: 'text', text: 'task' },
    { type: 'text', text: 'observation' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
  ]);
  const noImages = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] }]);
  assert.deepEqual(noImages.messages[0].content, [{ type: 'text', text: 'x' }]);
});

test('Claude: a plain request goes to /v1/messages with the key as a bearer token, no sampling parameters, no fallbacks', async () => {
  const fetchImpl = recorder(() => json(claudeReply('hello')));
  const llm = claude(fetchImpl, { model: 'claude-haiku-4-5' });
  assert.equal(llm.supportsVision, false);
  const result = await llm.chat({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
  assert.deepEqual(result, { text: 'hello', model: 'claude-opus-5-5' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
  assert.ok(call.headers.get('anthropic-version'));
  assert.equal(call.headers.get('anthropic-beta'), null);
  assert.deepEqual(call.body, { model: 'claude-haiku-4-5', max_tokens: 16000, system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks']) assert.equal(forbidden in call.body, false, forbidden);
});

test('Claude: on the current models a declined request is retried on a fallback model, and this can be switched off', async () => {
  const on = recorder(() => json(claudeReply('ok')));
  await claude(on).chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(on.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(on.calls[0].headers.get('anthropic-beta'), FALLBACK_BETA);
  assert.equal(on.calls[0].body.fallbacks, 'default');
  assert.equal('betas' in on.calls[0].body, false);

  const off = recorder(() => json(claudeReply('ok')));
  await claude(off, { fallbacks: false }).chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(off.calls[0].headers.get('anthropic-beta'), null);
  assert.equal('fallbacks' in off.calls[0].body, false);

  const haiku = recorder(() => json(claudeReply('ok')));
  await claude(haiku, { model: 'claude-haiku-5-5' }).chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('fallbacks' in haiku.calls[0].body, false, 'Haiku has no server-side fallback');
  assert.equal(haiku.calls[0].headers.get('anthropic-beta'), null);
});

test('Claude: screenshots are sent as image blocks only when enabled', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }];
  const seeing = recorder(() => json(claudeReply('ok')));
  const llm = claude(seeing, { useVision: true });
  assert.equal(llm.supportsVision, true);
  await llm.chat({ messages });
  assert.equal(seeing.calls[0].body.messages[0].content[1].type, 'image');

  const blind = recorder(() => json(claudeReply('ok')));
  await claude(blind).chat({ messages });
  assert.equal(JSON.stringify(blind.calls[0].body).includes('"image"'), false);
});

test('Claude: only the text blocks are the answer, and reasoning is ignored', async () => {
  const llm = claude(recorder(() => json(claudeReply([
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text: '<think>aside</think>{"ok":' },
    { type: 'text', text: 'true}' }
  ]))));
  assert.equal((await llm.chat({ messages: [{ role: 'user', content: 'hi' }] })).text, '{"ok":true}');
});

test('Claude: refusals and empty answers become clear errors', async () => {
  const refused = claude(recorder(() => json(claudeReply([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Looks like exploit work.' } }))));
  await assert.rejects(refused.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => {
    assert.match(error.message, /Claude declined this request \(cyber\)\. Looks like exploit work\./);
    assert.equal(Boolean(error.retryable), false);
    return true;
  });
  const thinkingOnly = claude(recorder(() => json(claudeReply([{ type: 'thinking', thinking: '', signature: 'x' }], { stop_reason: 'max_tokens' }))));
  await assert.rejects(thinkingOnly.chat({ messages: [{ role: 'user', content: 'x' }] }), /whole output limit thinking/);
  const empty = claude(recorder(() => json(claudeReply([]))));
  await assert.rejects(empty.chat({ messages: [{ role: 'user', content: 'x' }] }), /empty reply/);
});

test('Claude: errors name what to fix, and only transient ones are retryable', async () => {
  const cases = [
    [claudeError(401, 'authentication_error', 'invalid x-api-key'), /rejected the API key/, false],
    [claudeError(403, 'permission_error', 'no access to model'), /denied this key access.*no access to model/, false],
    [claudeError(404, 'not_found_error', 'model: nope'), /could not find the model/, false],
    [claudeError(429, 'rate_limit_error', 'slow down'), /rate limiting/, true],
    [claudeError(400, 'invalid_request_error', 'Your credit balance is too low'), /rejected the request: Your credit balance is too low/, false],
    [claudeError(402, 'billing_error', 'pay up'), /billing problem/, false],
    [claudeError(500, 'api_error', 'boom'), /HTTP 500/, true],
    [claudeError(529, 'overloaded_error', 'Overloaded'), /HTTP 529/, true]
  ];
  for (const [response, pattern, isRetryable] of cases) {
    const llm = claude(recorder(() => response));
    await assert.rejects(llm.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => {
      assert.match(error.message, pattern);
      assert.equal(Boolean(error.retryable), isRetryable, `HTTP ${response.status}`);
      return true;
    });
  }
  const offline = claude(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => error.retryable === true && /Could not reach Anthropic/.test(error.message));
});

test('Claude: a missing key never touches the network, and Stop is honoured', async () => {
  const fetchImpl = recorder(() => json(claudeReply('x')));
  await assert.rejects(claude(fetchImpl, { apiKey: '' }).chat({ messages: [{ role: 'user', content: 'x' }] }), /Add your Anthropic API key/);
  assert.equal(fetchImpl.calls.length, 0);

  const hang = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new DOMException('Aborted', 'AbortError')); });
  });
  const controller = new AbortController();
  const pending = claude(hang).chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('Claude: a whole agent task runs through the SDK, with strictly alternating turns', async () => {
  const replies = [JSON.stringify(act('shell', { command: 'echo hello from claude' })), JSON.stringify(act('finish', { summary: 'Claude saw hello.' }))];
  const fetchImpl = recorder((n) => json(claudeReply(replies[n - 1])));
  const llm = createLlm({ backend: 'anthropic', anthropicKey: KEY, anthropicModel: 'claude-opus-5-5', anthropicFallbacks: true, useVision: false }, { fetchImpl, maxRetries: 0 });
  const events = collector();
  const result = await runAgent({
    task: 'say hello', options: { startUrl: null, minutes: null, everyMinutes: null, maxSteps: 5, autonomy: 'ask' },
    llm, bridge: null, shellCwd: tmpDir(), secrets: [KEY], signal: new AbortController().signal,
    emit: events.emit, requestApproval: async () => 'approved', setScreenshot() {}
  });
  assert.deepEqual(result, { status: 'completed', summary: 'Claude saw hello.' });
  const second = fetchImpl.calls[1].body;
  assert.deepEqual(second.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(JSON.stringify(second.messages[2]), /hello from claude/);
  assert.match(second.system, /You are AI Shell/);
});

/* ---------------- ChatGPT ---------------- */

const openai = (fetchImpl, extra = {}) => createOpenAiBackend({ apiKey: OAI_KEY, model: 'gpt-test', fetchImpl, ...extra });
const gptReply = (content, extra = {}) => ({ model: 'gpt-test-2026', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }] });

test('ChatGPT: requests use max_completion_tokens and send no temperature', async () => {
  const fetchImpl = recorder(() => json(gptReply('hello')));
  const llm = openai(fetchImpl);
  assert.equal(llm.supportsVision, false);
  const result = await llm.chat({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], maxTokens: 12, temperature: 0 });
  assert.deepEqual(result, { text: 'hello', model: 'gpt-test-2026' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.headers.get('authorization'), `Bearer ${OAI_KEY}`);
  assert.deepEqual(call.body, { model: 'gpt-test', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], max_completion_tokens: 8192 });
});

test('ChatGPT: screenshots are sent only when enabled, and reasoning is stripped', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }];
  const seeing = recorder(() => json(gptReply('<think>x</think>done')));
  const llm = openai(seeing, { useVision: true });
  assert.equal(llm.supportsVision, true);
  assert.equal((await llm.chat({ messages })).text, 'done');
  assert.equal(seeing.calls[0].body.messages[0].content[1].type, 'image_url');

  const blind = recorder(() => json(gptReply('ok')));
  await openai(blind).chat({ messages });
  assert.equal(JSON.stringify(blind.calls[0].body).includes('image_url'), false);
});

test('ChatGPT: errors name what to fix; "out of quota" is not retried but "slow down" is', async () => {
  const cases = [
    [401, { error: { message: 'bad key' } }, /rejected the API key/, false],
    [403, { error: { message: 'region' } }, /denied this key access: region/, false],
    [404, { error: { message: 'no such model' } }, /could not find the model "gpt-test"/, false],
    [429, { error: { code: 'insufficient_quota', message: 'quota' } }, /out of quota or credit/, false],
    [429, { error: { code: 'rate_limit_exceeded', message: 'slow' } }, /rate limiting/, true],
    [400, { error: { message: 'Unsupported parameter' } }, /rejected the request for "gpt-test": Unsupported parameter/, false],
    [503, { error: { message: 'busy' } }, /HTTP 503/, true]
  ];
  for (const [status, body, pattern, isRetryable] of cases) {
    await assert.rejects(openai(recorder(() => json(body, status))).chat({ messages: [] }), (error) => {
      assert.match(error.message, pattern);
      assert.equal(Boolean(error.retryable), isRetryable, `HTTP ${status} ${body.error.code ?? ''}`);
      return true;
    });
  }
});

test('ChatGPT: refusals, cut-off answers, empty replies, a missing key and network trouble', async () => {
  await assert.rejects(openai(recorder(() => json({ choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }))).chat({ messages: [] }), /declined this request: I cannot help/);
  await assert.rejects(openai(recorder(() => json(gptReply('', { finish_reason: 'length' })))).chat({ messages: [] }), /whole output limit/);
  await assert.rejects(openai(recorder(() => json(gptReply('  ')))).chat({ messages: [] }), /empty reply/);

  const unused = recorder(() => json(gptReply('x')));
  await assert.rejects(openai(unused, { apiKey: '' }).chat({ messages: [] }), /Add your OpenAI API key/);
  assert.equal(unused.calls.length, 0);

  await assert.rejects(openai(async () => { throw new TypeError('fetch failed'); }).chat({ messages: [] }), (error) => error.retryable === true && /Could not reach OpenAI/.test(error.message));
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  await assert.rejects(openai(hang, { timeoutMs: 40 }).chat({ messages: [] }), (error) => error.retryable === true && /longer than/.test(error.message));
  const controller = new AbortController();
  const pending = openai(hang).chat({ messages: [], signal: controller.signal });
  controller.abort(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
  await assert.rejects(pending, { name: 'AbortError' });
});

/* ---------------- settings and the whole app ---------------- */

test('each brain says exactly what it is missing', () => {
  assert.match(credentialProblem({ backend: 'hf-api', hfToken: '' }), /Hugging Face token/);
  assert.match(credentialProblem({ backend: 'anthropic', anthropicKey: '' }), /Anthropic API key.*ANTHROPIC_API_KEY/);
  assert.match(credentialProblem({ backend: 'openai', openaiKey: '' }), /OpenAI API key.*OPENAI_API_KEY/);
  assert.equal(credentialProblem({ backend: 'anthropic', anthropicKey: 'k' }), null);
  assert.equal(credentialProblem({ backend: 'gguf' }), null);
});

test('API keys come from the standard environment variables and are masked everywhere', async () => {
  const store = createConfigStore({ file: path.join(tmpDir(), 'c.json'), env: { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: OAI_KEY } });
  const config = await store.resolve();
  assert.equal(config.anthropicKey, KEY);
  assert.equal(config.sources.anthropicKey, 'env');
  assert.equal(config.anthropicModel, 'claude-opus-5-5');
  assert.equal(config.anthropicFallbacks, true);
  const view = await store.save({ backend: 'anthropic' });
  assert.equal(view.configured, true);
  assert.equal(JSON.stringify(view).includes('testkey0123456789'), false);
  assert.equal(view.anthropicKey.set, true);
  assert.equal(view.openaiKey.set, true);

  assert.equal((await store.save({ anthropicFallbacks: false })).anthropicFallbacks, false, 'false is a real setting, not "unset"');
  await assert.rejects(store.save({ anthropicKey: 'has space' }), /Anthropic API key/);
  await assert.rejects(store.save({ openaiModel: 'has space' }), /spaces/);
  await assert.rejects(store.save({ backend: 'gemini' }), /backend must be one of/);
});

async function bootApp(env, replies) {
  const dir = tmpDir();
  const configStore = createConfigStore({ file: path.join(dir, 'c.json'), env });
  const fetchImpl = recorder((n) => (fetchImpl.kind === 'anthropic' ? json(claudeReply(replies[Math.min(n, replies.length) - 1])) : json(gptReply(replies[Math.min(n, replies.length) - 1]))));
  const app = createApp({ configStore, dataDir: dir, shellCwd: path.join(dir, 'ws'), createLlm: (config) => createLlm(config, { fetchImpl, maxRetries: 0 }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { call, fetchImpl, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

const finished = (s, id) => until(async () => {
  const { json: run } = await s.call('GET', `/api/runs/${id}`);
  return run && !['running', 'awaiting_approval'].includes(run.status) ? run : null;
}, { label: 'run to finish' });

for (const [backend, kind, keyName, key, pattern] of [
  ['anthropic', 'anthropic', 'anthropicKey', KEY, /Anthropic API key/],
  ['openai', 'openai', 'openaiKey', OAI_KEY, /OpenAI API key/]
]) {
  test(`the app runs a task on the ${backend} brain, and its key never leaks`, async (t) => {
    const s = await bootApp({}, [
      JSON.stringify(act('shell', { command: 'echo working' })),
      JSON.stringify(act('finish', { summary: `The key I was given is ${key}` }))
    ]);
    s.fetchImpl.kind = kind;
    t.after(s.close);

    const missing = await s.call('POST', '/api/runs', { task: 'x' });
    assert.equal((await s.call('PATCH', '/api/settings', { backend })).status, 200);
    const refused = await s.call('POST', '/api/runs', { task: 'x' });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, pattern);
    assert.equal(missing.status, 400);

    const saved = await s.call('PATCH', '/api/settings', { [keyName]: key });
    assert.equal(saved.json.configured, true);
    assert.equal(saved.text.includes(key), false);
    const health = (await s.call('GET', '/api/health')).json;
    assert.equal(health.backend, backend);
    assert.equal(health.configured, true);
    assert.equal(JSON.stringify(health).includes(key), false);

    const run = await s.call('POST', '/api/runs', { task: 'Run echo and report' });
    assert.equal(run.status, 202);
    const done = await finished(s, run.json.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.events.filter((e) => e.type === 'error')));
    assert.match(done.summary, /The key I was given is \[redacted\]/);
    assert.equal(JSON.stringify(done).includes(key), false, 'the key must never appear in a run');
    assert.equal(s.fetchImpl.calls.length, 2);
  });
}
