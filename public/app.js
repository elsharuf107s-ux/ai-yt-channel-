import { parseTimePlan, formatMinutes } from '/shared/duration.js';

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['running', 'awaiting_approval']);

const EXAMPLES = {
  site: 'Go to https://news.ycombinator.com and tell me the titles of the top 5 stories.',
  time: 'Open https://example.com and watch it for 20 minutes. Check every 5 minutes and tell me if anything on the page changes.',
  check: "Check tomorrow's weather forecast for London on bbc.com/weather and tell me whether rain is expected.",
  shell: 'Run "node --version" and "ls" in the workspace and tell me what you see.'
};

const FINISHED_TEXT = {
  completed: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
  timed_out: 'Time limit reached',
  step_limit: 'Action limit reached'
};

const state = { runId: null, lastSeq: 0, timer: null, status: 'idle', deadline: null, stepText: '', approvals: new Map(), lastPage: null };

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-requested-with': 'ai-shell' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setNote(text, kind = 'warn') {
  const note = $('form-note');
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('good', kind === 'good');
}

function clock(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h2 = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h2 ? `${h2}:${mm}:${ss}` : `${m}:${ss}`;
}

/* ---------- time plan under the prompt ---------- */

function renderPlan() {
  const field = Number($('minutes').value);
  const plan = parseTimePlan($('task').value);
  const parts = [];
  if (field > 0) parts.push(`Will work for up to ${formatMinutes(field)} (from the time limit field)`);
  else if (plan.minutes) parts.push(`Will work for up to ${formatMinutes(plan.minutes)} (from your prompt)`);
  else parts.push('No time limit: it stops when the task is done');
  if (plan.everyMinutes) parts.push(`checking about every ${formatMinutes(plan.everyMinutes)}`);
  $('plan').textContent = parts.join(', ') + '.';
  try { localStorage.setItem('ai-shell-draft', $('task').value); } catch { /* storage may be unavailable */ }
}

/* ---------- status chips ---------- */

function chip(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('warn', kind === 'warn');
}

async function refreshHealth() {
  try {
    const health = await api('/api/health');
    chip('chip-brain', health.configured ? `Brain: ${health.model}` : 'Brain: add a Hugging Face token in Settings', health.configured ? 'ok' : 'warn');
    chip('chip-bridge', health.bridge.online ? 'Browser: connected' : 'Browser: not connected', health.bridge.online ? 'ok' : 'warn');
    const modes = { ask: ['Safety: asks before risky actions', 'ok'], strict: ['Safety: asks before almost everything', 'ok'], auto: ['Safety: never asks', 'warn'] };
    chip('chip-mode', ...(modes[health.autonomy] || [`Safety: ${health.autonomy}`, null]));
    if (!state.lastPage) {
      $('empty-title').textContent = health.bridge.online ? 'Browser connected. It will appear here once a task uses it.' : 'Waiting for the browser on your computer';
    }
    $('setup-help').hidden = health.bridge.online;
    return health;
  } catch {
    chip('chip-brain', 'Server not reachable', 'warn');
    return null;
  }
}

/* ---------- feed ---------- */

function append(el, { reveal = false } = {}) {
  $('feed').append(el);
  if (reveal) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return el;
}

function setShot(version) {
  const img = $('shot');
  img.src = `/api/runs/${state.runId}/screenshot?v=${version}`;
  img.hidden = false;
  $('shot-empty').hidden = true;
}

function updateTitle() {
  document.title = state.approvals.size ? '(!) Approval needed · AI Shell' : 'AI Shell';
}

function approvalCard(event) {
  const approve = h('button', { class: 'btn primary', type: 'button', text: 'Approve' });
  const deny = h('button', { class: 'btn', type: 'button', text: 'Deny' });
  const actions = h('div', { class: 'actions' }, approve, deny);
  const decide = async (decision) => {
    approve.disabled = true;
    deny.disabled = true;
    try {
      await api(`/api/runs/${state.runId}/approvals/${event.approvalId}`, { method: 'POST', body: { decision } });
    } catch (error) {
      approve.disabled = false;
      deny.disabled = false;
      setNote(error.message);
    }
  };
  approve.addEventListener('click', () => decide('approve'));
  deny.addEventListener('click', () => decide('deny'));
  const card = h('li', { class: 'card approval' },
    h('h3', { text: 'Approval needed' }),
    h('div', { class: 'body', text: event.summary }),
    h('p', { class: 'why', text: event.reason }),
    actions);
  state.approvals.set(event.approvalId, { card, actions });
  updateTitle();
  return card;
}

