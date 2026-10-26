import Anthropic from '@anthropic-ai/sdk';
import { httpError } from '../errors.js';
import { stripReasoning } from './common.js';

const retryable = (error) => Object.assign(error, { retryable: true });

// Anthropic documents server-side fallback for these models: when a safety classifier declines a
// request, the API re-runs it on another model inside the same call instead of returning a refusal.
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Thinking models spend part of max_tokens on thinking, so leave room. It is a ceiling, not a spend.
const MAX_TOKENS = 16_000;

function contentBlocks(content, allowImages) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  const blocks = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text?.trim()) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && allowImages) {
      const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(part.image_url?.url ?? '');
      if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
  }
  return blocks;
}

/**
 * The agent speaks OpenAI-style messages. Anthropic wants the system prompt separately, and blocks
 * with real text, so: split out "system", drop empty text, turn image data-URLs into image blocks,
 * and merge neighbouring turns from the same role.
 */
export function toAnthropicMessages(messages, { images = false } = {}) {
  const system = [];
  const turns = [];
  for (const message of messages) {
    const blocks = contentBlocks(message.content, images);
    if (message.role === 'system') {
      system.push(blocks.map((block) => block.text).filter(Boolean).join('\n'));
      continue;
    }
    if (!blocks.length) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  return { system: system.filter(Boolean).join('\n\n'), messages: turns };
}

const detail = (error) => String(error?.error?.error?.message ?? error?.message ?? '').slice(0, 400);

function mapError(error, model) {
  if (error instanceof Anthropic.APIUserAbortError || error?.name === 'AbortError') {
    return Object.assign(new Error('Stopped'), { name: 'AbortError' });
  }
  if (error instanceof Anthropic.AuthenticationError) return httpError(502, 'Anthropic rejected the API key. Check it in Settings.');
  if (error instanceof Anthropic.PermissionDeniedError) return httpError(502, `Anthropic denied this key access to "${model}": ${detail(error)}`);
  if (error instanceof Anthropic.NotFoundError) return httpError(502, `Anthropic could not find the model "${model}". Check the model name in Settings.`);
  if (error instanceof Anthropic.RateLimitError) return retryable(httpError(502, 'Anthropic is rate limiting this key. Wait a moment and try again.'));
  if (error instanceof Anthropic.BadRequestError) return httpError(502, `Anthropic rejected the request: ${detail(error)}`);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return retryable(httpError(504, 'Anthropic took too long to answer.'));
  if (error instanceof Anthropic.APIConnectionError) return retryable(httpError(502, `Could not reach Anthropic: ${detail(error)}`));
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402) return httpError(502, 'Anthropic says this account has a billing problem (out of credit?). Check your Anthropic console.');
    const wrapped = httpError(502, `Anthropic error (HTTP ${error.status}): ${detail(error)}`);
    return error.status >= 500 ? retryable(wrapped) : wrapped; // includes 529 "overloaded"
  }
  return error;
}

/** Claude through the official Anthropic SDK. */
export function createAnthropicBackend({ apiKey, model, useVision = false, fallbacks = true, fetchImpl, baseURL, maxRetries = 2, timeoutMs }) {
  let client = null;
  const getClient = () => {
    client ??= new Anthropic({
      apiKey,
      maxRetries,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(timeoutMs ? { timeout: timeoutMs } : {})
    });
    return client;
  };

  return {
    name: 'anthropic',
    supportsVision: useVision,
    describe: () => `Claude · ${model}`,
    async chat({ messages, signal }) {
      if (!apiKey) throw httpError(400, 'Add your Anthropic API key in Settings (or set ANTHROPIC_API_KEY) to use Claude.');
      const { system, messages: turns } = toAnthropicMessages(messages, { images: useVision });
      // No temperature / top_p: current Claude models reject sampling parameters.
      const body = { model, max_tokens: MAX_TOKENS, ...(system ? { system } : {}), messages: turns };

      let response;
      try {
        response = fallbacks && FALLBACK_MODELS.has(model)
          ? await getClient().beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
          : await getClient().messages.create(body, { signal });
      } catch (error) {
        throw mapError(error, model);
      }

      // A safety classifier declined (HTTP 200). With fallbacks on, this means the whole chain declined.
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category;
        const why = response.stop_details?.explanation;
        throw httpError(502, `Claude declined this request${category ? ` (${category})` : ''}.${why ? ` ${why}` : ''} Try rewording the task.`);
      }

      const text = stripReasoning((response.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''));
      if (!text) {
        throw httpError(502, response.stop_reason === 'max_tokens'
          ? 'Claude used its whole output limit thinking and gave no answer.'
          : `Claude returned an empty reply from "${model}".`);
      }
      return { text, model: response.model ?? model };
    }
  };
}
