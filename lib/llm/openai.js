import { httpError } from '../errors.js';
import { stripImages, replyText, stripReasoning } from './common.js';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const retryable = (error) => Object.assign(error, { retryable: true });

function upstreamError(status, body, model) {
  const info = body?.error ?? {};
  const detail = String(info.message ?? body?.message ?? '').slice(0, 300);
  if (status === 401) return httpError(502, 'OpenAI rejected the API key. Check it in Settings.');
  if (status === 403) return httpError(502, `OpenAI denied this key access: ${detail}`);
  if (status === 404) return httpError(502, `OpenAI could not find the model "${model}" for this key. Check the model name in Settings. ${detail}`.trim());
  if (status === 429) {
    // The same status covers "slow down" and "you are out of credit"; only the first is worth retrying.
    return info.code === 'insufficient_quota'
      ? httpError(502, 'OpenAI says this account is out of quota or credit. Check your billing on platform.openai.com.')
      : retryable(httpError(502, 'OpenAI is rate limiting this key. Wait a moment and try again.'));
  }
  if (status === 400 || status === 422) return httpError(502, `OpenAI rejected the request for "${model}": ${detail || `HTTP ${status}`}`);
  const error = httpError(502, `OpenAI error (HTTP ${status}). ${detail}`.trim());
  return status >= 500 ? retryable(error) : error;
}

/** ChatGPT models through OpenAI's Chat Completions API. */
export function createOpenAiBackend({ apiKey, model, useVision = false, fetchImpl = globalThis.fetch, url = OPENAI_URL, timeoutMs = 180_000 }) {
  return {
    name: 'openai',
    supportsVision: useVision,
    describe: () => `ChatGPT · ${model}`,
    async chat({ messages, signal }) {
      if (!apiKey) throw httpError(400, 'Add your OpenAI API key in Settings (or set OPENAI_API_KEY) to use ChatGPT.');
      // max_completion_tokens works for every current chat model (older max_tokens is rejected by the
      // reasoning models), and reasoning models only accept the default temperature, so none is sent.
      const body = { model, messages: useVision ? messages : stripImages(messages), max_completion_tokens: 8192 };

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw retryable(httpError(504, `OpenAI took longer than ${Math.round(timeoutMs / 1000)}s to answer.`));
        if (error?.name === 'AbortError') throw error;
        throw retryable(httpError(502, `Could not reach OpenAI: ${error?.message || error}`));
      }

      const json = await response.json().catch(() => null);
      if (!response.ok) throw upstreamError(response.status, json, model);

      const choice = json?.choices?.[0];
      const text = stripReasoning(replyText(json));
      if (!text) {
        if (choice?.message?.refusal) throw httpError(502, `ChatGPT declined this request: ${String(choice.message.refusal).slice(0, 300)}`);
        throw httpError(502, choice?.finish_reason === 'length'
          ? 'The model used its whole output limit before answering (reasoning models count thinking against it).'
          : `OpenAI returned an empty reply from "${model}".`);
      }
      return { text, model: json?.model ?? model };
    }
  };
}
