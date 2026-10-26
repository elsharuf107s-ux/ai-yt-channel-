import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.js';

// hf-api    Hugging Face hosted models (needs a token)
// hf-local  a small ONNX model inside the Codespace via transformers.js
// gguf      a GGUF model from Hugging Face that this app downloads and runs in the Codespace (llama.cpp)
// server    any OpenAI-compatible server you run yourself (llama-server, Ollama, LM Studio, vLLM...)
// anthropic Claude, through Anthropic's API (needs an API key; usage is billed by Anthropic)
// openai    ChatGPT models, through OpenAI's API (needs an API key; usage is billed by OpenAI)
export const BACKENDS = ['hf-api', 'hf-local', 'gguf', 'server', 'anthropic', 'openai'];
export const AUTONOMY = ['ask', 'strict', 'auto'];

const SC117_GGUF = 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF';

// Model ids are editable settings: Hugging Face's hosted catalogue changes, so these are starting points.
export const DEFAULTS = Object.freeze({
  backend: 'hf-api',
  hfToken: '',
  textModel: 'Qwen/Qwen2.5-72B-Instruct',
  visionModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
  useVision: false,
  localModel: 'onnx-community/Qwen2.5-0.5B-Instruct',
  modelRepo: SC117_GGUF,
  modelQuant: '',
  modelFile: '',
  modelContext: 16384,
  serverUrl: 'http://127.0.0.1:8080/v1',
  serverModel: SC117_GGUF,
  serverKey: '',
  thinking: false,
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  anthropicFallbacks: true,
  openaiKey: '',
  openaiModel: 'gpt-6-luna', // the default FlipLab uses; change it to any model your key can use
  autonomy: 'ask',
  maxSteps: 40
});

const ENV_NAMES = {
  backend: 'AI_SHELL_BACKEND',
  hfToken: 'HF_TOKEN',
  textModel: 'AI_SHELL_TEXT_MODEL',
  visionModel: 'AI_SHELL_VISION_MODEL',
  localModel: 'AI_SHELL_LOCAL_MODEL',
  modelRepo: 'AI_SHELL_MODEL_REPO',
  modelQuant: 'AI_SHELL_MODEL_QUANT',
  modelFile: 'AI_SHELL_MODEL_FILE',
  serverUrl: 'AI_SHELL_SERVER_URL',
  serverModel: 'AI_SHELL_SERVER_MODEL',
  serverKey: 'AI_SHELL_SERVER_KEY',
  anthropicKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'AI_SHELL_ANTHROPIC_MODEL',
  openaiKey: 'OPENAI_API_KEY',
  openaiModel: 'AI_SHELL_OPENAI_MODEL',
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

function cleanSecret(value, what) {
  const secret = String(value ?? '').trim();
  if (secret.length > 300 || /\s/.test(secret)) throw httpError(400, `That does not look like ${what}.`);
  return secret;
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  let url;
  try { url = new URL(text); } catch { throw httpError(400, 'Enter the model server address, for example http://127.0.0.1:8080/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'The model server address must start with http:// or https://');
  if (url.username || url.password) throw httpError(400, 'Put the API key in its own field, not in the address.');
  return text.replace(/\/+$/, '');
}

function cleanRepo(value) {
  const repo = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,120}$/.test(repo)) throw httpError(400, 'The model repository looks like owner/name, for example SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF.');
  return repo;
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
  if ('hfToken' in patch) next.hfToken = cleanSecret(patch.hfToken, 'a Hugging Face token');
  if ('serverKey' in patch) next.serverKey = cleanSecret(patch.serverKey, 'an API key');
  if ('anthropicKey' in patch) next.anthropicKey = cleanSecret(patch.anthropicKey, 'an Anthropic API key');
  if ('openaiKey' in patch) next.openaiKey = cleanSecret(patch.openaiKey, 'an OpenAI API key');
  if ('anthropicModel' in patch) next.anthropicModel = cleanModel(patch.anthropicModel, 'Claude');
  if ('openaiModel' in patch) next.openaiModel = cleanModel(patch.openaiModel, 'ChatGPT');
  if ('anthropicFallbacks' in patch) next.anthropicFallbacks = Boolean(patch.anthropicFallbacks);
  if ('textModel' in patch) next.textModel = cleanModel(patch.textModel, 'text');
  if ('visionModel' in patch) next.visionModel = cleanModel(patch.visionModel, 'vision');
  if ('localModel' in patch) next.localModel = cleanModel(patch.localModel, 'local');
  if ('serverModel' in patch) next.serverModel = cleanModel(patch.serverModel, 'server');
  if ('serverUrl' in patch) next.serverUrl = cleanUrl(patch.serverUrl);
  if ('modelRepo' in patch) next.modelRepo = cleanRepo(patch.modelRepo);
  if ('modelQuant' in patch) {
    const quant = String(patch.modelQuant ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{0,40}$/.test(quant)) throw httpError(400, 'The quantization looks like Q4_K_M or IQ3_XS.');
    next.modelQuant = quant;
  }
  if ('modelFile' in patch) {
    const file = String(patch.modelFile ?? '').trim();
    if (file && (!/^[\w./-]{1,200}\.gguf$/i.test(file) || file.startsWith('/') || file.includes('..'))) {
      throw httpError(400, 'The model file is a path inside the models/ folder that ends in .gguf.');
    }
    next.modelFile = file;
  }
  if ('modelContext' in patch) {
    const size = Number(patch.modelContext);
    if (!Number.isInteger(size) || size < 2048 || size > 262_144) throw httpError(400, 'Context size must be a whole number from 2048 to 262144.');
    next.modelContext = size;
  }
  if ('useVision' in patch) next.useVision = Boolean(patch.useVision);
  if ('thinking' in patch) next.thinking = Boolean(patch.thinking);
  if ('maxSteps' in patch) {
    const steps = Number(patch.maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 500) throw httpError(400, 'Max steps must be a whole number from 1 to 500.');
    next.maxSteps = steps;
  }
  return next;
}

const SECRETS = ['hfToken', 'serverKey', 'anthropicKey', 'openaiKey'];

/** Why this brain cannot be used yet, or null when it has what it needs. */
export function credentialProblem(config) {
  if (config.backend === 'hf-api' && !config.hfToken) return 'Add your Hugging Face token in Settings first (or choose another brain).';
  if (config.backend === 'anthropic' && !config.anthropicKey) return 'Add your Anthropic API key in Settings first (or set ANTHROPIC_API_KEY).';
  if (config.backend === 'openai' && !config.openaiKey) return 'Add your OpenAI API key in Settings first (or set OPENAI_API_KEY).';
  return null;
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
    const secret = (key) => ({ set: Boolean(config[key]), preview: maskKey(config[key]), source: config.sources[key] });
    const view = {
      configured: !credentialProblem(config),
      sources: config.sources
    };
    for (const key of Object.keys(DEFAULTS)) {
      view[key] = SECRETS.includes(key) ? secret(key) : config[key];
    }
    return view;
  }

  function save(patch) {
    const run = queue.then(async () => {
      const clean = validatePatch(patch);
      const app = { ...(await load()) };
      for (const [key, value] of Object.entries(clean)) {
        if (value === '' && (SECRETS.includes(key) || key === 'modelQuant' || key === 'modelFile')) delete app[key];
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
