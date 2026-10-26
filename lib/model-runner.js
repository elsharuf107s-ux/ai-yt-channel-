import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './errors.js';
import { redact } from './redact.js';

const GB = 1024 ** 3;
const MAX_LOG_LINES = 200;
const SHARD = /-(\d{5})-of-\d{5}\.gguf$/i;

const gb = (bytes) => Math.round((bytes / GB) * 10) / 10;

/** Every .gguf under `root` (skipping dot-folders such as the Hub's metadata cache). */
export function listModelFiles(root, maxDepth = 4) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

// A split model is several files; llama.cpp wants the first. Vision projectors are separate files too.
const isPrimary = (file) => {
  const name = path.basename(file);
  if (/^mmproj/i.test(name)) return false;
  const shard = name.match(SHARD);
  return !shard || shard[1] === '00001';
};

/** Pick the model file to run from what is on disk. `{}` means nothing local: let llama.cpp download it. */
export function chooseModelFile(files, { requested = '', quant = '', modelsDir }) {
  if (requested) {
    const root = path.resolve(modelsDir);
    const full = path.resolve(root, requested);
    if (!full.startsWith(root + path.sep)) return { error: 'The model file must be inside the models/ folder.' };
    return fs.existsSync(full) ? { file: full } : { error: `Model file not found: models/${requested}` };
  }
  let usable = files.filter(isPrimary);
  if (quant) usable = usable.filter((file) => path.basename(file).toLowerCase().includes(quant.toLowerCase()));
  if (usable.length === 0) return {};
  if (usable.length === 1) return { file: usable[0] };
  const names = usable.map((file) => `  ${path.relative(modelsDir, file)}`).join('\n');
  return { error: `Found ${usable.length} GGUF files in models/. Set "Model file" (or a quantization) to choose one:\n${names}` };
}

export function buildServerArgs({ file, repo, quant, context, port, threads }) {
  return [
    ...(file ? ['-m', file] : ['-hf', quant ? `${repo}:${quant}` : repo]),
    '--alias', repo,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(context),
    '--jinja',
    ...(threads ? ['-t', String(threads)] : [])
  ];
}

