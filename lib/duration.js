// Pure helpers shared by the server and the UI (served to the browser at /shared/duration.js).
// Pulls a time budget ("for 20 minutes") and a check interval ("every 5 minutes") out of a prompt.

export const MAX_MINUTES = 360;

const WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60
};
const NUM = '(\\d+(?:\\.\\d+)?|half an?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty)';
const UNIT = '(hours?|hrs?|minutes?|mins?|seconds?|secs?)';
const CUE = '(?:for|within|in|over|during|up to|until)\\s+(?:the\\s+(?:next|last)\\s+)?(?:about\\s+|around\\s+|roughly\\s+)?';

const COMPOUND = /\b(?:for|within|in|over|during|up to)\s+(\d+)\s*(?:h|hr|hrs|hours?)\s*(?:and\s*)?(\d+)\s*(?:m|mins?|minutes?)\b/i;
const BUDGET = new RegExp(`\\b${CUE}${NUM}\\s*${UNIT}\\b`, 'i');
const BUDGET_SHORT = new RegExp(`\\b${CUE}(\\d+(?:\\.\\d+)?)(h|m|s)\\b`, 'i');
const EVERY = new RegExp(`\\bevery\\s+(?:${NUM}\\s*)?${UNIT}\\b`, 'i');
const EVERY_SHORT = /\bevery\s+(\d+(?:\.\d+)?)(h|m|s)\b/i;

function amount(token) {
  const value = String(token).toLowerCase();
  if (value.startsWith('half')) return 0.5;
  if (/^\d/.test(value)) return Number(value);
  return WORDS[value];
}

function toMinutes(count, unit) {
  const u = String(unit).toLowerCase();
  if (u.startsWith('h')) return count * 60;
  if (u.startsWith('s')) return count / 60;
  return count;
}

function clamp(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(MAX_MINUTES, Math.max(0.5, Math.round(minutes * 100) / 100));
}

/** @returns {{minutes:number|null, everyMinutes:number|null}} */
export function parseTimePlan(text) {
  const input = String(text || '');
  let minutes = null;
  let everyMinutes = null;

  const compound = input.match(COMPOUND);
  if (compound) {
    minutes = Number(compound[1]) * 60 + Number(compound[2]);
  } else {
    const budget = input.match(BUDGET);
    const short = input.match(BUDGET_SHORT);
    if (budget) minutes = toMinutes(amount(budget[1]), budget[2]);
    else if (short) minutes = toMinutes(Number(short[1]), short[2]);
  }

  const every = input.match(EVERY);
  const everyShort = input.match(EVERY_SHORT);
  if (every) everyMinutes = toMinutes(every[1] ? amount(every[1]) : 1, every[2]);
  else if (everyShort) everyMinutes = toMinutes(Number(everyShort[1]), everyShort[2]);

  return { minutes: clamp(minutes), everyMinutes: clamp(everyMinutes) };
}

export function formatMinutes(minutes) {
  if (!minutes) return '';
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`;
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