const DECISIONS = { approved: 'Approved', denied: 'Denied', expired: 'No answer in time: not done', stopped: 'Stopped' };

function renderEvent(event) {
  switch (event.type) {
    case 'step':
      state.stepText = `Action ${event.step} of ${event.maxSteps}`;
      break;
    case 'thought':
      append(h('li', { class: 'thought', text: event.text }));
      break;
    case 'action':
      append(h('li', { class: 'action' },
        h('span', { class: `badge${event.level === 'risky' ? ' risky' : ''}`, text: event.tool }),
        event.summary));
      break;
    case 'approval':
      append(approvalCard(event), { reveal: true });
      break;
    case 'approval_result': {
      const entry = state.approvals.get(event.approvalId);
      if (entry) {
        entry.actions.replaceChildren(h('strong', { text: DECISIONS[event.decision] || event.decision }));
        state.approvals.delete(event.approvalId);
        updateTitle();
      }
      break;
    }
    case 'observation': {
      if (event.page) {
        state.lastPage = event.page;
        $('shot-caption').textContent = [event.page.title, event.page.url].filter(Boolean).join(' · ');
      }
      const first = String(event.text).split('\n')[0].slice(0, 140);
      const label = event.ok ? (event.page ? `Saw: ${event.page.title || event.page.url}` : 'Result') : `Problem: ${first}`;
      append(h('li', { class: `obs${event.ok ? '' : ' bad'}` },
        h('details', {}, h('summary', { text: label }), h('pre', { text: event.text }))));
      break;
    }
    case 'note':
      append(h('li', { class: 'note-item', text: event.text }));
      break;
    case 'screenshot':
      setShot(event.version);
      break;
    case 'final': {
      const title = event.status === 'completed' ? 'Result' : FINISHED_TEXT[event.status] || 'Result';
      append(h('li', { class: 'card final' }, h('h3', { text: title }), h('div', { class: 'body', text: event.summary })), { reveal: true });
      break;
    }
    case 'error':
      append(h('li', { class: 'card error' }, h('h3', { text: 'Something went wrong' }), h('div', { class: 'body', text: event.message })), { reveal: true });
      break;
    default:
      break;
  }
}

/* ---------- run lifecycle ---------- */

function renderStatus() {
  const active = ACTIVE.has(state.status);
  $('run').disabled = active;
  $('improve').disabled = active;
  $('stop').hidden = !active;
  let text = 'Idle';
  if (state.status === 'running') {
    const left = state.deadline ? ` · ${clock((state.deadline - Date.now()) / 1000)} left` : '';
    text = `Working · ${state.stepText || 'starting'}${left}`;
  } else if (state.status === 'awaiting_approval') {
    text = 'Waiting for your approval';
  } else if (FINISHED_TEXT[state.status]) {
    text = FINISHED_TEXT[state.status];
  }
  $('status-line').textContent = text;
}

function applyView(view) {
  state.status = view.status;
  state.deadline = view.deadline ? Date.parse(view.deadline) : null;
  for (const event of view.events) renderEvent(event);
  state.lastSeq = view.lastSeq;
  renderStatus();
  if (!ACTIVE.has(view.status)) {
    stopPolling();
    refreshHealth();
  }
}

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

async function poll() {
  if (!state.runId) return;
  try {
    applyView(await api(`/api/runs/${state.runId}?after=${state.lastSeq}`));
  } catch (error) {
    stopPolling();
    state.status = 'failed';
    renderStatus();
    setNote(`Lost contact with the run: ${error.message}`);
  }
}

function beginRun(view) {
  stopPolling();
  state.runId = view.id;
  state.lastSeq = 0;
  state.stepText = '';
  state.lastPage = null;
  state.approvals.clear();
  updateTitle();
  $('feed').replaceChildren();
  $('shot').hidden = true;
  $('shot-empty').hidden = false;
  $('shot-caption').textContent = '';
  applyView(view);
  if (ACTIVE.has(view.status)) state.timer = setInterval(poll, 1000);
}

async function startRun() {
  const task = $('task').value.trim();
  if (!task) { setNote('Type what you want done first.'); return; }
  setNote('');
  $('run').disabled = true;
  try {
    const body = { task, startUrl: $('start-url').value.trim() || undefined, minutes: $('minutes').value.trim() || undefined };
    beginRun(await api('/api/runs', { method: 'POST', body }));
  } catch (error) {
    setNote(error.message);
    renderStatus();
  }
}

async function stopRun() {
  $('stop').disabled = true;
  try {
    await api(`/api/runs/${state.runId}/stop`, { method: 'POST' });
    await poll();
  } catch (error) {
    setNote(error.message);
  } finally {
    $('stop').disabled = false;
  }
}

