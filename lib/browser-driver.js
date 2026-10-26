import { isPrivateHost } from './policy.js';

const MAX_ELEMENTS = 80;
const MAX_TEXT = 3500;

// Runs inside the page. Numbers the interactive elements near the viewport and tags them with
// data-ais-id so a later "click 12" can find the same element again.
function collectElements(limit) {
  const attr = 'data-ais-id';
  document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[onclick],[contenteditable=""],[contenteditable="true"]';
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    if (out.length >= limit) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < -vh * 0.25 || rect.top > vh * 1.25 || rect.right < 0 || rect.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : (el.getAttribute('role') || tag);
    const label = el.getAttribute('aria-label')
      || (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.innerText
      || el.getAttribute('alt')
      || (type === 'submit' || type === 'button' ? el.value : '')
      || el.getAttribute('name')
      || '';
    const id = out.length + 1;
    el.setAttribute(attr, String(id));
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    out.push({
      id,
      tag,
      type,
      label: clean(label).slice(0, 90),
      name: el.getAttribute('name') || '',
      value: isField && type !== 'password' && type !== 'submit' && type !== 'button' ? clean(el.value).slice(0, 60) : '',
      href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : '',
      disabled: el.disabled === true,
      checked: el.checked === true
    });
  }
  return out;
}

function assertHttp(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('That is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https pages can be opened (not ${url.protocol}).`);
  return url;
}

const hostOf = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch { return null; }
};

/** Performs one browser action at a time on a Playwright browser context and reports what it now sees. */
export function createBrowserDriver({ context }) {
  let current = null;
  context.on('page', (page) => { current = page; });

  async function activePage() {
    if (current && !current.isClosed()) return current;
    current = context.pages().filter((page) => !page.isClosed()).at(-1) || await context.newPage();
    return current;
  }

  const target = (page, id) => {
    if (!Number.isInteger(id)) throw new Error('Use an element number from the latest ELEMENTS list.');
    return page.locator(`[data-ais-id="${id}"]`).first();
  };

  async function settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  async function observe(page, note = '') {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const elements = await page.evaluate(collectElements, MAX_ELEMENTS);
        const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        const scroll = await page.evaluate(() => ({ y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight) })).catch(() => null);
        const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 }).catch(() => null);
        return {
          url: page.url(),
          title: await page.title().catch(() => ''),
          scroll,
          note,
          elements,
          text: text.replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT),
          screenshot: shot ? shot.toString('base64') : null
        };
      } catch (error) {
        // A navigation can destroy the page context mid-read; settle and look once more.
        if (attempt >= 1) throw error;
        await settle(page);
      }
    }
  }

  async function execute({ tool, args = {} }) {
    let page = await activePage();
    const before = hostOf(page.url());
    const startedPrivate = before !== null && isPrivateHost(before);
    let allowPrivate = startedPrivate;

    switch (tool) {
      case 'goto': {
        const url = assertHttp(args.url);
        allowPrivate = allowPrivate || isPrivateHost(url.hostname);
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      }
      case 'click':
        await target(page, args.id).click({ timeout: 8000 });
        break;
      case 'type': {
        const field = target(page, args.id);
        await field.fill(String(args.text ?? ''), { timeout: 8000 });
        if (args.submit) await field.press('Enter');
        break;
      }
      case 'press':
        await page.keyboard.press(String(args.key));
        break;
      case 'scroll':
        if (args.direction === 'top') await page.evaluate(() => window.scrollTo(0, 0));
        else if (args.direction === 'bottom') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        else await page.mouse.wheel(0, (args.direction === 'up' ? -1 : 1) * Math.round((page.viewportSize()?.height || 800) * 0.8));
        break;
      case 'select': {
        const select = target(page, args.id);
        await select.selectOption({ label: String(args.value) }, { timeout: 8000 })
          .catch(() => select.selectOption(String(args.value), { timeout: 8000 }));
        break;
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        break;
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      case 'snapshot':
        break;
      default:
        throw new Error(`Unknown browser action "${tool}".`);
    }

    await settle(page);
    page = await activePage();

    // A public page must not be able to steer the browser onto the user's own network.
    const after = hostOf(page.url());
    if (after !== null && isPrivateHost(after) && !allowPrivate) {
      await page.goto('about:blank').catch(() => {});
      throw new Error('Blocked: that page tried to open an address on a private network.');
    }
    return observe(page);
  }

  return { execute };
}
