import fs from 'node:fs';
import net from 'node:net';
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

const FAKE_LLAMA = `#!/usr/bin/env node
// Stand-in for llama.cpp's llama-server: same flags, /health and /v1/chat/completions, no model.
const http = require('http');
const fs = require('fs');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const record = process.env.FAKE_LLAMA_RECORD;
const requests = [];
const save = () => record && fs.writeFileSync(record, JSON.stringify({ argv, env: { LLAMA_CACHE: process.env.LLAMA_CACHE, HF_TOKEN: process.env.HF_TOKEN }, requests }));
if (argv.includes('--version')) { console.error('version: 9999 (fake)'); process.exit(0); }
save();
if (process.env.FAKE_LLAMA_MODE === 'crash') { console.error("error: unknown model architecture: 'qwen3x'"); process.exit(1); }
console.error('loading model\\r10%\\r50%\\rdone');
if (process.env.HF_TOKEN) console.error('using token ' + process.env.HF_TOKEN);
const readyAt = Date.now() + Number(process.env.FAKE_LLAMA_LOADING_MS || 0);
const replies = JSON.parse(process.env.FAKE_LLAMA_REPLIES || '["{}"]');
let n = 0;
http.createServer((req, res) => {
  if (req.url === '/health') {
    const ready = Date.now() >= readyAt;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(ready ? { status: 'ok' } : { error: { message: 'Loading model' } }));
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      save();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replies[Math.min(n++, replies.length - 1)] } }] }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(arg('--port')), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

/** Writes a fake llama-server into binDir and returns its path. */
export function installFakeLlama(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'llama-server');
  fs.writeFileSync(file, FAKE_LLAMA, { mode: 0o755 });
  return file;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
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
