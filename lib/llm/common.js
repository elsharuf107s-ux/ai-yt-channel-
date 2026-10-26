// Helpers shared by the chat backends.

export const hasImage = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'));

export function stripImages(messages) {
  return messages.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.filter((part) => part.type !== 'image_url').map((part) => part.text ?? '').join('\n') }
    : m));
}

/** The reply text from an OpenAI-style chat completion body. */
export function replyText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  return '';
}

/**
 * Qwen3-style models may write their reasoning in <think>…</think> before the answer. That text is
 * not the answer (and can contain braces that look like JSON), so it is removed. Also handles a
 * chat template that already opened the tag (only "</think>" appears) and a reply cut off mid-thought.
 */
export function stripReasoning(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}
