import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createModelRunner, listModelFiles, chooseModelFile, buildServerArgs, findLlamaServer } from '../lib/model-runner.js';
import { installFakeLlama, freePort, tmpDir, until } from './helpers.js';

const REPO = 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF';
const touch = (file, bytes = 4) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  return file;
};
const config = (extra = {}) => ({ modelRepo: REPO, modelQuant: '', modelFile: '', modelContext: 16384, hfToken: '', ...extra });

async function rig({ env = {}, files = [] } = {}) {
  const root = tmpDir('runner-');
  const modelsDir = path.join(root, 'models');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(modelsDir, { recursive: true });
  for (const file of files) touch(path.join(modelsDir, file));
  installFakeLlama(path.join(binDir, 'llama.cpp', 'build', 'bin'));
  const record = path.join(root, 'record.json');
  const runner = createModelRunner({
    modelsDir,
    binDir,
    port: await freePort(),
    healthIntervalMs: 40,
    env: { ...process.env, LLAMA_SERVER: '', FAKE_LLAMA_RECORD: record, ...env }
  });
  const recorded = () => JSON.parse(fs.readFileSync(record, 'utf8'));
  return { runner, modelsDir, binDir, root, recorded };
}

test('finds the model to run among downloaded files', () => {
  const dir = tmpDir('models-');
  const one = touch(path.join(dir, 'Model', 'Model-Q4_K_M.gguf'));
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir }), { file: one });

  touch(path.join(dir, 'Model', 'mmproj-F16.gguf'));
  touch(path.join(dir, '.cache', 'huggingface', 'stale.gguf'));
  assert.deepEqual(listModelFiles(dir).map((f) => path.basename(f)), ['Model-Q4_K_M.gguf', 'mmproj-F16.gguf']);
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir }), { file: one });
});

test('a split model is started from its first part', () => {
  const dir = tmpDir('models-');
  const first = touch(path.join(dir, 'Big-Q3-00001-of-00003.gguf'));
  touch(path.join(dir, 'Big-Q3-00002-of-00003.gguf'));
  touch(path.join(dir, 'Big-Q3-00003-of-00003.gguf'));
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir }), { file: first });
});

test('with several quantizations on disk the user must choose, by quant or by file', () => {
  const dir = tmpDir('models-');
  const q4 = touch(path.join(dir, 'M-Q4_K_M.gguf'));
  touch(path.join(dir, 'M-IQ3_XS.gguf'));
  const ambiguous = chooseModelFile(listModelFiles(dir), { modelsDir: dir });
  assert.match(ambiguous.error, /Found 2 GGUF files.*M-IQ3_XS\.gguf.*M-Q4_K_M\.gguf/s);
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir, quant: 'q4_k_m' }), { file: q4 });
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir, requested: 'M-Q4_K_M.gguf' }), { file: q4 });
});

test('nothing on disk means llama.cpp downloads it; a bad explicit file is refused', () => {
  const dir = tmpDir('models-');
  assert.deepEqual(chooseModelFile([], { modelsDir: dir }), {});
  touch(path.join(dir, 'only-Q8_0.gguf'));
  assert.deepEqual(chooseModelFile(listModelFiles(dir), { modelsDir: dir, quant: 'Q4_K_M' }), {});
  assert.match(chooseModelFile([], { modelsDir: dir, requested: 'nope.gguf' }).error, /not found/);
  assert.match(chooseModelFile([], { modelsDir: dir, requested: '../outside.gguf' }).error, /inside the models/);
});

test('llama-server is started with the right arguments', () => {
  assert.deepEqual(buildServerArgs({ file: '/m/x.gguf', repo: 'o/n', quant: '', context: 8192, port: 8081 }),
    ['-m', '/m/x.gguf', '--alias', 'o/n', '--host', '127.0.0.1', '--port', '8081', '-c', '8192', '--jinja']);
  assert.deepEqual(buildServerArgs({ repo: 'o/n', quant: 'Q4_K_M', context: 4096, port: 9, threads: 4 }),
    ['-hf', 'o/n:Q4_K_M', '--alias', 'o/n', '--host', '127.0.0.1', '--port', '9', '-c', '4096', '--jinja', '-t', '4']);
  assert.equal(buildServerArgs({ repo: 'o/n', context: 1, port: 1 })[1], 'o/n');
});

test('llama-server is found from an override, the bin folder, or PATH', () => {
  const root = tmpDir('find-');
  assert.equal(findLlamaServer({ binDir: path.join(root, 'bin'), env: { PATH: '' } }), null);
  const nested = installFakeLlama(path.join(root, 'bin', 'llama.cpp', 'build', 'bin'));
  assert.equal(findLlamaServer({ binDir: path.join(root, 'bin'), env: { PATH: '' } }), nested);
  const onPath = installFakeLlama(path.join(root, 'onpath'));
  assert.equal(findLlamaServer({ binDir: path.join(root, 'none'), env: { PATH: path.dirname(onPath) } }), onPath);
  assert.equal(findLlamaServer({ binDir: path.join(root, 'bin'), env: { LLAMA_SERVER: onPath } }), onPath);
  assert.equal(findLlamaServer({ binDir: path.join(root, 'bin'), env: { LLAMA_SERVER: '/nope/llama-server' } }), null);
});

