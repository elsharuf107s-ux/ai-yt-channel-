#!/usr/bin/env node
// The "hands": runs on YOUR computer, opens a visible Chromium window, and carries out the
// browser actions the AI in the Codespace asks for. It only ever connects outward to the
// Codespace (through the private port-forward) and never listens on a port itself.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createBrowserDriver } from '../lib/browser-driver.js';

export const BRIDGE_VERSION = '0.1.0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startBridge({
  server = 'http://127.0.0.1:3000',
  profile = path.join(os.homedir(), '.ai-shell', 'browser-profile'),
  headless = false,
  cdp = '',
  chromiumPath = '',
  token = '',
  bridgeId = `bridge-${crypto.randomUUID().slice(0, 8)}`,
  pollMs = 700,
  log = console.log
} = {}) {
  const base = server.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'ai-shell', ...(token ? { 'x-bridge-token': token } : {}) };

  async function api(pathname, body, timeout = 15_000) {
    const response = await fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeout) });
    if (response.status === 204) return null;
    if (!response.ok) {
      let message = `AI Shell returned ${response.status}`;
      try { message = (await response.json()).error || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    return response.json();
  }

  let browser = null;
  let context;
  let mode;
  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0];
    if (!context) throw new Error('The browser at --cdp did not expose a browser context.');
    mode = 'cdp';
    log(`[bridge] attached to existing Chromium at ${cdp}`);
  } else {
    context = await chromium.launchPersistentContext(profile, {
      headless,
      viewport: headless ? { width: 1280, height: 800 } : null,
      executablePath: chromiumPath || undefined,
      args: ['--disable-dev-shm-usage']
    });
    mode = headless ? 'playwright-headless' : 'playwright-headed';
    log(`[bridge] opened Chromium (profile: ${profile})`);
  }

  const driver = createBrowserDriver({ context });
  const info = { bridgeId, mode, version: BRIDGE_VERSION };
  let stopping = false;
  let lastError = '';

  const heartbeat = setInterval(() => api('/api/bridge/heartbeat', info, 8000).catch(() => {}), 3000);
  api('/api/bridge/heartbeat', info, 8000).catch((error) => log(`[bridge] cannot reach ${base}: ${error.message}`));

  const loop = (async () => {
    while (!stopping) {
      try {
        const task = await api('/api/bridge/claim', info);
        lastError = '';
        if (!task) { await sleep(pollMs); continue; }
        let outcome;
        try {
          outcome = { ok: true, result: await driver.execute(task.action) };
        } catch (error) {
          outcome = { ok: false, error: String(error.message || error).split('\n')[0] };
        }
        log(`[bridge] ${task.action.tool}: ${outcome.ok ? 'done' : outcome.error}`);
        await api(`/api/bridge/tasks/${task.id}/complete`, outcome, 30_000);
      } catch (error) {
        if (stopping) break;
        if (error.message !== lastError) log(`[bridge] ${error.message} (retrying)`);
        lastError = error.message;
        await sleep(2000);
      }
    }
  })();

  return {
    bridgeId,
    async stop() {
      stopping = true;
      clearInterval(heartbeat);
      await loop;
      if (browser) await browser.close().catch(() => {});
      else await context.close().catch(() => {});
    }
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    const value = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    out[key] = value;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run bridge -- [--server http://127.0.0.1:3000] [--headless] [--profile DIR] [--chromium-path FILE] [--cdp URL] [--token SECRET]');
    process.exit(0);
  }
  try {
    const bridge = await startBridge({
      server: args.server || process.env.AI_SHELL_SERVER || 'http://127.0.0.1:3000',
      profile: args.profile ? path.resolve(String(args.profile)) : undefined,
      headless: args.headless === true || args.headless === 'true',
      cdp: args.cdp ? String(args.cdp) : process.env.AI_SHELL_CDP_URL || '',
      chromiumPath: args['chromium-path'] ? String(args['chromium-path']) : process.env.AI_SHELL_CHROMIUM || '',
      token: args.token ? String(args.token) : process.env.AI_SHELL_BRIDGE_TOKEN || ''
    });
    console.log('[bridge] connected. Leave this running; press Ctrl+C to stop.');
    const shutdown = () => bridge.stop().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(`[bridge] could not start: ${error.message}`);
    if (/Executable doesn't exist|browserType.launch/i.test(error.message)) console.error('Install the browser first:  npx playwright install chromium');
    process.exit(1);
  }
}
