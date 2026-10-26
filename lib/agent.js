import { validateAction, toolKind } from './tools.js';
import { assessAction, needsApproval } from './policy.js';
import { runShell } from './shell.js';
import { redact, clip } from './redact.js';
import { stripReasoning } from './llm/common.js';
import {
  buildSystemPrompt,
  buildTaskMessage,
  formatBrowserObservation,
  formatShellObservation,
  formatClock
} from './prompts.js';

const KEEP_FULL = 4;          // newest observations sent in full; older ones are shortened
const MAX_INVALID = 3;        // bad model replies in a row before giving up
const MAX_ERRORS = 5;         // failed actions in a row before giving up
const REPEAT_WARN = 3;        // identical actions in a row before nudging the model
const LLM_RETRY_DELAYS = [2000, 6000];

const abortError = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pull the first complete JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
  const source = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = source.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new Error('the JSON object was cut off');
}

export function parseReply(text) {
  const data = extractJson(stripReasoning(text));
  const action = data.action && typeof data.action === 'object' ? data.action : data;
  if (typeof action.tool !== 'string') throw new Error('missing "action.tool"');
  return { thought: String(data.thought ?? '').slice(0, 400), tool: action.tool, args: action.args };
}

function shorten(content) {
  const head = String(content).split('\n').slice(0, 2).join(' | ');
  return `${head.slice(0, 300)} [older details omitted]`;
}

