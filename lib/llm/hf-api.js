import { httpError } from '../errors.js';
import { hasImage, stripImages, replyText, stripReasoning } from './common.js';

// Hugging Face Inference Providers expose an OpenAI-compatible chat endpoint.
export const HF_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';

// Transient failures: the agent retries these a couple of times so a long run survives a blip.
const retryable = (error) => Object.assign(error, { retryable: true });

function upstreamError(status, body, model) {
  const detail = String(body?.error?.message ?? body?.error ?? body?.message ?? '').slice(0, 300);
  if (status === 401 || status === 403) return httpError(502, `Hugging Face rejected the token (HTTP ${status}). Check it in Settings. ${detail}`.trim());
  if (status === 402) return httpError(502, 'Hugging Face says this account has no Inference Providers credits left.');
  if (status === 429) return retryable(httpError(502, 'Hugging Face is rate limiting this token. Wait a moment and try again.'));
  if (status === 400 || status === 404) return httpError(502, `Hugging Face could not run "${model}": ${detail || `HTTP ${status}`}. Try another model in Settings.`);
  const error = httpError(502, `Hugging Face error (HTTP ${status}). ${detail}`.trim());
  return status >= 500 ? retryable(error) : error;
}

export function createHfApiBackend({ token, textModel, visionModel, useVision = false, fetchImpl = globalThis.fetch, url = HF_ROUTER_URL, timeoutMs = 90_000 }) {
  return {
    name: 'hf-api',
    supportsVision: Boolean(useVision && visionModel),
    describe: () => `Hugging Face · ${textModel}`,
    async chat({ messages, signal, maxTokens = 1024, temperature = 0.2 }) {
      if (!token) throw httpError(400, 'Add your Hugging Face token in Settings (or set HF_TOKEN) to use hosted models.');
      const withImage = hasImage(messages);
      const model = withImage && useVision ? visionModel : textModel;
      const prepared = withImage && !useVision ? stripImages(messages) : messages;

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: prepared, max_tokens: maxTokens, temperature, stream: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw retryable(httpError(504, `Hugging Face took longer than ${Math.round(timeoutMs / 1000)}s to answer.`));
        if (error?.name === 'AbortError') throw error;
        throw retryable(httpError(502, `Could not reach Hugging Face: ${error?.message || error}`));
      }

      const body = await response.json().catch(() => null);
      if (!response.ok) throw upstreamError(response.status, body, model);
      const text = stripReasoning(replyText(body));
      if (!text) throw httpError(502, `Hugging Face returned an empty reply from "${model}".`);
      return { text, model };
    }
  };
}
