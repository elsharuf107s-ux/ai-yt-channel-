import { httpError } from '../errors.js';
import { createHfApiBackend } from './hf-api.js';
import { createLocalBackend } from './hf-local.js';
import { createServerBackend } from './server.js';
import { createAnthropicBackend } from './anthropic.js';
import { createOpenAiBackend } from './openai.js';

const NOT_READY = {
  stopped: 'The built-in model is not running. Open Settings and press "Start model".',
  starting: 'The built-in model is still starting (downloading or loading). Wait until Settings says Ready, then try again.',
  failed: 'The built-in model stopped. Open Settings to read why, then start it again.'
};

/**
 * Build the chat backend selected in Settings.
 * `deps` lets the app pass the model runner, and lets tests inject fetch / a model loader.
 */
export function createLlm(config, deps = {}) {
  if (config.backend === 'hf-local') {
    return createLocalBackend({ model: config.localModel, loader: deps.localLoader });
  }

  if (config.backend === 'server') {
    return createServerBackend({
      url: config.serverUrl,
      model: config.serverModel,
      apiKey: config.serverKey,
      thinking: config.thinking,
      fetchImpl: deps.fetchImpl
    });
  }

  if (config.backend === 'anthropic') {
    return createAnthropicBackend({
      apiKey: config.anthropicKey,
      model: config.anthropicModel,
      useVision: config.useVision,
      fallbacks: config.anthropicFallbacks,
      fetchImpl: deps.fetchImpl,
      baseURL: deps.baseURL,
      maxRetries: deps.maxRetries
    });
  }

  if (config.backend === 'openai') {
    return createOpenAiBackend({ apiKey: config.openaiKey, model: config.openaiModel, useVision: config.useVision, fetchImpl: deps.fetchImpl });
  }

  if (config.backend === 'gguf') {
    const { runner } = deps;
    if (!runner) throw httpError(500, 'The built-in model runner is not available.');
    const inner = createServerBackend({ url: runner.url, model: config.modelRepo, thinking: config.thinking, fetchImpl: deps.fetchImpl });
    // Fail fast with a plain explanation instead of a connection error.
    const check = () => {
      const { state } = runner.status();
      if (state !== 'ready') throw httpError(400, NOT_READY[state] || NOT_READY.stopped);
    };
    return {
      ...inner,
      name: 'gguf',
      describe: () => `Built-in model · ${config.modelRepo}`,
      check,
      async chat(options) {
        check();
        return inner.chat(options);
      }
    };
  }

  return createHfApiBackend({
    token: config.hfToken,
    textModel: config.textModel,
    visionModel: config.visionModel,
    useVision: config.useVision,
    fetchImpl: deps.fetchImpl
  });
}