async function improvePrompt() {
  const text = $('task').value.trim();
  if (!text) { setNote('Type a rough idea first, then press Improve prompt.'); return; }
  setNote('');
  const button = $('improve');
  button.disabled = true;
  button.textContent = 'Improving…';
  try {
    const { prompt } = await api('/api/prompt/improve', { method: 'POST', body: { text, startUrl: $('start-url').value.trim() || undefined } });
    const box = $('task');
    box.focus();
    box.select();
    if (!document.execCommand('insertText', false, prompt)) box.value = prompt;
    renderPlan();
    setNote('Rewritten. Read it, change anything you like, then press Run. Ctrl+Z undoes it.', 'good');
  } catch (error) {
    setNote(error.message);
  } finally {
    button.textContent = 'Improve prompt';
    renderStatus();
  }
}

/* ---------- settings ---------- */

function toggleBackendGroups() {
  const local = $('set-backend').value === 'hf-local';
  $('group-api').hidden = local;
  $('group-local').hidden = !local;
}

function settingsMessage(text, kind = 'warn') {
  const el = $('settings-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('good', kind === 'good');
}

async function openSettings() {
  settingsMessage('');
  try {
    const s = await api('/api/settings');
    $('set-backend').value = s.backend;
    $('set-text-model').value = s.textModel;
    $('set-vision-model').value = s.visionModel;
    $('set-use-vision').checked = s.useVision;
    $('set-local-model').value = s.localModel;
    $('set-autonomy').value = s.autonomy;
    $('set-max-steps').value = s.maxSteps;
    $('set-token').value = '';
    $('set-clear-token').checked = false;
    $('token-state').textContent = s.hfToken.set ? `(saved: ${s.hfToken.preview}, from ${s.hfToken.source})` : '(not set)';
    toggleBackendGroups();
    $('settings').showModal();
  } catch (error) {
    setNote(error.message);
  }
}

function settingsPatch() {
  const patch = {
    backend: $('set-backend').value,
    textModel: $('set-text-model').value,
    visionModel: $('set-vision-model').value,
    useVision: $('set-use-vision').checked,
    localModel: $('set-local-model').value,
    autonomy: $('set-autonomy').value,
    maxSteps: Number($('set-max-steps').value)
  };
  const token = $('set-token').value.trim();
  if (token) patch.hfToken = token;
  else if ($('set-clear-token').checked) patch.hfToken = '';
  return patch;
}

async function saveSettings() {
  try {
    await api('/api/settings', { method: 'PATCH', body: settingsPatch() });
    settingsMessage('Saved.', 'good');
    $('set-token').value = '';
    $('set-clear-token').checked = false;
    refreshHealth();
  } catch (error) {
    settingsMessage(error.message);
  }
}

async function testSettings() {
  const button = $('settings-test');
  button.disabled = true;
  settingsMessage('Asking the model…', 'good');
  try {
    const result = await api('/api/settings/test', { method: 'POST', body: settingsPatch() });
    settingsMessage(`It works. ${result.model} replied: ${result.reply}`, 'good');
  } catch (error) {
    settingsMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- start-up ---------- */

function wire() {
  $('run').addEventListener('click', startRun);
  $('stop').addEventListener('click', stopRun);
  $('improve').addEventListener('click', improvePrompt);
  $('task').addEventListener('input', renderPlan);
  $('minutes').addEventListener('input', renderPlan);
  $('task').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('run').disabled) startRun();
  });
  for (const button of document.querySelectorAll('[data-example]')) {
    button.addEventListener('click', () => {
      $('task').value = EXAMPLES[button.dataset.example];
      renderPlan();
      $('task').focus();
    });
  }
  $('open-settings').addEventListener('click', openSettings);
  $('set-backend').addEventListener('change', toggleBackendGroups);
  $('settings-save').addEventListener('click', saveSettings);
  $('settings-test').addEventListener('click', testSettings);
  $('settings-close').addEventListener('click', () => $('settings').close());
}

async function init() {
  wire();
  try { $('task').value = localStorage.getItem('ai-shell-draft') || ''; } catch { /* storage may be unavailable */ }
  renderPlan();
  const health = await refreshHealth();
  setInterval(refreshHealth, 4000);
  setInterval(() => { if (state.status === 'running') renderStatus(); }, 1000);

  // Reconnect to a task that is still running (or show the last one) after a page reload.
  try {
    const runs = await api('/api/runs');
    const target = health?.activeRunId || runs[0]?.id;
    if (target) beginRun(await api(`/api/runs/${target}`));
  } catch { /* no earlier run */ }
}

init();