test('starts a local model file, waits while it loads, then reports ready', async (t) => {
  const { runner, modelsDir, recorded } = await rig({ files: ['Model/Model-Q4_K_M.gguf'], env: { FAKE_LLAMA_LOADING_MS: '400' } });
  t.after(() => runner.stop());
  assert.equal((await runner.start(config())).state, 'starting');
  await until(() => runner.status().message.includes('Loading the model'), { label: 'loading message' });
  assert.equal(runner.status().state, 'starting');
  await until(() => runner.status().state === 'ready', { label: 'ready' });

  const { argv, env } = recorded();
  assert.deepEqual(argv.slice(0, 2), ['-m', path.join(modelsDir, 'Model', 'Model-Q4_K_M.gguf')]);
  assert.ok(argv.includes('--jinja'));
  assert.equal(argv[argv.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(argv[argv.indexOf('--alias') + 1], REPO);
  assert.equal(argv[argv.indexOf('-c') + 1], '16384');
  assert.equal(env.LLAMA_CACHE, path.join(modelsDir, 'cache'));
  assert.equal(runner.status().mode.kind, 'file');
  assert.deepEqual(runner.status().warnings, []);
});

test('with no file on disk it asks llama.cpp to download from Hugging Face and says so', async (t) => {
  const { runner, recorded } = await rig();
  t.after(() => runner.stop());
  await runner.start(config({ modelQuant: 'Q4_K_M' }));
  await until(() => runner.status().state === 'ready');
  const { argv } = recorded();
  assert.deepEqual(argv.slice(0, 2), ['-hf', `${REPO}:Q4_K_M`]);
  assert.equal(runner.status().mode.kind, 'hub');
  assert.match(runner.status().warnings[0], /will download it from Hugging Face/);
});

test('the Hugging Face token reaches llama.cpp but never appears in the log', async (t) => {
  const token = 'hf_secrettoken0123456789';
  const { runner, recorded } = await rig({ files: ['m-Q4.gguf'] });
  t.after(() => runner.stop());
  await runner.start(config({ hfToken: token }));
  await until(() => runner.status().state === 'ready');
  assert.equal(recorded().env.HF_TOKEN, token);
  const log = runner.status().log.join('\n');
  assert.match(log, /using token \[redacted\]/);
  assert.equal(log.includes(token), false);
  // download progress that redraws one line with \r keeps only its last state
  assert.match(log, /^done$/m);
  assert.equal(log.includes('10%'), false);
});

test('a start that crashes is reported with the reason from the log', async (t) => {
  const { runner } = await rig({ files: ['m-Q4.gguf'], env: { FAKE_LLAMA_MODE: 'crash' } });
  t.after(() => runner.stop());
  await runner.start(config());
  await until(() => runner.status().state === 'failed', { label: 'failure' });
  assert.match(runner.status().message, /stopped before it was ready \(exit code 1\)/);
  assert.match(runner.status().log.join('\n'), /unknown model architecture/);
  // it can be started again after a failure
  assert.equal((await runner.start(config())).state, 'starting');
});

test('stopping ends the process and starting twice does nothing extra', async () => {
  const { runner } = await rig({ files: ['m-Q4.gguf'] });
  const first = await runner.start(config());
  await until(() => runner.status().state === 'ready');
  const second = await runner.start(config());
  assert.equal(second.pid, first.pid);

  const { pid } = runner.status();
  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.pid, null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await runner.stop()).state, 'stopped');
});

test('killNow takes the process down immediately', async () => {
  const { runner } = await rig({ files: ['m-Q4.gguf'] });
  await runner.start(config());
  await until(() => runner.status().state === 'ready');
  const { pid } = runner.status();
  runner.killNow();
  await until(() => runner.status().state === 'failed', { label: 'process gone' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('missing llama.cpp or an ambiguous choice of file are explained, not attempted', async () => {
  const none = createModelRunner({ modelsDir: tmpDir(), binDir: tmpDir(), port: 1, env: { PATH: '' } });
  await assert.rejects(none.start(config()), { status: 400, message: /npm run setup:llama/ });
  assert.equal(none.status().state, 'stopped');
  assert.equal(none.status().binary, null);

  const { runner } = await rig({ files: ['a-Q4.gguf', 'b-Q8.gguf'] });
  await assert.rejects(runner.start(config()), { status: 400, message: /Found 2 GGUF files/ });
  assert.equal(runner.status().state, 'stopped');
});

test('status reports this machine so a too-small Codespace is obvious', async () => {
  const { runner } = await rig();
  const { machine } = runner.status();
  assert.ok(machine.ramGB > 0 && machine.cpus > 0);
  assert.ok(machine.freeDiskGB === null || machine.freeDiskGB > 0);
});
