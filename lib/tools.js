// The actions the model may choose from, how their arguments are validated, and the help text
// that goes into the system prompt. Browser tools run on the user's computer through the bridge;
// shell runs inside the Codespace; wait and finish are handled by the agent itself.

const str = (max) => ({ type: 'string', required: true, max });

export const TOOLS = {
  goto: { kind: 'browser', fields: { url: str(2000) }, help: 'goto {"url":"https://example.com"} - open a web page' },
  click: { kind: 'browser', fields: { id: { type: 'int', required: true } }, help: 'click {"id":12} - click an element from the latest ELEMENTS list' },
  type: {
    kind: 'browser',
    fields: { id: { type: 'int', required: true }, text: str(4000), submit: { type: 'boolean' } },
    help: 'type {"id":3,"text":"hello","submit":false} - replace the text of an input; submit:true presses Enter afterwards'
  },
  press: { kind: 'browser', fields: { key: { ...str(40), pattern: /^[A-Za-z0-9+_ -]+$/ } }, help: 'press {"key":"Enter"} - press a key such as Enter, Escape, Tab, ArrowDown' },
  scroll: {
    kind: 'browser',
    fields: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], default: 'down' } },
    help: 'scroll {"direction":"down"} - scroll the page: down, up, top or bottom'
  },
  select: { kind: 'browser', fields: { id: { type: 'int', required: true }, value: str(500) }, help: 'select {"id":5,"value":"Large"} - choose an option in a <select> dropdown' },
  back: { kind: 'browser', fields: {}, help: 'back {} - go back one page' },
  reload: { kind: 'browser', fields: {}, help: 'reload {} - reload the current page to get fresh content' },
  snapshot: { kind: 'browser', fields: {}, help: 'snapshot {} - look at the current page again without doing anything' },
  wait: { kind: 'local', fields: { seconds: { type: 'number', required: true, min: 1, max: 300 } }, help: 'wait {"seconds":60} - pause (max 300). Use between checks when monitoring' },
  shell: {
    kind: 'shell',
    fields: { command: str(2000), timeout: { type: 'int', min: 1, max: 120 } },
    help: 'shell {"command":"ls -la"} - run a Linux command in the cloud workspace folder (optional "timeout" seconds, max 120)'
  },
  finish: { kind: 'local', fields: { summary: str(8000) }, help: 'finish {"summary":"..."} - end the task and report the result to the user' }
};

export function toolKind(tool) {
  return TOOLS[tool]?.kind;
}

export function toolHelp() {
  return Object.values(TOOLS).map((spec) => `- ${spec.help}`).join('\n');
}

/** Validate and normalise model-supplied arguments. Throws an Error whose message is shown to the model. */
export function validateAction(tool, rawArgs) {
  const spec = TOOLS[tool];
  if (!spec) throw new Error(`Unknown tool "${tool}". Available tools: ${Object.keys(TOOLS).join(', ')}.`);
  const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    let value = input[name];
    if (value === undefined || value === null || value === '') {
      if (field.default !== undefined) value = field.default;
      else if (field.required) throw new Error(`Tool "${tool}" needs "${name}".`);
      else continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`);
      if (field.max && value.length > field.max) throw new Error(`"${name}" is too long (max ${field.max} characters).`);
      if (field.enum && !field.enum.includes(value)) throw new Error(`"${name}" must be one of: ${field.enum.join(', ')}.`);
      if (field.pattern && !field.pattern.test(value)) throw new Error(`"${name}" has unsupported characters.`);
    } else if (field.type === 'int' || field.type === 'number') {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`"${name}" must be a number.`);
      if (field.type === 'int' && !Number.isInteger(number)) throw new Error(`"${name}" must be a whole number.`);
      value = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, number));
    } else if (field.type === 'boolean') {
      value = value === true || value === 'true';
    }
    args[name] = value;
  }
  if (tool === 'goto' && !/^[a-z][a-z0-9+.-]*:/i.test(args.url)) args.url = `https://${args.url}`;
  return args;
}
