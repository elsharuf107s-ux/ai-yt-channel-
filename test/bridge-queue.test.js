import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeQueue } from '../lib/bridge-queue.js';

const online = () => {
  const queue = createBridgeQueue({ taskTimeoutMs: 200 });
  queue.heartbeat({ bridgeId: 'b1', mode: 'playwright-headed', version: '1' });
  return queue;
};

test('refuses work while no bridge is connected', async () => {
  const queue = createBridgeQueue();
  assert.equal(queue.status().online, false);
  await assert.rejects(queue.enqueue({ tool: 'snapshot', args: {} }), /bridge is offline/);
});

test('a heartbeat marks the bridge online, and it goes offline when heartbeats stop', () => {
  let t = 1000;
  const queue = createBridgeQueue({ now: () => t, onlineWindowMs: 10_000 });
  queue.heartbeat({ bridgeId: 'b1', mode: 'cdp' });
  assert.deepEqual([queue.status().online, queue.status().mode], [true, 'cdp']);
  t += 9_000;
  assert.equal(queue.status().online, true);
  t += 2_000;
  assert.equal(queue.status().online, false);
});

test('task goes queue -> claim -> complete and resolves with the result', async () => {
  const queue = online();
  const pending = queue.enqueue({ tool: 'goto', args: { url: 'https://x.test' } });
  const task = queue.claim({ bridgeId: 'b1' });
  assert.equal(task.action.tool, 'goto');
  assert.equal(queue.claim({ bridgeId: 'b1' }), null);
  assert.equal(queue.complete(task.id, { ok: true, result: { url: 'https://x.test/' } }), true);
  assert.deepEqual(await pending, { url: 'https://x.test/' });
});

test('failures from the bridge reject with its message', async () => {
  const queue = online();
  const pending = queue.enqueue({ tool: 'click', args: { id: 1 } });
  const task = queue.claim();
  queue.complete(task.id, { ok: false, error: 'Element not found' });
  await assert.rejects(pending, /Element not found/);
});

test('tasks are handed out oldest first', async () => {
  const queue = online();
  const first = queue.enqueue({ tool: 'goto', args: {} });
  const second = queue.enqueue({ tool: 'back', args: {} });
  const a = queue.claim();
  const b = queue.claim();
  assert.deepEqual([a.action.tool, b.action.tool], ['goto', 'back']);
  queue.complete(a.id, { ok: true, result: 1 });
  queue.complete(b.id, { ok: true, result: 2 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test('a task the bridge never finishes times out and cannot be completed later', async () => {
  const queue = online();
  const pending = queue.enqueue({ tool: 'snapshot', args: {} }, { timeoutMs: 40 });
  const task = queue.claim();
  await assert.rejects(pending, /did not finish "snapshot"/);
  assert.equal(queue.complete(task.id, { ok: true, result: {} }), false);
});

test('stopping cancels a waiting task, and a cancelled task is never handed to the bridge', async () => {
  const queue = online();
  const controller = new AbortController();
  const pending = queue.enqueue({ tool: 'goto', args: {} }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(queue.claim(), null);
  await assert.rejects(queue.enqueue({ tool: 'goto', args: {} }, { signal: controller.signal }), { name: 'AbortError' });
});

test('completing an unknown or still-queued task is ignored', async () => {
  const queue = online();
  assert.equal(queue.complete('nope', { ok: true }), false);
  const pending = queue.enqueue({ tool: 'snapshot', args: {} }, { timeoutMs: 30 });
  const id = [...[queue.claim()]][0].id;
  queue.complete(id, { ok: true, result: 'done' });
  assert.equal(await pending, 'done');
  assert.equal(queue.complete(id, { ok: true, result: 'again' }), false);
});
