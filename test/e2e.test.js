// The real thing: the actual server, the actual local bridge, and a real Chromium window
// (headless here) driven by a scripted "model". Skipped when no Chromium is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../server.js';
import { createConfigStore } from '../lib/config.js';
import { startBridge } from '../scripts/local-bridge.js';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { scriptedLlm, act, tmpDir, until, lastUserText, findChromium } from './helpers.js';

const chromium = findChromium();
const LIVE = ['running', 'awaiting_approval'];

const SHOP = `<!doctype html><title>Demo Shop</title><h1>Demo Shop</h1>
<label>Search products <input id="q" name="q" placeholder="Search products"></label>
<button onclick="location='/results?q='+encodeURIComponent(document.getElementById('q').value)">Search</button>
<button onclick="document.getElementById('msg').textContent='ACCOUNT DELETED'">Delete account</button>
<p id="msg">nothing happened</p>`;

function shopServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/results') res.end(`<!doctype html><title>Results</title><h1>Results for ${url.searchParams.get('q')}</h1><p>Price: $42</p>`);
    else res.end(SHOP);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const idOf = (messages, pattern) => {
  const found = lastUserText(messages).match(pattern);
  if (!found) throw new Error(`No element matching ${pattern} in:\n${lastUserText(messages)}`);
  return Number(found[1]);
};

async function boot(replies, env) {
  const dir = tmpDir();
  const configStore = createConfigStore({ file: path.join(dir, 'config.json'), env: { HF_TOKEN: 'hf_testtoken0123456789', ...env } });
  const app = createApp({ configStore, createLlm: () => scriptedLlm(replies), dataDir: dir, shellCwd: path.join(dir, 'ws') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, json: await response.clone().json().catch(() => null), response };
  };
  const bridge = await startBridge({ server: base, headless: true, chromiumPath: chromium, profile: tmpDir('ai-shell-profile-'), log: () => {}, pollMs: 50 });
  await until(async () => (await call('GET', '/api/health')).json.bridge.online, { label: 'bridge to connect' });
  return {
    call,
    finished: (id) => until(async () => {
      const { json } = await call('GET', `/api/runs/${id}`);
      return json && !LIVE.includes(json.status) ? json : null;
    }, { timeout: 30_000, label: 'run to finish' }),
    close: async () => { await bridge.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  };
}

test('the AI browses a real page through the real bridge: type, click, read the result', { skip: !chromium && 'no Chromium available' }, async (t) => {
  const shop = await shopServer();
  t.after(() => shop.server.close());
  const s = await boot([
    act('goto', { url: `${shop.url}/` }),
    (m) => act('type', { id: idOf(m, /\[(\d+)\] input\[text\] "Search products"/), text: 'laptop' }),
    (m) => act('click', { id: idOf(m, /\[(\d+)\] button "Search"/) }),
    (m) => act('finish', { summary: `On the results page I read: ${lastUserText(m).match(/Price: \$\d+/)?.[0]} for ${lastUserText(m).match(/Results for \w+/)?.[0]}` })
  ], { AI_SHELL_AUTONOMY: 'auto' });
  t.after(s.close);

  const started = await s.call('POST', '/api/runs', { task: 'Search the shop for a laptop and tell me the price' });
  const done = await s.finished(started.json.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.events.filter((e) => e.type === 'error' || e.type === 'note')));
  assert.equal(done.summary, 'On the results page I read: Price: $42 for Results for laptop');

  const shot = await s.call('GET', `/api/runs/${done.id}/screenshot`);
  assert.equal(shot.status, 200);
  assert.equal(shot.response.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await shot.response.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(done.events.some((e) => e.type === 'screenshot'));
});

test('in "ask" mode a local-network page and a destructive click wait for approval; a denied click never happens', { skip: !chromium && 'no Chromium available' }, async (t) => {
  const shop = await shopServer();
  t.after(() => shop.server.close());
  const s = await boot([
    act('goto', { url: `${shop.url}/` }),
    (m) => act('click', { id: idOf(m, /\[(\d+)\] button "Delete account"/) }),
    act('snapshot'),
    (m) => act('finish', { summary: lastUserText(m).includes('ACCOUNT DELETED') ? 'the account was deleted' : 'the account is untouched' })
  ], { AI_SHELL_AUTONOMY: 'ask' });
  t.after(s.close);

  const started = await s.call('POST', '/api/runs', { task: 'Look at the shop, then press the delete button' });
  const seen = [];
  const decide = async (decision) => {
    const pending = await until(async () => (await s.call('GET', `/api/runs/${started.json.id}`)).json.pending[0], { timeout: 20_000, label: 'approval request' });
    seen.push(pending.summary);
    await s.call('POST', `/api/runs/${started.json.id}/approvals/${pending.id}`, { decision });
  };
  await decide('approve');
  await decide('deny');
  const done = await s.finished(started.json.id);

  assert.match(seen[0], /Open http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(seen[1], /Click \[\d+\] button "Delete account"/);
  assert.equal(done.status, 'completed');
  assert.equal(done.summary, 'the account is untouched');
});

test('the browser driver refuses non-web addresses and a public page that redirects to the private network', async () => {
  const urls = ['https://public.example/'];
  const stub = {
    gotos: [],
    isClosed: () => false,
    url: () => urls.at(-1),
    title: async () => 't',
    viewportSize: () => ({ width: 1000, height: 800 }),
    goto: async function goto(target) { this.gotos.push(target); urls.push(target === 'about:blank' ? 'about:blank' : 'http://169.254.169.254/latest/meta-data'); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => [],
    screenshot: async () => null
  };
  const driver = createBrowserDriver({ context: { on() {}, pages: () => [stub], newPage: async () => stub } });

  await assert.rejects(driver.execute({ tool: 'goto', args: { url: 'file:///etc/passwd' } }), /Only http and https/);
  await assert.rejects(driver.execute({ tool: 'goto', args: { url: 'javascript:alert(1)' } }), /Only http and https/);
  await assert.rejects(driver.execute({ tool: 'goto', args: { url: 'https://public.example/redirects' } }), /private network/);
  assert.deepEqual(stub.gotos, ['https://public.example/redirects', 'about:blank']);
  await assert.rejects(driver.execute({ tool: 'click', args: { id: 1.5 } }), /element number/);
  await assert.rejects(driver.execute({ tool: 'rm', args: {} }), /Unknown browser action/);
});
