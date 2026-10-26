import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerBackend, chatCompletionsUrl } from '../lib/llm/server.js';
import { createHfApiBackend } from '../lib/llm/hf-api.js';
import { stripReasoning } from '../lib/llm/common.js';
import { createLlm } from '../lib/llm/index.js';

const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const recording = (respond) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return respond(calls.length); };
  impl.calls = calls;
  return impl;
};
const base = { url: 'http://127.0.0.1:8080/v1', model: 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF' };

test('reasoning blocks are removed from replies', () => {
  assert.equal(stripReasoning('<think>hmm {"a":1}</think>{"b":2}'), '{"b":2}');
  assert.equal(stripReasoning('<think>one</think>A<think>two</think>B'), 'AB');
  assert.equal(stripReasoning('thinking out loud\n</think>\nThe answer'), 'The answer');
  assert.equal(stripReasoning('<think>never finished because the token limit hit'), '');
  assert.equal(stripReasoning('plain text'), 'plain text');
  assert.equal(stripReasoning(undefined), '');
});

test('the server address is turned into the chat endpoint', () => {
  assert.equal(chatCompletionsUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://host:11434/v1/'), 'http://host:11434/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://host:8080'), 'http://host:8080/chat/completions');
  assert.equal(chatCompletionsUrl('https://h/v1/chat/completions?x=1#y'), 'https://h/v1/chat/completions');
});

test('sends an OpenAI-style request, turning thinking off by default and adding no key header', async () => {
  const fetchImpl = recording(() => json(reply('hello')));
  const llm = createServerBackend({ ...base, fetchImpl });
  assert.equal(llm.supportsVision, false);
  const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, temperature: 0 });
  assert.deepEqual(result, { text: 'hello', model: base.model });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal('authorization' in call.init.headers, false);
  assert.deepEqual(call.body, {
    model: base.model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    temperature: 0,
    stream: false,
    chat_template_kwargs: { enable_thinking: false }
  });
});

test('with thinking on, the model gets room to think and is not told to stop', async () => {
  const fetchImpl = recording(() => json(reply('ok')));
  const llm = createServerBackend({ ...base, thinking: true, apiKey: 'sk-local-key-123456', fetchImpl });
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 12 });
  const [call] = fetchImpl.calls;
  assert.equal(call.body.max_tokens, 4096);
  assert.equal('chat_template_kwargs' in call.body, false);
  assert.equal(call.init.headers.authorization, 'Bearer sk-local-key-123456');
});

test('reasoning is dropped, and a reply that is only reasoning gets a useful error', async () => {
  const thoughtful = createServerBackend({ ...base, fetchImpl: recording(() => json(reply('<think>try {"x":1}</think>{"ok":true}'))) });
  assert.equal((await thoughtful.chat({ messages: [] })).text, '{"ok":true}');

  const cutOff = createServerBackend({ ...base, fetchImpl: recording(() => json(reply('<think>still thinking when the limit hit'))) });
  await assert.rejects(cutOff.chat({ messages: [] }), /only wrote its reasoning.*Turn thinking off/);

  const empty = createServerBackend({ ...base, fetchImpl: recording(() => json(reply('  '))) });
  await assert.rejects(empty.chat({ messages: [] }), /empty reply/);
});

test('hosted Hugging Face replies also have reasoning removed', async () => {
  const llm = createHfApiBackend({ token: 'hf_x0123456789', textModel: 'a/b', fetchImpl: recording(() => json(reply('<think>x</think>done'))) });
  assert.equal((await llm.chat({ messages: [] })).text, 'done');
});

test('screenshots are dropped because the server backend is text only', async () => {
  const fetchImpl = recording(() => json(reply('ok')));
  const llm = createServerBackend({ ...base, fetchImpl });
  await llm.chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:x' } }] }] });
  assert.equal(JSON.stringify(fetchImpl.calls[0].body).includes('image_url'), false);
});

test('errors say what to check, and transient ones are retryable', async () => {
  const cases = [
    [401, /rejected the API key/, false],
    [404, /answered 404.*end in \/v1/, false],
    [400, /could not run/, false],
    [503, /still be loading the model/, true],
    [500, /HTTP 500/, true]
  ];
  for (const [status, pattern, retryable] of cases) {
    const llm = createServerBackend({ ...base, fetchImpl: recording(() => json({ error: { message: 'detail' } }, status)) });
    await assert.rejects(llm.chat({ messages: [] }), (error) => {
      assert.match(error.message, pattern);
      assert.equal(Boolean(error.retryable), retryable, `status ${status}`);
      return true;
    });
  }
});

test('an unreachable server or a slow answer is reported clearly and can be retried', async () => {
  const refused = createServerBackend({ ...base, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(refused.chat({ messages: [] }), (error) => error.retryable === true && /Could not reach the model server.*ECONNREFUSED.*reach that address/.test(error.message));

  const hang = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  const slow = createServerBackend({ ...base, timeoutMs: 40, fetchImpl: hang });
  await assert.rejects(slow.chat({ messages: [] }), (error) => error.retryable === true && /longer than/.test(error.message));
});

test('createLlm builds the server and built-in model backends from settings', async () => {
  const server = createLlm({ backend: 'server', serverUrl: base.url, serverModel: 'm', serverKey: '', thinking: false });
  assert.equal(server.name, 'server');

  const states = { state: 'stopped' };
  const runner = { url: 'http://127.0.0.1:8081/v1', status: () => states };
  const fetchImpl = recording(() => json(reply('hi')));
  const gguf = createLlm({ backend: 'gguf', modelRepo: 'o/n', thinking: false }, { runner, fetchImpl });
  assert.equal(gguf.name, 'gguf');
  assert.match(gguf.describe(), /Built-in model · o\/n/);

  assert.throws(() => gguf.check(), /not running.*Start model/);
  states.state = 'starting';
  await assert.rejects(gguf.chat({ messages: [] }), /still starting/);
  states.state = 'failed';
  assert.throws(() => gguf.check(), /stopped.*read why/);
  assert.equal(fetchImpl.calls.length, 0);

  states.state = 'ready';
  assert.doesNotThrow(() => gguf.check());
  assert.equal((await gguf.chat({ messages: [{ role: 'user', content: 'x' }] })).text, 'hi');
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8081/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].body.model, 'o/n');

  assert.throws(() => createLlm({ backend: 'gguf' }), /runner is not available/);
});
