import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConfigStore, DEFAULTS } from '../lib/config.js';
import { tmpDir } from './helpers.js';

const store = (env = {}) => createConfigStore({ file: path.join(tmpDir(), 'c.json'), env });

test('the SC117 model is the built-in and server default', async () => {
  const config = await store().resolve();
  assert.equal(config.modelRepo, 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF');
  assert.equal(config.serverModel, config.modelRepo);
  assert.equal(config.modelContext, 16384);
  assert.equal(config.thinking, false);
  assert.equal(config.backend, 'hf-api', 'the default brain stays the hosted API, which works on any Codespace');
});

test('the built-in model and the server backend need no Hugging Face token', async () => {
  const s = store();
  assert.equal((await s.save({ backend: 'gguf' })).configured, true);
  assert.equal((await s.save({ backend: 'server' })).configured, true);
  assert.equal((await s.save({ backend: 'hf-api' })).configured, false);
});

test('environment variables can make the built-in model the default brain', async () => {
  const config = await store({ AI_SHELL_BACKEND: 'gguf', AI_SHELL_MODEL_QUANT: 'IQ3_XS', AI_SHELL_MODEL_REPO: 'o/n' }).resolve();
  assert.equal(config.backend, 'gguf');
  assert.equal(config.modelQuant, 'IQ3_XS');
  assert.equal(config.modelRepo, 'o/n');
  assert.equal(config.sources.backend, 'env');
});

test('the server key is masked like the token and can be cleared', async () => {
  const s = store();
  const view = await s.save({ serverKey: 'sk-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(view.serverKey.set, true);
  assert.equal(JSON.stringify(view).includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal((await s.save({ serverKey: '' })).serverKey.set, false);
  await assert.rejects(s.save({ serverKey: 'has space' }), /API key/);
});

test('every setting has a default and a place in the public view', async () => {
  const view = await store().publicView();
  for (const key of Object.keys(DEFAULTS)) assert.ok(key in view, key);
});
