import { createHfApiBackend } from './hf-api.js';
import { createLocalBackend } from './hf-local.js';

/** Build the chat backend selected in Settings. `deps` lets tests inject fetch / a model loader. */
export function createLlm(config, deps = {}) {
  if (config.backend === 'hf-local') {
    return createLocalBackend({ model: config.localModel, loader: deps.localLoader });
  }
  return createHfApiBackend({
    token: config.hfToken,
    textModel: config.textModel,
    visionModel: config.visionModel,
    useVision: config.useVision,
    fetchImpl: deps.fetchImpl
  });
}
