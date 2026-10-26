import crypto from 'node:crypto';
import { httpError } from './errors.js';
import { runAgent } from './agent.js';
import { parseTimePlan, MAX_MINUTES } from './duration.js';
import { credentialProblem } from './config.js';

const MAX_EVENTS = 2000;
const MAX_RUNS = 20;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const ACTIVE = new Set(['running', 'awaiting_approval']);

function cleanStartUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  let text = String(value).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw httpError(400, 'The "Start at" website is not a valid address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'The "Start at" website must be an http or https address.');
  return url.toString();
}

function cleanMinutes(value) {
  if (value === undefined || value === null || value === '') return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > MAX_MINUTES) {
    throw httpError(400, `Time limit must be between 0.5 and ${MAX_MINUTES} minutes.`);
  }
  return minutes;
}

export function createRunManager({ configStore, bridge, createLlm, shellCwd, bridgeToken = '', now = () => Date.now(), wait, approvalTimeoutMs = APPROVAL_TIMEOUT_MS }) {
  const runs = new Map();

  const active = () => [...runs.values()].find((run) => ACTIVE.has(run.status)) || null;

  function emit(run, type, data = {}) {
    run.seq += 1;
    run.events.push({ seq: run.seq, at: new Date(now()).toISOString(), type, ...data });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  function setStatus(run, status) {
    run.status = status;
    emit(run, 'status', { status });
  }

  function requestApproval(run, info) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const limits = [approvalTimeoutMs];
      if (run.deadline) limits.push(Math.max(0, run.deadline - now()));
      const timer = setTimeout(() => settle('expired'), Math.min(...limits));
      const onAbort = () => settle('stopped');
      const settle = (decision) => {
        if (!run.pending.delete(id)) return;
        clearTimeout(timer);
        run.controller.signal.removeEventListener('abort', onAbort);
        emit(run, 'approval_result', { approvalId: id, decision });
        if (ACTIVE.has(run.status)) setStatus(run, 'running');
        resolve(decision);
      };
      run.pending.set(id, { id, ...info, settle });
      run.controller.signal.addEventListener('abort', onAbort, { once: true });
      setStatus(run, 'awaiting_approval');
      emit(run, 'approval', { approvalId: id, tool: info.tool, summary: info.summary, reason: info.reason });
    });
  }

  function prune() {
    const finished = [...runs.values()].filter((run) => !ACTIVE.has(run.status));
    while (runs.size > MAX_RUNS && finished.length) runs.delete(finished.shift().id);
  }

  async function start({ task, startUrl, minutes } = {}) {
    const text = String(task ?? '').trim();
    if (!text) throw httpError(400, 'Tell the AI what to do first.');
    if (text.length > 4000) throw httpError(400, 'That task is too long (max 4000 characters).');
    if (active()) throw httpError(409, 'A task is already running. Stop it or wait for it to finish.');

    const config = await configStore.resolve();
    const missing = credentialProblem(config);
    if (missing) throw httpError(400, missing);
    const plan = parseTimePlan(text);
    const explicit = cleanMinutes(minutes);
    const budget = explicit ?? plan.minutes;
    const options = {
      startUrl: cleanStartUrl(startUrl),
      minutes: budget,
      minutesSource: explicit ? 'field' : plan.minutes ? 'prompt' : null,
      everyMinutes: plan.everyMinutes,
      maxSteps: budget ? Math.max(config.maxSteps, 150) : config.maxSteps,
      autonomy: config.autonomy
    };

    const llm = createLlm(config);
    llm.check?.();
    const run = {
      id: crypto.randomUUID(),
      task: text,
      options,
      model: llm.describe?.() ?? llm.name,
      status: 'running',
      createdAt: new Date(now()).toISOString(),
      endedAt: null,
      summary: null,
      seq: 0,
      events: [],
      pending: new Map(),
      controller: new AbortController(),
      screenshot: null,
      screenshotVersion: 0,
      deadline: budget ? now() + budget * 60_000 : null
    };
    runs.set(run.id, run);
    prune();
    emit(run, 'status', { status: 'running' });

    const secrets = [config.hfToken, config.serverKey, config.anthropicKey, config.openaiKey, bridgeToken].filter(Boolean);
    runAgent({
      task: text,
      options,
      llm,
      bridge,
      shellCwd,
      secrets,
      signal: run.controller.signal,
      emit: (type, data) => emit(run, type, data),
      requestApproval: (info) => requestApproval(run, info),
      setScreenshot: (buffer) => {
        run.screenshot = buffer;
        run.screenshotVersion += 1;
        emit(run, 'screenshot', { version: run.screenshotVersion });
      },
      now,
      ...(wait ? { wait } : {})
    }).then(
      (result) => finish(run, result.status, result.summary),
      (error) => finish(run, 'failed', error?.message || 'The run crashed.')
    );

    return view(run, 0);
  }

  function finish(run, status, summary) {
    for (const pending of [...run.pending.values()]) pending.settle('stopped');
    run.summary = summary;
    run.endedAt = new Date(now()).toISOString();
    if (status === 'failed') emit(run, 'error', { message: summary });
    run.status = status;
    emit(run, 'done', { status, summary });
  }

  function view(run, after = 0) {
    return {
      id: run.id,
      task: run.task,
      status: run.status,
      model: run.model,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      summary: run.summary,
      options: run.options,
      deadline: run.deadline ? new Date(run.deadline).toISOString() : null,
      screenshotVersion: run.screenshotVersion,
      pending: [...run.pending.values()].map(({ id, tool, summary, reason }) => ({ id, tool, summary, reason })),
      lastSeq: run.seq,
      events: run.events.filter((event) => event.seq > after)
    };
  }

  function stop(id) {
    const run = runs.get(id);
    if (!run) throw httpError(404, 'That run was not found.');
    if (ACTIVE.has(run.status)) run.controller.abort();
    return view(run, run.seq);
  }

  function decide(runId, approvalId, decision) {
    const run = runs.get(runId);
    if (!run) throw httpError(404, 'That run was not found.');
    const pending = run.pending.get(approvalId);
    if (!pending) throw httpError(404, 'That approval is no longer waiting.');
    if (decision !== 'approve' && decision !== 'deny') throw httpError(400, 'Decision must be "approve" or "deny".');
    pending.settle(decision === 'approve' ? 'approved' : 'denied');
    return view(run, run.seq);
  }

  return {
    start,
    stop,
    decide,
    active,
    get: (id) => runs.get(id),
    view,
    list: () => [...runs.values()].reverse().map((run) => ({ ...view(run, run.seq), events: [] }))
  };
}
