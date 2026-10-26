import test from 'node:test';
import assert from 'node:assert/strict';
import { createHfApiBackend, HF_ROUTER_URL } from '../lib/llm/hf-api.js';
import { createLocalBackend } from '../lib/llm/hf-local.js';
import { createLlm } from '../lib/llm/index.js';

const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  impl.calls = calls;
  return impl;
}

const base = { token: 'hf_testtoken0123456789', textModel: 'org/text-model', visionModel: 'org/vision-model' };

test('sends an OpenAI-style chat request to the Hugging Face router', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(reply('hello')));
  const llm = createHfApiBackend({ ...base, fetchImpl });
  const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, temperature: 0 });
  assert.deepEqual(result, { text: 'hello', model: 'org/text-model' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, HF_ROUTER_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Bearer hf_testtoken0123456789');
  assert.deepEqual(call.body, { model: 'org/text-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, temperature: 0, stream: false });
});

test('uses the vision model only when a screenshot is attached and vision is on', async () => {
  const withImage = [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
  const on = recordingFetch(() => jsonResponse(reply('ok')));
  const llmOn = createHfApiBackend({ ...base, useVision: true, fetchImpl: on });
  assert.equal(llmOn.supportsVision, true);
  await llmOn.chat({ messages: withImage });
  await llmOn.chat({ messages: [{ role: 'user', content: 'plain' }] });
  assert.deepEqual(on.calls.map((c) => c.body.model), ['org/vision-model', 'org/text-model']);

  const off = recordingFetch(() => jsonResponse(reply('ok')));
  const llmOff = createHfApiBackend({ ...base, useVision: false, fetchImpl: off });
  assert.equal(llmOff.supportsVision, false);
  await llmOff.chat({ messages: withImage });
  assert.equal(off.calls[0].body.model, 'org/text-model');
  assert.equal(JSON.stringify(off.calls[0].body).includes('image_url'), false);
});

test('explains a missing token without calling the network', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(reply('x')));
  const llm = createHfApiBackend({ ...base, token: '', fetchImpl });
  await assert.rejects(llm.chat({ messages: [] }), /Add your Hugging Face token/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('maps Hugging Face errors to clear messages and marks transient ones retryable', async () => {
  const cases = [
    [401, /rejected the token/, false],
    [402, /no Inference Providers credits/, false],
    [429, /rate limiting/, true],
    [404, /could not run "org\/text-model".*another model/, false],
    [503, /HTTP 503/, true]
  ];
  for (const [status, pattern, retryable] of cases) {
    const llm = createHfApiBackend({ ...base, fetchImpl: recordingFetch(() => jsonResponse({ error: { message: 'detail' } }, status)) });
    await assert.rejects(llm.chat({ messages: [] }), (error) => {
      assert.match(error.message, pattern);
      assert.equal(Boolean(error.retryable), retryable, `status ${status}`);
      return true;
    });
  }
});

test('treats an empty reply as an error', async () => {
  const llm = createHfApiBackend({ ...base, fetchImpl: recordingFetch(() => jsonResponse(reply('   '))) });
  await assert.rejects(llm.chat({ messages: [] }), /empty reply/);
});

test('reads replies delivered as content parts', async () => {
  const llm = createHfApiBackend({ ...base, fetchImpl: recordingFetch(() => jsonResponse(reply([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]))) });
  assert.equal((await llm.chat({ messages: [] })).text, 'abcd');
});

test('a slow upstream times out with a retryable error; a user stop passes through', async () => {
  // A real hung socket keeps the event loop alive; this stand-in needs its own timer to do the same.
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  const slow = createHfApiBackend({ ...base, timeoutMs: 40, fetchImpl: hang });
  await assert.rejects(slow.chat({ messages: [] }), (error) => error.retryable === true && /longer than/.test(error.message));

  const controller = new AbortController();
  const stoppable = createHfApiBackend({ ...base, timeoutMs: 5000, fetchImpl: hang });
  const pending = stoppable.chat({ messages: [], signal: controller.signal });
  controller.abort(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a network failure is retryable', async () => {
  const llm = createHfApiBackend({ ...base, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(llm.chat({ messages: [] }), (error) => error.retryable === true && /Could not reach Hugging Face/.test(error.message));
});

test('local backend runs the injected pipeline and flattens image parts to text', async () => {
  const seen = [];
  const loader = async () => async (messages) => {
    seen.push(messages);
    return [{ generated_text: [...messages, { role: 'assistant', content: '{"ok":true}' }] }];
  };
  const llm = createLocalBackend({ model: 'local/test-model-1', loader });
  assert.equal(llm.supportsVision, false);
  const result = await llm.chat({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:x' } }] }]
  });
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(seen[0], [{ role: 'user', content: 'look' }]);
});

test('local backend loads the model once and reports a missing install clearly', async () => {
  let loads = 0;
  const loader = async () => { loads += 1; return async (m) => [{ generated_text: [...m, { role: 'assistant', content: 'x' }] }]; };
  const llm = createLocalBackend({ model: 'local/test-model-2', loader });
  await llm.chat({ messages: [{ role: 'user', content: 'a' }] });
  await llm.chat({ messages: [{ role: 'user', content: 'b' }] });
  assert.equal(loads, 1);

  const missing = createLocalBackend({ model: 'local/test-model-3' });
  await assert.rejects(missing.chat({ messages: [{ role: 'user', content: 'a' }] }), /npm run setup:local-model/);
});

test('createLlm picks the backend from settings', () => {
  assert.equal(createLlm({ backend: 'hf-api', hfToken: 'x', textModel: 't', visionModel: 'v' }).name, 'hf-api');
  assert.equal(createLlm({ backend: 'hf-local', localModel: 'm' }).name, 'hf-local');
});
