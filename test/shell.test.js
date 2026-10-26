import test from 'node:test';
import assert from 'node:assert/strict';
import { runShell, scrubbedEnv } from '../lib/shell.js';
import { tmpDir } from './helpers.js';

test('captures output and exit codes', async () => {
  const cwd = tmpDir();
  const ok = await runShell('echo hello && echo oops 1>&2', { cwd });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), 'hello');
  assert.equal(ok.stderr.trim(), 'oops');
  const bad = await runShell('exit 3', { cwd });
  assert.equal(bad.exitCode, 3);
});

test('runs in the given working directory, creating it if needed', async () => {
  const cwd = `${tmpDir()}/nested/work`;
  const result = await runShell('pwd', { cwd });
  assert.equal(result.stdout.trim(), cwd);
});

test('kills commands that run too long', async () => {
  const started = Date.now();
  const result = await runShell('sleep 10', { cwd: tmpDir(), timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000);
});

test('truncates huge output', async () => {
  const result = await runShell('yes x | head -c 60000', { cwd: tmpDir(), maxOutput: 1000 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 1000);
});

test('secrets in the environment are not visible to commands', async () => {
  process.env.AI_SHELL_TEST_API_TOKEN = 'super-secret-value-123';
  try {
    assert.equal('AI_SHELL_TEST_API_TOKEN' in scrubbedEnv(), false);
    const result = await runShell('printenv AI_SHELL_TEST_API_TOKEN; echo "[$AI_SHELL_TEST_API_TOKEN]"', { cwd: tmpDir() });
    assert.equal(result.stdout.includes('super-secret-value-123'), false);
    assert.match(result.stdout, /\[\]/);
  } finally {
    delete process.env.AI_SHELL_TEST_API_TOKEN;
  }
});

test('stopping kills the whole process group quickly', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = runShell('sleep 30 & sleep 30', { cwd: tmpDir(), signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(Date.now() - started < 3000);
});

test('an already-stopped signal never starts the command', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runShell('echo hi', { cwd: tmpDir(), signal: controller.signal }), { name: 'AbortError' });
});