/** Wire format for the model: older observations are shortened so long runs keep a small context. */
function toWire(system, history, supportsVision) {
  const lastObservation = history.findLastIndex((entry) => entry.observation);
  let kept = 0;
  const reversed = [...history].reverse().map((entry, i) => {
    if (!entry.observation) return { role: entry.role, content: entry.content };
    kept += 1;
    if (kept > KEEP_FULL) return { role: entry.role, content: shorten(entry.content) };
    const isLast = history.length - 1 - i === lastObservation;
    if (isLast && supportsVision && entry.image) {
      return {
        role: entry.role,
        content: [
          { type: 'text', text: entry.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${entry.image}` } }
        ]
      };
    }
    return { role: entry.role, content: entry.content };
  });
  return [{ role: 'system', content: system }, ...reversed.reverse()];
}

/**
 * Drives one task to the end. Everything it needs from the outside world is passed in, so tests can
 * run it with a scripted model, a fake clock and a fake browser.
 */
export async function runAgent({
  task, options, llm, bridge, shellCwd, secrets = [], signal, emit, requestApproval, setScreenshot,
  now = () => Date.now(), wait = sleep
}) {
  const { startUrl, minutes, everyMinutes, maxSteps, autonomy } = options;
  const startedAt = now();
  const deadline = minutes ? startedAt + minutes * 60_000 : null;
  const clean = (text) => redact(text, secrets);
  const system = buildSystemPrompt({ minutes, everyMinutes, maxSteps, now: new Date(startedAt) });
  const history = [{ role: 'user', content: buildTaskMessage({ task, startUrl, now: new Date(startedAt) }) }];

  let elements = new Map();
  let invalid = 0;
  let errors = 0;
  let lastSignature = '';
  let repeats = 0;

  const timeLeft = () => (deadline ? Math.max(0, Math.round((deadline - now()) / 1000)) : null);
  const isStop = (error) => signal.aborted || error?.name === 'AbortError';
  const stopped = () => ({ status: 'stopped', summary: 'Stopped by you.' });
  const failed = (message) => ({ status: 'failed', summary: message });

  async function ask(extra = []) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await llm.chat({ messages: [...toWire(system, history, llm.supportsVision), ...extra], signal });
      } catch (error) {
        if (isStop(error) || !error.retryable || attempt >= LLM_RETRY_DELAYS.length) throw error;
        emit('note', { text: `The model is busy (${error.message}). Retrying…` });
        await wait(LLM_RETRY_DELAYS[attempt], signal);
      }
    }
  }

  async function wrapUp(status, reason) {
    let summary;
    try {
      const reply = await ask([{
        role: 'user',
        content: `${reason} Reply with {"thought":"...","action":{"tool":"finish","args":{"summary":"..."}}} summarising what you found so far and what is still unfinished.`
      }]);
      try {
        summary = clean(String(parseReply(reply.text).args?.summary || ''));
      } catch {
        // A model asked to "summarise" often just answers in prose; that is still the summary.
        summary = clean(clip(reply.text.trim(), 2000));
      }
    } catch (error) {
      if (isStop(error)) return stopped();
    }
    summary ||= `${reason} No further summary was available.`;
    emit('final', { summary, status });
    return { status, summary };
  }

  async function execute(tool, args) {
    const kind = toolKind(tool);
    if (tool === 'wait') {
      const ms = Math.min(args.seconds * 1000, deadline ? Math.max(0, deadline - now()) : Infinity);
      await wait(ms, signal);
      return { text: `Waited ${Math.round(ms / 1000)}s.` };
    }
    if (kind === 'shell') {
      const result = await runShell(args.command, { cwd: shellCwd, timeoutMs: (args.timeout || 30) * 1000, signal });
      return { text: formatShellObservation(result), ok: result.exitCode === 0 && !result.timedOut };
    }
    const result = await bridge.enqueue({ tool, args }, { signal });
    if (!result || typeof result !== 'object') throw new Error('The browser returned an unreadable result.');
    if (Array.isArray(result.elements)) elements = new Map(result.elements.map((el) => [el.id, el]));
    if (result.screenshot) setScreenshot(Buffer.from(result.screenshot, 'base64'));
    return { text: formatBrowserObservation(result), image: result.screenshot || null, page: { url: result.url, title: result.title } };
  }

  function pushObservation(text, extra = {}) {
    const left = timeLeft();
    const footer = `\n\n[${left === null ? '' : `Time left: ${formatClock(left)} · `}Action ${extra.step} of ${maxSteps}]`;
    history.push({ role: 'user', content: clean(text) + footer, observation: true, image: extra.image });
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal.aborted) return stopped();
    if (deadline && now() >= deadline) return wrapUp('timed_out', 'Your time budget has run out.');

    emit('step', { step, maxSteps, timeLeftSec: timeLeft() });

    let reply;
    try {
      reply = await ask();
    } catch (error) {
      if (isStop(error)) return stopped();
      return failed(error.message);
    }

    let parsed;
    let args;
    try {
      parsed = parseReply(reply.text);
      args = validateAction(parsed.tool, parsed.args);
    } catch (error) {
      invalid += 1;
      emit('note', { text: `The model sent an unusable reply (${error.message}). Asking it to try again.` });
      if (invalid > MAX_INVALID) return failed(`The model kept sending replies this program could not read (${error.message}). Try a stronger model in Settings.`);
      history.push({ role: 'assistant', content: clean(clip(reply.text, 600)) });
      history.push({ role: 'user', content: `That reply was not usable: ${error.message}. Reply with exactly one JSON object: {"thought":"...","action":{"tool":"...","args":{...}}}` });
      continue;
    }
    invalid = 0;
    const { tool } = parsed;
    history.push({ role: 'assistant', content: clean(JSON.stringify({ thought: parsed.thought, action: { tool, args } })) });
    if (parsed.thought) emit('thought', { text: clean(parsed.thought) });

    if (tool === 'finish') {
      const summary = clean(args.summary);
      emit('final', { summary, status: 'completed' });
      return { status: 'completed', summary };
    }

    const signature = `${tool}:${JSON.stringify(args)}`;
    repeats = signature === lastSignature ? repeats + 1 : 1;
    lastSignature = signature;

    const assessment = assessAction(tool, args, { elements });
    emit('action', { tool, args: JSON.parse(clean(JSON.stringify(args))), summary: clean(assessment.summary), level: assessment.level });

    if (assessment.level === 'blocked') {
      pushObservation(`Refused: ${assessment.reason} Choose a different action.`, { step });
      emit('observation', { tool, ok: false, text: assessment.reason });
      continue;
    }

    if (needsApproval(assessment, tool, autonomy)) {
      const decision = await requestApproval({ tool, args, summary: clean(assessment.summary), reason: assessment.reason || 'This mode asks before most actions.' });
      if (decision === 'stopped' || signal.aborted) return stopped();
      if (decision !== 'approved') {
        const text = decision === 'expired'
          ? 'The user did not answer in time, so this action was NOT done. Do not retry it; continue another way or finish.'
          : 'The user DENIED this action, so it was NOT done. Do not retry it; choose another approach or finish and explain.';
        pushObservation(text, { step });
        emit('observation', { tool, ok: false, text });
        continue;
      }
    }

    try {
      const outcome = await execute(tool, args);
      errors = 0;
      let text = outcome.text;
      if (repeats >= REPEAT_WARN && tool !== 'wait') text += `\n\nNOTE: you have now done this exact action ${repeats} times in a row. Try something different or call finish.`;
      pushObservation(text, { step, image: outcome.image });
      emit('observation', { tool, ok: outcome.ok !== false, text: clip(clean(outcome.text), 700), page: outcome.page });
    } catch (error) {
      if (isStop(error)) return stopped();
      errors += 1;
      const text = `Error: ${error.message}`;
      pushObservation(`${text}\nTip: take a "snapshot" to see the current page before trying again.`, { step });
      emit('observation', { tool, ok: false, text: clean(text) });
      if (errors >= MAX_ERRORS) return failed(`Stopped after ${MAX_ERRORS} failed actions in a row. Last error: ${error.message}`);
    }
  }

  return wrapUp('step_limit', `You have used all ${maxSteps} allowed actions.`);
}
