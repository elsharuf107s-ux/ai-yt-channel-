// Secrets must never reach the model, the UI log, or a run transcript.
// Known secret values are replaced exactly; common token shapes are replaced by pattern.
const PATTERNS = [
  /hf_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g
];

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
}
