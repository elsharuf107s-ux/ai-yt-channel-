import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export function tmpDir(prefix = 'ai-shell-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const act = (tool, args = {}, thought = 'ok') => ({ thought, action: { tool, args } });

/** A model that replies from a script: strings / objects / Errors / functions of the messages. */
export function scriptedLlm(replies, { supportsVision = false } = {}) {
  const calls = [];
  let index = 0;
  return {
    name: 'scripted',
    supportsVision,
    calls,
    describe: () => 'Scripted model',
    async chat({ messages, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      calls.push(messages);
      let next = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (typeof next === 'function') next = next(messages);
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'scripted' };
    }
  };
}

/** A browser bridge stand-in. `handler(action)` returns the page observation. */
export function fakeBridge(handler) {
  const actions = [];
  return {
    actions,
    status: () => ({ online: true }),
    async enqueue(action, { signal } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      actions.push(action);
      return handler(action, signal);
    }
  };
}

export const page = (overrides = {}) => ({
  url: 'https://example.com/',
  title: 'Example',
  scroll: { y: 0, height: 1000 },
  elements: [],
  text: 'Hello world',
  screenshot: null,
  ...overrides
});

export function collector() {
  const events = [];
  return { events, emit: (type, data = {}) => events.push({ type, ...data }), of: (type) => events.filter((e) => e.type === type) };
}

export function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : last.content.map((p) => p.text ?? '').join('\n');
}

/** A Chromium to drive in the end-to-end tests: an explicit override, a preinstalled one, or Playwright's own. */
export function findChromium() {
  const candidates = [process.env.AI_SHELL_CHROMIUM, '/opt/pw-browsers/chromium', chromium.executablePath()].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

export async function until(check, { timeout = 8000, step = 25, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}
