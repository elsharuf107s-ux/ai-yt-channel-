import { spawn } from 'node:child_process';
import fs from 'node:fs';

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH)/i;

/** Child processes never inherit tokens, so `printenv` or `env` cannot leak them. */
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
}

export function runShell(command, { cwd, timeoutMs = 30_000, maxOutput = 20_000, signal, env = scrubbedEnv() } = {}) {
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const collect = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutput) {
        truncated = true;
        return next.slice(0, maxOutput);
      }
      return next;
    };

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });

    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const onAbort = () => { aborted = true; killGroup(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (exitCode, exitSignal) => finish(() => {
      if (aborted) return reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      resolve({ exitCode, signal: exitSignal, stdout, stderr, truncated, timedOut });
    }));
  });
}
