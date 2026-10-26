import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfigStore, validatePatch } from './lib/config.js';
import { createBridgeQueue } from './lib/bridge-queue.js';
import { createRunManager } from './lib/runs.js';
import { createModelRunner } from './lib/model-runner.js';
import { createLlm as defaultCreateLlm } from './lib/llm/index.js';
import { httpError } from './lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const IMPROVE_PROMPT = `You rewrite a rough request into a clear, self-contained task for an AI that controls a web browser and a Linux shell.
Keep the user's intent, and keep any website, numbers, times and durations (like "for 20 minutes" or "every 5 minutes") exactly as written.
Write it as: the goal; where to go; what to do, in short steps; when to stop; what to report back.
Do not invent websites, accounts or details that were not given. If something is missing, say what to assume or to mention it in the final report.
Output only the rewritten task, under 150 words, with no preamble.`;

const ALLOWED_HOSTS = [/^localhost$/, /^127\.0\.0\.1$/, /^\[?::1\]?$/, /\.github\.dev$/, /\.githubpreview\.dev$/];

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Everything here can run commands in the Codespace and drive a browser on the user's computer,
 * so the API refuses requests that did not come from this app:
 *  - Host allow-list stops DNS-rebinding from a malicious website.
 *  - A custom header on every write stops cross-site form posts (browsers will not send it
 *    cross-origin without a CORS preflight, which this server never grants).
 */
export function createApp(deps = {}) {
  const bridgeToken = deps.bridgeToken ?? process.env.AI_SHELL_BRIDGE_TOKEN ?? '';
  const extraHosts = String(deps.allowedHosts ?? process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const dataDir = deps.dataDir ?? process.env.AI_SHELL_DATA_DIR ?? path.join(__dirname, 'data');
  const runner = deps.runner ?? createModelRunner({
    modelsDir: deps.modelsDir ?? process.env.AI_SHELL_MODELS_DIR ?? path.join(__dirname, 'models'),
    binDir: deps.binDir ?? path.join(__dirname, 'bin'),
    port: Number(process.env.AI_SHELL_MODEL_PORT) || 8081
  });
  const createLlm = deps.createLlm ?? ((config) => defaultCreateLlm(config, { runner }));
  const configStore = deps.configStore ?? createConfigStore({ file: path.join(dataDir, 'config.json') });
  const bridge = deps.bridge ?? createBridgeQueue();
  const runs = deps.runs ?? createRunManager({
    configStore,
    bridge,
    createLlm,
    bridgeToken,
    shellCwd: deps.shellCwd ?? process.env.AI_SHELL_WORKSPACE ?? path.join(__dirname, 'workspace')
  });

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    if (!ALLOWED_HOSTS.some((pattern) => pattern.test(host)) && !extraHosts.includes(host)) {
      return res.status(403).json({ error: 'This host name is not allowed. Add it to ALLOWED_HOSTS to use it.' });
    }
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    next();
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'ai-shell') return res.status(403).json({ error: 'Missing app header.' });
    next();
  });

  app.use(express.json({ limit: '12mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/shared/duration.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'duration.js')));

  const requireBridgeToken = (req, _res, next) => {
    if (bridgeToken && !safeEqual(req.get('x-bridge-token') ?? '', bridgeToken)) return next(httpError(401, 'Bridge token missing or wrong.'));
    next();
  };

  app.get('/api/health', async (_req, res) => {
    const settings = await configStore.publicView();
    res.json({
      ok: true,
      app: 'AI Shell',
      version: pkg.version,
      backend: settings.backend,
      model: { 'hf-local': settings.localModel, gguf: settings.modelRepo, server: settings.serverModel, anthropic: settings.anthropicModel, openai: settings.openaiModel }[settings.backend] ?? settings.textModel,
      modelState: settings.backend === 'gguf' ? runner.status().state : null,
      configured: settings.configured,
      autonomy: settings.autonomy,
      bridge: bridge.status(),
      activeRunId: runs.active()?.id ?? null
    });
  });

  app.get('/api/settings', async (_req, res) => res.json(await configStore.publicView()));
  app.patch('/api/settings', async (req, res) => res.json(await configStore.save(req.body || {})));

  app.get('/api/model', async (_req, res) => {
    const config = await configStore.resolve();
    res.json({ ...runner.status(), repo: config.modelRepo, quant: config.modelQuant, selected: config.backend === 'gguf' });
  });

  app.post('/api/model/start', async (_req, res) => {
    res.status(202).json(await runner.start(await configStore.resolve()));
  });

  app.post('/api/model/stop', async (_req, res) => res.json(await runner.stop()));

  app.post('/api/settings/test', async (req, res) => {
    const config = await configStore.resolve(validatePatch(req.body || {}));
    const llm = createLlm(config);
    const reply = await llm.chat({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 12, temperature: 0 });
    res.json({ ok: true, model: reply.model, reply: reply.text.trim().slice(0, 80) });
  });

  app.post('/api/prompt/improve', async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw httpError(400, 'Type a rough idea first.');
    if (text.length > 4000) throw httpError(400, 'That is too long to rewrite.');
    const config = await configStore.resolve();
    const llm = createLlm(config);
    const site = String(req.body?.startUrl ?? '').trim();
    const reply = await llm.chat({
      messages: [{ role: 'system', content: IMPROVE_PROMPT }, { role: 'user', content: site ? `${text}\n\nWebsite: ${site}` : text }],
      maxTokens: 500,
      temperature: 0.3
    });
    res.json({ prompt: reply.text.trim().replace(/^["'`]+|["'`]+$/g, '') });
  });

  app.post('/api/runs', async (req, res) => {
    res.status(202).json(await runs.start(req.body || {}));
  });

  app.get('/api/runs', (_req, res) => res.json(runs.list()));

  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) throw httpError(404, 'That run was not found (the server may have restarted).');
    res.json(runs.view(run, Number(req.query.after) || 0));
  });

  app.get('/api/runs/:id/screenshot', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run?.screenshot) return res.status(204).end();
    res.set('Cache-Control', 'no-store').type('image/jpeg').send(run.screenshot);
  });

  app.post('/api/runs/:id/stop', (req, res) => res.json(runs.stop(req.params.id)));

  app.post('/api/runs/:id/approvals/:approvalId', (req, res) => {
    res.json(runs.decide(req.params.id, req.params.approvalId, req.body?.decision));
  });

  app.post('/api/bridge/heartbeat', requireBridgeToken, (req, res) => res.json(bridge.heartbeat(req.body || {})));

  app.post('/api/bridge/claim', requireBridgeToken, (req, res) => {
    const task = bridge.claim(req.body || {});
    if (!task) return res.status(204).end();
    res.json(task);
  });

  app.post('/api/bridge/tasks/:id/complete', requireBridgeToken, (req, res) => {
    res.json({ accepted: bridge.complete(req.params.id, req.body || {}) });
  });

  app.use('/api', () => {
    throw httpError(404, 'Not found');
  });

  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((error, _req, res, _next) => {
    let status = error.status || error.statusCode || 500;
    let message = error.message || 'Unexpected server error';
    if (error.type === 'entity.too.large') [status, message] = [413, 'That request is too large.'];
    if (error.type === 'entity.parse.failed') [status, message] = [400, 'The request body was not valid JSON.'];
    if (status >= 500 && !error.status) console.error(error);
    res.status(status).json({ error: message });
  });

  app.locals.deps = { configStore, bridge, runs, runner };
  return app;
}

export function start(port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0') {
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`AI Shell running on http://${host}:${server.address().port}`);
    console.log('Keep this port PRIVATE: anyone who can open it can run commands in this Codespace.');
  });
  const { runner } = app.locals.deps;
  // Stop the model first so it releases its memory, then the web server.
  const shutdown = () => runner.stop().catch(() => {}).finally(() => server.close(() => process.exit(0)));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('exit', () => runner.killNow());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start();
}
