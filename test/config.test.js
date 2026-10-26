import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfigStore, maskKey, DEFAULTS } from '../lib/config.js';
import { tmpDir } from './helpers.js';

const fileIn = (dir) => path.join(dir, 'data', 'config.json');

test('defaults apply when nothing is set', async () => {
  const store = createConfigStore({ file: fileIn(tmpDir()), env: {} });
  const config = await store.resolve();
  assert.equal(config.backend, DEFAULTS.backend);
  assert.equal(config.autonomy, 'ask');
  assert.equal(config.hfToken, '');
  assert.equal((await store.publicView()).configured, false);
});

test('precedence is draft, then saved, then environment, then default', async () => {
  const dir = tmpDir();
  const env = { HF_TOKEN: 'hf_envtoken0000000', AI_SHELL_TEXT_MODEL: 'env/model' };
  const store = createConfigStore({ file: fileIn(dir), env });
  assert.equal((await store.resolve()).textModel, 'env/model');
  await store.save({ textModel: 'saved/model' });
  assert.equal((await store.resolve()).textModel, 'saved/model');
  assert.equal((await store.resolve({ textModel: 'draft/model' })).textModel, 'draft/model');
  assert.equal((await store.resolve()).hfToken, 'hf_envtoken0000000');
  assert.equal((await store.resolve()).sources.hfToken, 'env');
});

test('the token is masked in the public view and stored with owner-only permissions', async () => {
  const dir = tmpDir();
  const file = fileIn(dir);
  const store = createConfigStore({ file, env: {} });
  const view = await store.save({ hfToken: 'hf_abcdefghijklmnopqrstuvwxyz' });
  assert.equal(JSON.stringify(view).includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(view.hfToken.set, true);
  assert.equal(view.hfToken.preview, maskKey('hf_abcdefghijklmnopqrstuvwxyz'));
  assert.equal(view.configured, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = createConfigStore({ file, env: {} });
  assert.equal((await reloaded.resolve()).hfToken, 'hf_abcdefghijklmnopqrstuvwxyz');
});

test('an empty token clears the saved one', async () => {
  const store = createConfigStore({ file: fileIn(tmpDir()), env: {} });
  await store.save({ hfToken: 'hf_abcdefghijklmnopqrstuvwxyz' });
  const view = await store.save({ hfToken: '' });
  assert.equal(view.hfToken.set, false);
});

test('the local backend counts as configured without a token', async () => {
  const store = createConfigStore({ file: fileIn(tmpDir()), env: {} });
  assert.equal((await store.save({ backend: 'hf-local' })).configured, true);
});

test('rejects invalid settings', async () => {
  const store = createConfigStore({ file: fileIn(tmpDir()), env: {} });
  await assert.rejects(store.save({ backend: 'openai' }), /backend must be one of/);
  await assert.rejects(store.save({ autonomy: 'yolo' }), /autonomy must be one of/);
  await assert.rejects(store.save({ textModel: 'has space' }), /spaces/);
  await assert.rejects(store.save({ textModel: '  ' }), /Enter a text model/);
  await assert.rejects(store.save({ maxSteps: 0 }), /whole number/);
  await assert.rejects(store.save({ maxSteps: 1.5 }), /whole number/);
  await assert.rejects(store.save({ hfToken: 'has space' }), /token/);
});

test('an invalid value in the environment is ignored rather than trusted', async () => {
  const store = createConfigStore({ file: fileIn(tmpDir()), env: { AI_SHELL_AUTONOMY: 'yolo', AI_SHELL_BACKEND: 'nope' } });
  const config = await store.resolve();
  assert.equal(config.autonomy, 'ask');
  assert.equal(config.backend, 'hf-api');
});

test('settings survive concurrent saves', async () => {
  const file = fileIn(tmpDir());
  const store = createConfigStore({ file, env: {} });
  await Promise.all([store.save({ textModel: 'a/b' }), store.save({ maxSteps: 12 }), store.save({ autonomy: 'strict' })]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { textModel: 'a/b', maxSteps: 12, autonomy: 'strict' });
});
