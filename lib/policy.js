// Decides which actions run on their own and which need the user's Approve button.
//   safe    - runs without asking in "ask" mode
//   risky   - needs approval in "ask" mode
//   blocked - never runs, in any mode
// Modes: ask (risky actions need approval), strict (everything but looking/waiting needs approval),
//        auto (nothing asks; only "blocked" is still refused).

const RISKY_LABEL = /\b(buy|purchase|pay|checkout|check out|place (?:your |the )?order|order now|subscribe|donate|delete|remove|erase|cancel (?:subscription|order|account|plan)|close account|send|submit|post|publish|tweet|reply|confirm|transfer|withdraw|sign ?out|log ?out|unfollow|unsubscribe|authorize|grant access|install|download)\b/i;
const SENSITIVE_FIELD = /(password|passcode|card number|credit card|cvv|cvc|security code|ssn|social security|routing number|iban)/i;

const BLOCKED_SHELL = [
  /\brm\s+(?:-\S+\s+)+(?:\/|~|\$HOME|\/\*|\.\.?)(?:\s|$)/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  />\s*\/dev\/(?:sd|nvme|vd|hd)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\b(?:shutdown|reboot|poweroff|halt)\b/
];

const SAFE_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'date', 'whoami', 'uname', 'df', 'du', 'which', 'grep']);
const NO_PATH_CHECK = new Set(['echo', 'date', 'whoami', 'uname', 'pwd']);
const GIT_SAFE = new Set(['status', 'log', 'diff', 'branch', 'show']);
const SHELL_METACHARS = /[;&|<>`$(){}\\\n\r~]/;
const SENSITIVE_PATH = /(^|\/)(\.env[^/]*|data|\.git|\.ssh|\.aws|\.npmrc|\.netrc)(\/|$)/;

export const QUIET_TOOLS = new Set(['snapshot', 'wait', 'scroll', 'finish']);

export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function isSafeShell(command) {
  const text = String(command).trim();
  if (!text || SHELL_METACHARS.test(text)) return false;
  const [cmd, ...args] = text.split(/\s+/);
  const bare = args.map((arg) => arg.replace(/^["']+|["']+$/g, ''));
  if (cmd === 'node' || cmd === 'npm') return args.length === 1 && (args[0] === '-v' || args[0] === '--version');
  if (cmd === 'git') {
    if (!GIT_SAFE.has(bare[0])) return false;
    if (bare.some((arg) => arg.startsWith('--output') || arg === '-o' || arg === '--ext-diff')) return false;
  } else if (!SAFE_COMMANDS.has(cmd)) {
    return false;
  }
  if (NO_PATH_CHECK.has(cmd)) return true;
  return bare.every((arg) => arg.startsWith('-') || !(arg.startsWith('/') || arg.includes('..') || SENSITIVE_PATH.test(arg)));
}

export function summarizeAction(tool, args, elements) {
  const label = (id) => {
    const el = elements?.get?.(Number(id));
    return el ? ` ${el.tag}${el.label ? ` "${el.label}"` : ''}` : '';
  };
  switch (tool) {
    case 'goto': return `Open ${args.url}`;
    case 'click': return `Click [${args.id}]${label(args.id)}`;
    case 'type': return `Type "${String(args.text).slice(0, 120)}" into [${args.id}]${label(args.id)}${args.submit ? ' and press Enter' : ''}`;
    case 'press': return `Press ${args.key}`;
    case 'scroll': return `Scroll ${args.direction}`;
    case 'select': return `Choose "${args.value}" in [${args.id}]${label(args.id)}`;
    case 'back': return 'Go back';
    case 'reload': return 'Reload the page';
    case 'snapshot': return 'Look at the page';
    case 'wait': return `Wait ${args.seconds}s`;
    case 'shell': return `Run: ${args.command}`;
    case 'finish': return 'Finish';
    default: return tool;
  }
}

/**
 * @param {string} tool
 * @param {object} args validated args
 * @param {{elements?: Map<number, {tag:string,type?:string,label?:string}>}} ctx latest page elements
 */
export function assessAction(tool, args, ctx = {}) {
  const summary = summarizeAction(tool, args, ctx.elements);

  if (tool === 'goto') {
    let url;
    try { url = new URL(args.url); } catch { return { level: 'blocked', reason: 'That is not a valid URL.', summary }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { level: 'blocked', reason: `Only http and https pages can be opened (not ${url.protocol}).`, summary };
    }
    if (isPrivateHost(url.hostname)) {
      return { level: 'risky', reason: 'This address is on your own or a private network.', summary };
    }
    return { level: 'safe', summary };
  }

  if (tool === 'click' || tool === 'select') {
    const el = ctx.elements?.get?.(Number(args.id));
    if (el && RISKY_LABEL.test(`${el.label || ''} ${el.value || ''}`)) {
      return { level: 'risky', reason: `"${el.label || el.value}" looks like it sends, buys, posts or deletes something.`, summary };
    }
    return { level: 'safe', summary };
  }

  if (tool === 'type') {
    const el = ctx.elements?.get?.(Number(args.id));
    if (el && (el.type === 'password' || SENSITIVE_FIELD.test(`${el.label || ''} ${el.name || ''}`))) {
      return { level: 'risky', reason: 'This is a password or payment field.', summary };
    }
    return { level: 'safe', summary };
  }

  if (tool === 'shell') {
    const command = String(args.command);
    if (BLOCKED_SHELL.some((pattern) => pattern.test(command))) {
      return { level: 'blocked', reason: 'This command could wipe the workspace or the machine, so it is always refused.', summary };
    }
    return isSafeShell(command)
      ? { level: 'safe', summary }
      : { level: 'risky', reason: 'Shell commands can change files or run programs in the Codespace.', summary };
  }

  return { level: 'safe', summary };
}

export function needsApproval(assessment, tool, mode) {
  if (assessment.level === 'blocked') return false;
  if (mode === 'auto') return false;
  if (mode === 'strict') return !QUIET_TOOLS.has(tool);
  return assessment.level === 'risky';
}
