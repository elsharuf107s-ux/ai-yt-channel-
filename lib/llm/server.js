import { httpError } from '../errors.js';
import { stripImages, hasImage, replyText, stripReasoning } from './common.js';

const retryable = (error) => Object.assign(error, { retryable: true });

/** "http://host:8080/v1" -> "http://host:8080/v1/chat/completions" */
export function chatCompletionsUrl(base) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  // Work on a plain string: assigning an empty pathname makes URL put a "/" back.
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/chat/completions')) pathname += '/chat/completions';
  url.pathname = pathname;
  return url.toString();
}

function upstreamError(status, body, model, url) {
  const detail = String(body?.error?.message ?? body?.error ?? body?.message ?? '').slice(0, 300);
  if (status === 401 || status === 403) return httpError(502, `The model server rejected the API key (HTTP ${status}). Check it in Settings.`);
  if (status === 404) return httpError(502, `The model server answered 404 at ${url}. The address usually needs to end in /v1, and the model name must match what the server loaded. ${detail}`.trim());
  if (status === 400) return httpError(502, `The model server could not run "${model}": ${detail || 'HTTP 400'}`);
  // 503 is what llama-server answers while it is still loading a big model.
  return retryable(httpError(502, `The model server returned HTTP ${status}${status === 503 ? ' (it may still be loading the model)' : ''}. ${detail}`.trim()));
}

/**
 * Any OpenAI-compatible chat server: llama.cpp's llama-server, Ollama (/v1), LM Studio, vLLM...
 * This is how a GGUF model from Hugging Face is used, since GGUF files are run by llama.cpp.
 */
export function createServerBackend({ url, model, apiKey = '', thinking = false, fetchImpl = globalThis.fetch, timeoutMs = 600_000 }) {
  const endpoint = chatCompletionsUrl(url);
  return {
    name: 'server',
    supportsVision: false,
    describe: () => `Model server · ${model}`,
    async chat({ messages, signal, maxTokens = 2048, temperature = 0.2 }) {
      const prepared = hasImage(messages) ? stripImages(messages) : messages;
      const body = {
        model,
        messages: prepared,
        // A model that thinks first needs room for the thinking AND the answer.
        max_tokens: thinking ? Math.max(maxTokens, 4096) : maxTokens,
        temperature,
        stream: false,
        // Qwen3-style chat templates honour this; servers that do not know it ignore it.
        ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } })
      };

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw retryable(httpError(504, `The model server took longer than ${Math.round(timeoutMs / 1000)}s to answer.`));
        if (error?.name === 'AbortError') throw error;
        const reason = error?.cause?.code || error?.message || error;
        throw retryable(httpError(502, `Could not reach the model server at ${endpoint} (${reason}). Is it running, and can the Codespace reach that address?`));
      }

      const json = await response.json().catch(() => null);
      if (!response.ok) throw upstreamError(response.status, json, model, endpoint);
      const raw = replyText(json);
      const text = stripReasoning(raw);
      if (!text) {
        throw httpError(502, raw.trim()
          ? 'The model only wrote its reasoning and never gave an answer (it probably ran out of tokens while thinking). Turn thinking off in Settings.'
          : `The model server returned an empty reply from "${model}".`);
      }
      return { text, model };
    }
  };
}
