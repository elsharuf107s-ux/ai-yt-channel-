import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.js';

export const BACKENDS = ['hf-api', 'hf-local'];
export const AUTONOMY = ['ask', 'strict', 'auto'];

// Model ids are editable settings: Hugging Face's hosted catalogue changes, so these are starting points.
export const DEFAULTS = Object.freeze({
  backend: 'hf-api',
  hfToken: '',
  textModel: 'Qwen/Qwen2.5-72B-Instruct',
  visionModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
  useVision: false,
  localModel: 'onnx-community/Qwen2.5-0.5B-Instruct',
  autonomy: 'ask',
  maxSteps: 40
});

const ENV_NAMES = {
  backend: 'AI_SHELL_BACKEND',
  hfToken: 'HF_TOKEN',
  textModel: 'AI_SHELL_TEXT_MODEL',
  visionModel: 'AI_SHELL_VISION_MODEL',
  localModel: 'AI_SHELL_LOCAL_MODEL',
  autonomy: 'AI_SHELL_AUTONOMY'
};

const ENUMS = { backend: BACKENDS, autonomy: AUTONOMY };

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function cleanModel(value, label) {
  const model = String(value ?? '').trim();
  if (!model) throw httpError(400, `Enter a ${label} model id.`);
  if (model.length > 120 || /\s/.test(model)) throw httpError(400, `${label} model ids cannot contain spaces.`);
  return model;
}

export function validatePatch(patch = {}) {
  const next = {};
  for (const key of ['backend', 'autonomy']) {
    if (key in patch) {
      const value = String(patch[key] ?? '').trim();
      if (!ENUMS[key].includes(value)) throw httpError(400, `${key} must be one of: ${ENUMS[key].join(', ')}.`);
      next[key] = value;
    }
  }
  if ('hfToken' in patch) {
    const token = String(patch.hfToken ?? '').trim();
    if (token.length > 300 || /\s/.test(token)) throw httpError(400, 'That does not look like a Hugging Face token.');
    next.hfToken = token;
  }
  if ('textModel' in patch) next.textModel = cleanModel(patch.textModel, 'text');
  if ('visionModel' in patch) next.visionModel = cleanModel(patch.visionModel, 'vision');
  if ('localModel' in patch) next.localModel = cleanModel(patch.localModel, 'local');
  if ('useVision' in patch) next.useVision = Boolean(patch.useVision);
  if ('maxSteps' in patch) {
    const steps = Number(patch.maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 500) throw httpError(400, 'Max steps must be a whole number from 1 to 500.');
    next.maxSteps = steps;
  }
  return next;
}

export function createConfigStore({ file, env = process.env } = {}) {
  let saved = null;
  let queue = Promise.resolve();

  async function load() {
    if (saved) return saved;
    saved = {};
    if (!file) return saved;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return saved;
  }

  async function resolve(overrides = {}) {
    const app = await load();
    const config = {};
    const sources = {};
    for (const key of Object.keys(DEFAULTS)) {
      const candidates = [
        ['draft', overrides[key]],
        ['app', app[key]],
        ['env', ENV_NAMES[key] ? env[ENV_NAMES[key]] : undefined]
      ];
      let chosen = [DEFAULTS[key], DEFAULTS[key] === '' ? null : 'default'];
      for (const [source, raw] of candidates) {
        if (raw === undefined || raw === null || raw === '') continue;
        if (ENUMS[key] && !ENUMS[key].includes(String(raw).trim())) continue;
        chosen = [typeof DEFAULTS[key] === 'string' ? String(raw).trim() : raw, source];
        break;
      }
      [config[key], sources[key]] = chosen;
    }
    return { ...config, sources };
  }

  async function publicView() {
    const config = await resolve();
    return {
      backend: config.backend,
      textModel: config.textModel,
      visionModel: config.visionModel,
      useVision: config.useVision,
      localModel: config.localModel,
      autonomy: config.autonomy,
      maxSteps: config.maxSteps,
      hfToken: { set: Boolean(config.hfToken), preview: maskKey(config.hfToken), source: config.sources.hfToken },
      configured: config.backend === 'hf-local' || Boolean(config.hfToken),
      sources: config.sources
    };
  }

  function save(patch) {
    const run = queue.then(async () => {
      const clean = validatePatch(patch);
      const app = { ...(await load()) };
      for (const [key, value] of Object.entries(clean)) {
        if (value === '' && key === 'hfToken') delete app[key];
        else app[key] = value;
      }
      if (file) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(app, null, 2), { mode: 0o600 });
        await fs.rename(tmp, file);
      }
      saved = app;
      return publicView();
    });
    queue = run.catch(() => {});
    return run;
  }

  return { resolve, publicView, save };
}
