import { httpError } from '../errors.js';

const pipelines = new Map();

// Optional dependency: `npm run setup:local-model` installs @huggingface/transformers.
async function defaultLoader(model) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    throw httpError(400, 'The local model backend is not installed. Run "npm run setup:local-model" in the Codespace, or switch to the Hugging Face API in Settings.');
  }
  return transformers.pipeline('text-generation', model, { dtype: 'q4' });
}

function flatten(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((part) => part.text ?? '').filter(Boolean).join('\n') : m.content
  }));
}

/** Runs a small model inside the Codespace itself. Text only, and much weaker than the hosted models. */
export function createLocalBackend({ model, loader = defaultLoader }) {
  return {
    name: 'hf-local',
    supportsVision: false,
    describe: () => `Local · ${model}`,
    async chat({ messages, signal, maxTokens = 512 }) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      if (!pipelines.has(model)) {
        const loading = loader(model);
        pipelines.set(model, loading);
        loading.catch(() => pipelines.delete(model));
      }
      const generator = await pipelines.get(model);
      const output = await generator(flatten(messages), { max_new_tokens: maxTokens, do_sample: false });
      if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      const generated = output?.[0]?.generated_text;
      const text = Array.isArray(generated) ? generated.at(-1)?.content : generated;
      if (typeof text !== 'string' || !text.trim()) throw httpError(502, `The local model "${model}" returned an empty reply.`);
      return { text, model };
    }
  };
}