function walkFor(dir, name, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  if (depth >= 5) return null;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = walkFor(path.join(dir, entry.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function findLlamaServer({ binDir, env = process.env }) {
  if (env.LLAMA_SERVER) return fs.existsSync(env.LLAMA_SERVER) ? env.LLAMA_SERVER : null;
  const local = walkFor(binDir, 'llama-server');
  if (local) return local;
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'llama-server');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Starts and watches a llama.cpp `llama-server` for a GGUF model, inside this machine.
 * The app talks to it over http://127.0.0.1:<port>/v1 like any other OpenAI-compatible server.
 */
export function createModelRunner({ modelsDir, binDir, port = 8081, spawnImpl = spawn, fetchImpl = globalThis.fetch, env = process.env, healthIntervalMs = 1000 }) {
  let child = null;
  let exited = null;
  let state = 'stopped';
  let message = 'Not started.';
  let mode = null;
  let warnings = [];
  let log = [];
  let timer = null;
  let stopping = false;
  let secrets = [];

  const url = `http://127.0.0.1:${port}/v1`;

  function pushLog(chunk) {
    for (const piece of chunk.toString().split('\n')) {
      // Download progress redraws one line with \r; keep only its latest state.
      const line = piece.split('\r').pop().trim();
      if (line) log.push(redact(line, secrets).slice(0, 400));
    }
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
  }

  function machine() {
    let freeDiskGB = null;
    try {
      let dir = path.resolve(modelsDir);
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const stats = fs.statfsSync(dir);
      freeDiskGB = gb(stats.bavail * stats.bsize);
    } catch { /* not available on this platform */ }
    return { ramGB: gb(os.totalmem()), freeRamGB: gb(os.freemem()), freeDiskGB, cpus: os.cpus().length };
  }

  function status() {
    return {
      state,
      message,
      url,
      port,
      binary: findLlamaServer({ binDir, env }),
      mode,
      warnings,
      log: log.slice(-60),
      machine: machine(),
      pid: child?.pid ?? null
    };
  }

  async function probe(proc) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (child !== proc) return;
      if (response.ok) {
        state = 'ready';
        message = 'Ready.';
      } else {
        message = 'Loading the model into memory. This can take several minutes for a big model.';
      }
    } catch {
      if (child === proc && state === 'starting') message = 'Starting. If the model is not on disk yet, llama.cpp is downloading it (see the log).';
    }
  }

  async function start(config) {
    if (child && (state === 'starting' || state === 'ready')) return status();

    const binary = findLlamaServer({ binDir, env });
    if (!binary) {
      throw httpError(400, 'llama-server (llama.cpp) is not installed in this Codespace. Run "npm run setup:llama", or set LLAMA_SERVER to its path.');
    }
    const chosen = chooseModelFile(listModelFiles(modelsDir), { requested: config.modelFile, quant: config.modelQuant, modelsDir });
    if (chosen.error) throw httpError(400, chosen.error);

    mode = chosen.file
      ? { kind: 'file', value: chosen.file }
      : { kind: 'hub', value: config.modelQuant ? `${config.modelRepo}:${config.modelQuant}` : config.modelRepo };

    warnings = [];
    if (chosen.file) {
      const size = fs.statSync(chosen.file).size;
      const total = os.totalmem();
      if (size > total) {
        warnings.push(`The model file is ${gb(size)} GB but this machine has ${gb(total)} GB of RAM. It may not load, or will be extremely slow. Use a bigger Codespace machine or a smaller quantization.`);
      }
    } else {
      warnings.push('No model file found in models/, so llama.cpp will download it from Hugging Face on first start. Big models can need tens of GB of disk and a long download.');
    }

    secrets = [config.hfToken].filter(Boolean);
    log = [];
    stopping = false;
    fs.mkdirSync(modelsDir, { recursive: true });
    const args = buildServerArgs({ file: chosen.file, repo: config.modelRepo, quant: config.modelQuant, context: config.modelContext, port });
    const childEnv = {
      ...env,
      LLAMA_CACHE: path.join(modelsDir, 'cache'),
      LD_LIBRARY_PATH: [path.dirname(binary), env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
      ...(config.hfToken ? { HF_TOKEN: config.hfToken } : {})
    };

    const proc = spawnImpl(binary, args, { cwd: path.dirname(binary), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    state = 'starting';
    message = 'Launching llama-server…';
    exited = new Promise((resolve) => {
      proc.once('exit', (code, signal) => {
        if (child !== proc) return resolve();
        child = null;
        clearInterval(timer);
        if (stopping) {
          state = 'stopped';
          message = 'Stopped.';
        } else {
          const when = state === 'ready' ? 'while running' : 'before it was ready';
          state = 'failed';
          message = `llama-server stopped ${when} (${signal || `exit code ${code}`}). The last log lines below usually say why.`;
        }
        resolve();
      });
    });
    proc.once('error', (error) => {
      if (child !== proc) return;
      child = null;
      clearInterval(timer);
      state = 'failed';
      message = `Could not start llama-server: ${error.message}`;
    });
    proc.stdout?.on('data', pushLog);
    proc.stderr?.on('data', pushLog);

    clearInterval(timer);
    timer = setInterval(() => probe(proc), healthIntervalMs);
    timer.unref?.();
    return status();
  }

  async function stop() {
    if (!child) {
      if (state !== 'failed') { state = 'stopped'; message = 'Stopped.'; }
      return status();
    }
    stopping = true;
    const proc = child;
    proc.kill('SIGTERM');
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 8000);
    await exited;
    clearTimeout(killer);
    return status();
  }

  /** Synchronous last resort for process exit, so a 70 GB model is not left holding the RAM. */
  function killNow() {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  return { start, stop, status, url, killNow };
}
